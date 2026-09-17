#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2030,SC2031,SC2034,SC2317,SC2329
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf -- "${WORK}"' EXIT

assert_equals() {
  local actual=$1
  local expected=$2
  local message=$3
  [[ ${actual} == "${expected}" ]] || {
    printf '断言失败：%s（期望 %s，实际 %s）\n' "${message}" "${expected}" "${actual}" >&2
    exit 1
  }
}

# 在伪终端里运行一段脚本：真实用户看到的是终端，/dev/tty 提示、stderr 与 Ctrl-C 都只有在 pty 里才测得出来。
# 参数：脚本，然后成对的「等待出现的文本」「要做的事（输入文本，或 INT/TERM/HUP）」。输出末尾追加 EXIT=<退出码>。
# Run a script inside a pseudo terminal: /dev/tty prompts, stderr and Ctrl-C only behave like a
# user's session there. Arguments: the script, then pairs of "text to wait for" and "action"
# (text to type, or INT/TERM/HUP). The output ends with EXIT=<status>.
run_in_pty() {
  python3 - "$@" <<'PY'
import os, pty, select, signal, sys, time

script, steps = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", script])
output = b""
consumed = 0
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    if steps:
        position = output.find(steps[0].encode(), consumed)
        if position >= 0:
            consumed = position + len(steps[0].encode())
            action = steps[1]
            steps = steps[2:]
            if action == "INT":
                os.write(fd, b"\x03")
            elif action in ("TERM", "HUP"):
                os.kill(pid, getattr(signal, "SIG" + action))
            else:
                os.write(fd, action.encode() + b"\n")
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
else:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.write(output.decode(errors="replace").replace("\r\n", "\n"))
sys.stdout.write(f"\nEXIT={code}\n")
PY
}

# 没有控制终端地运行，模拟 CI、cron 和 `curl | sudo bash` 之外的无人值守场景。
# Run without a controlling terminal, as CI, cron and other unattended runs do.
run_without_tty() {
  setsid -w bash -c "$1" < /dev/null 2>&1 || true
}

assert_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} == *"${needle}"* ]] || {
    printf '断言失败：%s\n实际输出：\n%s\n' "${message}" "${haystack}" >&2
    exit 1
  }
}

assert_not_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} != *"${needle}"* ]] || {
    printf '断言失败：%s\n实际输出：\n%s\n' "${message}" "${haystack}" >&2
    exit 1
  }
}

# ---------------------------------------------------------------------------
# 迁移提示 / Migration prompt
# ---------------------------------------------------------------------------

migration_fixture="
  source '${INSTALLER}'
  systemctl() {
    case \$1 in
      cat | is-active | is-enabled) return 0 ;;
      *) return 1 ;;
    esac
  }
  KIXDNS_CONFIG_PATH='${INSTALLER}'
  KIXDNS_BINARY_PATH='${INSTALLER}'
  INSTALL_MODE=auto
  detect_existing_kixdns
"

# 回归：终端提示之后 stderr 不能被永久吞掉，否则取消与失败信息用户都看不到。
# Regression: stderr must not stay swallowed after the tty prompt, or cancel and failure messages vanish.
output="$(run_in_pty "${migration_fixture}
  choose_install_mode
" ']：' n)"
assert_contains "${output}" "已取消安装，现有 KixDNS 未作修改。" "终端里取消安装必须看得到取消提示"
assert_not_contains "${output}" "安装失败" "取消是用户的选择，不应带安装失败前缀"
assert_contains "${output}" "EXIT=1" "取消安装应以非零状态退出"
assert_contains "${output}" "服务：kixdns.service（运行中，开机自启）" "提示应说明检测到的 unit 与运行状态"
assert_contains "${output}" "把原 unit 与运行状态备份到 /var/lib/kixdns-panel/external-backup" "提示应说明备份位置"
assert_contains "${output}" "保持原来的运行状态（现在运行中）" "提示应说明运行状态会被保持"
assert_contains "${output}" "迁移为增强版？[y/N]：" "提示应以默认否的问题结尾"

output="$(run_in_pty "${migration_fixture}
  choose_install_mode
  printf 'MODE=%s\n' \"\${INSTALL_MODE}\"
" ']：' y)"
assert_contains "${output}" "MODE=managed" "回答 y 应迁移为增强版"

output="$(run_in_pty "${migration_fixture}
  choose_install_mode
  printf 'MODE=%s\n' \"\${INSTALL_MODE}\"
" ']：' maybe ']：' 2 ']：' '?')"
assert_contains "${output}" "请输入 y 或 n。" "认不出的回答应提示重新输入"
assert_contains "${output}" "已取消安装，现有 KixDNS 未作修改。" "连续三次认不出应取消安装"
assert_not_contains "${output}" "MODE=managed" "认不出的回答不能被当作同意"

output="$(run_without_tty "${migration_fixture}
  choose_install_mode
  printf 'MODE=%s\n' \"\${INSTALL_MODE}\"
")"
assert_not_contains "${output}" "MODE=managed" "无人值守安装不能默认迁移"
assert_contains "${output}" "sudo bash ./scripts/install.sh --replace-existing" "无人值守提示应给出安装包命令"
assert_contains "${output}" "| sudo bash -s -- --replace-existing" "无人值守提示应给出一键安装命令"

# ---------------------------------------------------------------------------
# 中断回滚 / Interrupt rollback
# ---------------------------------------------------------------------------

# 回归：Ctrl-C、SIGTERM、SSH 断线都必须触发回滚，不能留下被停掉的服务。
# Regression: Ctrl-C, SIGTERM and an SSH hangup must all roll back instead of leaving services stopped.
for signal_name in INT TERM HUP; do
  output="$(run_in_pty "
    source '${INSTALLER}'
    backup_path() { :; }
    restore_path() { :; }
    restore_managed_config() { :; }
    systemctl() { :; }
    INSTALL_MODE=managed
    PANEL_ONLY_UPDATE=false
    prepare_rollback
    printf 'READY\n'
    sleep 20
    printf 'NOT-INTERRUPTED\n'
  " READY "${signal_name}")"
  assert_contains "${output}" "安装被中断" "${signal_name} 后必须回滚并说明安装被中断"
  assert_not_contains "${output}" "NOT-INTERRUPTED" "${signal_name} 后不能继续安装"
done

# ---------------------------------------------------------------------------
# 参数 / Arguments
# ---------------------------------------------------------------------------

help="$(bash "${INSTALLER}" --help)"
assert_contains "${help}" "--replace-existing" "帮助应说明迁移参数"
assert_contains "${help}" "--reinstall" "帮助应说明修复安装参数"
assert_contains "${help}" "--panel-only-update" "帮助应说明仅更新面板参数"
assert_not_contains "${help}" "--keep-existing" "帮助不应再出现已移除的模式"

output="$(bash "${INSTALLER}" --keep-existing 2>&1 || true)"
assert_contains "${output}" "「仅安装面板」模式已移除" "旧参数应明确说明模式已移除"
assert_contains "${output}" "--replace-existing" "旧参数应指向迁移参数"
assert_contains "${output}" "恢复原来的 KixDNS" "旧参数应说明迁移可以撤销"

source "${INSTALLER}"
# 在线更新器声明了只读的 PANEL_ENV，放进子 shell 以免锁住下面测试要改的同名变量。
# The online updater declares PANEL_ENV readonly; source it in a subshell so tests below can still change it.
(source "${PACKAGE_ROOT}/scripts/panel-online-update.sh")

INSTALL_MODE="auto"
parse_arguments --replace-existing --reinstall --kixdns-unit kixdns@edge.service
assert_equals "${INSTALL_MODE}" "managed" "显式迁移参数应启用受管模式"
assert_equals "${REINSTALL}" "true" "--reinstall 应强制重新安装"
assert_equals "${KIXDNS_SERVICE_UNIT}" "kixdns@edge.service" "自定义 unit 应被保留"

if (parse_arguments --unknown-option) 2>/dev/null; then
  printf '断言失败：未知安装参数不应被接受\n' >&2
  exit 1
fi

INSTALL_MODE="auto"
EXISTING_KIXDNS=false
choose_install_mode
assert_equals "${INSTALL_MODE}" "managed" "新主机应安装面板管理的增强版"

KIXDNS_SERVICE_UNIT="kixdns@primary.service"
validate_unit

if (
  KIXDNS_CONFIG_PATH=/pipeline.json
  KIXDNS_BINARY_PATH=/var/lib/kixdns-panel/bin/kixdns
  KIXDNS_CONTROL_SOCKET=/run/kixdns/admin.sock
  validate_install_mode
) 2>/dev/null; then
  printf '断言失败：受管配置不能直接放在根目录\n' >&2
  exit 1
fi
KIXDNS_SERVICE_UNIT=kixdns.service

# ---------------------------------------------------------------------------
# 旧「仅安装面板」主机 / Legacy panel-only hosts
# ---------------------------------------------------------------------------

PANEL_ENV="${WORK}/panel.env"
PANEL_SERVER_BINARY="${WORK}/kixdns-panel-server"
: > "${PANEL_SERVER_BINARY}"
printf 'KIXDNS_MANAGEMENT_ENABLED=false\n' > "${PANEL_ENV}"
output="$( (refuse_legacy_panel) 2>&1 || true)"
assert_contains "${output}" "已移除的「仅安装面板」模式" "旧模式主机应被拒绝"
assert_contains "${output}" "sudo kixdns-panel-uninstall" "旧模式主机应先卸载"
assert_contains "${output}" "选择迁移为增强版" "旧模式主机应重新安装并迁移"
printf 'KIXDNS_MANAGEMENT_ENABLED=true\n' > "${PANEL_ENV}"
refuse_legacy_panel
: > "${PANEL_ENV}"
refuse_legacy_panel
# 回归：按提示卸载面板并保留配置后，只剩 panel.env 而没有面板程序；这时再拒绝就再也装不上了。
# Regression: after uninstalling as advised and keeping the config, only panel.env remains without the
# panel program; refusing then would block the install forever.
rm -f -- "${PANEL_SERVER_BINARY}"
printf 'KIXDNS_MANAGEMENT_ENABLED=false\n' > "${PANEL_ENV}"
output="$( (refuse_legacy_panel; printf 'CONTINUED\n') 2>&1 || true)"
assert_contains "${output}" "CONTINUED" "只剩旧 panel.env、面板程序已卸载时应允许重新安装"
assert_not_contains "${output}" "已移除的「仅安装面板」模式" "面板程序已卸载时不应再拒绝"

# ---------------------------------------------------------------------------
# 安装前以 root 写入的 GitHub Token / A GitHub token written by root before installing
# ---------------------------------------------------------------------------

# 一键安装遇到限流时让用户先用 sudo 写入 Token；面板以 kixdns-panel 运行，读不了 root 的 0600 文件。
# One-click install tells rate-limited users to write the token with sudo; the panel runs as
# kixdns-panel and cannot read a root-owned 0600 file.
token_adoption() {
  (
    GITHUB_TOKEN_FILE="${WORK}/github-token"
    chown() { printf 'chown %s\n' "$*"; }
    chmod() { printf 'chmod %s\n' "$*"; }
    adopt_github_token
    printf 'CONTINUED\n'
  ) 2>&1 || true
}
rm -f -- "${WORK}/github-token"
printf 'ghp_example\n' > "${WORK}/github-token"
output="$(token_adoption)"
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${WORK}/github-token" "安装前写入的 Token 应归面板账号所有"
assert_contains "${output}" "chmod 0600 -- ${WORK}/github-token" "安装前写入的 Token 应为 0600"
assert_contains "${output}" "CONTINUED" "收归 Token 后应继续安装"
rm -f -- "${WORK}/github-token"
output="$(token_adoption)"
assert_not_contains "${output}" "chown" "没有 Token 文件时不应改动任何文件"
assert_contains "${output}" "CONTINUED" "没有 Token 文件时应继续安装"
ln -s /etc/passwd "${WORK}/github-token"
output="$(token_adoption)"
assert_not_contains "${output}" "chown" "Token 路径是符号链接时不应改动所有者"
assert_contains "${output}" "CONTINUED" "Token 路径是符号链接时交给面板报告"
rm -f -- "${WORK}/github-token"

# ---------------------------------------------------------------------------
# 同一版本 / Same version
# ---------------------------------------------------------------------------

same_version_output() {
  local panel_active=${5:-true}
  (
    EXISTING_PANEL=$1
    PANEL_RELEASE=$2
    PANEL_BUILD_COMMIT=$3
    REINSTALL=$4
    systemctl() { [[ $1 == is-active && ${panel_active} == true ]]; }
    skip_if_already_installed
    printf 'CONTINUED REINSTALL=%s\n' "${REINSTALL}"
  ) 2>&1
}
commit_a=$(printf 'a%.0s' {1..40})
commit_b=$(printf 'b%.0s' {1..40})
printf 'KIXDNS_PANEL_INSTALLED_RELEASE=v3.1.1\nKIXDNS_PANEL_INSTALLED_COMMIT=%s\n' "${commit_a}" > "${PANEL_ENV}"
output="$(same_version_output true v3.1.1 "${commit_b}" false)"
assert_contains "${output}" "KixDNS Panel v3.1.1 已安装，未作任何修改。" "同一 Release 再次运行应直接退出"
assert_contains "${output}" "--reinstall" "同一版本提示应说明如何修复安装"
assert_not_contains "${output}" "CONTINUED" "同一 Release 不应继续安装"
output="$(same_version_output true v3.1.1 "${commit_b}" true)"
assert_contains "${output}" "CONTINUED" "--reinstall 应继续安装"
# 同一版本但面板没在运行：说「未作任何修改」就是把坏掉的安装当成好的，应按 --reinstall 修复。
# Same version but the panel is not running: "nothing changed" would pass off a broken install as fine; repair as --reinstall.
output="$(same_version_output true v3.1.1 "${commit_b}" false false)"
assert_contains "${output}" "KixDNS Panel v3.1.1 已安装，但面板没有在运行" "同版本面板未运行时应说明原因"
assert_not_contains "${output}" "未作任何修改" "面板未运行时不能说未作修改"
assert_contains "${output}" "CONTINUED REINSTALL=true" "面板未运行时应按 --reinstall 继续修复安装"
output="$(same_version_output true v3.1.2 "${commit_a}" false)"
assert_contains "${output}" "CONTINUED" "不同 Release 应继续安装"
output="$(same_version_output false v3.1.1 "${commit_a}" false)"
assert_contains "${output}" "CONTINUED" "没有已安装面板时应继续安装"
printf 'KIXDNS_PANEL_INSTALLED_COMMIT=%s\n' "${commit_a^^}" > "${PANEL_ENV}"
output="$(same_version_output true '' "${commit_a}" false)"
assert_contains "${output}" "构建 aaaaaaaaaaaa 已安装" "开发构建应按提交判断同一版本"
output="$(same_version_output true v3.1.1 "${commit_b}" false)"
assert_contains "${output}" "CONTINUED" "开发构建提交不同应继续安装"

# ---------------------------------------------------------------------------
# 安装类型与 KixDNS 变更计划 / Install kind and KixDNS change plan
# ---------------------------------------------------------------------------

install_kind_of() {
  (
    PANEL_ONLY_UPDATE=$1
    EXISTING_PANEL=$2
    EXISTING_KIXDNS=$3
    PRESERVE_KIXDNS_STATE=false
    determine_install_kind
    printf '%s %s\n' "${INSTALL_KIND}" "${PRESERVE_KIXDNS_STATE}"
  )
}
assert_equals "$(install_kind_of false false false)" "fresh false" "新主机是首次安装"
assert_equals "$(install_kind_of false false true)" "migrate true" "已有非面板 KixDNS 是迁移并保持状态"
assert_equals "$(install_kind_of false true true)" "upgrade true" "已有面板是升级并保持状态"
assert_equals "$(install_kind_of true true true)" "panel-only false" "仅更新面板不碰 KixDNS 状态"

package_fixture="${WORK}/package"
mkdir -p "${package_fixture}/bin" "${package_fixture}/deploy/systemd" "${WORK}/units" "${WORK}/managed"
cp "${PACKAGE_ROOT}/deploy/systemd/kixdns.service" "${package_fixture}/deploy/systemd/"
printf 'kixdns-v1\n' > "${package_fixture}/bin/kixdns"
plan_of() {
  (
    PACKAGE_ROOT=${package_fixture}
    SYSTEMD_UNIT_DIRECTORY="${WORK}/units"
    MANAGED_KIXDNS_BINARY="${WORK}/managed/kixdns"
    INSTALL_KIND=$1
    KIXDNS_WAS_ACTIVE=$2
    plan_kixdns_changes
    printf 'binary=%s unit=%s restart=%s\n' "${KIXDNS_BINARY_CHANGED}" "${KIXDNS_UNIT_CHANGED}" "${KIXDNS_RESTART}"
  )
}
assert_equals "$(plan_of fresh false)" "binary=true unit=true restart=false" "首次安装写入程序和 unit，但不启动"
assert_equals "$(plan_of migrate true)" "binary=true unit=true restart=true" "迁移运行中的 KixDNS 要替换并重启"
cp "${package_fixture}/bin/kixdns" "${WORK}/managed/kixdns"
(
  PACKAGE_ROOT=${package_fixture}
  render_kixdns_unit > "${WORK}/units/kixdns.service"
)
assert_equals "$(plan_of upgrade true)" "binary=false unit=false restart=false" "程序和 unit 都没变时不能重启 KixDNS"
printf 'kixdns-v2\n' > "${package_fixture}/bin/kixdns"
assert_equals "$(plan_of upgrade true)" "binary=true unit=false restart=true" "程序变化时重启运行中的 KixDNS"
assert_equals "$(plan_of upgrade false)" "binary=true unit=false restart=false" "已停止的 KixDNS 替换后保持停止"
cp "${package_fixture}/bin/kixdns" "${WORK}/managed/kixdns"
printf '# 手工改动\n' >> "${WORK}/units/kixdns.service"
assert_equals "$(plan_of upgrade true)" "binary=false unit=true restart=true" "unit 变化时重启运行中的 KixDNS"
assert_equals "$(plan_of panel-only true)" "binary=false unit=false restart=false" "仅更新面板从不动 KixDNS"

# ---------------------------------------------------------------------------
# 端口 53 / Port 53
# ---------------------------------------------------------------------------

LISTENERS=""
ss() { printf '%s\n' "${LISTENERS}"; }
RESOLVED_LISTENERS='udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=620,fd=13))
tcp   LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=620,fd=14))
tcp   LISTEN 0      4096   0.0.0.0:22              0.0.0.0:*    users:(("sshd",pid=700,fd=3))'
DNSMASQ_LISTENERS='udp   UNCONN 0      0      0.0.0.0:53        0.0.0.0:*    users:(("dnsmasq",pid=812,fd=4))'
KIXDNS_LISTENERS='udp   UNCONN 0      0      0.0.0.0:53        0.0.0.0:*    users:(("kixdns",pid=900,fd=9))'
config_fixture="${WORK}/pipeline.json"
write_config() {
  printf '{\n  "settings": {\n    "bind_udp": "%s",\n    "bind_tcp": "%s"\n  }\n}\n' "$1" "$1" > "${config_fixture}"
}
conflict_of() {
  (
    LISTENERS=$1
    KIXDNS_CONFIG_PATH=${config_fixture}
    find_port_conflict
    printf '%s %s %s %s\n' "${PORT_CONFLICT}" "${PORT_CONFLICT_PORT}" "${PORT_HOLDER_NAME}" "${PORT_HOLDER_PID}"
  )
}
write_config 0.0.0.0:53
assert_equals "$(conflict_of "${RESOLVED_LISTENERS}")" "resolved 53 systemd-resolve 620" "通配地址与 resolved 的 127.0.0.53 冲突"
assert_equals "$(conflict_of "${DNSMASQ_LISTENERS}")" "other 53 dnsmasq 812" "其他程序占用时报告进程名和 PID"
assert_equals "$(conflict_of "${KIXDNS_LISTENERS}")" "none   " "KixDNS 自己占用端口不算冲突"
assert_equals "$(conflict_of "${RESOLVED_LISTENERS}"$'\n'"${DNSMASQ_LISTENERS}")" "other 53 dnsmasq 812" \
  "同时有 resolved 和其他程序时，优先报告其他程序"
write_config 192.168.1.2:53
assert_equals "$(conflict_of "${RESOLVED_LISTENERS}")" "none   " "具体地址不与 127.0.0.53 冲突"
write_config 127.0.0.1:5353
assert_equals "$(conflict_of "${RESOLVED_LISTENERS}")" "none   " "其他端口不冲突"
rm -f -- "${config_fixture}"
assert_equals "$( (KIXDNS_CONFIG_PATH=${config_fixture}; kixdns_listen_addresses) | tr '\n' ' ')" \
  "udp 0.0.0.0:53 tcp 0.0.0.0:53 " "没有配置时按安装包默认配置检查端口"
write_config 0.0.0.0:53

resolv_fixture="${WORK}/resolv"
mkdir -p "${resolv_fixture}/run" "${resolv_fixture}/etc"
printf 'nameserver 127.0.0.53\n' > "${resolv_fixture}/run/stub-resolv.conf"
printf 'nameserver 192.0.2.1\n' > "${resolv_fixture}/run/resolv.conf"
port53_fixture="
  source '${INSTALLER}'
  ss() { printf '%s\n' '${RESOLVED_LISTENERS}'; }
  KIXDNS_CONFIG_PATH='${config_fixture}'
  RESOLV_CONF='${resolv_fixture}/etc/resolv.conf'
  ln -sfn '../run/stub-resolv.conf' \"\${RESOLV_CONF}\"
  INSTALL_KIND=fresh
"
output="$(run_in_pty "${port53_fixture}
  plan_port53
  printf 'ACTION=%s\n' \"\${RESOLVED_ACTION}\"
" ']：' y)"
assert_contains "${output}" "端口 53 被 systemd-resolved 的本机 DNS 缓存（127.0.0.53）占用" "应说明谁占用了端口"
assert_contains "${output}" "改为指向 /run/systemd/resolve/resolv.conf" "resolv.conf 指向本机缓存时应说明会改指向"
assert_contains "${output}" "关闭 systemd-resolved 的 53 端口监听？[y/N]：" "应询问是否关闭监听"
assert_contains "${output}" "ACTION=disable-stub" "同意后应计划关闭监听"
output="$(run_in_pty "${port53_fixture}
  plan_port53
  printf 'ACTION=%s\n' \"\${RESOLVED_ACTION}\"
" ']：' '')"
assert_contains "${output}" "ACTION=none" "默认不改动 systemd-resolved"
assert_contains "${output}" "安装完成后会给出手动处理的命令" "拒绝后应说明之后怎么办"
output="$(run_without_tty "${port53_fixture}
  plan_port53
  printf 'ACTION=%s\n' \"\${RESOLVED_ACTION}\"
")"
assert_contains "${output}" "ACTION=none" "无人值守安装不改动 systemd-resolved"
output="$(run_without_tty "${port53_fixture}
  INSTALL_KIND=migrate
  KIXDNS_RESTART=true
  plan_port53
  printf 'CONTINUED\n'
")"
assert_contains "${output}" "替换后的 KixDNS 无法启动" "要重启 KixDNS 而端口被占时应在改动主机前停下"
assert_contains "${output}" "DNSStubListener=no" "停下时应给出手动关闭命令"
assert_not_contains "${output}" "CONTINUED" "端口被占且要重启 KixDNS 时不能继续"
output="$(run_without_tty "
  source '${INSTALLER}'
  ss() { printf '%s\n' '${DNSMASQ_LISTENERS}'; }
  KIXDNS_CONFIG_PATH='${config_fixture}'
  INSTALL_KIND=upgrade
  KIXDNS_RESTART=true
  plan_port53
  printf 'CONTINUED\n'
")"
assert_contains "${output}" "被 dnsmasq（PID 812）占用" "其他程序占用时应报告进程"
assert_not_contains "${output}" "CONTINUED" "其他程序占用且要重启 KixDNS 时不能继续"

# 关闭与恢复 systemd-resolved 的本机监听。install 不能以普通用户改属主，测试里去掉 -o/-g。
# Turning systemd-resolved's stub off and back on. install cannot chown as a normal user, so drop -o/-g here.
install() {
  local arguments=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      -o | -g) shift ;;
      *) arguments+=("$1") ;;
    esac
    shift
  done
  command install "${arguments[@]}"
}
resolved_round_trip() {
  local kind=$1
  (
    RESOLVED_DROPIN="${WORK}/rt/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${WORK}/rt/resolv.conf"
    RESOLVED_UPLINK_RESOLV_CONF="${resolv_fixture}/run/resolv.conf"
    RESOLVED_STATE="${WORK}/rt/state"
    rm -rf -- "${WORK}/rt"
    mkdir -p "${WORK}/rt"
    if [[ ${kind} == symlink ]]; then
      ln -s ../run/systemd/resolve/stub-resolv.conf "${RESOLV_CONF}"
    else
      printf '# 手写\nnameserver 127.0.0.53\n' > "${RESOLV_CONF}"
    fi
    systemctl() { printf 'systemctl %s\n' "$*"; }
    # 用真实的 find_port_conflict：重启后 ss 里已经没有 resolved，它会清空冲突信息，结果里的端口号不能跟着丢。
    # Use the real find_port_conflict: after the restart ss no longer lists resolved and it clears the
    # conflict details, which must not blank the port in the summary.
    ss() { :; }
    KIXDNS_CONFIG_PATH=${config_fixture}
    name_resolution_works() { return 0; }
    PORT_CONFLICT=resolved
    PORT_CONFLICT_PORT=53
    RESOLVED_ACTION=disable-stub
    disable_resolved_stub
    printf 'DROPIN=%s\n' "$(tr '\n' ' ' < "${RESOLVED_DROPIN}")"
    printf 'AFTER=%s\n' "$(readlink "${RESOLV_CONF}")"
    printf 'CHANGED=%s\n' "${RESOLVED_CHANGED}"
    print_port53_notice
    restore_resolved_stub
    if [[ -L ${RESOLV_CONF} ]]; then
      printf 'RESTORED=link:%s\n' "$(readlink "${RESOLV_CONF}")"
    else
      printf 'RESTORED=file:%s\n' "$(tr '\n' ' ' < "${RESOLV_CONF}")"
    fi
    [[ -e ${RESOLVED_DROPIN} ]] && printf 'DROPIN-LEFT\n'
    [[ -e $(dirname -- "${RESOLVED_DROPIN}") ]] && printf 'DROPIN-DIRECTORY-LEFT\n'
    [[ -e ${RESOLVED_STATE} ]] && printf 'STATE-LEFT\n'
    true
  ) 2>&1
}
output="$(resolved_round_trip symlink)"
assert_contains "${output}" "DROPIN=[Resolve] DNSStubListener=no " "应写入关闭本机监听的 drop-in"
assert_contains "${output}" "AFTER=${resolv_fixture}/run/resolv.conf" "resolv.conf 应改指向上游列表"
assert_contains "${output}" "systemctl restart systemd-resolved.service" "改动后应重启 systemd-resolved"
assert_contains "${output}" "RESTORED=link:../run/systemd/resolve/stub-resolv.conf" "恢复时应还原原来的符号链接"
assert_contains "${output}" "端口 53：已关闭 systemd-resolved 的本机监听" "关闭监听后结果应写明端口号"
assert_not_contains "${output}" "LEFT" "恢复后不应残留 drop-in、目录或记录"
output="$(resolved_round_trip file)"
assert_contains "${output}" "RESTORED=file:# 手写 nameserver 127.0.0.53 " "恢复时应还原原来的普通文件内容"
assert_not_contains "${output}" "LEFT" "恢复普通文件后不应残留"
# 假的 getent：记下调用次数，前 GETENT_FAILURES 次失败；GETENT_BROKEN_WHEN 指向的文件存在时一直失败。
# A fake getent: counts calls and fails the first GETENT_FAILURES; always fails while GETENT_BROKEN_WHEN exists.
getent_stub="${WORK}/getent-stub"
mkdir -p "${getent_stub}"
cat > "${getent_stub}/getent" <<'SH'
#!/bin/sh
count=$(cat "${GETENT_COUNTER}" 2>/dev/null || echo 0)
count=$((count + 1))
echo "${count}" > "${GETENT_COUNTER}"
if [ -n "${GETENT_BROKEN_WHEN:-}" ] && [ -e "${GETENT_BROKEN_WHEN}" ]; then
  exit 2
fi
[ "${count}" -gt "${GETENT_FAILURES:-0}" ]
SH
chmod +x "${getent_stub}/getent"
resolution_of() {
  (
    PATH="${getent_stub}:${PATH}"
    export GETENT_COUNTER="${WORK}/getent-count" GETENT_FAILURES=$1
    rm -f -- "${GETENT_COUNTER}"
    sleep() { :; }
    if name_resolution_works; then
      printf 'ok %s\n' "$(<"${GETENT_COUNTER}")"
    else
      printf 'failed %s\n' "$(<"${GETENT_COUNTER}")"
    fi
  )
}
# 回归：glibc 第一台服务器超时 5 秒，丢一个 UDP 包单次查询就失败，安装会被误判回滚。
# Regression: glibc's first-server timeout is 5 s, so one lost UDP packet failed a single lookup and rolled the install back.
assert_equals "$(resolution_of 2)" "ok 3" "解析前两次失败、第三次成功时应视为可用"
assert_equals "$(resolution_of 0)" "ok 1" "第一次成功时不应再重试"
assert_equals "$(resolution_of 99)" "failed 3" "一直失败时最多试三次后判定不可用"
output="$(
  (
    RESOLVED_DROPIN="${WORK}/broken/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${WORK}/broken/resolv.conf"
    RESOLVED_STATE="${WORK}/broken/state"
    mkdir -p "${WORK}/broken"
    printf 'nameserver 192.0.2.53\n' > "${RESOLV_CONF}"
    systemctl() { :; }
    find_port_conflict() { PORT_CONFLICT=none; }
    sleep() { :; }
    PATH="${getent_stub}:${PATH}"
    export GETENT_COUNTER="${WORK}/getent-count" GETENT_FAILURES=0 GETENT_BROKEN_WHEN=${RESOLVED_DROPIN}
    rm -f -- "${GETENT_COUNTER}"
    abort_install() { printf 'ABORT %s\n' "$*"; exit 3; }
    RESOLVED_ACTION=disable-stub
    disable_resolved_stub
    printf 'CONTINUED\n'
  ) 2>&1 || true
)"
assert_contains "${output}" "ABORT 关闭 systemd-resolved 的本机监听后，本机域名解析不可用" "改动后解析失败应中止并回滚"
assert_not_contains "${output}" "CONTINUED" "改动后解析失败不能继续安装"

# 关闭监听之后安装失败：回滚必须放回 resolv.conf、删掉 drop-in 与它的目录和记录。
# A failure after the stub was turned off: rollback must put resolv.conf back and remove the drop-in, its directory and the record.
resolved_rollback() {
  local kind=$1
  local root="${WORK}/rollback-resolved"
  rm -rf -- "${root}"
  mkdir -p "${root}/backup"
  (
    RESOLVED_DROPIN="${root}/resolved.conf.d/kixdns-panel.conf"
    RESOLV_CONF="${root}/resolv.conf"
    RESOLVED_UPLINK_RESOLV_CONF="${resolv_fixture}/run/resolv.conf"
    RESOLVED_STATE="${root}/state"
    if [[ ${kind} == symlink ]]; then
      ln -s ../run/systemd/resolve/stub-resolv.conf "${RESOLV_CONF}"
    else
      printf '# 手写\nnameserver 127.0.0.53\n' > "${RESOLV_CONF}"
    fi
    systemctl() { :; }
    ss() { :; }
    name_resolution_works() { return 0; }
    restore_path() { :; }
    restore_managed_config() { :; }
    KIXDNS_CONFIG_PATH=${config_fixture}
    BACKUP_ROOT="${root}/backup"
    INSTALL_MODE=managed
    INSTALL_KIND=fresh
    EXISTING_PANEL=false
    CREATED_EXTERNAL_BACKUP=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    PORT_CONFLICT=resolved
    PORT_CONFLICT_PORT=53
    RESOLVED_ACTION=disable-stub
    disable_resolved_stub
    rollback_install 1
  ) > /dev/null 2>&1 || true
  if [[ -L ${root}/resolv.conf ]]; then
    printf 'RESTORED=link:%s\n' "$(readlink "${root}/resolv.conf")"
  else
    printf 'RESTORED=file:%s\n' "$(tr '\n' ' ' < "${root}/resolv.conf")"
  fi
  [[ ! -e ${root}/resolved.conf.d/kixdns-panel.conf ]] || printf 'DROPIN-LEFT\n'
  [[ ! -e ${root}/resolved.conf.d ]] || printf 'DROPIN-DIRECTORY-LEFT\n'
  [[ ! -e ${root}/state ]] || printf 'STATE-LEFT\n'
}
output="$(resolved_rollback symlink)"
assert_contains "${output}" "RESTORED=link:../run/systemd/resolve/stub-resolv.conf" "回滚应还原 resolv.conf 原来的符号链接"
assert_not_contains "${output}" "LEFT" "回滚后不应残留 drop-in、目录或记录"
output="$(resolved_rollback file)"
assert_contains "${output}" "RESTORED=file:# 手写 nameserver 127.0.0.53 " "回滚应还原 resolv.conf 原来的普通文件"
assert_not_contains "${output}" "LEFT" "回滚普通文件后不应残留"

# ---------------------------------------------------------------------------
# 服务状态 / Service state
# ---------------------------------------------------------------------------

# 回归：v3.1.0 以 `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true` 结尾，从未启用过的 KixDNS
# 让函数返回非零，set -e 直接无声退出，重装和升级都半途停下。
# Regression: v3.1.0 ended with `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true`; a never-enabled
# KixDNS made the function return non-zero and set -e silently killed reinstalls and upgrades.
output="$(bash -c "
  source '${INSTALLER}'
  systemctl() { return 1; }
  EXISTING_PANEL=true
  detect_existing_kixdns
  printf 'CONTINUED active=%s enabled=%s\n' \"\${KIXDNS_WAS_ACTIVE}\" \"\${KIXDNS_WAS_ENABLED}\"
" 2>&1 || true)"
assert_contains "${output}" "CONTINUED active=false enabled=false" "KixDNS 未运行且未启用时记录状态不能让安装退出"

SYSTEMCTL_CALLS=""
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
assert_contains "${SYSTEMCTL_CALLS}" "disable --now kixdns.service" "首次安装必须保持 KixDNS 停止且禁用开机启动"
SYSTEMCTL_CALLS=""
PRESERVE_KIXDNS_STATE=true
KIXDNS_WAS_ACTIVE=true
KIXDNS_WAS_ENABLED=true
restore_managed_service_state
assert_contains "${SYSTEMCTL_CALLS}" "enable kixdns.service" "迁移或升级必须保持开机启动"
assert_contains "${SYSTEMCTL_CALLS}" "restart kixdns.service" "迁移或升级必须保持运行"
SYSTEMCTL_CALLS=""
KIXDNS_WAS_ACTIVE=false
KIXDNS_WAS_ENABLED=false
restore_managed_service_state
assert_contains "${SYSTEMCTL_CALLS}" "disable kixdns.service" "迁移或升级必须保持禁用开机启动"
assert_contains "${SYSTEMCTL_CALLS}" "stop kixdns.service" "迁移或升级必须保持停止"
unset -f systemctl

# 迁移失败回滚：放回原 unit，并按迁移前的状态启用、重启。
# Failed migration rollback: put the original unit back, then re-enable and restart per the pre-migration state.
output="$(
  (
    calls="${WORK}/rollback-calls"
    : > "${calls}"
    systemctl() { printf '%s\n' "$*" >> "${calls}"; }
    restore_path() { printf 'restore %s\n' "$1" >> "${calls}"; }
    restore_managed_config() { :; }
    BACKUP_ROOT="${WORK}/rollback-root"
    EXTERNAL_BACKUP="${WORK}/rollback-external"
    mkdir -p "${BACKUP_ROOT}" "${EXTERNAL_BACKUP}"
    INSTALL_MODE=managed
    INSTALL_KIND=migrate
    EXISTING_PANEL=false
    CREATED_EXTERNAL_BACKUP=true
    KIXDNS_BINARY_CHANGED=true
    KIXDNS_UNIT_CHANGED=true
    KIXDNS_WAS_ACTIVE=true
    KIXDNS_WAS_ENABLED=true
    rollback_install 1 2>/dev/null
  ) || true
  cat "${WORK}/rollback-calls"
)"
assert_contains "${output}" "disable --now kixdns-panel.service kixdns-panel-helper.service" "迁移失败应停用新装的面板服务"
assert_contains "${output}" "restore /etc/systemd/system/kixdns.service" "迁移失败应放回原 unit"
assert_contains "${output}" "enable kixdns.service" "迁移失败应恢复开机启动"
assert_contains "${output}" "restart kixdns.service" "迁移失败应恢复运行"
[[ ! -e ${WORK}/rollback-external ]] || {
  printf '断言失败：迁移失败后不应残留外部备份\n' >&2
  exit 1
}

# 回滚放回面板数据库：新面板启动时可能已把库迁移到更高的 schema，旧面板会拒绝打开它，一直起不来。
# Rollback puts the panel database back: the new panel may have migrated it to a higher schema on start,
# which the old panel refuses to open, leaving it crash-looping.
database_rollback() {
  local stable=$1
  local take_backup=$2
  local root="${WORK}/rollback-database"
  rm -rf -- "${root}"
  mkdir -p "${root}/data" "${root}/backup"
  (
    PANEL_DATABASE="${root}/data/panel.db"
    BACKUP_ROOT="${root}/backup"
    printf 'schema-5\n' > "${PANEL_DATABASE}"
    printf 'wal-5\n' > "${PANEL_DATABASE}-wal"
    [[ ${take_backup} == false ]] || backup_panel_database
    # 新面板启动后迁移了数据库，并留下自己的 WAL 与共享内存文件。
    # The new panel migrated the database on start and left its own WAL and shared-memory files.
    printf 'schema-6\n' > "${PANEL_DATABASE}"
    printf 'wal-6\n' > "${PANEL_DATABASE}-wal"
    printf 'shm-6\n' > "${PANEL_DATABASE}-shm"
    eval "real_restore_path() $(declare -f restore_path | tail -n +2)"
    restore_path() {
      [[ $1 != "${root}"/* ]] || real_restore_path "$@"
    }
    restore_managed_config() { :; }
    # 记下面板停下和重启那一刻数据库的内容，钉住「先停再放回、放回后才重启」的顺序。
    # Record the database at the moment the panel stops and restarts, pinning stop, then restore, then restart.
    systemctl() {
      printf 'systemctl %s\n' "$*"
      [[ $* != *kixdns-panel.service* ]] ||
        printf '%s-SEES=%s\n' "$1" "$(cat "${PANEL_DATABASE}" 2>/dev/null || printf 'missing')"
    }
    chown() { printf 'chown %s\n' "$*"; }
    chmod() { printf 'chmod %s\n' "$*"; }
    environment_value() { printf '0.0.0.0:5738\n'; }
    wait_for_service_stable() { printf 'wait %s\n' "$*"; [[ ${stable} == true ]]; }
    INSTALL_MODE=managed
    INSTALL_KIND=upgrade
    EXISTING_PANEL=true
    CREATED_EXTERNAL_BACKUP=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    rollback_install 1
  ) 2>&1 || true
  printf 'DB=%s\n' "$(cat "${root}/data/panel.db" 2>/dev/null || printf 'missing')"
  printf 'WAL=%s\n' "$(cat "${root}/data/panel.db-wal" 2>/dev/null || printf 'missing')"
  printf 'SHM=%s\n' "$(cat "${root}/data/panel.db-shm" 2>/dev/null || printf 'missing')"
}
output="$(database_rollback true true)"
assert_contains "${output}" "DB=schema-5" "回滚应放回安装前的面板数据库"
assert_contains "${output}" "WAL=wal-5" "回滚应放回安装前的 WAL"
assert_contains "${output}" "SHM=missing" "安装前没有的共享内存文件回滚后不应残留"
assert_contains "${output}" "chown kixdns-panel:kixdns -- ${WORK}/rollback-database/data/panel.db" "放回的数据库应归面板账号所有"
assert_contains "${output}" "chmod 0600 -- ${WORK}/rollback-database/data/panel.db" "放回的数据库应为 0600"
assert_contains "${output}" "wait kixdns-panel.service 127.0.0.1 5738" "回滚后应确认原面板稳定运行"
assert_contains "${output}" "安装未完成，已恢复原有程序和服务。" "原面板恢复运行时说明已恢复"
assert_contains "${output}" "stop-SEES=schema-6" "放回数据库前必须先停掉面板"
assert_contains "${output}" "restart-SEES=schema-5" "重启原面板时数据库必须已经放回"

output="$(database_rollback false true)"
assert_contains "${output}" "原面板没有恢复运行" "原面板起不来时不能说已恢复"
assert_contains "${output}" "journalctl -u kixdns-panel.service -n 50 --no-pager" "原面板起不来时应给出日志命令"
assert_not_contains "${output}" "已恢复原有程序和服务" "原面板起不来时不能打印成功"

# 数据库还没备份就回滚（例如备份前被中断）：不能按「备份里没有」把正在用的数据库删掉。
# Rolling back before the database was backed up (e.g. interrupted first): must not delete the live
# database because the backup lacks it.
output="$(database_rollback true false)"
assert_contains "${output}" "DB=schema-6" "没有备份数据库时回滚不应动数据库"

# 备份必须在停掉面板之后（数据库不再写入）、替换程序之前。
# The backup must come after the panel stops (no more writes) and before the binaries are swapped.
main_body="$(declare -f main)"
stop_line="$(grep -n 'systemctl stop kixdns-panel.service' <<< "${main_body}" | head -n 1 | cut -d: -f1)"
backup_line="$(grep -n 'backup_panel_database' <<< "${main_body}" | head -n 1 | cut -d: -f1)"
swap_line="$(grep -n 'kixdns-panel-server.new' <<< "${main_body}" | head -n 1 | cut -d: -f1)"
[[ -n ${backup_line} && ${stop_line} -lt ${backup_line} && ${backup_line} -lt ${swap_line} ]] || {
  printf '断言失败：面板数据库应在停掉面板后、替换程序前备份（stop=%s backup=%s swap=%s）\n' \
    "${stop_line}" "${backup_line}" "${swap_line}" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 启动后校验 / Post-start verification
# ---------------------------------------------------------------------------

SERVICE_WAIT_SECONDS=3
SERVICE_STABLE_SECONDS=1
pid_counter="${WORK}/pid-counter"
service_probe() {
  local mode=$1
  local port_ok=$2
  (
    printf '0\n' > "${pid_counter}"
    systemctl() {
      local count
      count=$(<"${pid_counter}")
      case "$2" in
        --property=ActiveState) printf 'active\n' ;;
        --property=MainPID)
          count=$((count + 1))
          printf '%s\n' "${count}" > "${pid_counter}"
          if [[ ${mode} == stable ]]; then
            printf '4242\n'
          else
            # 崩溃循环：每次看到的都是新进程。/ Crash loop: every look sees a new process.
            printf '%s\n' "$((4000 + count))"
          fi
          ;;
      esac
    }
    port_accepts_connection() { [[ ${port_ok} == true ]]; }
    if wait_for_service_stable kixdns-panel.service 127.0.0.1 5738; then
      printf 'stable\n'
    else
      printf 'unstable\n'
    fi
  )
}
assert_equals "$(service_probe stable true)" "stable" "PID 稳定且端口可连接时视为启动成功"
assert_equals "$(service_probe crash true)" "unstable" "主进程反复更换时视为崩溃循环"
assert_equals "$(service_probe stable false)" "unstable" "端口不接受连接时视为启动失败"

output="$(
  (
    systemctl() {
      case "$4" in
        kixdns-panel.service)
          [[ $2 == --property=ActiveState ]] && printf 'active\n' || printf '4242\n'
          ;;
        *) [[ $2 == --property=ActiveState ]] && printf 'activating\n' || printf '0\n' ;;
      esac
    }
    port_accepts_connection() { return 0; }
    environment_value() { printf '0.0.0.0:5738\n'; }
    abort_install() { printf 'ABORT %s\n' "$*"; exit 3; }
    KIXDNS_SERVICE_UNIT=kixdns.service
    KIXDNS_RESTART=true
    verify_services_started
    printf 'CONTINUED\n'
  ) 2>&1 || true
)"
assert_contains "${output}" "ABORT kixdns.service 替换后没有保持运行。" "重启的 KixDNS 没起来时应中止并点名服务"
assert_contains "${output}" "journalctl -u kixdns.service -n 50 --no-pager" "失败信息应给出查看日志的命令"
assert_not_contains "${output}" "CONTINUED" "KixDNS 没起来时不能报告安装完成"
output="$(
  (
    systemctl() { [[ $2 == --property=ActiveState ]] && printf 'failed\n' || printf '0\n'; }
    environment_value() { printf '0.0.0.0:5738\n'; }
    abort_install() { printf 'ABORT %s\n' "$*"; exit 3; }
    KIXDNS_RESTART=false
    verify_services_started
    printf 'CONTINUED\n'
  ) 2>&1 || true
)"
assert_contains "${output}" "ABORT kixdns-panel.service 启动后没有保持运行" "面板没起来时应中止并点名面板服务"
assert_contains "${output}" "journalctl -u kixdns-panel.service -n 50 --no-pager" "面板失败时应给出日志命令"
SERVICE_WAIT_SECONDS=15
SERVICE_STABLE_SECONDS=4

# ---------------------------------------------------------------------------
# 面板环境 / Panel environment
# ---------------------------------------------------------------------------

environment_source="${WORK}/environment-source"
environment_output="${WORK}/environment-output"
printf '%s\n' \
  'KIXDNS_PANEL_BIND=127.0.0.1:5738' \
  'KIXDNS_PANEL_INSTALLED_RELEASE=' \
  '# true：面板管理增强版二进制；false：保留外部 KixDNS，仅使用兼容能力。' \
  'KIXDNS_MANAGEMENT_ENABLED=true' \
  'KIXDNS_UPDATE_RELEASE_WORKFLOW=build-kixdns-release.yml' > "${environment_source}"
KIXDNS_CONFIG_PATH=/etc/kixdns/pipeline.json
KIXDNS_BINARY_PATH=/var/lib/kixdns-panel/bin/kixdns
KIXDNS_CONTROL_SOCKET=/run/kixdns/admin.sock
KIXDNS_SERVICE_UNIT=kixdns.service
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' 42
if grep -q '^KIXDNS_PANEL_INSTALLED_RELEASE=' "${environment_output}"; then
  printf '断言失败：Action 包不应输出空 Release 环境变量\n' >&2
  exit 1
fi
if grep -q 'KIXDNS_MANAGEMENT_ENABLED\|false：保留外部' "${environment_output}"; then
  printf '断言失败：升级应删掉已移除的管理模式开关\n' >&2
  exit 1
fi
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit v1.0.0 42
release_value="$(awk -F= '$1 == "KIXDNS_PANEL_INSTALLED_RELEASE" { print $2 }' "${environment_output}")"
assert_equals "${release_value}" "v1.0.0" "正式包应保留 Release 标签"
helper_socket_value="$(awk -F= '$1 == "KIXDNS_SERVICE_HELPER_SOCKET" { print $2 }' "${environment_output}")"
assert_equals "${helper_socket_value}" "/run/kixdns-panel/control.sock" "面板环境应写入受限 helper Socket"
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "0.0.0.0:5738" "旧版默认监听地址应迁移为内网可访问"
source_id_value="$(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${environment_output}")"
assert_equals "${source_id_value}" "42" "面板环境应记录完整包 Artifact ID"
if grep -q 'KIXDNS_MANAGEMENT_ENABLED' "${PACKAGE_ROOT}/deploy/panel.env.example"; then
  printf '断言失败：面板环境模板不应再包含已移除的管理模式开关\n' >&2
  exit 1
fi

printf '%s\n' 'KIXDNS_PANEL_BIND=192.168.10.5:6754' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' 42
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

# ---------------------------------------------------------------------------
# 安装结果 / Summary
# ---------------------------------------------------------------------------

summary_of() {
  (
    INSTALL_KIND=$1
    KIXDNS_WAS_ACTIVE=$2
    KIXDNS_BINARY_CHANGED=$3
    KIXDNS_RESTART=$4
    PORT_CONFLICT=$5
    PORT_CONFLICT_PORT=53
    PORT_HOLDER_NAME=systemd-resolve
    RESOLVED_CHANGED=$6
    RESOLVED_PORT=53
    RESOLV_CONF="${WORK}/summary-resolv.conf"
    PANEL_RELEASE=v3.1.1
    PANEL_BUILD_COMMIT=${commit_a}
    KIXDNS_BUILD_COMMIT=${commit_b}
    PREVIOUS_PANEL_LABEL=$7
    KIXDNS_UNIT_CHANGED=false
    print_summary http://192.168.1.20:5738
  )
}
ln -sfn ../run/systemd/resolve/stub-resolv.conf "${WORK}/summary-resolv.conf"
output="$(summary_of fresh false true false resolved false '')"
assert_equals "$(sed -n 2p <<< "${output}")" "安装完成：KixDNS Panel v3.1.1" "结果第一行应说明安装了哪个版本"
assert_equals "$(sed -n 3p <<< "${output}")" "面板地址：http://192.168.1.20:5738" "第二行应是面板地址"
assert_contains "${output}" "下一步：打开面板地址 → 创建管理员账号 → 在「系统与更新」页启动 KixDNS" "首次安装应给出下一步"
assert_contains "${output}" "KixDNS：已安装，尚未启动" "首次安装应说明 KixDNS 未启动"
assert_contains "${output}" "端口 53：被 systemd-resolved 占用" "端口未处理时应给出提示"
assert_contains "${output}" "sudo ln -sfn /run/systemd/resolve/resolv.conf ${WORK}/summary-resolv.conf" "应给出改指向 resolv.conf 的命令"
assert_equals "$(tail -n 2 <<< "${output}" | head -n 1)" "请仅在可信内网使用面板；公网访问必须配置防火墙和 HTTPS 反向代理。" "安全提醒应在构建信息之前"
assert_equals "$(tail -n 1 <<< "${output}")" "构建：面板 aaaaaaaaaaaa · KixDNS bbbbbbbbbbbb" "构建身份应在最后一行"
output="$(summary_of migrate true true true none false '')"
assert_contains "${output}" "KixDNS：已迁移为增强版，保持原来的运行状态（运行中）；原 unit 备份在 /var/lib/kixdns-panel/external-backup，卸载面板时可恢复" "迁移结果应说明状态与备份"
assert_not_contains "${output}" "下一步" "迁移不应给出首次安装的下一步"
assert_not_contains "${output}" "端口 53" "端口无冲突时不提示"
output="$(summary_of upgrade true false false none false 'v3.1.0')"
assert_contains "${output}" "面板：已升级 v3.1.0 → v3.1.1" "升级应说明版本变化"
assert_contains "${output}" "KixDNS：未变（运行中）" "KixDNS 未变时应明确说明"
output="$(summary_of upgrade true true true none false 'v3.1.0')"
assert_contains "${output}" "KixDNS：已替换并按原状态重启（运行中）" "KixDNS 被替换时应说明已按原状态重启"
output="$(summary_of upgrade false true false none false 'v3.1.1')"
assert_contains "${output}" "面板：已重新安装 v3.1.1" "同版本 --reinstall 应说明是重新安装"
assert_contains "${output}" "KixDNS：已替换，保持原状态（已停止）" "停止的 KixDNS 替换后保持停止"
output="$(summary_of fresh false true false resolved true '')"
assert_contains "${output}" "端口 53：已关闭 systemd-resolved 的本机监听" "关闭监听后应说明并提示卸载可恢复"
output="$(summary_of panel-only true false false none false 'v3.1.0')"
assert_equals "$(sed -n 2p <<< "${output}")" "面板更新完成：KixDNS Panel v3.1.1" "仅更新面板的结果第一行"
assert_contains "${output}" "KixDNS：未替换，配置与运行状态保持不变" "仅更新面板应说明 KixDNS 未动"

# ---------------------------------------------------------------------------
# 面板在线更新的失败原因 / Online panel update failure reasons
# ---------------------------------------------------------------------------

# 把更新器里写死的系统路径换到临时目录，其余逻辑原样运行。
# Point the updater's hardcoded system paths at a scratch directory and run the rest unchanged.
online_update_root="${WORK}/online-update"
mkdir -p "${online_update_root}/status"
sed -e "s|/var/lib/kixdns-panel-update|${online_update_root}/status|g" \
  -e "s|/etc/kixdns-panel/panel.env|${online_update_root}/panel.env|" \
  -e "s|/usr/local/libexec/kixdns-panel-one-click-install|${online_update_root}/one-click|" \
  -e "s|/usr/local/bin/kixdns-panel-server|${online_update_root}/server|" \
  -e "s|/var/lib/kixdns-panel/github-token|${online_update_root}/github-token|" \
  -e "s|/run/kixdns-panel-update.lock|${online_update_root}/lock|" \
  "${PACKAGE_ROOT}/scripts/panel-online-update.sh" > "${online_update_root}/updater.sh"
printf '#!/usr/bin/env bash\nprintf "kixdns-panel-server 3.1.1\\n"\n' > "${online_update_root}/server"
printf 'KIXDNS_PANEL_INSTALLED_RELEASE=v3.1.1\n' > "${online_update_root}/panel.env"
chmod 0755 "${online_update_root}/server"

# 参数：一键安装器的脚本正文，curl 替身的函数体。输出状态文件里的 state 与 message。
# Arguments: the one-click installer's body and a function body standing in for curl.
# Prints the status file's state and message.
online_update_status() {
  printf '#!/usr/bin/env bash\n%s\n' "$1" > "${online_update_root}/one-click"
  chmod 0755 "${online_update_root}/one-click"
  rm -f -- "${online_update_root}/status/status.json"
  bash -c "
    source '${online_update_root}/updater.sh'
    chown() { :; }
    sleep() { :; }
    trusted_root_executable() { [[ -x \$1 ]]; }
    curl() { $2; }
    main
  " > /dev/null 2>&1 || true
  jq -r '.state + " " + .message' "${online_update_root}/status/status.json"
}
latest_release='printf "{\"tag_name\":\"v3.1.2\"}\n"'

# 回归：失败只写「请查看日志」，系统页看不到原因。安装器最后一行是回滚收尾，真正的原因在「失败：」那一行。
# Regression: a failure only said "see the log" and the system page showed no reason. The installer's
# last line is the rollback epilogue; the real reason is on the line carrying "失败：".
output="$(online_update_status "printf '正在安装文件与服务…\n'
printf '安装失败：kixdns-panel.service 启动后没有保持运行（15 秒内没有稳定运行并接受 5738 端口连接）。\n查看原因：journalctl -u kixdns-panel.service -n 50 --no-pager\n' >&2
printf '安装未完成，已恢复原有程序和服务。\n' >&2
exit 1" "${latest_release}")"
assert_contains "${output}" "failed 在线更新失败：安装失败：kixdns-panel.service 启动后没有保持运行" \
  "安装器失败时状态应带上安装器给出的原因"

output="$(online_update_status "exit 0" "printf 'curl: (6) Could not resolve host: api.github.com\n' >&2; return 6")"
assert_contains "${output}" "failed 在线更新失败：curl: (6) Could not resolve host: api.github.com" \
  "查询最新版失败时状态应带上 curl 的错误"

online_update_status "printf '一键安装失败：%s\n' \"\$(printf 'x%.0s' {1..400})\" >&2; exit 1" "${latest_release}" > /dev/null
assert_equals "$(jq -r '.message | length' "${online_update_root}/status/status.json")" "300" \
  "过长的原因应截断到面板接受的 300 字"

output="$(online_update_status "exit 0" "${latest_release}")"
assert_equals "${output}" "complete 面板已更新到 v3.1.2" "安装器成功时状态应为完成"

printf '安装策略检查通过。\n'
