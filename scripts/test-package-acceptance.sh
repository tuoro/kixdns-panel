#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_PATH=/etc/kixdns/pipeline.json
PANEL_ENV=/etc/kixdns-panel/panel.env
ACCEPTANCE_PY="${PACKAGE_ROOT}/scripts/package_acceptance.py"
INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"
UNINSTALLER="${PACKAGE_ROOT}/scripts/uninstall.sh"
installed=false

fail() {
  printf '::error file=scripts/test-package-acceptance.sh::%s\n' "$*" >&2
  printf '安装包验收失败：%s\n' "$*" >&2
  exit 1
}

report_error() {
  local status=$?
  trap - ERR
  printf '::error file=scripts/test-package-acceptance.sh::验收命令失败：%s\n' "${BASH_COMMAND}" >&2
  exit "${status}"
}

trap report_error ERR

require_clean_host() {
  local path
  for path in \
    /usr/local/bin/kixdns-panel-server \
    /usr/local/bin/kixdns-panel-uninstall \
    /usr/local/libexec/kixdns-panel-helper \
    /usr/share/kixdns-panel \
    /etc/kixdns-panel \
    /etc/kixdns \
    /var/lib/kixdns-panel \
    /run/kixdns-panel/control.sock \
    /etc/systemd/system/kixdns-panel.service \
    /etc/systemd/system/kixdns-panel-helper.service \
    /etc/systemd/system/kixdns.service; do
    [[ ! -e ${path} && ! -L ${path} ]] || fail "临时机已有路径 ${path}"
  done
  ! systemctl cat kixdns-panel.service >/dev/null 2>&1 || fail "临时机已有面板服务"
  ! systemctl cat kixdns-panel-helper.service >/dev/null 2>&1 || fail "临时机已有 helper 服务"
  ! systemctl cat kixdns.service >/dev/null 2>&1 || fail "临时机已有 KixDNS 服务"
}

show_failure_logs() {
  local status=$1
  ((status == 0)) && return
  printf '\nKixDNS 服务状态：\n' >&2
  systemctl status kixdns.service --no-pager >&2 || true
  printf '\n面板服务状态：\n' >&2
  systemctl status kixdns-panel.service --no-pager >&2 || true
  printf '\n服务控制 helper 状态：\n' >&2
  systemctl status kixdns-panel-helper.service --no-pager >&2 || true
  printf '\nKixDNS 日志：\n' >&2
  journalctl -u kixdns.service --no-pager -n 120 >&2 || true
  printf '\n面板日志：\n' >&2
  journalctl -u kixdns-panel.service --no-pager -n 120 >&2 || true
  printf '\n服务控制 helper 日志：\n' >&2
  journalctl -u kixdns-panel-helper.service --no-pager -n 120 >&2 || true
}

cleanup() {
  local status=$?
  trap - EXIT
  show_failure_logs "${status}"
  if [[ ${installed} == true || -f ${PANEL_ENV} ]]; then
    bash "${UNINSTALLER}" --purge >/dev/null 2>&1 || true
  fi
  exit "${status}"
}

verify_removed() {
  local path
  systemctl daemon-reload
  ! systemctl is-active --quiet kixdns-panel.service || fail "卸载后面板服务仍在运行"
  ! systemctl is-active --quiet kixdns-panel-helper.service || fail "卸载后 helper 服务仍在运行"
  ! systemctl is-active --quiet kixdns.service || fail "卸载后 KixDNS 服务仍在运行"
  for path in \
    /usr/local/bin/kixdns-panel-server \
    /usr/local/bin/kixdns-panel-uninstall \
    /usr/local/libexec/kixdns-panel-helper \
    /usr/share/kixdns-panel \
    /etc/kixdns-panel \
    /etc/kixdns \
    /var/lib/kixdns-panel \
    /run/kixdns-panel/control.sock \
    /etc/systemd/system/kixdns-panel.service \
    /etc/systemd/system/kixdns-panel-helper.service \
    /etc/systemd/system/kixdns.service; do
    [[ ! -e ${path} && ! -L ${path} ]] || fail "卸载后仍残留 ${path}"
  done
  ! getent passwd kixdns-panel >/dev/null || fail "卸载后仍残留面板账号"
}

[[ ${EUID} -eq 0 ]] || fail "必须使用 root 权限运行"
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true ]] ||
  fail "该脚本只允许在 GitHub Actions 临时机运行"
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]] ||
  fail "该脚本拒绝修改自托管 Runner"
os_id="$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)"
[[ ${os_id} == ubuntu ]] ||
  fail "当前验收只允许 Ubuntu 临时机"
command -v systemctl >/dev/null || fail "临时机缺少 systemd"
command -v python3 >/dev/null || fail "临时机缺少 Python 3"

require_clean_host
trap cleanup EXIT

dns_port="$(python3 "${ACCEPTANCE_PY}" prepare --config "${CONFIG_PATH}")"
[[ ${dns_port} =~ ^[0-9]+$ ]] || fail "没有获得有效 DNS 端口"

bash "${INSTALLER}" --replace-existing
installed=true
grep -Fxq 'KIXDNS_PANEL_BIND=0.0.0.0:5738' "${PANEL_ENV}" ||
  fail "面板没有监听局域网 IPv4 地址"
[[ -x /usr/local/bin/kixdns-panel-uninstall ]] || fail "没有安装全局卸载命令"
/usr/local/bin/kixdns-panel-uninstall --help >/dev/null
[[ $(stat -c '%U:%G:%a' -- "$(dirname -- "${CONFIG_PATH}")") == kixdns-panel:kixdns:750 ]] ||
  fail "安装器没有设置可原子写入的配置目录权限"
[[ $(stat -c '%U:%G:%a' -- "${CONFIG_PATH}") == kixdns-panel:kixdns:640 ]] ||
  fail "安装器没有设置受控的配置文件权限"
systemd-analyze verify /etc/systemd/system/kixdns.service \
  /etc/systemd/system/kixdns-panel-helper.service /etc/systemd/system/kixdns-panel.service
grep -Fq -- "--unit kixdns.service --allowed-uid $(id -u kixdns-panel)" \
  /etc/systemd/system/kixdns-panel-helper.service || fail "helper 没有固定 KixDNS unit 与面板 UID"
[[ ! -e /etc/polkit-1/rules.d/50-kixdns-panel.rules ]] || fail "安装后仍残留旧 Polkit 规则"
[[ $(stat -c '%U:%G:%a' -- /run/kixdns-panel/control.sock) == kixdns-panel:kixdns:600 ]] ||
  fail "服务控制 helper Socket 权限不符合预期"
kixdns_pid="$(systemctl show --property=MainPID --value kixdns.service)"
python3 - <<'PY'
import socket

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(5)
client.connect("/run/kixdns-panel/control.sock")
client.sendall(b"restart")
client.shutdown(socket.SHUT_WR)
try:
    response = client.recv(1024)
except ConnectionResetError:
    response = b""
if response:
    raise SystemExit("root 请求不应通过面板用户 UID 校验")
PY
[[ $(systemctl show --property=MainPID --value kixdns.service) == "${kixdns_pid}" ]] ||
  fail "非面板 UID 绕过了 helper 校验"
panel_env_new="$(mktemp /etc/kixdns-panel/.acceptance-env.XXXXXX)"
awk -v diagnostic="127.0.0.1:${dns_port}" '
  /^KIXDNS_DIAGNOSTIC_SERVER=/ {
    print "KIXDNS_DIAGNOSTIC_SERVER=" diagnostic
    found = 1
    next
  }
  { print }
  END { if (!found) print "KIXDNS_DIAGNOSTIC_SERVER=" diagnostic }
' "${PANEL_ENV}" > "${panel_env_new}"
chown root:kixdns "${panel_env_new}"
chmod 0640 "${panel_env_new}"
mv -fT -- "${panel_env_new}" "${PANEL_ENV}"
systemctl restart kixdns.service kixdns-panel.service

python3 "${ACCEPTANCE_PY}" verify --dns-port "${dns_port}" --mode setup

# 同一完整包再次安装，验证数据库、配置历史和管理员数据均被保留。
bash "${INSTALLER}" --replace-existing
python3 "${ACCEPTANCE_PY}" verify --dns-port "${dns_port}" --mode login

uninstall_log="$(mktemp)"
if bash -x "${UNINSTALLER}" --purge >"${uninstall_log}" 2>&1; then
  cat "${uninstall_log}"
else
  uninstall_status=$?
  cat "${uninstall_log}" >&2
  uninstall_details="$(tail -n 8 "${uninstall_log}" | tr '\n' ' ')"
  rm -f -- "${uninstall_log}"
  fail "卸载脚本失败（退出码 ${uninstall_status}）：${uninstall_details}"
fi
rm -f -- "${uninstall_log}"
installed=false
verify_removed
trap - EXIT
printf '完整包安装、覆盖升级、运行联调与卸载验收通过。\n'
