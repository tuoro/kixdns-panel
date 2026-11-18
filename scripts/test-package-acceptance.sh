#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_PATH=/etc/kixdns/pipeline.json
PANEL_ENV=/etc/kixdns-panel/panel.env
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
systemctl is-active --quiet kixdns.service || fail "迁移后 KixDNS 没有保持运行"
systemctl is-enabled --quiet kixdns.service || fail "迁移后 KixDNS 没有保持开机自启"
[[ $(unit_main_executable kixdns.service) == /var/lib/kixdns-panel/bin/kixdns ]] ||
  fail "迁移后运行的不是增强版程序"
python3 "${ACCEPTANCE_PY}" dns --dns-port "${migration_port}"
[[ -f /var/lib/kixdns-panel/external-backup/install.env ]] || fail "迁移没有备份原 unit 与运行状态"
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
grep -Fxq "KIXDNS_CONFIG=${CONFIG_PATH}" /var/lib/kixdns-panel/external-backup/install.env ||
  fail "迁移备份没有记下原配置"
grep -Fxq 'KIXDNS_MANAGED_CONFIG=/etc/kixdns-panel/kixdns/pipeline.json' /var/lib/kixdns-panel/external-backup/install.env ||
  fail "迁移备份没有记下面板管理的副本"
# 在面板里改配置：改的是副本，原配置不变。/ Edit the config in the panel: the copy changes, the original does not.
python3 "${ACCEPTANCE_PY}" verify --dns-port "${migration_port}" --mode migrated
[[ $(original_config_state) == "${original_before}" ]] || fail "在面板里改配置改到了原配置"
! cmp -s -- "${CONFIG_PATH}" /etc/kixdns-panel/kixdns/pipeline.json || fail "面板保存的配置没有写进迁移副本"

uninstall_log="$(mktemp)"
bash "${UNINSTALLER}" --remove-kixdns --remove-config --yes 2>&1 | tee "${uninstall_log}"
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
[[ ! -e /etc/kixdns-panel ]] || fail "卸载后仍残留 /etc/kixdns-panel"
! systemctl is-active --quiet kixdns-panel.service || fail "卸载后面板服务仍在运行"
remove_migration_fixture
migration_fixture=false

rm -f -- "${install_log}"
trap - EXIT
printf '完整包安装、同版本重跑、修复安装、运行联调、迁移与卸载验收通过。\n'
