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
# 没有 panel.env 时卸载器会扫描 unit 目录；指向不存在的目录，免得读到开发机上真实安装的 KixDNS。
# Without panel.env the uninstaller scans the unit directory; point it nowhere so a real KixDNS on the dev host cannot leak in.
SYSTEMD_UNIT_DIRECTORY="${PACKAGE_ROOT}/.missing-systemd-units"
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
  local kind=${2:-symlink}
  local work
  work="$(mktemp -d)"
  (
    RESOLVED_STATE="${work}/state"
    RESOLVED_DROPIN="${work}/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${work}/resolv.conf"
    mkdir -p "${RESOLVED_STATE}" "$(dirname -- "${RESOLVED_DROPIN}")"
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
    EXTERNAL_BACKUP="${PANEL_STATE_DIRECTORY}/external-backup"
    RESOLVED_STATE="${PANEL_STATE_DIRECTORY}/resolved-stub"
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
    EXTERNAL_BACKUP="${PANEL_STATE_DIRECTORY}/external-backup"
    RESOLVED_STATE="${PANEL_STATE_DIRECTORY}/resolved-stub"
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
    esac
    systemctl() {
      [[ $1 != is-active ]] || return 1
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
  assert_contains "${output}" "该 unit 由面板创建，将随面板一起移除" "移除失效的面板 unit 时必须说明原因"
  assert_contains "${output}" "没有可保留的 KixDNS" "程序不在时不能声称 KixDNS 已保留"
done
output="$(dead_unit_uninstall foreign 2>&1)"
[[ ${output} != *RUN-FAILED* ]] || {
  printf '断言失败：程序已不存在的外部 unit 不应让卸载失败\n%s\n' "${output}" >&2
  exit 1
}
assert_contains "${output}" "UNIT-LEFT" "不是面板创建的 unit 必须原样保留"
assert_contains "${output}" "该 unit 不是面板创建的，保留不动" "保留失效的外部 unit 时必须说明"
[[ ${output} != *"systemctl disable --now kixdns.service"* ]] || {
  printf '断言失败：不是面板创建的 unit 不应被停用\n%s\n' "${output}" >&2
  exit 1
}

one_click_help="$(bash "${PACKAGE_ROOT}/scripts/one-click-install.sh" --help)"
[[ ${one_click_help} == *"--version"* ]]
[[ -f "${PACKAGE_ROOT}/scripts/panel-online-update.sh" ]]

printf '卸载策略检查通过。\n'
