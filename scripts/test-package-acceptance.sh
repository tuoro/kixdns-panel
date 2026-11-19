#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_PATH=/etc/kixdns/pipeline.json
PANEL_ENV=/etc/kixdns-panel/panel.env
# 迁移前的备份在只有 root 能进的目录里 / The pre-migration backup lives in the root-only directory
ROOT_RECORDS=/var/lib/kixdns-panel-backup
EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
ACCEPTANCE_PY="${PACKAGE_ROOT}/scripts/package_acceptance.py"
INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"
UNINSTALLER="${PACKAGE_ROOT}/scripts/uninstall.sh"
MIGRATION_ROOT=/opt/kixdns-acceptance-external
MIGRATION_UNIT=/etc/systemd/system/kixdns.service
installed=false
migration_fixture=false
install_log="$(mktemp)"

fail() {
  printf '::error file=scripts/test-package-acceptance.sh::%s\n' "$*" >&2
  printf '安装包验收失败：%s\n' "$*" >&2
  exit 1
}

report_error() {
  local status=$?
  # 只在设下陷阱的那个 shell 里报：-E 让 ERR 陷阱也在子 shell 里触发，同一个失败会报两次
  # Report in the shell that set the trap only: -E fires the ERR trap in subshells too, reporting one failure twice
  [[ -z ${1:-} || ${BASHPID} == "$1" ]] || exit "${status}"
  trap - ERR
  printf '::error file=scripts/test-package-acceptance.sh::验收命令失败：%s\n' "${BASH_COMMAND}" >&2
  exit "${status}"
}

# shellcheck disable=SC2064 # BASHPID 要在挂陷阱时展开，记下是哪个 shell 挂的 / BASHPID expands now, recording which shell set the trap
trap "report_error ${BASHPID}" ERR

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
    /var/lib/kixdns-panel-backup \
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

remove_migration_fixture() {
  systemctl disable --now kixdns.service >/dev/null 2>&1 || true
  rm -f -- "${MIGRATION_UNIT}"
  rm -rf -- "${MIGRATION_ROOT}" /etc/kixdns
  systemctl daemon-reload
  systemctl reset-failed kixdns.service >/dev/null 2>&1 || true
  userdel kixdns >/dev/null 2>&1 || true
  groupdel kixdns >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT
  show_failure_logs "${status}"
  if [[ ${installed} == true || -f ${PANEL_ENV} ]]; then
    bash "${UNINSTALLER}" --purge >/dev/null 2>&1 || true
  fi
  [[ ${migration_fixture} == false ]] || remove_migration_fixture
  rm -f -- "${install_log}"
  exit "${status}"
}

# 安装器的输出同时给 CI 日志和断言用。/ The installer output goes both to the CI log and to assertions.
run_installer() {
  bash "${INSTALLER}" "$@" 2>&1 | tee "${install_log}"
  return "${PIPESTATUS[0]}"
}

require_output() {
  grep -Fq -- "$1" "${install_log}" || fail "$2"
}

unit_main_executable() {
  local pid
  pid="$(systemctl show --property=MainPID --value "$1")"
  [[ ${pid} =~ ^[1-9][0-9]*$ ]] || return 1
  readlink -f "/proc/${pid}/exe"
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
    /var/lib/kixdns-panel-backup \
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

# 全新安装把配置指到已有的 /etc 里：安装器要在改动主机之前拒绝，/etc 的属主和权限不变。
# A fresh install pointing the config into the existing /etc: the installer must refuse before touching the host, and
# /etc keeps its owner and mode.
etc_before="$(stat -c '%U:%G:%a' -- /etc)"
if run_installer --kixdns-config /etc/kixdns-acceptance.json; then
  fail "配置指到已有的 /etc 里，安装器却没有拒绝"
fi
require_output "KixDNS 配置不能放在 /etc：面板要能写配置所在的目录，而这个目录已经存在" "拒绝时没有说明原因"
[[ $(stat -c '%U:%G:%a' -- /etc) == "${etc_before}" ]] || fail "拒绝时改动了 /etc 的属主或权限"
[[ ! -e /etc/kixdns-panel && ! -e /var/lib/kixdns-panel && ! -e /usr/local/bin/kixdns-panel-server ]] ||
  fail "拒绝时改动了主机"
! getent passwd kixdns-panel >/dev/null || fail "拒绝时建了面板账号"

dns_port="$(python3 "${ACCEPTANCE_PY}" prepare --config "${CONFIG_PATH}")"
[[ ${dns_port} =~ ^[0-9]+$ ]] || fail "没有获得有效 DNS 端口"

run_installer
installed=true
require_output "安装完成：KixDNS 面板" "首次安装没有说明安装了哪个版本"
require_output "下一步：" "首次安装没有给出下一步"
require_output "KixDNS：已安装，尚未启动" "首次安装没有说明 KixDNS 未启动"
! systemctl is-active --quiet kixdns.service || fail "首次安装不应自动启动 KixDNS"
! systemctl is-enabled --quiet kixdns.service || fail "首次安装不应启用 KixDNS 开机启动"
grep -Fxq 'KIXDNS_PANEL_BIND=0.0.0.0:5738' "${PANEL_ENV}" ||
  fail "面板没有监听局域网 IPv4 地址"
[[ -x /usr/local/bin/kixdns-panel-uninstall ]] || fail "没有安装全局卸载命令"
[[ $(stat -c '%U:%G:%a' -- /usr/local/libexec/kixdns-panel-one-click-install) == root:root:755 ]] ||
  fail "在线更新使用的一键安装器权限不符合预期"
[[ $(stat -c '%U:%G:%a' -- /usr/local/libexec/kixdns-panel-online-update) == root:root:755 ]] ||
  fail "面板在线更新器权限不符合预期"
[[ $(stat -c '%U:%G:%a' -- /var/lib/kixdns-panel-update) == root:kixdns:750 ]] ||
  fail "面板在线更新状态目录权限不符合预期"
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
kixdns_source_id="$(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${PANEL_ENV}")"
[[ ${kixdns_source_id} =~ ^[1-9][0-9]*$ ]] || fail "完整包没有写入 KixDNS 内核包编号"
[[ $(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE" { print $2 }' "${PANEL_ENV}") == fork ]] ||
  fail "完整包没有记下内核来自 fork 发布"
[[ -f /var/lib/kixdns-panel/bundle/KIXDNS_SOURCE.json ]] || fail "完整包内核来源没有持久化"
[[ ! -e /var/lib/kixdns-panel/bundle/upstream.lock.json ]] || fail "完整包里还留着补丁集构建的身份"
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
systemctl restart kixdns-panel.service

python3 "${ACCEPTANCE_PY}" verify --dns-port "${dns_port}" --mode setup-stopped
systemctl is-enabled --quiet kixdns.service || fail "面板启动 KixDNS 后没有启用开机启动"
kixdns_pid="$(systemctl show --property=MainPID --value kixdns.service)"
[[ ${kixdns_pid} =~ ^[1-9][0-9]*$ ]] || fail "面板启动 KixDNS 后没有主进程"
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

kixdns_digest_before="$(sha256sum /var/lib/kixdns-panel/bin/kixdns | awk '{ print $1 }')"
config_digest_before="$(sha256sum "${CONFIG_PATH}" | awk '{ print $1 }')"
bundle_digest_before="$(find /var/lib/kixdns-panel/bundle -type f -print0 | sort -z |
  xargs -0 sha256sum | sha256sum | awk '{ print $1 }')"
kixdns_commit_before="$(awk -F= '$1 == "KIXDNS_INSTALLED_COMMIT" { print $2 }' "${PANEL_ENV}")"
kixdns_source_before="$(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${PANEL_ENV}")"
# 同一个包再运行一次不应改动任何东西，也不应打断 DNS。
# Running the same package again must change nothing and must not interrupt DNS.
run_installer
require_output "已安装，未作任何修改" "同一版本再次运行没有直接退出"
[[ $(systemctl show --property=MainPID --value kixdns.service) == "${kixdns_pid}" ]] ||
  fail "同一版本再次运行重启了 KixDNS"
run_installer --panel-only-update --reinstall
require_output "KixDNS：未替换，配置与运行状态保持不变" "仅更新面板没有说明 KixDNS 未动"
systemctl is-active --quiet kixdns.service || fail "仅更新面板改变了 KixDNS 运行状态"
systemctl is-enabled --quiet kixdns.service || fail "仅更新面板改变了 KixDNS 开机状态"
[[ $(sha256sum /var/lib/kixdns-panel/bin/kixdns | awk '{ print $1 }') == "${kixdns_digest_before}" ]] ||
  fail "仅更新面板替换了 KixDNS 二进制"
[[ $(sha256sum "${CONFIG_PATH}" | awk '{ print $1 }') == "${config_digest_before}" ]] ||
  fail "仅更新面板改写了 KixDNS 配置"
[[ $(find /var/lib/kixdns-panel/bundle -type f -print0 | sort -z | xargs -0 sha256sum |
  sha256sum | awk '{ print $1 }') == "${bundle_digest_before}" ]] || fail "仅更新面板改写了 KixDNS 构建身份"
[[ $(awk -F= '$1 == "KIXDNS_INSTALLED_COMMIT" { print $2 }' "${PANEL_ENV}") == "${kixdns_commit_before}" ]] ||
  fail "仅更新面板改写了 KixDNS 提交身份"
[[ $(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${PANEL_ENV}") == "${kixdns_source_before}" ]] ||
  fail "仅更新面板改写了 KixDNS Artifact 身份"

# 同一完整包用 --reinstall 修复安装，验证数据库、配置历史和管理员数据均被保留；
# KixDNS 程序与 unit 都没变，所以不能被重启。
# Repair-install the same package with --reinstall: database, config history and the admin survive,
# and since neither the KixDNS binary nor its unit changed, KixDNS must not be restarted.
kixdns_pid="$(systemctl show --property=MainPID --value kixdns.service)"
run_installer --reinstall
require_output "KixDNS：未变（运行中）" "修复安装没有说明 KixDNS 未变"
[[ $(systemctl show --property=MainPID --value kixdns.service) == "${kixdns_pid}" ]] ||
  fail "KixDNS 没有变化，修复安装却重启了它"
systemctl is-active --quiet kixdns.service || fail "覆盖安装没有保持 KixDNS 运行状态"
systemctl is-enabled --quiet kixdns.service || fail "覆盖安装没有保持 KixDNS 开机启动状态"
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

# 迁移：主机上已有一个运行中且开机自启的外部 KixDNS。用包里的程序和另一个空闲端口让它真的跑起来。
# 它的配置写着一个 GeoSite 文件，先放在只有 root 进得去的目录里。
# Migration: the host already has an external KixDNS, running and enabled. Use the package's own
# binary on another free port so it really runs. Its config names a GeoSite file, kept at first in a
# directory only root can enter.
migration_geosite="${MIGRATION_ROOT}/private/geosite.dat"
migration_port="$(python3 "${ACCEPTANCE_PY}" prepare --config "${CONFIG_PATH}" --geosite "${migration_geosite}")"
[[ ${migration_port} =~ ^[0-9]+$ ]] || fail "没有获得迁移验收的 DNS 端口"
migration_fixture=true
install -d -m 0755 "${MIGRATION_ROOT}"
install -d -m 0700 "$(dirname -- "${migration_geosite}")"
install -m 0644 "${PACKAGE_ROOT}/geo/geosite.dat" "${migration_geosite}"
install -m 0755 "${PACKAGE_ROOT}/bin/kixdns" "${MIGRATION_ROOT}/kixdns"
cat > "${MIGRATION_UNIT}" <<EOF
[Unit]
Description=验收用的外部 KixDNS

[Service]
ExecStart=${MIGRATION_ROOT}/kixdns run --config ${CONFIG_PATH} --admin-socket /run/kixdns/admin.sock
RuntimeDirectory=kixdns
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
cp -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/original.service"
systemctl daemon-reload
systemctl enable --now kixdns.service
python3 "${ACCEPTANCE_PY}" dns --dns-port "${migration_port}"
[[ $(unit_main_executable kixdns.service) == "${MIGRATION_ROOT}/kixdns" ]] ||
  fail "外部 KixDNS 没有运行验收准备的程序"
# 原配置和它所在的目录：迁移、面板改配置、卸载恢复之后都要和这时一模一样。
# The original config and its directory: after migration, a panel edit and the uninstall restore they must be exactly as now.
original_config_state() {
  stat -c '%U:%G:%a' -- "${CONFIG_PATH}" "$(dirname -- "${CONFIG_PATH}")"
  sha256sum -- "${CONFIG_PATH}"
}
original_before="$(original_config_state)"

# 迁移后的 KixDNS 以 kixdns 账号运行，读不到这个 GeoSite：安装器要在改动主机之前拒绝，并点名文件。
# The migrated KixDNS runs as the kixdns account and cannot read this GeoSite: the installer must refuse before
# touching the host, naming the file.
if run_installer --replace-existing; then
  fail "迁移后的 KixDNS 读不到原配置里写的文件，安装器却没有拒绝"
fi
require_output "读不到原配置 ${CONFIG_PATH} 里写的这些文件" "拒绝迁移时没有说明原因"
require_output "  ${migration_geosite}：kixdns 账号没有读取权限" "拒绝迁移时没有点名读不到的文件"
[[ ! -e /etc/kixdns-panel && ! -e /var/lib/kixdns-panel && ! -e /usr/local/bin/kixdns-panel-server ]] ||
  fail "拒绝迁移时改动了主机"
cmp -s -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/original.service" || fail "拒绝迁移时改动了原来的 unit"
[[ $(unit_main_executable kixdns.service) == "${MIGRATION_ROOT}/kixdns" ]] || fail "拒绝迁移时动了原来的 KixDNS"
chmod 0755 "$(dirname -- "${migration_geosite}")"

run_installer --replace-existing
installed=true
require_output "KixDNS：已迁移为增强版，保持原来的运行状态（运行中）" "迁移结果没有说明保持运行状态"
require_output "配置：已复制到 /etc/kixdns-panel/kixdns/pipeline.json 由面板管理，原来的 ${CONFIG_PATH} 不动" \
  "迁移结果没有说明配置副本"
# 这个 GeoSite 谁都读得到，面板也读得到：安装结果不该提醒 / Everyone can read this GeoSite, the panel too: no notice
! grep -Fq 'Geo 文件：面板读不到' "${install_log}" || fail "面板读得到原配置里的 GeoSite，安装结果却提醒读不到"
systemctl is-active --quiet kixdns.service || fail "迁移后 KixDNS 没有保持运行"
systemctl is-enabled --quiet kixdns.service || fail "迁移后 KixDNS 没有保持开机自启"
[[ $(unit_main_executable kixdns.service) == /var/lib/kixdns-panel/bin/kixdns ]] ||
  fail "迁移后运行的不是增强版程序"
python3 "${ACCEPTANCE_PY}" dns --dns-port "${migration_port}"
[[ -f ${EXTERNAL_BACKUP}/install.env ]] || fail "迁移没有备份原 unit 与运行状态"
# 面板管理的是原配置的副本，放在面板自己建的目录里；面板 unit 只能写这个目录和状态目录。
# The panel manages a copy of the original config in a directory of its own; the panel unit may write only that and its state.
[[ $(original_config_state) == "${original_before}" ]] || fail "迁移改动了原配置或它所在的目录"
cmp -s -- "${CONFIG_PATH}" /etc/kixdns-panel/kixdns/pipeline.json || fail "迁移副本和原配置不一致"
[[ $(stat -c '%U:%G:%a' -- /etc/kixdns-panel/kixdns/pipeline.json) == kixdns-panel:kixdns:640 ]] ||
  fail "迁移副本的权限不符合预期"
[[ $(stat -c '%U:%G:%a' -- /etc/kixdns-panel/kixdns) == kixdns-panel:kixdns:750 ]] ||
  fail "迁移副本所在目录的权限不符合预期"
[[ $(stat -c '%U:%G:%a' -- /etc/kixdns-panel) == root:kixdns:750 ]] || fail "面板配置目录的权限不符合预期"
grep -Fxq 'KIXDNS_CONFIG=/etc/kixdns-panel/kixdns/pipeline.json' "${PANEL_ENV}" || fail "panel.env 没有指向迁移副本"
grep -Fq -- '--config /etc/kixdns-panel/kixdns/pipeline.json ' "${MIGRATION_UNIT}" || fail "增强版 unit 没有运行迁移副本"
grep -Fxq 'ReadWritePaths=/etc/kixdns-panel/kixdns /var/lib/kixdns-panel' /etc/systemd/system/kixdns-panel.service ||
  fail "面板 unit 放开了迁移副本所在目录以外的路径"
grep -Fxq "KIXDNS_CONFIG=${CONFIG_PATH}" "${EXTERNAL_BACKUP}/install.env" ||
  fail "迁移备份没有记下原配置"
grep -Fxq 'KIXDNS_MANAGED_CONFIG=/etc/kixdns-panel/kixdns/pipeline.json' "${EXTERNAL_BACKUP}/install.env" ||
  fail "迁移备份没有记下面板管理的副本"
# 在面板里改配置：改的是副本，原配置不变。/ Edit the config in the panel: the copy changes, the original does not.
python3 "${ACCEPTANCE_PY}" verify --dns-port "${migration_port}" --mode migrated
[[ $(original_config_state) == "${original_before}" ]] || fail "在面板里改配置改到了原配置"
! cmp -s -- "${CONFIG_PATH}" /etc/kixdns-panel/kixdns/pipeline.json || fail "面板保存的配置没有写进迁移副本"

# 第一次恢复保留面板数据：恢复完备份就用掉，保留的 panel.env 记下 KixDNS 已不归面板管。
# The first restore keeps the panel data: once restored the backup is used up, and the kept panel.env records that the
# KixDNS is no longer the panel's.
uninstall_log="$(mktemp)"
bash "${UNINSTALLER}" --remove-kixdns --keep-config --yes 2>&1 | tee "${uninstall_log}"
installed=false
grep -Fq "它用的是迁移前的配置 ${CONFIG_PATH}，面板改过的副本已删除。" "${uninstall_log}" ||
  fail "卸载没有说明用回了迁移前的配置"
rm -f -- "${uninstall_log}"
systemctl daemon-reload
cmp -s -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/original.service" || fail "卸载没有放回原来的 unit"
systemctl is-active --quiet kixdns.service || fail "卸载后原来的 KixDNS 没有恢复运行"
systemctl is-enabled --quiet kixdns.service || fail "卸载后原来的 KixDNS 没有恢复开机自启"
[[ $(unit_main_executable kixdns.service) == "${MIGRATION_ROOT}/kixdns" ]] ||
  fail "卸载后运行的不是原来的程序"
# 按迁移前的地址应答，说明原来的 KixDNS 跑的是迁移前的配置，不是面板改过的那份。
# Answering with the pre-migration address shows the original KixDNS runs the pre-migration config, not the panel's edit.
python3 "${ACCEPTANCE_PY}" dns --dns-port "${migration_port}"
[[ $(original_config_state) == "${original_before}" ]] || fail "卸载恢复后原配置或它所在的目录和迁移前不一样"
! systemctl is-active --quiet kixdns-panel.service || fail "卸载后面板服务仍在运行"
[[ ! -e ${EXTERNAL_BACKUP} ]] || fail "恢复以后仍留着迁移前的备份"
grep -Fxq 'KIXDNS_MANAGEMENT_ENABLED=false' "${PANEL_ENV}" || fail "恢复以后保留的 panel.env 没有记下 KixDNS 已不归面板管"

# 再迁移之前，主机上的 KixDNS 换了一份配置，改成不开机自启、照常运行。新配置写着一个只有 kixdns 账号读得到的 GeoSite
# （上次迁移建的账号还在）：KixDNS 读得到，面板读不到，迁移照常，安装结果点名它。
# Before migrating again, the host's KixDNS got another config and stopped starting at boot while still running. The new
# config names a GeoSite only the kixdns account can read (the account the last migration made is still there): KixDNS can
# read it, the panel cannot, migration goes ahead and the install result names it.
second_config="${MIGRATION_ROOT}/second.json"
kernel_only_geosite="${MIGRATION_ROOT}/kernel-only/geosite.dat"
second_port="$(python3 "${ACCEPTANCE_PY}" prepare --config "${second_config}" --geosite "${kernel_only_geosite}")"
[[ ${second_port} =~ ^[0-9]+$ ]] || fail "没有获得再迁移验收的 DNS 端口"
install -d -m 0755 "$(dirname -- "${kernel_only_geosite}")"
install -o kixdns -g kixdns -m 0600 "${PACKAGE_ROOT}/geo/geosite.dat" "${kernel_only_geosite}"
cat > "${MIGRATION_UNIT}" <<EOF
[Unit]
Description=验收用的外部 KixDNS（再迁移前换了配置）

[Service]
ExecStart=${MIGRATION_ROOT}/kixdns run --config ${second_config} --admin-socket /run/kixdns/admin.sock
RuntimeDirectory=kixdns
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
cp -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/second.service"
systemctl daemon-reload
systemctl disable kixdns.service
systemctl restart kixdns.service
python3 "${ACCEPTANCE_PY}" dns --dns-port "${second_port}"
second_config_state() {
  stat -c '%U:%G:%a' -- "${second_config}"
  sha256sum -- "${second_config}"
}
second_before="$(second_config_state)"

run_installer --replace-existing
installed=true
require_output "KixDNS：已迁移为增强版，保持原来的运行状态（运行中）" "再迁移的结果没有说明保持运行状态"
require_output "配置：已复制到 /etc/kixdns-panel/kixdns/pipeline.json 由面板管理，原来的 ${second_config} 不动" \
  "再迁移的结果没有说明配置副本"
require_output "Geo 文件：面板读不到原配置里写的这些" "面板读不到原配置里的 GeoSite 时安装结果没有提醒"
require_output "  ${kernel_only_geosite}：kixdns-panel 账号没有读取权限" "安装结果没有点名面板读不到的 GeoSite"
systemctl is-active --quiet kixdns.service || fail "再迁移后 KixDNS 没有保持运行"
! systemctl is-enabled --quiet kixdns.service || fail "再迁移后 KixDNS 不该开机自启"
[[ $(unit_main_executable kixdns.service) == /var/lib/kixdns-panel/bin/kixdns ]] ||
  fail "再迁移后运行的不是增强版程序"
python3 "${ACCEPTANCE_PY}" dns --dns-port "${second_port}"
cmp -s -- "${EXTERNAL_BACKUP}/kixdns.service" "${MIGRATION_ROOT}/second.service" ||
  fail "再迁移没有备份主机上现在的 unit"
grep -Fxq "KIXDNS_CONFIG=${second_config}" "${EXTERNAL_BACKUP}/install.env" ||
  fail "再迁移的备份没有记下现在的原配置"
grep -Fxq 'KIXDNS_WAS_ACTIVE=true' "${EXTERNAL_BACKUP}/install.env" ||
  fail "再迁移的备份没有记下现在在运行"
grep -Fxq 'KIXDNS_WAS_ENABLED=false' "${EXTERNAL_BACKUP}/install.env" ||
  fail "再迁移的备份没有记下现在不开机自启"
! grep -q '^KIXDNS_MANAGEMENT_ENABLED=' "${PANEL_ENV}" || fail "重新安装后 panel.env 还说 KixDNS 不归面板管"

# 第二次恢复回到第二次迁移之前：换过的 unit 和配置、不开机自启、在运行。
# The second restore goes back to just before the second migration: the changed unit and config, not enabled, running.
uninstall_log="$(mktemp)"
bash "${UNINSTALLER}" --remove-kixdns --remove-config --yes 2>&1 | tee "${uninstall_log}"
installed=false
grep -Fq "它用的是迁移前的配置 ${second_config}，面板改过的副本已删除。" "${uninstall_log}" ||
  fail "第二次恢复没有用回第二次迁移前的配置"
rm -f -- "${uninstall_log}"
systemctl daemon-reload
cmp -s -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/second.service" || fail "第二次恢复没有放回第二次迁移前的 unit"
systemctl is-active --quiet kixdns.service || fail "第二次恢复后原来的 KixDNS 没有运行"
! systemctl is-enabled --quiet kixdns.service || fail "第二次恢复把开机自启改回了第一次迁移前的样子"
[[ $(unit_main_executable kixdns.service) == "${MIGRATION_ROOT}/kixdns" ]] ||
  fail "第二次恢复后运行的不是原来的程序"
python3 "${ACCEPTANCE_PY}" dns --dns-port "${second_port}"
[[ $(second_config_state) == "${second_before}" ]] || fail "第二次恢复后原配置和第二次迁移前不一样"
[[ ! -e /etc/kixdns-panel ]] || fail "卸载后仍残留 /etc/kixdns-panel"
! systemctl is-active --quiet kixdns-panel.service || fail "卸载后面板服务仍在运行"

# v4.3.4 及更早原地迁移的主机：那时的迁移不复制，直接接管原配置，原配置的目录归面板（kixdns-panel:kixdns 0750）、面板 unit 的
# ReadWritePaths 放开它，备份里不记副本，panel.env 里还是旧示例的可信代理。先用这个包迁移一个外部 KixDNS，再把主机改回那时
# 留下的样子，然后在线更新（--panel-only-update）、再改回去完整重装各一次：都要改管副本，原配置一字不动地交还原来的 KixDNS。
# A host migrated in place by v4.3.4 or earlier: that migration made no copy and took the original config over, the
# original's directory belonging to the panel (kixdns-panel:kixdns 0750) and opened by the panel unit's ReadWritePaths, no
# copy in the backup, and the old example's trusted proxies in panel.env. Migrate an external KixDNS with this package, turn
# the host back into what that left, then run an online update (--panel-only-update) and, turned back again, a full
# reinstall: each must move onto the copy and hand the original, byte for byte, back to the original KixDNS.
legacy_directory="${MIGRATION_ROOT}/legacy"
legacy_config="${legacy_directory}/kixdns.json"
legacy_copy=/etc/kixdns-panel/kixdns/pipeline.json
legacy_port="$(python3 "${ACCEPTANCE_PY}" prepare --config "${legacy_config}")"
[[ ${legacy_port} =~ ^[0-9]+$ ]] || fail "没有获得旧版原地迁移验收的 DNS 端口"
chmod 0755 "${legacy_directory}"
cat > "${MIGRATION_UNIT}" <<EOF
[Unit]
Description=验收用的外部 KixDNS（旧版原地迁移）

[Service]
ExecStart=${MIGRATION_ROOT}/kixdns run --config ${legacy_config} --admin-socket /run/kixdns/admin.sock
RuntimeDirectory=kixdns
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
cp -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/legacy.service"
systemctl daemon-reload
systemctl enable kixdns.service
systemctl restart kixdns.service
python3 "${ACCEPTANCE_PY}" dns --dns-port "${legacy_port}"
legacy_sum="$(sha256sum < "${legacy_config}")"
run_installer --replace-existing
installed=true

# 把主机改回 v4.3.4 原地迁移留下的样子 / Turn the host back into what a v4.3.4 in-place migration left
make_legacy_in_place() {
  local temporary
  systemctl stop kixdns-panel.service
  temporary="$(mktemp /etc/kixdns-panel/.acceptance-env.XXXXXX)"
  awk -v config="${legacy_config}" '
    /^# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。默认谁都不信。$/ { next }
    /^# 面板在本机 Nginx 后面时写 / { next }
    /^KIXDNS_TRUSTED_PROXIES=/ {
      print "# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。"
      print "KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128"
      next
    }
    /^KIXDNS_CONFIG=/ { print "KIXDNS_CONFIG=" config; next }
    { print }
  ' "${PANEL_ENV}" > "${temporary}"
  chown root:kixdns "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${PANEL_ENV}"
  # 旧版的备份：没有副本、账号和 unit 内容的记录，放在面板的状态目录里（升级时挪进只有 root 能进的目录）
  # An older version's backup: no record of the copy, the accounts or the unit's content, kept in the panel's state
  # directory (an upgrade moves it into the root-only directory)
  sed -i -E '/^KIXDNS_(MANAGED_CONFIG|LEGACY_IN_PLACE|USER_CREATED|GROUP_CREATED|UNIT_FRAGMENT)=/d' "${EXTERNAL_BACKUP}/install.env"
  rm -f -- "${EXTERNAL_BACKUP}/unit-fragment" "${EXTERNAL_BACKUP}"/unit-dropin-*.conf
  mv -T -- "${EXTERNAL_BACKUP}" /var/lib/kixdns-panel/external-backup
  rmdir -- "${ROOT_RECORDS}" 2>/dev/null || true
  sed -i -e "s|--config [^ ]*|--config ${legacy_config}|" -e "s|^ConditionPathExists=.*|ConditionPathExists=${legacy_config}|" \
    "${MIGRATION_UNIT}"
  sed -i "s|^ReadWritePaths=.*|ReadWritePaths=${legacy_directory} /var/lib/kixdns-panel|" /etc/systemd/system/kixdns-panel.service
  chown kixdns-panel:kixdns "${legacy_directory}" "${legacy_config}"
  chmod 0750 "${legacy_directory}"
  chmod 0640 "${legacy_config}"
  rm -rf -- /etc/kixdns-panel/kixdns
  systemctl daemon-reload
  systemctl restart kixdns.service
  systemctl start kixdns-panel.service
  python3 "${ACCEPTANCE_PY}" dns --dns-port "${legacy_port}"
}

# 改管副本以后应有的样子。参数：安装结果里说 KixDNS 的那一行。/ What the host must look like once on the copy. Argument: the
# install result's line about KixDNS.
require_legacy_converted() {
  require_output "$1" "改管副本时没有说明 KixDNS 怎样了"
  require_output "配置：改为管理副本 ${legacy_copy}，以后在面板里改的都写进副本；原配置 ${legacy_config} 留着升级这时的内容，交还给原来的 KixDNS" \
    "改管副本时没有说明配置的去向"
  require_output "旧版迁移时把原配置交给了面板，没有记下它原来的属主和权限，这次改成：" "改管副本时没有说明改了属主"
  require_output "  ${legacy_directory}：kixdns-panel:kixdns 0750 → root:root 0755" "改管副本时没有列出交还的目录"
  # 原来的 KixDNS 以 root 运行，原配置只留给 root / The original KixDNS runs as root, so the original is left to root alone
  require_output "  ${legacy_config}：kixdns-panel:kixdns 0640 → root:root 0600" "改管副本时没有列出交还的原配置"
  require_output "反向代理：panel.env 还信任本机代理（旧版的默认值 127.0.0.1/32,::1/128）" "旧版的可信代理默认值留着时没有提醒"
  [[ $(stat -c '%U:%G:%a' -- "${legacy_directory}") == root:root:755 ]] || fail "原配置的目录没有交还 root"
  [[ $(stat -c '%U:%G:%a' -- "${legacy_config}") == root:root:600 ]] || fail "原配置没有交还 root"
  [[ $(sha256sum < "${legacy_config}") == "${legacy_sum}" ]] || fail "改管副本时改了原配置的内容"
  cmp -s -- "${legacy_config}" "${legacy_copy}" || fail "副本和原配置不一样"
  [[ $(stat -c '%U:%G:%a' -- "${legacy_copy}") == kixdns-panel:kixdns:640 ]] || fail "副本的权限不符合预期"
  grep -Fxq "KIXDNS_CONFIG=${legacy_copy}" "${PANEL_ENV}" || fail "panel.env 没有改指副本"
  grep -Fq -- "--config ${legacy_copy} " "${MIGRATION_UNIT}" || fail "KixDNS 的 unit 没有改指副本"
  grep -Fxq 'ReadWritePaths=/etc/kixdns-panel/kixdns /var/lib/kixdns-panel' /etc/systemd/system/kixdns-panel.service ||
    fail "面板 unit 还能写原配置的目录"
  grep -Fxq "KIXDNS_MANAGED_CONFIG=${legacy_copy}" "${EXTERNAL_BACKUP}/install.env" || fail "备份没有记下副本"
  grep -Fxq 'KIXDNS_LEGACY_IN_PLACE=true' "${EXTERNAL_BACKUP}/install.env" || fail "备份没有记下这是旧版原地迁移"
  [[ ! -e /var/lib/kixdns-panel/external-backup ]] || fail "旧版放在面板状态目录里的备份没有挪进只有 root 能进的目录"
  [[ $(stat -c '%U:%G:%a' -- "${ROOT_RECORDS}") == root:root:700 ]] || fail "备份所在的目录不是只有 root 能进"
  grep -Fxq 'KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128' "${PANEL_ENV}" || fail "升级改掉了用户的可信代理"
  ! grep -Fxq '# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。' "${PANEL_ENV}" || fail "旧的可信代理说明没有换掉"
  # 面板账号不能再在原配置的目录里建文件 / The panel account can no longer create files in the original's directory
  ! setpriv --reuid=kixdns-panel --regid=kixdns --init-groups -- touch "${legacy_directory}/.acceptance-probe" 2>/dev/null ||
    fail "面板账号还能写原配置的目录"
  systemctl is-active --quiet kixdns.service || fail "改管副本以后 KixDNS 没有保持运行"
  [[ $(unit_main_executable kixdns.service) == /var/lib/kixdns-panel/bin/kixdns ]] || fail "改管副本以后运行的不是增强版"
  python3 "${ACCEPTANCE_PY}" dns --dns-port "${legacy_port}"
}

make_legacy_in_place
run_installer --panel-only-update --reinstall
require_legacy_converted "KixDNS：程序未替换，unit 改用新的配置路径，已按原状态重启（运行中）"
make_legacy_in_place
run_installer --reinstall
require_legacy_converted "KixDNS：已替换并按原状态重启（运行中）"
# 在面板里改配置：写进副本，原配置不变 / Edit the config in the panel: the copy changes, the original does not
python3 "${ACCEPTANCE_PY}" verify --dns-port "${legacy_port}" --mode migrated
[[ $(sha256sum < "${legacy_config}") == "${legacy_sum}" ]] || fail "在面板里改配置改到了原配置"
uninstall_log="$(mktemp)"
bash "${UNINSTALLER}" --remove-kixdns --remove-config --yes 2>&1 | tee "${uninstall_log}"
installed=false
grep -Fq "它用的配置 ${legacy_config} 是升级到新版那时面板保存的内容" "${uninstall_log}" ||
  fail "旧版原地迁移的主机恢复时没有照实说原配置里是什么"
rm -f -- "${uninstall_log}"
systemctl daemon-reload
cmp -s -- "${MIGRATION_UNIT}" "${MIGRATION_ROOT}/legacy.service" || fail "卸载没有放回旧版原地迁移前的 unit"
systemctl is-active --quiet kixdns.service || fail "卸载后原来的 KixDNS 没有运行"
[[ $(unit_main_executable kixdns.service) == "${MIGRATION_ROOT}/kixdns" ]] || fail "卸载后运行的不是原来的程序"
python3 "${ACCEPTANCE_PY}" dns --dns-port "${legacy_port}"
[[ ! -e /etc/kixdns-panel ]] || fail "卸载后仍残留 /etc/kixdns-panel"
remove_migration_fixture
migration_fixture=false

rm -f -- "${install_log}"
trap - EXIT
printf '完整包安装、同版本重跑、修复安装、运行联调、迁移、恢复后再迁移、旧版原地迁移改管副本与卸载验收通过。\n'
