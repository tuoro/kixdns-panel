#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2034,SC2317,SC2329
set -Eeuo pipefail
# 临时目录和 CI 一样只有自己能写（R1、R4 见 test-install-policy.sh）/ Scratch directories writable by their owner alone, as in
# CI (R1, R4: see test-install-policy.sh)
umask 022

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNINSTALLER="${PACKAGE_ROOT}/scripts/uninstall.sh"

assert_equals() {
  local actual=$1
  local expected=$2
  local message=$3
  [[ ${actual} == "${expected}" ]] || {
    printf '断言失败：%s（期望 %s，实际 %s）\n' "${message}" "${expected}" "${actual}" >&2
    exit 1
  }
}

# 在伪终端里运行一段脚本：真实用户看到的是终端，/dev/tty 提示、stderr 与 Ctrl-C 都只有在 pty 里才测得出来。
# 参数：脚本，然后成对的「等待出现的文本」「要做的事（输入文本，或 INT/TERM/HUP）」。输出末尾追加 EXIT=<退出码>。
# Run a script inside a pseudo terminal: /dev/tty prompts, stderr and Ctrl-C only behave like a
# user's session there. Arguments: the script, then pairs of "text to wait for" and "action"
# (text to type, or INT/TERM/HUP). The output ends with EXIT=<status>.
run_in_pty() {
  python3 - "$@" <<'PY'
import os, pty, select, signal, sys, time

script, steps = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", script])
output = b""
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    if steps and steps[0].encode() in output:
        action = steps[1]
        steps = steps[2:]
        if action == "INT":
            os.write(fd, b"\x03")
        elif action in ("TERM", "HUP"):
            os.kill(pid, getattr(signal, "SIG" + action))
        else:
            os.write(fd, action.encode() + b"\n")
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
else:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.write(output.decode(errors="replace").replace("\r\n", "\n"))
sys.stdout.write(f"\nEXIT={code}\n")
PY
}

assert_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} == *"${needle}"* ]] || {
    printf '断言失败：%s\n实际输出：\n%s\n' "${message}" "${haystack}" >&2
    exit 1
  }
}

assert_not_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} != *"${needle}"* ]] || {
    printf '断言失败：%s\n实际输出：\n%s\n' "${message}" "${haystack}" >&2
    exit 1
  }
}

# 回归：终端提示之后 stderr 不能被永久吞掉，否则取消信息用户看不到。
# Regression: stderr must not stay swallowed after the tty prompt, or the cancel message vanishes.
output="$(run_in_pty "
  source '${UNINSTALLER}'
  KIXDNS_MANAGED=true
  KIXDNS_ACTION=auto
  choose_kixdns_action
" ']：' 3)"
assert_contains "${output}" "已取消卸载" "终端里取消卸载必须看得到取消提示"
[[ ${output} != *"卸载失败"* ]] || {
  printf '断言失败：取消是用户的选择，不应带卸载失败前缀\n%s\n' "${output}" >&2
  exit 1
}

help="$(bash "${UNINSTALLER}" --help)"
[[ ${help} == *"--keep-kixdns"* ]]
[[ ${help} == *"--remove-config"* ]]
[[ ${help} == *"--purge"* ]]

source "${UNINSTALLER}"
# 停面板账号的进程（R2）在临时主机上一律当作已经没有进程 / On scratch hosts no panel-account process is left (R2)
account_signal() { :; }
account_live_processes() { return 1; }
ROOT_GID="$(id -g)"
# 直接放在 /tmp 里的夹具（/tmp 谁都能写）当作 root 的 panel.env；临时主机（uninstall_scratch_host）里照真的查（R4）
# Fixtures right in /tmp (writable by anyone) count as root's panel.env; scratch hosts (uninstall_scratch_host) check for
# real (R4)
eval "real_panel_env_trusted() $(declare -f panel_env_trusted | tail -n +2)"
panel_env_trusted() { return 0; }

# 测试里的 systemd 只回答卸载器会问的 `show --property=名字 --value unit`，按临时目录里的 unit 文件作答，不碰开发机上真实的服务：
# 先找 SYSTEMD_UNIT_DIRECTORY（相当于 /etc/systemd/system），再找 OTHER_UNIT_DIRECTORY（相当于 /usr/local/lib/systemd/system）。
# The systemd of these tests answers only the `show --property=NAME --value UNIT` the uninstaller asks, from the unit files
# in the scratch tree, never touching the real services of the dev host: SYSTEMD_UNIT_DIRECTORY first (standing in for
# /etc/systemd/system), then OTHER_UNIT_DIRECTORY (standing in for /usr/local/lib/systemd/system).
fake_systemctl_show() {
  local each
  local exec_start
  # 一次查几个 unit 的 Id 和 ExecStart，像 systemctl 那样一个 unit 一段、段间空一行
  # Id and ExecStart of several units at once, one block per unit with a blank line between, as systemctl prints them
  if [[ $2 == --property=Id ]]; then
    for each in "${@:4}"; do
      exec_start="$(fake_systemctl_show show --property=ExecStart --value "${each}")"
      [[ -z ${exec_start} ]] || printf 'ExecStart=%s\n' "${exec_start}"
      printf 'Id=%s\n\n' "${each}"
    done
    return 0
  fi
  local property=${2#--property=}
  local unit=${4:-}
  local directory
  local file=""
  for directory in "${SYSTEMD_UNIT_DIRECTORY}" "${OTHER_UNIT_DIRECTORY:-/nonexistent}"; do
    if [[ -f ${directory}/${unit} ]]; then
      file=${directory}/${unit}
      break
    fi
  done
  [[ -n ${file} ]] || return 0
  # /etc/systemd/system/<unit>.d/ 里的 drop-in 跟在后面，后写的算数 / Drop-ins in /etc/systemd/system/<unit>.d/ follow, the last
  # one written wins
  local files=("${file}")
  for directory in "${SYSTEMD_UNIT_DIRECTORY}/${unit}.d"/*.conf; do
    [[ ! -f ${directory} ]] || files+=("${directory}")
  done
  case ${property} in
    ActiveState) printf 'active\n' ;;
    MainPID) printf '4242\n' ;;
    FragmentPath) printf '%s\n' "${file}" ;;
    ExecStart)
      awk '/^ExecStart=./ { line = $0; sub(/^ExecStart=/, "", line) }
        END { if (line != "") { split(line, words, " "); printf "{ path=%s ; argv[]=%s ; ignore_errors=no ; }\n", words[1], line } }' \
        "${files[@]}"
      ;;
    User) awk '/^User=/ { value = $0; sub(/^User=/, "", value) } END { print value }' "${files[@]}" ;;
  esac
}
# 临时主机上的 unit 文件：/etc/systemd/system 和 OTHER_UNIT_DIRECTORY 里的 / The scratch host's unit files: those in
# /etc/systemd/system and in OTHER_UNIT_DIRECTORY
fake_systemctl_list() {
  local file
  [[ $1 == list-unit-files ]] || return 0
  for file in "${SYSTEMD_UNIT_DIRECTORY}"/*.service "${OTHER_UNIT_DIRECTORY:-/nonexistent}"/*.service; do
    [[ ! -f ${file} ]] || printf '%s enabled enabled\n' "${file##*/}"
  done
}
use_fake_systemctl() {
  systemctl() {
    case $1 in
      show) fake_systemctl_show "$@" ;;
      list-units | list-unit-files) fake_systemctl_list "$@" ;;
    esac
  }
}
use_fake_systemctl

PANEL_ENV="${PACKAGE_ROOT}/.missing-panel.env"
EXTERNAL_BACKUP="${PACKAGE_ROOT}/.missing-external-backup"
# 没有 panel.env 时卸载器会扫描 unit 目录；指向不存在的目录，免得读到开发机上真实安装的 KixDNS。
# Without panel.env the uninstaller scans the unit directory; point it nowhere so a real KixDNS on the dev host cannot leak in.
SYSTEMD_UNIT_DIRECTORY="${PACKAGE_ROOT}/.missing-systemd-units"
SYSTEMD_VENDOR_DIRECTORIES=("${PACKAGE_ROOT}/.missing-vendor-units")
KIXDNS_MANAGED=false
KIXDNS_SERVICE_UNIT=kixdns.service
HAS_EXTERNAL_BACKUP=false
load_settings
assert_equals "${HAS_EXTERNAL_BACKUP}" false "没有迁移备份时设置加载也应成功"

# 新安装的 panel.env 不再写管理模式开关；没有这个键必须按面板管理的 KixDNS 处理，否则 --remove-kixdns 会被悄悄改成保留。
# New panel.env files no longer carry the management switch; its absence must mean a panel-managed KixDNS,
# or --remove-kixdns would silently turn into keep.
fixture_env="$(mktemp)"
printf 'KIXDNS_SERVICE_UNIT=kixdns.service\n' > "${fixture_env}"
output="$(
  PANEL_ENV=${fixture_env}
  KIXDNS_ACTION=remove
  load_settings
  choose_kixdns_action
  printf 'ACTION=%s\n' "${KIXDNS_ACTION}"
)"
assert_equals "${output}" "ACTION=remove" "没有管理模式开关的新 panel.env 应允许移除 KixDNS"
# 旧「仅安装面板」主机的 KixDNS 从来不归面板管，卸载器必须保留它。
# On a legacy panel-only host the KixDNS was never the panel's, so the uninstaller must keep it.
printf 'KIXDNS_MANAGEMENT_ENABLED=false\n' >> "${fixture_env}"
output="$(
  PANEL_ENV=${fixture_env}
  KIXDNS_ACTION=remove
  load_settings
  choose_kixdns_action
  printf 'ACTION=%s\n' "${KIXDNS_ACTION}"
)"
assert_contains "${output}" "ACTION=keep" "旧「仅安装面板」主机的 KixDNS 必须保留"
rm -f -- "${fixture_env}"

KIXDNS_ACTION=auto
CONFIG_ACTION=auto
ASSUME_YES=false
PURGE=false
parse_arguments --keep-kixdns --remove-config --yes
assert_equals "${KIXDNS_ACTION}" keep "显式保留 KixDNS 参数应生效"
assert_equals "${CONFIG_ACTION}" remove "显式删除配置参数应生效"
assert_equals "${ASSUME_YES}" true "显式确认参数应生效"
choose_kixdns_action
choose_config_action

# 外部备份：迁移前原来的 KixDNS 才算；以前重装时备份的面板自带 KixDNS（跑的是面板状态目录里的程序）不算，
# 否则卸载会把一个程序已被删掉的服务放回去、开机启动。
# The external backup counts for the KixDNS from before migration only; one an older reinstall made of the panel's own
# KixDNS (running the program in the panel's state directory) does not, or uninstall would restore a service whose program
# is gone and enable it at boot.
(
  work="$(mktemp -d)"
  trap 'rm -rf -- "${work}"' EXIT
  ROOT_RECORDS="${work}/records"
  EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
  ROOT_UID="$(command id -u)"
  ROOT_CHAIN_TOP=${work}
  mkdir -p "${EXTERNAL_BACKUP}"
  chmod 0700 "${ROOT_RECORDS}"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_BINARY=%s\n' /usr/local/bin/kixdns > "${EXTERNAL_BACKUP}/install.env"
  external_backup_present || { printf '断言失败：原来的 KixDNS 的备份应当算数\n' >&2; exit 1; }
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_BINARY=%s\n' "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${EXTERNAL_BACKUP}/install.env"
  ! external_backup_present || { printf '断言失败：面板自带 KixDNS 的备份不能当成原来的 KixDNS\n' >&2; exit 1; }
  rm -rf -- "${EXTERNAL_BACKUP}"
  ! external_backup_present || { printf '断言失败：没有备份时不能当成有\n' >&2; exit 1; }
)

# panel.env 说 KixDNS 归面板管，可它的 unit 已经换成跑别的程序（保留配置卸载后用户换上了自己的 KixDNS）：不再算面板的，
# 整个保留。迁移来的主机恢复到一半（还有外部备份、unit 是放回去的原 unit）照旧算面板的，好把恢复做完。
# panel.env says the KixDNS is the panel's, but its unit now runs another program (after a keep-config uninstall the user
# put their own KixDNS in): it no longer counts as the panel's and is kept whole. A migrated host part way through a restore
# (external backup still there, the unit is the original put back) still counts as the panel's, so the restore can finish.
# 第 3 个参数是 unit 文件放在哪：etc（/etc/systemd/system）或 other（systemd 也会加载的别处，例如 /usr/local/lib/systemd/system）。
# The third argument is where the unit file lives: etc (/etc/systemd/system) or other (elsewhere systemd loads from too, such
# as /usr/local/lib/systemd/system).
managed_by_unit() {
  local exec_start=$1
  local with_backup=$2
  local where=${3:-etc}
  (
    work="$(mktemp -d)"
    trap 'rm -rf -- "${work}"' EXIT
    PANEL_ENV="${work}/panel.env"
    SYSTEMD_UNIT_DIRECTORY="${work}/units"
    OTHER_UNIT_DIRECTORY="${work}/other-units"
    ROOT_RECORDS="${work}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(command id -u)"
    ROOT_CHAIN_TOP=${work}
    mkdir -p "${SYSTEMD_UNIT_DIRECTORY}" "${OTHER_UNIT_DIRECTORY}"
    unit_directory=${SYSTEMD_UNIT_DIRECTORY}
    [[ ${where} == etc ]] || unit_directory=${OTHER_UNIT_DIRECTORY}
    printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=/etc/kixdns/pipeline.json\n' > "${PANEL_ENV}"
    printf '[Service]\nExecStart=%s run --config /etc/kixdns/pipeline.json\n' "${exec_start}" > "${unit_directory}/kixdns.service"
    if [[ ${with_backup} == true ]]; then
      mkdir -p "${EXTERNAL_BACKUP}"
      chmod 0700 "${ROOT_RECORDS}"
      printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_BINARY=/usr/local/bin/kixdns\nKIXDNS_WAS_ACTIVE=true\nKIXDNS_WAS_ENABLED=true\n' > "${EXTERNAL_BACKUP}/install.env"
    fi
    KIXDNS_MANAGED=false
    KIXDNS_SERVICE_UNIT=kixdns.service
    HAS_EXTERNAL_BACKUP=false
    load_settings
    printf '%s\n' "${KIXDNS_MANAGED}"
  )
}
assert_equals "$(managed_by_unit /usr/local/bin/kixdns false)" false "unit 换成跑别的程序以后，KixDNS 不能再当面板的删掉"
assert_equals "$(managed_by_unit "${PANEL_STATE_DIRECTORY}/bin/kixdns" false)" true "unit 跑的还是面板的程序时照旧归面板管"
assert_equals "$(managed_by_unit /usr/local/bin/kixdns true)" true "恢复到一半、还有外部备份时照旧归面板管，好把恢复做完"
# 回归：只看 /etc/systemd/system 里的文件，用户放在 /usr/local/lib/systemd/system 的同名 unit 就被当成面板的停掉、删掉。
# 归属要按 systemd 实际加载的那个 unit 认。
# Regression: only the file in /etc/systemd/system was looked at, so a unit of the same name the user put in
# /usr/local/lib/systemd/system was stopped and removed as the panel's. Ownership follows the unit systemd really loads.
assert_equals "$(managed_by_unit /usr/local/sbin/kixdns false other)" false "放在别处的同名 unit 跑别的程序时，也不能当面板的删掉"
assert_equals "$(managed_by_unit "${PANEL_STATE_DIRECTORY}/bin/kixdns" false other)" true "systemd 加载的 unit 跑面板的程序时照旧归面板管"

HAS_EXTERNAL_BACKUP=false
CONFIG_ACTION=keep
KIXDNS_MANAGED=false
KIXDNS_ACTION=keep
RESTORED_EXTERNAL=false
load_external_backup
validate_removal_targets
remove_managed_kixdns
remove_panel_state
restore_external_state

if (KIXDNS_ACTION=auto CONFIG_ACTION=auto PURGE=false parse_arguments --keep-kixdns --remove-kixdns) 2>/dev/null; then
  printf '断言失败：冲突的 KixDNS 处理参数不应被接受\n' >&2
  exit 1
fi

if (ASSUME_YES=true KIXDNS_ACTION=auto CONFIG_ACTION=auto PURGE=false validate_non_interactive) 2>/dev/null; then
  printf '断言失败：--yes 不应替代缺失的处理选项\n' >&2
  exit 1
fi

KIXDNS_ACTION=auto
CONFIG_ACTION=auto
ASSUME_YES=false
PURGE=false
parse_arguments --purge
assert_equals "${KIXDNS_ACTION}" remove "--purge 应移除面板管理的 KixDNS"
assert_equals "${CONFIG_ACTION}" remove "--purge 应删除面板配置"
assert_equals "${ASSUME_YES}" true "--purge 应跳过交互确认"

KIXDNS_MANAGED=false
KIXDNS_ACTION=auto
HAS_EXTERNAL_BACKUP=false
choose_kixdns_action
assert_equals "${KIXDNS_ACTION}" keep "外部 KixDNS 必须自动保留"

if (KIXDNS_ACTION=auto CONFIG_ACTION=auto ASSUME_YES=false open_terminal) 2>/dev/null; then
  printf '断言失败：无交互终端时不应继续卸载\n' >&2
  exit 1
fi

UNIT_CALLS=""
systemctl() {
  if [[ $1 == is-active ]]; then
    return 1
  fi
  UNIT_CALLS+="$*"$'\n'
}
systemctl noop
UNIT_CALLS=""
stop_unit kixdns-panel.service
wait_for_unit_inactive kixdns-panel.service
[[ ${UNIT_CALLS} == *"disable --now kixdns-panel.service"* ]]
[[ ${UNIT_CALLS} == *"stop kixdns-panel.service"* ]]
[[ ${UNIT_CALLS} == *"kill --kill-who=all kixdns-panel.service"* ]]
[[ ${UNIT_CALLS} == *"reset-failed kixdns-panel.service"* ]]
unset -f systemctl
use_fake_systemctl

# 安装器关闭过 systemd-resolved 的本机监听：移除 KixDNS 时恢复原样，保留 KixDNS 时只给出恢复命令。
# The installer turned systemd-resolved's stub off: removing KixDNS restores it, keeping KixDNS only prints the commands.
resolved_uninstall() {
  local action=$1
  local kind=${2:-symlink}
  local work
  work="$(mktemp -d)"
  (
    # 和真的卸载器一样，记录在只有 root 能进的目录里（R1）/ As in the real uninstaller, the record lives in the root-only
    # directory (R1)
    ROOT_RECORDS="${work}/records"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    ROOT_UID="$(command id -u)"
    ROOT_CHAIN_TOP=${work}
    RESOLVED_DROPIN="${work}/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${work}/resolv.conf"
    mkdir -p "${RESOLVED_STATE}" "$(dirname -- "${RESOLVED_DROPIN}")"
    chmod 0700 "${ROOT_RECORDS}" "${RESOLVED_STATE}"
    printf '[Resolve]\nDNSStubListener=no\n' > "${RESOLVED_DROPIN}"
    ln -s /run/systemd/resolve/resolv.conf "${RESOLV_CONF}"
    if [[ ${kind} == symlink ]]; then
      printf '%s\n' RESOLVED_DROPIN_DIRECTORY_CREATED=true RESOLV_CONF_KIND=symlink \
        RESOLV_CONF_TARGET=../run/systemd/resolve/stub-resolv.conf > "${RESOLVED_STATE}/install.env"
    else
      printf '# 手写\nnameserver 127.0.0.53\n' > "${RESOLVED_STATE}/resolv.conf"
      printf '%s\n' RESOLVED_DROPIN_DIRECTORY_CREATED=true RESOLV_CONF_KIND=file > "${RESOLVED_STATE}/install.env"
    fi
    printf 'STATE=%s\n' "${RESOLVED_STATE}"
    systemctl() { printf 'systemctl %s\n' "$*"; }
    KIXDNS_ACTION=${action}
    restore_resolved_stub
    if [[ -L ${RESOLV_CONF} ]]; then
      printf 'LINK=%s\n' "$(readlink "${RESOLV_CONF}")"
    else
      printf 'FILE=%s\n' "$(tr '\n' ' ' < "${RESOLV_CONF}")"
    fi
    [[ ! -e ${RESOLVED_DROPIN} ]] || printf 'DROPIN-LEFT\n'
    [[ ! -e $(dirname -- "${RESOLVED_DROPIN}") ]] || printf 'DIRECTORY-LEFT\n'
    [[ ! -e ${RESOLVED_STATE} ]] || printf 'STATE-LEFT\n'
  )
  rm -rf -- "${work}"
}
output="$(resolved_uninstall remove)"
assert_contains "${output}" "LINK=../run/systemd/resolve/stub-resolv.conf" "移除 KixDNS 时应还原 resolv.conf 原来的指向"
assert_contains "${output}" "systemctl restart systemd-resolved.service" "移除 KixDNS 时应重启 systemd-resolved"
[[ ${output} != *LEFT* ]] || {
  printf '断言失败：恢复后不应残留 drop-in、目录或记录\n%s\n' "${output}" >&2
  exit 1
}
output="$(resolved_uninstall keep)"
assert_contains "${output}" "LINK=/run/systemd/resolve/resolv.conf" "保留 KixDNS 时不能改回 resolv.conf"
assert_contains "${output}" "DROPIN-LEFT" "保留 KixDNS 时不能删掉关闭监听的 drop-in"
assert_contains "${output}" "sudo ln -sfn ../run/systemd/resolve/stub-resolv.conf" "保留 KixDNS 时应给出恢复命令"
# 原来的 resolv.conf 是普通文件时，恢复命令必须把它放回去，否则照做之后 resolv.conf 仍指向上游列表。
# When the original resolv.conf was a plain file the commands must put it back, or following them leaves the uplink link in place.
output="$(resolved_uninstall keep file)"
state_directory="$(sed -n 's/^STATE=//p' <<< "${output}")"
assert_contains "${output}" "LINK=/run/systemd/resolve/resolv.conf" "保留 KixDNS 时不能改回普通文件"
assert_contains "${output}" "sudo cp -a --remove-destination ${state_directory}/resolv.conf " "原来是普通文件时应给出放回文件的命令"
output="$(resolved_uninstall remove file)"
assert_contains "${output}" "FILE=# 手写 nameserver 127.0.0.53 " "移除 KixDNS 时应放回原来的普通文件"
[[ ${output} != *LEFT* ]] || {
  printf '断言失败：恢复普通文件后不应残留\n%s\n' "${output}" >&2
  exit 1
}

# 回归：保留 KixDNS、删除配置连续卸载两次。第一次删掉了 panel.env，第二次曾因此把 KixDNS 当成外部的，
# 再整个删掉状态目录，连同保留的 bin/kixdns；unit 还在，重启后主机却没有 DNS。
# Regression: keep KixDNS and remove the config, twice. The first run deletes panel.env, so the second
# once treated KixDNS as external and removed the whole state directory with the kept bin/kixdns;
# the unit stayed and the host had no DNS after the next reboot.
repeated_keep_uninstall() {
  local work
  work="$(mktemp -d)"
  (
    PANEL_CONFIG_DIRECTORY="${work}/etc/kixdns-panel"
    PANEL_STATE_DIRECTORY="${work}/var/lib/kixdns-panel"
    SYSTEMD_UNIT_DIRECTORY="${work}/etc/systemd/system"
    PANEL_ENV="${PANEL_CONFIG_DIRECTORY}/panel.env"
    ROOT_RECORDS="${work}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    mkdir -p "${PANEL_CONFIG_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
      "${SYSTEMD_UNIT_DIRECTORY}"
    printf 'KIXDNS_SERVICE_UNIT=kixdns.service\n' > "${PANEL_ENV}"
    printf '#!/bin/sh\n' > "${PANEL_STATE_DIRECTORY}/bin/kixdns"
    chmod 0755 "${PANEL_STATE_DIRECTORY}/bin/kixdns"
    : > "${PANEL_STATE_DIRECTORY}/panel.db"
    printf '[Service]\nExecStart=%s run --config /etc/kixdns/pipeline.json\n' \
      "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service"
    systemctl() { [[ $1 != is-active ]]; }
    getent() { return 2; }
    chown() { :; }
    remove_panel_components() { :; }
    for run in first second; do
      (
        KIXDNS_MANAGED=false
        KIXDNS_KEPT_EARLIER=false
        KIXDNS_SERVICE_UNIT=kixdns.service
        KIXDNS_ACTION=auto
        CONFIG_ACTION=auto
        ASSUME_YES=false
        PURGE=false
        HAS_EXTERNAL_BACKUP=false
        RESTORED_EXTERNAL=false
        parse_arguments --keep-kixdns --remove-config --yes
        run_uninstall
      ) || printf 'RUN-FAILED=%s\n' "${run}"
      [[ -x ${PANEL_STATE_DIRECTORY}/bin/kixdns ]] && printf 'BINARY-KEPT=%s\n' "${run}"
    done
    [[ -f ${SYSTEMD_UNIT_DIRECTORY}/kixdns.service ]] && printf 'UNIT-KEPT\n'
    [[ ! -e ${PANEL_CONFIG_DIRECTORY} ]] && printf 'CONFIG-REMOVED\n'
    [[ ! -e ${PANEL_STATE_DIRECTORY}/panel.db ]] && printf 'DATABASE-REMOVED\n'
    # 第二次即使显式要求移除，也不能在没有 panel.env 时删掉保留的 KixDNS。
    # Even an explicit removal on a third run must not delete the kept KixDNS without panel.env.
    (
      KIXDNS_MANAGED=false
      KIXDNS_KEPT_EARLIER=false
      KIXDNS_SERVICE_UNIT=kixdns.service
      KIXDNS_ACTION=auto
      CONFIG_ACTION=auto
      ASSUME_YES=false
      PURGE=false
      HAS_EXTERNAL_BACKUP=false
      RESTORED_EXTERNAL=false
      parse_arguments --remove-kixdns --remove-config --yes
      run_uninstall
    ) || printf 'RUN-FAILED=third\n'
    [[ -x ${PANEL_STATE_DIRECTORY}/bin/kixdns ]] && printf 'BINARY-KEPT=third\n'
    true
  )
  rm -rf -- "${work}"
}
output="$(repeated_keep_uninstall 2>&1)"
[[ ${output} != *RUN-FAILED* ]] || {
  printf '断言失败：重复卸载不应失败\n%s\n' "${output}" >&2
  exit 1
}
assert_contains "${output}" "BINARY-KEPT=first" "第一次保留 KixDNS 时程序必须还在"
assert_contains "${output}" "BINARY-KEPT=second" "第二次卸载不能删掉上次保留的 KixDNS 程序"
assert_contains "${output}" "BINARY-KEPT=third" "没有 panel.env 时即使要求移除也必须保留上次保留的 KixDNS"
assert_contains "${output}" "UNIT-KEPT" "保留的 KixDNS unit 必须还在"
assert_contains "${output}" "CONFIG-REMOVED" "删除配置时 panel.env 所在目录应被删除"
assert_contains "${output}" "DATABASE-REMOVED" "删除配置时面板数据库应被删除"
assert_contains "${output}" "这次同样保留" "要求移除却只能保留时必须说明原因"

# 回归：v3.1.1 的重复卸载删掉了保留的程序却留下 unit。这样的主机再卸载时不能把 unit 当成保留的 KixDNS，
# 否则删除配置时报「找不到需要保留的 KixDNS 二进制」而失败。面板创建的 unit 随面板移除，别人的 unit 原样保留。
# Regression: v3.1.1's repeated uninstall deleted the kept binary but left the unit. Uninstalling such a host
# must not treat the unit as a kept KixDNS, or removing the config fails on the missing binary. A panel-created
# unit goes with the panel; anyone else's unit stays.
dead_unit_uninstall() {
  local kind=$1
  local work
  work="$(mktemp -d)"
  (
    PANEL_CONFIG_DIRECTORY="${work}/etc/kixdns-panel"
    PANEL_STATE_DIRECTORY="${work}/var/lib/kixdns-panel"
    SYSTEMD_UNIT_DIRECTORY="${work}/etc/systemd/system"
    PANEL_ENV="${PANEL_CONFIG_DIRECTORY}/panel.env"
    ROOT_RECORDS="${work}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    mkdir -p "${SYSTEMD_UNIT_DIRECTORY}"
    case ${kind} in
      panel-documentation)
        printf '[Unit]\nDocumentation=https://github.com/tuoro/kixdns-panel\n[Service]\nExecStart=%s run --config /etc/kixdns/custom.json\n' \
          "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service"
        ;;
      panel-execstart)
        printf '[Service]\nExecStart=%s run --config /etc/kixdns/pipeline.json --admin-socket /run/kixdns/admin.sock\n' \
          "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service"
        ;;
      foreign)
        printf '[Unit]\nDocumentation=https://example.com/my-dns\n[Service]\nExecStart=%s run -c /opt/dns.json\n' \
          "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service"
        ;;
      panel-dropin)
        # 面板写的 unit，用户用 drop-in 换成跑自己的程序：systemd 跑的不是面板的程序，那就是用户的服务
        # A unit the panel wrote, switched by the user through a drop-in to their own program: systemd does not run the
        # panel's program, so it is the user's service
        printf '[Service]\nExecStart=%s run --config /etc/kixdns/pipeline.json --admin-socket /run/kixdns/admin.sock\n' \
          "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service"
        mkdir -p "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service.d"
        printf '[Service]\nExecStart=\nExecStart=/usr/local/sbin/kixdns run --config /etc/my-dns.json\n' \
          > "${SYSTEMD_UNIT_DIRECTORY}/kixdns.service.d/override.conf"
        ;;
    esac
    systemctl() {
      [[ $1 != is-active ]] || return 1
      [[ $1 != show ]] || { fake_systemctl_show "$@"; return 0; }
      printf 'systemctl %s\n' "$*"
    }
    getent() { return 2; }
    chown() { :; }
    remove_panel_components() { :; }
    (
      KIXDNS_MANAGED=false
      KIXDNS_KEPT_EARLIER=false
      KIXDNS_SERVICE_UNIT=kixdns.service
      KIXDNS_ACTION=auto
      CONFIG_ACTION=auto
      ASSUME_YES=false
      PURGE=false
      HAS_EXTERNAL_BACKUP=false
      RESTORED_EXTERNAL=false
      parse_arguments --keep-kixdns --remove-config --yes
      run_uninstall
    ) || printf 'RUN-FAILED\n'
    [[ -f ${SYSTEMD_UNIT_DIRECTORY}/kixdns.service ]] && printf 'UNIT-LEFT\n'
    true
  )
  rm -rf -- "${work}"
}
for kind in panel-documentation panel-execstart; do
  output="$(dead_unit_uninstall "${kind}" 2>&1)"
  [[ ${output} != *RUN-FAILED* && ${output} != *UNIT-LEFT* ]] || {
    printf '断言失败：程序已不存在的面板 unit（%s）应随面板移除且卸载成功\n%s\n' "${kind}" "${output}" >&2
    exit 1
  }
  assert_contains "${output}" "systemctl disable --now kixdns.service" "移除失效的面板 unit 前应先停用它"
  assert_contains "${output}" "这个服务由面板创建，随面板一起移除" "移除失效的面板 unit 时必须说明原因"
  assert_contains "${output}" "没有可保留的 KixDNS" "程序不在时不能声称 KixDNS 已保留"
done
output="$(dead_unit_uninstall foreign 2>&1)"
[[ ${output} != *RUN-FAILED* ]] || {
  printf '断言失败：程序已不存在的外部 unit 不应让卸载失败\n%s\n' "${output}" >&2
  exit 1
}
assert_contains "${output}" "UNIT-LEFT" "不是面板创建的 unit 必须原样保留"
assert_contains "${output}" "这个服务不是面板创建的，保留不动" "保留失效的外部 unit 时必须说明"
# 回归：只看 /etc/systemd/system 里的文件，drop-in 已经让它跑用户自己程序的 unit 也被当成面板留下的、程序已不在的 unit 删掉。
# Regression: looking only at the file in /etc/systemd/system, a unit a drop-in had switched to the user's own program was
# removed as a dead unit the panel left.
output="$(dead_unit_uninstall panel-dropin 2>&1)"
assert_not_contains "${output}" "RUN-FAILED" "drop-in 换了程序的 unit 不应让卸载失败"
assert_contains "${output}" "UNIT-LEFT" "systemd 跑的不是面板程序的 unit 必须原样保留"
assert_not_contains "${output}" "systemctl disable --now kixdns.service" "systemd 跑的不是面板程序的 unit 不应被停用"
[[ ${output} != *"systemctl disable --now kixdns.service"* ]] || {
  printf '断言失败：不是面板创建的 unit 不应被停用\n%s\n' "${output}" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 迁移来的主机：配置 / Migrated hosts: the config
# ---------------------------------------------------------------------------

INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"

# 卸载器单独分发、不能 source 安装器，这几个函数各有一份，必须一字不差：哪边改了另一边没跟上，这里就失败。
# The uninstaller ships on its own and cannot source the installer, so these functions exist twice and must match
# exactly: when one side changes without the other, this fails.
for shared_function in wait_for_service_stable port_accepts_connection owner_and_mode hand_back_directory \
  unit_service_setting original_config_access hand_back_original_config panel_written_config_file \
  ensure_root_records root_only_path record_problem same_filesystem quarantine_record refuse_record trusted_record \
  old_records_present adopt_old_records secure_root_records panel_process_uids account_signal account_live_processes \
  quiesce_panel_account refuse_with_panel_held adoption_done mark_adoption_done discard_old_records take_root_lock \
  panel_env_trusted managed_unit_config original_unit_files panel_owned; do
  installer_copy="$(bash -c "source '${INSTALLER}'; declare -f ${shared_function}" 2>/dev/null || true)"
  uninstaller_copy="$(bash -c "source '${UNINSTALLER}'; declare -f ${shared_function}" 2>/dev/null || true)"
  [[ -n ${installer_copy} && ${installer_copy} == "${uninstaller_copy}" ]] || {
    printf '断言失败：安装器和卸载器的 %s 不一样\n' "${shared_function}" >&2
    diff <(printf '%s\n' "${installer_copy}") <(printf '%s\n' "${uninstaller_copy}") >&2 || true
    exit 1
  }
done
for shared_setting in SERVICE_WAIT_SECONDS SERVICE_STABLE_SECONDS; do
  assert_equals "$(bash -c "source '${UNINSTALLER}'; printf '%s' \"\${${shared_setting}:-}\"")" \
    "$(bash -c "source '${INSTALLER}'; printf '%s' \"\${${shared_setting}}\"")" "安装器和卸载器的 ${shared_setting} 应一样"
done

# 在临时目录里搭一台迁移过的主机：用安装器自己的函数迁移一个外部 KixDNS（原配置 etc/kixdns.json），
# 再像面板那样改写它管理的那份配置。改动系统的命令换成只在临时目录里生效的替身。
# Build a migrated host in a scratch tree: migrate an external KixDNS (original config etc/kixdns.json) with the
# installer's own functions, then rewrite the config it manages, as the panel would. Commands that change the
# system are replaced by stand-ins that only act inside the scratch tree.
migrated_host() {
  local root=$1
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/units" "${root}/state/bin" "${root}/panel-etc" "${root}/package/deploy/systemd" \
    "${root}/package/deploy/config"
  cp "${PACKAGE_ROOT}/deploy/systemd/kixdns.service" "${root}/package/deploy/systemd/"
  cp "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${root}/package/deploy/config/"
  cp "${PACKAGE_ROOT}/deploy/panel.env.example" "${root}/package/deploy/"
  printf '{"original":true}\n' > "${root}/etc/kixdns.json"
  chmod 0604 "${root}/etc/kixdns.json"
  chmod 0751 "${root}/etc"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${root}/etc/kixdns.json" \
    > "${root}/units/kixdns.service"
  cp -- "${root}/units/kixdns.service" "${root}/original.service"
  migrate_scratch_host "${root}" "${root}/etc/kixdns.json" true true
}

# 把临时主机上现在这个外部 KixDNS 迁移成增强版：它的 unit 写着配置 config，运行、开机自启与否是 active、enabled（true 或 false）。
# Migrate the external KixDNS the scratch host has now: its unit names the config config, and active and enabled (true or
# false) say whether it runs and starts at boot.
migrate_scratch_host() {
  local root=$1
  local config=$2
  local active=$3
  local enabled=$4
  bash -c "
    set -Eeuo pipefail
    source '${INSTALLER}'
    root='${root}'
    PACKAGE_ROOT=\"\${root}/package\"
    PANEL_CONFIG_DIRECTORY=\"\${root}/panel-etc\"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY=\"\${root}/panel-etc/kixdns\"
    MIGRATED_KIXDNS_CONFIG=\"\${root}/panel-etc/kixdns/pipeline.json\"
    PANEL_ENV=\"\${root}/panel-etc/panel.env\"
    SYSTEMD_UNIT_DIRECTORY=\"\${root}/units\"
    SYSTEMD_VENDOR_DIRECTORIES=(\"\${root}/vendor-units\")
    ROOT_RECORDS=\"\${root}/records\"
    EXTERNAL_BACKUP=\"\${ROOT_RECORDS}/external-backup\"
    ROOT_UID=\"\$(id -u)\"
    ROOT_CHAIN_TOP=\"\${root}\"
    # 安装器把已有的旧备份先挪进回滚备份 / The installer first moves an old backup already there into the rollback backup
    BACKUP_ROOT=\"\$(mktemp -d \"\${root}/rollback.XXXXXX\")\"
    systemctl() {
      case \$1 in
        show) printf '{ path=/usr/local/bin/kixdns ; argv[]=/usr/local/bin/kixdns run --config %s ; }\n' '${config}' ;;
        cat) return 0 ;;
        is-active) ${active} ;;
        is-enabled) ${enabled} ;;
      esac
    }
    install() {
      local arguments=()
      while [[ \$# -gt 0 ]]; do
        case \$1 in -o | -g) shift ;; *) arguments+=(\"\$1\") ;; esac
        shift
      done
      [[ \${arguments[*]: -1} != \"\${root}\"/* ]] || command install \"\${arguments[@]}\"
    }
    chown() { :; }
    kixdns_can_read() { return 0; }
    update_panel_environment() { render_panel_environment /dev/null \"\${PANEL_ENV}\" 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 1 fork; }
    # ACCOUNTS_MISSING=true：迁移前还没有 kixdns 账号和组，这次迁移建的；否则它们原来就有。不看开发机上真实的账号。
    # ACCOUNTS_MISSING=true: the kixdns account and group did not exist before the migration, which created them; otherwise
    # they were there already. The real accounts of the dev host are not looked at.
    if [[ '${ACCOUNTS_MISSING:-false}' == true ]]; then
      id() { return 1; }
      getent() { return 2; }
    else
      id() { printf '990\n'; }
      getent() { printf 'kixdns:x:990:\n'; }
    fi
    record_existing_accounts
    unset -f id getent
    # 和 install.sh 的 main 一样，什么都不问之前先看上次卸载有没有恢复完 / As install.sh's main does, check that an earlier
    # uninstall finished its restore before anything is asked
    refuse_unfinished_restore
    INSTALL_MODE=managed
    detect_existing_kixdns
    determine_install_kind
    validate_install_mode
    preserve_external_install
    install_configuration
    render_kixdns_unit > \"\${SYSTEMD_UNIT_DIRECTORY}/kixdns.service\"
  " || return 1
  # 受管 unit 运行的是面板状态目录里的程序；换成临时主机的状态目录，卸载器才认得出它。
  # The managed unit runs the program in the panel's state directory; point it at the scratch host's, so the
  # uninstaller recognises it.
  sed -i "s|/var/lib/kixdns-panel/|${root}/state/|g" "${root}/units/kixdns.service"
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  chmod 0755 "${root}/state/bin/kixdns"
  # 面板保存配置：改的是 panel.env 记下的那一份。/ The panel saves a config: it rewrites the one panel.env names.
  printf '{"edited":true}\n' > "$(awk -F= '$1 == "KIXDNS_CONFIG" { print $2 }' "${root}/panel-etc/panel.env")"
}

# 在同一台临时主机上运行卸载器；参数照传给 parse_arguments。
# Run the uninstaller on that scratch host; the arguments go to parse_arguments as given.
uninstall_scratch_host() {
  local root=$1
  shift
  (
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    PANEL_STATE_DIRECTORY="${root}/state"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    SYSTEMD_VENDOR_DIRECTORIES=("${root}/vendor-units")
    PANEL_ENV="${PANEL_CONFIG_DIRECTORY}/panel.env"
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    # 临时主机上的文件都归跑测试的用户，由他代替 root；FORGED_RECORDS=true 时 root 是别人，面板写的记录就不归 root
    # The scratch host's files belong to the user running the test, who stands in for root; with FORGED_RECORDS=true root
    # is someone else, so records the panel wrote are not root's
    ROOT_UID="$(command id -u)"
    panel_env_trusted() { real_panel_env_trusted; }
    if [[ ${FORGED_RECORDS:-} == true ]]; then
      ROOT_UID=0
      # 只冒充记录：panel.env 照样是 root 的，只有 root 能进的记录目录也照样是 root 的 / Only the records are forged: panel.env
      # is root's as ever, and so is the root-only records directory
      panel_env_trusted() { return 0; }
      stat() {
        if [[ $1 == -c && ${*: -1} == "${root}/records" ]]; then
          case $2 in
            %u) printf '0\n' ;;
            '%u %a') printf '0 %s\n' "$(command stat -c '%a' -- "${root}/records")" ;;
            *) command stat "$@" ;;
          esac
          return
        fi
        command stat "$@"
      }
    fi
    ROOT_CHAIN_TOP=${root}
    KIXDNS_RUNTIME_DIRECTORY="${root}/run-kixdns"
    KIXDNS_CONFIG_DIRECTORY="${root}/etc-kixdns"
    # SYSTEMCTL_LOG 非空时记下每个改动服务的 systemctl 调用；SYSTEMCTL_FAIL_START=true 时启动服务失败，像真的卸载器那样就此
    # 停下。查询（show）不记：恢复后等原来的 KixDNS 稳定运行时会反复查它的状态，默认它一直是同一个主进程；
    # SYSTEMCTL_UNSTABLE=true 时它一直起不来（Restart= 的崩溃循环里总是 activating）。
    # With SYSTEMCTL_LOG set every systemctl call that changes a service is recorded; with SYSTEMCTL_FAIL_START=true starting
    # a service fails and, as in the real uninstaller, the run stops there. Queries (show) are not recorded: after the restore
    # the uninstaller keeps asking for the original KixDNS's state while waiting for it to settle, and by default it stays
    # the same main process; with SYSTEMCTL_UNSTABLE=true it never comes up (always activating in a Restart= crash loop).
    systemctl() {
      if [[ $1 == list-units || $1 == list-unit-files ]]; then
        fake_systemctl_list "$@"
        return 0
      fi
      if [[ $1 == show ]]; then
        if [[ $2 == --property=ActiveState && ${SYSTEMCTL_UNSTABLE:-} == true ]]; then
          printf 'activating\n'
        else
          fake_systemctl_show "$@"
        fi
        return 0
      fi
      [[ -z ${SYSTEMCTL_LOG:-} ]] || printf '%s\n' "$*" >> "${SYSTEMCTL_LOG}"
      [[ $1 != start || ${SYSTEMCTL_FAIL_START:-} != true ]] || return 1
      [[ $1 != is-active ]]
    }
    sleep() { :; }
    # 账号：ACCOUNTS_PRESENT=true 时 kixdns、kixdns-panel 账号和 kixdns 组都在；ACCOUNT_LOG 非空时记下删账号、删组的调用；
    # ACCOUNT_BUSY=true 时 kixdns 账号还有别的进程在用。开发机上真实的账号和进程一个也不碰。
    # Accounts: with ACCOUNTS_PRESENT=true the kixdns and kixdns-panel accounts and the kixdns group exist; with ACCOUNT_LOG
    # set the calls removing an account or the group are recorded; with ACCOUNT_BUSY=true other processes still use the
    # kixdns account. No real account or process of the dev host is touched.
    getent() { [[ ${ACCOUNTS_PRESENT:-} == true ]] && printf '%s:x:990:990::/nonexistent:/usr/sbin/nologin\n' "$2"; }
    id() { [[ ${ACCOUNTS_PRESENT:-} == true ]] && printf '990\n'; }
    userdel() { [[ -z ${ACCOUNT_LOG:-} ]] || printf 'userdel %s\n' "$*" >> "${ACCOUNT_LOG}"; }
    groupdel() { [[ -z ${ACCOUNT_LOG:-} ]] || printf 'groupdel %s\n' "$*" >> "${ACCOUNT_LOG}"; }
    terminate_account_processes() { :; }
    account_has_processes() { [[ ${ACCOUNT_BUSY:-} == true && $1 == kixdns ]]; }
    # CHOWN_LOG 非空时记下每个 chown；PANEL_OWNED=true 时临时主机上的文件都算面板账号的（它们其实归跑测试的用户）。
    # With CHOWN_LOG set every chown is recorded; with PANEL_OWNED=true every file of the scratch host counts as the panel
    # account's (they really belong to the user running the test).
    chown() { [[ -z ${CHOWN_LOG:-} ]] || printf 'chown %s\n' "$*" >> "${CHOWN_LOG}"; }
    if [[ ${PANEL_OWNED:-} == true ]]; then
      panel_owned() { [[ -e $1 || -L $1 ]]; }
    fi
    install() {
      local arguments=()
      while [[ $# -gt 0 ]]; do
        case $1 in -o | -g) shift ;; *) arguments+=("$1") ;; esac
        shift
      done
      [[ ${arguments[*]: -1} != "${root}"/* ]] || command install "${arguments[@]}"
    }
    remove_panel_components() { :; }
    KIXDNS_MANAGED=false
    KIXDNS_KEPT_EARLIER=false
    KIXDNS_SERVICE_UNIT=kixdns.service
    KIXDNS_ACTION=auto
    CONFIG_ACTION=auto
    ASSUME_YES=false
    PURGE=false
    HAS_EXTERNAL_BACKUP=false
    RESTORED_EXTERNAL=false
    DEAD_PANEL_UNITS=()
    DEAD_FOREIGN_UNITS=()
    parse_arguments "$@"
    run_uninstall
  ) 2>&1 || printf 'RUN-FAILED\n'
}

# 回归：以前迁移原地接管原配置，面板改的就是它；卸载时放回原来的 unit 并说「已恢复」，原来的 KixDNS 却跑着面板改过的配置。
# 现在面板只改副本：卸载恢复后，原配置的内容、权限和它所在目录的权限都和迁移前一样，副本随增强版一起删掉。
# Regression: migration used to take the original config over in place, so the panel edited it; uninstall put the original
# unit back and said "restored", yet the original KixDNS ran the config the panel had edited. Now the panel edits only the
# copy: after the restore, the original config's content and mode and its directory's mode are as before the migration,
# and the copy goes with the enhanced KixDNS.
scratch="$(mktemp -d)"
trap 'rm -rf -- "${scratch}"' EXIT
host="${scratch}/host"
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "迁移过的主机卸载不应失败"
assert_equals "$(cat "${host}/etc/kixdns.json")" '{"original":true}' "恢复原来的 KixDNS 后，它的配置应是迁移前的内容"
assert_equals "$(stat -c '%a' "${host}/etc/kixdns.json")" "604" "恢复后原配置的权限应和迁移前一样"
assert_equals "$(stat -c '%a' "${host}/etc")" "751" "恢复后原配置所在目录的权限应和迁移前一样"
cmp -s -- "${host}/units/kixdns.service" "${host}/original.service" || {
  printf '断言失败：卸载应放回原来的 unit\n' >&2
  exit 1
}
[[ ! -e ${host}/panel-etc ]] || { printf '断言失败：删除配置时副本和面板配置目录应一起删掉\n' >&2; exit 1; }
assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "卸载应说明原来的 KixDNS 已恢复"
assert_contains "${output}" "它用的是迁移前的配置 ${host}/etc/kixdns.json，面板改过的副本已删除。" "卸载应说明用回了迁移前的配置"

# 只移除增强版、保留面板数据：副本跟着增强版删掉（以后重新迁移会再从原配置复制一份），panel.env 和数据库留着。
# Removing only the enhanced KixDNS and keeping the panel data: the copy goes with it (a later migration copies the
# original again), panel.env and the database stay.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留数据移除增强版不应失败"
[[ ! -e ${host}/panel-etc/kixdns ]] || { printf '断言失败：移除增强版时副本和它的目录应删掉\n' >&2; exit 1; }
[[ -f ${host}/panel-etc/panel.env ]] || { printf '断言失败：保留数据时 panel.env 应留着\n' >&2; exit 1; }
assert_equals "$(cat "${host}/etc/kixdns.json")" '{"original":true}' "保留数据移除增强版时原配置也应是迁移前的内容"

# 恢复用掉备份：原来的 KixDNS 放回去以后备份就删掉，保留的 panel.env 记下这台主机的 KixDNS 已不归面板管。以后再迁移，记下的是
# 那时主机上的 KixDNS，再恢复就回到那次迁移之前。回归：以前备份一直留着，再迁移时安装器见备份在就不再备份，第二次恢复放回的是
# 第一次迁移前的 unit、配置和运行状态。
# A restore uses the backup up: once the original KixDNS is back the backup is removed, and the kept panel.env records that
# the KixDNS on this host is no longer the panel's. A later migration records the KixDNS the host has then, and restoring
# again goes back to just before that migration. Regression: the backup used to stay, so a later migration saw it and made
# none, and the second restore put back the unit, config and running state from before the first migration.
systemctl_log="${scratch}/systemctl.log"
# 最后一次 daemon-reload 之后的 systemctl 调用：恢复原来的 KixDNS 运行状态的那几个 / The systemctl calls after the last
# daemon-reload: the ones restoring the original KixDNS's running state
restore_calls() {
  awk '$1 == "daemon-reload" { calls = ""; next } { calls = calls $0 ";" } END { print calls }' "${systemctl_log}"
}
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
: > "${systemctl_log}"
output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留数据恢复原来的 KixDNS 不应失败"
assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "保留数据时也应恢复原来的 KixDNS"
[[ ! -e ${host}/records/external-backup ]] || { printf '断言失败：恢复成功后应删掉迁移前的备份\n' >&2; exit 1; }
assert_equals "$(restore_calls)" "enable kixdns.service --quiet;start kixdns.service;" "第一次恢复应按迁移前的状态启用并启动"
assert_contains "$(cat "${host}/panel-etc/panel.env")" "KIXDNS_MANAGEMENT_ENABLED=false" \
  "恢复后保留的 panel.env 应记下 KixDNS 已不归面板管"
# 再运行一次卸载器（比如这回想删数据）：原来的 KixDNS 已经不归面板管，不能当成面板的去停、去删。
# Running the uninstaller once more (to delete the data this time, say): the original KixDNS is no longer the panel's and
# must not be stopped or removed as if it were.
: > "${systemctl_log}"
output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "恢复以后再卸载不应失败"
assert_contains "${output}" "这台机器的 KixDNS 不归面板管理" "恢复以后再卸载应说明 KixDNS 已不归面板管"
assert_not_contains "$(cat "${systemctl_log}")" "kixdns.service" "恢复以后再卸载不能再动原来的 KixDNS"
cmp -s -- "${host}/units/kixdns.service" "${host}/original.service" ||
  { printf '断言失败：恢复以后再卸载不能删掉或换掉原来的 unit\n' >&2; exit 1; }
# 再迁移一次之前，主机上的 KixDNS 换了配置、改成不开机自启也不运行；这次迁移记下的是它现在的样子。
# Before migrating again, the host's KixDNS got another config and was set to neither run nor start at boot; this migration
# records it as it is now.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "第一次恢复不应失败"
printf '{"second":true}\n' > "${host}/etc/second.json"
printf '[Service]\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${host}/etc/second.json" > "${host}/units/kixdns.service"
cp -- "${host}/units/kixdns.service" "${host}/second.service"
migrate_scratch_host "${host}" "${host}/etc/second.json" false false > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
cmp -s -- "${host}/records/external-backup/kixdns.service" "${host}/second.service" ||
  { printf '断言失败：再迁移时应备份主机上现在的 unit\n' >&2; exit 1; }
backup="$(cat "${host}/records/external-backup/install.env")"
assert_contains "${backup}" "KIXDNS_CONFIG=${host}/etc/second.json" "再迁移时应记下现在的原配置"
assert_contains "${backup}" "KIXDNS_WAS_ACTIVE=false" "再迁移时应记下现在没在运行"
assert_contains "${backup}" "KIXDNS_WAS_ENABLED=false" "再迁移时应记下现在不开机自启"
: > "${systemctl_log}"
output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "第二次恢复不应失败"
assert_contains "${output}" "它用的是迁移前的配置 ${host}/etc/second.json，面板改过的副本已删除。" "第二次恢复应用回第二次迁移前的配置"
cmp -s -- "${host}/units/kixdns.service" "${host}/second.service" ||
  { printf '断言失败：第二次恢复应放回第二次迁移前的 unit\n' >&2; exit 1; }
assert_equals "$(restore_calls)" "disable kixdns.service;stop kixdns.service;" "第二次恢复应回到第二次迁移前：不开机自启、不运行"
[[ ! -e ${host}/panel-etc ]] || { printf '断言失败：第二次恢复删除数据时面板配置目录应删掉\n' >&2; exit 1; }

# 恢复到一半失败（原来的 KixDNS 没能启动）：备份和 panel.env 都留着、说清怎么接着恢复，重新运行卸载器能把恢复做完。
# 删除数据时也一样：备份和面板数据要等恢复做完才删。
# A restore failing half way (the original KixDNS would not start): the backup and panel.env stay, the uninstaller says how
# to carry on, and running it again finishes the restore. The same when deleting the data: the backup and the panel data
# go only once the restore is done.
for config_action in keep remove; do
  migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
  output="$(SYSTEMCTL_FAIL_START=true uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_contains "${output}" "RUN-FAILED" "原来的 KixDNS 没能启动时卸载应失败（${config_action}）"
  assert_contains "${output}" "原来的 KixDNS（kixdns.service）没能按迁移前的状态恢复" "恢复失败时应说明（${config_action}）"
  assert_contains "${output}" "| sudo bash -s -- --remove-kixdns --${config_action}-config --yes" \
    "恢复失败时应给出接着恢复的命令（${config_action}）"
  [[ -f ${host}/records/external-backup/install.env && -f ${host}/panel-etc/panel.env ]] ||
    { printf '断言失败：恢复没做完时备份和 panel.env 都要留着（%s）\n' "${config_action}" >&2; exit 1; }
  : > "${systemctl_log}"
  output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_not_contains "${output}" "RUN-FAILED" "重新运行卸载器应把恢复做完（${config_action}）"
  assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "重新运行卸载器应恢复原来的 KixDNS（${config_action}）"
  assert_equals "$(restore_calls)" "enable kixdns.service --quiet;start kixdns.service;" \
    "重新运行卸载器应按迁移前的状态启动（${config_action}）"
  cmp -s -- "${host}/units/kixdns.service" "${host}/original.service" ||
    { printf '断言失败：重新运行卸载器应放回原来的 unit（%s）\n' "${config_action}" >&2; exit 1; }
  [[ ! -e ${host}/records/external-backup ]] || { printf '断言失败：恢复做完后应删掉备份（%s）\n' "${config_action}" >&2; exit 1; }
done
[[ ! -e ${host}/panel-etc ]] || { printf '断言失败：恢复做完后删除数据时面板配置目录应删掉\n' >&2; exit 1; }

# 回归：Type=simple 的服务 fork 成功 systemctl start 就返回 0，原来的 KixDNS 随后崩溃循环（读不了配置之类），卸载却说已恢复、
# 用掉了备份，再运行也接不上。要像安装器那样等它稳定运行；起不来就和启动失败一样，留着备份和 panel.env，说清怎么接着恢复。
# Regression: systemctl start returns 0 once a Type=simple service forks, and the original KixDNS then crash-looped (unable to
# read its config, say) while the uninstall reported it restored and used the backup up, so a rerun could not carry on. Wait
# for it to settle as the installer does; when it does not, keep the backup and panel.env and say how to carry on, as for a
# failed start.
for config_action in keep remove; do
  migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
  output="$(SYSTEMCTL_UNSTABLE=true uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_contains "${output}" "RUN-FAILED" "原来的 KixDNS 起来又崩溃时卸载应失败（${config_action}）"
  assert_contains "${output}" "原来的 KixDNS（kixdns.service）没能按迁移前的状态恢复" "起来又崩溃时应说明没恢复好（${config_action}）"
  assert_contains "${output}" "| sudo bash -s -- --remove-kixdns --${config_action}-config --yes" \
    "起来又崩溃时应给出接着恢复的命令（${config_action}）"
  assert_not_contains "${output}" "原来的 KixDNS 已恢复" "起来又崩溃时不能说已恢复（${config_action}）"
  [[ -f ${host}/records/external-backup/install.env && -f ${host}/panel-etc/panel.env ]] ||
    { printf '断言失败：原来的 KixDNS 没稳定运行时备份和 panel.env 都要留着（%s）\n' "${config_action}" >&2; exit 1; }
  output="$(uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "它能稳定运行以后重新运行卸载器应恢复完（${config_action}）"
done

# 恢复没做完（原来的 KixDNS 起不来）时卸载器有意留下备份，让人查明原因后重跑卸载接着恢复。这时先去安装，安装器不能把这份
# 备份当成旧卸载器留下的过期备份、换成恢复到一半的样子（原来的 KixDNS 停着，迁移前它在运行）：在改动主机之前拒绝，说清先把
# 卸载做完，或者不再恢复就删掉备份。
# When the restore was not finished (the original KixDNS would not start) the uninstaller leaves the backup on purpose, so the
# uninstall can be rerun once the cause is found. Installing at that point, the installer must not take the backup for a
# stale one an older uninstaller left and replace it with the half-restored state (the original KixDNS stopped, while it was
# running before the migration): it refuses before touching the host and says to finish the uninstall first, or to remove
# the backup when the restore is not wanted any more.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
output="$(SYSTEMCTL_FAIL_START=true uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "RUN-FAILED" "原来的 KixDNS 起不来时卸载应失败"
backup_before="$(cat "${host}/records/external-backup/install.env")"
output="$(migrate_scratch_host "${host}" "${host}/etc/kixdns.json" false true 2>&1)" || true
assert_equals "$(cat "${host}/records/external-backup/install.env")" "${backup_before}" \
  "恢复没做完时安装器不能换掉迁移前的备份"
assert_contains "${output}" "安装失败：上次卸载没有把原来的 KixDNS 恢复完，迁移前的备份还在 ${host}/records/external-backup。" \
  "恢复没做完时安装器应拒绝并说明"
assert_contains "${output}" "| sudo bash -s -- --remove-kixdns --keep-config --yes" "拒绝时应给出用同样选项接着卸载的命令"
assert_contains "${output}" "sudo rm -rf ${host}/records/external-backup" "拒绝时应说明不再恢复就删掉备份"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "接着卸载应把恢复做完"
[[ ! -e ${host}/records/external-backup ]] || { printf '断言失败：恢复做完后应删掉备份和它的标记\n' >&2; exit 1; }

# 保留增强版、删除面板数据：保留的 KixDNS 还在用副本，副本和它的目录必须留下，面板配置目录里的其他东西照删；
# 再卸载一次（这时已经没有 panel.env）也一样。
# Keeping the enhanced KixDNS and removing the panel data: the kept KixDNS still runs the copy, so the copy and its
# directory must stay while everything else in the panel's config directory goes; a second uninstall (with no panel.env
# by then) does the same.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
: > "${host}/panel-etc/leftover"
output="$(uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留增强版删除数据不应失败"
assert_equals "$(cat "${host}/panel-etc/kixdns/pipeline.json" 2>/dev/null || printf missing)" '{"edited":true}' \
  "保留的 KixDNS 用的副本必须留下"
[[ ! -e ${host}/panel-etc/panel.env && ! -e ${host}/panel-etc/leftover ]] ||
  { printf '断言失败：删除数据时面板配置目录里副本以外的东西应删掉\n' >&2; exit 1; }
[[ -x ${host}/state/bin/kixdns ]] || { printf '断言失败：保留的 KixDNS 程序必须留下\n' >&2; exit 1; }
output="$(uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "再次卸载不应失败"
assert_equals "$(cat "${host}/panel-etc/kixdns/pipeline.json" 2>/dev/null || printf missing)" '{"edited":true}' \
  "再次卸载也不能删掉保留的 KixDNS 用的副本"

# 保留 KixDNS、删除面板数据：面板账号随后删掉，它名下还留着的东西就归了一个空出来的 UID，以后建的账号拿到这个 UID 就能改正在
# 运行的 DNS 的配置。保留的 KixDNS 要用的（程序、配置、配置里写着的面板目录里的文件，比如面板导入的 GeoSite）改归 root，组和权限
# 按 systemd 加载的 unit 运行用的账号定（和交还原配置一样）；面板的其他数据（查询日志、内核版本、没用到的 Geo 文件、写到一半的
# 临时文件）删掉。回归：配置目录和配置还归删掉的面板账号；面板导入的 GeoSite 随 geo 目录删掉，保留的 KixDNS 下次重启就少了它；
# 查询日志等留着、也归那个 UID；程序交给了 kixdns 账号自己，DNS 进程能改写自己的程序。
# Keeping KixDNS and removing the panel data: the panel account goes right after, so whatever it still owns falls to a freed
# UID, and a later account given that UID could rewrite the running DNS's config. What the kept KixDNS needs (its program,
# its config, the files in the panel's directories its config names, such as the GeoSite the panel imported) is handed to
# root, with the group and mode set by the account the loaded unit runs as (as for handing back an original config); the
# panel's other data (query log, kernel versions, unused Geo files, half-written temporary files) goes. Regression: the
# config directory and config stayed with the removed panel account; the imported GeoSite went with the geo directory, so the
# kept KixDNS lost it at its next restart; the query log and others stayed, owned by that UID; the program was handed to the
# kixdns account itself, so the DNS process could rewrite its own program.
kept_host() {
  local root=$1
  rm -rf -- "${root}"
  mkdir -p "${root}/etc-kixdns" "${root}/units" "${root}/state/bin" "${root}/state/geo" "${root}/state/querylog" \
    "${root}/state/bundle" "${root}/state/versions/2026.11.07" "${root}/panel-etc"
  printf 'geosite\n' > "${root}/state/geo/site-abc.dat"
  printf 'old\n' > "${root}/state/geo/site-old.dat"
  : > "${root}/state/querylog/2026-11-19T00.jsonl.zst"
  : > "${root}/state/bundle/KIXDNS_SOURCE.json"
  : > "${root}/state/versions/2026.11.07/kixdns"
  : > "${root}/state/panel.db"
  printf '{"settings":{"geosite_data_paths":["%s"]}}\n' "${root}/state/geo/site-abc.dat" > "${root}/etc-kixdns/pipeline.json"
  : > "${root}/etc-kixdns/.kixdns-panel-Ab12Cd"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=%s\n' "${root}/etc-kixdns/pipeline.json" > "${root}/panel-etc/panel.env"
  printf '[Service]\nUser=kixdns\nGroup=kixdns\nExecStart=%s run --config %s --admin-socket /run/kixdns/admin.sock\n' \
    "${root}/state/bin/kixdns" "${root}/etc-kixdns/pipeline.json" > "${root}/units/kixdns.service"
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  chmod 0755 "${root}/state/bin/kixdns"
}
chown_log="${scratch}/chown.log"
# 改成了谁、权限是多少；chown 带不带 -h 都算（交还时一律不跟着符号链接改）/ Who it became and its mode; chown with or
# without -h alike (handing back never follows a symlink)
kept_owner_of() {
  grep -Fx -e "chown $1 -- $2" -e "chown -h $1 -- $2" "${chown_log}" > /dev/null && printf '%s %s\n' "$1" "$(stat -c '%a' "$2")"
}
# 回归（U3）：安装器关掉 resolved 监听时的记录在只有 root 能进的目录里，保留 KixDNS、删除面板数据时留着它：卸载器给出的恢复命令
# 要用它。
# Regression (U3): the record the installer left when it turned resolved's stub off lives in the root-only directory, and
# keeping KixDNS while removing the panel data leaves it: the restore commands the uninstaller prints need it.
kept_host "${host}"
mkdir -p "${host}/records/resolved-stub"
chmod 0700 "${host}/records" "${host}/records/resolved-stub"
printf 'RESOLV_CONF_KIND=file\n' > "${host}/records/resolved-stub/install.env"
printf 'nameserver 127.0.0.53\n' > "${host}/records/resolved-stub/resolv.conf"
output="$(PANEL_OWNED=true ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_contains "${output}" "sudo cp -a --remove-destination ${host}/records/resolved-stub/resolv.conf" "保留 KixDNS 时应给出恢复 resolv.conf 的命令"
[[ -f ${host}/records/resolved-stub/resolv.conf && -f ${host}/records/resolved-stub/install.env ]] ||
  { printf '断言失败：恢复命令要用的 resolved 记录必须留着\n' >&2; exit 1; }
kept_host "${host}"
: > "${chown_log}"
: > "${systemctl_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} SYSTEMCTL_LOG=${systemctl_log} ACCOUNTS_PRESENT=true \
  uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留 KixDNS、删除面板数据不应失败"
for kept_path in etc-kixdns state state/bin state/geo; do
  assert_equals "$(kept_owner_of root:kixdns "${host}/${kept_path}")" "root:kixdns 750" "${kept_path} 应归 root、kixdns 组能进"
done
assert_equals "$(kept_owner_of root:kixdns "${host}/state/bin/kixdns")" "root:kixdns 750" "保留的程序应归 root、kixdns 组能运行"
for kept_path in etc-kixdns/pipeline.json state/geo/site-abc.dat; do
  assert_equals "$(kept_owner_of root:kixdns "${host}/${kept_path}")" "root:kixdns 640" "${kept_path} 应归 root、kixdns 组只读"
done
assert_not_contains "$(cat "${chown_log}")" "kixdns:kixdns" "保留的东西不能交给 kixdns 账号自己"
for gone_path in state/geo/site-old.dat state/querylog state/bundle state/versions state/panel.db etc-kixdns/.kixdns-panel-Ab12Cd; do
  [[ ! -e ${host}/${gone_path} ]] || { printf '断言失败：面板的数据 %s 应删掉\n' "${gone_path}" >&2; exit 1; }
done
assert_equals "$(cat "${host}/state/geo/site-abc.dat" 2>/dev/null || printf missing)" "geosite" "保留的 KixDNS 配置里写着的 GeoSite 必须留着"
assert_not_contains "$(cat "${systemctl_log}")" "kixdns.service" "保留 KixDNS 时不能停它"
assert_contains "${output}" "保留的 KixDNS 用到的程序、配置和文件改归 root，面板的其他数据已删除。" "交还时应说明"
# 回归（P1）：交还给 root 的只能是面板目录里真的那个文件：硬链接到别处的（改它的属主就改到别处去了）不改属主、不读。面板账号
# 的进程在这之前一个不剩地停掉，查过以后它就换不了了。
# Regression (P1): only the real file in the panel's directory is handed to root: one hard-linked from elsewhere (changing
# its owner changes it elsewhere) is neither re-owned nor read. Every process of the panel account is stopped before that,
# so nothing can swap it after the check.
kept_host "${host}"
mkdir -p "${host}/elsewhere"
printf 'secret\n' > "${host}/elsewhere/shadow"
rm -f -- "${host}/etc-kixdns/pipeline.json" "${host}/state/geo/site-abc.dat"
ln "${host}/elsewhere/shadow" "${host}/etc-kixdns/pipeline.json"
ln "${host}/elsewhere/shadow" "${host}/state/geo/site-abc.dat"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "$(cat "${chown_log}")" "${host}/etc-kixdns/pipeline.json" "硬链接到别处的配置不能改属主"
assert_not_contains "$(cat "${chown_log}")" "${host}/state/geo/site-abc.dat" "硬链接到别处的 Geo 文件不能改属主"
run_body="$(declare -f run_uninstall)"
components_line="$(grep -n 'remove_panel_components' <<< "${run_body}" | head -n 1 | cut -d: -f1 || true)"
stop_line="$(grep -n 'stop_panel_processes' <<< "${run_body}" | head -n 1 | cut -d: -f1 || true)"
removal_line="$(grep -n 'remove_managed_kixdns' <<< "${run_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${stop_line} && ${components_line} -lt ${stop_line} && ${stop_line} -lt ${removal_line} ]] || {
  printf '断言失败：面板停了以后、动面板的目录之前，要停掉面板账号的所有进程（components=%s stop=%s removal=%s）\n' \
    "${components_line}" "${stop_line}" "${removal_line}" >&2
  exit 1
}
# 上次卸载是旧版卸载器做的，已经留下了归空 UID 的配置：没有 panel.env 时按保留的 unit 认出它的配置，照样交还。
# An older uninstaller already left the config to a freed UID: without panel.env the config is found from the kept unit and
# handed back all the same.
kept_host "${host}"
rm -f -- "${host}/panel-etc/panel.env"
rm -rf -- "${host}/state/geo/site-old.dat" "${host}/state/querylog" "${host}/state/bundle" "${host}/state/versions"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "旧版卸载器之后再卸载不应失败"
assert_equals "$(kept_owner_of root:kixdns "${host}/etc-kixdns/pipeline.json")" "root:kixdns 640" "没有 panel.env 时也应按保留的 unit 交还它的配置"
# 迁移来的主机保留增强版：它用的是 /etc/kixdns-panel/kixdns 里的副本，那个目录和它上面的面板配置目录也交给 unit 运行用的组。
# A migrated host keeping the enhanced KixDNS runs the copy in /etc/kixdns-panel/kixdns: that directory and the panel config
# directory above it go to the unit's group too.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
sed -i 's|^\[Service\]$|[Service]\nUser=kixdns\nGroup=kixdns|' "${host}/units/kixdns.service"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留增强版删除数据不应失败"
assert_equals "$(kept_owner_of root:kixdns "${host}/panel-etc/kixdns")" "root:kixdns 750" "副本的目录应归 root、kixdns 组能进"
assert_equals "$(kept_owner_of root:kixdns "${host}/panel-etc/kixdns/pipeline.json")" "root:kixdns 640" "副本应归 root、kixdns 组只读"
assert_equals "$(kept_owner_of root:kixdns "${host}/panel-etc")" "root:kixdns 750" "副本上面的面板配置目录 kixdns 组也要能进"

# 旧版安装器原地迁移的主机：没有副本，卸载照旧不动它的配置，但要说明那是面板改过的内容。
# A host an older installer migrated in place: there is no copy, uninstall leaves its config alone as before, but says
# it holds what the panel saved.
inplace_host() {
  local root=$1
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/units" "${root}/state/bin" "${root}/state/external-backup" "${root}/panel-etc"
  printf '{"edited":true}\n' > "${root}/etc/kixdns.json"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=%s\n' "${root}/etc/kixdns.json" > "${root}/panel-etc/panel.env"
  printf '%s\n' KIXDNS_SERVICE_UNIT=kixdns.service "KIXDNS_CONFIG=${root}/etc/kixdns.json" \
    KIXDNS_BINARY=/usr/local/bin/kixdns KIXDNS_WAS_ACTIVE=true KIXDNS_WAS_ENABLED=true \
    > "${root}/state/external-backup/install.env"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${root}/etc/kixdns.json" \
    > "${root}/state/external-backup/kixdns.service"
  printf '[Service]\nExecStart=%s run --config %s --admin-socket /run/kixdns/admin.sock\n' \
    "${root}/state/bin/kixdns" "${root}/etc/kixdns.json" > "${root}/units/kixdns.service"
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  chmod 0755 "${root}/state/bin/kixdns"
  # 旧版安装器建的备份：目录 0700、文件 0600 / The backup the older installer made: directory 0700, files 0600
  chmod 0700 "${root}/state/external-backup"
  chmod 0600 "${root}/state/external-backup/install.env" "${root}/state/external-backup/kixdns.service"
  # 旧版原地迁移把原配置的目录和文件交给了面板 / The older in-place migration handed the original's directory and file to the panel
  chmod 0750 "${root}/etc"
  chmod 0640 "${root}/etc/kixdns.json"
}
# 旧版原地迁移、配置在公共目录里的主机保留增强版：公共目录只交还 root:root 0755，不能收紧成 0750；unit 以 root 运行时配置只留给 root。
# A host an older version migrated in place, its config in a shared directory, keeping the enhanced KixDNS: the shared
# directory is only handed back as root:root 0755, never tightened to 0750; with the unit running as root the config is left
# to root alone.
inplace_host "${host}"
: > "${host}/etc/passwd-like"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "公共目录里的配置保留时不应失败"
assert_equals "$(kept_owner_of root:root "${host}/etc")" "root:root 755" "公共目录只交还 root、谁都能进"
assert_equals "$(kept_owner_of root:root "${host}/etc/kixdns.json")" "root:root 600" "unit 以 root 运行时配置只留给 root"
inplace_host "${host}"
output="$(PANEL_OWNED=true uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "原地迁移的主机卸载不应失败"
assert_equals "$(cat "${host}/etc/kixdns.json" 2>/dev/null || printf missing)" '{"edited":true}' "原地迁移的主机卸载时不动它的配置"
assert_contains "${output}" "它用的配置 ${host}/etc/kixdns.json 是面板最后保存的内容：旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底。" \
  "原地迁移的主机卸载时应说明配置是面板改过的"
# 同类（I1）：没升级过、直接卸载恢复的旧版原地迁移主机，原配置和它的目录还归面板（kixdns-panel:kixdns，面板账号删掉以后就归了
# 一个不存在的 UID；以非 root 账号运行的原来的 KixDNS 还读不到它）。恢复时和升级时一样交还：目录 root:root 0755，文件归 root、
# 组是原来的 unit 运行用的组（这里以 root 运行：0600），并列出改了什么。
# Sibling (I1): on a host an older version migrated in place and restored straight away without an upgrade, the original
# config and its directory still belonged to the panel (kixdns-panel:kixdns, a UID that no longer exists once the panel
# account is removed; an original KixDNS running as a non-root account could not even read it). The restore hands them back
# as an upgrade does: the directory root:root 0755, the file owned by root with the group the original unit runs as (root
# here: 0600), and lists what changed.
assert_equals "$(stat -c '%a' "${host}/etc")" "755" "恢复时原配置的目录应交还、谁都能进"
assert_equals "$(stat -c '%a' "${host}/etc/kixdns.json")" "600" "原来的 KixDNS 以 root 运行时原配置只留给 root"
assert_contains "${output}" "旧版迁移时把原配置交给了面板，没有记下它原来的属主和权限，交还给原来的 KixDNS 时改成：" "恢复时应说明为什么改属主"
assert_contains "${output}" "  ${host}/etc：" "恢复时应列出改了的目录"
assert_contains "${output}" "  ${host}/etc/kixdns.json：" "恢复时应列出改了的文件"
# 回归（S2）：旧版的 unit 不在 /etc/systemd/system 时备份里没有它（service-file-missing）。以前这时看不出原来的 KixDNS 以谁运行，
# 0700 目录里的私有配置交还成谁都能读的 0644；现在按名字在 systemd 的搜索路径上找到它，照它的 User= 交还。
# Regression (S2): when the older version's unit lived outside /etc/systemd/system the backup lacks it
# (service-file-missing). Who the original KixDNS ran as could not be told then, and a private config in a 0700 directory
# came back world-readable 0644; now the unit is found by name on the systemd search path and its User= decides.
inplace_host "${host}"
rm -f -- "${host}/state/external-backup/kixdns.service"
: > "${host}/state/external-backup/service-file-missing"
chmod 0600 "${host}/state/external-backup/service-file-missing"
mkdir -p "${host}/vendor-units"
printf '[Service]\nUser=kxu\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${host}/etc/kixdns.json" \
  > "${host}/vendor-units/kixdns.service"
: > "${chown_log}"
output="$(OTHER_UNIT_DIRECTORY=${host}/vendor-units PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true \
  uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "unit 不在备份里的原地迁移主机卸载不应失败"
assert_equals "$(kept_owner_of root:990 "${host}/etc/kixdns.json")" "root:990 640" \
  "unit 不在备份里时应按名字找到它，按它运行用的账号交还，不能交还成谁都能读"
# 回归（P1）：交还的原配置硬链接到别处时不改它：改属主、权限就改到别处去了。
# Regression (P1): an original config hard-linked from elsewhere is not handed back: changing its owner and mode would
# change something else.
inplace_host "${host}"
mkdir -p "${host}/elsewhere"
ln -- "${host}/etc/kixdns.json" "${host}/elsewhere/shadow"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "$(cat "${chown_log}")" "${host}/etc/kixdns.json" "硬链接到别处的原配置不能改属主"
assert_equals "$(stat -c '%a' "${host}/elsewhere/shadow")" "640" "硬链接到别处的原配置不能改权限"
# 只列真改了的：目录已经是 0755 时不列它。/ Only what really changed is listed: a directory already 0755 is not.
inplace_host "${host}"
chmod 0755 "${host}/etc"
output="$(PANEL_OWNED=true uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "  ${host}/etc：" "没改的目录不能列出"
assert_contains "${output}" "  ${host}/etc/kixdns.json：" "改了的配置照旧列出"
# 管理员已经把目录改回 root：照他改的留着。/ The admin already gave the directory back to root: it stays as he set it.
inplace_host "${host}"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_equals "$(stat -c '%a' "${host}/etc")" "750" "不归面板的目录不能再交还"
# 回归（S3）：没升级过的旧版原地迁移主机，保留 KixDNS 和面板数据卸载（--keep-kixdns --keep-config）：面板的 KixDNS 接着用原配置，
# 可旧版交给面板的原配置目录（这里是 /etc 这样的公共目录）以前一直归面板（kixdns-panel:kixdns 0750，别的账号连 /etc 都进不去）。
# 面板卸载了，目录交还 root:root 0755 并列出来；配置文件留给接着运行的 KixDNS 读，以后重装时再交还。
# Regression (S3): a host an older version migrated in place and never upgraded, uninstalled keeping KixDNS and the panel
# data (--keep-kixdns --keep-config): the panel's KixDNS goes on with the original config, but the original's directory
# the older version gave the panel (a shared one such as /etc here) used to stay the panel's (kixdns-panel:kixdns 0750,
# other accounts could not even enter /etc). The panel is gone, so the directory goes back as root:root 0755 and is
# listed; the config file stays readable for the KixDNS that keeps running and is handed back at a later reinstall.
inplace_host "${host}"
: > "${host}/etc/passwd-like"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留 KixDNS 和数据卸载旧版原地迁移的主机不应失败"
assert_equals "$(kept_owner_of root:root "${host}/etc")" "root:root 755" "保留 KixDNS 和数据时原配置的目录也应交还 root"
assert_contains "${output}" "旧版迁移时把原配置所在的目录交给了面板，面板卸载以后交还：" "交还目录时应说明"
assert_contains "${output}" "  ${host}/etc：" "交还目录时应列出它"
assert_not_contains "$(cat "${chown_log}")" "${host}/etc/kixdns.json" "接着运行的 KixDNS 要读的配置这时不动"
[[ -f ${host}/records/external-backup/install.env ]] || { printf '断言失败：保留 KixDNS 时迁移前的备份要留着\n' >&2; exit 1; }
# 升级时已经改管副本的旧版原地迁移主机：恢复时删副本、放回原 unit，原配置里是升级那时面板保存的内容，要照实说。
# A host an older version migrated in place and an upgrade moved onto a copy: the restore removes the copy and puts the
# original unit back, and the original holds what the panel had saved at that upgrade, which is said as it is.
inplace_host "${host}"
mkdir -p "${host}/panel-etc/kixdns"
printf '{"after-upgrade":true}\n' > "${host}/panel-etc/kixdns/pipeline.json"
sed -i "s|^KIXDNS_CONFIG=.*|KIXDNS_CONFIG=${host}/panel-etc/kixdns/pipeline.json|" "${host}/panel-etc/panel.env"
printf '%s\n' "KIXDNS_MANAGED_CONFIG=${host}/panel-etc/kixdns/pipeline.json" KIXDNS_LEGACY_IN_PLACE=true \
  >> "${host}/state/external-backup/install.env"
chmod 0755 "${host}/etc"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "改管副本以后的旧主机卸载不应失败"
assert_contains "${output}" "它用的配置 ${host}/etc/kixdns.json 是升级到新版那时面板保存的内容（旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底），之后改的副本已删除。" \
  "改管副本以后的旧主机恢复时应照实说原配置里是什么"
assert_not_contains "${output}" "它用的是迁移前的配置" "改管副本以后的旧主机，原配置不是迁移前的"
assert_not_contains "${output}" "没有记下它原来的属主和权限" "升级时已经交还过，恢复时不用再交还"
[[ ! -e ${host}/panel-etc/kixdns ]] || { printf '断言失败：恢复时应删掉副本\n' >&2; exit 1; }

# 原来的 KixDNS 的配置本来就在副本的位置、被原地接管：那是它自己的配置，不是副本，移除增强版时不能删。
# The original KixDNS's config already sat where the copy goes and was managed in place: it is its own config, not a copy,
# and removing the enhanced KixDNS must not delete it.
inplace_host "${host}"
mkdir -p "${host}/panel-etc/kixdns"
printf '{"own":true}\n' > "${host}/panel-etc/kixdns/pipeline.json"
sed -i "s|${host}/etc/kixdns.json|${host}/panel-etc/kixdns/pipeline.json|" \
  "${host}/panel-etc/panel.env" "${host}/state/external-backup/install.env"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "配置在副本位置的原地迁移主机卸载不应失败"
assert_equals "$(cat "${host}/panel-etc/kixdns/pipeline.json" 2>/dev/null || printf missing)" '{"own":true}' \
  "原来的 KixDNS 自己的配置不能当成副本删掉"

# 删副本之前确认面板配置目录不是符号链接：rm -rf 会顺着它删到别处。
# Before removing the copy, make sure the panel's config directory is no symlink: rm -rf would follow it elsewhere.
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
mv -- "${host}/panel-etc" "${host}/panel-etc-real"
ln -s "${host}/panel-etc-real" "${host}/panel-etc"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "配置目录不能是符号链接" "面板配置目录是符号链接时应拒绝删除副本"
[[ -f ${host}/panel-etc-real/kixdns/pipeline.json ]] || { printf '断言失败：拒绝时不能删掉符号链接另一头的文件\n' >&2; exit 1; }
rm -f -- "${host}/panel-etc"

# 全新安装的主机：配置目录按 panel.env 记下的路径认，是安装器建的 /etc/kixdns 才删，别的目录不凭猜测删。
# A freshly installed host: the config directory is recognised from the path panel.env recorded; only the /etc/kixdns the
# installer creates is removed, and no other directory is removed on a guess.
fresh_host() {
  local root=$1
  local config=$2
  rm -rf -- "${root}"
  mkdir -p "${root}/etc-kixdns" "${root}/elsewhere" "${root}/units" "${root}/state/bin" "${root}/panel-etc"
  printf '{}\n' > "${root}/etc-kixdns/pipeline.json"
  printf '{}\n' > "${root}/elsewhere/pipeline.json"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=%s\n' "${config}" > "${root}/panel-etc/panel.env"
  printf '[Service]\nExecStart=%s run --config %s --admin-socket /run/kixdns/admin.sock\n' \
    "${root}/state/bin/kixdns" "${config}" > "${root}/units/kixdns.service"
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  chmod 0755 "${root}/state/bin/kixdns"
}
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "全新安装的主机卸载不应失败"
[[ ! -e ${host}/etc-kixdns ]] || { printf '断言失败：全新安装的配置目录应随 KixDNS 删掉\n' >&2; exit 1; }
fresh_host "${host}" "${host}/elsewhere/pipeline.json"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "配置不在默认位置的主机卸载不应失败"
[[ -e ${host}/etc-kixdns && -e ${host}/elsewhere/pipeline.json ]] ||
  { printf '断言失败：panel.env 没指向的目录不能删\n' >&2; exit 1; }

# 回归（P2）：面板账号拥有 /var/lib/kixdns-panel，能在那里放一份自己写的「迁移前的备份」，卸载器照着它装 unit、启动，面板就成了
# root。root 要照着做事的记录现在只放在只有 root 能进的目录里；旧版留在状态目录里的，先挪进去（一次 rename，挪进来以后面板就碰
# 不到了）再验：目录和每个文件都归 root、不是符号链接、只有一个链接，不对就拒绝照它们做事。
# Regression (P2): the panel account owns /var/lib/kixdns-panel, so it could put a "pre-migration backup" of its own
# there, and the uninstaller installed and started the unit it named, making the panel root. The records root acts on now
# live only in a root-only directory; ones an older version left in the state directory are moved there first (one rename,
# after which the panel cannot touch them) and checked afterwards: the directory and every file root's, no symlinks, one
# link each, or nothing is done by them.
plant_backup() {
  mkdir -p "${host}/state/external-backup"
  printf '%s\n' KIXDNS_SERVICE_UNIT=pwn.service KIXDNS_CONFIG=/nonexistent KIXDNS_BINARY=/bin/true KIXDNS_WAS_ACTIVE=true \
    KIXDNS_WAS_ENABLED=false > "${host}/state/external-backup/install.env"
  printf '[Service]\nExecStart=/bin/sh -c "id > /root/pwned"\n' > "${host}/state/external-backup/kixdns.service"
}
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
plant_backup
: > "${systemctl_log}"
output="$(FORGED_RECORDS=true SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
# S1（第四轮）：以前在这里停下，面板每次一起来又放一份，以后每次卸载都停在这里；现在挪走、当作没有备份接着卸载
# S1 (fourth review): this used to stop the run, and as the panel planted a new one whenever it started, every later
# uninstall stopped too; now it is moved away and the uninstall goes on as if there were no backup
assert_not_contains "${output}" "RUN-FAILED" "面板写的备份不能让卸载停下"
assert_contains "${output}" "不是 root 建的" "应说明备份不是 root 的"
assert_contains "${output}" "这台主机就当作没有这份记录。" "面板写的备份应当作没有"
[[ ! -e ${host}/units/pwn.service ]] || { printf '断言失败：不能照面板写的备份装 unit\n' >&2; exit 1; }
assert_not_contains "$(cat "${systemctl_log}")" "pwn.service" "不能启动面板写的备份里的 unit"
assert_contains "${output}" "${host}/records/quarantine 里还有挪走的、不能信的记录，留着给你查看" "删除面板数据时应说明 quarantine 里还有东西"
[[ ! -e ${host}/records/external-backup && ! -e ${host}/state/external-backup ]] ||
  { printf '断言失败：拒绝时可疑的备份不能还留在会被信的名字上\n' >&2; exit 1; }
[[ -n "$(find "${host}/records/quarantine" -mindepth 1 -maxdepth 1 -name 'external-backup.*' -print -quit 2>/dev/null)" ]] ||
  { printf '断言失败：拒绝时可疑的备份应挪进只有 root 能进的 quarantine\n' >&2; exit 1; }
# 旧版留在状态目录里的、root 建的备份：面板停了以后验过、挪进只有 root 能进的目录照常用；就算没真的开始卸载就退出，也留在那里：
# 放回去就又成了面板能换掉的东西（安装器和卸载器要一起换成新的，见 PR）。
# A backup an older version left in the state directory, root's own: checked once the panel has stopped, moved into the
# root-only directory and used as usual; it stays there even when the run ends before the uninstall really starts:
# putting it back would make it something the panel can replace again (installer and uninstaller ship together, see the PR).
inplace_host "${host}"
(
  PANEL_STATE_DIRECTORY="${host}/state"
  ROOT_RECORDS="${host}/records"
  EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
  ROOT_UID="$(id -u)"
  ROOT_CHAIN_TOP=${host}
  install() {
    local arguments=()
    while [[ $# -gt 0 ]]; do
      case $1 in -o | -g) shift ;; *) arguments+=("$1") ;; esac
      shift
    done
    command install "${arguments[@]}"
  }
  chown() { :; }
  secure_root_records
  [[ -f ${host}/records/external-backup/install.env ]] && printf 'MOVED\n'
) > "${scratch}/records.out" 2>&1 || true
assert_contains "$(cat "${scratch}/records.out")" "MOVED" "root 建的旧备份应挪进只有 root 能进的目录"
[[ -f ${host}/records/external-backup/install.env && ! -e ${host}/state/external-backup ]] ||
  { printf '断言失败：挪进只有 root 能进的目录的备份不能再放回面板能写的地方\n' >&2; exit 1; }
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "原来的 KixDNS 已恢复" "旧位置的 root 备份挪过来以后照常恢复"
[[ ! -e ${host}/state/external-backup && ! -e ${host}/records/external-backup ]] ||
  { printf '断言失败：恢复做完后两处都不应留着备份\n' >&2; exit 1; }

# ---------------------------------------------------------------------------
# 面板管的 KixDNS 走了以后再卸载 / Uninstalling again once the panel's KixDNS is gone
# ---------------------------------------------------------------------------

account_log="${scratch}/accounts.log"
account_calls() { tr '\n' ';' < "${account_log}"; }

# 迁移建的 kixdns 账号和组：迁移时记进备份，卸载恢复、删除面板数据时一起删；原来就有的不动。保留面板数据恢复时记进 panel.env，
# 以后删除面板数据时再删；账号还有别的进程在用时留着它和组。回归：恢复以后，迁移建的账号和组一直留着。
# The kixdns account and group a migration created: recorded in the backup, removed with the panel data when uninstalling
# restores the original; ones that were there already stay. A restore that keeps the panel data carries the record into
# panel.env, and a later removal of the panel data removes them then; while other processes still use the account, it stays
# with the group. Regression: after a restore the account and group the migration created stayed for good.
ACCOUNTS_MISSING=true migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
backup="$(cat "${host}/records/external-backup/install.env")"
assert_contains "${backup}" "KIXDNS_USER_CREATED=true" "迁移建了 kixdns 账号时备份应记下"
assert_contains "${backup}" "KIXDNS_GROUP_CREATED=true" "迁移建了 kixdns 组时备份应记下"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "恢复并删除数据不应失败"
assert_equals "$(account_calls)" "userdel kixdns-panel;userdel kixdns;groupdel kixdns;" "恢复并删除数据时应删掉迁移建的账号和组"
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
assert_contains "$(cat "${host}/records/external-backup/install.env")" "KIXDNS_USER_CREATED=false" "账号原来就有时备份应记下不是迁移建的"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_equals "$(account_calls)" "userdel kixdns-panel;" "原来就有的 kixdns 账号和组不能删"
ACCOUNTS_MISSING=true migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
output="$(ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "$(cat "${host}/panel-etc/panel.env")" "KIXDNS_USER_CREATED=true" "保留数据恢复时应把迁移建的账号记进 panel.env"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_contains "${output}" "这台机器的 KixDNS 不归面板管理" "恢复以后再卸载时 KixDNS 已不归面板管"
assert_equals "$(account_calls)" "userdel kixdns-panel;userdel kixdns;groupdel kixdns;" "以后删除数据时应删掉迁移建的账号和组"
ACCOUNTS_MISSING=true migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_BUSY=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_equals "$(account_calls)" "userdel kixdns-panel;" "kixdns 账号还有别的进程在用时不能删它和组"
assert_contains "${output}" "kixdns 账号还有别的进程或服务在用，保留它和 kixdns 组。" "保留 kixdns 账号时应说明"

# 全新安装的主机，--remove-kixdns --keep-config 移除了面板自己的 KixDNS：保留的 panel.env 记下 KixDNS 已不归面板管，以后的卸载
# 不再停、不再删这个名字的 unit。用户接着在 /usr/local/lib/systemd/system 装了自己的同名 KixDNS，配置放在 /etc/kixdns 里；再
# 删除面板数据时：不碰它的服务，/etc/kixdns 里只删面板写的配置，目录留着、交还 root。回归：panel.env 还说归面板管，卸载器只看
# /etc/systemd/system 里的文件，停掉、禁用了用户的 KixDNS，删掉整个 /etc/kixdns 和 kixdns 账号。
# A freshly installed host where --remove-kixdns --keep-config removed the panel's own KixDNS: the kept panel.env records
# that the KixDNS is no longer the panel's, and later uninstalls neither stop nor remove a unit of that name. The user then
# installs their own KixDNS of the same name in /usr/local/lib/systemd/system with its config in /etc/kixdns; removing the
# panel data then leaves its service alone and removes only the config the panel wrote in /etc/kixdns, keeping the directory
# and handing it to root. Regression: panel.env still said the panel's, the uninstaller looked only at the file in
# /etc/systemd/system, stopped and disabled the user's KixDNS, and removed all of /etc/kixdns and the kixdns account.
other_units="${scratch}/other-units"
own_kixdns() {
  mkdir -p "${other_units}"
  printf '{"own":true}\n' > "${host}/etc-kixdns/own.json"
  printf '[Service]\n%bExecStart=/usr/local/sbin/kixdns run --config %s\n' "${1:-}" "${host}/etc-kixdns/own.json" \
    > "${other_units}/kixdns.service"
}
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
chmod 0750 "${host}/etc-kixdns"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "移除面板自己的 KixDNS、保留数据不应失败"
panel_env="$(cat "${host}/panel-etc/panel.env")"
assert_contains "${panel_env}" "KIXDNS_MANAGEMENT_ENABLED=false" "移除面板的 KixDNS、保留 panel.env 时应记下 KixDNS 已不归面板管"
assert_contains "${panel_env}" "KIXDNS_REMOVED=true" "移除面板的 KixDNS、保留 panel.env 时应记下它的配置和账号留着待删"
[[ -f ${host}/etc-kixdns/pipeline.json && ! -e ${host}/units/kixdns.service ]] ||
  { printf '断言失败：保留数据时配置应留着、面板的 unit 应删掉\n' >&2; exit 1; }
own_kixdns
: > "${systemctl_log}"
: > "${account_log}"
# 交还目录前要看它还归不归面板：临时主机上的文件都算面板的 / Handing a directory back checks it is still the panel's: every
# file of the scratch host counts as the panel's
output="$(OTHER_UNIT_DIRECTORY=${other_units} SYSTEMCTL_LOG=${systemctl_log} ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} \
  PANEL_OWNED=true uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "以后删除数据不应失败"
assert_not_contains "$(cat "${systemctl_log}")" "kixdns.service" "以后再卸载不能停、不能禁用用户自己的 KixDNS"
[[ -f ${other_units}/kixdns.service && -f ${host}/etc-kixdns/own.json ]] ||
  { printf '断言失败：用户自己的 unit 和配置必须留着\n' >&2; exit 1; }
[[ ! -e ${host}/etc-kixdns/pipeline.json ]] || { printf '断言失败：删除数据时应删掉面板写的配置\n' >&2; exit 1; }
assert_equals "$(stat -c '%a' "${host}/etc-kixdns")" "755" "留下的 /etc/kixdns 应交还 root、谁都能进"
assert_contains "${output}" "${host}/etc-kixdns 里还有不是面板写的文件，目录留着，只删了面板写的配置。" "留下目录时应说明"
assert_equals "$(account_calls)" "userdel kixdns-panel;userdel kixdns;groupdel kixdns;" "以后删除数据时应删掉面板建的 kixdns 账号和组"
# 用户自己的 KixDNS 也用 kixdns 账号：账号和组留着。/ The user's own KixDNS uses the kixdns account too: it stays with the group.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes > /dev/null
own_kixdns 'User=kixdns\n'
: > "${account_log}"
output="$(OTHER_UNIT_DIRECTORY=${other_units} ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} \
  uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_equals "$(account_calls)" "userdel kixdns-panel;" "用户自己的 KixDNS 用着 kixdns 账号时不能删它和组"
# /etc/kixdns 里只剩面板写的文件（配置和写到一半的临时文件）：整个删掉。/ Only files the panel wrote are left in /etc/kixdns
# (the config and a half-written temporary file): the whole directory goes.
rm -rf -- "${other_units}"
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes > /dev/null
: > "${host}/etc-kixdns/.kixdns-panel-Ab12Cd"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "只剩面板文件时删除数据不应失败"
[[ ! -e ${host}/etc-kixdns ]] || { printf '断言失败：/etc/kixdns 里只剩面板写的文件时应整个删掉\n' >&2; exit 1; }
# /etc/kixdns 里的子目录不是面板写的，哪怕它的名字像面板的临时文件：目录留着，子目录也留着。
# A subdirectory of /etc/kixdns is not something the panel wrote, even named like a panel temporary file: the directory
# stays, and so does the subdirectory.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
assert_not_contains "$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)" "RUN-FAILED" "先移除面板的 KixDNS 不应失败"
mkdir -p "${host}/etc-kixdns/.kixdns-panel-Zz99Yy"
printf 'mine\n' > "${host}/etc-kixdns/.kixdns-panel-Zz99Yy/notes"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
[[ -f ${host}/etc-kixdns/.kixdns-panel-Zz99Yy/notes ]] || { printf '断言失败：/etc/kixdns 里的子目录不是面板写的，不能删\n' >&2; exit 1; }
# 回归（M2）：移除面板的 KixDNS、保留数据以后，用户照 KixDNS 的文档自己装了 KixDNS：/etc/systemd/system/kixdns.service，以 root
# 运行，ExecStart 用 -c 指向 /etc/kixdns/pipeline.json（正是面板留下的那份）。以前删除面板数据时把它当成面板写的配置删掉，
# 用户的 KixDNS 下次启动就失败。属主看不出是谁的，只能看 unit：任何 unit 的 ExecStart 用 -c、--config、--config= 指着的配置都不删，
# 归面板的改归 root（组和权限按那个 unit 运行用的账号），并说明。
# Regression (M2): after the panel's KixDNS was removed and the data kept, the user installed KixDNS by its docs:
# /etc/systemd/system/kixdns.service, running as root, ExecStart pointing with -c at /etc/kixdns/pipeline.json (the very
# one the panel left). Removing the panel data used to delete it as the panel's config, and the user's KixDNS failed on its
# next start. Ownership cannot tell whose it is, only units can: a config any unit's ExecStart names with -c, --config or
# --config= is never removed; when it is the panel's it goes to root (group and mode by the account that unit runs as),
# and that is said.
for own_option in '-c ' '--config '; do
  fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
  chmod 0750 "${host}/etc-kixdns"
  assert_not_contains "$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)" "RUN-FAILED" \
    "先移除面板的 KixDNS 不应失败（${own_option}）"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run %s%s\n' "${own_option}" "${host}/etc-kixdns/pipeline.json" \
    > "${host}/units/kixdns.service"
  chmod 0640 "${host}/etc-kixdns/pipeline.json"
  : > "${chown_log}"
  output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true \
    uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
  assert_not_contains "${output}" "RUN-FAILED" "用户自己的 KixDNS 用着面板留下的配置时删除数据不应失败（${own_option}）"
  [[ -f ${host}/etc-kixdns/pipeline.json ]] ||
    { printf '断言失败：有 unit 用着的配置不能删（%s）\n' "${own_option}" >&2; exit 1; }
  assert_equals "$(kept_owner_of root:root "${host}/etc-kixdns/pipeline.json")" "root:root 600" \
    "unit 以 root 运行时，它用着的配置改归 root、只给 root（${own_option}）"
  assert_equals "$(kept_owner_of root:root "${host}/etc-kixdns")" "root:root 755" "配置所在的目录交还 root（${own_option}）"
  assert_contains "${output}" "kixdns.service 还在用 ${host}/etc-kixdns/pipeline.json，这份配置留着，交还 root：" \
    "留下有 unit 用着的配置时应说明（${own_option}）"
  assert_contains "${output}" "  ${host}/etc-kixdns/pipeline.json：" "应列出改了的配置（${own_option}）"
done
# 别的名字的 unit、放在别处、用 --config= 写法，以别的账号运行：一样留着，组按那个账号。
# A unit of another name, living elsewhere, using the --config= form and running as another account: kept just the same,
# with that account's group.
rm -rf -- "${other_units}"
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
assert_not_contains "$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)" "RUN-FAILED" "先移除面板的 KixDNS 不应失败"
mkdir -p "${other_units}"
printf '[Service]\nUser=kxu\nExecStart=/opt/dns/kixdns run --config=%s --admin-socket /run/dns/admin.sock\n' \
  "${host}/etc-kixdns/pipeline.json" > "${other_units}/dns-own.service"
: > "${chown_log}"
output="$(OTHER_UNIT_DIRECTORY=${other_units} PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true \
  uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
[[ -f ${host}/etc-kixdns/pipeline.json ]] || { printf '断言失败：别的 unit 用着的配置也不能删\n' >&2; exit 1; }
assert_equals "$(kept_owner_of root:990 "${host}/etc-kixdns/pipeline.json")" "root:990 640" "组和权限按用着它的 unit 运行用的账号"
assert_contains "${output}" "dns-own.service 还在用 ${host}/etc-kixdns/pipeline.json" "应说明是哪个 unit 用着"
rm -rf -- "${other_units}"
# 第一次卸载是旧版卸载器做的、没记下归属：panel.env 还说归面板管。按 systemd 实际加载的 unit 认，用户放在别处的同名 unit 跑的
# 是别的程序，就不是面板的，不碰。
# The first uninstall was done by an older uninstaller that recorded nothing: panel.env still says the panel's. Going by the
# unit systemd really loads, the user's unit of the same name elsewhere runs another program, so it is not the panel's and is
# left alone.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
rm -f -- "${host}/units/kixdns.service" "${host}/state/bin/kixdns"
own_kixdns
: > "${systemctl_log}"
output="$(OTHER_UNIT_DIRECTORY=${other_units} SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "旧版卸载器之后再卸载不应失败"
assert_contains "${output}" "这台机器的 KixDNS 不归面板管理" "systemd 加载的同名 unit 跑别的程序时应说明不归面板管"
assert_not_contains "$(cat "${systemctl_log}")" "kixdns.service" "旧版卸载器之后再卸载也不能停用户自己的 KixDNS"
[[ -f ${other_units}/kixdns.service && -f ${host}/etc-kixdns/own.json ]] ||
  { printf '断言失败：旧版卸载器之后再卸载也不能删用户的 unit 和配置\n' >&2; exit 1; }
# ---------------------------------------------------------------------------
# 第三轮审查：root 照着做事的规则（R1–R4，写在 uninstall.sh 开头），每一处都照做
# Third review: the rules for what root acts on (R1–R4, at the top of uninstall.sh), and every site follows them
# ---------------------------------------------------------------------------

# 回归（M-A，R1）：面板在状态目录里种一份备份，第一次卸载拒绝了它，却把它「关」在只有 root 能进的目录里、名字不变；第二次卸载就照
# 它装上、启动了面板写的 unit。现在拒绝的记录挪出会被信的名字，以后不再用；再卸载一次就当作没有备份。
# Regression (M-A, R1): the panel planted a backup in its state directory; the first uninstall refused it but "locked" it
# in the root-only directory under the same name, and the second one installed and started the unit the panel wrote. Now
# a refused record leaves every trusted name and is never used again; uninstalling again treats the host as having none.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
plant_backup
: > "${systemctl_log}"
output="$(FORGED_RECORDS=true SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "${host}/state/external-backup 不能信（它不是 root 建的），没有用它（挪到了" "第一次卸载应不用面板写的备份"
assert_not_contains "${output}" "RUN-FAILED" "面板写的备份不能让卸载停下"
[[ ! -e ${host}/records/external-backup && ! -e ${host}/state/external-backup ]] ||
  { printf '断言失败：拒绝的备份不能还留在会被信的名字上\n' >&2; exit 1; }
output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "再卸载一次应当作没有备份接着卸载"
[[ ! -e ${host}/units/pwn.service ]] || { printf '断言失败：第二次卸载也不能照面板写的备份装 unit\n' >&2; exit 1; }
assert_not_contains "$(cat "${systemctl_log}")" "pwn.service" "第二次卸载也不能启动面板写的 unit"

# R2：卸载器先停面板和它账号的所有进程（以面板账号的身份 kill -1），之后才动面板的目录，也才挪旧位置的记录。
# R2: the uninstaller stops the panel and every process of its account first (kill -1 as the panel account), and only then
# touches the panel's directories or moves records from the old place.
run_body="$(declare -f run_uninstall)"
components_body="$(declare -f remove_panel_components)"
assert_contains "${components_body}" "stop_panel_processes" "停掉面板的服务以后应停光面板账号的进程"
stop_unit_line="$(grep -n 'stop_unit kixdns-panel-helper.service' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
quiesce_line="$(grep -n 'stop_panel_processes' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
first_rm_line="$(grep -n 'rm -' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${quiesce_line} && ${stop_unit_line} -lt ${quiesce_line} && ${quiesce_line} -lt ${first_rm_line} ]] || {
  printf '断言失败：停掉面板以后、删东西之前要停光面板账号的进程（stop=%s quiesce=%s rm=%s）\n' \
    "${stop_unit_line}" "${quiesce_line}" "${first_rm_line}" >&2
  exit 1
}
quiesce_body="$(declare -f stop_panel_processes)"
assert_contains "${quiesce_body}" "quiesce_panel_account" "卸载器应以面板账号的身份停它的进程"
records_quiesce="$(declare -f quiesce_for_records)"
assert_contains "${records_quiesce}" "stop_panel_processes" "挪旧位置的记录之前应停光面板账号的进程"

# 回归（S-G）：删除面板数据时，交还的路径以前写成「UNKNOWN:kixdns」：先删了面板账号，才读改之前的样子。现在先交还、后删账号。
# Regression (S-G): removing the panel data used to show the paths handed back as "UNKNOWN:kixdns": the panel account was
# deleted before the before-values were read. Now the hand-back comes first and the account goes after.
state_body="$(declare -f remove_panel_state)"
config_line="$(grep -n 'remove_panel_kixdns_config' <<< "${state_body}" | head -n 1 | cut -d: -f1 || true)"
account_line="$(grep -n 'remove_account kixdns-panel' <<< "${state_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${config_line} && -n ${account_line} && ${config_line} -lt ${account_line} ]] || {
  printf '断言失败：要先交还 /etc/kixdns 再删面板账号（config=%s account=%s）\n' "${config_line}" "${account_line}" >&2
  exit 1
}

# 回归（#4）：unit 的配置参数看不出指着哪里（写成变量、相对路径）时，/etc/kixdns 整个留着，归面板的改归 root，并说明。
# Regression (#4): when a unit's config argument cannot be told (a variable, a relative path), /etc/kixdns stays whole,
# what the panel owns goes to root, and this is said.
# shellcheck disable=SC2016 # 就是要 unit 里写着没展开的变量 / The unit is meant to hold the unexpanded variable
for unclear_option in '-c ${KIXDNS_CONFIG}' '--config=pipeline.json' ''; do
  fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
  assert_not_contains "$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)" "RUN-FAILED" "先移除面板的 KixDNS 不应失败"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run %s\n' "${unclear_option}" > "${host}/units/kixdns.service"
  # 和安装器装的一样是 0640 / 0640, as the installer leaves it
  chmod 0640 "${host}/etc-kixdns/pipeline.json"
  : > "${chown_log}"
  output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true \
    uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
  [[ -f ${host}/etc-kixdns/pipeline.json ]] ||
    { printf '断言失败：看不出 unit 用哪份配置时 /etc/kixdns 要整个留着（%s）\n' "${unclear_option}" >&2; exit 1; }
  assert_contains "${output}" "看不出它用的是哪份配置，${host}/etc-kixdns 整个留着" "看不出时应说明（${unclear_option}）"
  # S3（第四轮）：只把属主改成 root，组和权限不变（以前改成 root:root 0644，0640 的配置谁都能读了）
  # S3 (fourth review): only the owner becomes root, group and mode stay (it used to become root:root 0644, so a 0640
  # config turned readable by all)
  assert_contains "$(cat "${chown_log}")" "chown -h root -- ${host}/etc-kixdns/pipeline.json" "留着的配置应改归 root（${unclear_option}）"
  assert_equals "$(stat -c '%a' "${host}/etc-kixdns/pipeline.json")" "640" "留着的配置不能放宽权限（${unclear_option}）"
done

# 回归（#5）：保留 KixDNS、删除面板数据时，以前凡是配置里写着的状态目录里的路径都留下（比如 panel.db），还交给 kixdns 组读。现在
# 只留它真要读的 Geo 数据（状态目录的 geo 里的），面板的数据一律删掉。
# Regression (#5): keeping KixDNS and removing the panel data used to keep any state-directory path the config named (such
# as panel.db) and hand it to the kixdns group. Now only the Geo data it really reads (in the state directory's geo) stays;
# the panel's data always goes.
kept_host "${host}"
printf '{"settings":{"geosite_data_paths":["%s"],"other":"%s"}}\n' "${host}/state/geo/site-abc.dat" "${host}/state/panel.db" \
  > "${host}/etc-kixdns/pipeline.json"
output="$(PANEL_OWNED=true ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
[[ ! -e ${host}/state/panel.db ]] || { printf '断言失败：配置里写着 panel.db 也不能把面板的数据库留下\n' >&2; exit 1; }
[[ -f ${host}/state/geo/site-abc.dat ]] || { printf '断言失败：保留的 KixDNS 要读的 GeoSite 应留下\n' >&2; exit 1; }

# R3：保留 KixDNS、删除面板数据时，配置所在的目录交给 root 之前也要查过不是符号链接。旧版的 /etc/kixdns-panel 归面板，面板能把
# 迁移副本的目录换成指向别处的符号链接，chmod 就跟着改到别处去了。
# R3: keeping KixDNS and removing the panel data, the config's directory is checked not to be a symlink before it goes to
# root too. An older version's /etc/kixdns-panel is the panel's, which can swap the migration copy's directory for a
# symlink to elsewhere, and chmod would follow it there.
kept_host "${host}"
mkdir -p "${host}/elsewhere"
mv -- "${host}/etc-kixdns/pipeline.json" "${host}/elsewhere/pipeline.json"
rm -rf -- "${host}/etc-kixdns"
ln -s "${host}/elsewhere" "${host}/etc-kixdns"
chmod 0700 "${host}/elsewhere"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true \
  uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_equals "$(stat -c '%a' "${host}/elsewhere")" "700" "配置所在的目录是符号链接时不能跟着它改权限"
rm -f -- "${host}/etc-kixdns"

# R3：交给 root 时 chmod 只用在查过不是符号链接的目录和普通文件上。find 列出以后那个目录被换成指向别处的符号链接（这里让 find
# 直接列出一个符号链接来模拟），chmod 不能跟着改到别处去。
# R3: handing to root, chmod only touches a directory or plain file checked not to be a symlink. A directory swapped for a
# symlink to elsewhere after find listed it (simulated here by find listing a symlink) must not lead chmod elsewhere.
output="$(
  base="${scratch}/kept-swap"
  rm -rf -- "${base}"
  mkdir -p "${base}/state/bin" "${base}/elsewhere"
  chmod 0700 "${base}/elsewhere"
  PANEL_STATE_DIRECTORY="${base}/state"
  kept_unit_files() { :; }
  original_config_access() { printf 'kixdns 0640\n'; }
  kept_kixdns_config() { :; }
  chown() { :; }
  find() {
    if [[ " $* " == *" ! -type l -print0 "* ]]; then
      ln -s "${base}/elsewhere" "${base}/state/swapped"
      printf '%s\0' "${base}/state" "${base}/state/swapped"
      return 0
    fi
    command find "$@"
  }
  hand_kept_kixdns_to_root > /dev/null 2>&1 || true
  printf 'ELSEWHERE=%s\n' "$(stat -c '%a' "${base}/elsewhere")"
)"
assert_contains "${output}" "ELSEWHERE=700" "交给 root 时不能跟着换成符号链接的目录改权限"

# 回归（S-D，R4）：panel.env 所在的目录面板能写时，它记的归属、待删的账号都不能信：照 KixDNS 的 unit 认，认不出的就保留，不删。
# Regression (S-D, R4): when panel.env's directory is writable by the panel, what it records about ownership and accounts
# left to remove cannot be trusted: the KixDNS unit decides, and what cannot be told is kept, not removed.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
assert_not_contains "$(uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)" "RUN-FAILED" "先移除面板的 KixDNS 不应失败"
chmod 0777 "${host}/panel-etc"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_contains "${output}" "${host}/panel-etc/panel.env 面板能改，它记的不能信" "panel.env 不能信时应说明"
assert_equals "$(account_calls)" "userdel kixdns-panel;" "不能信的 panel.env 里记的待删账号不能删"
[[ -f ${host}/etc-kixdns/pipeline.json ]] || { printf '断言失败：不能信的 panel.env 不能让卸载器删 /etc/kixdns\n' >&2; exit 1; }
# R4：panel.env 不能信、它记的配置又和 unit 对得上时，只照它认 KixDNS 的配置和 unit；归属照 unit 定（unit 跑的是面板的程序、用的是
# 这份配置，就是面板的），它写的「KixDNS 不归面板管」不认。
# R4: when panel.env cannot be trusted but the config it records matches the unit, only the KixDNS config and unit are
# taken from it; ownership follows the unit (running the panel's program on this config, it is the panel's), and its word
# that the KixDNS is not the panel's is not taken.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
printf 'KIXDNS_MANAGEMENT_ENABLED=false\n' >> "${host}/panel-etc/panel.env"
chmod 0777 "${host}/panel-etc"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "panel.env 不能信、配置和 unit 对得上时卸载不应失败"
[[ ! -e ${host}/units/kixdns.service ]] ||
  { printf '断言失败：不能信的 panel.env 说 KixDNS 不归面板管也不认，照 unit 认出的面板的 KixDNS 要移除\n' >&2; exit 1; }
chmod 0755 "${host}/panel-etc" 2>/dev/null || true

# 状态目录单独挂载时删不掉挂载点：里面清空了就留着、说一声，不算卸载失败（S-F 的主机卸载时就是这样）。
# A state directory mounted on its own cannot lose its mount point: once emptied it stays, this is said, and the uninstall
# does not fail (as on the S-F host).
output="$(
  mounted="${scratch}/mounted-state"
  mkdir -p "${mounted}/geo"
  : > "${mounted}/panel.db"
  rm() {
    if [[ ${*: -1} == "${mounted}" ]]; then
      command rm -rf -- "${mounted:?}"/*
      return 1
    fi
    command rm "$@"
  }
  mountpoint() { [[ ${*: -1} == "${mounted}" ]]; }
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  remove_state_directory "${mounted}"
  printf 'LEFT=%s\n' "$(find "${mounted}" -mindepth 1 | wc -l)"
)" || true
assert_contains "${output}" "是单独挂载的文件系统：里面已经清空，挂载点留着。" "单独挂载的状态目录清空后应说明"
assert_contains "${output}" "LEFT=0" "单独挂载的状态目录里应清空"
assert_not_contains "${output}" "FAILED" "单独挂载的状态目录不算卸载失败"

# R1：卸载器每读一次记录都先验它：迁移前的备份（backup_value、external_backup_present）和 resolved 的记录（restore_resolved_stub）。
# 只有 root 能进的目录里那份坏了（这里是别人能写），就挪走它、停下，不照它做事。
# R1: the uninstaller checks a record at every read: the pre-migration backup (backup_value, external_backup_present) and
# the resolved record (restore_resolved_stub). When the copy in the root-only directory is bad (here: writable by others),
# it is moved away and the run stops, never acting on it.
# NIT 4：经 backup_value 读备份的几处（load、inplace、kept）都先跑 trusted_record，不能信的在那里挪走、停下 / NIT 4: each
# place reading the backup through backup_value (load, inplace, kept) runs trusted_record first, which moves an untrusted
# one away and stops there
for reader in value present resolved load inplace kept; do
  output="$(
    base="${scratch}/record-reader"
    rm -rf -- "${base}"
    mkdir -p "${base}/records/external-backup" "${base}/records/resolved-stub" "${base}/etc"
    chmod 0700 "${base}/records"
    chmod 0770 "${base}/records/external-backup" "${base}/records/resolved-stub"
    printf 'KIXDNS_SERVICE_UNIT=pwn.service\n' > "${base}/records/external-backup/install.env"
    printf 'RESOLV_CONF_KIND=file\n' > "${base}/records/resolved-stub/install.env"
    printf 'nameserver 192.0.2.1\n' > "${base}/records/resolved-stub/resolv.conf"
    ROOT_CHAIN_TOP=${base}
    ROOT_RECORDS="${base}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    RESOLVED_DROPIN="${base}/etc/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${base}/etc/resolv.conf"
    KIXDNS_ACTION=remove
    ROOT_UID="$(id -u)"
    install() { mkdir -p "${@: -1}"; chmod 0700 "${@: -1}"; }
    systemctl() { :; }
    fail() { printf 'FAILED %s\n' "$*"; exit 1; }
    case ${reader} in
      value)
        # backup_value 在命令替换里读：它只验、不给值；挪走和停下由调用它的地方先跑的 trusted_record 做（NIT 4）
        # backup_value is read inside command substitutions: it only checks and gives no value; moving away and stopping
        # come from the trusted_record its caller runs first (NIT 4)
        record=${EXTERNAL_BACKUP}
        printf 'VALUE=%s\n' "$(backup_value KIXDNS_SERVICE_UNIT)"
        trusted_record external-backup
        ;;
      present)
        record=${EXTERNAL_BACKUP}
        external_backup_present && printf 'PRESENT\n'
        ;;
      resolved)
        record=${RESOLVED_STATE}
        restore_resolved_stub
        ;;
      load)
        record=${EXTERNAL_BACKUP}
        HAS_EXTERNAL_BACKUP=true
        load_external_backup
        ;;
      inplace)
        record=${EXTERNAL_BACKUP}
        ORIGINAL_CONFIG="${base}/etc/kixdns.json"
        MANAGED_CONFIG=${ORIGINAL_CONFIG}
        hand_back_original_config() { printf 'HANDED-BACK\n'; }
        hand_back_in_place_config
        ;;
      kept)
        record=${EXTERNAL_BACKUP}
        KIXDNS_MANAGED=true
        KIXDNS_ACTION=keep
        CONFIG_ACTION=keep
        HAS_EXTERNAL_BACKUP=true
        hand_back_kept_in_place_directory
        ;;
    esac
    [[ ! -e ${record} ]] || printf 'STILL-TRUSTED-NAME\n'
  )" || true
  assert_contains "${output}" "不能信（别人能往里写）" "读记录（${reader}）之前应先验它"
  assert_not_contains "${output}" "VALUE=pwn.service" "验不过的记录不能给出它记的值（${reader}）"
  assert_not_contains "${output}" "PRESENT" "验不过的备份不能算数（${reader}）"
  assert_not_contains "${output}" "已恢复原样" "验不过的 resolved 记录不能照着恢复（${reader}）"
  assert_not_contains "${output}" "STILL-TRUSTED-NAME" "验不过的记录不能还留在会被信的名字上（${reader}）"
  assert_not_contains "${output}" "HANDED-BACK" "验不过的备份不能照着交还（${reader}）"
done
# NIT 4：backup_value 只验：放记录的目录不是 0700（别的都对）时也不给值 / NIT 4: backup_value only checks: with the records
# directory not 0700 (all else fine) it gives no value either
output="$(
  umask 022
  base="${scratch}/record-chain"
  rm -rf -- "${base}"
  mkdir -p "${base}/records/external-backup"
  chmod 0755 "${base}/records"
  chmod 0700 "${base}/records/external-backup"
  printf 'KIXDNS_SERVICE_UNIT=pwn.service\n' > "${base}/records/external-backup/install.env"
  ROOT_CHAIN_TOP=${base}
  ROOT_RECORDS="${base}/records"
  EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
  ROOT_UID="$(id -u)"
  printf 'VALUE=%s\n' "$(backup_value KIXDNS_SERVICE_UNIT || true)"
  chmod 0700 "${base}/records"
  printf 'VALUE=%s\n' "$(backup_value KIXDNS_SERVICE_UNIT || true)"
)"
assert_equals "${output}" $'VALUE=\nVALUE=pwn.service' "放记录的目录不是只有 root 能进时 backup_value 不能给值"

# 回归（S3）：只有程序是 KixDNS 的 unit，它看不出指着哪里的配置参数才算数。sh 的 -c、mosdns 的相对路径配置不能让 /etc/kixdns 整个
# 留着（以前留着，面板的文件还交给了 root:root 0644）；绝对路径不管是哪个程序写的都照旧算，留着它不会删错。
# Regression (S3): only a unit whose program is KixDNS has a config argument that cannot be told count. sh's -c, mosdns's
# relative config must not keep /etc/kixdns whole (they did, and handed the panel's files to root:root 0644); an absolute
# path counts as before whatever the program, since keeping it cannot remove the wrong thing.
named_output="$(
  SYSTEMD_UNIT_DIRECTORY="${scratch}/named-units"
  rm -rf -- "${SYSTEMD_UNIT_DIRECTORY}"
  mkdir -p "${SYSTEMD_UNIT_DIRECTORY}"
  printf '[Service]\nExecStart=/bin/sh -c "exec sleep infinity"\n' > "${SYSTEMD_UNIT_DIRECTORY}/keepalive.service"
  printf '[Service]\nExecStart=/usr/local/bin/mosdns start -c config.yaml -d /etc/mosdns\n' > "${SYSTEMD_UNIT_DIRECTORY}/mosdns.service"
  printf '[Service]\nExecStart=/usr/local/bin/other -c /etc/kixdns/pipeline.json\n' > "${SYSTEMD_UNIT_DIRECTORY}/other.service"
  printf '[Service]\nExecStart=/opt/kixdns run -c relative.json\n' > "${SYSTEMD_UNIT_DIRECTORY}/kx.service"
  printf '[Service]\nExecStart=/opt/bin/kixdns run\n' > "${SYSTEMD_UNIT_DIRECTORY}/bare.service"
  printf '[Service]\nExecStart=/usr/bin/sleep infinity\n' > "${SYSTEMD_UNIT_DIRECTORY}/sleeper.service"
  configs_named_by_units | sort
)"
assert_not_contains "${named_output}" "keepalive.service" "sh 的 -c 不能算 KixDNS 的配置参数"
assert_not_contains "${named_output}" "mosdns.service" "别的程序的相对路径配置不能算"
assert_contains "${named_output}" "other.service"$'\t'"/etc/kixdns/pipeline.json" "任何程序写着的绝对路径都照旧算"
assert_contains "${named_output}" "kx.service"$'\t'"?relative.json" "KixDNS 的相对路径配置看不出指着哪里"
assert_contains "${named_output}" "bare.service"$'\t'"?" "没写配置参数的 KixDNS 看不出用哪份配置"
assert_not_contains "${named_output}" "sleeper.service" "没写配置参数的别的程序不能算"
# S3：有 unit 用着、交给 root 的配置也不放宽权限：算出来的和它现在的取交集
# S3: a config a unit uses and that goes to root is not widened either: the computed mode intersected with the current one
narrowed_file="${scratch}/narrowed"
: > "${narrowed_file}"
chmod 0600 "${narrowed_file}"
assert_equals "$(narrowed_mode "${narrowed_file}" 0640)" "0600" "交还时算出来的权限不能比现在的宽"
chmod 0644 "${narrowed_file}"
assert_equals "$(narrowed_mode "${narrowed_file}" 0640)" "0640" "交还时可以收紧到算出来的权限"
# 有 unit 用着的配置交给 root 时照这样取交集：0600 的不会变成 0640 / A config a unit uses goes to root with that intersection:
# a 0600 one does not become 0640
named_config="${scratch}/named/pipeline.json"
mkdir -p "${scratch}/named"
: > "${named_config}"
chmod 0600 "${named_config}"
(
  kept_unit_files() { :; }
  original_config_access() { printf 'kixdns 0640\n'; }
  panel_owned() { [[ -e $1 ]]; }
  chown() { :; }
  hand_back_directory() { :; }
  hand_named_config_to_root user.service "${named_config}" > /dev/null
)
assert_equals "$(stat -c '%a' "${named_config}")" "600" "有 unit 用着的配置交给 root 时不能放宽权限"

# 回归（M1，结构 2）：保留 KixDNS、删除面板数据时，配置里写着一个带空格的「Geo 路径」（只要以 geo/ 开头），以前拿 " ${keep[*]} " 做
# 子串比较，空格隔开的别的路径也就算「留下」：面板在旧位置放的一份备份（停下时才放，躲过开头的检查）交给了 root，下一次安装当它是
# 真的接手。现在交给 root 之前先删掉 root 会读的记录名字；留下的只认精确的、在 geo/ 下、没有空白和 . .. 的普通文件。
# Regression (M1, structural change 2): keeping KixDNS and removing the panel data, a "Geo path" with spaces in the config
# (it only had to start with geo/) made, through the substring test on " ${keep[*]} ", any path appearing in it count as
# kept: a backup the panel put in the old place (while stopping, after the start-of-run check) went to root, and the next
# install adopted it as genuine. Now the record names root reads go before anything is handed to root, and only exact,
# plain files under geo/ with no whitespace and no . or .. segment stay.
kept_host "${host}"
mkdir -p "${host}/state/external-backup" "${host}/state/geo/a ${host}/state"
printf 'KIXDNS_SERVICE_UNIT=pwn.service\n' > "${host}/state/external-backup/install.env"
printf '[Service]\nExecStart=/bin/sh -c "id > /root/pwned"\n' > "${host}/state/external-backup/kixdns.service"
crafted="${host}/state/geo/a ${host}/state/external-backup/install.env ${host}/state/external-backup/kixdns.service z"
mkdir -p "$(dirname -- "${crafted}")"
printf 'x\n' > "${crafted}"
printf '{"settings":{"geosite_data_paths":["%s"],"note":"%s"}}\n' "${host}/state/geo/site-abc.dat" "${crafted}" \
  > "${host}/etc-kixdns/pipeline.json"
# 面板在开头的检查以后才放：这里跳过开头的接手 / The panel plants it after the start-of-run check: the start is skipped here
: > "${chown_log}"
output="$(
  secure_root_records() { :; }
  PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes
)"
[[ ! -e ${host}/state/external-backup ]] || { printf '断言失败：交给 root 之前应删掉旧位置的记录名字\n' >&2; exit 1; }
# 记录名字下面不是普通文件的东西（这里是命名管道）删文件时删不掉，目录也就不空：要按名字整个删掉，不能交给 root
# What is under a record name and is no regular file (a named pipe here) survives the file sweep, so the directory is not
# empty either: it must go by name, whole, and never to root
kept_host "${host}"
mkdir -p "${host}/state/resolved-stub"
mkfifo "${host}/state/resolved-stub/pipe"
: > "${chown_log}"
output="$(
  secure_root_records() { :; }
  PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes
)"
[[ ! -e ${host}/state/resolved-stub ]] || { printf '断言失败：记录名字下面别的东西也应随名字删掉\n' >&2; exit 1; }
assert_not_contains "$(cat "${chown_log}")" "resolved-stub" "记录名字不能交给 root"
assert_not_contains "$(cat "${chown_log}")" "external-backup" "旧位置的记录名字不能交给 root"
[[ ! -e ${crafted} ]] || { printf '断言失败：带空格的 Geo 路径不能留下\n' >&2; exit 1; }
assert_equals "$(cat "${host}/state/geo/site-abc.dat" 2>/dev/null || printf missing)" "geosite" "配置里写着的真的 GeoSite 应留下"
# 每一条规则单独看：这些文件都真的在，只有最后一个能留下 / Each rule on its own: all these files really exist, and only the
# last one stays
odd_state="${scratch}/odd-state"
rm -rf -- "${odd_state}"
mkdir -p "${odd_state}/geo"
: > "${odd_state}/panel.db"
: > "${odd_state}/geo/x.dat"
: > "${odd_state}/geo/tab"$'\t'"x.dat"
: > "${odd_state}/geo/sp ace.dat"
ln "${odd_state}/geo/x.dat" "${odd_state}/geo/linked.dat"
: > "${odd_state}/geo/plain.dat"
for odd_geo in "geo/../panel.db" "geo/./x.dat" "geo/tab"$'\t'"x.dat" "geo/sp ace.dat" "geo/linked.dat" "geo" "geo/"; do
  ! (PANEL_STATE_DIRECTORY=${odd_state} kept_geo_path "${odd_state}/${odd_geo}") ||
    { printf '断言失败：%s 不能算要留下的 Geo 文件\n' "${odd_geo}" >&2; exit 1; }
done
(PANEL_STATE_DIRECTORY=${odd_state} kept_geo_path "${odd_state}/geo/plain.dat") ||
  { printf '断言失败：geo 下的普通文件应留下\n' >&2; exit 1; }

# 回归（S4）：保留 KixDNS、删除面板数据，保留的 KixDNS 用的是 /etc/kixdns-panel 里的配置（v4.3.4 的 --kixdns-config，或者 R4 照
# unit 认出来的）：以前整个删掉 /etc/kixdns-panel，KixDNS 下次启动就失败。现在留下那份配置，交给 root、组照 unit，不放宽；别的都删。
# Regression (S4): keeping KixDNS and removing the panel data while the kept KixDNS uses a config in /etc/kixdns-panel
# (v4.3.4's --kixdns-config, or what R4 took from the unit): /etc/kixdns-panel used to go whole, so KixDNS failed at its next
# start. Now that config stays, goes to root with the unit's group, is not widened, and everything else goes.
kept_host "${host}"
mv -- "${host}/etc-kixdns/pipeline.json" "${host}/panel-etc/pipeline.json"
printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=%s\n' "${host}/panel-etc/pipeline.json" > "${host}/panel-etc/panel.env"
sed -i "s|${host}/etc-kixdns/pipeline.json|${host}/panel-etc/pipeline.json|" "${host}/units/kixdns.service"
: > "${host}/panel-etc/other-panel-file"
chmod 0640 "${host}/panel-etc/pipeline.json"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "保留的 KixDNS 的配置在面板配置目录里时卸载不应失败"
[[ -f ${host}/panel-etc/pipeline.json ]] || { printf '断言失败：保留的 KixDNS 用着的面板配置目录里的配置要留着\n' >&2; exit 1; }
[[ ! -e ${host}/panel-etc/panel.env && ! -e ${host}/panel-etc/other-panel-file ]] ||
  { printf '断言失败：面板配置目录里别的都应删掉\n' >&2; exit 1; }
assert_contains "$(cat "${chown_log}")" "chown -h root:kixdns -- ${host}/panel-etc/pipeline.json" "留着的配置应交给 root、组照 unit"
assert_equals "$(stat -c '%a' "${host}/panel-etc/pipeline.json")" "640" "留着的配置不能放宽权限"
# 保留的 KixDNS 的配置 0600 时也不放宽成 0640；列 unit 的时候漏了它（configs_named_by_units 看不到），也照它的 unit 认出来留着
# The kept KixDNS's config at 0600 is not widened to 0640 either; and with the unit listing missing it
# (configs_named_by_units sees nothing), its unit still keeps it
kept_host "${host}"
mv -- "${host}/etc-kixdns/pipeline.json" "${host}/panel-etc/pipeline.json"
printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=%s\n' "${host}/panel-etc/pipeline.json" > "${host}/panel-etc/panel.env"
sed -i "s|${host}/etc-kixdns/pipeline.json|${host}/panel-etc/pipeline.json|" "${host}/units/kixdns.service"
chmod 0600 "${host}/panel-etc/pipeline.json"
output="$(
  configs_named_by_units() { :; }
  PANEL_OWNED=true ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --keep-kixdns --remove-config --yes
)"
[[ -f ${host}/panel-etc/pipeline.json ]] || { printf '断言失败：保留的 KixDNS 的配置照它的 unit 认出来也要留着\n' >&2; exit 1; }
assert_equals "$(stat -c '%a' "${host}/panel-etc/pipeline.json")" "600" "保留的 KixDNS 的配置不能放宽权限"
# 不是保留的 KixDNS、别的 unit 用着面板配置目录里的配置（R4 下认不出归属时也一样）：留着，交给 root，别的删掉
# A unit other than the kept KixDNS uses a config in the panel config directory (as when R4 cannot tell ownership): it
# stays, goes to root, and the rest goes
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
printf '{}\n' > "${host}/panel-etc/user.json"
chmod 0640 "${host}/panel-etc/user.json"
printf '[Service]\nUser=kixdns\nGroup=kixdns\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${host}/panel-etc/user.json" \
  > "${host}/units/user-kixdns.service"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "别的 unit 用着面板配置目录里的配置时卸载不应失败"
[[ -f ${host}/panel-etc/user.json && ! -e ${host}/panel-etc/panel.env ]] ||
  { printf '断言失败：别的 unit 用着的配置留着、面板配置目录里别的删掉\n' >&2; exit 1; }
assert_contains "$(cat "${chown_log}")" "chown -h root:kixdns -- ${host}/panel-etc/user.json" "别的 unit 用着的配置应交给 root"
assert_contains "${output}" "user-kixdns.service 还在用 ${host}/panel-etc/user.json，这份配置留着" "别的 unit 用着的配置留着时应说明"

# 回归（结构 1）：「接手过」的标记卸载以后也留着：放记录的目录不删；quarantine 里有东西时说一声。
# Regression (structural change 1): the "adopted" marker outlives an uninstall: the records directory is not removed;
# something left in quarantine is said.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "全新安装的主机卸载不应失败"
[[ -f ${host}/records/.adopted ]] || { printf '断言失败：卸载以后「接手过」的标记应留着\n' >&2; exit 1; }
# 有了标记，旧位置再有的不验、不用 / With the marker, anything in the old place later is neither checked nor used
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
mkdir -p "${host}/records"
chmod 0700 "${host}/records"
printf 'adopted\n' > "${host}/records/.adopted"
mkdir -p "${host}/state/external-backup"
chmod 0700 "${host}/state/external-backup"
printf '%s\n' KIXDNS_SERVICE_UNIT=pwn.service KIXDNS_CONFIG=/nonexistent KIXDNS_BINARY=/bin/true KIXDNS_WAS_ACTIVE=true \
  KIXDNS_WAS_ENABLED=false > "${host}/state/external-backup/install.env"
printf '[Service]\nExecStart=/bin/sh -c "id > /root/pwned"\n' > "${host}/state/external-backup/kixdns.service"
: > "${systemctl_log}"
output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns --keep-config --yes)"
assert_contains "${output}" "${host}/state/external-backup 不用（挪到了" "接手过以后旧位置的记录应挪走"
assert_not_contains "${output}" "已验过" "接手过以后旧位置的记录不能再接手，哪怕整份都归 root"
[[ ! -e ${host}/units/pwn.service && ! -e ${host}/records/external-backup ]] ||
  { printf '断言失败：接手过以后旧位置的记录不能用\n' >&2; exit 1; }
assert_not_contains "$(cat "${systemctl_log}")" "pwn.service" "接手过以后旧位置的记录不能用来启动 unit"

# S1：照记录停下时（KEEP_PANEL_STOPPED）卸载器也不重启面板和 helper / S1: after a stop over a record (KEEP_PANEL_STOPPED)
# the uninstaller restarts neither the panel nor the helper either
kept_stopped="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; [[ $1 == is-active ]]; }
    stop_panel_processes() { :; }
    quiesce_for_records
    refuse_with_panel_held "记录不对"
  ) 2>&1
)" || true
assert_contains "${kept_stopped}" "面板和它账号的进程这时都停着" "照记录停下时卸载器应说明面板停着"
assert_equals "$(grep -c '^systemctl start' <<< "${kept_stopped}" || true)" "0" "照记录停下时卸载器不能重启面板和 helper"
restarted="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; [[ $1 == is-active ]]; }
    stop_panel_processes() { :; }
    quiesce_for_records
  ) 2>&1
)" || true
assert_contains "${restarted}" "systemctl start kixdns-panel.service" "没真的开始卸载就退出时应照原样重启面板"

# 结构 3：卸载器一开头拿锁；先停在线更新和 helper，再停面板 / Structural change 3: the uninstaller takes the lock first thing;
# the online update and the helper stop before the panel
main_body="$(declare -f main)"
lock_line="$(grep -n 'take_root_lock' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
run_line="$(grep -n 'run_uninstall' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${lock_line} && -n ${run_line} && ${lock_line} -lt ${run_line} ]] ||
  { printf '断言失败：卸载器要一开头就拿锁（lock=%s run=%s）\n' "${lock_line}" "${run_line}" >&2; exit 1; }
components_body="$(declare -f remove_panel_components)"
# 只停 helper 本身：面板的 unit Requires= helper，照常停 helper 会先停面板 / The helper alone: the panel's unit Requires= the
# helper, so a plain stop of the helper stops the panel first
helper_line="$(grep -n 'systemctl stop --job-mode=ignore-dependencies kixdns-panel-helper.service' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
panel_line="$(grep -n 'stop_unit kixdns-panel.service' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
update_line="$(grep -n 'stop_unit kixdns-panel-update.service' <<< "${components_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${helper_line} && -n ${panel_line} && -n ${update_line} && ${update_line} -lt ${panel_line} && ${helper_line} -lt ${panel_line} ]] ||
  { printf '断言失败：面板停下之前应先停在线更新和 helper（update=%s helper=%s panel=%s）\n' "${update_line}" "${helper_line}" "${panel_line}" >&2; exit 1; }
records_quiesce="$(declare -f quiesce_for_records)"
helper_line="$(grep -n 'systemctl stop --job-mode=ignore-dependencies kixdns-panel-helper.service' <<< "${records_quiesce}" | head -n 1 | cut -d: -f1 || true)"
panel_line="$(grep -n 'systemctl stop kixdns-panel.service' <<< "${records_quiesce}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${helper_line} && -n ${panel_line} && ${helper_line} -lt ${panel_line} ]] ||
  { printf '断言失败：挪记录前面板停下之前应先停 helper（helper=%s panel=%s）\n' "${helper_line}" "${panel_line}" >&2; exit 1; }

# 回归（(a)，S4）：不是保留的 KixDNS、别的 unit 用着面板配置目录的子目录里的配置时，子目录也交给 root，子目录里别的东西删掉：
# 以前子目录还归面板，删了面板账号以后归一个空出来的 UID。
# Regression ((a), S4): when a unit other than the kept KixDNS uses a config in a subdirectory of the panel config
# directory, the subdirectory goes to root too and whatever else is in it goes: the subdirectory used to stay the panel's,
# owned by a freed UID once the panel account was removed.
fresh_host "${host}" "${host}/etc-kixdns/pipeline.json"
mkdir -p "${host}/panel-etc/sub/deeper"
printf '{}\n' > "${host}/panel-etc/sub/deeper/user.json"
chmod 0640 "${host}/panel-etc/sub/deeper/user.json"
: > "${host}/panel-etc/sub/leftover"
printf '[Service]\nUser=kixdns\nGroup=kixdns\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${host}/panel-etc/sub/deeper/user.json" \
  > "${host}/units/user-kixdns.service"
: > "${chown_log}"
output="$(PANEL_OWNED=true CHOWN_LOG=${chown_log} ACCOUNTS_PRESENT=true uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "子目录里有 unit 用着的配置时卸载不应失败"
[[ -f ${host}/panel-etc/sub/deeper/user.json && ! -e ${host}/panel-etc/sub/leftover ]] ||
  { printf '断言失败：子目录里只留 unit 用着的配置\n' >&2; exit 1; }
for kept_directory in sub sub/deeper; do
  assert_contains "$(cat "${chown_log}")" "chown -h root -- ${host}/panel-etc/${kept_directory}"$'\n' "${kept_directory} 也应交给 root"
done
assert_contains "$(cat "${chown_log}")" "chown -h root:kixdns -- ${host}/panel-etc/sub/deeper/user.json" "子目录里的配置应交给 root"

# 规则写在脚本开头 / The rules are written at the top of the script
for rule in R1 R2 R3 R4; do
  assert_contains "$(head -n 60 "${UNINSTALLER}")" "# ${rule}：" "uninstall.sh 开头应写明规则 ${rule}"
done

rm -rf -- "${scratch}"

one_click_help="$(bash "${PACKAGE_ROOT}/scripts/one-click-install.sh" --help)"
[[ ${one_click_help} == *"--version"* ]]
[[ -f "${PACKAGE_ROOT}/scripts/panel-online-update.sh" ]]

printf '卸载策略检查通过。\n'
