#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2034,SC2317,SC2329
set -Eeuo pipefail

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

PANEL_ENV="${PACKAGE_ROOT}/.missing-panel.env"
EXTERNAL_BACKUP="${PACKAGE_ROOT}/.missing-external-backup"
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

# 安装器关闭过 systemd-resolved 的本机监听：移除 KixDNS 时恢复原样，保留 KixDNS 时只给出恢复命令。
# The installer turned systemd-resolved's stub off: removing KixDNS restores it, keeping KixDNS only prints the commands.
resolved_uninstall() {
  local action=$1
  local work
  work="$(mktemp -d)"
  (
    RESOLVED_STATE="${work}/state"
    RESOLVED_DROPIN="${work}/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${work}/resolv.conf"
    mkdir -p "${RESOLVED_STATE}" "$(dirname -- "${RESOLVED_DROPIN}")"
    printf '[Resolve]\nDNSStubListener=no\n' > "${RESOLVED_DROPIN}"
    ln -s /run/systemd/resolve/resolv.conf "${RESOLV_CONF}"
    printf '%s\n' RESOLVED_DROPIN_DIRECTORY_CREATED=true RESOLV_CONF_KIND=symlink \
      RESOLV_CONF_TARGET=../run/systemd/resolve/stub-resolv.conf > "${RESOLVED_STATE}/install.env"
    systemctl() { printf 'systemctl %s\n' "$*"; }
    KIXDNS_ACTION=${action}
    restore_resolved_stub
    printf 'LINK=%s\n' "$(readlink "${RESOLV_CONF}")"
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

one_click_help="$(bash "${PACKAGE_ROOT}/scripts/one-click-install.sh" --help)"
[[ ${one_click_help} == *"--version"* ]]
[[ -f "${PACKAGE_ROOT}/scripts/panel-online-update.sh" ]]

printf '卸载策略检查通过。\n'
