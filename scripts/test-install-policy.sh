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

if (parse_arguments --unknown-option) 2>/dev/null; then
  printf '断言失败：未知安装参数不应被接受\n' >&2
  exit 1
fi

printf '安装策略检查通过。\n'
