#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2034
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

help="$(bash "${UNINSTALLER}" --help)"
[[ ${help} == *"--keep-kixdns"* ]]
[[ ${help} == *"--remove-config"* ]]
[[ ${help} == *"--purge"* ]]

source "${UNINSTALLER}"

PANEL_ENV="${PACKAGE_ROOT}/.missing-panel.env"
EXTERNAL_BACKUP="${PACKAGE_ROOT}/.missing-external-backup"
KIXDNS_MANAGEMENT_ENABLED=false
KIXDNS_SERVICE_UNIT=kixdns.service
HAS_EXTERNAL_BACKUP=false
load_settings
assert_equals "${HAS_EXTERNAL_BACKUP}" false "没有迁移备份时设置加载也应成功"

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
KIXDNS_MANAGEMENT_ENABLED=false
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

KIXDNS_MANAGEMENT_ENABLED=false
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

one_click_help="$(bash "${PACKAGE_ROOT}/scripts/one-click-install.sh" --help)"
[[ ${one_click_help} == *"--version"* ]]
[[ -f "${PACKAGE_ROOT}/scripts/panel-online-update.sh" ]]

printf '卸载策略检查通过。\n'
