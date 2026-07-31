#!/usr/bin/env bash
set -Eeuo pipefail

PURGE=false
case ${1:-} in
  "") ;;
  --purge) PURGE=true ;;
  *)
    printf '卸载失败：未知参数 %s\n' "$1" >&2
    exit 1
    ;;
esac

PANEL_ENV=/etc/kixdns-panel/panel.env
EXTERNAL_BACKUP=/var/lib/kixdns-panel/external-backup
KIXDNS_MANAGEMENT_ENABLED=true
KIXDNS_SERVICE_UNIT=kixdns.service

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

if [[ ${EUID} -ne 0 ]]; then
  printf '卸载失败：请使用 root 权限运行\n' >&2
  exit 1
fi

value="$(environment_value KIXDNS_MANAGEMENT_ENABLED || true)"
[[ -z ${value} ]] || KIXDNS_MANAGEMENT_ENABLED=${value}
value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
[[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
[[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9_.@-]{1,120}\.service$ ]] || {
  printf '卸载失败：panel.env 中的 KixDNS unit 名称无效\n' >&2
  exit 1
}

systemctl disable --now kixdns-panel.service 2>/dev/null || true
systemctl disable --now kixdns-panel-helper.service 2>/dev/null || true
rm -f -- /etc/systemd/system/kixdns-panel.service
rm -f -- /etc/systemd/system/kixdns-panel-helper.service
if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true ]]; then
  systemctl disable --now "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  rm -f -- "/etc/systemd/system/${KIXDNS_SERVICE_UNIT}"
  if [[ -f ${EXTERNAL_BACKUP}/install.env ]]; then
    original_unit="$(backup_value KIXDNS_SERVICE_UNIT || true)"
    [[ ${original_unit} =~ ^[A-Za-z0-9_.@-]{1,120}\.service$ ]] || {
      printf '卸载失败：外部 KixDNS 备份中的 unit 名称无效\n' >&2
      exit 1
    }
    if [[ -f ${EXTERNAL_BACKUP}/kixdns.service ]]; then
      install -o root -g root -m 0644 "${EXTERNAL_BACKUP}/kixdns.service" \
        "/etc/systemd/system/${original_unit}"
    fi
  fi
fi
rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
rm -f -- /usr/local/bin/kixdns-panel-server
rm -f -- /usr/local/libexec/kixdns-panel-helper
rm -f -- /run/kixdns-panel/control.sock
rm -rf -- /usr/share/kixdns-panel
systemctl daemon-reload
if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true && -f ${EXTERNAL_BACKUP}/install.env ]]; then
  [[ $(backup_value KIXDNS_WAS_ENABLED || true) == true ]] && systemctl enable "${original_unit}"
  [[ $(backup_value KIXDNS_WAS_ACTIVE || true) == true ]] && systemctl start "${original_unit}"
  printf '迁移前的外部 KixDNS 服务定义与运行状态已恢复。\n'
fi

if [[ ${PURGE} == true ]]; then
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} == true ]]; then
    rm -rf -- /etc/kixdns
  fi
  rm -rf -- /etc/kixdns-panel /var/lib/kixdns-panel
  userdel kixdns-panel 2>/dev/null || true
  printf 'KixDNS Panel 已卸载，面板配置与运行数据已清除。\n'
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} != true ]]; then
    printf '外部 KixDNS 的服务、二进制、配置和账号均未修改。\n'
  fi
else
  printf 'KixDNS Panel 已卸载，配置与运行数据已保留。\n'
  if [[ ${KIXDNS_MANAGEMENT_ENABLED} != true ]]; then
    printf '外部 KixDNS 仍按原状态运行。\n'
  fi
  printf '如需清除全部数据，请重新运行：sudo bash ./scripts/uninstall.sh --purge\n'
fi
