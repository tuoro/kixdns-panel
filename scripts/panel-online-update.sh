#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="tuoro/kixdns-panel"
readonly STATUS_DIRECTORY="/var/lib/kixdns-panel-update"
readonly STATUS_FILE="${STATUS_DIRECTORY}/status.json"
readonly PANEL_ENV="/etc/kixdns-panel/panel.env"
readonly INSTALLER="/usr/local/libexec/kixdns-panel-one-click-install"
readonly PANEL_SERVER="/usr/local/bin/kixdns-panel-server"
readonly GITHUB_TOKEN_FILE="/var/lib/kixdns-panel/github-token"
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
# 真正的原因在带「失败：」的那一行；没有这样的行就用最后一个非空行。
# Pick the reason out of a step's stderr: the installer's last line is usually a rollback epilogue
# such as "restored the original programs", and the real reason sits on the line carrying "失败：";
# without one, use the last non-empty line.
failure_line() {
  awk '
    { gsub(/[[:cntrl:]]/, "") }
    NF { last = $0; if (index($0, "失败：")) reason = $0 }
    END { print (reason != "" ? reason : last) }
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

prepare_github_api_config() {
  local mode
  local token
  [[ -e ${GITHUB_TOKEN_FILE} ]] || return 0
  local invalid="GitHub Token 文件权限或格式无效，请在系统页重新配置 Token"
  [[ -f ${GITHUB_TOKEN_FILE} && ! -L ${GITHUB_TOKEN_FILE} ]] || fail_because "${invalid}"
  mode="$(stat -c '%a' -- "${GITHUB_TOKEN_FILE}")"
  [[ ${mode} =~ ^[0-7]{3,4}$ ]] || fail_because "${invalid}"
  (((8#${mode} & 8#077) == 0)) || fail_because "${invalid}"
  [[ $(stat -c '%s' -- "${GITHUB_TOKEN_FILE}") -le 257 ]] || fail_because "${invalid}"
  token="$(<"${GITHUB_TOKEN_FILE}")"
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
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
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
  trap fail_update ERR
  STEP_ERRORS="$(mktemp "${STATUS_DIRECTORY}/.errors.XXXXXX")"
  trusted_root_executable "${INSTALLER}" || fail_because "一键安装器 ${INSTALLER} 不是 root 所有或可被他人改写"
  trusted_root_executable "${PANEL_SERVER}" || fail_because "面板程序 ${PANEL_SERVER} 不是 root 所有或可被他人改写"
  exec 9>/run/kixdns-panel-update.lock
  flock -n 9 || {
    # 另一个更新正在写状态文件；这里再写一份失败会盖掉它的进度。
    # Another update owns the status file; writing a failure here would overwrite its progress.
    trap - ERR
    printf '%s\n' '已有面板在线更新任务正在执行' >&2
    return 1
  }
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
  run_step "${INSTALLER}" --version "${latest_version}" -- --panel-only-update
  write_status complete "面板已更新到 ${latest_version}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
