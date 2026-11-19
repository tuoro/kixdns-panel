#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="tuoro/kixdns-panel"
readonly STATUS_DIRECTORY="/var/lib/kixdns-panel-update"
readonly STATUS_FILE="${STATUS_DIRECTORY}/status.json"
# 安装器留给管理员的话（install.sh 的 write_update_notice）/ What the installer leaves for the admin (write_update_notice in
# install.sh)
readonly NOTICE_FILE="${STATUS_DIRECTORY}/notice"
readonly PANEL_ENV="/etc/kixdns-panel/panel.env"
readonly INSTALLER="/usr/local/libexec/kixdns-panel-one-click-install"
readonly PANEL_SERVER="/usr/local/bin/kixdns-panel-server"
readonly GITHUB_TOKEN_FILE="/var/lib/kixdns-panel/github-token"
# 安装器、卸载器和在线更新器共用的锁（install.sh 的 take_root_lock）；策略测试里换成临时文件
# The lock the installer, the uninstaller and the online updater share (take_root_lock in install.sh); a scratch file in the
# policy tests
ROOT_LOCK="/run/kixdns-panel-root/lock"
# SHOULD 2：两把锁都在只有 root 能进的目录里，都是 root 的 0600（root_lock_file_ready），降了权的子进程不带着它们的描述符
# （drop_privileges）/ SHOULD 2: both locks live in a directory only root can enter, both root's 0600 (root_lock_file_ready),
# and children that drop privileges carry none of their descriptors (drop_privileges)
LOCK_DIRECTORY="${ROOT_LOCK%/*}"
# root 的 UID 和 GID：在线更新以 root 运行；策略测试里是跑测试的用户 / root's UID and GID: the online update runs as root;
# the user running the tests in the policy tests
ROOT_UID="$(id -u)"
ROOT_GID="$(id -g)"
UPDATE_LOCK="${LOCK_DIRECTORY}/update.lock"
TARGET_VERSION=""
GITHUB_API_CONFIG=""
STEP_ERRORS=""
FAILURE_REASON=""

cleanup() {
  if [[ -n ${GITHUB_API_CONFIG} && ${GITHUB_API_CONFIG} == "${STATUS_DIRECTORY}"/.github-api.* ]]; then
    rm -f -- "${GITHUB_API_CONFIG}"
  fi
  if [[ -n ${STEP_ERRORS} && ${STEP_ERRORS} == "${STATUS_DIRECTORY}"/.errors.* ]]; then
    rm -f -- "${STEP_ERRORS}"
  fi
}

# 失败原因写进状态文件，系统页直接显示；完整输出仍在 journald。
# The failure reason goes into the status file for the system page; the full output stays in journald.
fail_because() {
  FAILURE_REASON=$1
  printf '%s\n' "$1" >&2
  return 1
}

# 从一步的 stderr 里挑出原因：安装器最后一行常是「已恢复原有程序」这类收尾话，
# 真正的原因在带「失败：」的那一行；没有这样的行就用最后一个非空行。安装器自己的「（一键）安装失败：」前缀去掉，
# 状态里只留一个「在线更新失败：」。
# Pick the reason out of a step's stderr: the installer's last line is usually a rollback epilogue
# such as "restored the original programs", and the real reason sits on the line carrying "失败：";
# without one, use the last non-empty line. The installer's own 「（一键）安装失败：」 prefix is dropped,
# so the status carries a single 「在线更新失败：」.
failure_line() {
  awk '
    { gsub(/[[:cntrl:]]/, "") }
    NF { last = $0; if (index($0, "失败：")) reason = $0 }
    END { out = (reason != "" ? reason : last); sub(/^(一键)?安装失败：/, "", out); print out }
  ' "$1"
}

# 运行一步，stderr 先留一份再转回 journald；失败时从中取原因，成功就清空，免得旧输出冒充后面的失败原因。
# Run a step keeping a copy of its stderr before passing it on to journald; take the reason from it on
# failure, and clear it on success so stale output cannot pose as the reason for a later failure.
run_step() {
  local status=0
  "$@" 2> "${STEP_ERRORS}" || status=$?
  cat -- "${STEP_ERRORS}" >&2
  if ((status == 0)); then
    : > "${STEP_ERRORS}"
  fi
  return "${status}"
}

# SHOULD 2：锁文件是 root 的 0600：没有就照 0600 建，已有的是 root 的普通文件就改成 0600；是符号链接、不是普通文件或不归 root
# 时不用它。放锁的目录只有 root 能进（打开之前查过），这里查到的就是会打开的那一个。参数：锁文件。
# SHOULD 2: a lock file is root's 0600: created 0600 when missing, an existing regular file of root's made 0600; a symlink,
# a non-regular file or one not root's is not used. The lock directory only root can enter (checked before the open), so
# what is checked here is what gets opened. Argument: the lock file.
root_lock_file_ready() {
  local file=$1
  [[ -e ${file} || -L ${file} ]] || (umask 077 && : >> "${file}")
  [[ -f ${file} && ! -L ${file} && $(stat -c '%u %g' -- "${file}") == "${ROOT_UID} ${ROOT_GID}" ]] || return 1
  [[ $(stat -c '%a' -- "${file}") == 600 ]] || chmod 0600 -- "${file}"
  [[ $(stat -c '%u %g %a' -- "${file}") == "${ROOT_UID} ${ROOT_GID} 600" ]]
}

# SHOULD 2：以别的身份运行一条命令，参数原样交给 setpriv；--timeout N 时由 root 的 timeout 限时（降了权的那个身份停不掉它）。
# 降权之前先关掉 2 以上的每一个文件描述符：锁、管道和打开的文件都不跟着过去，那个身份就没法经 /proc/<pid>/fd 或 pidfd_getfd
# 拿到它们。每一个降权的子进程都经这里。参数：[--timeout 秒数]、setpriv 的参数和命令。
# SHOULD 2: run a command under another identity, the arguments going to setpriv as they are; with --timeout N, root's
# timeout bounds it (the dropped identity cannot stop it). Every descriptor above 2 is closed before privileges drop: no
# lock, pipe or open file goes along, so that identity cannot reach them through /proc/<pid>/fd or pidfd_getfd. Every
# child that drops privileges goes through here. Arguments: [--timeout seconds], setpriv's arguments and the command.
drop_privileges() {
  local seconds=""
  if [[ $1 == --timeout ]]; then
    seconds=$2
    shift 2
  fi
  (
    for fd in /proc/"${BASHPID}"/fd/*; do
      fd=${fd##*/}
      if [[ ${fd} =~ ^[0-9]+$ ]] && ((fd > 2)) && [[ -e /proc/${BASHPID}/fd/${fd} ]]; then
        exec {fd}>&-
      fi
    done
    if [[ -n ${seconds} ]]; then
      timeout "${seconds}" setpriv "$@"
    else
      setpriv "$@"
    fi
  )
}

# Token 文件放在面板的状态目录里，面板账号能在检查和读取之间把它换成指向别处的符号链接或管道。按文件属主的身份去读（换了也只能
# 读到那个身份本来就能读的），最多等 5 秒、最多读 300 字节。
# The token file lives in the panel's state directory, where the panel account can swap it between the check and the read
# for a symlink elsewhere or a pipe. It is read as the file's owner (a swap then only reaches what that owner could read
# anyway), waiting 5 s and reading 300 bytes at most.
read_token_file() {
  local file=$1
  local owner
  local group
  owner="$(stat -c '%u' -- "${file}")"
  group="$(stat -c '%g' -- "${file}")"
  if [[ ${owner} == "$(id -u)" ]]; then
    timeout 5 head -c 300 -- "${file}"
  else
    drop_privileges --timeout 5 --reuid="${owner}" --regid="${group}" --clear-groups -- head -c 300 -- "${file}"
  fi
}

prepare_github_api_config() {
  local mode
  local token
  [[ -e ${GITHUB_TOKEN_FILE} ]] || return 0
  local invalid="GitHub Token 文件权限或格式不对，在系统页重新填一次 Token"
  [[ -f ${GITHUB_TOKEN_FILE} && ! -L ${GITHUB_TOKEN_FILE} ]] || fail_because "${invalid}"
  mode="$(stat -c '%a' -- "${GITHUB_TOKEN_FILE}")"
  [[ ${mode} =~ ^[0-7]{3,4}$ ]] || fail_because "${invalid}"
  (((8#${mode} & 8#077) == 0)) || fail_because "${invalid}"
  [[ $(stat -c '%s' -- "${GITHUB_TOKEN_FILE}") -le 257 ]] || fail_because "${invalid}"
  token="$(read_token_file "${GITHUB_TOKEN_FILE}")" || fail_because "${invalid}"
  [[ ${token} =~ ^(github_pat_|gh[pousr]_)[A-Za-z0-9_-]+$ ]] || fail_because "${invalid}"
  GITHUB_API_CONFIG="$(mktemp "${STATUS_DIRECTORY}/.github-api.XXXXXX")"
  chmod 0600 "${GITHUB_API_CONFIG}"
  printf 'header = "Authorization: Bearer %s"\n' "${token}" > "${GITHUB_API_CONFIG}"
  unset token
}

write_status() {
  local state=$1
  local message=$2
  local temporary
  [[ -d ${STATUS_DIRECTORY} && ! -L ${STATUS_DIRECTORY} ]] || return 1
  temporary="$(mktemp "${STATUS_DIRECTORY}/.status.XXXXXX")"
  jq -n \
    --arg state "${state}" \
    --arg message "${message}" \
    --arg target_version "${TARGET_VERSION}" \
    --argjson updated_at "$(date +%s)" \
    '{state: $state, message: ($message | .[0:300]), target_version: $target_version, updated_at: $updated_at}' \
    > "${temporary}"
  chown root:kixdns "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${STATUS_FILE}"
}

fail_update() {
  local status=$?
  # 只在设下陷阱的那个 shell 里记失败：-E 让 ERR 陷阱也在子 shell 里触发，那里记一次、父 shell 再记一次
  # Record the failure in the shell that set the trap only: -E fires the ERR trap in subshells too, which recorded it once
  # before the parent did again
  [[ -z ${1:-} || ${BASHPID} == "$1" ]] || exit "${status}"
  local reason=${FAILURE_REASON}
  trap - ERR
  if [[ -z ${reason} && -n ${STEP_ERRORS} && -s ${STEP_ERRORS} ]]; then
    reason="$(failure_line "${STEP_ERRORS}")"
  fi
  # 面板只接受 300 字以内的消息，超出会整份状态被拒；截断交给 write_status。
  # The panel accepts messages up to 300 characters and rejects the whole status beyond; write_status truncates.
  if [[ -n ${reason} ]]; then
    write_status failed "在线更新失败：${reason}" || true
  else
    write_status failed "在线更新失败，详情见 journalctl -u kixdns-panel-update.service" || true
  fi
  exit "${status}"
}

environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  AWK_KEY="${key}" awk -F= 'BEGIN { key = ENVIRON["AWK_KEY"] }
    $1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

# SHOULD 3：安装器（仅更新面板时）留给管理员的话，接在完成的结果后面，系统页上就看得到；读完就删，上一次留下的在更新之前删掉
# SHOULD 3: what the installer (on a panel-only update) left for the admin follows the result, so the system page shows it;
# it is removed once read, and one left by an earlier run is removed before the update
update_notice() {
  local notice=""
  if [[ -f ${NOTICE_FILE} && ! -L ${NOTICE_FILE} ]]; then
    notice="$(tr -d '[:cntrl:]' < "${NOTICE_FILE}")"
  fi
  rm -f -- "${NOTICE_FILE}"
  [[ -z ${notice} ]] || printf '。%s' "${notice}"
}

trusted_root_executable() {
  local mode
  local path=$1
  [[ -x ${path} && -f ${path} && ! -L ${path} ]] || return 1
  [[ $(stat -c '%u' -- "${path}") == 0 ]] || return 1
  mode="$(stat -c '%a' -- "${path}")"
  [[ ${mode} =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#${mode} & 8#022) == 0))
}

main() {
  local current_release
  local current_version_floor
  local current_binary_release
  local latest_json
  local latest_version
  local newest
  local -a github_api_args=()
  if ! command -v curl >/dev/null || ! command -v jq >/dev/null || \
    ! command -v flock >/dev/null; then
    printf '%s\n' '面板在线更新缺少 curl、jq 或 flock' >&2
    return 127
  fi
  trap cleanup EXIT
  # shellcheck disable=SC2064 # BASHPID 要在挂陷阱时展开，记下是哪个 shell 挂的 / BASHPID expands now, recording which shell set the trap
  trap "fail_update ${BASHPID}" ERR
  STEP_ERRORS="$(mktemp "${STATUS_DIRECTORY}/.errors.XXXXXX")"
  trusted_root_executable "${INSTALLER}" || fail_because "一键安装器 ${INSTALLER} 不是 root 所有或可被他人改写"
  trusted_root_executable "${PANEL_SERVER}" || fail_because "面板程序 ${PANEL_SERVER} 不是 root 所有或可被他人改写"
  [[ -e ${LOCK_DIRECTORY} || -L ${LOCK_DIRECTORY} ]] || install -d -o root -g root -m 0700 "${LOCK_DIRECTORY}"
  [[ -d ${LOCK_DIRECTORY} && ! -L ${LOCK_DIRECTORY} && $(stat -c '%u %a' -- "${LOCK_DIRECTORY}") == "${ROOT_UID} 700" ]] ||
    fail_because "${LOCK_DIRECTORY} 不是只有 root 能进的目录，锁不能放在那里"
  root_lock_file_ready "${UPDATE_LOCK}" || fail_because "${UPDATE_LOCK} 不是 root 的普通文件，锁不能用它"
  exec 9>> "${UPDATE_LOCK}"
  flock -n 9 || {
    # 另一个更新正在写状态文件；这里再写一份失败会盖掉它的进度。
    # Another update owns the status file; writing a failure here would overwrite its progress.
    trap - ERR
    printf '%s\n' '已有面板在线更新任务正在执行' >&2
    return 1
  }
  # 整个更新都拿着安装器、卸载器也用的那把锁：它们正在运行时不更新；安装器从 KIXDNS_PANEL_ROOT_LOCK_FD 认出这一把，接着用
  # The whole update holds the lock the installer and uninstaller use too: no update while either runs; the installer
  # recognises this one from KIXDNS_PANEL_ROOT_LOCK_FD and carries on with it
  root_lock_file_ready "${ROOT_LOCK}" || fail_because "${ROOT_LOCK} 不是 root 的普通文件，锁不能用它"
  exec 8>> "${ROOT_LOCK}"
  flock -n 8 || fail_because "安装器或卸载器正在运行，这次不更新；等它结束再试"
  export KIXDNS_PANEL_ROOT_LOCK_FD=8
  write_status checking "正在检查最新正式版"
  sleep 2
  prepare_github_api_config
  if [[ -n ${GITHUB_API_CONFIG} ]]; then
    github_api_args=(--config "${GITHUB_API_CONFIG}")
  fi
  latest_json="$(run_step curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'User-Agent: kixdns-panel-online-updater' \
    "${github_api_args[@]}" \
    "https://api.github.com/repos/${REPOSITORY}/releases/latest")"
  latest_version="$(jq -er '.tag_name | select(type == "string")' <<< "${latest_json}")" ||
    fail_because "GitHub 返回的最新正式版信息无法解析"
  [[ ${latest_version} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail_because "最新正式版标签 ${latest_version} 不是 vX.Y.Z 格式"
  TARGET_VERSION=${latest_version}
  current_release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  current_binary_release="v$(run_step "${PANEL_SERVER}" --version | awk 'NF >= 2 { print $NF; exit }')"
  [[ ${current_binary_release} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail_because "无法读取当前面板程序的版本"
  current_version_floor=${current_binary_release}
  if [[ -n ${current_release} ]]; then
    [[ ${current_release} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      fail_because "panel.env 里记录的面板版本 ${current_release} 无效"
    current_version_floor="$(printf '%s\n%s\n' "${current_release}" "${current_binary_release}" |
      sort -V | tail -n 1)"
  fi
  newest="$(printf '%s\n%s\n' "${current_version_floor}" "${latest_version}" | sort -V | tail -n 1)"
  [[ ${newest} == "${latest_version}" ]] ||
    fail_because "最新正式版 ${latest_version} 低于当前面板 ${current_version_floor}，不会降级"
  if [[ ${current_release} == "${latest_version}" ]]; then
    write_status complete "当前面板已经是最新正式版"
    return
  fi
  write_status downloading "正在下载并校验 ${latest_version}"
  rm -f -- "${NOTICE_FILE}"
  run_step "${INSTALLER}" --version "${latest_version}" -- --panel-only-update
  write_status complete "面板已更新到 ${latest_version}$(update_notice)"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
