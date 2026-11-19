#!/usr/bin/env bash
set -Eeuo pipefail

PANEL_CONFIG_DIRECTORY=/etc/kixdns-panel
PANEL_STATE_DIRECTORY=/var/lib/kixdns-panel
SYSTEMD_UNIT_DIRECTORY=/etc/systemd/system
PANEL_ENV=/etc/kixdns-panel/panel.env
EXTERNAL_BACKUP=/var/lib/kixdns-panel/external-backup
# 本地的卸载命令随面板一起删掉以后，接着卸载用的是这一份（docs/deployment.md 的「卸载」）。
# Once the local uninstall command is removed with the panel, this copy carries on (「卸载」 in docs/deployment.md).
UNINSTALL_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh"
# 全新安装时安装器为 KixDNS 配置建的目录；panel.env 记下的配置在这里时，它才随 KixDNS 删掉。
# The directory the installer creates for the KixDNS config on a fresh install; it goes with KixDNS only when the
# config panel.env records is in it.
KIXDNS_CONFIG_DIRECTORY=/etc/kixdns
KIXDNS_RUNTIME_DIRECTORY=/run/kixdns
# panel.env 记下的、面板管理的 KixDNS 配置；迁移来的主机上是原配置的副本。备份里记的是迁移前原来的 KixDNS 的配置。
# The KixDNS config panel.env records, the one the panel manages; on a migrated host it is a copy of the original. The
# backup records the original KixDNS's config from before migration.
MANAGED_CONFIG=""
ORIGINAL_CONFIG=""
# 安装器关闭 systemd-resolved 本机监听时留下的记录；移除 KixDNS 时据此恢复。
# The record the installer leaves when it turns systemd-resolved's stub off; removing KixDNS restores from it.
RESOLVED_STATE=/var/lib/kixdns-panel/resolved-stub
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/kixdns-panel.conf
RESOLV_CONF=/etc/resolv.conf
KIXDNS_MANAGED=false
KIXDNS_SERVICE_UNIT=kixdns.service
KIXDNS_ACTION=auto
CONFIG_ACTION=auto
ASSUME_YES=false
PURGE=false
HAS_EXTERNAL_BACKUP=false
ORIGINAL_UNIT=""
ORIGINAL_ENABLED=false
ORIGINAL_ACTIVE=false
RESTORED_EXTERNAL=false
KIXDNS_KEPT_EARLIER=false
# 迁移建的 kixdns 账号和组（备份里记的）：恢复、删除面板数据时一起删 / The kixdns account and group the migration created
# (recorded in the backup): removed with the panel data on a restore
ORIGINAL_USER_CREATED=false
ORIGINAL_GROUP_CREATED=false
# KixDNS 已不归面板管时，保留的 panel.env 记下的待删的东西：面板自己的 KixDNS 已移除、它的配置和 kixdns 账号留着
# （KIXDNS_REMOVED），或者迁移建的 kixdns 账号、组（KIXDNS_USER_CREATED、KIXDNS_GROUP_CREATED）。删除面板数据时一起删。
# What the kept panel.env records as left to remove once the KixDNS is no longer the panel's: the panel's own KixDNS was
# removed, leaving its config and the kixdns account (KIXDNS_REMOVED), or the kixdns account and group a migration created
# (KIXDNS_USER_CREATED, KIXDNS_GROUP_CREATED). They go when the panel data is removed.
LEFT_REMOVED=false
LEFT_USER_CREATED=false
LEFT_GROUP_CREATED=false
# 指向面板目录里、但程序已经不在的 unit：前者由面板创建、随面板移除，后者不是面板创建的、原样保留。
# Units pointing at the panel's kixdns after the binary is gone: panel-created ones go with the panel, others stay.
DEAD_PANEL_UNITS=()
DEAD_FOREIGN_UNITS=()
# 和 install.sh 一样：放回去的原来的 KixDNS 要在这么长时间里起来，并保持同一个主进程这么久。
# As in install.sh: the original KixDNS put back must come up within this long and keep one main process for this long.
SERVICE_WAIT_SECONDS=15
SERVICE_STABLE_SECONDS=4

fail() {
  printf '卸载失败：%s\n' "$*" >&2
  exit 1
}

cancel_uninstall() {
  # 取消是用户的选择，不是失败，所以不带「卸载失败」前缀。
  # Cancelling is the user's choice, not a failure, so it carries no failure prefix.
  printf '已取消卸载，未作任何修改。\n' >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：sudo kixdns-panel-uninstall [选项]

默认通过交互终端依次询问 KixDNS 和配置数据的处理方式。

  --keep-kixdns     仅卸载面板，保留当前 KixDNS
  --remove-kixdns   同时移除面板管理的 KixDNS；迁移过来的会移除增强版、恢复原来的 KixDNS
  --keep-config     保留面板配置、数据库、版本库和 Geo 数据
  --remove-config   删除面板配置与运行数据
  --yes             跳过最终确认；仍须明确指定缺少的处理方式
  --purge           兼容旧命令，等同 --remove-kixdns --remove-config --yes
  -h, --help        显示帮助

无人值守示例：
  sudo kixdns-panel-uninstall --keep-kixdns --keep-config --yes
  sudo kixdns-panel-uninstall --remove-kixdns --remove-config --yes
EOF
}

set_choice() {
  local variable=$1
  local value=$2
  local current=${!variable}
  [[ ${current} == auto || ${current} == "${value}" ]] || fail "存在互相冲突的卸载选项"
  printf -v "${variable}" '%s' "${value}"
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge)
        [[ ${PURGE} == false && ${KIXDNS_ACTION} == auto && ${CONFIG_ACTION} == auto ]] ||
          fail "--purge 不能与其他处理选项同时使用"
        PURGE=true
        KIXDNS_ACTION=remove
        CONFIG_ACTION=remove
        ASSUME_YES=true
        ;;
      --keep-kixdns)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice KIXDNS_ACTION keep
        ;;
      --remove-kixdns)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice KIXDNS_ACTION remove
        ;;
      --keep-config)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice CONFIG_ACTION keep
        ;;
      --remove-config)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice CONFIG_ACTION remove
        ;;
      --yes) ASSUME_YES=true ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "未知参数 $1" ;;
    esac
    shift
  done
}

environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

backup_value() {
  local key=$1
  local file=${EXTERNAL_BACKUP}/install.env
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

unit_runs_managed_binary() {
  local file=$1
  [[ -f ${file} && ! -L ${file} ]] || return 1
  awk -v binary="${PANEL_STATE_DIRECTORY}/bin/kixdns" '
    /^[[:space:]]*ExecStart[[:space:]]*=/ && index($0, binary) { found = 1 }
    END { exit !found }
  ' "${file}"
}

# 这个 unit 跑的不是面板的程序：/etc/systemd/system 里的文件写着别的程序，或者 systemd 实际加载的那一份（可能在
# /usr/local/lib/systemd/system 之类的别处，也可能被 drop-in 改过 ExecStart）跑的是别的程序。没有这个 unit 时不算。
# This unit does not run the panel's program: the file in /etc/systemd/system names another one, or the copy systemd really
# loads (perhaps elsewhere, such as /usr/local/lib/systemd/system, or with ExecStart changed by a drop-in) runs another one.
# A unit that does not exist does not count.
unit_runs_other_program() {
  local unit=$1
  local file=${SYSTEMD_UNIT_DIRECTORY}/${unit}
  local exec_start
  if [[ -f ${file} ]] && ! unit_runs_managed_binary "${file}"; then
    return 0
  fi
  exec_start="$(systemctl show --property=ExecStart --value "${unit}" 2>/dev/null || true)"
  [[ ${exec_start} =~ path=([^[:space:];]+) ]] || return 1
  [[ ${BASH_REMATCH[1]} != "${PANEL_STATE_DIRECTORY}/bin/kixdns" ]]
}

# 保留只对真实存在的程序有意义：普通文件、不是符号链接、可执行。
# Keeping only means something for a binary that is really there: a regular, non-symlink, executable file.
managed_binary_present() {
  local binary=${PANEL_STATE_DIRECTORY}/bin/kixdns
  [[ -f ${binary} && ! -L ${binary} && -x ${binary} ]]
}

# 面板写出的 unit 带面板的 Documentation= 行，或者是安装器渲染的 ExecStart 形状。
# A unit the panel wrote carries the panel's Documentation= line or the ExecStart shape the installer renders.
unit_created_by_panel() {
  local file=$1
  awk -v binary="${PANEL_STATE_DIRECTORY}/bin/kixdns" '
    /^Documentation=https:\/\/github\.com\/tuoro\/kixdns-panel[[:space:]]*$/ { found = 1 }
    $1 == "ExecStart=" binary && $2 == "run" && $3 == "--config" && $4 ~ /^\// &&
      $5 == "--admin-socket" && $6 ~ /^\// && NF == 6 { found = 1 }
    END { exit !found }
  ' "${file}"
}

# 还有 unit 在运行面板目录里的 kixdns 时，就不能整个删掉状态目录。
# While any unit still runs the kixdns inside the panel's state directory, that directory must not be removed wholesale.
managed_binary_in_use() {
  local file
  managed_binary_present || return 1
  for file in "${SYSTEMD_UNIT_DIRECTORY}"/*.service; do
    unit_runs_managed_binary "${file}" && return 0
  done
  return 1
}

detect_kept_kixdns() {
  local file
  local unit
  # 上一次卸载选择保留 KixDNS 并删除配置时，panel.env 已经没了，但 unit 仍在运行面板目录里的程序。
  # 这时按「面板管理、已选择保留」处理；否则第二次卸载会把保留的程序连同状态目录删掉，重启后主机没有 DNS。
  # When an earlier uninstall kept KixDNS and removed the config, panel.env is gone but a unit still
  # runs the binary in the panel's directory. Treat it as panel-managed and kept; otherwise a second run
  # deletes the kept binary with the state directory and the host has no DNS after the next reboot.
  # 程序已经不在（v3.1.1 的重复卸载会删掉它、留下 unit）时没有可保留的东西：不能强制保留，否则删除配置时找不到二进制而失败。
  # When the binary is gone (v3.1.1's repeated uninstall deleted it and left the unit) there is nothing to keep:
  # forcing keep would make removing the config fail on the missing binary.
  for file in "${SYSTEMD_UNIT_DIRECTORY}"/*.service; do
    unit_runs_managed_binary "${file}" || continue
    unit=${file##*/}
    case ${unit} in
      kixdns-panel.service | kixdns-panel-helper.service | kixdns-panel-update.service) continue ;;
    esac
    # 文件写着面板的程序，systemd 却按 drop-in 跑别的：那是别人的服务，不当成面板留下的 / The file names the panel's program
    # but systemd runs another one through a drop-in: someone else's service, not one the panel left
    ! unit_runs_other_program "${unit}" || continue
    if ! managed_binary_present; then
      if unit_created_by_panel "${file}"; then
        DEAD_PANEL_UNITS+=("${unit}")
        printf '%s 指向的 KixDNS 程序已不存在；这个服务由面板创建，随面板一起移除。\n' "${unit}"
      else
        DEAD_FOREIGN_UNITS+=("${unit}")
        printf '%s 指向的 KixDNS 程序已不存在；这个服务不是面板创建的，保留不动。\n' "${unit}"
      fi
      continue
    fi
    KIXDNS_SERVICE_UNIT=${unit}
    KIXDNS_MANAGED=true
    KIXDNS_KEPT_EARLIER=true
    return 0
  done
}

load_settings() {
  local value
  if [[ -f ${PANEL_ENV} ]]; then
    # 现在的安装器不再写 KIXDNS_MANAGEMENT_ENABLED；值是 false 表示 KixDNS 不归面板管：已移除的「仅安装面板」模式留下的，
    # 或者卸载放回了原来的 KixDNS、保留了 panel.env（mark_kixdns_unmanaged）。没有 panel.env 时无法确认归属，同样按不归面板管
    # 处理，宁可保留。
    # Current installers no longer write KIXDNS_MANAGEMENT_ENABLED; false means the KixDNS is not the panel's: left by the
    # removed panel-only mode, or by an uninstall that put the original KixDNS back and kept panel.env
    # (mark_kixdns_unmanaged). Without panel.env ownership is unknown, so keep it.
    value="$(environment_value KIXDNS_MANAGEMENT_ENABLED || true)"
    [[ -z ${value} || ${value} =~ ^(true|false)$ ]] ||
      fail "panel.env 里的 KixDNS 管理模式无效"
    [[ ${value} == false ]] || KIXDNS_MANAGED=true
    value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
    [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
    MANAGED_CONFIG="$(environment_value KIXDNS_CONFIG || true)"
    [[ $(environment_value KIXDNS_REMOVED || true) != true ]] || LEFT_REMOVED=true
    [[ $(environment_value KIXDNS_USER_CREATED || true) != true ]] || LEFT_USER_CREATED=true
    [[ $(environment_value KIXDNS_GROUP_CREATED || true) != true ]] || LEFT_GROUP_CREATED=true
  else
    detect_kept_kixdns
  fi
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh).
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${KIXDNS_SERVICE_UNIT} != *..* ]] ||
    fail "panel.env 里的 KixDNS 服务名称无效"
  if external_backup_present; then
    HAS_EXTERNAL_BACKUP=true
  fi
  # panel.env 说归面板管，可它的 unit 已经换成跑别的程序（保留配置卸载后，用户换上了自己的 KixDNS）：它不再是面板的，
  # 和不归面板管一样整个保留，不停、不删 unit、不删 /etc/kixdns 和 kixdns 账号。看的是 systemd 实际加载的那个 unit，
  # 不只是 /etc/systemd/system 里的文件：用户的 unit 可能放在别处。还有外部备份时不这样认：那是迁移来的主机恢复到一半，
  # unit 是放回去的原 unit，要照旧把恢复做完。
  # panel.env says the panel's, but its unit now runs another program (after a keep-config uninstall the user put their own
  # KixDNS in): it is no longer the panel's and is kept whole, as an unmanaged one is: not stopped, its unit, /etc/kixdns
  # and the kixdns account not removed. What counts is the unit systemd really loads, not only the file in
  # /etc/systemd/system: the user's unit may live elsewhere. Not so with an external backup still there: that is a migrated
  # host part way through a restore, the unit is the original put back, and the restore must finish as before.
  if [[ ${KIXDNS_MANAGED} == true && ${HAS_EXTERNAL_BACKUP} == false ]] && unit_runs_other_program "${KIXDNS_SERVICE_UNIT}"; then
    KIXDNS_MANAGED=false
  fi
}

# 迁移前原来的 KixDNS 的备份。以前重装会把卸载时留下的面板自带 KixDNS 也备份成「原来的」：它跑的是面板状态目录里的程序，
# 放回去就是一个程序已被删掉、却开机启动的服务。这样的备份不算
# The backup of the KixDNS from before migration. An older reinstall also backed up the panel's own KixDNS kept by an
# uninstall as the original: it runs the program in the panel's state directory, so putting it back gave a service enabled
# at boot whose program is gone. Such a backup does not count
external_backup_present() {
  [[ -f ${EXTERNAL_BACKUP}/install.env ]] || return 1
  [[ $(backup_value KIXDNS_BINARY || true) != "${PANEL_STATE_DIRECTORY}/bin/kixdns" ]]
}

# 迁移外部 KixDNS 时面板管理的配置副本所在的目录，和 install.sh 的 MIGRATED_KIXDNS_CONFIG_DIRECTORY 是同一个；只有面板会建它。
# The directory of the config copy the panel manages after migrating an external KixDNS, the same as install.sh's
# MIGRATED_KIXDNS_CONFIG_DIRECTORY; only the panel creates it.
migrated_config_directory() {
  printf '%s/kixdns\n' "${PANEL_CONFIG_DIRECTORY}"
}

# panel.env 记下的配置是迁移副本，而且不是原来的 KixDNS 自己的配置（那是配置本来就放在副本位置、原地接管的情况）。
# panel.env names the migration copy as the config, and it is not the original KixDNS's own config (which happens when
# the config already sat where the copy goes and was managed in place).
managed_config_is_copy() {
  [[ ${MANAGED_CONFIG} == "$(migrated_config_directory)/pipeline.json" && ${MANAGED_CONFIG} != "${ORIGINAL_CONFIG}" ]]
}

open_terminal() {
  # 裸 exec 上的重定向会永久生效：写成 `exec 3<>/dev/tty 2>/dev/null` 会让之后所有错误信息消失。
  # A redirection on a bare exec is permanent: `exec 3<>/dev/tty 2>/dev/null` would hide every later error.
  { exec 3<>/dev/tty; } 2>/dev/null ||
    fail "当前没有交互终端；要写明 KixDNS 和配置怎么处理，并加 --yes"
}

close_terminal() {
  exec 3>&- 3<&-
}

choose_kixdns_action() {
  local choice=""
  if [[ ${KIXDNS_KEPT_EARLIER} == true ]]; then
    if [[ ${KIXDNS_ACTION} == remove ]]; then
      printf '上次卸载保留了 KixDNS（%s），面板配置已删除，无法确认如何安全移除；这次同样保留。\n' "${KIXDNS_SERVICE_UNIT}"
    fi
    KIXDNS_ACTION=keep
    return
  fi
  if [[ ${KIXDNS_MANAGED} != true ]]; then
    if [[ ${KIXDNS_ACTION} == remove && ${#DEAD_PANEL_UNITS[@]} -eq 0 && ${#DEAD_FOREIGN_UNITS[@]} -eq 0 ]]; then
      printf '这台机器的 KixDNS 不归面板管理，为防止误删，只卸载面板、保留它。\n'
    fi
    KIXDNS_ACTION=keep
    return
  fi
  [[ ${KIXDNS_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n选择 KixDNS 的处理方式：\n' >&3
  printf '  1. 仅卸载面板，保留当前 KixDNS\n' >&3
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    printf '  2. 移除增强版，恢复原来的 KixDNS\n' >&3
  else
    printf '  2. 同时移除面板管理的 KixDNS\n' >&3
  fi
  printf '  3. 取消卸载（默认）\n' >&3
  printf '选 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) KIXDNS_ACTION=keep ;;
    2) KIXDNS_ACTION=remove ;;
    *) cancel_uninstall ;;
  esac
}

choose_config_action() {
  local choice=""
  [[ ${CONFIG_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n选择配置与运行数据的处理方式：\n' >&3
  printf '  1. 保留配置、数据库、版本库和 Geo 数据\n' >&3
  printf '  2. 删除全部面板配置与运行数据\n' >&3
  printf '  3. 取消卸载（默认）\n' >&3
  printf '选 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) CONFIG_ACTION=keep ;;
    2) CONFIG_ACTION=remove ;;
    *) cancel_uninstall ;;
  esac
}

confirm_uninstall() {
  local answer=""
  [[ ${ASSUME_YES} == true ]] && return
  open_terminal
  printf '\n卸载计划：\n' >&3
  if [[ ${KIXDNS_ACTION} == keep ]]; then
    printf '  - 保留 KixDNS\n' >&3
  elif [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    # 和上面的选项同一句话：迁移过来的主机上，移除的是增强版，原来的 KixDNS 会放回去
    printf '  - 移除增强版，恢复原来的 KixDNS\n' >&3
  else
    printf '  - 移除面板管理的 KixDNS\n' >&3
  fi
  if [[ ${CONFIG_ACTION} == keep ]]; then
    printf '  - 保留面板配置与运行数据\n' >&3
  else
    printf '  - 删除面板配置与运行数据\n' >&3
  fi
  printf '确认继续？[y/N]：' >&3
  IFS= read -r answer <&3 || true
  close_terminal
  [[ ${answer} =~ ^([yY]|[yY][eE][sS])$ ]] || cancel_uninstall
}

validate_non_interactive() {
  if [[ ${ASSUME_YES} == true && (${KIXDNS_ACTION} == auto || ${CONFIG_ACTION} == auto) ]]; then
    fail "--yes 必须与完整的 KixDNS 和配置处理选项一起使用"
  fi
}

load_external_backup() {
  [[ ${HAS_EXTERNAL_BACKUP} == true ]] || return 0
  ORIGINAL_UNIT="$(backup_value KIXDNS_SERVICE_UNIT || true)"
  ORIGINAL_ENABLED="$(backup_value KIXDNS_WAS_ENABLED || true)"
  ORIGINAL_ACTIVE="$(backup_value KIXDNS_WAS_ACTIVE || true)"
  ORIGINAL_CONFIG="$(backup_value KIXDNS_CONFIG || true)"
  [[ $(backup_value KIXDNS_USER_CREATED || true) != true ]] || ORIGINAL_USER_CREATED=true
  [[ $(backup_value KIXDNS_GROUP_CREATED || true) != true ]] || ORIGINAL_GROUP_CREATED=true
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh).
  [[ ${ORIGINAL_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${ORIGINAL_UNIT} != *..* ]] ||
    fail "原来的 KixDNS 的备份里，服务名称无效"
  [[ ${ORIGINAL_ENABLED} =~ ^(true|false)$ && ${ORIGINAL_ACTIVE} =~ ^(true|false)$ ]] ||
    fail "原来的 KixDNS 的备份里，运行状态无效"
}

validate_removal_targets() {
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]] && managed_config_is_copy; then
    [[ ! -L ${PANEL_CONFIG_DIRECTORY} ]] || fail "配置目录不能是符号链接"
  fi
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  [[ ! -L ${PANEL_CONFIG_DIRECTORY} && ! -L ${PANEL_STATE_DIRECTORY} ]] ||
    fail "配置目录不能是符号链接"
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == keep ]]; then
    [[ -f ${PANEL_STATE_DIRECTORY}/bin/kixdns && ! -L ${PANEL_STATE_DIRECTORY}/bin/kixdns ]] ||
      fail "找不到需要保留的 KixDNS 二进制"
  fi
}

stop_unit() {
  local unit=$1
  systemctl disable --now "${unit}" 2>/dev/null || true
  systemctl stop "${unit}" 2>/dev/null || true
  systemctl kill --kill-who=all "${unit}" 2>/dev/null || true
  systemctl reset-failed "${unit}" 2>/dev/null || true
}

wait_for_unit_inactive() {
  local unit=$1
  local attempt
  for ((attempt = 0; attempt < 50; attempt++)); do
    systemctl is-active --quiet "${unit}" || return 0
    sleep 0.1
  done
  fail "无法停止服务 ${unit}"
}

terminate_account_processes() {
  local account=$1
  local attempt
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -u "${account}" >/dev/null 2>&1 || return 0
  pkill -TERM -u "${account}" 2>/dev/null || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    pgrep -u "${account}" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  pkill -KILL -u "${account}" 2>/dev/null || true
  for ((attempt = 0; attempt < 10; attempt++)); do
    pgrep -u "${account}" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  fail "账号 ${account} 仍有无法停止的进程"
}

remove_account() {
  local account=$1
  getent passwd "${account}" >/dev/null 2>&1 || return 0
  terminate_account_processes "${account}"
  userdel "${account}" 2>/dev/null ||
    fail "删不掉账号 ${account}：先停掉这个账号的其他进程"
}

# 这个账号还有进程在跑。不靠 pgrep：精简的系统上没有 procps。/proc 里每个进程目录的属主就是它的有效 UID。
# The account still has processes running. pgrep is not relied on, as minimal systems lack procps: the owner of each
# process directory in /proc is its effective UID.
account_has_processes() {
  local uid
  local entry
  uid="$(id -u "$1" 2>/dev/null)" || return 1
  for entry in /proc/[0-9]*; do
    [[ $(stat -c '%u' -- "${entry}" 2>/dev/null) != "${uid}" ]] || return 0
  done
  return 1
}

# 删掉面板的 kixdns 账号（参数 user 或 user=true）和 kixdns 组（参数 group 或 group=true）。面板的 KixDNS 这时已经停了、unit 已经删了：账号还有进程在跑，
# 或者 systemd 加载的同名 unit 写着用它，就是别人的服务在用（比如保留配置卸载后用户自己装的 KixDNS），账号和组都留着，不去
# 杀它的进程。kixdns-panel 账号的主组也是 kixdns，所以要先删 kixdns-panel。
# Removes the panel's kixdns account (argument user) and kixdns group (argument group). The panel's KixDNS has stopped and
# its unit is gone by now: an account that still has processes, or that the loaded unit of that name says it runs as, is in
# use by someone else's service (the user's own KixDNS installed after a keep-config uninstall, say), so the account and the
# group both stay and its processes are not killed. kixdns-panel has kixdns as its primary group too, so it goes first.
remove_kixdns_account() {
  local item
  local remove_user=false
  local remove_group=false
  for item in "$@"; do
    case ${item} in
      user | user=true) remove_user=true ;;
      group | group=true) remove_group=true ;;
    esac
  done
  if getent passwd kixdns >/dev/null 2>&1; then
    if account_has_processes kixdns ||
      [[ $(systemctl show --property=User --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true) == kixdns ]]; then
      if [[ ${remove_user} == true || ${remove_group} == true ]]; then
        printf 'kixdns 账号还有别的进程或服务在用，保留它和 kixdns 组。\n'
      fi
      return 0
    fi
    if [[ ${remove_user} == true ]]; then
      userdel kixdns 2>/dev/null || fail "删不掉账号 kixdns：先停掉这个账号的其他进程"
    fi
  fi
  if [[ ${remove_group} == true ]]; then
    groupdel kixdns 2>/dev/null || true
  fi
}

# 面板在 /etc/kixdns 里写的文件：panel.env 记下的配置，和面板写到一半留下的临时文件（.kixdns-panel- 加 6 个字母或数字，
# 见 panel-server 的 temporaries.rs）。参数：文件名，配置的文件名。
# The files the panel writes in /etc/kixdns: the config panel.env records, and the temporary files a write cut short leaves
# (.kixdns-panel- and 6 letters or digits, see panel-server's temporaries.rs). Arguments: the file name, the config's name.
panel_written_config_file() {
  [[ $1 == "$2" || $1 =~ ^\.kixdns-panel-[A-Za-z0-9]{6}$ ]]
}

# 删除面板数据时，删掉面板为 KixDNS 配置用的 /etc/kixdns：里面只有面板写的文件时整个删掉；还有别的（比如用户自己的 KixDNS
# 的配置）时只删面板写的，目录留着，交还 root。配置不在 /etc/kixdns 时什么也不删。
# Removing the panel data removes the /etc/kixdns the panel used for the KixDNS config: whole when it holds only files the
# panel wrote; with anything else in it (the config of the user's own KixDNS, say) only the panel's files go and the
# directory stays, handed back to root. With the config elsewhere, nothing is removed.
remove_panel_kixdns_config() {
  local config=${MANAGED_CONFIG:-${KIXDNS_CONFIG_DIRECTORY}/pipeline.json}
  local directory=${KIXDNS_CONFIG_DIRECTORY}
  local name
  local others=false
  [[ $(dirname -- "${config}") == "${directory}" && -d ${directory} && ! -L ${directory} ]] || return 0
  while IFS= read -r -d '' name; do
    if ! panel_written_config_file "${name}" "${config##*/}" || [[ -d ${directory}/${name} && ! -L ${directory}/${name} ]]; then
      others=true
    fi
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  if [[ ${others} == false ]]; then
    rm -rf -- "${directory}"
    return 0
  fi
  while IFS= read -r -d '' name; do
    if panel_written_config_file "${name}" "${config##*/}" && [[ ! -d ${directory}/${name} || -L ${directory}/${name} ]]; then
      rm -f -- "${directory:?}/${name}"
    fi
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  hand_back_directory "${directory}"
  printf '%s 里还有不是面板写的文件，目录留着，只删了面板写的配置。\n' "${directory}"
}

# 把一个面板用过、现在要交还的目录改归 root:root、权限 0755。面板自己的目录（面板配置目录、状态目录和它们下面的）不交还。
# Hands a directory the panel used back to root:root with mode 0755. The panel's own directories (its config and state
# directories and what lies below them) are not handed back.
hand_back_directory() {
  local directory=$1
  case ${directory} in
    "${PANEL_CONFIG_DIRECTORY}" | "${PANEL_CONFIG_DIRECTORY}"/* | "${PANEL_STATE_DIRECTORY}" | "${PANEL_STATE_DIRECTORY}"/*) return 0 ;;
  esac
  [[ -d ${directory} && ! -L ${directory} ]] || return 0
  chown root:root -- "${directory}"
  chmod 0755 -- "${directory}"
}

remove_panel_components() {
  stop_unit kixdns-panel-update.service
  wait_for_unit_inactive kixdns-panel-update.service
  stop_unit kixdns-panel.service
  wait_for_unit_inactive kixdns-panel.service
  stop_unit kixdns-panel-helper.service
  wait_for_unit_inactive kixdns-panel-helper.service
  rm -f -- /etc/systemd/system/kixdns-panel.service
  rm -f -- /etc/systemd/system/kixdns-panel-helper.service
  rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
  rm -f -- /usr/local/bin/kixdns-panel-server
  rm -f -- /usr/local/bin/kixdns-panel-uninstall
  rm -f -- /usr/local/libexec/kixdns-panel-helper
  rm -f -- /usr/local/libexec/kixdns-panel-one-click-install
  rm -f -- /usr/local/libexec/kixdns-panel-online-update
  rm -rf -- /run/kixdns-panel
  rm -rf -- /usr/share/kixdns-panel
  rm -rf -- /var/lib/kixdns-panel-update
}

remove_dead_kixdns_units() {
  local unit
  for unit in "${DEAD_PANEL_UNITS[@]}"; do
    stop_unit "${unit}"
    wait_for_unit_inactive "${unit}"
    rm -f -- "${SYSTEMD_UNIT_DIRECTORY}/${unit}"
  done
}

remove_managed_kixdns() {
  [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]] || return 0
  stop_unit "${KIXDNS_SERVICE_UNIT}"
  wait_for_unit_inactive "${KIXDNS_SERVICE_UNIT}"
  rm -f -- "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}"
  rm -f -- "${PANEL_STATE_DIRECTORY}/bin/kixdns" "${PANEL_STATE_DIRECTORY}/bin/.kixdns.new"
  rm -rf -- "${KIXDNS_RUNTIME_DIRECTORY}"
  # 迁移来的主机上，增强版用的是原配置的副本：随增强版一起删掉。原配置一直没动过，不用放回。
  # On a migrated host the enhanced KixDNS ran a copy of the original config: it goes with it. The original was never
  # touched, so there is nothing to put back.
  if managed_config_is_copy; then
    rm -rf -- "$(migrated_config_directory)"
  fi
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    if [[ -f ${EXTERNAL_BACKUP}/kixdns.service ]]; then
      install -o root -g root -m 0644 "${EXTERNAL_BACKUP}/kixdns.service" \
        "${SYSTEMD_UNIT_DIRECTORY}/${ORIGINAL_UNIT}"
    fi
    RESTORED_EXTERNAL=true
  else
    # 面板自己的 KixDNS 已经移除：保留的 panel.env 不能再说它归面板管，否则以后用户装上同名的 KixDNS，再运行卸载器会把它当成
    # 面板的停掉、删掉。它的配置和 kixdns 账号留着，记下来等删除面板数据时再删。
    # The panel's own KixDNS is gone: the kept panel.env must stop saying it is the panel's, or once the user installs a
    # KixDNS of the same name, running the uninstaller again stops and removes it as the panel's. Its config and the kixdns
    # account stay, recorded to go when the panel data is removed.
    mark_kixdns_unmanaged KIXDNS_REMOVED=true
  fi
}

remove_panel_state() {
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  local state=${PANEL_STATE_DIRECTORY}
  local kept_kixdns=false
  rm -f -- "${state}/github-token"
  # 保留的 KixDNS 就在状态目录里：只要还有 unit 指向它，就只删面板自己的数据，绝不整个删目录。
  # The kept KixDNS lives in the state directory: while any unit points at it, remove only the panel's data, never the whole directory.
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == keep ]] || managed_binary_in_use; then
    kept_kixdns=true
    rm -f -- "${state}/panel.db" "${state}/panel.db-shm" "${state}/panel.db-wal"
    rm -rf -- "${state}/versions" "${state}/geo" "${state}/external-backup"
    if [[ -f ${state}/bin/kixdns ]]; then
      chown kixdns:kixdns -- "${state}" "${state}/bin" "${state}/bin/kixdns"
      chmod 0750 -- "${state}" "${state}/bin"
      chmod 0755 -- "${state}/bin/kixdns"
    fi
  else
    rm -rf -- "${state}"
  fi
  remove_account kixdns-panel
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove && ${HAS_EXTERNAL_BACKUP} == false ]] ||
    [[ ${KIXDNS_MANAGED} == false && ${LEFT_REMOVED} == true ]]; then
    # 全新安装的主机，面板的 KixDNS 这次或上次卸载时移除了：安装器为配置建的 /etc/kixdns 和 kixdns 账号一起删。按 panel.env
    # 记下的配置路径认，配置不在那里就不删别的目录；没记路径的旧 panel.env 按安装器的默认位置。
    # A freshly installed host whose KixDNS this or an earlier uninstall removed: the /etc/kixdns the installer created for
    # the config and the kixdns account go too. It is recognised from the config path panel.env records, and no other
    # directory is removed; an old panel.env without the path means the installer's default location.
    remove_panel_kixdns_config
    remove_kixdns_account user group
  elif [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]]; then
    # 迁移来的主机这次恢复了原来的 KixDNS：只删迁移建的账号和组 / A migrated host whose original KixDNS this run restored:
    # only the account and group the migration created go
    remove_kixdns_account "user=${ORIGINAL_USER_CREATED}" "group=${ORIGINAL_GROUP_CREATED}"
  elif [[ ${KIXDNS_MANAGED} == false ]]; then
    # 上次卸载恢复了原来的 KixDNS、保留了 panel.env：它记下了迁移建的账号和组 / An earlier uninstall restored the original
    # KixDNS and kept panel.env, which records the account and group the migration created
    remove_kixdns_account "user=${LEFT_USER_CREATED}" "group=${LEFT_GROUP_CREATED}"
  fi
  # panel.env 是判断 KixDNS 归属的依据，最后才删：中途失败后重跑仍能认出面板管理的 KixDNS。
  # panel.env is how ownership is decided, so it goes last: a rerun after a mid-way failure still recognises the managed KixDNS.
  if [[ ${kept_kixdns} == true && -d "$(migrated_config_directory)" ]]; then
    # 保留的 KixDNS 还在用迁移副本：面板配置目录里只留下它。
    # The kept KixDNS still runs the migration copy: it is all that stays in the panel's config directory.
    find "${PANEL_CONFIG_DIRECTORY}" -mindepth 1 -maxdepth 1 ! -name kixdns ! -name panel.env -exec rm -rf -- {} +
    rm -f -- "${PANEL_ENV}"
  else
    rm -rf -- "${PANEL_CONFIG_DIRECTORY}"
  fi
}

state_value() {
  local file=$1
  local key=$2
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

# 与 install.sh 的 restore_resolved_stub 保持一致：卸载器单独分发，不能 source 安装器。
# Mirrors install.sh's restore_resolved_stub: the uninstaller ships on its own and cannot source the installer.
restore_resolved_stub() {
  local state=${RESOLVED_STATE}/install.env
  local kind
  local target
  [[ -f ${state} ]] || return 0
  kind="$(state_value "${state}" RESOLV_CONF_KIND || true)"
  target="$(state_value "${state}" RESOLV_CONF_TARGET || true)"
  if [[ ${KIXDNS_ACTION} == keep ]]; then
    # 保留的 KixDNS 还在用这个端口，恢复 resolved 的监听会让它下次启动失败。
    # The kept KixDNS still uses the port; restoring resolved's stub would break its next start.
    printf 'systemd-resolved 的本机监听保持关闭，保留的 KixDNS 继续使用 53 端口。以后要恢复：\n'
    printf '  sudo rm %s\n' "${RESOLVED_DROPIN}"
    if [[ ${kind} == symlink && -n ${target} ]]; then
      printf '  sudo ln -sfn %s %s\n' "${target}" "${RESOLV_CONF}"
    elif [[ ${kind} == file ]]; then
      # 现在的 resolv.conf 是指向上游列表的链接；不加 --remove-destination，cp 会顺着链接改写上游列表。
      # resolv.conf is now a link to the uplink list; without --remove-destination cp would write through it.
      printf '  sudo cp -a --remove-destination %s/resolv.conf %s\n' "${RESOLVED_STATE}" "${RESOLV_CONF}"
    fi
    printf '  sudo systemctl restart systemd-resolved\n'
    return 0
  fi
  rm -f -- "${RESOLVED_DROPIN}"
  if [[ $(state_value "${state}" RESOLVED_DROPIN_DIRECTORY_CREATED || true) == true ]]; then
    rmdir -- "$(dirname -- "${RESOLVED_DROPIN}")" 2>/dev/null || true
  fi
  case ${kind} in
    symlink) [[ -z ${target} ]] || ln -sfn -- "${target}" "${RESOLV_CONF}" ;;
    file)
      rm -f -- "${RESOLV_CONF}"
      cp -a -- "${RESOLVED_STATE}/resolv.conf" "${RESOLV_CONF}"
      ;;
  esac
  systemctl restart systemd-resolved.service || true
  rm -rf -- "${RESOLVED_STATE}"
  printf 'systemd-resolved 的本机监听与 %s 已恢复原样。\n' "${RESOLV_CONF}"
}

# 原来的 KixDNS 没能按迁移前的状态起来：备份和 panel.env 都还在，用同样的选项重新运行卸载就从头接着恢复。本地的卸载命令已经
# 随面板删掉，给出从网上运行的写法。
# The original KixDNS did not come back as it was before migration: the backup and panel.env are still there, and running
# the uninstall again with the same options carries the restore through. The local uninstall command is gone with the
# panel, so the way to run it from the web is given.
restore_incomplete() {
  # 给有意留下的备份标上「恢复没做完」和这次的选项：安装器看到它，就不会把它当成旧卸载器留下的过期备份、换成恢复到一半的
  # 样子，而是让人先把卸载做完（install.sh 的 refuse_unfinished_restore）。恢复做完时它随备份一起删掉。
  # Mark the backup left on purpose as "restore not finished", with this run's options: seeing it, the installer does not
  # take it for a stale backup an older uninstaller left and replace it with the half-restored state, but asks for the
  # uninstall to be finished first (refuse_unfinished_restore in install.sh). It goes with the backup once the restore is done.
  printf -- '--%s-config\n' "${CONFIG_ACTION}" > "${EXTERNAL_BACKUP}/restore-incomplete" 2>/dev/null || true
  fail "原来的 KixDNS（${ORIGINAL_UNIT}）没能按迁移前的状态恢复，备份还在 ${EXTERNAL_BACKUP}。
查明原因（journalctl -u ${ORIGINAL_UNIT} -n 50 --no-pager）后用同样的选项重新运行卸载，会接着恢复：
  curl -fsSL ${UNINSTALL_URL} | sudo bash -s -- --remove-kixdns --${CONFIG_ACTION}-config --yes"
}

# 原来的 KixDNS 放回去以后，这台主机上的 KixDNS 就不归面板管了：在保留的 panel.env 里记下，再运行卸载器不会把它当成面板的
# 去停、去删（备份已经用掉，靠它认不出来了）。用的是已移除的「仅安装面板」模式留下的同一个键：v3.1.1 起的卸载器都这样认它，
# 安装器重新安装时会删掉它。
# Once the original KixDNS is back, the KixDNS on this host is no longer the panel's: the kept panel.env records it, so
# running the uninstaller again does not stop or remove it as the panel's (the backup is used up and can no longer tell).
# It is the same key the removed panel-only mode left: uninstallers since v3.1.1 all read it this way, and the installer
# drops it on a reinstall.
# 参数是要一起记下的、等删除面板数据时再删的东西（KIXDNS_REMOVED=true、KIXDNS_USER_CREATED=true 之类，见 LEFT_REMOVED）。
# The arguments are what to record with it, left to go when the panel data is removed (KIXDNS_REMOVED=true,
# KIXDNS_USER_CREATED=true and so on, see LEFT_REMOVED).
mark_kixdns_unmanaged() {
  local temporary
  local extra
  [[ -f ${PANEL_ENV} ]] || return 0
  extra="$(printf '%s\n' "$@")"
  temporary="$(mktemp "${PANEL_CONFIG_DIRECTORY}/.panel.env.XXXXXX")"
  awk -v extra="${extra}" '
    !/^KIXDNS_(MANAGEMENT_ENABLED|REMOVED|USER_CREATED|GROUP_CREATED)=/ { print }
    END { print "KIXDNS_MANAGEMENT_ENABLED=false"; if (extra != "") print extra }
  ' "${PANEL_ENV}" > "${temporary}"
  chown --reference="${PANEL_ENV}" -- "${temporary}"
  chmod --reference="${PANEL_ENV}" -- "${temporary}"
  mv -fT -- "${temporary}" "${PANEL_ENV}"
}

port_accepts_connection() {
  local host=$1
  local port=$2
  # install.sh 不要求 curl；bash 自带的 /dev/tcp 足够确认端口在接受连接。
  # install.sh does not require curl; bash's own /dev/tcp is enough to see the port accepting connections.
  # shellcheck disable=SC2016 # $1/$2 由内层 bash 展开 / expanded by the inner bash
  timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "${host}" "${port}" 2>/dev/null
}

# 和 install.sh 的同名函数一字不差（scripts/test-uninstall-policy.sh 校对）：卸载器单独分发，不能 source 安装器。
# Identical to install.sh's function of the same name (checked by scripts/test-uninstall-policy.sh): the uninstaller ships
# on its own and cannot source the installer.
# Type=simple 的服务 fork 成功 systemctl 就返回，崩溃循环也会先显示 active。
# 这里要求主进程在比 RestartSec 更长的窗口里保持同一个 PID，必要时端口也已接受连接。
# systemctl returns as soon as a Type=simple service forks, and a crash loop briefly reads active.
# Require the same main PID for longer than RestartSec, and the port accepting connections when given.
wait_for_service_stable() {
  local unit=$1
  local host=${2:-}
  local port=${3:-}
  local tick
  local state
  local pid
  local stable_pid=""
  local stable_ticks=0
  for ((tick = 0; tick < SERVICE_WAIT_SECONDS * 2; tick++)); do
    state="$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
    pid="$(systemctl show --property=MainPID --value "${unit}" 2>/dev/null || true)"
    if [[ ${state} == active && ${pid} =~ ^[1-9][0-9]*$ ]]; then
      if [[ ${pid} == "${stable_pid}" ]]; then
        stable_ticks=$((stable_ticks + 1))
      else
        stable_pid=${pid}
        stable_ticks=0
      fi
      if ((stable_ticks >= SERVICE_STABLE_SECONDS * 2)) &&
        { [[ -z ${port} ]] || port_accepts_connection "${host}" "${port}"; }; then
        return 0
      fi
    else
      stable_pid=""
      stable_ticks=0
    fi
    sleep 0.5
  done
  return 1
}

restore_external_state() {
  [[ ${RESTORED_EXTERNAL} == true ]] || return 0
  if [[ ${ORIGINAL_ENABLED} == true ]]; then
    systemctl enable "${ORIGINAL_UNIT}" --quiet || restore_incomplete
  else
    systemctl disable "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  if [[ ${ORIGINAL_ACTIVE} == true ]]; then
    systemctl start "${ORIGINAL_UNIT}" || restore_incomplete
    # start 在 Type=simple 的服务 fork 以后就返回 0：起来又崩溃的不算恢复。
    # start returns 0 once a Type=simple service forks: one that comes up and crashes is not restored.
    wait_for_service_stable "${ORIGINAL_UNIT}" || restore_incomplete
  else
    systemctl stop "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  # 恢复做完才用掉备份：先记下 KixDNS 已不归面板管，再删备份。中途失败时备份还在，重新运行能接着恢复；以后再迁移，安装器按那时
  # 主机上的 KixDNS 重新备份，不会沿用这份旧的。
  # The backup is used up only once the restore is done: first record that the KixDNS is no longer the panel's, then remove
  # the backup. A failure part way leaves the backup, so a rerun carries the restore through; a later migration backs up
  # the KixDNS the host has then instead of keeping this old one.
  # 迁移建的 kixdns 账号和组随备份记录一起带进 panel.env，以后删除面板数据时再删 / The record of the kixdns account and group
  # the migration created moves into panel.env with it, so a later removal of the panel data removes them then
  mark_kixdns_unmanaged "KIXDNS_USER_CREATED=${ORIGINAL_USER_CREATED}" "KIXDNS_GROUP_CREATED=${ORIGINAL_GROUP_CREATED}"
  rm -rf -- "${EXTERNAL_BACKUP}"
  printf '原来的 KixDNS 已恢复，运行状态和迁移前一样。\n'
  if [[ -n ${ORIGINAL_CONFIG} && ${ORIGINAL_CONFIG} == "${MANAGED_CONFIG}" ]]; then
    # 旧版安装器原地迁移的主机：面板改的就是原配置，迁移前的内容没有留底，不能说成恢复了。
    # A host an older installer migrated in place: the panel edited the original config itself and the pre-migration
    # content was never kept, so it must not read as restored.
    printf '它用的配置 %s 是面板最后保存的内容：旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底。\n' "${ORIGINAL_CONFIG}"
  elif managed_config_is_copy && [[ -f ${ORIGINAL_CONFIG} ]]; then
    printf '它用的是迁移前的配置 %s，面板改过的副本已删除。\n' "${ORIGINAL_CONFIG}"
  fi
}

print_result() {
  printf 'KixDNS 面板已卸载。\n'
  if [[ ${#DEAD_PANEL_UNITS[@]} -gt 0 || ${#DEAD_FOREIGN_UNITS[@]} -gt 0 ]]; then
    printf '面板目录里的 KixDNS 程序已不存在，没有可保留的 KixDNS。\n'
  elif [[ ${KIXDNS_ACTION} == keep ]]; then
    printf 'KixDNS 已保留并继续独立运行。\n'
  elif [[ ${RESTORED_EXTERNAL} == false ]]; then
    printf '面板管理的 KixDNS 已移除。\n'
  fi
  if [[ ${CONFIG_ACTION} == keep ]]; then
    printf '面板配置与运行数据已保留，可供以后重新安装。\n'
  else
    printf '面板配置与运行数据已删除。\n'
  fi
}

main() {
  parse_arguments "$@"
  [[ ${EUID} -eq 0 ]] || fail "要用 root 权限运行"
  command -v systemctl >/dev/null 2>&1 || fail "系统未安装 systemd"
  run_uninstall
}

# 权限检查之后的全部步骤；拆出来是为了策略测试能在临时目录里把整个流程连跑两次。
# Every step after the privilege checks; split out so the policy test can run the whole flow twice in a temporary tree.
run_uninstall() {
  load_settings
  validate_non_interactive
  choose_kixdns_action
  choose_config_action
  confirm_uninstall
  if [[ ${HAS_EXTERNAL_BACKUP} == true && ${KIXDNS_ACTION} == remove ]]; then
    load_external_backup
  fi
  validate_removal_targets
  remove_panel_components
  remove_dead_kixdns_units
  remove_managed_kixdns
  restore_resolved_stub
  systemctl daemon-reload
  # 先把原来的 KixDNS 恢复完，再删面板数据：恢复中途失败时 panel.env 和备份都还在，重新运行能认出、接着恢复。
  # Finish restoring the original KixDNS before the panel data goes: a restore failing part way leaves panel.env and the
  # backup, so a rerun recognises it and carries on.
  restore_external_state
  remove_panel_state
  print_result
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
