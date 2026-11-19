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

# 测试里的 systemd 只回答卸载器会问的 `show --property=名字 --value unit`，按临时目录里的 unit 文件作答，不碰开发机上真实的服务：
# 先找 SYSTEMD_UNIT_DIRECTORY（相当于 /etc/systemd/system），再找 OTHER_UNIT_DIRECTORY（相当于 /usr/local/lib/systemd/system）。
# The systemd of these tests answers only the `show --property=NAME --value UNIT` the uninstaller asks, from the unit files
# in the scratch tree, never touching the real services of the dev host: SYSTEMD_UNIT_DIRECTORY first (standing in for
# /etc/systemd/system), then OTHER_UNIT_DIRECTORY (standing in for /usr/local/lib/systemd/system).
fake_systemctl_show() {
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
  case ${property} in
    ActiveState) printf 'active\n' ;;
    MainPID) printf '4242\n' ;;
    FragmentPath) printf '%s\n' "${file}" ;;
    ExecStart)
      [[ -z ${file} ]] ||
        awk '/^ExecStart=/ { line = $0; sub(/^ExecStart=/, "", line); split(line, words, " ")
          printf "{ path=%s ; argv[]=%s ; ignore_errors=no ; }\n", words[1], line }' "${file}"
      ;;
    User) [[ -z ${file} ]] || awk '/^User=/ { value = $0; sub(/^User=/, "", value) } END { print value }' "${file}" ;;
  esac
}
systemctl() { [[ $1 != show ]] || fake_systemctl_show "$@"; }

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

# 外部备份：迁移前原来的 KixDNS 才算；以前重装时备份的面板自带 KixDNS（跑的是面板状态目录里的程序）不算，
# 否则卸载会把一个程序已被删掉的服务放回去、开机启动。
# The external backup counts for the KixDNS from before migration only; one an older reinstall made of the panel's own
# KixDNS (running the program in the panel's state directory) does not, or uninstall would restore a service whose program
# is gone and enable it at boot.
(
  work="$(mktemp -d)"
  trap 'rm -rf -- "${work}"' EXIT
  EXTERNAL_BACKUP="${work}/external-backup"
  mkdir -p "${EXTERNAL_BACKUP}"
  printf 'KIXDNS_BINARY=%s\n' /usr/local/bin/kixdns > "${EXTERNAL_BACKUP}/install.env"
  external_backup_present || { printf '断言失败：原来的 KixDNS 的备份应当算数\n' >&2; exit 1; }
  printf 'KIXDNS_BINARY=%s\n' "${PANEL_STATE_DIRECTORY}/bin/kixdns" > "${EXTERNAL_BACKUP}/install.env"
  ! external_backup_present || { printf '断言失败：面板自带 KixDNS 的备份不能当成原来的 KixDNS\n' >&2; exit 1; }
  rm -f -- "${EXTERNAL_BACKUP}/install.env"
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
    EXTERNAL_BACKUP="${work}/external-backup"
    mkdir -p "${SYSTEMD_UNIT_DIRECTORY}" "${OTHER_UNIT_DIRECTORY}"
    unit_directory=${SYSTEMD_UNIT_DIRECTORY}
    [[ ${where} == etc ]] || unit_directory=${OTHER_UNIT_DIRECTORY}
    printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_CONFIG=/etc/kixdns/pipeline.json\n' > "${PANEL_ENV}"
    printf '[Service]\nExecStart=%s run --config /etc/kixdns/pipeline.json\n' "${exec_start}" > "${unit_directory}/kixdns.service"
    if [[ ${with_backup} == true ]]; then
      mkdir -p "${EXTERNAL_BACKUP}"
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
systemctl() { [[ $1 != show ]] || fake_systemctl_show "$@"; }

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
[[ ${output} != *"systemctl disable --now kixdns.service"* ]] || {
  printf '断言失败：不是面板创建的 unit 不应被停用\n%s\n' "${output}" >&2
  exit 1
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

# ---------------------------------------------------------------------------
# 迁移来的主机：配置 / Migrated hosts: the config
# ---------------------------------------------------------------------------

INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"

# 卸载器单独分发、不能 source 安装器，这几个函数各有一份，必须一字不差：哪边改了另一边没跟上，这里就失败。
# The uninstaller ships on its own and cannot source the installer, so these functions exist twice and must match
# exactly: when one side changes without the other, this fails.
for shared_function in wait_for_service_stable port_accepts_connection; do
  installer_copy="$(bash -c "source '${INSTALLER}'; declare -f ${shared_function}")"
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
    EXTERNAL_BACKUP=\"\${root}/state/external-backup\"
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
    update_panel_environment() { render_panel_environment /dev/null \"\${PANEL_ENV}\" commit panel '' 1 fork; }
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
    INSTALL_MODE=managed
    detect_existing_kixdns
    determine_install_kind
    validate_install_mode
    preserve_external_install
    install_configuration
    render_kixdns_unit > \"\${SYSTEMD_UNIT_DIRECTORY}/kixdns.service\"
  "
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
    PANEL_ENV="${PANEL_CONFIG_DIRECTORY}/panel.env"
    EXTERNAL_BACKUP="${PANEL_STATE_DIRECTORY}/external-backup"
    RESOLVED_STATE="${PANEL_STATE_DIRECTORY}/resolved-stub"
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
    account_has_processes() { [[ ${ACCOUNT_BUSY:-} == true ]]; }
    chown() { :; }
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
[[ ! -e ${host}/state/external-backup ]] || { printf '断言失败：恢复成功后应删掉迁移前的备份\n' >&2; exit 1; }
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
cmp -s -- "${host}/state/external-backup/kixdns.service" "${host}/second.service" ||
  { printf '断言失败：再迁移时应备份主机上现在的 unit\n' >&2; exit 1; }
backup="$(cat "${host}/state/external-backup/install.env")"
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
  [[ -f ${host}/state/external-backup/install.env && -f ${host}/panel-etc/panel.env ]] ||
    { printf '断言失败：恢复没做完时备份和 panel.env 都要留着（%s）\n' "${config_action}" >&2; exit 1; }
  : > "${systemctl_log}"
  output="$(SYSTEMCTL_LOG=${systemctl_log} uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_not_contains "${output}" "RUN-FAILED" "重新运行卸载器应把恢复做完（${config_action}）"
  assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "重新运行卸载器应恢复原来的 KixDNS（${config_action}）"
  assert_equals "$(restore_calls)" "enable kixdns.service --quiet;start kixdns.service;" \
    "重新运行卸载器应按迁移前的状态启动（${config_action}）"
  cmp -s -- "${host}/units/kixdns.service" "${host}/original.service" ||
    { printf '断言失败：重新运行卸载器应放回原来的 unit（%s）\n' "${config_action}" >&2; exit 1; }
  [[ ! -e ${host}/state/external-backup ]] || { printf '断言失败：恢复做完后应删掉备份（%s）\n' "${config_action}" >&2; exit 1; }
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
  [[ -f ${host}/state/external-backup/install.env && -f ${host}/panel-etc/panel.env ]] ||
    { printf '断言失败：原来的 KixDNS 没稳定运行时备份和 panel.env 都要留着（%s）\n' "${config_action}" >&2; exit 1; }
  output="$(uninstall_scratch_host "${host}" --remove-kixdns "--${config_action}-config" --yes)"
  assert_contains "${output}" "原来的 KixDNS 已恢复，运行状态和迁移前一样。" "它能稳定运行以后重新运行卸载器应恢复完（${config_action}）"
done

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
}
inplace_host "${host}"
output="$(uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "原地迁移的主机卸载不应失败"
assert_equals "$(cat "${host}/etc/kixdns.json" 2>/dev/null || printf missing)" '{"edited":true}' "原地迁移的主机卸载时不动它的配置"
assert_contains "${output}" "它用的配置 ${host}/etc/kixdns.json 是面板最后保存的内容：旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底。" \
  "原地迁移的主机卸载时应说明配置是面板改过的"

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
backup="$(cat "${host}/state/external-backup/install.env")"
assert_contains "${backup}" "KIXDNS_USER_CREATED=true" "迁移建了 kixdns 账号时备份应记下"
assert_contains "${backup}" "KIXDNS_GROUP_CREATED=true" "迁移建了 kixdns 组时备份应记下"
: > "${account_log}"
output="$(ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
assert_not_contains "${output}" "RUN-FAILED" "恢复并删除数据不应失败"
assert_equals "$(account_calls)" "userdel kixdns-panel;userdel kixdns;groupdel kixdns;" "恢复并删除数据时应删掉迁移建的账号和组"
migrated_host "${host}" > /dev/null 2>&1 || printf 'MIGRATION-FAILED\n'
assert_contains "$(cat "${host}/state/external-backup/install.env")" "KIXDNS_USER_CREATED=false" "账号原来就有时备份应记下不是迁移建的"
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
output="$(OTHER_UNIT_DIRECTORY=${other_units} SYSTEMCTL_LOG=${systemctl_log} ACCOUNTS_PRESENT=true ACCOUNT_LOG=${account_log} \
  uninstall_scratch_host "${host}" --remove-kixdns --remove-config --yes)"
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
rm -rf -- "${scratch}"

one_click_help="$(bash "${PACKAGE_ROOT}/scripts/one-click-install.sh" --help)"
[[ ${one_click_help} == *"--version"* ]]
[[ -f "${PACKAGE_ROOT}/scripts/panel-online-update.sh" ]]

printf '卸载策略检查通过。\n'
