#!/usr/bin/env bash
set -Eeuo pipefail

PURGE=false
[[ ${1:-} == "--purge" ]] && PURGE=true

if [[ ${EUID} -ne 0 ]]; then
  printf '卸载失败：请使用 root 权限运行\n' >&2
  exit 1
fi

systemctl disable --now kixdns-panel.service kixdns.service 2>/dev/null || true
rm -f -- /etc/systemd/system/kixdns-panel.service /etc/systemd/system/kixdns.service
rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
rm -f -- /usr/local/bin/kixdns-panel-server
rm -rf -- /usr/share/kixdns-panel
systemctl daemon-reload

if [[ ${PURGE} == true ]]; then
  rm -rf -- /etc/kixdns /etc/kixdns-panel /var/lib/kixdns-panel
  userdel kixdns-panel 2>/dev/null || true
  userdel kixdns 2>/dev/null || true
  groupdel kixdns 2>/dev/null || true
  printf 'KixDNS Panel 已卸载，配置与运行数据已清除。\n'
else
  printf 'KixDNS Panel 已卸载，/etc/kixdns、/etc/kixdns-panel 与 /var/lib/kixdns-panel 已保留。\n'
  printf '如需清除全部数据，请重新运行：sudo bash ./scripts/uninstall.sh --purge\n'
fi
