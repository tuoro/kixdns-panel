#!/usr/bin/env bash
set -Eeuo pipefail

PANEL_ENV=/etc/kixdns-panel/panel.env
EXTERNAL_BACKUP=/var/lib/kixdns-panel/external-backup
KIXDNS_MANAGEMENT_ENABLED=false
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

fail() {
  printf '卸载失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：sudo kixdns-panel-uninstall [选项]

默认通过交互终端依次询问 KixDNS 和配置数据的处理方式。

  --keep-kixdns     仅卸载面板，保留当前 KixDNS
  --remove-kixdns   同时移除面板管理的 KixDNS；外部 KixDNS 始终保留
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

load_settings() {
  local value
  if [[ -f ${PANEL_ENV} ]]; then
    value="$(environment_value KIXDNS_MANAGEMENT_ENABLED || true)"
    [[ -z ${value} ]] || KIXDNS_MANAGEMENT_ENABLED=${value}
    value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
    [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
  fi
  [[ ${KIXDNS_MANAGEMENT_ENABLED} =~ ^(true|false)$ ]] ||
    fail "panel.env 中的 KixDNS 管理模式无效"
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9_.@-]{1,120}\.service$ ]] ||
    fail "panel.env 中的 KixDNS unit 名称无效"
  if [[ -f ${EXTERNAL_BACKUP}/install.env ]]; then
    HAS_EXTERNAL_BACKUP=true
  fi
}

open_terminal() {
  exec 3<>/dev/tty 2>/dev/null ||
    fail "当前没有交互终端；请明确指定 KixDNS 与配置处理选项，并使用 --yes"
}

close_terminal() {
  exec 3>&- 3<&-
}

choose_kixdns_action() {
  local choice=""
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} != true ]]; then
    if [[ ${KIXDNS_ACTION} == remove ]]; then
      printf '当前使用外部 KixDNS；为防止误删，卸载器只移除面板并保留外部 KixDNS。\n'
    fi
    KIXDNS_ACTION=keep
    return
  fi
  [[ ${KIXDNS_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n请选择 KixDNS 的处理方式：\n' >&3
  printf '  1. 仅卸载面板，保留当前 KixDNS\n' >&3
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    printf '  2. 移除 KixDNS Enhanced，并恢复迁移前的外部 KixDNS\n' >&3
  else
    printf '  2. 同时移除面板管理的 KixDNS\n' >&3
  fi
  printf '  3. 取消卸载（默认）\n' >&3
  printf '请选择 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) KIXDNS_ACTION=keep ;;
    2) KIXDNS_ACTION=remove ;;
    *) fail "已取消卸载" ;;
  esac
}

choose_config_action() {
  local choice=""
  [[ ${CONFIG_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n请选择配置与运行数据的处理方式：\n' >&3
  printf '  1. 保留配置、数据库、版本库和 Geo 数据\n' >&3
  printf '  2. 删除全部面板配置与运行数据\n' >&3
  printf '  3. 取消卸载（默认）\n' >&3
  printf '请选择 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) CONFIG_ACTION=keep ;;
    2) CONFIG_ACTION=remove ;;
    *) fail "已取消卸载" ;;
  esac
}

confirm_uninstall() {
  local answer=""
  [[ ${ASSUME_YES} == true ]] && return
  open_terminal
  printf '\n卸载计划：\n' >&3
  if [[ ${KIXDNS_ACTION} == keep ]]; then
    printf '  - 保留 KixDNS\n' >&3
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
  [[ ${answer} =~ ^([yY]|[yY][eE][sS])$ ]] || fail "已取消卸载"
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
  [[ ${ORIGINAL_UNIT} =~ ^[A-Za-z0-9_.@-]{1,120}\.service$ ]] ||
    fail "外部 KixDNS 备份中的 unit 名称无效"
  [[ ${ORIGINAL_ENABLED} =~ ^(true|false)$ && ${ORIGINAL_ACTIVE} =~ ^(true|false)$ ]] ||
    fail "外部 KixDNS 备份中的服务状态无效"
}

validate_removal_targets() {
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  [[ ! -L /etc/kixdns-panel && ! -L /var/lib/kixdns-panel ]] ||
    fail "配置目录不能是符号链接"
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true && ${KIXDNS_ACTION} == keep ]]; then
    [[ -f /var/lib/kixdns-panel/bin/kixdns && ! -L /var/lib/kixdns-panel/bin/kixdns ]] ||
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
    fail "无法删除账号 ${account}，请先停止该账号的其他进程"
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

remove_managed_kixdns() {
  [[ ${KIXDNS_MANAGEMENT_ENABLED} == true && ${KIXDNS_ACTION} == remove ]] || return 0
  stop_unit "${KIXDNS_SERVICE_UNIT}"
  wait_for_unit_inactive "${KIXDNS_SERVICE_UNIT}"
  rm -f -- "/etc/systemd/system/${KIXDNS_SERVICE_UNIT}"
  rm -f -- /var/lib/kixdns-panel/bin/kixdns /var/lib/kixdns-panel/bin/.kixdns.new
  rm -rf -- /run/kixdns
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    if [[ -f ${EXTERNAL_BACKUP}/kixdns.service ]]; then
      install -o root -g root -m 0644 "${EXTERNAL_BACKUP}/kixdns.service" \
        "/etc/systemd/system/${ORIGINAL_UNIT}"
    fi
    RESTORED_EXTERNAL=true
  fi
}

remove_panel_state() {
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  rm -rf -- /etc/kixdns-panel
  rm -f -- /var/lib/kixdns-panel/github-token
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true && ${KIXDNS_ACTION} == keep ]]; then
    rm -f -- /var/lib/kixdns-panel/panel.db /var/lib/kixdns-panel/panel.db-shm \
      /var/lib/kixdns-panel/panel.db-wal
    rm -rf -- /var/lib/kixdns-panel/versions /var/lib/kixdns-panel/geo \
      /var/lib/kixdns-panel/external-backup
    chown kixdns:kixdns -- /var/lib/kixdns-panel /var/lib/kixdns-panel/bin \
      /var/lib/kixdns-panel/bin/kixdns
    chmod 0750 -- /var/lib/kixdns-panel /var/lib/kixdns-panel/bin
    chmod 0755 -- /var/lib/kixdns-panel/bin/kixdns
  else
    rm -rf -- /var/lib/kixdns-panel
  fi
  remove_account kixdns-panel
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true && ${KIXDNS_ACTION} == remove && \
    ${HAS_EXTERNAL_BACKUP} == false ]]; then
    rm -rf -- /etc/kixdns
    remove_account kixdns
    groupdel kixdns 2>/dev/null || true
  fi
}

restore_external_state() {
  [[ ${RESTORED_EXTERNAL} == true ]] || return 0
  if [[ ${ORIGINAL_ENABLED} == true ]]; then
    systemctl enable "${ORIGINAL_UNIT}"
  else
    systemctl disable "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  if [[ ${ORIGINAL_ACTIVE} == true ]]; then
    systemctl start "${ORIGINAL_UNIT}"
  else
    systemctl stop "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  printf '迁移前的外部 KixDNS 服务定义与运行状态已恢复。\n'
}

print_result() {
  printf 'KixDNS Panel 已卸载。\n'
  if [[ ${KIXDNS_ACTION} == keep ]]; then
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
  [[ ${EUID} -eq 0 ]] || fail "请使用 root 权限运行"
  command -v systemctl >/dev/null 2>&1 || fail "系统未安装 systemd"
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
  remove_managed_kixdns
  remove_panel_state
  systemctl daemon-reload
  restore_external_state
  print_result
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
