#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2034
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"

assert_equals() {
  local actual=$1
  local expected=$2
  local message=$3
  [[ ${actual} == "${expected}" ]] || {
    printf '断言失败：%s（期望 %s，实际 %s）\n' "${message}" "${expected}" "${actual}" >&2
    exit 1
  }
}

help="$(bash "${INSTALLER}" --help)"
[[ ${help} == *"--keep-existing"* ]]
[[ ${help} == *"--replace-existing"* ]]

source "${INSTALLER}"
source "${PACKAGE_ROOT}/scripts/panel-online-update.sh"

INSTALL_MODE="auto"
EXISTING_KIXDNS=false
choose_install_mode
assert_equals "${INSTALL_MODE}" "managed" "新主机应安装面板管理的增强版"

INSTALL_MODE="external"
EXISTING_KIXDNS=true
choose_install_mode
assert_equals "${INSTALL_MODE}" "external" "显式保留模式不能被脚本改写"

INSTALL_MODE="auto"
parse_arguments --replace-existing --kixdns-unit kixdns@edge.service
assert_equals "${INSTALL_MODE}" "managed" "显式迁移参数应启用受管模式"
assert_equals "${KIXDNS_SERVICE_UNIT}" "kixdns@edge.service" "自定义 unit 应被保留"

if (
  INSTALL_MODE="auto"
  EXISTING_KIXDNS=true
  choose_install_mode
) 2>/dev/null; then
  printf '断言失败：非交互环境的既有安装不应默认替换\n' >&2
  exit 1
fi

KIXDNS_SERVICE_UNIT="kixdns@primary.service"
validate_unit

if (
  INSTALL_MODE="managed"
  KIXDNS_CONFIG_PATH=/pipeline.json
  KIXDNS_BINARY_PATH=/var/lib/kixdns-panel/bin/kixdns
  KIXDNS_CONTROL_SOCKET=/run/kixdns/admin.sock
  validate_install_mode
) 2>/dev/null; then
  printf '断言失败：受管配置不能直接放在根目录\n' >&2
  exit 1
fi

environment_source="$(mktemp)"
environment_output="$(mktemp)"
trap 'rm -f -- "${environment_source}" "${environment_output}"' EXIT
printf '%s\n' \
  'KIXDNS_PANEL_BIND=127.0.0.1:5738' \
  'KIXDNS_PANEL_INSTALLED_RELEASE=' \
  'KIXDNS_UPDATE_RELEASE_WORKFLOW=build-kixdns-release.yml' > "${environment_source}"
KIXDNS_CONFIG_PATH=/etc/kixdns/pipeline.json
KIXDNS_BINARY_PATH=/var/lib/kixdns-panel/bin/kixdns
KIXDNS_CONTROL_SOCKET=/run/kixdns/admin.sock
KIXDNS_SERVICE_UNIT=kixdns.service
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' true 42
if grep -q '^KIXDNS_PANEL_INSTALLED_RELEASE=' "${environment_output}"; then
  printf '断言失败：Action 包不应输出空 Release 环境变量\n' >&2
  exit 1
fi
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit v1.0.0 true 42
release_value="$(awk -F= '$1 == "KIXDNS_PANEL_INSTALLED_RELEASE" { print $2 }' "${environment_output}")"
assert_equals "${release_value}" "v1.0.0" "正式包应保留 Release 标签"
helper_socket_value="$(awk -F= '$1 == "KIXDNS_SERVICE_HELPER_SOCKET" { print $2 }' "${environment_output}")"
assert_equals "${helper_socket_value}" "/run/kixdns-panel/control.sock" "面板环境应写入受限 helper Socket"
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "0.0.0.0:5738" "旧版默认监听地址应迁移为内网可访问"
source_id_value="$(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${environment_output}")"
assert_equals "${source_id_value}" "42" "面板环境应记录完整包 Artifact ID"

printf '%s\n' 'KIXDNS_PANEL_BIND=192.168.10.5:6754' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' true 42
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "192.168.10.5:6754" "用户自定义监听地址不应被升级覆盖"

is_private_ipv4 10.0.0.8
is_private_ipv4 172.31.255.254
is_private_ipv4 192.168.1.20
is_private_ipv4 100.127.255.254
if is_private_ipv4 8.8.8.8 || is_private_ipv4 172.32.0.1 || is_private_ipv4 999.1.1.1; then
  printf '断言失败：公网或无效地址不应作为内网访问地址\n' >&2
  exit 1
fi
assert_equals "$(panel_access_url '192.168.10.5:6754')" "http://192.168.10.5:6754" \
  "固定监听地址应生成对应访问链接"

SYSTEMCTL_CALLS=""
# 该测试桩由被测安装函数间接调用。
# shellcheck disable=SC2317,SC2329
systemctl() {
  case "$1" in
    is-active | is-enabled) return 1 ;;
    *) SYSTEMCTL_CALLS+="$*"$'\n' ;;
  esac
}
INSTALL_MODE=managed
EXISTING_PANEL=false
PRESERVE_KIXDNS_STATE=false
restore_managed_service_state
[[ ${SYSTEMCTL_CALLS} == *"disable --now kixdns.service"* ]] || {
  printf '断言失败：首次安装必须保持 KixDNS 停止且禁用开机启动\n' >&2
  exit 1
}
SYSTEMCTL_CALLS=""
PRESERVE_KIXDNS_STATE=true
KIXDNS_WAS_ACTIVE=true
KIXDNS_WAS_ENABLED=true
restore_managed_service_state
[[ ${SYSTEMCTL_CALLS} == *"enable kixdns.service"* && ${SYSTEMCTL_CALLS} == *"restart kixdns.service"* ]] || {
  printf '断言失败：覆盖安装必须恢复运行且启用的 KixDNS\n' >&2
  exit 1
}
SYSTEMCTL_CALLS=""
KIXDNS_WAS_ACTIVE=false
KIXDNS_WAS_ENABLED=false
restore_managed_service_state
[[ ${SYSTEMCTL_CALLS} == *"disable kixdns.service"* && ${SYSTEMCTL_CALLS} == *"stop kixdns.service"* ]] || {
  printf '断言失败：覆盖安装必须保持停止且禁用的 KixDNS\n' >&2
  exit 1
}
unset -f systemctl

if [[ $(uname -s) == Linux ]]; then
  trusted_test_file="$(mktemp)"
  chmod 0755 "${trusted_test_file}"
  trusted_root_executable "${trusted_test_file}"
  chmod 0775 "${trusted_test_file}"
  if trusted_root_executable "${trusted_test_file}"; then
    printf '断言失败：在线更新器不应信任组可写的 root 脚本\n' >&2
    exit 1
  fi
  rm -f -- "${trusted_test_file}"
fi

if (parse_arguments --unknown-option) 2>/dev/null; then
  printf '断言失败：未知安装参数不应被接受\n' >&2
  exit 1
fi

printf '安装策略检查通过。\n'
