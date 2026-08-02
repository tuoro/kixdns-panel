#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PANEL_USER="kixdns-panel"
KIXDNS_USER="kixdns"
KIXDNS_GROUP="kixdns"
BACKUP_ROOT=""
INSTALL_MODE="auto"
KIXDNS_SERVICE_UNIT="kixdns.service"
KIXDNS_CONFIG_PATH="/etc/kixdns/pipeline.json"
KIXDNS_BINARY_PATH="/var/lib/kixdns-panel/bin/kixdns"
EXISTING_KIXDNS_BINARY_PATH=""
KIXDNS_CONTROL_SOCKET="/run/kixdns/admin.sock"
KIXDNS_SERVICE_HELPER_SOCKET="/run/kixdns-panel/control.sock"
EXISTING_PANEL=false
EXISTING_KIXDNS=false
EXTERNAL_BACKUP=/var/lib/kixdns-panel/external-backup
CREATED_EXTERNAL_BACKUP=false
PRESERVE_KIXDNS_STATE=false
KIXDNS_WAS_ACTIVE=false
KIXDNS_WAS_ENABLED=false
PANEL_ONLY_UPDATE=false

usage() {
  cat <<'EOF'
用法：sudo bash scripts/install.sh [选项]

  --keep-existing       保留既有 KixDNS，仅安装受限模式面板
  --replace-existing    明确迁移到面板管理的 KixDNS Enhanced
  --kixdns-unit UNIT    既有 systemd unit，默认 kixdns.service
  --kixdns-config PATH  既有配置路径
  --kixdns-binary PATH  既有二进制路径（保留模式必需，可自动检测）
  --control-socket PATH 既有增强控制 Socket；原版可保留默认值
  -h, --help            显示帮助

检测到非面板管理的既有 KixDNS 时，交互终端会要求选择。无人值守安装必须
显式使用 --keep-existing 或 --replace-existing，脚本不会默认替换现有服务。
EOF
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-existing) INSTALL_MODE="external" ;;
      --replace-existing) INSTALL_MODE="managed" ;;
      --kixdns-unit)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_SERVICE_UNIT=$2
        shift
        ;;
      --kixdns-config)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONFIG_PATH=$2
        shift
        ;;
      --kixdns-binary)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_BINARY_PATH=$2
        shift
        ;;
      --control-socket)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONTROL_SOCKET=$2
        shift
        ;;
      --panel-only-update)
        PANEL_ONLY_UPDATE=true
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "未知参数：$1" ;;
    esac
    shift
  done
}

validate_unit() {
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9_.@-]{1,120}\.service$ ]] ||
    fail "KixDNS systemd unit 名称无效"
}

validate_absolute_path() {
  local label=$1
  local path=$2
  [[ ${path} == /* && ${#path} -le 4096 && ! ${path} =~ [[:space:]] ]] ||
    fail "${label}必须是不含空白的绝对路径"
}

environment_value() {
  local key=$1
  local file=/etc/kixdns-panel/panel.env
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

external_backup_value() {
  local key=$1
  local file=${EXTERNAL_BACKUP}/install.env
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

load_existing_panel_settings() {
  local value
  [[ -x /usr/local/bin/kixdns-panel-server && -f /etc/kixdns-panel/panel.env ]] || return 0
  EXISTING_PANEL=true
  value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
  value="$(environment_value KIXDNS_CONFIG || true)"
  [[ -z ${value} ]] || KIXDNS_CONFIG_PATH=${value}
  value="$(environment_value KIXDNS_BINARY || true)"
  [[ -z ${value} ]] || KIXDNS_BINARY_PATH=${value}
  value="$(environment_value KIXDNS_CONTROL_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_CONTROL_SOCKET=${value}
  value="$(environment_value KIXDNS_SERVICE_HELPER_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_HELPER_SOCKET=${value}
  if [[ ${INSTALL_MODE} == "auto" ]]; then
    value="$(environment_value KIXDNS_MANAGEMENT_ENABLED || true)"
    [[ ${value} == "false" ]] && INSTALL_MODE="external" || INSTALL_MODE="managed"
  fi
}

validate_panel_only_update() {
  [[ ${PANEL_ONLY_UPDATE} == true ]] || return 0
  [[ ${EXISTING_PANEL} == true ]] || fail "面板在线更新仅适用于已安装的 KixDNS Panel"
  [[ ${INSTALL_MODE} != "auto" ]] || fail "无法确认现有面板的 KixDNS 管理模式"
}

detect_service_argument() {
  local name=$1
  local value
  local exec_start
  exec_start="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${exec_start} =~ --${name}=([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ ${exec_start} =~ --${name}[[:space:]]+([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

detect_existing_kixdns() {
  local detected
  if systemctl cat "${KIXDNS_SERVICE_UNIT}" >/dev/null 2>&1 || command -v kixdns >/dev/null 2>&1 ||
    [[ -e /usr/local/bin/kixdns || -e /var/lib/kixdns-panel/bin/kixdns ]]; then
    EXISTING_KIXDNS=true
  fi
  [[ ${EXISTING_PANEL} == true ]] && return
  detected="$(detect_service_argument config || true)"
  [[ -z ${detected} ]] || KIXDNS_CONFIG_PATH=${detected}
  detected="$(detect_service_argument admin-socket || true)"
  [[ -z ${detected} ]] || KIXDNS_CONTROL_SOCKET=${detected}
  detected="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${detected} =~ path=([^[:space:];]+) ]]; then
    KIXDNS_BINARY_PATH=${BASH_REMATCH[1]}
  elif command -v kixdns >/dev/null 2>&1; then
    KIXDNS_BINARY_PATH="$(command -v kixdns)"
  elif [[ -x /usr/local/bin/kixdns ]]; then
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
  fi
}

choose_install_mode() {
  local choice=""
  if [[ ${INSTALL_MODE} == "auto" && ${EXISTING_KIXDNS} == false ]]; then
    INSTALL_MODE="managed"
    return
  fi
  [[ ${INSTALL_MODE} == "auto" ]] || return 0
  if ! exec 3<>/dev/tty 2>/dev/null; then
    fail "检测到既有 KixDNS；无人值守安装必须指定 --keep-existing 或 --replace-existing"
  fi
  printf '\n检测到现有 KixDNS，请选择安装方式：\n' >&3
  printf '  1. 保留现有 KixDNS，仅安装面板\n' >&3
  printf '  2. 安装 KixDNS Enhanced 并由面板管理\n' >&3
  printf '  3. 取消安装（默认）\n' >&3
  printf '请选择 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  exec 3>&- 3<&-
  case ${choice} in
    1) INSTALL_MODE="external" ;;
    2) INSTALL_MODE="managed" ;;
    *) fail "已取消安装，现有 KixDNS 未作修改" ;;
  esac
}

validate_install_mode() {
  local config_parent
  validate_unit
  validate_absolute_path "KixDNS 配置路径" "${KIXDNS_CONFIG_PATH}"
  validate_absolute_path "KixDNS 二进制路径" "${KIXDNS_BINARY_PATH}"
  validate_absolute_path "KixDNS 控制 Socket 路径" "${KIXDNS_CONTROL_SOCKET}"
  validate_absolute_path "面板服务控制 helper Socket" "${KIXDNS_SERVICE_HELPER_SOCKET}"
  [[ $(dirname -- "${KIXDNS_SERVICE_HELPER_SOCKET}") == /run/kixdns-panel ]] ||
    fail "面板服务控制 helper Socket 必须位于 /run/kixdns-panel"
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  [[ ${config_parent} != / && ! -L ${config_parent} ]] ||
    fail "KixDNS 配置不能直接位于根目录或符号链接目录"
  if [[ ${INSTALL_MODE} == "external" ]]; then
    [[ ${EXISTING_KIXDNS} == true ]] || fail "未检测到可保留的既有 KixDNS"
    [[ -f ${KIXDNS_CONFIG_PATH} ]] || fail "找不到既有 KixDNS 配置：${KIXDNS_CONFIG_PATH}"
    [[ -x ${KIXDNS_BINARY_PATH} ]] || fail "找不到既有 KixDNS 二进制：${KIXDNS_BINARY_PATH}"
    systemctl cat "${KIXDNS_SERVICE_UNIT}" >/dev/null 2>&1 ||
      fail "找不到既有 systemd unit：${KIXDNS_SERVICE_UNIT}"
  else
    if [[ -e ${KIXDNS_CONFIG_PATH} || -L ${KIXDNS_CONFIG_PATH} ]]; then
      [[ -f ${KIXDNS_CONFIG_PATH} && ! -L ${KIXDNS_CONFIG_PATH} ]] ||
        fail "受管 KixDNS 配置必须是普通文件"
    fi
    EXISTING_KIXDNS_BINARY_PATH=${KIXDNS_BINARY_PATH}
    KIXDNS_BINARY_PATH=/var/lib/kixdns-panel/bin/kixdns
  fi
}

capture_managed_service_state() {
  [[ ${PANEL_ONLY_UPDATE} == false ]] || return 0
  [[ ${INSTALL_MODE} == "managed" && ${EXISTING_PANEL} == true ]] || return 0
  PRESERVE_KIXDNS_STATE=true
  systemctl is-active --quiet "${KIXDNS_SERVICE_UNIT}" && KIXDNS_WAS_ACTIVE=true
  systemctl is-enabled --quiet "${KIXDNS_SERVICE_UNIT}" && KIXDNS_WAS_ENABLED=true
}

restore_managed_service_state() {
  [[ ${INSTALL_MODE} == "managed" ]] || return 0
  if [[ ${PRESERVE_KIXDNS_STATE} == false ]]; then
    systemctl disable --now "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
    return 0
  fi
  if [[ ${KIXDNS_WAS_ENABLED} == true ]]; then
    systemctl enable "${KIXDNS_SERVICE_UNIT}"
  else
    systemctl disable "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
  if [[ ${KIXDNS_WAS_ACTIVE} == true ]]; then
    systemctl restart "${KIXDNS_SERVICE_UNIT}"
  else
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
}

fail() {
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || fail "请使用 root 权限运行"
}

require_file() {
  [[ -f "$1" ]] || fail "安装包缺少 $1"
}

detect_artifact() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s\n' 'kixdns-enhanced-linux-x86_64' ;;
    aarch64 | arm64) printf '%s\n' 'kixdns-enhanced-linux-arm64' ;;
    *) fail "仅支持 Linux x86_64 和 ARM64" ;;
  esac
}

is_private_ipv4() {
  local address=$1
  awk -F. '
    NF != 4 { exit 1 }
    {
      for (part = 1; part <= 4; part++) {
        if ($part !~ /^[0-9]+$/ || $part < 0 || $part > 255) exit 1
      }
      if ($1 == 10 ||
          ($1 == 172 && $2 >= 16 && $2 <= 31) ||
          ($1 == 192 && $2 == 168) ||
          ($1 == 100 && $2 >= 64 && $2 <= 127)) exit 0
      exit 1
    }
  ' <<< "${address}"
}

detect_private_ipv4() {
  local address
  if command -v ip >/dev/null 2>&1; then
    address="$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (field = 1; field <= NF; field++) if ($field == "src") { print $(field + 1); exit } }')"
    if [[ -n ${address} ]] && is_private_ipv4 "${address}"; then
      printf '%s\n' "${address}"
      return 0
    fi
    while IFS= read -r address; do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done < <(ip -o -4 address show scope global 2>/dev/null | awk '{ split($4, parts, "/"); print parts[1] }')
  fi
  if command -v hostname >/dev/null 2>&1; then
    for address in $(hostname -I 2>/dev/null || true); do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done
  fi
  return 1
}

panel_access_url() {
  local bind=$1
  local host
  local port=${bind##*:}
  [[ ${port} =~ ^[0-9]{1,5}$ ]] || port=5738
  case ${bind} in
    0.0.0.0:* | \[::\]:*) host="$(detect_private_ipv4 || true)" ;;
    \[*\]:*) host=${bind%:*} ;;
    *:*) host=${bind%:*} ;;
    *) host="" ;;
  esac
  if [[ -n ${host} ]]; then
    printf 'http://%s:%s\n' "${host}" "${port}"
  else
    printf 'http://<本机内网IP>:%s\n' "${port}"
  fi
}

create_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || groupadd --system "${KIXDNS_GROUP}"
  if ! id -u "${KIXDNS_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${KIXDNS_USER}"
  fi
  if id -u "${PANEL_USER}" >/dev/null 2>&1; then
    usermod --append --groups "${KIXDNS_GROUP}" "${PANEL_USER}"
  else
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /var/lib/kixdns-panel --shell /usr/sbin/nologin "${PANEL_USER}"
  fi
  if getent group systemd-journal >/dev/null; then
    usermod --append --groups systemd-journal "${PANEL_USER}"
  fi
}

backup_path() {
  local source=$1
  local key=$2
  if [[ -e "${source}" || -L "${source}" ]]; then
    cp -a -- "${source}" "${BACKUP_ROOT}/${key}"
  else
    : > "${BACKUP_ROOT}/${key}.missing"
  fi
}

restore_path() {
  local target=$1
  local key=$2
  rm -rf -- "${target}"
  if [[ -e "${BACKUP_ROOT}/${key}" || -L "${BACKUP_ROOT}/${key}" ]]; then
    install -d -- "$(dirname -- "${target}")"
    cp -a -- "${BACKUP_ROOT}/${key}" "${target}"
  fi
}

rollback_install() {
  local status=$1
  trap - ERR
  set +e
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    restore_path /var/lib/kixdns-panel/bin/kixdns kixdns
    restore_path /var/lib/kixdns-panel/bundle bundled-metadata
    restore_path "/etc/systemd/system/${KIXDNS_SERVICE_UNIT}" kixdns-service
    restore_managed_config
  fi
  restore_path /usr/local/bin/kixdns-panel-server panel-server
  restore_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  restore_path /usr/local/libexec/kixdns-panel-one-click-install panel-one-click-install
  restore_path /usr/local/libexec/kixdns-panel-online-update panel-online-update
  restore_path /usr/share/kixdns-panel/web web
  restore_path /etc/systemd/system/kixdns-panel.service panel-service
  restore_path /usr/local/libexec/kixdns-panel-helper panel-helper
  restore_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  restore_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  restore_path /etc/kixdns-panel/panel.env panel-env
  systemctl daemon-reload
  systemctl restart kixdns-panel-helper.service 2>/dev/null || true
  if [[ ${CREATED_EXTERNAL_BACKUP} == true ]]; then
    if [[ $(external_backup_value KIXDNS_WAS_ENABLED || true) == true ]]; then
      systemctl enable "${KIXDNS_SERVICE_UNIT}"
    else
      systemctl disable "${KIXDNS_SERVICE_UNIT}"
    fi
    if [[ $(external_backup_value KIXDNS_WAS_ACTIVE || true) == true ]]; then
      systemctl restart "${KIXDNS_SERVICE_UNIT}"
    else
      systemctl stop "${KIXDNS_SERVICE_UNIT}"
    fi
    rm -rf -- "${EXTERNAL_BACKUP}"
  elif [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    restore_managed_service_state
    systemctl restart kixdns-panel.service
  else
    systemctl restart kixdns-panel.service
  fi
  rm -rf -- "${BACKUP_ROOT}"
  printf '安装未完成，已恢复原有程序和服务。\n' >&2
  exit "${status}"
}

backup_managed_config() {
  local config_parent
  local metadata
  [[ ${INSTALL_MODE} == "managed" ]] || return 0
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  backup_path "${KIXDNS_CONFIG_PATH}" kixdns-config
  if [[ -d ${config_parent} ]]; then
    metadata="$(stat -c '%u %g %a' -- "${config_parent}")"
    printf '%s\n' "${metadata}" > "${BACKUP_ROOT}/kixdns-config-directory.meta"
  else
    : > "${BACKUP_ROOT}/kixdns-config-directory.missing"
  fi
}

restore_managed_config() {
  local config_parent
  local owner
  local group
  local mode
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  rm -f -- "${KIXDNS_CONFIG_PATH}"
  if [[ -e ${BACKUP_ROOT}/kixdns-config || -L ${BACKUP_ROOT}/kixdns-config ]]; then
    install -d -- "${config_parent}"
    cp -a -- "${BACKUP_ROOT}/kixdns-config" "${KIXDNS_CONFIG_PATH}"
  fi
  if [[ -f ${BACKUP_ROOT}/kixdns-config-directory.meta ]]; then
    read -r owner group mode < "${BACKUP_ROOT}/kixdns-config-directory.meta"
    chown "${owner}:${group}" -- "${config_parent}"
    chmod "${mode}" -- "${config_parent}"
  elif [[ -f ${BACKUP_ROOT}/kixdns-config-directory.missing ]]; then
    rmdir --ignore-fail-on-non-empty -- "${config_parent}" 2>/dev/null || true
  fi
}

preserve_external_install() {
  local active="false"
  local enabled="false"
  [[ ${INSTALL_MODE} == "managed" && ${EXISTING_PANEL} == false && ${EXISTING_KIXDNS} == true ]] || return 0
  [[ ! -e ${EXTERNAL_BACKUP} ]] || return 0
  systemctl is-active --quiet "${KIXDNS_SERVICE_UNIT}" && active="true"
  systemctl is-enabled --quiet "${KIXDNS_SERVICE_UNIT}" && enabled="true"
  install -d -o root -g root -m 0700 "${EXTERNAL_BACKUP}"
  if [[ -e /etc/systemd/system/${KIXDNS_SERVICE_UNIT} ]]; then
    cp -a -- "/etc/systemd/system/${KIXDNS_SERVICE_UNIT}" "${EXTERNAL_BACKUP}/kixdns.service"
  else
    : > "${EXTERNAL_BACKUP}/service-file-missing"
  fi
  {
    printf 'KIXDNS_SERVICE_UNIT=%s\n' "${KIXDNS_SERVICE_UNIT}"
    printf 'KIXDNS_CONFIG=%s\n' "${KIXDNS_CONFIG_PATH}"
    printf 'KIXDNS_BINARY=%s\n' "${EXISTING_KIXDNS_BINARY_PATH}"
    printf 'KIXDNS_WAS_ACTIVE=%s\n' "${active}"
    printf 'KIXDNS_WAS_ENABLED=%s\n' "${enabled}"
  } > "${EXTERNAL_BACKUP}/install.env"
  chmod 0600 "${EXTERNAL_BACKUP}/install.env"
  CREATED_EXTERNAL_BACKUP=true
}

prepare_rollback() {
  BACKUP_ROOT="$(mktemp -d /var/tmp/kixdns-panel-install.XXXXXX)"
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    backup_path /var/lib/kixdns-panel/bin/kixdns kixdns
    backup_path /var/lib/kixdns-panel/bundle bundled-metadata
    backup_path "/etc/systemd/system/${KIXDNS_SERVICE_UNIT}" kixdns-service
  fi
  backup_path /usr/local/bin/kixdns-panel-server panel-server
  backup_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  backup_path /usr/local/libexec/kixdns-panel-one-click-install panel-one-click-install
  backup_path /usr/local/libexec/kixdns-panel-online-update panel-online-update
  backup_path /usr/share/kixdns-panel/web web
  backup_path /etc/systemd/system/kixdns-panel.service panel-service
  backup_path /usr/local/libexec/kixdns-panel-helper panel-helper
  backup_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  backup_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  backup_path /etc/kixdns-panel/panel.env panel-env
  if [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    backup_managed_config
  fi
  trap 'rollback_install $?' ERR
}

install_web() {
  local target=/usr/share/kixdns-panel/web
  local staged="${target}.new"
  local previous="${target}.previous"
  rm -rf -- "${staged}"
  install -d -o root -g root -m 0755 "${staged}"
  cp -a -- "${PACKAGE_ROOT}/web/." "${staged}/"
  chown -R root:root "${staged}"
  if [[ -d "${target}" ]]; then
    rm -rf -- "${previous}"
    mv -- "${target}" "${previous}"
  fi
  mv -- "${staged}" "${target}"
}

render_panel_environment() {
  local source=$1
  local output=$2
  local kixdns_commit=$3
  local panel_commit=$4
  local panel_release=$5
  local management_enabled=$6
  local kixdns_source_id=$7
  awk -v kixdns_commit="${kixdns_commit}" -v panel_commit="${panel_commit}" \
    -v panel_release="${panel_release}" -v management_enabled="${management_enabled}" \
    -v kixdns_source_id="${kixdns_source_id}" \
    -v config_path="${KIXDNS_CONFIG_PATH}" -v binary_path="${KIXDNS_BINARY_PATH}" \
    -v control_socket="${KIXDNS_CONTROL_SOCKET}" -v helper_socket="${KIXDNS_SERVICE_HELPER_SOCKET}" \
    -v service_unit="${KIXDNS_SERVICE_UNIT}" '
    /^KIXDNS_UPDATE_WORKFLOW=build-enhanced\.yml$/ {
      print "KIXDNS_UPDATE_WORKFLOW=build-kixdns.yml"
      next
    }
    /^KIXDNS_PANEL_BIND=127\.0\.0\.1:5738$/ {
      print "KIXDNS_PANEL_BIND=0.0.0.0:5738"
      bind_found = 1
      next
    }
    /^KIXDNS_PANEL_BIND=/ { bind_found = 1 }
    /^KIXDNS_CONFIG=/ { print "KIXDNS_CONFIG=" config_path; config_found = 1; next }
    /^KIXDNS_BINARY=/ { print "KIXDNS_BINARY=" binary_path; binary_found = 1; next }
    /^KIXDNS_CONTROL_SOCKET=/ { print "KIXDNS_CONTROL_SOCKET=" control_socket; socket_found = 1; next }
    /^KIXDNS_SERVICE_HELPER_SOCKET=/ { print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket; helper_socket_found = 1; next }
    /^KIXDNS_SERVICE_UNIT=/ { print "KIXDNS_SERVICE_UNIT=" service_unit; unit_found = 1; next }
    /^KIXDNS_MANAGEMENT_ENABLED=/ {
      print "KIXDNS_MANAGEMENT_ENABLED=" management_enabled
      management_found = 1
      next
    }
    /^KIXDNS_INSTALLED_COMMIT=/ {
      print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      kixdns_found = 1
      next
    }
    /^KIXDNS_INSTALLED_SOURCE_ID=/ {
      print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      source_id_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_COMMIT=/ {
      print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      panel_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_RELEASE=/ {
      if (panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
      panel_release_found = 1
      next
    }
    /^KIXDNS_UPDATE_RELEASE_WORKFLOW=/ {
      release_workflow = 1
    }
    { print }
    END {
      if (!bind_found) print "KIXDNS_PANEL_BIND=0.0.0.0:5738"
      if (!config_found) print "KIXDNS_CONFIG=" config_path
      if (!binary_found) print "KIXDNS_BINARY=" binary_path
      if (!socket_found) print "KIXDNS_CONTROL_SOCKET=" control_socket
      if (!helper_socket_found) print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket
      if (!unit_found) print "KIXDNS_SERVICE_UNIT=" service_unit
      if (!management_found) print "KIXDNS_MANAGEMENT_ENABLED=" management_enabled
      if (!kixdns_found) print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      if (!source_id_found) print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      if (!panel_found) print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      if (!panel_release_found && panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
      if (!release_workflow) print "KIXDNS_UPDATE_RELEASE_WORKFLOW=build-kixdns-release.yml"
    }
  ' "${source}" > "${output}"
}

update_panel_environment() {
  local kixdns_commit=$1
  local panel_commit=$2
  local panel_release=$3
  local kixdns_source_id=$4
  local management_enabled="true"
  local target=/etc/kixdns-panel/panel.env
  local temporary
  [[ ${INSTALL_MODE} == "external" ]] && management_enabled="false"
  temporary="$(mktemp /etc/kixdns-panel/.panel.env.XXXXXX)"
  render_panel_environment "${target}" "${temporary}" "${kixdns_commit}" \
    "${panel_commit}" "${panel_release}" "${management_enabled}" "${kixdns_source_id}"
  chown root:"${KIXDNS_GROUP}" "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${target}"
}

install_configuration() {
  local kixdns_build_commit=$1
  local panel_build_commit=$2
  local panel_release=$3
  local kixdns_source_id=$4
  local artifact
  artifact="$(detect_artifact)"
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 /etc/kixdns-panel
  if [[ ${INSTALL_MODE} == "managed" ]]; then
    install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 "$(dirname -- "${KIXDNS_CONFIG_PATH}")"
    if [[ ! -e ${KIXDNS_CONFIG_PATH} ]]; then
      install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 \
        "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${KIXDNS_CONFIG_PATH}"
    else
      chown "${PANEL_USER}:${KIXDNS_GROUP}" -- "${KIXDNS_CONFIG_PATH}"
      chmod 0640 -- "${KIXDNS_CONFIG_PATH}"
    fi
  fi
  if [[ ! -e /etc/kixdns-panel/panel.env ]]; then
    sed -e "s/^KIXDNS_UPDATE_ARTIFACT=.*/KIXDNS_UPDATE_ARTIFACT=${artifact}/" \
      -e "s/^KIXDNS_INSTALLED_COMMIT=.*/KIXDNS_INSTALLED_COMMIT=${kixdns_build_commit}/" \
      -e "s/^KIXDNS_PANEL_INSTALLED_COMMIT=.*/KIXDNS_PANEL_INSTALLED_COMMIT=${panel_build_commit}/" \
      -e "s/^KIXDNS_INSTALLED_SOURCE_ID=.*/KIXDNS_INSTALLED_SOURCE_ID=${kixdns_source_id}/" \
      "${PACKAGE_ROOT}/deploy/panel.env.example" > /etc/kixdns-panel/panel.env
    chown root:"${KIXDNS_GROUP}" /etc/kixdns-panel/panel.env
    chmod 0640 /etc/kixdns-panel/panel.env
  fi
  update_panel_environment "${kixdns_build_commit}" "${panel_build_commit}" "${panel_release}" \
    "${kixdns_source_id}"
}

install_bundled_metadata() {
  local target=/var/lib/kixdns-panel/bundle
  [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]] || return 0
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 "${target}"
  install -o root -g "${KIXDNS_GROUP}" -m 0640 \
    "${PACKAGE_ROOT}/upstream.lock.json" "${target}/upstream.lock.json"
  local file
  for file in KIXDNS_BUILD_COMMIT KIXDNS_SOURCE_RUN_ID KIXDNS_ARTIFACT_ID \
    KIXDNS_ARTIFACT_NAME KIXDNS_ARTIFACT_DIGEST KIXDNS_BINARY_SHA256 \
    KIXDNS_CAPABILITIES.json; do
    install -o root -g "${KIXDNS_GROUP}" -m 0640 \
      "${PACKAGE_ROOT}/${file}" "${target}/${file}"
  done
}

install_services() {
  local kixdns_unit=/etc/systemd/system/${KIXDNS_SERVICE_UNIT}
  local config_directory
  local panel_temporary
  local helper_temporary
  local helper_unit=/etc/systemd/system/kixdns-panel-helper.service
  local panel_uid
  panel_uid="$(id -u "${PANEL_USER}")"
  panel_temporary="$(mktemp /etc/systemd/system/.kixdns-panel.XXXXXX)"
  helper_temporary="$(mktemp /etc/systemd/system/.kixdns-panel-helper.XXXXXX)"
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    local kixdns_temporary
    kixdns_temporary="$(mktemp /etc/systemd/system/.kixdns.XXXXXX)"
    awk -v config_path="${KIXDNS_CONFIG_PATH}" -v control_socket="${KIXDNS_CONTROL_SOCKET}" '
      /^ConditionPathExists=/ { print "ConditionPathExists=" config_path; next }
      /^ExecStart=/ {
        print "ExecStart=/var/lib/kixdns-panel/bin/kixdns run --config " config_path " --admin-socket " control_socket
        next
      }
      { print }
    ' "${PACKAGE_ROOT}/deploy/systemd/kixdns.service" > "${kixdns_temporary}"
    install -o root -g root -m 0644 "${kixdns_temporary}" "${kixdns_unit}"
    rm -f -- "${kixdns_temporary}"
  fi
  awk -v service_unit="${KIXDNS_SERVICE_UNIT}" -v helper_socket="${KIXDNS_SERVICE_HELPER_SOCKET}" \
    -v panel_uid="${panel_uid}" '
    /^ExecStart=/ {
      print "ExecStart=/usr/local/libexec/kixdns-panel-helper --socket " helper_socket " --unit " service_unit " --allowed-uid " panel_uid
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel-helper.service" > "${helper_temporary}"
  install -o root -g root -m 0644 "${helper_temporary}" "${helper_unit}"
  rm -f -- "${helper_temporary}"
  config_directory="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  awk -v service_unit="${KIXDNS_SERVICE_UNIT}" -v config_directory="${config_directory}" '
    /^After=network-online\.target / { print "After=network-online.target " service_unit " kixdns-panel-helper.service"; next }
    /^ReadWritePaths=/ {
      print "ReadWritePaths=" config_directory " /var/lib/kixdns-panel"
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel.service" > "${panel_temporary}"
  install -o root -g root -m 0644 "${panel_temporary}" /etc/systemd/system/kixdns-panel.service
  rm -f -- "${panel_temporary}"
  rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
  systemctl daemon-reload
  systemctl enable kixdns-panel-helper.service kixdns-panel.service
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    restore_managed_service_state
  fi
  systemctl restart kixdns-panel-helper.service
  systemctl restart kixdns-panel.service
}

main() {
  local kixdns_build_commit
  local kixdns_source_id
  local panel_bind
  local panel_build_commit
  local panel_url
  local panel_release=""
  parse_arguments "$@"
  require_root
  command -v systemctl >/dev/null || fail "系统未安装 systemd"
  command -v getent >/dev/null || fail "系统缺少 getent"
  command -v sha256sum >/dev/null || fail "系统缺少 sha256sum"
  require_file "${PACKAGE_ROOT}/bin/kixdns"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-server"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-helper"
  require_file "${PACKAGE_ROOT}/web/index.html"
  require_file "${PACKAGE_ROOT}/deploy/config/pipeline.json"
  require_file "${PACKAGE_ROOT}/scripts/one-click-install.sh"
  require_file "${PACKAGE_ROOT}/scripts/panel-online-update.sh"
  require_file "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_SOURCE_RUN_ID"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_NAME"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_DIGEST"
  require_file "${PACKAGE_ROOT}/KIXDNS_BINARY_SHA256"
  require_file "${PACKAGE_ROOT}/KIXDNS_CAPABILITIES.json"
  require_file "${PACKAGE_ROOT}/upstream.lock.json"
  require_file "${PACKAGE_ROOT}/SHA256SUMS"
  panel_build_commit="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT")"
  kixdns_build_commit="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT")"
  kixdns_source_id="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID")"
  if [[ -f "${PACKAGE_ROOT}/PANEL_RELEASE" ]]; then
    panel_release="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_RELEASE")"
    [[ "${panel_release}" =~ ^[0-9A-Za-z._-]{1,100}$ ]] || fail "PANEL_RELEASE 标签无效"
  fi
  [[ "${panel_build_commit}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "PANEL_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${kixdns_build_commit}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "KIXDNS_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${kixdns_source_id}" =~ ^[1-9][0-9]*$ ]] || fail "KIXDNS_ARTIFACT_ID 无效"

  (cd "${PACKAGE_ROOT}" && sha256sum --check --quiet SHA256SUMS) || fail "安装包摘要校验失败"

  load_existing_panel_settings
  validate_panel_only_update
  detect_existing_kixdns
  if [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    choose_install_mode
  fi
  validate_install_mode
  capture_managed_service_state
  if [[ ${INSTALL_MODE} == "external" ]]; then
    KIXDNS_BINARY_PATH="$(readlink -f -- "${KIXDNS_BINARY_PATH}")"
    [[ -n ${KIXDNS_BINARY_PATH} ]] || fail "无法解析既有 KixDNS 二进制路径"
  fi

  create_accounts
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 \
    /var/lib/kixdns-panel /var/lib/kixdns-panel/bin /var/lib/kixdns-panel/versions \
    /var/lib/kixdns-panel/geo
  [[ ! -L /var/lib/kixdns-panel-update ]] || fail "在线更新状态目录不能是符号链接"
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 /var/lib/kixdns-panel-update
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    [[ ! -L /var/lib/kixdns-panel/bin/kixdns ]] || fail "KixDNS 二进制目标不能是符号链接"
  fi
  [[ ! -L /usr/local/bin/kixdns-panel-server ]] || fail "面板二进制目标不能是符号链接"
  [[ ! -L /usr/local/bin/kixdns-panel-uninstall ]] || fail "卸载命令目标不能是符号链接"
  [[ ! -L /usr/local/libexec/kixdns-panel-one-click-install ]] || fail "一键安装器目标不能是符号链接"
  [[ ! -L /usr/local/libexec/kixdns-panel-online-update ]] || fail "在线更新器目标不能是符号链接"
  if [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    preserve_external_install
  fi
  prepare_rollback
  systemctl stop kixdns-panel.service 2>/dev/null || true
  systemctl stop kixdns-panel-helper.service 2>/dev/null || true
  if [[ ${INSTALL_MODE} == "managed" && ${PANEL_ONLY_UPDATE} == false ]]; then
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 \
      "${PACKAGE_ROOT}/bin/kixdns" /var/lib/kixdns-panel/bin/.kixdns.new
    mv -fT -- /var/lib/kixdns-panel/bin/.kixdns.new /var/lib/kixdns-panel/bin/kixdns
  elif [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    kixdns_build_commit=""
    kixdns_source_id=""
  else
    kixdns_build_commit="$(environment_value KIXDNS_INSTALLED_COMMIT || true)"
    kixdns_source_id="$(environment_value KIXDNS_INSTALLED_SOURCE_ID || true)"
  fi
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-server" /usr/local/bin/.kixdns-panel-server.new
  mv -fT -- /usr/local/bin/.kixdns-panel-server.new /usr/local/bin/kixdns-panel-server
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/uninstall.sh" /usr/local/bin/.kixdns-panel-uninstall.new
  mv -fT -- /usr/local/bin/.kixdns-panel-uninstall.new /usr/local/bin/kixdns-panel-uninstall
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/one-click-install.sh" /usr/local/libexec/.kixdns-panel-one-click-install.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-one-click-install.new /usr/local/libexec/kixdns-panel-one-click-install
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/panel-online-update.sh" /usr/local/libexec/.kixdns-panel-online-update.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-online-update.new /usr/local/libexec/kixdns-panel-online-update
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-helper" /usr/local/libexec/.kixdns-panel-helper.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-helper.new /usr/local/libexec/kixdns-panel-helper
  install_web
  install_bundled_metadata
  if [[ ${PANEL_ONLY_UPDATE} == true ]]; then
    update_panel_environment "${kixdns_build_commit}" "${panel_build_commit}" "${panel_release}" \
      "${kixdns_source_id}"
  else
    install_configuration "${kixdns_build_commit}" "${panel_build_commit}" "${panel_release}" \
      "${kixdns_source_id}"
  fi
  install_services
  trap - ERR
  rm -rf -- "${BACKUP_ROOT}"

  if [[ ${PANEL_ONLY_UPDATE} == true ]]; then
    printf '\n面板在线更新完成。\n'
  else
    printf '\n安装完成。\n'
  fi
  printf '面板构建：%.12s\n' "${panel_build_commit}"
  if [[ ${PANEL_ONLY_UPDATE} == true ]]; then
    printf 'KixDNS：未替换，配置与运行状态保持不变\n'
  elif [[ ${INSTALL_MODE} == "managed" ]]; then
    printf 'KixDNS 模式：面板管理（增强构建 %.12s）\n' "${kixdns_build_commit}"
    if [[ ${PRESERVE_KIXDNS_STATE} == false ]]; then
      printf 'KixDNS 状态：已停止（首次安装不会自动启动，可在面板中启动）\n'
    fi
  else
    printf 'KixDNS 模式：保留外部安装（版本管理已禁用）\n'
  fi
  panel_bind="$(environment_value KIXDNS_PANEL_BIND || true)"
  [[ -n ${panel_bind} ]] || panel_bind=0.0.0.0:5738
  panel_url="$(panel_access_url "${panel_bind}")"
  printf '面板地址：%s\n' "${panel_url}"
  printf '首次访问时创建管理员账号；请仅在可信内网使用，公网访问必须配置防火墙和 HTTPS 反向代理。\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
