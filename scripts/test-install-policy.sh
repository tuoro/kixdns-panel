#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2030,SC2031,SC2034,SC2317,SC2329
set -Eeuo pipefail
# 临时目录和 CI 一样只有自己能写：R1、R4 要求 root 信的东西上面每一层都没人能写，开发机的 umask 002 会让它们都不能信
# Scratch directories writable by their owner alone, as in CI: R1 and R4 require nobody else to be able to write any level
# above what root trusts, and a dev machine's umask 002 would make all of it untrusted
umask 022

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
assert_contains "${output}" "把原 unit 与运行状态备份到 /var/lib/kixdns-panel-backup/external-backup" "提示应说明备份位置"
assert_contains "${output}" "保持原来的运行状态（现在运行中）" "提示应说明运行状态会被保持"
assert_contains "${output}" "把配置复制到 /etc/kixdns-panel/kixdns/pipeline.json，面板只改这份副本；原来的配置文件和它所在的目录不动" \
  "提示应说明面板管理的是配置副本，原配置不动"
assert_not_contains "${output}" "配置文件留在原位置" "外部 KixDNS 的配置不再原地接管"
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
assert_contains "${output}" "输入 y 或 n。" "认不出的回答应提示重新输入"
assert_contains "${output}" "已取消安装，现有 KixDNS 未作修改。" "连续三次认不出应取消安装"
assert_not_contains "${output}" "MODE=managed" "认不出的回答不能被当作同意"

output="$(run_without_tty "${migration_fixture}
  choose_install_mode
  printf 'MODE=%s\n' \"\${INSTALL_MODE}\"
")"
assert_not_contains "${output}" "MODE=managed" "无人值守安装不能默认迁移"
assert_contains "${output}" "sudo bash ./scripts/install.sh --replace-existing" "无人值守提示应给出安装包命令"
assert_contains "${output}" "| sudo bash -s -- --replace-existing" "无人值守提示应给出一键安装命令"

# 上次卸载时保留下来的面板自带 KixDNS（unit 跑的是面板状态目录里的程序）不是外部安装：重装接着管它，不用 --replace-existing，
# 也不问要不要迁移。回归：以前当成外部的，无人值守安装要 --replace-existing，还说会备份、卸载时恢复，其实 #279 以后不备份它。
# The panel's own KixDNS kept by an earlier uninstall (its unit runs the program in the panel's state directory) is not an
# external install: a reinstall takes it back without --replace-existing and without asking. Regression: it used to count as
# external, an unattended install demanded --replace-existing, and the text promised a backup and a restore that #279 removed.
kept_kixdns_fixture="
  source '${INSTALLER}'
  systemctl() {
    case \$1 in
      show) printf '{ path=%s ; argv[]=%s run --config /etc/kixdns/pipeline.json ; }\n' \"\${MANAGED_KIXDNS_BINARY}\" \"\${MANAGED_KIXDNS_BINARY}\" ;;
      cat | is-active | is-enabled) return 0 ;;
      *) return 1 ;;
    esac
  }
  INSTALL_MODE=auto
  detect_existing_kixdns
"
output="$(run_without_tty "${kept_kixdns_fixture}
  choose_install_mode
  determine_install_kind
  printf 'MODE=%s KIND=%s PRESERVE=%s\n' \"\${INSTALL_MODE}\" \"\${INSTALL_KIND}\" \"\${PRESERVE_KIXDNS_STATE}\"
")"
assert_contains "${output}" "MODE=managed KIND=reclaim PRESERVE=true" "面板自己留下的 KixDNS 无人值守重装也应接着管理、保持运行状态"
assert_not_contains "${output}" "--replace-existing" "面板自己留下的 KixDNS 不用 --replace-existing"
output="$(run_in_pty "${kept_kixdns_fixture}
  choose_install_mode
  printf 'MODE=%s\n' \"\${INSTALL_MODE}\"
")"
assert_contains "${output}" "MODE=managed" "终端里重装面板自己留下的 KixDNS 也不用问"
assert_not_contains "${output}" "迁移为增强版？" "面板自己留下的 KixDNS 不是迁移，不该问"

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
    # TERM/HUP 只发给 bash 本身，bash 要等前台的 sleep 结束才执行 trap；一整段 sleep 20 让每个信号白等 20 秒。
    # 切成 0.1 秒一段，trap 在下一段前就会运行，最长等待仍是 20 秒，没回滚时照样会打印 NOT-INTERRUPTED。
    # TERM/HUP reach only bash, which runs the trap after its foreground sleep ends; one sleep 20 cost
    # 20 s per signal. Slices of 0.1 s let the trap run at the next slice while keeping the 20 s bound,
    # so a missing rollback still prints NOT-INTERRUPTED.
    for _ in {1..200}; do sleep 0.1; done
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
# 临时目录里的东西归跑测试的用户，由他代替 root；root 才能改的路径只查到临时目录为止（R1、R4）
# What is in the scratch tree belongs to the user running the tests, who stands in for root; paths only root may change are
# checked up to the scratch tree (R1, R4)
ROOT_CHAIN_TOP=${WORK}
ROOT_GID="$(id -g)"
# 停面板账号的进程（R2）只在专门的用例里真的去发信号，别处一律当作已经没有进程 / Stopping the panel account's processes
# (R2) really sends signals only in its own case; everywhere else no process is left
! declare -F account_signal > /dev/null || eval "real_account_signal() $(declare -f account_signal | tail -n +2)"
! declare -F account_live_processes > /dev/null ||
  eval "real_account_live_processes() $(declare -f account_live_processes | tail -n +2)"
account_signal() { :; }
account_live_processes() { return 1; }
# 交还原配置时会按名字在 systemd 的搜索路径上找原来的 unit；指向不存在的目录，免得读到开发机上真实安装的 KixDNS。
# Handing back the original config looks the original unit up by name on the systemd search path; point it nowhere so a
# real KixDNS on the dev host cannot leak in.
SYSTEMD_VENDOR_DIRECTORIES=("${PACKAGE_ROOT}/.missing-vendor-units")
# 在线更新器声明了只读的 PANEL_ENV，放进子 shell 以免锁住下面测试要改的同名变量。
# The online updater declares PANEL_ENV readonly; source it in a subshell so tests below can still change it.
(source "${PACKAGE_ROOT}/scripts/panel-online-update.sh")

# 回归：在线更新的失败也只记一次。-E 让 ERR 陷阱在命令替换的子 shell 里也触发，以前那里先写一遍失败、父 shell 再写一遍。
# Regression: an online update's failure is recorded once. -E fires the ERR trap in command-substitution subshells too, which wrote
# the failure there before the parent wrote it again.
output="$(bash -c "
  source '${PACKAGE_ROOT}/scripts/panel-online-update.sh'
  write_status() { printf 'STATUS %s\\n' \"\$1\" >&2; }
  probe() { local value; value=\"\$(mktemp '${WORK}/missing-dir/x.XXXXXX')\"; printf '%s' \"\${value}\"; }
  trap \"fail_update \${BASHPID}\" ERR
  probe
" 2>&1 || true)"
writes="$(grep -c '^STATUS failed' <<< "${output}" || true)"
assert_equals "${writes}" "1" "在线更新失败只记一次"

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

# 路径里的 .、.. 和空的一段（//）会让 dirname 看到的目录和真正写进去的目录对不上，配置目录的两条规则就被绕开：
# /etc/kixdns/../x.json 看着在 /etc/kixdns 里，实际放在 /etc；/etc/kixdns-panel/x/../pipeline.json 实际在放着 panel.env 的目录里。
# 每个路径参数都拒绝它们。
# A ., .. or empty (//) component makes the directory dirname sees differ from the one really written to, so both
# config-directory rules are bypassed: /etc/kixdns/../x.json looks inside /etc/kixdns but lands in /etc, and
# /etc/kixdns-panel/x/../pipeline.json lands in the directory holding panel.env. Every path flag refuses them.
path_verdict() {
  (validate_absolute_path "路径" "$1" && printf 'accepted\n') 2>&1 || true
}
for bad_path in /etc/kixdns/../x.json /etc/kixdns-panel/x/../pipeline.json /etc/kixdns/./pipeline.json \
  /etc//kixdns/pipeline.json /etc/kixdns/ /etc/kixdns/.. /etc/kixdns/. / //pipeline.json; do
  output="$(path_verdict "${bad_path}")"
  assert_contains "${output}" "安装失败：路径必须是绝对路径，不含空白和控制字符，不含 \ \" ' % \$ 这几个符号（systemd 会解开它们），也不含 .、.. 或空的一段（//）" "${bad_path} 应被拒绝"
  assert_not_contains "${output}" "accepted" "${bad_path} 不能被接受"
done
for good_path in /etc/kixdns/pipeline.json /srv/..kixdns/pipeline.json /srv/kixdns./x.json /run/kixdns/admin.sock; do
  assert_equals "$(path_verdict "${good_path}")" "accepted" "${good_path} 应被接受"
done
for flag in --kixdns-config --kixdns-binary --control-socket; do
  output="$(
    (
      parse_arguments "${flag}" /etc/kixdns/../x.json
      KIXDNS_SERVICE_UNIT=kixdns.service
      INSTALL_KIND=fresh
      validate_install_mode
      printf 'CONTINUED\n'
    ) 2>&1 || true
  )"
  assert_contains "${output}" "不含 .、.. 或空的一段（//）" "${flag} 带 .. 时应被拒绝"
  assert_not_contains "${output}" "CONTINUED" "${flag} 带 .. 时不能继续安装"
done

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
assert_contains "${output}" "KixDNS 面板 v3.1.1 已安装，未作任何修改。" "同一 Release 再次运行应直接退出"
assert_contains "${output}" "--reinstall" "同一版本提示应说明如何修复安装"
assert_not_contains "${output}" "CONTINUED" "同一 Release 不应继续安装"
output="$(same_version_output true v3.1.1 "${commit_b}" true)"
assert_contains "${output}" "CONTINUED" "--reinstall 应继续安装"
# 同一版本但面板没在运行：说「未作任何修改」就是把坏掉的安装当成好的，应按 --reinstall 修复。
# Same version but the panel is not running: "nothing changed" would pass off a broken install as fine; repair as --reinstall.
output="$(same_version_output true v3.1.1 "${commit_b}" false false)"
assert_contains "${output}" "KixDNS 面板 v3.1.1 已安装，但面板没有在运行" "同版本面板未运行时应说明原因"
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

# 第 4 个参数是主机上已有 KixDNS 的程序，默认是外部装的那种。/ The fourth argument is the existing KixDNS program, an
# external one by default.
install_kind_of() {
  (
    PANEL_ONLY_UPDATE=$1
    EXISTING_PANEL=$2
    EXISTING_KIXDNS=$3
    KIXDNS_BINARY_PATH=${4:-/usr/local/bin/kixdns}
    PRESERVE_KIXDNS_STATE=false
    determine_install_kind
    printf '%s %s\n' "${INSTALL_KIND}" "${PRESERVE_KIXDNS_STATE}"
  )
}
assert_equals "$(install_kind_of false false false)" "fresh false" "新主机是首次安装"
assert_equals "$(install_kind_of false false true)" "migrate true" "已有非面板 KixDNS 是迁移并保持状态"
assert_equals "$(install_kind_of false false true "${MANAGED_KIXDNS_BINARY}")" "reclaim true" \
  "上次卸载时保留的面板自带 KixDNS 是接回来，保持状态"
assert_equals "$(install_kind_of false true true)" "upgrade true" "已有面板是升级并保持状态"
# 仅更新面板一般不动 KixDNS（下面 plan_of panel-only 断言程序、unit 都不变、不重启）；可升级时换了配置位置（I1），unit 要改指
# 新的配置，这时得按原来的状态重启它，不能当成全新安装停掉、禁用。以前这里断言 false，是因为那时仅更新面板从不改 unit。
# A panel-only update normally leaves KixDNS alone (plan_of panel-only below asserts no binary or unit change and no
# restart); but when the config moves on upgrade (I1) the unit is re-pointed at it, and KixDNS must then restart as it was,
# not be stopped and disabled as on a fresh install. This asserted false before, when a panel-only update never touched the unit.
assert_equals "$(install_kind_of true true true)" "panel-only true" "仅更新面板改 unit 时也保持 KixDNS 原来的状态"

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

# 逐请求的应答记录不进系统日志；只写 RUST_LOG=info 的旧 unit 在升级时被替换并重启，已有安装也跟着生效
# Per-request response records stay out of the journal; an old unit with a bare RUST_LOG=info is replaced and
# restarted on upgrade, so existing installs pick the filter up too
rendered_unit=$(PACKAGE_ROOT=${package_fixture}; render_kixdns_unit)
assert_equals "$(grep '^Environment=RUST_LOG=' <<<"${rendered_unit}")" "Environment=RUST_LOG=info,kixdns::engine::phases=warn" "KixDNS 的日志级别不记逐请求的应答"
printf '%s\n' "${rendered_unit/Environment=RUST_LOG=info,kixdns::engine::phases=warn/Environment=RUST_LOG=info}" > "${WORK}/units/kixdns.service"
assert_equals "$(plan_of upgrade true)" "binary=false unit=true restart=true" "旧的 RUST_LOG=info unit 升级时要替换并重启"

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
    # 和真的安装器一样，记录在只有 root 能进的目录里 / As in the real installer, the record lives in the root-only directory
    ROOT_RECORDS="${WORK}/rt/records"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    ROOT_UID="$(id -u)"
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
# 回归（S1）：drop-in 目录已经在时，关掉监听不能改它的权限（install -d 会把已有目录改成 0755）。
# Regression (S1): with the drop-in directory already there, turning the stub off must not change its mode (install -d
# resets an existing directory to 0755).
(
  RESOLVED_DROPIN="${WORK}/existing-dropin/resolved.conf.d/kixdns-panel.conf"
  RESOLV_CONF="${WORK}/existing-dropin/resolv.conf"
  RESOLVED_UPLINK_RESOLV_CONF="${resolv_fixture}/run/resolv.conf"
  RESOLVED_STATE="${WORK}/existing-dropin/records/resolved-stub"
  ROOT_RECORDS="${WORK}/existing-dropin/records"
  ROOT_UID="$(id -u)"
  mkdir -p "$(dirname -- "${RESOLVED_DROPIN}")"
  chmod 0700 "$(dirname -- "${RESOLVED_DROPIN}")"
  printf 'nameserver 192.0.2.1\n' > "${RESOLV_CONF}"
  systemctl() { :; }
  ss() { :; }
  name_resolution_works() { return 0; }
  install() {
    local arguments=()
    while [[ $# -gt 0 ]]; do
      case $1 in -o | -g) shift ;; *) arguments+=("$1") ;; esac
      shift
    done
    command install "${arguments[@]}"
  }
  KIXDNS_CONFIG_PATH=${config_fixture}
  PORT_CONFLICT=resolved
  PORT_CONFLICT_PORT=53
  RESOLVED_ACTION=disable-stub
  disable_resolved_stub
) > /dev/null 2>&1 || true
assert_equals "$(stat -c '%a' "${WORK}/existing-dropin/resolved.conf.d")" "700" "已有的 drop-in 目录权限不能被改"

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
    # 和真的安装器一样，记录在只有 root 能进的目录里 / As in the real installer, the record lives in the root-only directory
    ROOT_RECORDS="${WORK}/broken/records"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    ROOT_UID="$(id -u)"
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
    # 和真的安装器一样，记录在只有 root 能进的目录里 / As in the real installer, the record lives in the root-only directory
    ROOT_RECORDS="${root}/records"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    ROOT_UID="$(id -u)"
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
    ROOT_RECORDS="$(dirname -- "${EXTERNAL_BACKUP}")/records"
    ROOT_UID="$(id -u)"
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

# 回归：-E 让 ERR 陷阱也在命令替换的子 shell 里触发。子 shell 里回滚完会删掉备份，父 shell 接着又回滚一次，
# 这时 restore_path 只剩删除：刚放回的文件被删光。命令替换里的一条命令失败，回滚只能做一次，放回的文件要留着。
# Regression: -E fires the ERR trap inside command-substitution subshells too. The subshell's rollback deleted the backup,
# then the parent rolled back again, when restore_path could only delete: the files just put back were removed. A failing
# command in a substitution must roll back once and keep what it restored.
# 卸载时留下的面板自带 KixDNS 重装时不备份成「原来的 KixDNS」：卸载时会把它放回去，而它的程序已随状态目录删掉。
# 真正的外部安装照旧备份。
# The panel's own KixDNS kept by an uninstall is not backed up as the original on reinstall: uninstall would put it back,
# with its program deleted along with the state directory. A real external install is still backed up.
external_backup_of() {
  local binary=$1
  local root="${WORK}/external-backup-${RANDOM}"
  (
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    mkdir -p "${SYSTEMD_UNIT_DIRECTORY}"
    install() { mkdir -p "${@: -1}"; }
    chmod() { :; }
    INSTALL_KIND=migrate
    EXISTING_KIXDNS_BINARY_PATH=${binary}
    preserve_external_install
    printf '%s\n' "${CREATED_EXTERNAL_BACKUP}"
  )
}
assert_equals "$(external_backup_of "${MANAGED_KIXDNS_BINARY}")" "false" "面板自带的 KixDNS 不应备份成外部安装"
assert_equals "$(external_backup_of /usr/local/bin/kixdns)" "true" "外部安装的 KixDNS 应备份"

# 迁移外部 KixDNS 时已经有一份备份：那是以前的卸载恢复了原来的 KixDNS 却没删的，记的是更早那次迁移前的样子。换成主机上现在
# 这个 KixDNS 的 unit、配置和运行状态；迁移失败回滚时把那份原样放回去。回归：以前见备份在就不再备份，之后卸载恢复放回的是旧的。
# Migrating an external KixDNS with a backup already there: an earlier uninstall restored the original KixDNS and left the
# backup, which describes the host before an older migration. It is replaced with the unit, config and running state of the
# KixDNS the host has now; a failed migration puts the old one back as it was. Regression: a backup already there used to
# stop a new one being made, so a later restore put back the old state.
stale_external_backup() {
  local root="${WORK}/stale-external-backup"
  rm -rf -- "${root}"
  mkdir -p "${root}/units" "${root}/records/external-backup" "${root}/rollback"
  chmod 0700 "${root}/records"
  printf 'old unit\n' > "${root}/records/external-backup/kixdns.service"
  printf '%s\n' KIXDNS_SERVICE_UNIT=kixdns.service KIXDNS_CONFIG=/etc/old.json KIXDNS_BINARY=/usr/local/bin/kixdns \
    KIXDNS_WAS_ACTIVE=true KIXDNS_WAS_ENABLED=true > "${root}/records/external-backup/install.env"
  printf 'current unit\n' > "${root}/units/kixdns.service"
  (
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    BACKUP_ROOT="${root}/rollback"
    install() { mkdir -p "${@: -1}"; }
    chmod() { :; }
    INSTALL_KIND=migrate
    EXISTING_KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH=/etc/kixdns-panel/kixdns/pipeline.json
    ORIGINAL_KIXDNS_CONFIG_PATH=/etc/new.json
    KIXDNS_WAS_ACTIVE=false
    KIXDNS_WAS_ENABLED=false
    preserve_external_install
    printf 'CREATED=%s\n' "${CREATED_EXTERNAL_BACKUP}"
    printf 'UNIT=%s\n' "$(cat "${EXTERNAL_BACKUP}/kixdns.service")"
    printf 'BACKUP=%s\n' "$(tr '\n' ' ' < "${EXTERNAL_BACKUP}/install.env")"
    # 迁移接着失败了 / The migration then fails
    systemctl() { :; }
    restore_path() { :; }
    restore_managed_config() { :; }
    restore_panel_database() { :; }
    INSTALL_MODE=managed
    EXISTING_PANEL=false
    KIXDNS_BINARY_CHANGED=true
    KIXDNS_UNIT_CHANGED=true
    RESOLVED_CHANGED=false
    rollback_install 1 > /dev/null 2>&1
  ) || true
  printf 'AFTER-ROLLBACK=%s %s\n' "$(cat "${root}/records/external-backup/kixdns.service" 2>/dev/null || printf missing)" \
    "$(grep -c '^KIXDNS_CONFIG=/etc/old.json$' "${root}/records/external-backup/install.env" 2>/dev/null || true)"
}
output="$(stale_external_backup)"
assert_contains "${output}" "CREATED=true" "已有的旧备份应换成这次迁移的备份"
assert_contains "${output}" "UNIT=current unit" "再迁移时应备份主机上现在的 unit"
assert_contains "${output}" "KIXDNS_CONFIG=/etc/new.json " "再迁移时应记下现在的原配置"
assert_contains "${output}" "KIXDNS_WAS_ACTIVE=false KIXDNS_WAS_ENABLED=false " "再迁移时应记下现在的运行与开机状态"
assert_contains "${output}" "AFTER-ROLLBACK=old unit 1" "迁移失败回滚应把原来那份备份原样放回"

# 回归：旧备份刚挪进回滚备份、还没记下「这次建了备份」时被中断（Ctrl-C、SIGTERM），回滚按那个还没设的标记跳过了放回，
# 旧备份随回滚备份一起删掉。放回要看回滚备份里实际有没有它。
# Regression: interrupted (Ctrl-C, SIGTERM) right after the old backup moved into the rollback backup and before the run
# recorded that it made a backup, the rollback skipped the move-back on that unset flag and the old backup was deleted with
# the rollback backup. The move-back must follow what the rollback backup actually holds.
interrupted_stale_backup() {
  local root="${WORK}/interrupted-stale-backup"
  rm -rf -- "${root}"
  mkdir -p "${root}/units" "${root}/records/external-backup" "${root}/rollback"
  chmod 0700 "${root}/records"
  printf 'old unit\n' > "${root}/records/external-backup/kixdns.service"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_BINARY=/usr/local/bin/kixdns\n' > "${root}/records/external-backup/install.env"
  printf 'current unit\n' > "${root}/units/kixdns.service"
  (
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    BACKUP_ROOT="${root}/rollback"
    install() { mkdir -p "${@: -1}"; }
    chmod() { :; }
    systemctl() { :; }
    restore_path() { :; }
    restore_managed_config() { :; }
    restore_panel_database() { :; }
    # 旧备份挪走的那一刻被中断 / Interrupted the moment the old backup has moved
    mv() { command mv "$@"; [[ ${*: -1} != "${BACKUP_ROOT}/external-backup" ]] || rollback_install 130 interrupted; }
    INSTALL_MODE=managed
    INSTALL_KIND=migrate
    EXISTING_PANEL=false
    EXISTING_KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_BINARY_CHANGED=true
    KIXDNS_UNIT_CHANGED=true
    RESOLVED_CHANGED=false
    preserve_external_install
    printf 'NOT-INTERRUPTED\n'
  ) > /dev/null 2>&1 || true
  printf 'AFTER-INTERRUPT=%s\n' "$(cat "${root}/records/external-backup/kixdns.service" 2>/dev/null || printf missing)"
}
assert_equals "$(interrupted_stale_backup)" "AFTER-INTERRUPT=old unit" "旧备份挪走后马上被中断，回滚也要把它放回去"

# ---------------------------------------------------------------------------
# 迁移时的配置 / The config on migration
# ---------------------------------------------------------------------------

# 迁移外部 KixDNS：面板管理的是原配置的副本，放在只有面板会建的目录里；原配置和它所在的目录一点不动。
# 回归：以前原地接管原配置，对它所在的目录做 install -d。/etc/kixdns.json 这样的配置会让 /etc 归面板账号、权限变成 0750，
# 面板 unit 的 ReadWritePaths 还会放开整个 /etc。
# Migrating an external KixDNS: the panel manages a copy of the original config, in a directory only the panel creates; the
# original config and its directory stay exactly as they were. Regression: the config used to be taken over in place, with an
# install -d on its directory. A config like /etc/kixdns.json made /etc the panel account's with mode 0750, and the panel
# unit's ReadWritePaths opened all of /etc.
migration_layout() {
  local root="${WORK}/migration-layout"
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/panel-etc" "${root}/units" "${root}/package/deploy/systemd" \
    "${root}/package/deploy/config"
  cp "${PACKAGE_ROOT}/deploy/systemd/"*.service "${root}/package/deploy/systemd/"
  cp "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${root}/package/deploy/config/"
  printf '{"settings":{"bind_udp":"127.0.0.1:5353","bind_tcp":"127.0.0.1:5353"}}\n' > "${root}/etc/kixdns.json"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${root}/etc/kixdns.json" \
    > "${root}/units/kixdns.service"
  (
    PACKAGE_ROOT="${root}/package"
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${root}/panel-etc/kixdns"
    MIGRATED_KIXDNS_CONFIG="${root}/panel-etc/kixdns/pipeline.json"
    PANEL_ENV="${root}/panel-etc/panel.env"
    : > "${PANEL_ENV}"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    systemctl() {
      case $1 in
        show) printf '{ path=/usr/local/bin/kixdns ; argv[]=/usr/local/bin/kixdns run --config %s ; }\n' "${root}/etc/kixdns.json" ;;
        cat) return 0 ;;
        is-active | is-enabled) return 1 ;;
        *) printf 'systemctl %s\n' "$*" ;;
      esac
    }
    # 改动主机的命令只记下来；临时目录里的目录真的建出来，备份要写进去。面板 unit 装上之前，记下它放开的写入路径。
    # Commands that change the host are only recorded; directories inside the scratch tree are really created, since the
    # backup is written there. Before the panel unit is installed, record the write paths it opens.
    install() {
      printf 'install %s\n' "$*"
      [[ $1 != -d || ${*: -1} != "${root}"/* ]] || mkdir -p -- "${*: -1}"
      [[ ${*: -1} != */kixdns-panel.service ]] || grep '^ReadWritePaths=' "${*: -2:1}"
    }
    chown() { printf 'chown %s\n' "$*"; }
    chmod() { printf 'chmod %s\n' "$*"; }
    rm() { [[ ${*: -1} != "${root}"/* ]] || command rm "$@"; }
    id() { printf '990\n'; }
    mktemp() { local file="${root}/temporary.${RANDOM}"; : > "${file}"; printf '%s\n' "${file}"; }
    update_panel_environment() { :; }
    kixdns_can_read() { return 0; }
    INSTALL_MODE=managed
    detect_existing_kixdns
    determine_install_kind
    validate_install_mode
    plan_kixdns_changes
    printf 'LISTEN=%s\n' "$(kixdns_listen_addresses | tr '\n' ' ')"
    printf 'UNIT=%s\n' "$(render_kixdns_unit | grep '^ExecStart=')"
    render_panel_environment /dev/null "${root}/rendered.env" 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
    printf 'ENV=%s\n' "$(grep '^KIXDNS_CONFIG=' "${root}/rendered.env")"
    preserve_external_install
    printf 'BACKUP=%s\n' "$(grep 'CONFIG=' "${EXTERNAL_BACKUP}/install.env" | tr '\n' ' ')"
    install_configuration
    install_services
  ) 2>&1 || true
}
output="$(migration_layout)"
root="${WORK}/migration-layout"
touched="$(awk -v parent="${root}/etc" -v original="${root}/etc/kixdns.json" '
  ($1 == "install" && $2 == "-d" || $1 == "chown" || $1 == "chmod") && ($NF == parent || $NF == original)
' <<< "${output}")"
assert_equals "${touched}" "" "迁移不能改动原配置和它所在目录的属主或权限"
assert_contains "${output}" "ReadWritePaths=${root}/panel-etc/kixdns /var/lib/kixdns-panel" \
  "面板 unit 只能写迁移副本所在的目录和面板状态目录"
assert_not_contains "${output}" "ReadWritePaths=${root}/etc " "面板 unit 不能写原配置所在的目录"
assert_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/panel-etc/kixdns" \
  "迁移副本放在面板自己建的目录里"
assert_contains "${output}" \
  "install -o kixdns-panel -g kixdns -m 0640 -- ${root}/etc/kixdns.json ${root}/panel-etc/kixdns/pipeline.json" \
  "原配置应原样复制成面板管理的副本"
assert_contains "${output}" \
  "UNIT=ExecStart=/var/lib/kixdns-panel/bin/kixdns run --config ${root}/panel-etc/kixdns/pipeline.json --admin-socket" \
  "迁移后的 KixDNS 应运行副本"
assert_contains "${output}" "ENV=KIXDNS_CONFIG=${root}/panel-etc/kixdns/pipeline.json" "panel.env 应指向副本"
assert_contains "${output}" "BACKUP=KIXDNS_CONFIG=${root}/etc/kixdns.json KIXDNS_MANAGED_CONFIG=${root}/panel-etc/kixdns/pipeline.json " \
  "备份应分开记下原配置和面板管理的副本"
# 副本要到安装那一步才写出来；在那之前查端口，看的必须是原配置里的监听地址，不能退回安装包的默认配置。
# The copy is only written at install time; the port check before that must read the original config's listen
# addresses, not fall back to the package's default config.
assert_contains "${output}" "LISTEN=udp 127.0.0.1:5353 tcp 127.0.0.1:5353 " "迁移前检查端口应按原配置的监听地址"

# 原地管理的情况不变：升级沿用 panel.env 记下的路径（包括旧版原地迁移的主机），面板自己留下的 KixDNS 也不复制。
# What stays managed in place: an upgrade keeps the path panel.env recorded (hosts an older version migrated in place
# included), and the panel's own KixDNS left behind by an earlier uninstall is not copied either.
config_plan_of() {
  (
    INSTALL_KIND=$1
    KIXDNS_BINARY_PATH=$2
    KIXDNS_CONFIG_PATH=$3
    PANEL_CONFIG_DIRECTORY="${WORK}/plan-panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${PANEL_CONFIG_DIRECTORY}/kixdns"
    MIGRATED_KIXDNS_CONFIG="${PANEL_CONFIG_DIRECTORY}/kixdns/pipeline.json"
    kixdns_can_read() { return 0; }
    validate_install_mode
    printf '%s %s\n' "${KIXDNS_CONFIG_PATH}" "${ORIGINAL_KIXDNS_CONFIG_PATH:-none}"
  )
}
mkdir -p "${WORK}/plan-etc"
printf '{}\n' > "${WORK}/plan-etc/kixdns.json"
assert_equals "$(config_plan_of upgrade "${MANAGED_KIXDNS_BINARY}" "${WORK}/plan-etc/kixdns.json")" \
  "${WORK}/plan-etc/kixdns.json none" "升级沿用 panel.env 记下的配置路径"
assert_equals "$(config_plan_of migrate "${MANAGED_KIXDNS_BINARY}" "${WORK}/plan-etc/kixdns.json")" \
  "${WORK}/plan-etc/kixdns.json none" "面板自己留下的 KixDNS 照旧原地管理"
assert_equals "$(config_plan_of migrate /usr/local/bin/kixdns "${WORK}/plan-etc/kixdns.json")" \
  "${WORK}/plan-panel-etc/kixdns/pipeline.json ${WORK}/plan-etc/kixdns.json" "外部 KixDNS 的配置改为管理副本"
assert_equals "$(config_plan_of fresh /usr/local/bin/kixdns "${WORK}/plan-etc/kixdns.json")" \
  "${WORK}/plan-etc/kixdns.json none" "首次安装的配置路径不变"
# 配置本来就在副本的位置：没有别的原文件可复制，原地管理，不能把它当成自己的副本。
# A config already where the copy goes: there is no other original to copy from, so it is managed in place, not treated
# as its own copy.
mkdir -p "${WORK}/plan-panel-etc/kixdns"
printf '{}\n' > "${WORK}/plan-panel-etc/kixdns/pipeline.json"
assert_equals "$(config_plan_of migrate /usr/local/bin/kixdns "${WORK}/plan-panel-etc/kixdns/pipeline.json")" \
  "${WORK}/plan-panel-etc/kixdns/pipeline.json none" "配置已经在副本位置时原地管理"
rm -rf -- "${WORK}/plan-panel-etc"
# install -d 会顺着符号链接改目标的属主和权限：副本所在的目录是符号链接时拒绝迁移。
# install -d would change the owner and mode of a symlink's target: refuse when the copy's directory is a symlink.
mkdir -p "${WORK}/plan-elsewhere"
ln -s "${WORK}/plan-elsewhere" "${WORK}/plan-panel-etc"
output="$(config_plan_of migrate /usr/local/bin/kixdns "${WORK}/plan-etc/kixdns.json" 2>&1 || true)"
assert_contains "${output}" "不能是符号链接" "面板配置目录是符号链接时应拒绝迁移"
rm -f -- "${WORK}/plan-panel-etc"
mkdir -p "${WORK}/plan-panel-etc"
ln -s "${WORK}/plan-elsewhere" "${WORK}/plan-panel-etc/kixdns"
output="$(config_plan_of migrate /usr/local/bin/kixdns "${WORK}/plan-etc/kixdns.json" 2>&1 || true)"
assert_contains "${output}" "不能是符号链接" "副本所在的目录是符号链接时应拒绝迁移"
rm -rf -- "${WORK}/plan-panel-etc"

# 迁移后的 KixDNS 以 kixdns 账号运行、读的是副本，原配置所在的目录不再为它放开：原配置里写的文件它读不到时，
# 在改动主机之前拒绝迁移，并点名每个文件和原因。不存在的文件、目录和不是路径的字符串不算。
# The migrated KixDNS runs as the kixdns account and reads the copy; the original config's directory is no longer opened
# for it. When it cannot read a file the original config names, migration is refused before the host is touched, naming
# each file and why. Missing files, directories and strings that are not paths do not count.
readability_root="${WORK}/readability"
mkdir -p "${readability_root}/private" "${readability_root}/public" "${readability_root}/hidden" "${readability_root}/dir"
: > "${readability_root}/private/geosite.dat"
: > "${readability_root}/public/geoip.mmdb"
: > "${readability_root}/hidden/key.pem"
printf '{"settings":{"geosite_data_paths":["%s","%s"],"geoip_db_path":"%s","doh_path":"/dns-query","doh_tls_key":"%s","x":"%s"}}\n' \
  "${readability_root}/private/geosite.dat" "${readability_root}/public/missing.dat" \
  "${readability_root}/public/geoip.mmdb" "${readability_root}/hidden/key.pem" "${readability_root}/dir" \
  > "${readability_root}/kixdns.json"
readability_of() {
  local denied=$1
  (
    INSTALL_KIND=migrate
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH="${readability_root}/kixdns.json"
    PANEL_CONFIG_DIRECTORY="${WORK}/readability-panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${PANEL_CONFIG_DIRECTORY}/kixdns"
    MIGRATED_KIXDNS_CONFIG="${PANEL_CONFIG_DIRECTORY}/kixdns/pipeline.json"
    KIXDNS_HIDDEN_DIRECTORIES=("${readability_root}/hidden")
    setpriv() { printf 'setpriv %s\n' "$*"; [[ ${*: -1} != "${denied}"* ]]; }
    id() { return 1; }
    getent() { printf 'kixdns:x:991:\n'; }
    validate_install_mode
    printf 'CONTINUED\n'
  ) 2>&1 || true
}
output="$(readability_of "${readability_root}/private/")"
assert_contains "${output}" "迁移后的 KixDNS 以 kixdns 账号运行，读不到原配置 ${readability_root}/kixdns.json 里写的这些文件" \
  "读不到原配置里写的文件时应拒绝迁移"
assert_contains "${output}" "  ${readability_root}/private/geosite.dat：kixdns 账号没有读取权限" "应点名没有权限读的文件"
assert_contains "${output}" "  ${readability_root}/hidden/key.pem：KixDNS 的服务看不到 ${readability_root}/hidden 里的文件" \
  "应点名服务沙箱里看不到的文件"
assert_contains "${output}" "现有 KixDNS 未作修改" "拒绝时应说明主机没有改动"
assert_not_contains "${output}" "CONTINUED" "读不到原配置里写的文件时不能继续安装"
assert_not_contains "${output}" "public/geoip.mmdb：" "读得到的文件不应列出"
assert_not_contains "${output}" "missing.dat" "不存在的文件不应检查"
assert_not_contains "${output}" "/dns-query" "不是文件的字符串不应检查"
assert_not_contains "${output}" "setpriv --reuid=65534 --regid=991 --clear-groups -- test -r ${readability_root}/dir" "目录不应检查"
# kixdns 账号还不存在时，用不拥有任何文件的 nobody 加上 kixdns 组代替它试读。
# While the kixdns account does not exist yet, nobody (which owns no files) with the kixdns group stands in for it.
assert_contains "${output}" "setpriv --reuid=65534 --regid=991 --clear-groups -- test -r ${readability_root}/public/geoip.mmdb" \
  "kixdns 账号不存在时应以 nobody 加 kixdns 组试读"
output="$(readability_of "${WORK}/nothing-denied/")"
assert_contains "${output}" "${readability_root}/hidden/key.pem：KixDNS 的服务看不到" "服务沙箱里的文件有权限也读不到"
output="$(
  (
    INSTALL_KIND=migrate
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH="${readability_root}/kixdns.json"
    PANEL_CONFIG_DIRECTORY="${WORK}/readability-panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${PANEL_CONFIG_DIRECTORY}/kixdns"
    MIGRATED_KIXDNS_CONFIG="${PANEL_CONFIG_DIRECTORY}/kixdns/pipeline.json"
    KIXDNS_HIDDEN_DIRECTORIES=()
    setpriv() { printf 'setpriv %s\n' "$*"; }
    id() { [[ $1 == -u ]] && printf '991\n'; }
    getent() { printf 'kixdns:x:992:\n'; }
    validate_install_mode
    printf 'CONTINUED %s\n' "${KIXDNS_CONFIG_PATH}"
  ) 2>&1 || true
)"
assert_contains "${output}" "CONTINUED ${WORK}/readability-panel-etc/kixdns/pipeline.json" "文件都读得到时应继续迁移"
assert_contains "${output}" "setpriv --reuid=kixdns --regid=992 --init-groups -- test -r ${readability_root}/private/geosite.dat" \
  "kixdns 账号已存在时应以它和它的组试读"
# 没有 setpriv 就无从确认：拒绝迁移并说明缺什么，不能当作读得到。
# Without setpriv there is no way to tell: refuse and say what is missing rather than assume the files are readable.
output="$(
  (
    INSTALL_KIND=migrate
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH="${readability_root}/kixdns.json"
    PANEL_CONFIG_DIRECTORY="${WORK}/readability-panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${PANEL_CONFIG_DIRECTORY}/kixdns"
    MIGRATED_KIXDNS_CONFIG="${PANEL_CONFIG_DIRECTORY}/kixdns/pipeline.json"
    type() { return 1; }
    validate_install_mode
    printf 'CONTINUED\n'
  ) 2>&1 || true
)"
assert_contains "${output}" "系统缺少 setpriv（util-linux）" "没有 setpriv 时应说明缺什么"
assert_not_contains "${output}" "CONTINUED" "没有 setpriv 时不能当作读得到"
# 沙箱目录要和 KixDNS 的 unit 对得上：ProtectHome 藏起 /home、/root、/run/user，PrivateTmp 换掉 /tmp、/var/tmp。
# The hidden directories must match the KixDNS unit: ProtectHome hides /home, /root and /run/user, PrivateTmp replaces
# /tmp and /var/tmp.
if ! grep -qx 'ProtectHome=true' "${PACKAGE_ROOT}/deploy/systemd/kixdns.service" ||
  ! grep -qx 'PrivateTmp=true' "${PACKAGE_ROOT}/deploy/systemd/kixdns.service"; then
  printf '断言失败：KixDNS unit 的沙箱变了，安装器检查的不可见目录要跟着改\n' >&2
  exit 1
fi
assert_equals "${KIXDNS_HIDDEN_DIRECTORIES[*]-}" "/home /root /run/user /tmp /var/tmp" "安装器检查的不可见目录应与 unit 的沙箱一致"

# 面板（kixdns-panel 账号）自己也读原配置里写的 Geo 文件，挑 GeoSite 分类、给 IP 标地区时用。它读不到时不拒绝迁移（DNS 不受
# 影响），安装结果点名这些文件和原因，好让人去改权限。只查面板会读的 Geo 文件（GeoSite、GeoIP），DoH 证书这类面板不读的不查。
# kixdns-panel 账号还没建时和 kixdns 账号一样，用 nobody 加 kixdns 组代替它试读。
# The panel (the kixdns-panel account) reads the Geo files the original config names too, for picking GeoSite categories
# and labelling IP regions. When it cannot, migration is not refused (DNS is unaffected), and the install result names
# those files and why, so the permissions can be fixed. Only the Geo files the panel reads (GeoSite, GeoIP) are checked,
# not ones it never reads such as a DoH certificate. Before the kixdns-panel account exists, nobody with the kixdns group
# stands in for it, as for the kixdns account.
panel_readability_root="${WORK}/panel-readability"
mkdir -p "${panel_readability_root}/kernel-only" "${panel_readability_root}/shared"
for file in kernel-only/geosite.dat kernel-only/geoip.dat kernel-only/key.pem shared/geoip.mmdb shared/geosite.dat; do
  : > "${panel_readability_root}/${file}"
done
printf '{"settings":{"geosite_data_paths":[\n"%s",\n"%s"],"geoip_db_path":"%s","geoip_dat_path":"%s","doh_tls_key":"%s"}}\n' \
  "${panel_readability_root}/kernel-only/geosite.dat" "${panel_readability_root}/shared/geosite.dat" \
  "${panel_readability_root}/shared/geoip.mmdb" "${panel_readability_root}/kernel-only/geoip.dat" \
  "${panel_readability_root}/kernel-only/key.pem" > "${panel_readability_root}/kixdns.json"
printf '{"settings":{"geosite_data_paths":["%s"],"doh_tls_key":"%s"}}\n' \
  "${panel_readability_root}/shared/geosite.dat" "${panel_readability_root}/kernel-only/key.pem" \
  > "${panel_readability_root}/readable.json"
# 参数：原配置，kixdns-panel 账号在不在（exists / missing）。kixdns 账号读得到所有文件，面板（kixdns-panel 或代替它的 nobody）
# 读不到 kernel-only 里的。
# Arguments: the original config, and whether the kixdns-panel account exists (exists / missing). The kixdns account can read
# every file; the panel (kixdns-panel, or nobody standing in for it) cannot read those in kernel-only.
panel_readability_of() {
  local config=$1
  local panel_account=$2
  (
    INSTALL_KIND=migrate
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH=${config}
    PANEL_CONFIG_DIRECTORY="${WORK}/panel-readability-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${PANEL_CONFIG_DIRECTORY}/kixdns"
    MIGRATED_KIXDNS_CONFIG="${PANEL_CONFIG_DIRECTORY}/kixdns/pipeline.json"
    KIXDNS_HIDDEN_DIRECTORIES=()
    setpriv() { printf 'setpriv %s\n' "$*"; [[ $1 == --reuid=kixdns || ${*: -1} != */kernel-only/* ]]; }
    id() { [[ $2 == kixdns || ${panel_account} == exists ]]; }
    getent() { printf 'kixdns:x:992:\n'; }
    validate_install_mode
    printf 'CONTINUED\n'
    PANEL_RELEASE=v3.1.1
    PANEL_BUILD_COMMIT=${commit_a}
    KIXDNS_BUILD_COMMIT=${commit_b}
    KIXDNS_WAS_ACTIVE=true
    KIXDNS_UNIT_CHANGED=false
    PORT_CONFLICT=none
    RESOLVED_CHANGED=false
    print_summary http://192.168.1.20:5738
  ) 2>&1 || true
}
for panel_account in exists missing; do
  output="$(panel_readability_of "${panel_readability_root}/kixdns.json" "${panel_account}")"
  assert_contains "${output}" "CONTINUED" "面板读不到 Geo 文件时不应拒绝迁移（${panel_account}）"
  assert_contains "${output}" "Geo 文件：面板读不到原配置里写的这些，GeoSite 分类和 IP 地区标注会缺它们，DNS 不受影响：" \
    "面板读不到 Geo 文件时安装结果应提醒（${panel_account}）"
  assert_contains "${output}" "  ${panel_readability_root}/kernel-only/geosite.dat：kixdns-panel 账号没有读取权限" \
    "应点名面板读不到的 GeoSite 文件（${panel_account}）"
  assert_contains "${output}" "  ${panel_readability_root}/kernel-only/geoip.dat：kixdns-panel 账号没有读取权限" \
    "应点名面板读不到的 GeoIP 文件（${panel_account}）"
  assert_contains "${output}" "让 kixdns-panel 账号能读到它们，刷新面板页面就有了。" "提醒应说明怎么补上（${panel_account}）"
  assert_not_contains "${output}" "shared/geoip.mmdb：" "面板读得到的文件不应列出（${panel_account}）"
  assert_not_contains "${output}" "shared/geosite.dat：" "面板读得到的文件不应列出（${panel_account}）"
  assert_not_contains "${output}" "key.pem：" "面板不读的文件不应列出（${panel_account}）"
  assert_not_contains "${output}" "读不到原配置 ${panel_readability_root}/kixdns.json 里写的这些文件" \
    "kixdns 账号读得到时不应拒绝（${panel_account}）"
done
output="$(panel_readability_of "${panel_readability_root}/kixdns.json" exists)"
assert_contains "${output}" "setpriv --reuid=kixdns-panel --regid=992 --init-groups -- test -r ${panel_readability_root}/kernel-only/geosite.dat" \
  "kixdns-panel 账号已存在时应以它和它的组试读"
assert_not_contains "${output}" "setpriv --reuid=kixdns-panel --regid=992 --init-groups -- test -r ${panel_readability_root}/kernel-only/key.pem" \
  "面板不读的文件不应以面板账号试读"
output="$(panel_readability_of "${panel_readability_root}/kixdns.json" missing)"
assert_contains "${output}" "setpriv --reuid=65534 --regid=992 --clear-groups -- test -r ${panel_readability_root}/kernel-only/geoip.dat" \
  "kixdns-panel 账号不存在时应以 nobody 加 kixdns 组试读"
output="$(panel_readability_of "${panel_readability_root}/readable.json" exists)"
assert_contains "${output}" "CONTINUED" "面板读得到时应继续迁移"
assert_not_contains "${output}" "Geo 文件：" "面板都读得到时不应提醒"
# 面板 unit 和 KixDNS 的 unit 藏起的目录要一样：KixDNS 看得见（上面查过不在藏起的目录里）的文件，面板的服务也看得见，读不到
# 就只剩权限这一个原因。哪边的沙箱改了，这里都要重新想一遍。
# The panel unit and the KixDNS unit must hide the same directories: a file KixDNS can see (checked above to lie outside
# them) is visible to the panel's service too, leaving permissions as the only reason it cannot be read. When either
# sandbox changes, this needs thinking through again.
sandbox_of() {
  grep -E '^(ProtectHome|PrivateTmp|InaccessiblePaths|TemporaryFileSystem)=' "$1"
}
assert_equals "$(sandbox_of "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel.service")" \
  "$(sandbox_of "${PACKAGE_ROOT}/deploy/systemd/kixdns.service")" "面板 unit 和 KixDNS unit 藏起的目录应一样"

# 迁移失败回滚：删掉副本和它的目录，原配置和它所在的目录一点不动。
# A failed migration rolls back: the copy and its directory are removed, the original config and its directory untouched.
migration_rollback() {
  local root="${WORK}/migration-rollback"
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/panel-etc" "${root}/backup" "${root}/package/deploy/config"
  printf 'original\n' > "${root}/etc/kixdns.json"
  chmod 0604 "${root}/etc/kixdns.json"
  chmod 0751 "${root}/etc"
  : > "${root}/panel-etc/panel.env"
  (
    PACKAGE_ROOT="${root}/package"
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${root}/panel-etc/kixdns"
    MIGRATED_KIXDNS_CONFIG="${root}/panel-etc/kixdns/pipeline.json"
    PANEL_ENV="${root}/panel-etc/panel.env"
    BACKUP_ROOT="${root}/backup"
    INSTALL_KIND=migrate
    INSTALL_MODE=managed
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    KIXDNS_CONFIG_PATH="${root}/etc/kixdns.json"
    kixdns_can_read() { return 0; }
    validate_install_mode
    backup_managed_config
    update_panel_environment() { :; }
    chown() { :; }
    install_configuration
    printf 'COPY=%s\n' "$(cat "${MIGRATED_KIXDNS_CONFIG}")"
    eval "real_restore_path() $(declare -f restore_path | tail -n +2)"
    restore_path() { [[ $1 != "${root}"/* ]] || real_restore_path "$@"; }
    restore_panel_database() { :; }
    systemctl() { :; }
    EXISTING_PANEL=false
    CREATED_EXTERNAL_BACKUP=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    rollback_install 1
  ) 2>&1 || true
  printf 'ORIGINAL=%s %s\n' "$(cat "${root}/etc/kixdns.json")" "$(stat -c '%a' "${root}/etc/kixdns.json")"
  printf 'PARENT=%s\n' "$(stat -c '%a' "${root}/etc")"
  [[ ! -e ${root}/panel-etc/kixdns ]] || printf 'COPY-LEFT\n'
}
output="$(migration_rollback)"
assert_contains "${output}" "COPY=original" "迁移应先写出与原配置相同的副本"
assert_contains "${output}" "ORIGINAL=original 604" "迁移失败后原配置的内容和权限不变"
assert_contains "${output}" "PARENT=751" "迁移失败后原配置所在目录的权限不变"
assert_not_contains "${output}" "COPY-LEFT" "迁移失败应删掉副本和它的目录"

# 回滚删掉这次运行新建的配置目录，连同它上面同样是新建的几层，里面有什么都删：只会是这次运行写的（安装器写的配置，或者刚起来的
# 面板写到一半的临时文件）。回归：回滚只 rmdir 配置目录本身，面板留下的临时文件让它删不掉，新建的上层目录也留着；重新运行时
# #288 把这个「已经存在」的目录当成别人的，拒绝安装。
# Rollback removes the config directory this run created, along with the levels above it that are new too, whatever they
# hold: only what this run wrote can be there (the config the installer wrote, or a temporary file the panel had just begun
# writing). Regression: rollback only rmdir-ed the config directory itself, which a temporary file the panel left made
# impossible, and the new levels above it stayed; a rerun then saw an existing directory and #288 refused it as someone else's.
new_config_directory_rollback() {
  local root="${WORK}/new-config-directory"
  rm -rf -- "${root}"
  mkdir -p "${root}/backup" "${root}/existing"
  # 参数：配置路径，回滚备份目录 / Arguments: the config path, the rollback backup directory
  new_config_round() {
    (
      KIXDNS_CONFIG_PATH=$1
      BACKUP_ROOT=$2
      mkdir -p "${BACKUP_ROOT}"
      backup_managed_config
      mkdir -p "$(dirname -- "${KIXDNS_CONFIG_PATH}")"
      printf '{}\n' > "${KIXDNS_CONFIG_PATH}"
      : > "$(dirname -- "${KIXDNS_CONFIG_PATH}")/.kixdns-panel-Ab12Cd"
      restore_path() { :; }
      restore_panel_database() { :; }
      systemctl() { :; }
      chown() { :; }
      chmod() { :; }
      INSTALL_MODE=managed
      INSTALL_KIND=fresh
      EXISTING_PANEL=false
      KIXDNS_BINARY_CHANGED=false
      KIXDNS_UNIT_CHANGED=false
      RESOLVED_CHANGED=false
      rollback_install 1
    ) > /dev/null 2>&1 || true
  }
  new_config_round "${root}/srv/dns/pipeline.json" "${root}/backup"
  : > "${root}/existing/keep.json"
  new_config_round "${root}/existing/pipeline.json" "${root}/backup-existing"
  rm -f -- "${root}/existing/.kixdns-panel-Ab12Cd"
  [[ ! -e ${root}/srv ]] || printf 'NEW-LEFT %s\n' "$(cd "${root}" && find srv | sort | tr '\n' ' ')"
  [[ -f ${root}/existing/keep.json && ! -e ${root}/existing/pipeline.json ]] || printf 'EXISTING-CHANGED\n'
}
output="$(new_config_directory_rollback)"
assert_not_contains "${output}" "NEW-LEFT" "回滚应删掉这次新建的配置目录和它上面新建的几层"
assert_not_contains "${output}" "EXISTING-CHANGED" "原来就有的配置目录回滚后只删这次写的配置，别的不动"

# 回滚删掉这次运行建的账号，原来就有的不动。回归：回滚以后 kixdns 和 kixdns-panel 账号、kixdns 组都还留着。
# Rollback removes the accounts this run created and leaves the ones that were there. Regression: after a rollback the
# kixdns and kixdns-panel accounts and the kixdns group were all still there.
accounts_rollback() {
  local existing=$1
  (
    calls="${WORK}/accounts-calls"
    : > "${calls}"
    BACKUP_ROOT="$(command mktemp -d "${WORK}/accounts-rollback.XXXXXX")"
    # 这次建的账号名下的东西只在临时目录里找，不碰开发机 / What the new accounts own is looked for in the scratch tree only,
    # never on the dev host
    PANEL_STATE_DIRECTORY="${BACKUP_ROOT}/none/state"
    PANEL_CONFIG_DIRECTORY="${BACKUP_ROOT}/none/panel-etc"
    PANEL_UPDATE_DIRECTORY="${BACKUP_ROOT}/none/update"
    PANEL_RUNTIME_DIRECTORY="${BACKUP_ROOT}/none/run-panel"
    KIXDNS_RUNTIME_DIRECTORY="${BACKUP_ROOT}/none/run-kixdns"
    KIXDNS_CONFIG_PATH="${BACKUP_ROOT}/none/etc-kixdns/pipeline.json"
    mktemp() { printf '%s\n' "${BACKUP_ROOT}"; }
    accounts_exist() { [[ ${existing} == true || -f ${WORK}/accounts-created ]]; }
    rm -f -- "${WORK}/accounts-created"
    id() { accounts_exist && printf '99999\n'; }
    getent() { [[ $1 == group && $2 == systemd-journal ]] && return 2; accounts_exist && printf '%s:x:990:\n' "$2"; }
    groupadd() { printf 'groupadd %s\n' "$*" >> "${calls}"; : > "${WORK}/accounts-created"; }
    useradd() { printf 'useradd %s\n' "$*" >> "${calls}"; : > "${WORK}/accounts-created"; }
    usermod() { :; }
    userdel() { printf 'userdel %s\n' "$*" >> "${calls}"; }
    groupdel() { printf 'groupdel %s\n' "$*" >> "${calls}"; }
    backup_path() { :; }
    backup_managed_config() { :; }
    restore_path() { :; }
    restore_managed_config() { :; }
    record_new_directory() { :; }
    systemctl() { :; }
    INSTALL_MODE=managed
    INSTALL_KIND=fresh
    EXISTING_PANEL=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    prepare_rollback
    create_accounts
    rollback_install 1
  ) > /dev/null 2>&1 || true
  grep -E '^(userdel|groupdel) ' "${WORK}/accounts-calls" | tr '\n' ';'
}
assert_equals "$(accounts_rollback false)" "userdel kixdns-panel;userdel kixdns;groupdel kixdns;" "回滚应删掉这次建的账号和组"
assert_equals "$(accounts_rollback true)" "" "原来就有的账号和组回滚时不能删"
# 回滚要在建账号、建目录之前就挂上：否则这之间的失败不回滚，账号和目录照样留下。
# Rollback must be armed before accounts and directories are created; otherwise a failure in between rolls nothing back and
# they stay behind all the same.
main_body="$(declare -f main)"
rollback_line="$(grep -n 'prepare_rollback' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
accounts_line="$(grep -n 'create_accounts' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${rollback_line} && -n ${accounts_line} && ${rollback_line} -lt ${accounts_line} ]] || {
  printf '断言失败：回滚应在建账号之前挂上（rollback=%s accounts=%s）\n' "${rollback_line}" "${accounts_line}" >&2
  exit 1
}

# 回归（N2）：上次卸载没恢复完时，安装器在问任何问题之前就拒绝（以前先问装成什么，答完才说不能装），查原因的命令写的是备份
# 记下的 unit，不是这次默认的名字。
# Regression (N2): when an earlier uninstall did not finish the restore, the installer refuses before asking anything (it
# used to ask how to install and only then say it could not), and the command to find the cause names the unit the backup
# records, not this run's default name.
main_body="$(declare -f main)"
refuse_line="$(grep -n 'refuse_unfinished_restore' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
# 读任何记录之前，先把旧版放在面板状态目录里的记录挪进只有 root 能进的目录、验过（P2）/ Before any record is read, the
# records older versions kept in the panel's state directory are moved into the root-only directory and checked (P2)
secure_line="$(grep -n 'secure_root_records' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${secure_line} && -n ${refuse_line} && ${secure_line} -lt ${refuse_line} ]] || {
  printf '断言失败：安装器读记录之前要先把它们挪进只有 root 能进的目录（secure=%s refuse=%s）\n' "${secure_line}" "${refuse_line}" >&2
  exit 1
}
for later in load_existing_panel_settings skip_if_already_installed choose_install_mode; do
  later_line="$(grep -n "${later}" <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
  [[ -n ${refuse_line} && -n ${later_line} && ${refuse_line} -lt ${later_line} ]] || {
    printf '断言失败：恢复没做完的拒绝要在 %s 之前（refuse=%s %s=%s）\n' "${later}" "${refuse_line}" "${later}" "${later_line}" >&2
    exit 1
  }
done
validate_body="$(declare -f validate_install_mode)"
assert_not_contains "${validate_body}" "refuse_unfinished_restore" "恢复没做完的拒绝只在开头做一次"
unfinished_restore_refusal() {
  (
    ROOT_RECORDS="${WORK}/unfinished"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    mkdir -p "${EXTERNAL_BACKUP}"
    chmod 0700 "${ROOT_RECORDS}"
    printf 'KIXDNS_SERVICE_UNIT=dns-own.service\n' > "${EXTERNAL_BACKUP}/install.env"
    printf -- '--remove-config\n' > "${EXTERNAL_BACKUP}/restore-incomplete"
    KIXDNS_SERVICE_UNIT=kixdns.service
    refuse_unfinished_restore
  ) 2>&1 || true
}
output="$(unfinished_restore_refusal)"
assert_contains "${output}" "journalctl -u dns-own.service -n 50 --no-pager" "查原因的命令应写备份记下的 unit"
assert_contains "${output}" "| sudo bash -s -- --remove-kixdns --remove-config --yes" "拒绝时应给出用同样选项接着卸载的命令"

# 回归（P1）：面板账号能写的目录里，root 要做的每件事（改属主、改权限、install -d、读写配置）都得等面板停了、kixdns-panel
# 账号的进程一个不剩以后，再查一遍类型才做。以前面板还在跑的时候安装器就动手：面板在检查和 chown 之间把配置换成指向
# /etc/shadow 的符号链接，/etc/shadow 就归了面板。
# Regression (P1): everything root does in a directory the panel account can write (changing owners and modes, install -d,
# reading or writing the config) waits until the panel has stopped and no kixdns-panel process is left, then checks the
# type once more before acting. The installer used to act while the panel still ran: between the check and the chown the
# panel swapped the config for a symlink to /etc/shadow, and /etc/shadow became the panel's.
main_body="$(declare -f main)"
line_of() { grep -n -- "$1" <<< "${main_body}" | head -n 1 | cut -d: -f1 || true; }
stop_line="$(line_of 'stop_panel_processes')"
for later in record_panel_paths require_regular_targets backup_panel_state create_accounts create_panel_directories \
  adopt_github_token preserve_external_install install_configuration install_bundled_metadata; do
  later_line="$(line_of "${later}")"
  [[ -n ${stop_line} && -n ${later_line} && ${stop_line} -lt ${later_line} ]] || {
    printf '断言失败：%s 要等面板的进程都停了才做（stop=%s %s=%s）\n' "${later}" "${stop_line}" "${later}" "${later_line}" >&2
    exit 1
  }
done
# 面板停了以后再查一遍：面板能写的路径不能是符号链接，文件只能有一个链接（硬链接到别处的文件，改属主就改到别处去了）。
# Checked again once the panel has stopped: no path the panel can write may be a symlink, and a file may have one link
# only (changing the owner of a file hard-linked from elsewhere changes it elsewhere too).
targets_verdict() {
  (
    PANEL_STATE_DIRECTORY="${WORK}/targets/state"
    PANEL_UPDATE_DIRECTORY="${WORK}/targets/update"
    MANAGED_KIXDNS_BINARY="${PANEL_STATE_DIRECTORY}/bin/kixdns"
    GITHUB_TOKEN_FILE="${PANEL_STATE_DIRECTORY}/github-token"
    PANEL_SERVER_BINARY="${WORK}/targets/server"
    LIBEXEC_DIRECTORY="${WORK}/targets/libexec"
    KIXDNS_CONFIG_PATH="${WORK}/targets/etc-kixdns/pipeline.json"
    ORIGINAL_KIXDNS_CONFIG_PATH=""
    INSTALL_KIND=upgrade
    require_regular_targets
    printf 'ACCEPTED\n'
  ) 2>&1 || true
}
targets_tree() {
  rm -rf -- "${WORK}/targets"
  mkdir -p "${WORK}/targets/state/bin" "${WORK}/targets/state/geo" "${WORK}/targets/etc-kixdns" "${WORK}/targets/elsewhere"
  printf '{}\n' > "${WORK}/targets/etc-kixdns/pipeline.json"
  printf 'secret\n' > "${WORK}/targets/elsewhere/shadow"
}
targets_tree
assert_contains "$(targets_verdict)" "ACCEPTED" "普通的目录和文件应通过"
targets_tree
rm -f -- "${WORK}/targets/etc-kixdns/pipeline.json"
ln -s "${WORK}/targets/elsewhere/shadow" "${WORK}/targets/etc-kixdns/pipeline.json"
assert_contains "$(targets_verdict)" "不能是符号链接" "面板换成符号链接的配置应被拒绝"
targets_tree
rm -f -- "${WORK}/targets/etc-kixdns/pipeline.json"
ln "${WORK}/targets/elsewhere/shadow" "${WORK}/targets/etc-kixdns/pipeline.json"
assert_contains "$(targets_verdict)" "有别的硬链接" "硬链接到别处的配置应被拒绝"
targets_tree
rmdir -- "${WORK}/targets/state/bin"
ln -s "${WORK}/targets/elsewhere" "${WORK}/targets/state/bin"
assert_contains "$(targets_verdict)" "不能是符号链接" "面板换成符号链接的目录应被拒绝"

# 回归（M1、S1）：回滚以后主机要和安装前一样。接回保留的 KixDNS 时状态目录本来就在（root:kixdns），这次建的面板账号把它和
# bin、geo 改归了自己，刚起来的面板又写了查询日志；回滚删掉账号以后它们就归了空出来的 UID，以后建的账号拿到这个 UID 就能
# 换掉正在跑的 DNS 程序。现在：动过的、本来就有的目录和文件，回滚时放回原来的属主和权限；这次建的账号名下剩下的（这次建的）删掉；
# 放回文件时不再把已有目录的权限改成 0755。
# Regression (M1, S1): after a rollback the host must be as before the install. Taking back a kept KixDNS, the state
# directory was there already (root:kixdns); the panel account this run created took it, bin and geo over, and the panel
# that had just started wrote a query log. Once the rollback removed the account they belonged to a freed UID, and a later
# account given that UID could replace the running DNS program. Now the existing directories and files the run changed get
# their owner and mode back, whatever the new account still owns (made by this run) goes, and putting files back no longer
# resets an existing directory to 0755.
rollback_owners() {
  local root="${WORK}/rollback-owners"
  rm -rf -- "${root}"
  mkdir -p "${root}/state/bin" "${root}/state/geo" "${root}/etc-kixdns" "${root}/panel-etc" "${root}/update" "${root}/records"
  chmod 0700 "${root}/records"
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  printf '{}\n' > "${root}/etc-kixdns/pipeline.json"
  chmod 0751 "${root}/state" "${root}/state/bin" "${root}/state/geo" "${root}/etc-kixdns"
  (
    calls="${root}/calls"
    : > "${calls}"
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    PANEL_ENV="${root}/panel-etc/panel.env"
    PANEL_STATE_DIRECTORY="${root}/state"
    PANEL_UPDATE_DIRECTORY="${root}/update"
    PANEL_RUNTIME_DIRECTORY="${root}/run-panel"
    KIXDNS_RUNTIME_DIRECTORY="${root}/run-kixdns"
    PANEL_SHARE_DIRECTORY="${root}/share"
    LIBEXEC_DIRECTORY="${root}/libexec"
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    ROOT_UID="$(id -u)"
    MANAGED_KIXDNS_BINARY="${root}/state/bin/kixdns"
    GITHUB_TOKEN_FILE="${root}/state/github-token"
    PANEL_DATABASE="${root}/state/panel.db"
    KIXDNS_CONFIG_PATH="${root}/etc-kixdns/pipeline.json"
    BACKUP_ROOT="${root}/backup"
    mkdir -p "${BACKUP_ROOT}"
    mktemp() { printf '%s\n' "${BACKUP_ROOT}"; }
    # 面板账号是这次建的：开始时没有，之后有 / The panel account is this run's: absent at the start, present later
    id() {
      [[ $1 == -u && $2 == kixdns-panel ]] || return 0
      [[ -f ${root}/panel-created ]] && command id -u
    }
    getent() { printf 'kixdns:x:990:\n'; }
    useradd() { : > "${root}/panel-created"; }
    groupadd() { :; }
    usermod() { :; }
    userdel() { printf 'userdel %s\n' "$*" >> "${calls}"; }
    groupdel() { :; }
    install() {
      local arguments=()
      while [[ $# -gt 0 ]]; do
        case $1 in -o | -g) shift ;; *) arguments+=("$1") ;; esac
        shift
      done
      [[ ${arguments[*]: -1} != "${root}"/* ]] || command install "${arguments[@]}"
    }
    chown() { printf 'chown %s\n' "$*" >> "${calls}"; }
    eval "real_backup_path() $(declare -f backup_path | tail -n +2)"
    eval "real_restore_path() $(declare -f restore_path | tail -n +2)"
    backup_path() { [[ $1 != "${root}"/* ]] || real_backup_path "$@"; }
    restore_path() { [[ $1 != "${root}"/* ]] || real_restore_path "$@"; }
    systemctl() { :; }
    INSTALL_MODE=managed
    INSTALL_KIND=reclaim
    EXISTING_PANEL=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    prepare_rollback
    # 和 main 一样：面板的进程都没了以后才记下面板能写的路径 / As in main: the panel's paths are recorded once its
    # processes are gone
    record_panel_paths
    backup_panel_state
    create_accounts
    create_panel_directories
    install_configuration() { :; }
    # 刚起来的面板写的查询日志 / The query log the panel wrote once started
    mkdir -p "${root}/state/querylog"
    : > "${root}/state/querylog/state.json"
    # 刚起来的面板在运行目录里留下的 socket：状态目录有 sweep_new_panel_files 删，运行目录只有 remove_owned_by 会删
    # The socket the panel left in its runtime directory once started: the state directory is swept by
    # sweep_new_panel_files, the runtime directory only by remove_owned_by
    mkdir -p "${root}/run-panel"
    : > "${root}/run-panel/panel.sock"
    rollback_install 1
  ) > /dev/null 2>&1 || true
  printf 'MODES=%s\n' "$(stat -c '%a' "${root}/state" "${root}/state/bin" "${root}/state/geo" "${root}/etc-kixdns" | tr '\n' ' ')"
  [[ -e ${root}/state/querylog ]] && printf 'QUERYLOG-LEFT\n'
  [[ -e ${root}/run-panel/panel.sock ]] && printf 'RUNTIME-LEFT\n'
  [[ -e ${root}/state/versions ]] && printf 'VERSIONS-LEFT\n'
  [[ -f ${root}/state/bin/kixdns ]] || printf 'PROGRAM-LOST\n'
  grep -E "^chown -h [0-9]+:[0-9]+ -- ${root}/state$" "${root}/calls" > /dev/null && printf 'STATE-OWNER-RESTORED\n'
  grep -c '^userdel kixdns-panel' "${root}/calls" | sed 's/^/USERDEL=/'
}
output="$(rollback_owners)"
assert_contains "${output}" "MODES=751 751 751 751 " "回滚以后本来就有的目录权限不变"
assert_contains "${output}" "STATE-OWNER-RESTORED" "回滚应放回状态目录原来的属主"
assert_not_contains "${output}" "QUERYLOG-LEFT" "回滚应删掉这次建的账号写下的东西"
assert_not_contains "${output}" "RUNTIME-LEFT" "回滚应删掉这次建的账号在状态目录以外写下的东西"
assert_not_contains "${output}" "VERSIONS-LEFT" "回滚应删掉这次新建的目录"
assert_not_contains "${output}" "PROGRAM-LOST" "回滚不能删掉本来就有的 KixDNS 程序"
assert_contains "${output}" "USERDEL=1" "回滚应删掉这次建的面板账号"
# restore_path 只放回备份过的东西：还没来得及备份就回滚，不能把它删掉 / restore_path puts back only what was backed up:
# rolling back before a path was backed up must not delete it
(
  BACKUP_ROOT="${WORK}/never-backed-up"
  mkdir -p "${BACKUP_ROOT}" "${WORK}/never-backed-up-target"
  printf 'live\n' > "${WORK}/never-backed-up-target/file"
  restore_path "${WORK}/never-backed-up-target/file" never
)
assert_equals "$(cat "${WORK}/never-backed-up-target/file" 2>/dev/null || printf missing)" "live" "没备份过的路径回滚时不能删"
# 回归（S1）：放回一样东西时，它所在的目录已经在就不动（install -d 会把已有的目录改成 0755）：以前回滚把只有 root 能进的
# 0700 备份目录改成了谁都能进。建目录的时候，已有的 helper 目录也一样不改权限。
# Regression (S1): putting a thing back leaves its directory alone when it exists (install -d would make an existing one
# 0755): rollback used to make the root-only 0700 backup directory enterable by anyone. Creating directories leaves an
# existing helper directory's mode alone too.
(
  BACKUP_ROOT="${WORK}/restore-parent/rollback"
  mkdir -p "${BACKUP_ROOT}/external-backup" "${WORK}/restore-parent/records"
  chmod 0700 "${WORK}/restore-parent/records"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\n' > "${BACKUP_ROOT}/external-backup/install.env"
  restore_path "${WORK}/restore-parent/records/external-backup" external-backup
)
assert_equals "$(stat -c '%a' "${WORK}/restore-parent/records")" "700" "放回备份时不能改它所在目录的权限"
[[ -f ${WORK}/restore-parent/records/external-backup/install.env ]] ||
  { printf '断言失败：回滚应放回备份\n' >&2; exit 1; }
output="$(
  LIBEXEC_DIRECTORY="${WORK}/existing-libexec"
  mkdir -p "${LIBEXEC_DIRECTORY}"
  install() { printf 'install %s\n' "$*"; }
  create_panel_directories
)"
assert_not_contains "${output}" "${WORK}/existing-libexec" "已有的 helper 目录不能被 install -d 改权限"

# ---------------------------------------------------------------------------
# 配置所在的目录 / The config's directory
# ---------------------------------------------------------------------------

# 面板要原子写配置，安装器就把配置所在的目录交给它：install -d 改归 kixdns-panel、权限 0750，面板 unit 的 ReadWritePaths
# 放开它。这个目录只能是 panel.env 或已有 KixDNS 的 unit 记下的、安装器新建的，或者面板固定的 /etc/kixdns 和迁移副本的目录。
# 回归：全新安装带 --kixdns-config /etc/foo.json 时，/etc 归面板账号、权限变成 0750（别的非 root 账号进不去），面板还能写
# 整个 /etc。
# The panel writes its config atomically, so the installer hands it the config's directory: install -d gives it to
# kixdns-panel with mode 0750, and the panel unit's ReadWritePaths opens it. That directory may only be one panel.env or the
# existing KixDNS's unit records, one the installer creates, or the panel's fixed /etc/kixdns or migration copy directory.
# Regression: a fresh install with --kixdns-config /etc/foo.json gave /etc to the panel account with mode 0750 (no other
# non-root account could enter it), and the panel could write all of /etc.
config_directory_root="${WORK}/config-directory"
config_directory_tree() {
  local root=${config_directory_root}
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/units" "${root}/state/bin" "${root}/package/bin" "${root}/package/deploy/systemd" \
    "${root}/package/deploy/config"
  cp "${PACKAGE_ROOT}/deploy/systemd/"*.service "${root}/package/deploy/systemd/"
  cp "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${root}/package/deploy/config/"
  cp "${PACKAGE_ROOT}/deploy/panel.env.example" "${root}/package/deploy/"
  printf 'kixdns\n' > "${root}/package/bin/kixdns"
  printf '{}\n' > "${root}/etc/foo.json"
}
# 用安装器自己的函数从参数一路走到装好服务。改动主机的命令只记下来；临时目录里的目录真的建出来。面板 unit 装上之前，记下它
# 放开的写入路径。CONFIG_DIRECTORY_UNIT 非空时，主机上有一个面板自带 KixDNS 的 unit，配置是它；CONFIG_DIRECTORY_KIXDNS=true
# 时只剩面板目录里的 KixDNS 程序、没有 unit。
# Walk from the arguments to the installed services with the installer's own functions. Commands that change the host are
# only recorded; directories inside the scratch tree are really created. Before the panel unit is installed, record the
# write paths it opens. With CONFIG_DIRECTORY_UNIT set, the host has a unit of the panel's own KixDNS running that config;
# with CONFIG_DIRECTORY_KIXDNS=true only the KixDNS program in the panel's directory is left, without a unit.
config_directory_run() {
  local root=${config_directory_root}
  (
    PACKAGE_ROOT="${root}/package"
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    PANEL_ENV="${root}/panel-etc/panel.env"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${root}/panel-etc/kixdns"
    MIGRATED_KIXDNS_CONFIG="${root}/panel-etc/kixdns/pipeline.json"
    KIXDNS_CONFIG_DIRECTORY="${root}/etc-kixdns"
    KIXDNS_CONFIG_PATH="${root}/etc-kixdns/pipeline.json"
    MANAGED_KIXDNS_BINARY="${root}/state/bin/kixdns"
    KIXDNS_BINARY_PATH=${MANAGED_KIXDNS_BINARY}
    PANEL_SERVER_BINARY="${root}/panel-server"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    SYSTEMD_VENDOR_DIRECTORIES=("${root}/vendor-units")
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    # 临时主机上的文件都归跑测试的用户，由他代替 root；FORGED_RECORDS=true 时 root 是别人
    # The scratch host's files belong to the user running the test, who stands in for root; with FORGED_RECORDS=true root
    # is someone else
    ROOT_UID="$(id -u)"
    if [[ ${FORGED_RECORDS:-} == true ]]; then
      ROOT_UID=0
      # 只冒充记录：panel.env 照样是 root 的，只有 root 能进的记录目录也照样是 root 的 / Only the records are forged: panel.env
      # is root's as ever, and so is the root-only records directory
      panel_env_trusted() { return 0; }
      stat() {
        if [[ $1 == -c && ${*: -1} == "${root}/records" ]]; then
          case $2 in
            %u) printf '0\n' ;;
            '%u %a') printf '0 %s\n' "$(command stat -c '%a' -- "${root}/records")" ;;
            *) command stat "$@" ;;
          esac
          return
        fi
        command stat "$@"
      }
    fi
    INSTALL_MODE=auto
    PANEL_ONLY_UPDATE=false
    EXISTING_PANEL=false
    EXISTING_KIXDNS=false
    EXISTING_KIXDNS_UNIT=false
    ORIGINAL_KIXDNS_CONFIG_PATH=""
    KIXDNS_UNIT_CONFIG_PATH=""
    unit_config=${CONFIG_DIRECTORY_UNIT:-}
    systemctl() {
      case $1 in
        cat) [[ -n ${unit_config} ]] ;;
        show)
          [[ -z ${unit_config} ]] ||
            printf '{ path=%s ; argv[]=%s run --config %s ; }\n' "${MANAGED_KIXDNS_BINARY}" "${MANAGED_KIXDNS_BINARY}" "${unit_config}"
          ;;
        is-active | is-enabled) return 1 ;;
        *) printf 'systemctl %s\n' "$*" ;;
      esac
    }
    install() {
      local mode=""
      local argument
      printf 'install %s\n' "$*"
      for argument in "$@"; do
        [[ ${argument} != [0-7][0-7][0-7][0-7] ]] || mode=${argument}
      done
      if [[ $1 == -d && ${*: -1} == "${root}"/* ]]; then
        mkdir -p -- "${*: -1}"
        [[ -z ${mode} ]] || command chmod "${mode}" "${*: -1}"
      fi
      [[ ${*: -1} != */kixdns-panel.service ]] || grep '^ReadWritePaths=' "${*: -2:1}"
    }
    # SEPARATE_FILESYSTEM=true：状态目录在别的文件系统上 / The state directory on a filesystem of its own
    if [[ ${SEPARATE_FILESYSTEM:-} == true ]]; then
      same_filesystem() { [[ $1 != "${root}/state" && $2 != "${root}/state" ]]; }
      # 跨文件系统的 mv 不是一次 rename：记下来，看有没有直接挪到会被信的名字上 / Across filesystems mv is no single rename:
      # it is logged, to see whether anything moves straight onto a trusted name
      mv() { printf 'mv %s\n' "$*" >> "${root}/mv.log"; command mv "$@"; }
    fi
    ROOT_CHAIN_TOP=${root}
    chown() { printf 'chown %s\n' "$*"; }
    # 权限真的改（只在临时目录里），列出改了什么时才看得出；属主改不了，只记下来
    # Modes really change (inside the scratch tree only), so the list of what changed can see them; owners cannot, and are
    # only recorded
    chmod() { printf 'chmod %s\n' "$*"; [[ ${*: -1} != "${root}"/* ]] || command chmod "$@"; }
    # 临时主机上的文件都算面板的，REPAIRED_DIRECTORY 这个目录除外（管理员已经改回 root 的）/ Every file of the scratch host
    # counts as the panel's, except REPAIRED_DIRECTORY (one the admin already gave back to root)
    panel_owned() { [[ $1 != "${REPAIRED_DIRECTORY:-}" ]]; }
    rm() { [[ ${*: -1} != "${root}"/* ]] || command rm "$@"; }
    id() { printf '990\n'; }
    # 原来的 KixDNS 以 kxu 账号运行时，它的主组是 1001；还有个 staff 组 / When the original KixDNS runs as the kxu account, its
    # primary group is 1001; there is a staff group too
    getent() {
      case "$1 $2" in
        "passwd kxu") printf 'kxu:x:1001:1001::/nonexistent:/usr/sbin/nologin\n' ;;
        "group staff") printf 'staff:x:50:\n' ;;
        *) return 2 ;;
      esac
    }
    mktemp() { local file="${root}/temporary.${RANDOM}"; : > "${file}"; printf '%s\n' "${file}"; }
    update_panel_environment() { :; }
    PANEL_STATE_DIRECTORY="${root}/state"
    parse_arguments "$@"
    # 和 main 一样的顺序 / In the same order as main
    check_panel_env_trust
    secure_root_records
    refuse_unfinished_restore
    load_existing_panel_settings
    # 没有 unit 时不检测：主机上 PATH 里或 /usr/local/bin 下有 kixdns 会把这里变成迁移。
    # Without a unit, skip detection: a kixdns on this host's PATH or in /usr/local/bin would turn this into a migration.
    if [[ -n ${unit_config} || ${EXISTING_PANEL} == true ]]; then
      detect_existing_kixdns
    else
      EXISTING_KIXDNS=${CONFIG_DIRECTORY_KIXDNS:-false}
    fi
    choose_install_mode
    determine_install_kind
    validate_install_mode
    require_dedicated_config_directory
    plan_kixdns_changes
    printf 'PLANNED %s %s restart=%s unit=%s\n' "${INSTALL_KIND}" "${KIXDNS_CONFIG_PATH}" "${KIXDNS_RESTART}" \
      "${KIXDNS_UNIT_CHANGED}"
    install_configuration
    install_services
    printf 'UNIT=%s\n' "$(render_kixdns_unit | grep '^ExecStart=')"
    printf 'UNIT-OWN-LINES=%s\n' "$(render_kixdns_unit | grep -c '^# 主机上自己加的$' || true)"
    print_summary http://192.168.1.20:5738
  ) 2>&1 || true
}
# 改动了这个目录或它里面那份配置的属主、权限的命令。/ The commands that changed the owner or mode of this directory or of the config in it.
config_directory_touched() {
  awk -v directory="$2" -v config="$2/foo.json" '
    ($1 == "install" && $2 == "-d" || $1 == "chown" || $1 == "chmod") && ($NF == directory || $NF == config)
  ' <<< "$1"
}
root=${config_directory_root}
config_directory_message="换一个还不存在的目录，或者去掉 --kixdns-config，用默认的 ${root}/etc-kixdns/pipeline.json；要沿用已有的配置，先把它复制过去。"

config_directory_tree
output="$(config_directory_run --kixdns-config "${root}/etc/foo.json")"
assert_equals "$(config_directory_touched "${output}" "${root}/etc")" "" "全新安装不能改动已有目录和里面配置的属主或权限"
assert_not_contains "${output}" "ReadWritePaths=${root}/etc " "全新安装不能让面板写已有的目录"
assert_contains "${output}" "安装失败：KixDNS 配置不能放在 ${root}/etc：面板要能写配置所在的目录，而这个目录已经存在，安装器不会把它交给面板。" \
  "配置落在已有目录里时应说明为什么拒绝"
assert_contains "${output}" "${config_directory_message}" "拒绝时应说明换到哪里"
assert_not_contains "${output}" "PLANNED" "配置落在已有目录里时应在改动主机之前拒绝"

# 上次安装留下的 panel.env 记的是别的目录：这个已有的目录照样不交出去。
# A panel.env left by an earlier install records another directory: this existing one is still not handed over.
config_directory_tree
mkdir -p "${root}/panel-etc" "${root}/kept"
printf 'KIXDNS_CONFIG=%s\n' "${root}/kept/pipeline.json" > "${root}/panel-etc/panel.env"
output="$(config_directory_run --kixdns-config "${root}/etc/foo.json")"
assert_contains "${output}" "KixDNS 配置不能放在 ${root}/etc：" "panel.env 记的是别的目录时仍应拒绝已有目录"
assert_not_contains "${output}" "PLANNED" "panel.env 记的是别的目录时不能继续安装"

# 上次安装时 panel.env 记下的目录（卸载时保留了面板配置）：那是面板自己的目录，照旧交给它。
# The directory panel.env recorded in an earlier install (the uninstall kept the panel's config): it is the panel's own,
# and goes to it as before.
config_directory_tree
mkdir -p "${root}/panel-etc" "${root}/kept"
printf '{"kept":true}\n' > "${root}/kept/pipeline.json"
printf 'KIXDNS_CONFIG=%s\n' "${root}/kept/pipeline.json" > "${root}/panel-etc/panel.env"
output="$(config_directory_run --kixdns-config "${root}/kept/pipeline.json")"
assert_contains "${output}" "PLANNED fresh ${root}/kept/pipeline.json" "panel.env 记下的目录应照旧可用"
# 已有的目录不用 install -d，查过以后 chown -h（R3）/ An existing directory gets chown -h after the check, not install -d (R3)
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${root}/kept"$'\n' "panel.env 记下的目录照旧交给面板"
assert_not_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/kept" "已有的目录不能用 install -d"

# 还不存在的目录由安装器新建，交给面板。/ A directory that does not exist yet is created by the installer and handed to the panel.
config_directory_tree
output="$(config_directory_run --kixdns-config "${root}/srv/kixdns/pipeline.json")"
assert_contains "${output}" "PLANNED fresh ${root}/srv/kixdns/pipeline.json" "还不存在的目录应可用"
assert_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/srv/kixdns" "新建的配置目录归面板"
assert_contains "${output}" "ReadWritePaths=${root}/srv/kixdns /var/lib/kixdns-panel" "面板 unit 只放开新建的配置目录"

# 默认的 /etc/kixdns 已经存在（比如先放好了配置）：那是面板固定的位置，照旧接管，留下已有的配置。
# The default /etc/kixdns already exists (say a config was put there first): it is the panel's fixed location, taken over as
# before, keeping the config already there.
config_directory_tree
mkdir -p "${root}/etc-kixdns"
printf '{"prepared":true}\n' > "${root}/etc-kixdns/pipeline.json"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED fresh ${root}/etc-kixdns/pipeline.json" "默认目录已经存在时应照旧安装"
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${root}/etc-kixdns"$'\n' "默认目录照旧交给面板"
assert_not_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/etc-kixdns" "已有的默认目录不能用 install -d"
# 不跟着符号链接改（P1）/ Without following a symlink (P1)
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${root}/etc-kixdns/pipeline.json" "默认目录里已有的配置照旧归面板"
# 回归（N4）：/etc/kixdns 是面板固定的位置，可它里面放着配置以外的东西时，和别的目录一样不交给面板：以前只看路径，面板拿到
# 这个目录就能改里面别人的文件。所以这里先把准备好的 pipeline.json 移走，再试别的文件名；pipeline.json 还在时 custom.json 要拒绝。
# Regression (N4): /etc/kixdns is the panel's fixed place, but when it holds anything besides the config it is not handed
# to the panel, like any other directory: only the path used to count, and a panel given the directory could change the
# others' files in it. So the prepared pipeline.json is moved off before another file name is tried; with pipeline.json
# still there, custom.json is refused.
# 上一次运行新建的 panel.env 现在照实记下了配置的位置（以前新建时先照示例写 /etc/kixdns/pipeline.json）：这里要的是没记过这个目录的主机
# The panel.env the previous run created now records the config's real place (it used to be written from the example's
# /etc/kixdns/pipeline.json first): what is wanted here is a host that never recorded this directory
rm -f -- "${root}/panel-etc/panel.env"
output="$(config_directory_run --kixdns-config "${root}/etc-kixdns/custom.json")"
assert_contains "${output}" "安装失败：KixDNS 配置要放在 ${root}/etc-kixdns，面板要能写这个目录，可里面还放着别的文件（${root}/etc-kixdns/pipeline.json）。先把它们移走再重新运行。" \
  "/etc/kixdns 里放着别的文件时应拒绝并说明"
assert_not_contains "${output}" "PLANNED" "/etc/kixdns 里放着别的文件时应在改动主机之前拒绝"
rm -f -- "${root}/etc-kixdns/pipeline.json"
output="$(config_directory_run --kixdns-config "${root}/etc-kixdns/custom.json")"
assert_contains "${output}" "PLANNED fresh ${root}/etc-kixdns/custom.json" "默认目录里的其他文件名应可用"
config_directory_tree
mkdir -p "${root}/etc-kixdns"
: > "${root}/etc-kixdns/notes.txt"
output="$(config_directory_run)"
assert_contains "${output}" "可里面还放着别的文件（${root}/etc-kixdns/notes.txt）" "/etc/kixdns 里放着别的文件时默认安装也应拒绝"
assert_not_contains "${output}" "PLANNED" "/etc/kixdns 里放着别的文件时默认安装应在改动主机之前拒绝"

# 放着 panel.env 的面板配置目录不能交给面板，哪怕它还不存在：面板能改 panel.env，下次以 root 运行的安装器就会照着它改别的目录。
# The panel's config directory, which holds panel.env, never goes to the panel, even before it exists: a panel that could
# rewrite panel.env would steer the next installer run, as root, onto other directories.
config_directory_tree
output="$(config_directory_run --kixdns-config "${root}/panel-etc/pipeline.json")"
assert_contains "${output}" "安装失败：KixDNS 配置不能放在 ${root}/panel-etc：面板要能写配置所在的目录，而这里的 panel.env 只能由 root 修改。" \
  "配置放在面板配置目录时应说明为什么拒绝"
assert_contains "${output}" "${config_directory_message}" "拒绝时应说明换到哪里"
assert_not_contains "${output}" "PLANNED" "配置放在面板配置目录时应在改动主机之前拒绝"

# 全新安装时自己建的配置目录（只放着这份配置）：升级沿用 panel.env 记下的路径，照旧交给面板。
# A config directory a fresh install created for itself (holding this config only): an upgrade keeps the path panel.env
# records and hands it to the panel as before.
upgrade_host_tree() {
  config_directory_tree
  mkdir -p "${root}/panel-etc"
  printf 'KIXDNS_CONFIG=%s\nKIXDNS_SERVICE_UNIT=kixdns.service\n' "${root}/etc/foo.json" > "${root}/panel-etc/panel.env"
  : > "${root}/panel-server"
  chmod 0755 "${root}/panel-server"
  (
    PACKAGE_ROOT="${root}/package"
    KIXDNS_CONFIG_PATH="${root}/etc/foo.json"
    render_kixdns_unit > "${root}/units/kixdns.service"
  )
}
upgrade_host_tree
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/etc/foo.json" "升级应沿用 panel.env 记下的配置路径"
assert_contains "${output}" "ReadWritePaths=${root}/etc /var/lib/kixdns-panel" "只放着这份配置的目录照旧交给面板"
assert_not_contains "${output}" "配置：" "没换配置位置时不应说配置"

# 回归（I1）：v4.3.4 及更早原地迁移的主机，原配置所在的目录（比如 /etc）一直归面板（kixdns-panel:kixdns 0750，面板 unit 的
# ReadWritePaths 放开它，等于 root），每次重装还重新交一遍。以前这里断言的「升级时旧主机的面板 unit 照旧」（ReadWritePaths 是
# 原配置的目录）断言的正是这个错。现在升级时改成新迁移的样子：复制到副本、panel.env 和 unit 改指副本、备份记下副本，原配置和
# 它的目录交还给原来的 KixDNS：目录 root:root 0755，文件归 root、组是原来的 unit 运行用的组、0640。
# Regression (I1): on hosts migrated in place by v4.3.4 and earlier, the original config's directory (/etc, say) stayed the
# panel's (kixdns-panel:kixdns 0750, opened by the panel unit's ReadWritePaths, as good as root), handed over again on every
# reinstall. The "old host's panel unit unchanged on upgrade" asserted here before (ReadWritePaths on the original's
# directory) asserted exactly that bug. An upgrade now turns it into what a new migration makes: a copy, panel.env and the
# unit pointing at it, the backup recording it, and the original and its directory handed back to the original KixDNS: the
# directory root:root 0755, the file owned by root with the group the original unit runs as, 0640.
legacy_host_tree() {
  upgrade_host_tree
  : > "${root}/etc/passwd-like"
  # 旧版把备份放在面板的状态目录里 / Older versions kept the backup in the panel's state directory
  mkdir -p "${root}/state/external-backup"
  printf '%s\n' KIXDNS_SERVICE_UNIT=kixdns.service "KIXDNS_CONFIG=${root}/etc/foo.json" KIXDNS_BINARY=/usr/local/bin/kixdns \
    KIXDNS_WAS_ACTIVE=true KIXDNS_WAS_ENABLED=true > "${root}/state/external-backup/install.env"
  printf '[Unit]\nDescription=x\n[Service]\n%bExecStart=/usr/local/bin/kixdns run --config %s\n' "${1:-}" "${root}/etc/foo.json" \
    > "${root}/state/external-backup/kixdns.service"
  # 和旧版安装器建的一样：目录 0700、文件 0600 / As the older installer made it: directory 0700, files 0600
  chmod 0700 "${root}/state/external-backup"
  chmod 0600 "${root}/state/external-backup/install.env" "${root}/state/external-backup/kixdns.service"
  # 旧版把原配置的目录交给面板时改成 0750；配置的权限和交还后的不同，交还时才看得出改了
  # The older version made the original config's directory 0750 when it handed it to the panel; the config's mode differs
  # from the one it gets back, so the hand-back shows
  chmod 0750 "${root}/etc"
  chmod 0600 "${root}/etc/foo.json"
}
for legacy_arguments in "" --panel-only-update; do
  legacy_host_tree 'User=kxu\n'
  # 已装的 unit 里主机自己加的一行：仅更新面板只改配置路径，这行要留着 / A line the host added to the installed unit: a
  # panel-only update changes only the config path, so it stays
  printf '# 主机上自己加的\n' >> "${root}/units/kixdns.service"
  # shellcheck disable=SC2086 # 空参数就是不带参数 / An empty argument means none
  output="$(config_directory_run ${legacy_arguments})"
  label=${legacy_arguments:-升级}
  assert_contains "${output}" "${root}/panel-etc/kixdns/pipeline.json restart=false unit=true" "旧版原地迁移的主机应改管副本、换 unit（${label}）"
  assert_contains "${output}" "ReadWritePaths=${root}/panel-etc/kixdns /var/lib/kixdns-panel" "面板 unit 只能写副本的目录（${label}）"
  assert_not_contains "${output}" "ReadWritePaths=${root}/etc " "面板 unit 不能再写原配置的目录（${label}）"
  assert_not_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/etc"$'\n' "不能再把原配置的目录交给面板（${label}）"
  assert_contains "${output}" "install -o kixdns-panel -g kixdns -m 0640 -- ${root}/etc/foo.json ${root}/panel-etc/kixdns/pipeline.json" \
    "应把原配置复制成副本（${label}）"
  assert_contains "${output}" "chown -h root:root -- ${root}/etc"$'\n' "原配置的目录应交还 root（${label}）"
  assert_contains "${output}" "chmod 0755 -- ${root}/etc"$'\n' "原配置的目录应是 0755（${label}）"
  assert_contains "${output}" "chown -h root:1001 -- ${root}/etc/foo.json" "原配置应归 root、组是原来的 KixDNS 运行用的组（${label}）"
  assert_contains "${output}" "chmod 0640 -- ${root}/etc/foo.json" "原配置应是 0640（${label}）"
  assert_contains "${output}" "UNIT=ExecStart=/var/lib/kixdns-panel/bin/kixdns run --config ${root}/panel-etc/kixdns/pipeline.json" \
    "KixDNS 的 unit 应改指副本（${label}）"
  backup="$(cat "${root}/records/external-backup/install.env")"
  assert_contains "${backup}" "KIXDNS_CONFIG=${root}/etc/foo.json" "备份里原配置的路径不变（${label}）"
  assert_contains "${backup}" "KIXDNS_MANAGED_CONFIG=${root}/panel-etc/kixdns/pipeline.json" "备份应记下副本（${label}）"
  assert_contains "${backup}" "KIXDNS_LEGACY_IN_PLACE=true" "备份应记下原配置留着的是升级时面板保存的内容（${label}）"
  assert_contains "${output}" "配置：改为管理副本 ${root}/panel-etc/kixdns/pipeline.json，以后在面板里改的都写进副本；原配置 ${root}/etc/foo.json 留着升级这时的内容，交还给原来的 KixDNS" \
    "安装结果应说明改管副本、原配置留着升级时的内容（${label}）"
  assert_contains "${output}" "旧版迁移时把原配置交给了面板，没有记下它原来的属主和权限，这次改成：" "安装结果应说明为什么要改属主（${label}）"
  assert_contains "${output}" "  ${root}/etc：" "安装结果应列出改了的目录（${label}）"
  assert_contains "${output}" "  ${root}/etc/foo.json：" "安装结果应列出改了的文件（${label}）"
done
assert_contains "${output}" "KixDNS：程序未替换，unit 改用新的配置路径，保持原状态（已停止）" "仅更新面板时应说明只换了 unit"
assert_contains "${output}" "UNIT-OWN-LINES=1" "仅更新面板只改 unit 里的配置路径，别的行照旧"
# 原来的 KixDNS 以 root 运行：原配置只留给 root；看不出以谁运行（DynamicUser）：谁都能读。
# The original KixDNS ran as root: the original config is left to root alone; when it cannot be told (DynamicUser): anyone may read it.
for legacy_case in "|0600|root:root" 'DynamicUser=yes\n|0644|root:root' 'User=kxu\nGroup=staff\n|0640|root:staff'; do
  IFS='|' read -r legacy_lines legacy_mode legacy_owner <<< "${legacy_case}"
  legacy_host_tree "${legacy_lines}"
  output="$(config_directory_run)"
  assert_contains "${output}" "chown -h ${legacy_owner} -- ${root}/etc/foo.json" "原配置的属主应按原来的 unit 定（${legacy_lines:-root}）"
  assert_contains "${output}" "chmod ${legacy_mode} -- ${root}/etc/foo.json" "原配置的权限应按原来的 unit 定（${legacy_lines:-root}）"
done
# 回归（N1）：「这次改成」下面只列真改了的路径：目录已经是 root:root 0755 时不列它。
# Regression (N1): under "changed this time" only paths that really changed are listed: a directory already root:root 0755
# is not.
legacy_host_tree 'User=kxu\n'
chmod 0755 "${root}/etc"
output="$(config_directory_run)"
assert_not_contains "${output}" "  ${root}/etc：" "没改的目录不能列在「这次改成」下面"
assert_contains "${output}" "  ${root}/etc/foo.json：" "改了的配置照旧列出"
# 管理员已经把目录改回 root（不再归面板）：照他改的留着，不再交还成 0755。
# The admin already gave the directory back to root (no longer the panel's): it stays as he set it, not handed back as 0755.
legacy_host_tree 'User=kxu\n'
output="$(REPAIRED_DIRECTORY="${root}/etc" config_directory_run)"
assert_not_contains "${output}" "chown -h root:root -- ${root}/etc"$'\n' "不归面板的目录不能再交还"
assert_equals "$(stat -c '%a' "${root}/etc")" "750" "不归面板的目录的权限照管理员改的留着"
assert_not_contains "${output}" "  ${root}/etc：" "没交还的目录不能列出"

# 回归（S2、I4）：交还原配置时的组按原来的 unit 运行用的账号定，这个账号可能写在别处：v4.3.4 的 unit 不在 /etc/systemd/system
# 时备份里没有它（service-file-missing），要按名字在 systemd 的搜索路径上找；User= 也可能写在 drop-in 里。以前找不到 unit 就当
# 看不出来，0700 目录里 0600 的私有配置交还成谁都能读的 0644；drop-in 里的 User= 一旦漏看也一样。
# Regression (S2, I4): the group the original config goes back to follows the account the original unit runs as, which
# may be written elsewhere: when the v4.3.4 unit lived outside /etc/systemd/system the backup lacks it
# (service-file-missing) and it is found by name on the systemd search path; User= may also sit in a drop-in. Not finding
# the unit used to count as not knowing, and a private 0600 config in a 0700 directory came back world-readable 0644; a
# User= in a drop-in, once missed, does the same.
legacy_host_tree ''
rm -f -- "${root}/state/external-backup/kixdns.service"
: > "${root}/state/external-backup/service-file-missing"
chmod 0600 "${root}/state/external-backup/service-file-missing"
mkdir -p "${root}/vendor-units"
printf '[Service]\nUser=kxu\nExecStart=/usr/local/bin/kixdns run --config %s\n' "${root}/etc/foo.json" > "${root}/vendor-units/kixdns.service"
output="$(config_directory_run)"
assert_contains "${output}" "chown -h root:1001 -- ${root}/etc/foo.json" "unit 不在备份里时应按名字找到它，按它运行用的账号交还"
assert_contains "${output}" "chmod 0640 -- ${root}/etc/foo.json" "找到原来的 unit 时不能交还成谁都能读"
legacy_host_tree ''
mkdir -p "${root}/units/kixdns.service.d"
printf '[Service]\nUser=kxu\n' > "${root}/units/kixdns.service.d/override.conf"
output="$(config_directory_run)"
assert_contains "${output}" "chown -h root:1001 -- ${root}/etc/foo.json" "drop-in 里写的 User= 也要算"

# 迁移时把原来的 unit（不管放在哪）和它的 drop-in 一起备份，以后交还配置时照它们定组和权限。
# Migration backs up the original unit (wherever it lives) with its drop-ins, which later decide the group and mode of
# the config handed back.
unit_backup_of() {
  local root="${WORK}/unit-backup"
  rm -rf -- "${root}"
  mkdir -p "${root}/units" "${root}/vendor/kixdns.service.d" "${root}/units/kixdns.service.d" "${root}/records"
  chmod 0700 "${root}/records"
  printf '[Service]\nExecStart=/usr/local/bin/kixdns run\n' > "${root}/vendor/kixdns.service"
  printf '[Service]\nUser=kxu\n' > "${root}/vendor/kixdns.service.d/10-user.conf"
  printf '[Service]\nGroup=staff\n' > "${root}/units/kixdns.service.d/20-group.conf"
  (
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    install() { mkdir -p "${@: -1}"; }
    chmod() { :; }
    systemctl() {
      case $2 in
        --property=FragmentPath) printf '%s\n' "${root}/vendor/kixdns.service" ;;
        --property=DropInPaths) printf '%s %s\n' "${root}/vendor/kixdns.service.d/10-user.conf" "${root}/units/kixdns.service.d/20-group.conf" ;;
      esac
    }
    INSTALL_KIND=migrate
    EXISTING_KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    preserve_external_install
    mapfile -t files < <(original_unit_files "${EXTERNAL_BACKUP}" kixdns.service)
    printf 'FILES=%s\n' "${files[*]##*/}"
    printf 'ACCESS=%s\n' "$(getent() { [[ $1 == group && $2 == staff ]] && printf 'staff:x:50:\n'; }; original_config_access "${files[@]}")"
    grep '^KIXDNS_UNIT_FRAGMENT=' "${EXTERNAL_BACKUP}/install.env"
  ) 2>&1 || true
}
output="$(unit_backup_of)"
assert_contains "${output}" "FILES=unit-fragment unit-dropin-1.conf unit-dropin-2.conf" "迁移应备份原来的 unit 和它的 drop-in"
assert_contains "${output}" "ACCESS=staff 0640" "备份的 unit 和 drop-in 应一起定组和权限"
assert_contains "${output}" "KIXDNS_UNIT_FRAGMENT=${WORK}/unit-backup/vendor/kixdns.service" "备份应记下原来的 unit 放在哪"

# 回归（P2）：备份不是 root 建的（面板账号能在它的状态目录里放一份），安装器不照它改管副本、交还文件。S1（第四轮）以前在改动主机
# 之前停下，面板每次一起来又放一份，以后每次运行都停在这里；现在挪进 quarantine、说一声，当作没有这份记录接着装。
# Regression (P2): a backup root did not make (the panel account can put one in its state directory) is not acted on: no
# copy, no hand-back. Before S1 (fourth review) the installer stopped there, and as the panel planted a new one whenever it
# started, every later run stopped too; now it goes into quarantine, this is said, and the install goes on as if there were
# no such record.
legacy_host_tree 'User=kxu\n'
output="$(FORGED_RECORDS=true config_directory_run)"
assert_contains "${output}" "不是 root 建的" "面板写的备份应被拒绝"
assert_contains "${output}" "这台主机就当作没有这份记录。" "面板写的备份应挪走、接着做"
assert_not_contains "${output}" "安装失败" "面板写的备份不能让安装停下"
assert_not_contains "${output}" "chown root:" "面板写的备份不能让安装器交还任何文件"
# 一份记录要整份都是 root 的才算：面板建的空目录、目录别人能写、里面有符号链接或别的硬链接的，都不算，都挪走、接着做；放记录的
# 目录本身要是只有 root 能进的 0700，不是就停下。
# A record counts only when all of it is root's: an empty directory the panel made, a directory others can write, or one
# holding a symlink or a file with another hard link does not, and each is moved away while the run goes on; the
# directory holding the records must itself be root-only 0700, or the run stops.
legacy_host_tree 'User=kxu\n'
rm -f -- "${root}/state/external-backup"/*
output="$(FORGED_RECORDS=true config_directory_run)"
assert_contains "${output}" "不能信（它不是 root 建的）" "面板建的空目录不能当成记录"
for record_case in symlink hardlink writable; do
  legacy_host_tree 'User=kxu\n'
  case ${record_case} in
    # 指着别人能改的文件的符号链接（指着只有 root 能改的文件的，(b) 照它指着的内容接手，见下面）/ A symlink to a file others can
    # change (one to a file only root can change is adopted by its content, (b), see below)
    symlink)
      mkdir -p "${root}/shared"
      chmod 0777 "${root}/shared"
      : > "${root}/shared/extra"
      ln -s -- "${root}/shared/extra" "${root}/state/external-backup/extra"
      ;;
    hardlink) ln -- "${root}/etc/foo.json" "${root}/state/external-backup/extra" ;;
    writable) chmod 0770 "${root}/state/external-backup" ;;
  esac
  output="$(config_directory_run)"
  assert_contains "${output}" "${root}/state/external-backup 不能信" "记录里有${record_case}时不能照它做事"
  assert_contains "${output}" "这台主机就当作没有这份记录。" "记录里有${record_case}时应挪走、接着做"
  [[ ! -e ${root}/state/external-backup && ! -e ${root}/records/external-backup ]] ||
    { printf '断言失败：记录里有%s时不能留在会被信的名字上\n' "${record_case}" >&2; exit 1; }
done
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0755 "${root}/records"
output="$(config_directory_run)"
assert_contains "${output}" "${root}/records 不是只有 root 能进的目录，不能放安装记录" "放记录的目录别人能进时应拒绝"
assert_not_contains "${output}" "PLANNED" "放记录的目录别人能进时应在改动主机之前拒绝"
# S1：照记录停下时面板不重启，说清怎么先把面板用起来 / S1: a stop over a record does not restart the panel, and says how to
# get it running meanwhile
assert_contains "${output}" "面板和它账号的进程这时都停着，处理好以后再运行一次就会接着做下去" "照记录停下时应说明面板停着"
assert_equals "$(grep -c '^systemctl start kixdns-panel.service' <<< "${output}" || true)" "0" "照记录停下时不能重启面板"
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records/external-backup"
chmod 0700 "${root}/records"
output="$(config_directory_run)"
# 新旧两处都有：只有 root 能进的那份不能信（这里是空目录）时挪走它、停下 / Both places: when the root-only copy cannot be
# trusted (an empty directory here), it is moved away and the run stops
assert_contains "${output}" "${root}/records/external-backup 不能信（里面没有 install.env）" "只有 root 能进的那份不能信时应停下"
assert_not_contains "${output}" "PLANNED" "两处都有、新的那份不能信时应在改动主机之前停下"
# 只有 root 能进的那里已经有一份能信的：用那份，旧位置的不验、挪走，内容一样不一样都这样（第四轮以前，两份都能信又不一样时停下）
# A trusted copy already in the root-only place: that one is used and the old one is moved away unchecked, alike or not
# (before the fourth review, two trusted copies that differed stopped the run)
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0700 "${root}/records"
cp -a -- "${root}/state/external-backup" "${root}/records/external-backup"
printf 'KIXDNS_WAS_ACTIVE=false\n' >> "${root}/records/external-backup/install.env"
output="$(config_directory_run)"
assert_contains "${output}" "${root}/state/external-backup 没有用（挪到了 ${root}/records/quarantine/external-backup." \
  "两份都在时旧位置那份应挪走"
assert_contains "${output}" "只有 root 能进的 ${root}/records/external-backup 里已经有一份，用的是那份。" "两份都在时应说明用的是哪一份"
assert_contains "$(cat "${root}/records/external-backup/install.env")" "KIXDNS_WAS_ACTIVE=false" "两份都在时应照用只有 root 能进的那份"
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0700 "${root}/records"
cp -a -- "${root}/state/external-backup" "${root}/records/external-backup"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/panel-etc/kixdns/pipeline.json" "两份一样时照常装"
[[ ! -e ${root}/state/external-backup ]] || { printf '断言失败：两份一样时旧位置那份应挪走\n' >&2; exit 1; }
# ---------------------------------------------------------------------------
# 第三轮审查：先定 root 照着做事的规则（R1–R4，写在 install.sh 开头），每一处都照做
# Third review: the rules for what root acts on come first (R1–R4, at the top of install.sh), and every site follows them
# ---------------------------------------------------------------------------

# 回归（M-A，R1）：一份不能信的记录以前「关」在只有 root 能进的目录里、名字不变，下一次运行就照它做事（容器里卸载器第二次运行
# 装上并启动了面板写的 unit）。现在不能信的记录挪出所有会被信的名字（ROOT_RECORDS/quarantine，带时间），这次和以后都不再用；
# 再运行一次就当作没有这份记录。
# Regression (M-A, R1): a record that could not be trusted used to be "locked" in the root-only directory under the same
# name, and the next run acted on it (in a container the uninstaller's second run installed and started the unit the panel
# wrote). Now such a record leaves every trusted name (ROOT_RECORDS/quarantine, time-stamped) and is never used by this run
# or any later one; running again treats the host as having no such record.
legacy_host_tree 'User=kxu\n'
output="$(FORGED_RECORDS=true config_directory_run)"
[[ ! -e ${root}/records/external-backup && ! -e ${root}/state/external-backup ]] ||
  { printf '断言失败：拒绝的备份不能还留在会被信的名字上\n' >&2; exit 1; }
quarantined="$(find "${root}/records/quarantine" -mindepth 1 -maxdepth 1 -name 'external-backup.*' -print -quit 2>/dev/null || true)"
[[ -n ${quarantined} && -f ${quarantined}/install.env ]] || { printf '断言失败：拒绝的备份应挪进 quarantine\n' >&2; exit 1; }
assert_contains "${output}" "${root}/state/external-backup 不能信（它不是 root 建的），没有用它（挪到了 ${quarantined}）；这台主机就当作没有这份记录。" \
  "面板写的备份应挪走，说明是哪一份、去了哪里"
output="$(config_directory_run)"
assert_not_contains "${output}" "不能信" "再运行一次不能再碰那份记录"
assert_contains "${output}" "PLANNED upgrade" "再运行一次应当作没有这份记录接着装"
# 符号链接冒充的记录：不跟着它走，也挪走 / A record faked with a symlink: not followed, moved away too
legacy_host_tree 'User=kxu\n'
mv -- "${root}/state/external-backup" "${root}/fake-record"
ln -s -- "${root}/fake-record" "${root}/state/external-backup"
output="$(config_directory_run)"
assert_contains "${output}" "${root}/state/external-backup 不能信（它是符号链接）" "符号链接冒充的记录应被拒绝"
[[ ! -e ${root}/records/external-backup && ! -L ${root}/records/external-backup && ! -L ${root}/state/external-backup ]] ||
  { printf '断言失败：符号链接冒充的记录不能留在会被信的名字上\n' >&2; exit 1; }
[[ -f ${root}/fake-record/install.env ]] || { printf '断言失败：符号链接指着的东西不能动\n' >&2; exit 1; }

# R1：放记录的目录要是 0700，它上面每一层也要归 root、别人写不进、不是符号链接：上面一层别人能写，就能把整个目录换掉。哪一处
# 不对，所有记录都不能信，停下。
# R1: the records directory must be 0700, and every level above must be root's, not writable by others and no symlink:
# with a level above writable by others the whole directory can be swapped. When any of it is wrong, no record can be
# trusted and the run stops.
for chain_case in writable symlink mode; do
  output="$(
    base="${WORK}/chain"
    rm -rf -- "${base}"
    mkdir -p "${base}/real/records/external-backup"
    chmod 0700 "${base}/real/records" "${base}/real/records/external-backup"
    printf 'KIXDNS_SERVICE_UNIT=kixdns.service\n' > "${base}/real/records/external-backup/install.env"
    case ${chain_case} in
      writable)
        mv -- "${base}/real" "${base}/top"
        chmod 0777 "${base}/top"
        ;;
      symlink) ln -s real "${base}/top" ;;
      mode)
        mv -- "${base}/real" "${base}/top"
        chmod 0755 "${base}/top/records"
        ;;
    esac
    ROOT_CHAIN_TOP=${base}
    ROOT_RECORDS="${base}/top/records"
    ROOT_UID="$(id -u)"
    fail() { printf 'FAILED %s\n' "$*"; exit 1; }
    trusted_record external-backup && printf 'TRUSTED\n'
  )" || true
  assert_contains "${output}" "FAILED ${WORK}/chain/top/records 不是只有 root 能进的目录" "放记录的目录不对时不能信（${chain_case}）"
  assert_not_contains "${output}" "TRUSTED" "放记录的目录不对时不能信（${chain_case}）"
done
# R1：记录目录归 root 还不够，里面每个文件也要归 root（这里让 stat 说 install.env 归别的 UID）。
# R1: the record directory being root's is not enough; every file in it must be root's too (here stat says install.env
# belongs to another UID).
output="$(
  record="${WORK}/entry-owner/external-backup"
  rm -rf -- "${WORK}/entry-owner"
  mkdir -p "${record}"
  chmod 0700 "${record}"
  printf 'KIXDNS_SERVICE_UNIT=kixdns.service\n' > "${record}/install.env"
  ROOT_UID="$(id -u)"
  stat() {
    if [[ $1 == -c && $2 == %u && ${*: -1} == "${record}/install.env" ]]; then
      printf '4711\n'
    else
      command stat "$@"
    fi
  }
  record_problem "${record}" external-backup
)"
assert_equals "${output}" "里面的 install.env 不是 root 建的" "记录里有不归 root 的文件时不能信"

# R1：每读一次记录都先验。只有 root 能进的目录里那份坏了（这里是别人能写），哪个地方先读到它，都挪走它、停下，不会照它做事。
# R1: every read of a record checks it first. When the copy in the root-only directory is bad (here: writable by others),
# whichever site reads it first moves it away and stops, never acting on it.
record_reader() {
  local reader=$1
  local base="${WORK}/reader"
  rm -rf -- "${base}"
  mkdir -p "${base}/records/external-backup" "${base}/records/resolved-stub" "${base}/state" "${base}/units"
  chmod 0700 "${base}/records"
  printf '%s\n' KIXDNS_SERVICE_UNIT=kixdns.service "KIXDNS_CONFIG=${base}/etc/foo.json" KIXDNS_BINARY=/usr/local/bin/kixdns \
    KIXDNS_WAS_ACTIVE=true KIXDNS_WAS_ENABLED=true > "${base}/records/external-backup/install.env"
  printf -- '--keep-config\n' > "${base}/records/external-backup/restore-incomplete"
  printf 'RESOLV_CONF_KIND=unchanged\n' > "${base}/records/resolved-stub/install.env"
  chmod 0770 "${base}/records/external-backup" "${base}/records/resolved-stub"
  (
    ROOT_CHAIN_TOP=${base}
    ROOT_RECORDS="${base}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    RESOLVED_STATE="${ROOT_RECORDS}/resolved-stub"
    PANEL_STATE_DIRECTORY="${base}/state"
    SYSTEMD_UNIT_DIRECTORY="${base}/units"
    SYSTEMD_VENDOR_DIRECTORIES=("${base}/vendor")
    PANEL_ENV="${base}/panel.env"
    printf 'KIXDNS_CONFIG=%s\n' "${base}/etc/foo.json" > "${PANEL_ENV}"
    ROOT_UID="$(id -u)"
    install() { mkdir -p "${@: -1}"; chmod 0700 "${@: -1}"; }
    systemctl() { :; }
    rm() { command rm "$@"; }
    BACKUP_ROOT="${base}/rollback"
    mkdir -p "${BACKUP_ROOT}"
    INSTALL_KIND=migrate
    CONFIG_CONVERSION=legacy
    EXISTING_KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
    ORIGINAL_KIXDNS_CONFIG_PATH="${base}/etc/foo.json"
    case ${reader} in
      present) external_backup_present ;;
      unfinished) refuse_unfinished_restore ;;
      legacy) legacy_in_place_migration ;;
      reclaim-note) print_reclaim_backup_note ;;
      replace) preserve_external_install ;;
      backup-original) backup_original_config ;;
      resolved) RESOLVED_CHANGED=true restore_resolved_stub ;;
    esac
    printf 'READ-DONE\n'
  ) 2>&1 || true
  [[ -n "$(find "${base}/records/quarantine" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]] && printf 'QUARANTINED\n'
  return 0
}
for record_reader_name in present unfinished legacy reclaim-note replace backup-original resolved; do
  output="$(record_reader "${record_reader_name}")"
  assert_contains "${output}" "不能信（别人能往里写）" "读记录的 ${record_reader_name} 应先验它"
  assert_contains "${output}" "QUARANTINED" "读到坏记录的 ${record_reader_name} 应把它挪走"
  assert_not_contains "${output}" "READ-DONE" "读到坏记录的 ${record_reader_name} 不能接着做"
done

# 回归（S-E）：迁移过的主机上，面板在状态目录里放一份旧位置的备份，以后每次安装、卸载都停在「两处都在」。现在只有 root 能进的那份
# 能信、旧位置的不能信时，把旧的挪走、说一声，照用能信的那份。
# Regression (S-E): on a migrated host the panel planted a copy at the old location, and every later install and uninstall
# stopped at "both are there". Now, with the root-only copy trusted and the old one not, the old one is moved away, this is
# said, and the trusted copy is used.
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0700 "${root}/records"
cp -a -- "${root}/state/external-backup" "${root}/records/external-backup"
chmod 0770 "${root}/state/external-backup"
output="$(config_directory_run)"
assert_contains "${output}" "${root}/state/external-backup 没有用（挪到了" "旧位置那份应挪走"
assert_contains "${output}" "用的是那份。" "应说明照用的是哪一份"
notice_line="$(grep -F '没有用（' <<< "${output}" || true)"
assert_equals "$(grep -o 'quarantine/external-backup\.' <<< "${notice_line}" | wc -l)" "1" "挪去的地方只说一次"
assert_contains "${output}" "PLANNED upgrade ${root}/panel-etc/kixdns/pipeline.json" "照用能信的那份接着装"
[[ ! -e ${root}/state/external-backup ]] || { printf '断言失败：不能信的旧备份应挪走\n' >&2; exit 1; }

# 回归（结构 1，R1）：旧位置的记录只接手一次。第一次运行（旧位置什么都没有也一样）留下标记；之后旧位置再有的，哪怕整份都归 root
# （root 自己交给 root 的），也不验、不用，挪走、接着做。以前保留 KixDNS、删除面板数据时 root 把面板放的一份交给了 root，下一次
# 安装就当它是真的接手了。
# Regression (structural change 1, R1): records from the old place are adopted once. The first run (with nothing in the old
# place too) leaves the marker; after it, anything showing up in the old place, even all of it root's (handed to root by
# root itself), is never checked or used: moved away, and the run goes on. Before, keeping KixDNS while removing the panel
# data had root hand a copy the panel planted to root, and the next install adopted it as genuine.
upgrade_host_tree
output="$(config_directory_run)"
[[ -f ${root}/records/.adopted ]] || { printf '断言失败：第一次运行即使没有可接手的也应留下标记\n' >&2; exit 1; }
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0700 "${root}/records"
printf 'adopted\n' > "${root}/records/.adopted"
output="$(config_directory_run)"
assert_contains "${output}" "${root}/state/external-backup 不用（挪到了 ${root}/records/quarantine/external-backup." "接手过以后旧位置的记录应挪走"
assert_contains "${output}" "这台主机已经接手过旧版的记录，之后这里再有的都不是 root 写的" "接手过以后应说明为什么不用"
assert_not_contains "${output}" "已验过" "接手过以后旧位置的记录不能再验、再接手"
[[ ! -e ${root}/records/external-backup && ! -e ${root}/state/external-backup ]] ||
  { printf '断言失败：接手过以后旧位置的记录不能出现在会被信的名字上\n' >&2; exit 1; }
assert_not_contains "${output}" "PLANNED upgrade ${root}/panel-etc/kixdns/pipeline.json" "接手过以后旧位置的记录不能用来改管副本"

# 标记只在只有 root 能进的目录里才算：放记录的目录上面一层别人能写时，谁都能放一个标记，不能当作接手过
# The marker counts only in a root-only directory: with a level above the records directory writable by others anyone
# could put one there, so it does not mean adopted
marker_output="$(
  base="${WORK}/marker-chain"
  rm -rf -- "${base}"
  mkdir -p "${base}/top/records"
  chmod 0700 "${base}/top/records"
  : > "${base}/top/records/.adopted"
  chmod 0777 "${base}/top"
  ROOT_CHAIN_TOP=${base}
  ROOT_RECORDS="${base}/top/records"
  ROOT_UID="$(id -u)"
  adoption_done && printf 'ADOPTED\n' || printf 'NOT-ADOPTED\n'
  chmod 0755 "${base}/top"
  adoption_done && printf 'ADOPTED\n' || printf 'NOT-ADOPTED\n'
)"
assert_equals "$(tr '\n' ' ' <<< "${marker_output}")" "NOT-ADOPTED ADOPTED " "放记录的目录上面一层别人能写时，标记不能算数"

# 回归（S-F）：状态目录单独挂一个文件系统时，记录没法一次 rename 挪过去，以前安装、卸载都停下，还留下一个空的记录目录。现在面板
# 停了以后在原地验过、复制过去、验过复制的那份，再删原来的。
# Regression (S-F): with the state directory on a filesystem of its own the records cannot be renamed across, and install
# and uninstall both stopped, leaving an empty records directory. Now, once the panel has stopped, they are checked in
# place, copied, the copy checked, and then the original removed.
legacy_host_tree 'User=kxu\n'
cp -- "${root}/state/external-backup/kixdns.service" "${root}/separate-before"
rm -f -- "${root}/mv.log"
output="$(SEPARATE_FILESYSTEM=true config_directory_run)"
assert_not_contains "${output}" "不在同一个文件系统" "状态目录在别的文件系统上时也应挪过去"
assert_not_contains "$(cat -- "${root}/mv.log" 2>/dev/null || true)" "mv -T -- ${root}/state/external-backup ${root}/records/external-backup" \
  "跨文件系统时要先复制、验过复制的那份，不能直接挪到会被信的名字上"
assert_contains "${output}" "旧版放在 ${root}/state/external-backup 的记录已验过，挪到只有 root 能进的 ${root}/records/external-backup。" \
  "复制过去以后应说明"
[[ ! -e ${root}/state/external-backup ]] || { printf '断言失败：复制过去以后应删掉原来的\n' >&2; exit 1; }
cmp -s -- "${root}/separate-before" "${root}/records/external-backup/kixdns.service" ||
  { printf '断言失败：复制过去的备份应和原来一样\n' >&2; exit 1; }

# 回归（S2，R4）：panel.env 面板能改时，它记的「已经装了这一版」不能让升级跳过；是不是同一版照 root 的面板程序和包里的比。
# Regression (S2, R4): when the panel can change panel.env, its "this version is installed already" must not skip the
# upgrade; whether it is the same version compares root's panel program with the package's.
version_skip() {
  local base="${WORK}/version-skip"
  rm -rf -- "${base}"
  mkdir -p "${base}/package/bin" "${base}/panel-etc"
  printf 'new server\n' > "${base}/package/bin/kixdns-panel-server"
  printf '%s\n' "${1}" > "${base}/panel-server"
  printf 'KIXDNS_PANEL_INSTALLED_COMMIT=%s\n' "${PANEL_BUILD_COMMIT_FIXTURE}" > "${base}/panel-etc/panel.env"
  [[ ${2:-} != untrusted ]] || chmod 0777 "${base}/panel-etc"
  (
    ROOT_CHAIN_TOP=${base}
    ROOT_UID="$(id -u)"
    PACKAGE_ROOT="${base}/package"
    PANEL_ENV="${base}/panel-etc/panel.env"
    PANEL_SERVER_BINARY="${base}/panel-server"
    PANEL_RELEASE=""
    PANEL_BUILD_COMMIT=${PANEL_BUILD_COMMIT_FIXTURE}
    EXISTING_PANEL=true
    PANEL_ENV_TRUSTED=true
    panel_env_trusted || PANEL_ENV_TRUSTED=false
    same_panel_version_installed && printf 'SAME\n' || printf 'DIFFERENT\n'
  )
  chmod 0755 "${base}/panel-etc"
}
PANEL_BUILD_COMMIT_FIXTURE=0123456789abcdef0123456789abcdef01234567
assert_equals "$(version_skip 'old server')" "SAME" "能信的 panel.env 记的版本照旧用来判断"
assert_equals "$(version_skip 'old server' untrusted)" "DIFFERENT" "面板能改的 panel.env 记的版本不能让升级跳过"
assert_equals "$(version_skip 'new server' untrusted)" "SAME" "面板能改的 panel.env 时，面板程序和包里的一样才算同一版"

# 回归（S-D，R4）：v4.3.4 能把 --kixdns-config 放进 /etc/kixdns-panel，这个目录（连同 panel.env）就归了面板。面板改了 panel.env
# 里的配置路径，升级就把它指的目录（容器里是 systemd 的 drop-in 目录）交给了面板。现在 panel.env 只有它和上面每一层目录都只有
# root 能写时才信；不然配置路径照 root 才能改的 KixDNS unit 认，对不上就停下；能信的只有配置路径和 unit 名，账号、归属这些照它
# 做决定的项都不认。
# Regression (S-D, R4): v4.3.4 let --kixdns-config point into /etc/kixdns-panel, which (with panel.env) then belonged to the
# panel. The panel changed the config path in panel.env, and the upgrade handed the directory it named (a systemd drop-in
# directory in the container) to the panel. Now panel.env is trusted only when it and every directory above it are root's
# alone; otherwise the config path is taken from the KixDNS unit only root can change, and a mismatch stops the run; only
# the config path and the unit name are taken from it then, never the keys that decide accounts or ownership.
upgrade_host_tree
chmod 0664 "${root}/panel-etc/panel.env"
sed -i "s|^KIXDNS_CONFIG=.*|KIXDNS_CONFIG=${root}/dropins/pipeline.json|" "${root}/panel-etc/panel.env"
output="$(config_directory_run)"
assert_contains "${output}" "安装失败：${root}/panel-etc/panel.env 面板能改，它记的不能信：它写的 KixDNS 配置 ${root}/dropins/pipeline.json 和 ${root}/units/kixdns.service 里的 ${root}/etc/foo.json 对不上，安装器不会照它做事。" \
  "panel.env 能被面板改、配置又和 unit 对不上时应停下"
assert_not_contains "${output}" "PLANNED" "panel.env 不能信时应在改动主机之前停下"
[[ ! -e ${root}/dropins ]] || { printf '断言失败：不能照面板改的 panel.env 建目录\n' >&2; exit 1; }
upgrade_host_tree
chmod 0664 "${root}/panel-etc/panel.env"
printf 'KIXDNS_REMOVED=true\nKIXDNS_USER_CREATED=true\n' >> "${root}/panel-etc/panel.env"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/etc/foo.json" "配置和 unit 对得上时照 unit 认的路径升级"
untrusted_account_record="$(
  PANEL_ENV="${root}/panel-etc/panel.env"
  ROOT_CHAIN_TOP=${root}
  ROOT_UID="$(id -u)"
  PANEL_ENV_TRUSTED=false
  KIXDNS_USER_EXISTED=true
  kixdns_account_created user
)"
assert_equals "${untrusted_account_record}" "false" "不能信的 panel.env 里记的账号归属不能认"
# MUST 1：不能信的 panel.env 只给照 unit 对上的配置和 unit 名，显示用的几项也不给 / MUST 1: an untrusted panel.env gives only the
# config and unit name matched against the unit, not even the values shown
untrusted_display="$(
  PANEL_ENV="${WORK}/untrusted-display.env"
  printf 'KIXDNS_PANEL_BIND=0.0.0.0:1\nKIXDNS_PANEL_INSTALLED_RELEASE=v9\nKIXDNS_INSTALLED_COMMIT=%s\n' \
    4444444444444444444444444444444444444444 > "${PANEL_ENV}"
  PANEL_ENV_TRUSTED=false
  PANEL_ENV_VERIFIED=true
  for key in KIXDNS_PANEL_BIND KIXDNS_PANEL_INSTALLED_RELEASE KIXDNS_INSTALLED_COMMIT; do
    environment_value "${key}" || printf 'NONE %s\n' "${key}"
  done
)"
assert_equals "${untrusted_display}" $'NONE KIXDNS_PANEL_BIND\nNONE KIXDNS_PANEL_INSTALLED_RELEASE\nNONE KIXDNS_INSTALLED_COMMIT' \
  "不能信的 panel.env 里显示用的几项也不能给"

# 回归（S-G）：账号已经删掉的路径，属主以前写成 UNKNOWN。现在写成「已删除的面板账号（UID n）」。
# Regression (S-G): a path whose account is gone used to show UNKNOWN as its owner. Now it reads 「已删除的面板账号（UID n）」.
deleted_owner="$(
  stat() {
    case $2 in
      %U) printf 'UNKNOWN\n' ;;
      %u) printf '998\n' ;;
      %G) printf 'kixdns\n' ;;
      %a) printf '750\n' ;;
      *) command stat "$@" ;;
    esac
  }
  owner_and_mode /anywhere
)"
assert_equals "${deleted_owner}" "已删除的面板账号（UID 998）:kixdns 0750" "已删除的账号应写成「已删除的面板账号（UID n）」"

# 回归（M-B，R2）：回滚以前先重启旧面板，再放回属主和权限（restore_owners）；面板账号在这中间把自己的目录换成指向 root 目录的
# 符号链接，chmod 就顺着改了那个目录（容器里 /etc/systemd/system 变成 0777）。现在回滚先停面板、停光它账号的进程，面板能写的路径
# 上的事全做完（放回文件、属主、删这次建的目录和账号），最后才重启旧面板。
# Regression (M-B, R2): rollback used to restart the old panel first and put owners and modes back afterwards
# (restore_owners); in between the panel account swapped its own directory for a symlink to a root directory, and chmod
# followed it (/etc/systemd/system became 0777 in a container). Now rollback stops the panel and every process of its
# account first, finishes everything on panel-writable paths (files, owners, removing this run's directories and
# accounts), and restarts the old panel last.
rollback_body="$(declare -f rollback_install)"
rollback_line() { grep -n -- "$1" <<< "${rollback_body}" | head -n 1 | cut -d: -f1 || true; }
previous_line="$(rollback_line 'systemctl stop kixdns-panel.service')"
for rollback_step in stop_panel_processes restore_panel_database restore_owners sweep_new_panel_files remove_new_directories \
  remove_new_accounts 'systemctl restart kixdns-panel.service'; do
  step_line="$(rollback_line "${rollback_step}")"
  [[ -n ${previous_line} && -n ${step_line} && ${previous_line} -lt ${step_line} ]] || {
    printf '断言失败：回滚里 %s 的位置不对（前一步在 %s，它在 %s）\n' "${rollback_step}" "${previous_line}" "${step_line}" >&2
    exit 1
  }
  previous_line=${step_line}
done

# 回归（S-C，R2）：换 PID 的、不可转储的面板账号进程躲得过 /proc 扫描。现在以面板账号的身份 kill -KILL -1（内核一次发给它所有的
# 进程），一直到 /proc 的 status 里没有它活着的进程。
# Regression (S-C, R2): a panel-account process that changes PID, or turns non-dumpable, escaped the /proc scan. Now
# kill -KILL -1 runs as the panel account (the kernel sends it to all its processes at once) until no status in /proc shows
# a live process of it.
quiesce_run() {
  (
    signals="${WORK}/quiesce-signals"
    : > "${signals}"
    # 这里真的走 setpriv（setpriv 本身是假的，只记下来）/ Here setpriv really is used (setpriv itself is fake and only records)
    account_signal() { real_account_signal "$@"; }
    id() { [[ $1 == -u && $2 == kixdns-panel ]] && printf '4242\n'; }
    getent() { [[ $1 == group ]] && printf 'kixdns:x:990:\n'; }
    setpriv() { printf '%s\n' "$*" >> "${signals}"; }
    # 发过 SIGKILL 以后就没有活着的进程了；SURVIVOR=true 时一直有 / No live process is left once SIGKILL went out; with
    # SURVIVOR=true one always is
    account_live_processes() { [[ ${SURVIVOR:-} == true ]] || ! grep -q 'kill -KILL -1' "${signals}"; }
    sleep() { :; }
    abort_install() { printf 'ABORTED %s\n' "$*"; return 1; }
    stop_panel_processes && printf 'STOPPED\n'
    cat "${signals}"
  ) 2>&1 || true
}
output="$(quiesce_run)"
assert_contains "${output}" "--reuid=4242 --regid=990 --clear-groups -- bash -c kill -KILL -1" "应以面板账号的身份 kill -1"
assert_contains "${output}" "STOPPED" "面板账号的进程停光以后应往下走"
output="$(SURVIVOR=true quiesce_run)"
assert_contains "${output}" "ABORTED 面板账号（UID 4242）还有停不掉的进程" "停不掉时应停下、不动面板的目录"
# R3：面板能写的已有目录不用 install -d（它顺着符号链接改目标，还把已有目录改成 0755）：查过不是符号链接再 chown -h、chmod。
# R3: an existing directory the panel can write never gets install -d (which follows a symlink to its target and resets an
# existing directory to 0755): it is checked to be no symlink, then chown -h and chmod.
directories_run() {
  local base="${WORK}/directories"
  rm -rf -- "${base}"
  mkdir -p "${base}/state/bin" "${base}/state/versions" "${base}/state/geo" "${base}/update" "${base}/libexec" "${base}/elsewhere"
  [[ ${GEO_LINK:-} != true ]] || { rmdir -- "${base}/state/geo"; ln -s -- "${base}/elsewhere" "${base}/state/geo"; }
  (
    PANEL_STATE_DIRECTORY="${base}/state"
    PANEL_UPDATE_DIRECTORY="${base}/update"
    LIBEXEC_DIRECTORY="${base}/libexec"
    install() { printf 'install %s\n' "$*"; }
    chown() { printf 'chown %s\n' "$*"; }
    chmod() { printf 'chmod %s\n' "$*"; }
    abort_install() { printf 'ABORTED %s\n' "$*"; exit 1; }
    create_panel_directories
  ) 2>&1 || true
}
output="$(directories_run)"
assert_not_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${WORK}/directories/state" "已有的状态目录不能用 install -d"
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${WORK}/directories/state/geo" "已有的目录查过以后 chown -h"
assert_contains "${output}" "chmod 0750 -- ${WORK}/directories/state/geo" "已有的目录查过以后 chmod"
output="$(GEO_LINK=true directories_run)"
assert_contains "${output}" "ABORTED ${WORK}/directories/state/geo 不能是符号链接" "面板换成符号链接的目录应被拒绝"
assert_not_contains "${output}" "chmod 0750 -- ${WORK}/directories/state/geo" "符号链接的目录不能 chmod"

# 回归（NIT）：回滚以后状态目录里不能留下这次刚起来的面板写的东西（容器里留下了数据库迁移时的备份 panel.db.v5-<时间>.bak）。
# Regression (NIT): after a rollback the state directory keeps nothing the panel this run started wrote (a container kept
# the database migration's backup panel.db.v5-<time>.bak).
sweep_run() {
  local base="${WORK}/sweep"
  rm -rf -- "${base}"
  mkdir -p "${base}/state/bin" "${base}/state/querylog" "${base}/etc-kixdns"
  : > "${base}/state/panel.db"
  : > "${base}/state/querylog/old.jsonl.zst"
  printf '{}\n' > "${base}/etc-kixdns/pipeline.json"
  (
    PANEL_STATE_DIRECTORY="${base}/state"
    PANEL_CONFIG_DIRECTORY="${base}/panel-etc"
    PANEL_UPDATE_DIRECTORY="${base}/update"
    PANEL_RUNTIME_DIRECTORY="${base}/run-panel"
    KIXDNS_RUNTIME_DIRECTORY="${base}/run-kixdns"
    KIXDNS_CONFIG_PATH="${base}/etc-kixdns/pipeline.json"
    BACKUP_ROOT="${base}/backup"
    mkdir -p "${BACKUP_ROOT}"
    record_preexisting_paths
    : > "${base}/state/panel.db.v5-1795091192.bak"
    : > "${base}/etc-kixdns/.kixdns-panel-Ab12Cd"
    sweep_new_panel_files
  ) 2>&1 || true
  find "${base}/state" "${base}/etc-kixdns" -mindepth 1 -maxdepth 1 -printf '%f '
}
output="$(sweep_run)"
assert_not_contains "${output}" "panel.db.v5-1795091192.bak" "回滚应删掉这次的面板写的数据库备份"
assert_not_contains "${output}" ".kixdns-panel-Ab12Cd" "回滚应删掉这次的面板写到一半的临时文件"
assert_contains "${output}" "panel.db" "回滚不能删掉本来就有的数据库"

# R2：建了面板账号以后再停一次它的进程：新账号可能拿到旧账号空出来的 UID。/ R2: the panel account's processes are stopped
# once more after it is created: a new account may get a UID an old one freed.
main_body="$(declare -f main)"
accounts_line="$(grep -n 'create_accounts' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
directories_line="$(grep -n 'create_panel_directories' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
second_stop="$(sed -n "${accounts_line},${directories_line}p" <<< "${main_body}" | grep -c 'stop_panel_processes' || true)"
assert_equals "${second_stop}" "1" "建了面板账号以后、建目录之前应再停一次它的进程"
# R4：安装器一开头就查 panel.env 能不能信，在读它定任何路径、挪任何记录之前。
# R4: the installer checks whether panel.env can be trusted first thing, before reading it for any path or moving any
# record.
trust_line="$(grep -n 'check_panel_env_trust' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
records_line="$(grep -n 'secure_root_records' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
settings_line="$(grep -n 'load_existing_panel_settings' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${trust_line} && -n ${records_line} && -n ${settings_line} && ${trust_line} -lt ${records_line} &&
  ${trust_line} -lt ${settings_line} ]] || {
  printf '断言失败：安装器要先查 panel.env 能不能信，再挪记录、读设置（trust=%s records=%s settings=%s）\n' \
    "${trust_line}" "${records_line}" "${settings_line}" >&2
  exit 1
}
# R2：要停的 UID 里有面板能写的路径的属主里已经没有账号的那些（旧面板账号删掉以后它的进程可能还在）。
# R2: the UIDs to stop include owners of panel-writable paths that no longer have an account (the processes of a deleted
# old panel account may live on).
freed_uids="$(
  id() { return 1; }
  stat() { [[ $2 == %u ]] && printf '4711\n'; }
  getent() { return 2; }
  panel_process_uids "${WORK}"
)"
assert_equals "${freed_uids}" "4711" "面板能写的路径归一个已经没有账号的 UID 时，它的进程也要停"
# R2：还有没有进程看 /proc 里每个进程 status 的 Uid 行（真实、有效、保存的 UID）：跑测试的用户这时就有进程，一个没人用的 UID 没有。
# R2: whether processes are left is read from the Uid line (real, effective, saved UID) of every process's status in
# /proc: the user running the tests has processes right now, an unused UID has none.
real_account_live_processes "$(id -u)" ||
  { printf '断言失败：跑测试的用户还有进程时应看得出来\n' >&2; exit 1; }
! real_account_live_processes 2147480000 ||
  { printf '断言失败：没有进程的 UID 不能算还有进程\n' >&2; exit 1; }
# R2（第四轮的 NIT）：一个线程一个线程地看。在一份假的 /proc 里：主线程退出成了僵尸、别的线程还在跑的进程算活着；只剩僵尸的不算；
# 读到一半不见了的任务跳过；还在却读不到的，当作还活着。
# R2 (the fourth review's NIT): thread by thread. In a fake /proc: a process whose main thread exited into a zombie while
# another thread runs is live; one left as zombies only is not; a task gone part way is skipped; one still there that cannot
# be read counts as live.
fake_proc_task() {
  local base=$1 pid=$2 tid=$3 state=$4 uid=$5
  mkdir -p "${base}/${pid}/task/${tid}"
  printf 'Name:\tx\nUmask:\t0022\nState:\t%s (x)\nTgid:\t%s\nPid:\t%s\nUid:\t%s\t%s\t%s\t%s\nGid:\t1\t1\t1\t1\n' \
    "${state}" "${pid}" "${tid}" "${uid}" "${uid}" "${uid}" "${uid}" > "${base}/${pid}/task/${tid}/status"
}
live_in_fake_proc() {
  (
    PROC_ROOT=$1
    real_account_live_processes 4711 && printf 'LIVE\n' || printf 'NONE\n'
  )
}
fake_proc="${WORK}/fake-proc"
rm -rf -- "${fake_proc}"
fake_proc_task "${fake_proc}" 100 100 Z 4711
fake_proc_task "${fake_proc}" 100 101 S 4711
fake_proc_task "${fake_proc}" 200 200 S 1000
assert_equals "$(live_in_fake_proc "${fake_proc}")" "LIVE" "主线程是僵尸、别的线程还在跑的进程也算活着"
rm -rf -- "${fake_proc}/100/task/101"
assert_equals "$(live_in_fake_proc "${fake_proc}")" "NONE" "只剩僵尸的进程不算活着"
mkdir -p "${fake_proc}/300/task/300"
assert_equals "$(live_in_fake_proc "${fake_proc}")" "NONE" "读到一半不见了的任务应跳过"
fake_proc_task "${fake_proc}" 400 400 S 4711
chmod 0000 "${fake_proc}/400/task/400/status"
if [[ -r ${fake_proc}/400/task/400/status ]]; then
  # root 跑测试时 chmod 拦不住读，就让它变成目录 / Under root chmod does not stop the read; make it a directory instead
  rm -f -- "${fake_proc}/400/task/400/status"
  mkdir -p "${fake_proc}/400/task/400/status"
fi
assert_equals "$(live_in_fake_proc "${fake_proc}")" "LIVE" "还在却读不到的任务应当作还活着"
chmod 0644 "${fake_proc}/400/task/400/status" 2>/dev/null || true
rm -rf -- "${fake_proc}"
# R2：开头为了挪旧版的记录停了面板，没真的开始安装就退出时照原样重启它；没开头停过的照常看 systemd。
# R2: when the panel was stopped at the start to move older records and the run ends before the install really starts, it
# is restarted as it was; otherwise systemd is asked as usual.
early_restart="$(
  (
    stopped="${WORK}/early-stopped"
    rm -f -- "${stopped}"
    # 停了以后 systemd 说它不在运行 / Once stopped, systemd says it is not running
    systemctl() {
      printf 'systemctl %s\n' "$*"
      case $1 in
        stop) : > "${stopped}" ;;
        is-active) [[ ! -e ${stopped} ]] ;;
      esac
    }
    # 记下怎么停下（参数由 quiesce_for_records 传）/ Records how it stops (quiesce_for_records passes the argument)
    # shellcheck disable=SC2120
    stop_panel_processes() { printf 'STOP-PROCESSES %s\n' "$*"; }
    quiesce_for_records
    panel_was_running && printf 'WAS-RUNNING\n'
    # SHOULD 3：之后的退出都经过 on_installer_exit（它还管回滚挂上了却没开始、删准备回滚的备份目录）/ SHOULD 3: every exit
    # after this goes through on_installer_exit (which also sees to an armed rollback that never started and the backup
    # directory made for it)
    trap -p EXIT
  )
)" || true
assert_contains "${early_restart}" "trap -- 'on_installer_exit' EXIT" "开头停面板以后的退出应经过 on_installer_exit"
assert_contains "${early_restart}" "systemctl stop kixdns-panel.service" "挪旧版的记录之前应停面板"
# 停不掉进程时照记录停下、面板不重启（S1；第四轮以前是 fail）/ Processes that cannot be stopped stop the run over the
# record with the panel kept stopped (S1; fail before the fourth review)
assert_contains "$(sed -n '/systemctl stop kixdns-panel.service/,$p' <<< "${early_restart}")" "STOP-PROCESSES refuse_with_panel_held" \
  "挪旧版的记录之前、停了面板以后，应停光面板账号的进程"
# 结构 3：先停 helper 再停面板，结束时 helper 也照原样重启 / Structural change 3: the helper stops before the panel, and is
# restarted as it was at the end
# 只停 helper 本身：面板的 unit Requires= helper，照常停 helper 会先停面板 / The helper alone: the panel's unit Requires= the
# helper, so a plain stop of the helper stops the panel first
helper_stop_line="$(grep -n '^systemctl stop --job-mode=ignore-dependencies kixdns-panel-helper.service' <<< "${early_restart}" | head -n 1 | cut -d: -f1 || true)"
panel_stop_line="$(grep -n '^systemctl stop kixdns-panel.service' <<< "${early_restart}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${helper_stop_line} && -n ${panel_stop_line} && ${helper_stop_line} -lt ${panel_stop_line} ]] || {
  printf '断言失败：面板停下之前应先停 helper（helper=%s panel=%s）\n' "${helper_stop_line}" "${panel_stop_line}" >&2
  exit 1
}
assert_contains "${early_restart}" "systemctl start kixdns-panel-helper.service" "没真的开始安装就退出时应重启开头停下的 helper"
assert_contains "${early_restart}" "systemctl start kixdns-panel.service" "没真的开始安装就退出时应重启开头停下的面板"
assert_contains "${early_restart}" "WAS-RUNNING" "开头停过面板时，看的是停之前它在不在运行"
# S1：照记录停下时（KEEP_PANEL_STOPPED）面板和 helper 都不重启 / S1: after a stop over a record (KEEP_PANEL_STOPPED) neither
# the panel nor the helper restarts
kept_stopped="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; [[ $1 == is-active ]]; }
    stop_panel_processes() { :; }
    quiesce_for_records
    refuse_with_panel_held "记录不对"
  ) 2>&1
)" || true
assert_contains "${kept_stopped}" "面板和它账号的进程这时都停着" "照记录停下时应说明面板停着"
assert_equals "$(grep -c '^systemctl start' <<< "${kept_stopped}" || true)" "0" "照记录停下时面板和 helper 都不能重启"
# 结构 3：安装器一开头拿锁（在读 panel.env、挪记录之前）；面板停下之前先停 helper；回滚里 helper 和旧面板都在放回属主以后才重启；
# panel.env 也只在停光面板的进程以后放回（第四轮的 NIT）。
# Structural change 3: the installer takes the lock first thing (before panel.env is read or records moved); the helper
# stops before the panel; in a rollback the helper and the old panel restart only after the owners are back; panel.env is
# put back only once the panel's processes are gone too (the fourth review's NIT).
lock_line="$(grep -n 'take_root_lock' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
trust_line="$(grep -n 'check_panel_env_trust' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${lock_line} && -n ${trust_line} && ${lock_line} -lt ${trust_line} ]] ||
  { printf '断言失败：安装器要一开头就拿锁（lock=%s trust=%s）\n' "${lock_line}" "${trust_line}" >&2; exit 1; }
helper_line="$(grep -n 'stop_panel_helper' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
panel_line="$(grep -n 'systemctl stop kixdns-panel.service' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${helper_line} && -n ${panel_line} && ${helper_line} -lt ${panel_line} ]] ||
  { printf '断言失败：安装时面板停下之前应先停 helper（helper=%s panel=%s）\n' "${helper_line}" "${panel_line}" >&2; exit 1; }
rollback_body="$(declare -f rollback_install)"
owners_line="$(grep -n 'restore_owners' <<< "${rollback_body}" | head -n 1 | cut -d: -f1 || true)"
helper_restart_line="$(grep -n 'restart kixdns-panel-helper.service' <<< "${rollback_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${owners_line} && -n ${helper_restart_line} && ${owners_line} -lt ${helper_restart_line} ]] ||
  { printf '断言失败：回滚时 helper 要在放回属主以后才重启（owners=%s helper=%s）\n' "${owners_line}" "${helper_restart_line}" >&2; exit 1; }
# shellcheck disable=SC2016 # 找的就是函数正文里没展开的写法 / What is looked for is the unexpanded text of the function
guarded="$(sed -n '/if \[\[ ${quiesced} == true \]\]; then/,/^    fi$/p' <<< "${rollback_body}" | head -n 20)"
# shellcheck disable=SC2016 # 同上 / As above
assert_contains "${guarded}" 'restore_path "${PANEL_ENV}" panel-env' "回滚放回 panel.env 也要在停光面板的进程以后"
# shellcheck disable=SC2016 # 同上 / As above
[[ $(grep -c 'restore_path "${PANEL_ENV}" panel-env' <<< "${rollback_body}") == 1 ]] ||
  { printf '断言失败：回滚只在停光面板的进程以后放回 panel.env\n' >&2; exit 1; }
# 结构 3：同一时间只跑一个。锁在别人手里时停下并说明；在线更新器拿着锁再调安装器时，安装器认出传下来的那一把，接着用。
# Structural change 3: one at a time. With the lock held elsewhere the run stops and says so; when the online updater holds
# it and runs the installer, the installer recognises the one handed down and carries on with it.
# 锁在只有 root 能进的目录里（SHOULD 2）；这里由跑测试的用户代替 root / The lock lives in a root-only directory (SHOULD 2);
# the user running the tests stands in for root here
ROOT_UID="$(id -u)"
lock_directory="${WORK}/lock-directory"
lock_file="${lock_directory}/lock"
rm -rf -- "${lock_directory}"
mkdir -m 0700 "${lock_directory}"
exec 7>> "${lock_file}"
flock -n 7
lock_output="$(
  ROOT_LOCK=${lock_file}
  unset KIXDNS_PANEL_ROOT_LOCK_FD
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  take_root_lock
  printf 'LOCKED\n'
)" || true
assert_contains "${lock_output}" "FAILED 另一个安装、卸载或在线更新正在运行" "锁在别人手里时应停下并说明"
assert_not_contains "${lock_output}" "LOCKED" "锁在别人手里时不能接着做"
# SHOULD 2：说清拿着锁的是谁（PID 和程序，从 /proc/locks 按 inode 找）/ SHOULD 2: say who holds it (the PID and program, found in
# /proc/locks by inode)
[[ ${lock_output} =~ 拿着锁的是\ PID\ [1-9][0-9]* ]] ||
  { printf '断言失败：锁在别人手里时应说出拿着它的进程（%s）\n' "${lock_output}" >&2; exit 1; }
# 照锁文件的设备号（十六进制的主:次）和 inode 在 /proc/locks 里找，别的锁和排队等着的不算 / Looked up in /proc/locks by the lock
# file's device (major:minor in hex) and inode; other locks and waiters do not count
holder_output="$(
  fake_proc="${WORK}/fake-proc"
  rm -rf -- "${fake_proc}"
  mkdir -p "${fake_proc}/4242"
  lock_id="$(printf '%02x:%02x:%s' "$(stat -c '%Hd' -- "${lock_file}")" "$(stat -c '%Ld' -- "${lock_file}")" \
    "$(stat -c '%i' -- "${lock_file}")")"
  printf '1: FLOCK  ADVISORY  WRITE 1111 00:00:1 0 EOF\n2: FLOCK  ADVISORY  WRITE 4242 %s 0 EOF\n2: -> FLOCK  ADVISORY  WRITE 3333 %s 0 EOF\n' \
    "${lock_id}" "${lock_id}" > "${fake_proc}/locks"
  printf 'kixdns-panel-se\n' > "${fake_proc}/4242/comm"
  printf '0::/system.slice/kixdns-panel.service\n' > "${fake_proc}/4242/cgroup"
  ROOT_LOCK=${lock_file}
  PROC_ROOT=${fake_proc}
  root_lock_holder
)"
assert_equals "${holder_output}" "：拿着锁的是 PID 4242，程序 kixdns-panel-se，unit kixdns-panel.service" \
  "应照锁文件的设备号和 inode 找出拿着锁的进程"
for script_name in install uninstall panel-online-update; do
  grep -qE '^ROOT_LOCK="?/run/kixdns-panel-root/lock"?$' "${PACKAGE_ROOT}/scripts/${script_name}.sh" ||
    { printf '断言失败：%s.sh 的锁应放在只有 root 能进的 /run/kixdns-panel-root/ 里\n' "${script_name}" >&2; exit 1; }
done
# 放锁的目录不是只有 root 能进（别人能进、是符号链接）就不用它 / A lock directory others can enter, or a symlink, is not used
for lock_case in mode symlink; do
  lock_output="$(
    base="${WORK}/lock-case"
    rm -rf -- "${base}"
    mkdir -p "${base}/real"
    case ${lock_case} in
      mode) mv -- "${base}/real" "${base}/locks"; chmod 0755 "${base}/locks" ;;
      symlink) chmod 0700 "${base}/real"; ln -s real "${base}/locks" ;;
    esac
    ROOT_LOCK="${base}/locks/lock"
    unset KIXDNS_PANEL_ROOT_LOCK_FD
    fail() { printf 'FAILED %s\n' "$*"; exit 1; }
    take_root_lock
    printf 'LOCKED\n'
  )" || true
  assert_contains "${lock_output}" "不是只有 root 能进的目录，锁不能放在那里" "放锁的目录不对时不能用（${lock_case}）"
  assert_not_contains "${lock_output}" "LOCKED" "放锁的目录不对时不能拿锁（${lock_case}）"
done
# 还没有放锁的目录时建成只有 root 能进的 / A missing lock directory is created root-only
lock_output="$(
  base="${WORK}/lock-new"
  rm -rf -- "${base}"
  mkdir -p "${base}"
  ROOT_LOCK="${base}/locks/lock"
  unset KIXDNS_PANEL_ROOT_LOCK_FD
  install() {
    local mode=""
    local argument
    for argument in "$@"; do [[ ${argument} != [0-7][0-7][0-7][0-7] ]] || mode=${argument}; done
    mkdir -p "${@: -1}"
    [[ -z ${mode} ]] || chmod "${mode}" "${@: -1}"
  }
  take_root_lock
  stat -c '%a' "${base}/locks"
)" || true
assert_equals "${lock_output}" "700" "放锁的目录应建成只有 root 能进的"
lock_output="$(
  ROOT_LOCK=${lock_file}
  KIXDNS_PANEL_ROOT_LOCK_FD=7
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  take_root_lock
  printf 'LOCKED\n'
)" || true
assert_contains "${lock_output}" "LOCKED" "在线更新器传下来的锁应接着用"
exec 7>&-
lock_output="$(
  ROOT_LOCK=${lock_file}
  KIXDNS_PANEL_ROOT_LOCK_FD=7
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  take_root_lock
  printf 'LOCKED FD=%s\n' "${KIXDNS_PANEL_ROOT_LOCK_FD}"
  flock -n 7 2>/dev/null && printf 'STALE-FD-USED\n'
)" || true
assert_contains "${lock_output}" "LOCKED" "没人拿着锁时应拿到"
assert_not_contains "${lock_output}" "STALE-FD-USED" "环境里写着、却不是这把锁的文件描述符不能当成锁"
# 环境里写着的文件描述符开着别的文件：不能拿它的锁顶替（锁在别人手里时照样停下）/ The descriptor named in the environment
# holds some other file: its lock does not stand in (with the lock held elsewhere the run still stops)
exec 5>> "${lock_file}"
flock -n 5
exec 7>> "${WORK}/not-the-lock"
lock_output="$(
  ROOT_LOCK=${lock_file}
  KIXDNS_PANEL_ROOT_LOCK_FD=7
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  take_root_lock
  printf 'LOCKED\n'
)" || true
exec 7>&- 5>&-
assert_not_contains "${lock_output}" "LOCKED" "环境里写着的文件描述符不是这把锁时不能当成拿到了锁"


# ---------------------------------------------------------------------------
# 第五轮审查（rv6）/ Fifth review (rv6)
# ---------------------------------------------------------------------------

# 回归（MUST 1）：不能信的 panel.env 里一行 KIXDNS_INSTALLED_SOURCE=fork\nKIXDNS_CONFIG=…（反斜杠 n 是两个字符），仅更新面板时交给
# awk -v 写回，awk 把它解开成换行，重写出来的、已经归 root 的 panel.env 里就多了一行排在前面的 KIXDNS_CONFIG；下一次运行照它把
# systemd 的 drop-in 目录交给了面板（容器里两个系统都是 uid=0）。现在不能信的 panel.env 一项也不带过来：照安装包的示例重写，原来那份
# 挪进 quarantine；写进去的每一项照格式验过，值经 ENVIRON 交给 awk。
# Regression (MUST 1): one line of an untrusted panel.env, KIXDNS_INSTALLED_SOURCE=fork\nKIXDNS_CONFIG=… (backslash n as two
# characters), went back through awk -v on a panel-only update; awk decoded it into a new line, so the rewritten panel.env,
# now root's, held an extra KIXDNS_CONFIG ahead of the real one, and the next run handed a systemd drop-in directory to the
# panel (uid=0 in a container on both systems). Now nothing is carried over from an untrusted panel.env: it is rewritten
# from the package's example and the old one goes to quarantine; every value written passes its format and reaches awk
# through ENVIRON.
escape_run() {
  local base="${WORK}/escape"
  rm -rf -- "${base}"
  mkdir -p "${base}/package/deploy" "${base}/package/bin" "${base}/panel-etc" "${base}/state/bin" "${base}/records"
  chmod 0700 "${base}/records"
  cp "${PACKAGE_ROOT}/deploy/panel.env.example" "${base}/package/deploy/"
  printf 'kernel\n' > "${base}/state/bin/kixdns"
  file_sha256 "${base}/state/bin/kixdns" > "${base}/package/KIXDNS_BINARY_SHA256"
  printf '%s\n' 'KIXDNS_INSTALLED_SOURCE=fork\nKIXDNS_CONFIG=/etc/systemd/system/kixdns.service.d/pipeline.json' \
    "KIXDNS_CONFIG=${base}/etc-kixdns/pipeline.json" 'KIXDNS_INSTALLED_COMMIT=4444444444444444444444444444444444444444' \
    'KIXDNS_INSTALLED_SOURCE_ID=77' 'KIXDNS_EXTRA_FROM_THE_PANEL=yes' 'KIXDNS_PANEL_BIND=0.0.0.0:1' > "${base}/panel-etc/panel.env"
  (
    PACKAGE_ROOT="${base}/package"
    PANEL_CONFIG_DIRECTORY="${base}/panel-etc"
    PANEL_ENV="${base}/panel-etc/panel.env"
    PANEL_STATE_DIRECTORY="${base}/state"
    MANAGED_KIXDNS_BINARY="${base}/state/bin/kixdns"
    KIXDNS_CONFIG_PATH="${base}/etc-kixdns/pipeline.json"
    ROOT_RECORDS="${base}/records"
    ROOT_CHAIN_TOP=${base}
    ROOT_UID="$(id -u)"
    PANEL_ENV_TRUSTED=${1:-false}
    PANEL_ENV_VERIFIED=true
    PANEL_BUILD_COMMIT=5555555555555555555555555555555555555555
    PANEL_RELEASE=""
    KIXDNS_BUILD_COMMIT=6666666666666666666666666666666666666666
    KIXDNS_SOURCE_ID=88
    KIXDNS_SOURCE=fork
    KIXDNS_GROUP=$(id -gn)
    chown() { :; }
    install() { mkdir -p "${@: -1}"; chmod 0700 "${@: -1}"; }
    installed_kixdns_labels
    printf 'LABELS=%s %s %s\n' "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
    update_panel_environment "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
  ) 2>&1
  printf 'CONFIG-LINES=%s\n' "$(grep -c '^KIXDNS_CONFIG=' "${base}/panel-etc/panel.env")"
  printf 'FIRST-CONFIG=%s\n' "$(grep -m1 '^KIXDNS_CONFIG=' "${base}/panel-etc/panel.env")"
  grep -q 'kixdns.service.d' "${base}/panel-etc/panel.env" && printf 'INJECTED\n'
  grep -q '^KIXDNS_EXTRA_FROM_THE_PANEL=' "${base}/panel-etc/panel.env" && printf 'CARRIED-OVER\n'
  grep -m1 '^KIXDNS_PANEL_BIND=' "${base}/panel-etc/panel.env"
  [[ -n "$(find "${base}/records/quarantine" -name 'panel.env.*' -print -quit 2>/dev/null)" ]] && printf 'OLD-QUARANTINED\n'
  return 0
}
output="$(escape_run false)"
assert_contains "${output}" "CONFIG-LINES=1" "重写的 panel.env 里只能有一行 KIXDNS_CONFIG"
assert_contains "${output}" "FIRST-CONFIG=KIXDNS_CONFIG=${WORK}/escape/etc-kixdns/pipeline.json" "KIXDNS_CONFIG 只能是验过的那一个"
assert_not_contains "${output}" "INJECTED" "不能信的 panel.env 里的值不能带进重写的那份"
assert_not_contains "${output}" "CARRIED-OVER" "不能信的 panel.env 里认不得的行不能带过来"
assert_contains "${output}" "KIXDNS_PANEL_BIND=0.0.0.0:5738" "不能信的 panel.env 照安装包的示例重写"
assert_contains "${output}" "OLD-QUARANTINED" "不能信的 panel.env 应挪进 quarantine 留给管理员看"
assert_contains "${output}" "面板能改，这次照安装包的示例重写，里面原来的设置一项也没用" "重写不能信的 panel.env 时应说明"
# 内核的来源、提交、编号照 root 的事实定：面板目录里的内核和这个包的一字不差，就是包里的；不然写成空
# The kernel's source, commit and id from root's facts: a kernel identical to this package's is the package's; otherwise
# empty
assert_contains "${output}" "LABELS=6666666666666666666666666666666666666666 88 fork" "内核和包里的一样时照包里的记"
# 能信的 panel.env：它记的照旧写回，只要每一项都照格式验过 / A trusted panel.env: what it records is written back, provided
# each value passes its format
output="$(escape_run true)"
assert_contains "${output}" "LABELS=6666666666666666666666666666666666666666 88 fork" "能信的 panel.env 里有不合格式的值时照 root 的事实定"
labels_output="$(
  PANEL_ENV="${WORK}/labels.env"
  printf '%s\n' 'KIXDNS_INSTALLED_COMMIT=4444444444444444444444444444444444444444' 'KIXDNS_INSTALLED_SOURCE_ID=77' \
    'KIXDNS_INSTALLED_SOURCE=fork' > "${PANEL_ENV}"
  PANEL_ENV_TRUSTED=true
  installed_kixdns_labels
  printf '%s %s %s\n' "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
  PANEL_ENV_TRUSTED=false
  MANAGED_KIXDNS_BINARY="${WORK}/no-such-kernel"
  installed_kixdns_labels
  printf '[%s %s %s]\n' "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
)"
assert_contains "${labels_output}" "4444444444444444444444444444444444444444 77 fork" "能信的 panel.env 里合格式的内核记录照旧写回"
assert_contains "${labels_output}" "[  ]" "不能信、内核也对不上时写成空"
labels_output="$(
  base="${WORK}/labels-kernel"
  rm -rf -- "${base}"
  mkdir -p "${base}/package"
  printf 'other kernel\n' > "${base}/kixdns"
  printf '%064d\n' 0 > "${base}/package/KIXDNS_BINARY_SHA256"
  PACKAGE_ROOT="${base}/package"
  MANAGED_KIXDNS_BINARY="${base}/kixdns"
  PANEL_ENV_TRUSTED=false
  KIXDNS_BUILD_COMMIT=6666666666666666666666666666666666666666
  KIXDNS_SOURCE_ID=88
  KIXDNS_SOURCE=fork
  installed_kixdns_labels
  printf '[%s %s %s]\n' "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
)"
assert_equals "${labels_output}" "[  ]" "面板目录里的内核和包里的不一样时不能照包里的记"
# 每一项照格式验：不对就停下，不写 / Every value passes its format, or the run stops without writing
for bad_value in 'KIXDNS_INSTALLED_COMMIT=x\nKIXDNS_CONFIG=/x' 'KIXDNS_INSTALLED_SOURCE_ID=1\n2' 'KIXDNS_INSTALLED_SOURCE=release' \
  'KIXDNS_PANEL_INSTALLED_RELEASE=v1\n' 'KIXDNS_CONFIG=/etc/a\b.json' 'KIXDNS_SERVICE_UNIT=x.service\n' \
  'KIXDNS_PANEL_BIND=0.0.0.0:1'; do
  panel_env_value_valid "${bad_value%%=*}" "${bad_value#*=}" &&
    { printf '断言失败：%s 不能算合格式\n' "${bad_value}" >&2; exit 1; }
done
for good_value in 'KIXDNS_INSTALLED_COMMIT=' 'KIXDNS_INSTALLED_COMMIT=aBcDeF0123456789aBcDeF0123456789aBcDeF01' \
  'KIXDNS_INSTALLED_SOURCE_ID=42' 'KIXDNS_INSTALLED_SOURCE=fork' 'KIXDNS_CONFIG=/etc/kixdns/pipeline.json' \
  'KIXDNS_SERVICE_UNIT=kixdns.service'; do
  panel_env_value_valid "${good_value%%=*}" "${good_value#*=}" ||
    { printf '断言失败：%s 应算合格式\n' "${good_value}" >&2; exit 1; }
done
render_output="$(
  KIXDNS_CONFIG_PATH=/etc/kixdns/pipeline.json
  fail() { printf 'FAILED %s\n' "$*"; exit 1; }
  render_panel_environment /dev/null "${WORK}/bad-render.env" 'x\nKIXDNS_CONFIG=/evil' "" "" "" ""
  printf 'RENDERED\n'
)" || true
assert_contains "${render_output}" "FAILED 要写进 panel.env 的 KIXDNS_INSTALLED_COMMIT 格式不对" "要写的值不合格式时应停下"
assert_not_contains "${render_output}" "RENDERED" "要写的值不合格式时不能写"
# 路径里的反斜杠和控制字符：awk -v 和 systemd 都会解开反斜杠；systemd 还把引号当引号、% 当说明符、$ 当变量（unit 的 Exec 行、
# ReadWritePaths、panel.env 都是它读），写进去的路径就和安装器建的不是同一个
# Backslashes and control characters in paths: awk -v and systemd both decode backslashes; systemd also takes quotes as
# quotes, % as a specifier and $ as a variable (it reads the unit's Exec lines, ReadWritePaths and panel.env), so the path
# written would not be the one the installer made
# shellcheck disable=SC2016 # 要的就是没展开的 $ / The unexpanded $ is the point
for bad_path in '/etc/kixdns/a\nb.json' "/etc/kixdns/a"$'\t'"b.json" "/etc/kixdns/a"$'\x01'"b.json" '/etc/kixdns/%h.json' \
  '/etc/kixdns/$HOME.json' '/etc/kixdns/${HOME}.json' '/etc/kixdns/a"b.json' "/etc/kixdns/a'b.json"; do
  output="$(path_verdict "${bad_path}")"
  assert_contains "${output}" "（systemd 会解开它们）" "${bad_path} 应被拒绝"
  assert_not_contains "${output}" "accepted" "${bad_path} 不能被接受"
done
# 四个脚本里不再有 awk -v，也不把读来的值插进 sed 的脚本（只看代码行，注释不算）
# No awk -v left in the four scripts, and no value read in is put into a sed script (code lines only, not comments)
for script_name in install uninstall panel-online-update one-click-install; do
  code="$(grep -v '^[[:space:]]*#' "${PACKAGE_ROOT}/scripts/${script_name}.sh")"
  [[ $(grep -cE "awk[^']*[[:space:]]-v[[:space:]]" <<< "${code}" || true) == 0 ]] ||
    { printf '断言失败：%s.sh 里还有 awk -v\n' "${script_name}" >&2; exit 1; }
  [[ $(grep -cE 'sed [^|]*"[^"]*\$\{' <<< "${code}" || true) == 0 ]] ||
    { printf '断言失败：%s.sh 里还有插进 sed 脚本的变量\n' "${script_name}" >&2; exit 1; }
done
# 新建 panel.env 也照示例渲染，不再用 sed 填值 / A new panel.env is rendered from the example too, sed no longer fills values
assert_not_contains "$(declare -f install_configuration)" "sed -e" "新建 panel.env 不能再用 sed 填值"

# 回归（SHOULD 3）：arm_rollback 先记下回滚的 shell、后挂 INT/TERM/HUP，信号落在中间时既不回滚，EXIT 也以为回滚会管，开头为记录
# 停下的 helper 和面板就一直停着（debian 13 上 47 次里有 2 次）；bash 5.2 在解析多行命令替换时收到信号，INT/TERM 的陷阱会解析失败
# （「trap: line 2: unexpected EOF」），同样没回滚。现在先挂陷阱再记下回滚的 shell；EXIT 的 on_installer_exit 只在回滚真的开始以后
# 才不插手：回滚挂上了却没开始就在这里回滚；还没挂上就删掉备份目录、照原样重启。
# Regression (SHOULD 3): arm_rollback recorded the rollback shell before trapping INT/TERM/HUP, so a signal in between got
# no rollback while EXIT took it that the rollback would see to things, and the helper and panel stopped at the start for
# the records stayed stopped (2 of 47 on debian 13); bash 5.2 receiving a signal while parsing a multi-line command
# substitution fails to parse the INT/TERM trap ("trap: line 2: unexpected EOF"), with no rollback either. Now the traps
# come before the rollback shell is recorded, and EXIT's on_installer_exit keeps out only once the rollback has really
# started: armed but not started, it rolls back there; not armed yet, it removes the backup directory and restarts what
# was stopped.
arm_body="$(declare -f arm_rollback)"
trap_line="$(grep -n 'INT TERM HUP' <<< "${arm_body}" | head -n 1 | cut -d: -f1 || true)"
shell_line="$(grep -n 'ROLLBACK_SHELL=' <<< "${arm_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${trap_line} && -n ${shell_line} && ${trap_line} -lt ${shell_line} ]] ||
  { printf '断言失败：要先挂陷阱再记下回滚的 shell（trap=%s shell=%s）\n' "${trap_line}" "${shell_line}" >&2; exit 1; }
assert_contains "$(declare -f rollback_install | head -n 12)" "ROLLBACK_STARTED=true" "回滚一开始就要记下它开始了"
exit_line="$(grep -n 'trap on_installer_exit EXIT' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
records_line="$(grep -n 'secure_root_records' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${exit_line} && -n ${records_line} && ${exit_line} -lt ${records_line} ]] ||
  { printf '断言失败：一开头就要挂 EXIT（exit=%s records=%s）\n' "${exit_line}" "${records_line}" >&2; exit 1; }
early_backup="$(mktemp -d /var/tmp/kixdns-panel-install.XXXXXX)"
exit_output="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; }
    rollback_install() { printf 'ROLLBACK %s\n' "$*"; }
    PANEL_STOPPED_EARLY=true
    PANEL_WAS_ACTIVE=true
    HELPER_WAS_ACTIVE=true
    BACKUP_ROOT=${early_backup}
    on_installer_exit
  )
)"
assert_not_contains "${exit_output}" "ROLLBACK" "回滚还没挂上时退出不能回滚"
assert_contains "${exit_output}" "systemctl start kixdns-panel.service" "回滚还没挂上时退出应照原样重启开头停下的面板"
[[ ! -e ${early_backup} ]] || { printf '断言失败：还没开始就退出时应删掉准备回滚的备份目录\n' >&2; exit 1; }
exit_output="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; }
    rollback_install() { printf 'ROLLBACK %s\n' "$*"; }
    PANEL_STOPPED_EARLY=true
    PANEL_WAS_ACTIVE=true
    ROOT_WORK_STARTED=true
    ROLLBACK_SHELL=${BASHPID}
    on_installer_exit
  )
)"
assert_contains "${exit_output}" "ROLLBACK 1 interrupted" "回滚挂上了却没开始就退出时应在退出时回滚"
exit_output="$(
  (
    systemctl() { printf 'systemctl %s\n' "$*"; }
    rollback_install() { printf 'ROLLBACK %s\n' "$*"; }
    PANEL_STOPPED_EARLY=true
    PANEL_WAS_ACTIVE=true
    ROOT_WORK_STARTED=true
    ROLLBACK_SHELL=${BASHPID}
    ROLLBACK_STARTED=true
    on_installer_exit
  )
)"
assert_equals "${exit_output}" "" "回滚开始以后退出时什么也不做"
started_output="$(
  systemctl() { printf 'systemctl %s\n' "$*"; }
  PANEL_STOPPED_EARLY=true
  PANEL_WAS_ACTIVE=true
  ROLLBACK_STARTED=true
  restart_panel_after_early_stop
  panel_held_for_records && printf 'HELD\n'
  true
)"
assert_equals "${started_output}" "" "回滚开始以后由回滚重启，也不再算为记录停着"

# 回归（NIT 4）：quarantine_record 在命令替换里调用，它照记录停下（ensure_root_records）时记下的「面板不重启」丢在子 shell 里，父 shell
# 接着把 helper 和面板都重启了，消息却说它们停着。现在它不在命令替换里调用，结果放在 QUARANTINED_TO 里。
# Regression (NIT 4): quarantine_record ran inside a command substitution, so "keep the panel stopped" from its stop over a
# record (ensure_root_records) was lost with the subshell, and the parent restarted the helper and the panel while the
# message said both stay stopped. Now it never runs in a command substitution, and leaves its result in QUARANTINED_TO.
for script_name in install uninstall; do
  # shellcheck disable=SC2016 # 找的就是没展开的写法 / The unexpanded text is what is looked for
  [[ $(grep -c '\$(quarantine_record' "${PACKAGE_ROOT}/scripts/${script_name}.sh" || true) == 0 ]] ||
    { printf '断言失败：%s.sh 里还在命令替换里调用 quarantine_record\n' "${script_name}" >&2; exit 1; }
done
quarantine_output="$(
  umask 022
  base="${WORK}/quarantine-reset"
  rm -rf -- "${base}"
  mkdir -p "${base}/records" "${base}/old/thing"
  chmod 0700 "${base}/records"
  ROOT_RECORDS="${base}/records"
  ROOT_CHAIN_TOP=${base}
  ROOT_UID="$(id -u)"
  ROOT_GID="$(id -g)"
  install() { mkdir -p "${@: -1}"; chmod 0700 "${@: -1}"; }
  same_filesystem() { return 1; }
  QUARANTINED_TO=/stale/place
  quarantine_record "${base}/old/thing" thing
  printf 'TO=[%s]\n' "${QUARANTINED_TO}"
  [[ ! -e ${base}/old/thing ]] || printf 'LEFT\n'
)"
assert_equals "${quarantine_output}" "TO=[]" "删掉而不是挪走时 QUARANTINED_TO 应为空，不留上一次的去处"
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/records"
chmod 0755 "${root}/records"
output="$(FORGED_RECORDS=true config_directory_run)"
assert_contains "${output}" "不是只有 root 能进的目录，不能放安装记录" "挪走不能信的记录时放记录的目录不对应停下"
assert_contains "${output}" "面板和它账号的进程这时都停着" "照记录停下时应说明面板停着"
assert_equals "$(grep -c '^systemctl start' <<< "${output}" || true)" "0" "照记录停下时面板和 helper 都不能重启"

# 回归（NIT 5）：挪进 quarantine 的东西整个交给 root，面板账号删掉以后不留归空 UID 的东西
# Regression (NIT 5): what goes into quarantine is handed to root as a whole, so nothing is left owned by a freed UID once
# the panel account goes
legacy_host_tree 'User=kxu\n'
output="$(FORGED_RECORDS=true config_directory_run)"
assert_contains "${output}" "chown -hR 0:$(id -g) -- ${root}/records/quarantine/external-backup." "挪进 quarantine 的东西应整个交给 root"

# 回归（(b)）：v4.3.4 用 systemctl link 装的原 unit，备份里的 kixdns.service 是符号链接，接手时被当作不能信挪走，以后恢复不了。现在
# 链接本身归 root、指着的文件和它上面每一层都只有 root 能写时，接手时换成指着的文件的内容；不然照旧挪走，并说明管理员能怎么办。
# Regression ((b)): v4.3.4 backed up a unit installed with systemctl link as a symlink, and adoption moved it away as
# untrusted, so it could never be restored. Now, with the link root's and the file it points at and every level above it
# writable by root alone, adoption replaces it with that file's content; otherwise it is moved away as before, saying what
# the admin can do.
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/linked-units"
cp -- "${root}/state/external-backup/kixdns.service" "${root}/linked-units/kixdns.service"
# unit 文件通常是 0644：接手以后照样只有 root 能读写 / Unit files are usually 0644: adopted, it is still root's alone to read
# and write
chmod 0644 "${root}/linked-units/kixdns.service"
rm -f -- "${root}/state/external-backup/kixdns.service"
ln -s -- "${root}/linked-units/kixdns.service" "${root}/state/external-backup/kixdns.service"
output="$(config_directory_run)"
assert_contains "${output}" "的记录已验过，挪到只有 root 能进的 ${root}/records/external-backup。" "指着只有 root 能改的文件的符号链接应照它的内容接手"
[[ -f ${root}/records/external-backup/kixdns.service && ! -L ${root}/records/external-backup/kixdns.service ]] ||
  { printf '断言失败：接手以后记录里应是普通文件\n' >&2; exit 1; }
cmp -s -- "${root}/linked-units/kixdns.service" "${root}/records/external-backup/kixdns.service" ||
  { printf '断言失败：接手以后应是指着的文件的内容\n' >&2; exit 1; }
[[ $(stat -c '%a' -- "${root}/records/external-backup/kixdns.service") == 600 ]] ||
  { printf '断言失败：接手以后的文件应只有 root 能读写\n' >&2; exit 1; }
# 链接本身要归 root，指着的要是只有一个链接的普通文件 / The link itself must be root's, and what it points at a regular file
# with one link
link_verdicts="$(
  umask 022
  base="${WORK}/record-links"
  rm -rf -- "${base}"
  mkdir -p "${base}/units/dir.service" "${base}/record"
  printf 'unit\n' > "${base}/units/one.service"
  printf 'unit\n' > "${base}/units/two.service"
  ln -- "${base}/units/two.service" "${base}/units/two-again.service"
  ln -s -- "${base}/units/one.service" "${base}/record/plain"
  ln -s -- "${base}/units/two.service" "${base}/record/hardlinked"
  ln -s -- "${base}/units/dir.service" "${base}/record/directory"
  ln -s -- "${base}/units/one.service" "${base}/record/foreign"
  ROOT_CHAIN_TOP=${base}
  ROOT_UID="$(id -u)"
  stat() {
    if [[ $1 == -c && $2 == %u && ${4:-} == "${base}/record/foreign" ]]; then
      printf '12345\n'
    else
      command stat "$@"
    fi
  }
  for link in plain hardlinked directory foreign; do
    if trusted_record_link "${base}/record/${link}"; then printf '%s trusted\n' "${link}"; else printf '%s not\n' "${link}"; fi
  done
)"
assert_equals "${link_verdicts}" $'plain trusted\nhardlinked not\ndirectory not\nforeign not' \
  "只有归 root、指着只有一个链接的普通文件的符号链接才能照它指着的算"
legacy_host_tree 'User=kxu\n'
mkdir -p "${root}/linked-units"
chmod 0777 "${root}/linked-units"
cp -- "${root}/state/external-backup/kixdns.service" "${root}/linked-units/kixdns.service"
rm -f -- "${root}/state/external-backup/kixdns.service"
ln -s -- "${root}/linked-units/kixdns.service" "${root}/state/external-backup/kixdns.service"
output="$(config_directory_run)"
assert_contains "${output}" "里面的 kixdns.service 是符号链接，指着的文件或它上面的目录不是只有 root 能改" "指着别人能改的文件的符号链接不能信"
assert_contains "${output}" "确认它就是迁移前的备份的话：把里面的符号链接换成它指着的那个文件" "不能信时应说明管理员能怎么办"
[[ ! -e ${root}/records/external-backup ]] || { printf '断言失败：不能信的符号链接记录不能接手\n' >&2; exit 1; }

# R3：内核包的身份目录已经有时不用 install -d；里面的文件先删掉同名的再写。/ R3: an existing bundle directory gets no
# install -d; its files are removed by name before being written.
output="$(
  base="${WORK}/bundle-target"
  rm -rf -- "${base}"
  mkdir -p "${base}/bundle"
  ln -s -- /nonexistent "${base}/bundle/KIXDNS_BUILD_COMMIT"
  install() { printf 'install %s\n' "$*"; }
  chown() { printf 'chown %s\n' "$*"; }
  chmod() { printf 'chmod %s\n' "$*"; }
  abort_install() { printf 'ABORTED %s\n' "$*"; exit 1; }
  INSTALL_KIND=upgrade
  eval "$(declare -f install_bundled_metadata | sed "s|/var/lib/kixdns-panel/bundle|${base}/bundle|")"
  install_bundled_metadata
  [[ -L ${base}/bundle/KIXDNS_BUILD_COMMIT ]] && printf 'LINK-LEFT\n'
  true
)"
assert_not_contains "${output}" "install -d -o root -g kixdns -m 0750 ${WORK}/bundle-target/bundle" "已有的 bundle 目录不能用 install -d"
assert_contains "${output}" "chown -h root:kixdns -- ${WORK}/bundle-target/bundle" "已有的 bundle 目录查过以后 chown -h"
assert_not_contains "${output}" "LINK-LEFT" "写 bundle 里的文件之前应删掉同名的东西"
# R3：放回属主只放到还是同一种东西上：记下时是目录、现在成了文件（或符号链接）的不动。/ R3: owners go back only onto the same
# kind of thing: what was a directory when recorded and is now a file (or a symlink) is left alone.
output="$(
  base="${WORK}/owners-kind"
  rm -rf -- "${base}"
  mkdir -p "${base}/backup" "${base}/swapped"
  BACKUP_ROOT="${base}/backup"
  record_owner "${base}/swapped"
  rmdir -- "${base}/swapped"
  : > "${base}/swapped"
  chown() { printf 'chown %s\n' "$*"; }
  chmod() { printf 'chmod %s\n' "$*"; }
  restore_owners
)"
assert_not_contains "${output}" "${WORK}/owners-kind/swapped" "记下时是目录、现在不是的不能放回属主和权限"
# R3：回滚放回配置时，已有的配置目录不用 install -d（它会改成 0755）。/ R3: putting the config back on rollback runs no
# install -d on an existing config directory (which would make it 0755).
(
  base="${WORK}/managed-config"
  rm -rf -- "${base}"
  mkdir -p "${base}/backup" "${base}/etc-kixdns"
  chmod 0700 "${base}/etc-kixdns"
  printf '{}\n' > "${base}/backup/kixdns-config"
  BACKUP_ROOT="${base}/backup"
  KIXDNS_CONFIG_PATH="${base}/etc-kixdns/pipeline.json"
  restore_managed_config
)
assert_equals "$(stat -c '%a' "${WORK}/managed-config/etc-kixdns")" "700" "回滚放回配置时不能改已有配置目录的权限"
# R3：面板停了以后再查一遍时，panel.env 也不能是符号链接（安装器要读它、换掉它）。/ R3: on the check once the panel has
# stopped, panel.env may not be a symlink either (the installer reads and replaces it).
targets_tree
mkdir -p "${WORK}/targets/panel-etc"
ln -s -- "${WORK}/targets/elsewhere/shadow" "${WORK}/targets/panel-etc/panel.env"
assert_contains "$(PANEL_ENV=${WORK}/targets/panel-etc/panel.env targets_verdict)" "panel.env 不能是符号链接" "panel.env 是符号链接时应被拒绝"
# R4：照 unit 认配置路径，只认跑面板的 KixDNS 程序、只有 root 能改的 unit 文件。/ R4: the config path comes only from a unit
# file that runs the panel's KixDNS program and that root alone can change.
unit_base="${WORK}/unit-config"
rm -rf -- "${unit_base}"
mkdir -p "${unit_base}/units"
printf '[Service]\nExecStart=/var/lib/kixdns-panel/bin/kixdns run --config /etc/kixdns/pipeline.json --admin-socket /run/kixdns/admin.sock\n' \
  > "${unit_base}/units/kixdns.service"
printf '[Service]\nExecStart=/usr/bin/other run --config /etc/kixdns/pipeline.json\n' > "${unit_base}/units/other.service"
assert_equals "$(ROOT_UID="$(id -u)" managed_unit_config "${unit_base}/units/kixdns.service")" "/etc/kixdns/pipeline.json" \
  "跑面板 KixDNS 的 unit 应给出它的配置"
assert_equals "$(ROOT_UID="$(id -u)" managed_unit_config "${unit_base}/units/other.service")" "" "跑别的程序的 unit 不能拿来认配置"
chmod 0664 "${unit_base}/units/kixdns.service"
assert_equals "$(ROOT_UID="$(id -u)" managed_unit_config "${unit_base}/units/kixdns.service")" "" "别人能改的 unit 文件不能拿来认配置"

# 规则写在脚本开头 / The rules are written at the top of the script
for rule in R1 R2 R3 R4; do
  assert_contains "$(head -n 60 "${INSTALLER}")" "# ${rule}：" "install.sh 开头应写明规则 ${rule}"
done

# 已经改管副本的主机再升级：备份里有副本的记录，不再动原配置。/ A host already on the copy upgrades again: the backup records
# the copy, and the original is not touched again.
legacy_host_tree 'User=kxu\n'
config_directory_run > /dev/null
printf 'KIXDNS_CONFIG=%s\nKIXDNS_SERVICE_UNIT=kixdns.service\n' "${root}/panel-etc/kixdns/pipeline.json" > "${root}/panel-etc/panel.env"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/panel-etc/kixdns/pipeline.json" "改过来以后再升级照旧管副本"
assert_not_contains "${output}" "${root}/etc/foo.json" "改过来以后再升级不能再动原配置"

# 同类（I1）：#288 以前全新安装可以把配置放进 /etc 这样的公共目录，这个目录就归了面板。没有外部备份、记下的配置目录不是
# /etc/kixdns、里面还放着配置以外的东西时，升级把配置挪到 /etc/kixdns/pipeline.json，目录交还 root:root 0755。那里已经有文件时
# 在改动主机之前停下。
# Sibling (I1): before #288 a fresh install could put the config in a shared directory such as /etc, which then became the
# panel's. Without an external backup, with the recorded config directory other than /etc/kixdns and holding anything besides
# the config, an upgrade moves the config to /etc/kixdns/pipeline.json and hands the directory back as root:root 0755. A
# file already there stops it before the host is touched.
for shared_arguments in "" --panel-only-update; do
  upgrade_host_tree
  : > "${root}/etc/passwd-like"
  # 当年的全新安装把这个目录交给面板时是 0750 / The fresh install of that time handed this directory to the panel as 0750
  chmod 0750 "${root}/etc"
  # shellcheck disable=SC2086 # 空参数就是不带参数 / An empty argument means none
  output="$(config_directory_run ${shared_arguments})"
  label=${shared_arguments:-升级}
  assert_contains "${output}" "${root}/etc-kixdns/pipeline.json restart=false unit=true" "公共目录里的配置应挪到 /etc/kixdns（${label}）"
  assert_contains "${output}" "install -o kixdns-panel -g kixdns -m 0640 -- ${root}/etc/foo.json ${root}/etc-kixdns/pipeline.json" \
    "应把配置复制到新位置（${label}）"
  [[ ! -e ${root}/etc/foo.json ]] || { printf '断言失败：挪走以后公共目录里不能留着旧配置（%s）\n' "${label}" >&2; exit 1; }
  assert_contains "${output}" "chown -h root:root -- ${root}/etc"$'\n' "公共目录应交还 root（${label}）"
  assert_contains "${output}" "chmod 0755 -- ${root}/etc"$'\n' "公共目录应是 0755（${label}）"
  assert_contains "${output}" "ReadWritePaths=${root}/etc-kixdns /var/lib/kixdns-panel" "面板 unit 只能写新的配置目录（${label}）"
  assert_contains "${output}" "配置：从 ${root}/etc/foo.json 挪到 ${root}/etc-kixdns/pipeline.json；${root}/etc 里还放着别的文件，面板不再写它" \
    "安装结果应说明配置挪到哪（${label}）"
  assert_contains "${output}" "  ${root}/etc：" "安装结果应列出交还的目录（${label}）"
done
# 回归（N4）：照提示把 /etc/kixdns/pipeline.json 移走以后，/etc/kixdns 里还放着别的文件：这个目录也不交给面板，在改动主机之前停下。
# Regression (N4): once /etc/kixdns/pipeline.json was moved off as told, /etc/kixdns still holds other files: that directory
# is not handed to the panel either, and the run stops before the host is touched.
upgrade_host_tree
: > "${root}/etc/passwd-like"
mkdir -p "${root}/etc-kixdns"
: > "${root}/etc-kixdns/README"
output="$(config_directory_run)"
assert_contains "${output}" "安装失败：KixDNS 配置要放在 ${root}/etc-kixdns，面板要能写这个目录，可里面还放着别的文件（${root}/etc-kixdns/README）。" \
  "挪配置的新目录里放着别的文件时应拒绝"
assert_not_contains "${output}" "PLANNED" "挪配置的新目录里放着别的文件时应在改动主机之前拒绝"
[[ -f ${root}/etc/foo.json ]] || { printf '断言失败：拒绝时公共目录里的配置要留着\n' >&2; exit 1; }

# 同类（I1）：旧版原地迁移的主机用 --keep-kixdns 卸载过，留下的增强版跑的还是公共目录里的原配置；接回它时也一样挪走，不再把
# 公共目录交给面板。
# Sibling (I1): a host an older version migrated in place, uninstalled with --keep-kixdns, leaves the enhanced KixDNS running
# the original config in the shared directory; taking it back moves the config just the same instead of handing the shared
# directory to the panel again.
config_directory_tree
: > "${root}/etc/passwd-like"
printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
output="$(CONFIG_DIRECTORY_UNIT="${root}/etc/foo.json" config_directory_run)"
assert_contains "${output}" "PLANNED reclaim ${root}/etc-kixdns/pipeline.json" "接回面板的 KixDNS 时公共目录里的配置也应挪走"
assert_contains "${output}" "chown -h root:root -- ${root}/etc"$'\n' "接回时公共目录应交还 root"
assert_not_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/etc"$'\n' "接回时不能再把公共目录交给面板"
# 换配置位置以后安装失败：回滚放回原配置（内容、权限）、它所在目录的权限、补记之前的外部备份，删掉副本或新位置的配置。
# The install fails after the config moved: rollback puts back the original config (content, mode), its directory's mode and
# the external backup as it was before the copy was added, and removes the copy or the config in its new place.
conversion_rollback() {
  local kind=$1
  if [[ ${kind} == legacy ]]; then
    legacy_host_tree 'User=kxu\n'
  else
    upgrade_host_tree
    : > "${root}/etc/passwd-like"
  fi
  chmod 0751 "${root}/etc"
  chmod 0604 "${root}/etc/foo.json"
  cp -a -- "${root}/etc/foo.json" "${root}/original-config"
  [[ ! -f ${root}/state/external-backup/install.env ]] || cp -- "${root}/state/external-backup/install.env" "${root}/original-backup"
  (
    PACKAGE_ROOT="${root}/package"
    PANEL_CONFIG_DIRECTORY="${root}/panel-etc"
    PANEL_ENV="${root}/panel-etc/panel.env"
    PANEL_STATE_DIRECTORY="${root}/state"
    MIGRATED_KIXDNS_CONFIG_DIRECTORY="${root}/panel-etc/kixdns"
    MIGRATED_KIXDNS_CONFIG="${root}/panel-etc/kixdns/pipeline.json"
    KIXDNS_CONFIG_DIRECTORY="${root}/etc-kixdns"
    PANEL_SERVER_BINARY="${root}/panel-server"
    SYSTEMD_UNIT_DIRECTORY="${root}/units"
    ROOT_RECORDS="${root}/records"
    EXTERNAL_BACKUP="${ROOT_RECORDS}/external-backup"
    ROOT_UID="$(id -u)"
    BACKUP_ROOT="${root}/rollback"
    mkdir -p "${BACKUP_ROOT}"
    getent() { [[ $1 == passwd && $2 == kxu ]] && printf 'kxu:x:1001:1001::/nonexistent:/usr/sbin/nologin\n'; }
    chown() { :; }
    panel_owned() { return 0; }
    systemctl() { :; }
    update_panel_environment() { :; }
    install() {
      local arguments=()
      while [[ $# -gt 0 ]]; do
        case $1 in -o | -g) shift ;; *) arguments+=("$1") ;; esac
        shift
      done
      [[ ${arguments[*]: -1} != "${root}"/* ]] || command install "${arguments[@]}"
    }
    secure_root_records
    load_existing_panel_settings
    INSTALL_KIND=upgrade
    validate_install_mode
    eval "real_backup_path() $(declare -f backup_path | tail -n +2)"
    eval "real_restore_path() $(declare -f restore_path | tail -n +2)"
    backup_path() { [[ $1 != "${root}"/* ]] || real_backup_path "$@"; }
    restore_path() { [[ $1 != "${root}"/* ]] || real_restore_path "$@"; }
    backup_managed_config
    backup_original_config
    install_configuration
    printf 'CONVERTED %s %s\n' "${CONFIG_CONVERSION}" "$(stat -c '%a' "${root}/etc")"
    restore_panel_database() { :; }
    INSTALL_MODE=managed
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    rollback_install 1
  ) 2>&1 || true
  printf 'ORIGINAL=%s %s\n' "$(cmp -s "${root}/etc/foo.json" "${root}/original-config" && printf same || printf changed)" \
    "$(stat -c '%a' "${root}/etc/foo.json" 2>/dev/null || printf missing)"
  printf 'DIRECTORY=%s\n' "$(stat -c '%a' "${root}/etc")"
  [[ ! -e ${root}/panel-etc/kixdns && ! -e ${root}/etc-kixdns ]] || printf 'NEW-CONFIG-LEFT\n'
  if [[ -f ${root}/original-backup ]]; then
    cmp -s "${root}/records/external-backup/install.env" "${root}/original-backup" || printf 'BACKUP-CHANGED\n'
  fi
}
for conversion_kind in legacy shared; do
  output="$(conversion_rollback "${conversion_kind}")"
  assert_contains "${output}" "CONVERTED ${conversion_kind} 755" "回滚之前应真的换了配置位置（${conversion_kind}）"
  assert_contains "${output}" "ORIGINAL=same 604" "回滚应放回原配置的内容和权限（${conversion_kind}）"
  assert_contains "${output}" "DIRECTORY=751" "回滚应放回原配置所在目录的权限（${conversion_kind}）"
  assert_not_contains "${output}" "NEW-CONFIG-LEFT" "回滚应删掉副本或新位置的配置（${conversion_kind}）"
  assert_not_contains "${output}" "BACKUP-CHANGED" "回滚应放回补记之前的外部备份（${conversion_kind}）"
done
# 面板写到一半的临时文件不算别的东西 / A temporary file the panel was half way through writing does not count as anything else
upgrade_host_tree
: > "${root}/etc/.kixdns-panel-Ab12Cd"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/etc/foo.json" "只多了面板的临时文件时目录照旧"
upgrade_host_tree
: > "${root}/etc/passwd-like"
mkdir -p "${root}/etc-kixdns"
printf '{"other":true}\n' > "${root}/etc-kixdns/pipeline.json"
output="$(config_directory_run)"
assert_contains "${output}" "安装失败：KixDNS 配置在 ${root}/etc 里，这个目录还放着别的文件，不能再交给面板写。安装器要把配置挪到 ${root}/etc-kixdns/pipeline.json，可那里已经有文件。" \
  "新位置已经有文件时应停下并说明"
assert_contains "${output}" "先把 ${root}/etc-kixdns/pipeline.json 移走再重新运行；现有安装未作修改。" "停下时应说明怎么办"
assert_not_contains "${output}" "PLANNED" "新位置已经有文件时应在改动主机之前停下"
[[ -f ${root}/etc/foo.json ]] || { printf '断言失败：停下时不能动原来的配置\n' >&2; exit 1; }

# 上次卸载保留下来的面板自带 KixDNS：接回来（不是迁移，以前这里断言的 migrate 正是 I5 的错），配置按它的 unit 记下的路径
# 原地管理，照旧；带不带 --replace-existing 都一样。
# The panel's own KixDNS kept by an earlier uninstall: taken back (not migrated; the migrate asserted here before was the
# bug), its config managed in place where its unit says, as before; with or without --replace-existing alike.
for reclaim_arguments in --replace-existing ""; do
  config_directory_tree
  printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
  # shellcheck disable=SC2086 # 空参数就是不带参数 / An empty argument means none
  output="$(CONFIG_DIRECTORY_UNIT="${root}/etc/foo.json" config_directory_run ${reclaim_arguments})"
  assert_contains "${output}" "PLANNED reclaim ${root}/etc/foo.json" "面板自带 KixDNS 的配置应按它的 unit 原地管理（${reclaim_arguments:-无参数}）"
done

# 迁移外部 KixDNS：检查的是副本的目录，不是原配置所在的已有目录；副本的目录已经在（上次卸载保留增强版时留下的）也照旧可用。
# Migrating an external KixDNS: the copy's directory is checked, not the existing one of the original config; the copy's
# directory being there already (left by an earlier uninstall that kept the enhanced KixDNS) is fine as before.
config_directory_tree
mkdir -p "${root}/panel-etc/kixdns"
output="$(CONFIG_DIRECTORY_KIXDNS=true config_directory_run --replace-existing --kixdns-binary /usr/local/bin/kixdns \
  --kixdns-config "${root}/etc/foo.json")"
assert_contains "${output}" "PLANNED migrate ${root}/panel-etc/kixdns/pipeline.json" "迁移副本的目录已经在时应照旧迁移"
assert_equals "$(config_directory_touched "${output}" "${root}/etc")" "" "迁移不能改动原配置所在的目录"

# 只剩面板目录里的 KixDNS 程序、没有 unit：配置路径来自 --kixdns-config，不是记录，照样不能落在已有目录里。
# Only the KixDNS program in the panel's directory is left, without a unit: the config path comes from --kixdns-config,
# not from a record, so it still may not land in an existing directory.
config_directory_tree
printf '#!/bin/sh\n' > "${root}/state/bin/kixdns"
output="$(CONFIG_DIRECTORY_KIXDNS=true config_directory_run --replace-existing --kixdns-config "${root}/etc/foo.json")"
assert_contains "${output}" "KixDNS 配置不能放在 ${root}/etc：" "没有 unit 记下配置时，参数给的路径不能落在已有目录里"
assert_equals "$(config_directory_touched "${output}" "${root}/etc")" "" "没有 unit 记下配置时不能改动已有目录"

# 安装器照这个顺序检查：迁移副本计划好之后（validate_install_mode 里），改动主机之前。
# The installer checks in this order: once the migration copy is planned (in validate_install_mode), before the host is touched.
main_body="$(declare -f main)"
# 少了哪一步时 grep 什么也找不到；|| true 让下面的断言说出来，而不是 set -e 无声退出。
# grep finds nothing when a step is missing; || true lets the assertion below say so instead of set -e exiting silently.
validate_line="$(grep -n 'validate_install_mode' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
dedicated_line="$(grep -n 'require_dedicated_config_directory' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
accounts_line="$(grep -n 'create_accounts' <<< "${main_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${dedicated_line} && ${validate_line} -lt ${dedicated_line} && ${dedicated_line} -lt ${accounts_line} ]] || {
  printf '断言失败：配置目录应在规划好迁移副本之后、改动主机之前检查（validate=%s dedicated=%s accounts=%s）\n' \
    "${validate_line}" "${dedicated_line}" "${accounts_line}" >&2
  exit 1
}

substitution_rollback() {
  local root="${WORK}/rollback-substitution"
  rm -rf -- "${root}"
  mkdir -p "${root}/etc" "${root}/backup"
  bash -c "
    source '${INSTALLER}'
    PANEL_ENV='${root}/etc/panel.env'
    BACKUP_ROOT='${root}/backup'
    printf 'old-env\\n' > \"\${PANEL_ENV}\"
    backup_path \"\${PANEL_ENV}\" panel-env
    printf 'new-env\\n' > \"\${PANEL_ENV}\"
    eval \"real_restore_path() \$(declare -f restore_path | tail -n +2)\"
    restore_path() { [[ \$1 != '${root}'/* ]] || real_restore_path \"\$@\"; }
    restore_managed_config() { :; }
    restore_panel_database() { :; }
    systemctl() { :; }
    environment_value() { printf '0.0.0.0:5738\\n'; }
    wait_for_service_stable() { :; }
    INSTALL_MODE=managed
    INSTALL_KIND=upgrade
    EXISTING_PANEL=true
    CREATED_EXTERNAL_BACKUP=false
    KIXDNS_BINARY_CHANGED=false
    KIXDNS_UNIT_CHANGED=false
    RESOLVED_CHANGED=false
    write_something() { local temporary; temporary=\"\$(mktemp '${root}/missing-dir/.panel.env.XXXXXX')\"; printf '%s' \"\${temporary}\"; }
    arm_rollback
    write_something
  " 2>&1 || true
  printf 'ENV=%s\n' "$(cat "${root}/etc/panel.env" 2>/dev/null || printf 'missing')"
}
output="$(substitution_rollback)"
assert_contains "${output}" "ENV=old-env" "命令替换里失败时，回滚放回的面板环境文件不能被第二次回滚删掉"
rollbacks="$(grep -c '安装未完成' <<< "${output}" || true)"
assert_equals "${rollbacks}" "1" "命令替换里失败时只回滚一次"

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
assert_contains "${output}" "chown -h kixdns-panel:kixdns -- ${WORK}/rollback-database/data/panel.db" "放回的数据库应归面板账号所有（不跟着符号链接改）"
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

# 等待循环按轮数计时（每轮 sleep 0.5）；下面把 sleep 换成空操作，因为断言只看各轮之间 PID 与端口的变化，
# 不看墙钟，原来这一节每次都要真等十几秒。
# The wait loop counts rounds (sleep 0.5 each); the stubs below make sleep a no-op because the assertions
# depend on PID and port changes across rounds, not wall time, and this section used to wait over ten seconds.
SERVICE_WAIT_SECONDS=3
SERVICE_STABLE_SECONDS=1
pid_counter="${WORK}/pid-counter"
service_probe() {
  local mode=$1
  local port_ok=$2
  (
    printf '0\n' > "${pid_counter}"
    sleep() { :; }
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
    sleep() { :; }
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
    sleep() { :; }
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
  1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
if grep -q '^KIXDNS_PANEL_INSTALLED_RELEASE=' "${environment_output}"; then
  printf '断言失败：Action 包不应输出空 Release 环境变量\n' >&2
  exit 1
fi
if grep -q 'KIXDNS_MANAGEMENT_ENABLED\|false：保留外部' "${environment_output}"; then
  printf '断言失败：升级应删掉已移除的管理模式开关\n' >&2
  exit 1
fi
if grep -q 'KIXDNS_UPDATE_RELEASE_WORKFLOW' "${environment_output}"; then
  printf '断言失败：升级应删掉不再读取的 Release 工作流设置\n' >&2
  exit 1
fi
# 卸载器在 KixDNS 不归面板管以后记下的待删的东西：重新装上以后又归面板管，这些键要删掉（迁移备份会接着记账号，见下）。
# What the uninstaller records as left to remove once the KixDNS is no longer the panel's: after a reinstall it is the
# panel's again and these keys go (a migration backup carries the accounts on, see below).
printf '%s\n' 'KIXDNS_MANAGEMENT_ENABLED=false' 'KIXDNS_REMOVED=true' 'KIXDNS_USER_CREATED=true' 'KIXDNS_GROUP_CREATED=false' \
  > "${WORK}/left-behind.env"
render_panel_environment "${WORK}/left-behind.env" "${WORK}/left-behind.out" 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
assert_equals "$(grep -c '^KIXDNS_\(MANAGEMENT_ENABLED\|REMOVED\|USER_CREATED\|GROUP_CREATED\)=' "${WORK}/left-behind.out" || true)" "0" \
  "重新安装应删掉卸载器记下的归属和待删记录"
# 迁移备份记下 kixdns 账号和组是不是面板建的：这次运行开始时还没有，或者保留的 panel.env 记着是以前的面板留下待删的。
# The migration backup records whether the kixdns account and group are the panel's: missing when this run began, or left
# by an earlier panel to be removed, as the kept panel.env says.
account_created_of() {
  (
    KIXDNS_USER_EXISTED=$1
    KIXDNS_GROUP_EXISTED=$1
    PANEL_ENV="${WORK}/account-created.env"
    printf '%s\n' "${@:2}" > "${PANEL_ENV}"
    printf '%s %s\n' "$(kixdns_account_created user)" "$(kixdns_account_created group)"
  )
}
assert_equals "$(account_created_of false)" "true true" "这次建的 kixdns 账号和组算面板的"
assert_equals "$(account_created_of true)" "false false" "原来就有的 kixdns 账号和组不算面板的"
assert_equals "$(account_created_of true KIXDNS_REMOVED=true)" "true true" "面板自己的 KixDNS 移除后留下的账号和组算面板的"
assert_equals "$(account_created_of true KIXDNS_USER_CREATED=true KIXDNS_GROUP_CREATED=false)" "true false" \
  "上次迁移建的账号记在 panel.env 里时照旧算面板的"
render_panel_environment "${environment_source}" "${environment_output}" \
  1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 v1.0.0 42 fork
release_value="$(awk -F= '$1 == "KIXDNS_PANEL_INSTALLED_RELEASE" { print $2 }' "${environment_output}")"
assert_equals "${release_value}" "v1.0.0" "正式包应保留 Release 标签"
helper_socket_value="$(awk -F= '$1 == "KIXDNS_SERVICE_HELPER_SOCKET" { print $2 }' "${environment_output}")"
assert_equals "${helper_socket_value}" "/run/kixdns-panel/control.sock" "面板环境应写入受限 helper Socket"
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "127.0.0.1:5738" "用户设的本机监听地址不应被升级改成对外"
source_id_value="$(awk -F= '$1 == "KIXDNS_INSTALLED_SOURCE_ID" { print $2 }' "${environment_output}")"
assert_equals "${source_id_value}" "42" "面板环境应记录完整包 Artifact ID"
if grep -q 'KIXDNS_MANAGEMENT_ENABLED\|KIXDNS_UPDATE_' "${PACKAGE_ROOT}/deploy/panel.env.example"; then
  printf '断言失败：面板环境模板不应再包含已移除的设置\n' >&2
  exit 1
fi

# 旧面板写下的环境：按补丁集构建找 Artifact 的设置，还没有内核来源。
# An environment an older panel wrote: the settings that located patchset Artifacts, and no kernel source yet.
printf '%s\n' \
  '# GitHub API 元数据请求可在系统页配置 Token；Artifact 下载仍通过 nightly.link。' \
  'KIXDNS_UPDATE_REPOSITORY=tuoro/kixdns-panel' \
  'KIXDNS_UPDATE_WORKFLOW=build-kixdns.yml' \
  'KIXDNS_UPDATE_BRANCH=main' \
  '# x86_64 使用 x86_64，ARM64 使用 arm64；安装脚本会自动填写。' \
  'KIXDNS_UPDATE_ARTIFACT=kixdns-enhanced-linux-x86_64' \
  '# 完整安装包复用的 KixDNS Action 提交，由安装脚本填写；不要手工修改。' \
  'KIXDNS_INSTALLED_COMMIT=3333333333333333333333333333333333333333' \
  '# 完整安装包自带增强 Artifact 的 GitHub ID，由安装脚本填写。' \
  'KIXDNS_INSTALLED_SOURCE_ID=7' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
if grep -q 'KIXDNS_UPDATE_\|nightly\.link\|自动填写。$\|Action 提交\|增强 Artifact' "${environment_output}"; then
  printf '断言失败：升级应删掉不再读取的 Artifact 更新设置和旧说明\n' >&2
  exit 1
fi
identity_lines="$(grep '^KIXDNS_INSTALLED_\|^# 完整安装包' "${environment_output}")"
expected_identity="$(printf '%s\n' \
  '# 完整安装包自带内核的来源和提交，由安装脚本填写；不要手工修改。' \
  'KIXDNS_INSTALLED_SOURCE=fork' \
  'KIXDNS_INSTALLED_COMMIT=1111111111111111111111111111111111111111' \
  '# 完整安装包自带内核包在 GitHub 上的编号，由安装脚本填写。' \
  'KIXDNS_INSTALLED_SOURCE_ID=42')"
assert_equals "${identity_lines}" "${expected_identity}" "完整包应在提交前记下内核来源，说明改成新的说法"
# 只更新面板、原来没记来源（旧 Action 内核）：不凭空写上来源。
# A panel-only update with no recorded source (an old Action kernel): no source is made up.
render_panel_environment "${environment_source}" "${environment_output}" \
  3333333333333333333333333333333333333333 2222222222222222222222222222222222222222 '' 7 ''
if grep -q '^KIXDNS_INSTALLED_SOURCE=' "${environment_output}"; then
  printf '断言失败：没有来源记录时不应写出内核来源\n' >&2
  exit 1
fi
printf '%s\n' 'KIXDNS_INSTALLED_SOURCE=fork' 'KIXDNS_INSTALLED_COMMIT=3333333333333333333333333333333333333333' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  3333333333333333333333333333333333333333 2222222222222222222222222222222222222222 '' 7 fork
assert_equals "$(grep -c '^KIXDNS_INSTALLED_SOURCE=fork$' "${environment_output}")" "1" \
  "已有的内核来源应原地保留一行"

printf '%s\n' 'KIXDNS_PANEL_BIND=192.168.10.5:6754' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "192.168.10.5:6754" "用户自定义监听地址不应被升级覆盖"

printf '%s\n' 'KIXDNS_PANEL_INSTALLED_RELEASE=' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 '' 42 fork
assert_equals "$(grep -c '^KIXDNS_PANEL_BIND=0\.0\.0\.0:5738$' "${environment_output}")" "1" \
  "没设过监听地址时应补上默认值"

# v4.3.4 及更早的示例写的是「默认信任本机代理」，从那时装起的 panel.env 都带着它。升级保留这个值：改掉的话，本机 Nginx 后面的
# 每个人几次输错就全被锁住，比它挡住的本机伪造更糟。值和上面那行说明都还是旧示例原样时，把说明换成新示例的，在安装结果里
# 提醒一次；说明换过以后不再提醒。
# Up to v4.3.4 the example trusted the local proxy by default, and every panel.env made from it still carries that. An upgrade
# keeps the value: changing it would lock everyone behind a local Nginx out after a few wrong logins, worse than the local
# spoofing it stops. When the value and the comment above it are still the old example's, the comment becomes the new
# example's and the install result says so once; with the comment replaced, it says nothing again.
trusted_proxies_round() {
  (
    PANEL_ENV=$1
    PANEL_CONFIG_DIRECTORY="$(dirname -- "$1")"
    chown() { :; }
    TRUSTED_PROXIES_NOTICE=false
    update_panel_environment 1111111111111111111111111111111111111111 42 fork
    printf 'NOTICE=%s\n' "${TRUSTED_PROXIES_NOTICE}"
  )
}
trusted_env="${WORK}/trusted-proxies/panel.env"
mkdir -p "$(dirname -- "${trusted_env}")"
old_trusted_comment='# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。'
printf '%s\n' 'KIXDNS_PANEL_SECURE_COOKIE=false' "${old_trusted_comment}" 'KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128' \
  'RUST_LOG=info' > "${trusted_env}"
assert_equals "$(trusted_proxies_round "${trusted_env}")" "NOTICE=true" "旧示例的默认值和说明都还在时应提醒"
new_trusted_comments="$(awk '/^KIXDNS_TRUSTED_PROXIES=/ { print comments; exit } /^#/ { comments = comments (comments == "" ? "" : "\n") $0; next } { comments = "" }' \
  "${PACKAGE_ROOT}/deploy/panel.env.example")"
assert_equals "$(grep -B2 '^KIXDNS_TRUSTED_PROXIES=' "${trusted_env}")" \
  "${new_trusted_comments}"$'\n''KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128' "旧说明应换成新示例的说明，值保持不变"
assert_equals "$(grep -c '^KIXDNS_TRUSTED_PROXIES=' "${trusted_env}")" "1" "可信代理只能有一行"
assert_equals "$(grep -cxF "${old_trusted_comment}" "${trusted_env}" || true)" "0" "旧说明不应留下"
assert_equals "$(trusted_proxies_round "${trusted_env}")" "NOTICE=false" "说明换过以后不再提醒"
# 用户改过值或说明的，是自己的设置，不动也不提醒。/ A value or comment the user changed is their own setting: left alone, no notice.
for trusted_lines in "${old_trusted_comment}|KIXDNS_TRUSTED_PROXIES=10.0.0.0/8" \
  "# 我自己的反向代理|KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128" "KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128"; do
  tr '|' '\n' <<< "${trusted_lines}" > "${trusted_env}"
  before="$(cat "${trusted_env}")"
  assert_equals "$(trusted_proxies_round "${trusted_env}")" "NOTICE=false" "改过的可信代理设置不应提醒（${trusted_lines}）"
  assert_equals "$(grep -B1 '^KIXDNS_TRUSTED_PROXIES=' "${trusted_env}")" "${before}" "改过的可信代理设置不应改动（${trusted_lines}）"
done
output="$(
  INSTALL_KIND=upgrade
  KIXDNS_WAS_ACTIVE=true
  KIXDNS_BINARY_CHANGED=false
  KIXDNS_UNIT_CHANGED=false
  PORT_CONFLICT=none
  RESOLVED_CHANGED=false
  PANEL_BUILD_COMMIT=${commit_a}
  KIXDNS_BUILD_COMMIT=${commit_b}
  TRUSTED_PROXIES_NOTICE=true
  PANEL_ENV=/etc/kixdns-panel/panel.env
  print_summary http://192.168.1.20:5738
)"
assert_equals "$(tail -n 2 <<< "${output}" | head -n 1)" "只在可信内网使用面板；公网访问必须配置防火墙和 HTTPS 反向代理。" \
  "可信代理的提醒也在安全提醒之前"
assert_contains "${output}" "反向代理：panel.env 还信任本机代理（旧版的默认值 127.0.0.1/32,::1/128）；这台主机上没有反向代理时，清空它更安全：" \
  "旧默认值留着时安装结果应提醒"
assert_contains "${output}" \
  "  sudo sed -i 's|^KIXDNS_TRUSTED_PROXIES=.*|KIXDNS_TRUSTED_PROXIES=|' /etc/kixdns-panel/panel.env && sudo systemctl restart kixdns-panel.service" \
  "提醒应给出清空的命令"

# 文档里照抄就要能用：panel.env 是 root:kixdns 0640，普通 sudo 用户读不了。回归：「代理就在本机」那段的 grep 没带 sudo，
# 读不到就当没有这一项，又追加了一行重复的。文档 bash 代码块里每条碰 panel.env 的命令都要以 sudo 开头。
# The docs must work when copied: panel.env is root:kixdns 0640, which an ordinary sudo user cannot read. Regression: the
# grep in the "proxy on the same host" snippet lacked sudo, read nothing and appended a duplicate line. Every command in a
# bash block of the docs that touches panel.env must start with sudo.
unprivileged_panel_env_commands() {
  python3 -I - "$@" <<'PY'
import shlex
import sys

for path in sys.argv[1:]:
    block = None
    logical = ""
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("```"):
            block = None if block is not None else line[3:].strip()
            continue
        if block != "bash":
            continue
        logical += line.rstrip("\\").strip() + " "
        if line.endswith("\\"):
            continue
        # 引号外的 ||、&&、|、; 把一行分成几条命令 / ||, &&, | and ; outside quotes split a line into commands
        lexer = shlex.shlex(logical, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        command = []
        for token in list(lexer) + [";"]:
            if token in ("||", "&&", "|", ";"):
                if "/etc/kixdns-panel/panel.env" in command and command[0] != "sudo":
                    print(f"{path}: {' '.join(command)}")
                command = []
            else:
                command.append(token)
        logical = ""
PY
}
assert_equals "$(unprivileged_panel_env_commands "${PACKAGE_ROOT}/docs/deployment.md" "${PACKAGE_ROOT}/docs/deployment.en.md")" "" \
  "文档里碰 panel.env 的命令都要带 sudo"

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
assert_equals "$(sed -n 2p <<< "${output}")" "安装完成：KixDNS 面板 v3.1.1" "结果第一行应说明安装了哪个版本"
assert_equals "$(sed -n 3p <<< "${output}")" "面板地址：http://192.168.1.20:5738" "第二行应是面板地址"
assert_contains "${output}" "下一步：打开面板地址，创建管理员，然后在概览页点「启动 KixDNS」" "首次安装应给出下一步"
assert_contains "${output}" "KixDNS：已安装，尚未启动" "首次安装应说明 KixDNS 未启动"
assert_contains "${output}" "端口 53：被 systemd-resolved 占用" "端口未处理时应给出提示"
assert_contains "${output}" "sudo ln -sfn /run/systemd/resolve/resolv.conf ${WORK}/summary-resolv.conf" "应给出改指向 resolv.conf 的命令"
assert_equals "$(tail -n 2 <<< "${output}" | head -n 1)" "只在可信内网使用面板；公网访问必须配置防火墙和 HTTPS 反向代理。" "安全提醒应在构建信息之前"
assert_equals "$(tail -n 1 <<< "${output}")" "构建：面板 aaaaaaaaaaaa · KixDNS bbbbbbbbbbbb" "构建身份应在最后一行"
# MUST 1：不知道装的是哪个内核时不留半截的标签 / MUST 1: an unknown kernel build does not leave a dangling label
output="$(commit_b='' summary_of panel-only true false false none false '')"
assert_equals "$(tail -n 1 <<< "${output}")" "构建：面板 aaaaaaaaaaaa · KixDNS 未知" "不知道内核的提交时应写未知"
output="$(summary_of migrate true true true none false '')"
assert_contains "${output}" "KixDNS：已迁移为增强版，保持原来的运行状态（运行中）；原 unit 备份在 /var/lib/kixdns-panel-backup/external-backup，卸载面板时可恢复" "迁移结果应说明状态与备份"
output="$(ORIGINAL_KIXDNS_CONFIG_PATH=${INSTALLER} KIXDNS_CONFIG_PATH=/etc/kixdns-panel/kixdns/pipeline.json \
  summary_of migrate true true true none false '')"
assert_contains "${output}" "配置：已复制到 /etc/kixdns-panel/kixdns/pipeline.json 由面板管理，原来的 ${INSTALLER} 不动" \
  "迁移结果应说明配置副本在哪、原配置不动"
output="$(ORIGINAL_KIXDNS_CONFIG_PATH=${WORK}/no-such-config.json KIXDNS_CONFIG_PATH=/etc/kixdns-panel/kixdns/pipeline.json \
  summary_of migrate true true true none false '')"
assert_contains "${output}" "配置：${WORK}/no-such-config.json 不存在，面板在 /etc/kixdns-panel/kixdns/pipeline.json 写入了默认配置" \
  "原配置不存在时迁移结果应说明写入了默认配置"
assert_not_contains "${output}" "下一步" "迁移不应给出首次安装的下一步"
assert_not_contains "${output}" "端口 53" "端口无冲突时不提示"
# 接回上次卸载时保留的面板自带 KixDNS：没有另做备份，以后移除会删掉它；迁移来的主机上迁移前的备份还在时，说那份备份。
# Taking back the panel's own KixDNS kept by an earlier uninstall: no backup is made and a later removal deletes it; on a
# migrated host whose pre-migration backup is still there, that backup is named instead.
reclaim_records="${WORK}/reclaim-records"
reclaim_backup="${reclaim_records}/external-backup"
reclaim_uid="$(id -u)"
rm -rf -- "${reclaim_records}"
for reclaim_view in plan summary; do
  if [[ ${reclaim_view} == plan ]]; then
    output="$(ROOT_RECORDS=${reclaim_records} EXTERNAL_BACKUP=${reclaim_backup} ROOT_UID=${reclaim_uid} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)"
  else
    output="$(ROOT_RECORDS=${reclaim_records} EXTERNAL_BACKUP=${reclaim_backup} ROOT_UID=${reclaim_uid} summary_of reclaim true true true none false '')"
  fi
  assert_contains "${output}" "它是面板自己装的，这次不另做备份；以后卸载时选择移除 KixDNS，会把它删掉" "接回时应说明不备份、移除会删掉（${reclaim_view}）"
  assert_not_contains "${output}" "原 unit 备份在" "接回时不能说备份了原 unit（${reclaim_view}）"
  assert_not_contains "${output}" "迁移为增强版" "接回不是迁移（${reclaim_view}）"
done
assert_contains "${output}" "KixDNS：已接回上次卸载时保留的 KixDNS，保持原来的运行状态（运行中）" "接回的结果应说明保持运行状态"
assert_contains "$(ROOT_RECORDS=${reclaim_records} EXTERNAL_BACKUP=${reclaim_backup} ROOT_UID=${reclaim_uid} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)" \
  "检测到上次卸载时保留的 KixDNS（kixdns.service，运行中），接着由面板管理" "接回前应说明检测到了什么"
mkdir -p "${reclaim_backup}"
chmod 0700 "${reclaim_records}"
printf 'KIXDNS_SERVICE_UNIT=kixdns.service\nKIXDNS_BINARY=/usr/local/bin/kixdns\n' > "${reclaim_backup}/install.env"
for reclaim_view in plan summary; do
  if [[ ${reclaim_view} == plan ]]; then
    output="$(ROOT_RECORDS=${reclaim_records} EXTERNAL_BACKUP=${reclaim_backup} ROOT_UID=${reclaim_uid} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)"
  else
    output="$(ROOT_RECORDS=${reclaim_records} EXTERNAL_BACKUP=${reclaim_backup} ROOT_UID=${reclaim_uid} summary_of reclaim true true true none false '')"
  fi
  assert_contains "${output}" "迁移前原来的 KixDNS 的备份还在 ${reclaim_backup}，以后卸载时选择移除增强版即可恢复" \
    "迁移前的备份还在时应说明能恢复（${reclaim_view}）"
  assert_not_contains "${output}" "会把它删掉" "迁移前的备份还在时移除不会删掉了事（${reclaim_view}）"
done

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
assert_equals "$(sed -n 2p <<< "${output}")" "面板更新完成：KixDNS 面板 v3.1.1" "仅更新面板的结果第一行"
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
  -e "s|/run/kixdns-panel-root|${online_update_root}/locks|" \
  "${PACKAGE_ROOT}/scripts/panel-online-update.sh" > "${online_update_root}/updater.sh"
# 两把锁都在只有 root 能进的目录里（SHOULD 2）/ Both locks live in a root-only directory (SHOULD 2)
mkdir -m 0700 "${online_update_root}/locks"
printf '#!/usr/bin/env bash\nprintf "kixdns-panel-server 3.1.1\\n"\n' > "${online_update_root}/server"
printf 'KIXDNS_PANEL_INSTALLED_RELEASE=v3.1.1\n' > "${online_update_root}/panel.env"
chmod 0755 "${online_update_root}/server"

# 结构 3：在线更新器整个运行都拿着安装器、卸载器也用的那把锁。它们正在运行时不更新、也不下载；拿到了就传给安装器
# （KIXDNS_PANEL_ROOT_LOCK_FD），安装器接着用这一把。
# Structural change 3: the online updater holds the lock the installer and uninstaller use for its whole run. While either
# runs it neither updates nor downloads; once it has the lock it hands it to the installer (KIXDNS_PANEL_ROOT_LOCK_FD),
# which carries on with it.
updater_body="$(cat -- "${online_update_root}/updater.sh")"
assert_contains "${updater_body}" "export KIXDNS_PANEL_ROOT_LOCK_FD=8" "在线更新器应把锁传给安装器"
root_lock_line="$(grep -n 'flock -n 8' <<< "${updater_body}" | head -n 1 | cut -d: -f1 || true)"
download_line="$(grep -n 'releases/latest' <<< "${updater_body}" | head -n 1 | cut -d: -f1 || true)"
[[ -n ${root_lock_line} && -n ${download_line} && ${root_lock_line} -lt ${download_line} ]] ||
  { printf '断言失败：在线更新器要先拿锁再查新版（lock=%s download=%s）\n' "${root_lock_line}" "${download_line}" >&2; exit 1; }

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
assert_contains "${output}" "failed 在线更新失败：kixdns-panel.service 启动后没有保持运行" \
  "安装器失败时状态应带上安装器给出的原因，不再叠一层「安装失败：」"
assert_not_contains "${output}" "安装失败：" "状态里只留一个「在线更新失败：」"

output="$(online_update_status "printf '一键安装失败：下载安装包失败，面板还是原来的版本。检查网络后再点一次在线更新\n' >&2; exit 1" "${latest_release}")"
assert_equals "${output}" "failed 在线更新失败：下载安装包失败，面板还是原来的版本。检查网络后再点一次在线更新" \
  "一键安装器的前缀也去掉"

output="$(online_update_status "exit 0" "printf 'curl: (6) Could not resolve host: api.github.com\n' >&2; return 6")"
assert_contains "${output}" "failed 在线更新失败：curl: (6) Could not resolve host: api.github.com" \
  "查询最新版失败时状态应带上 curl 的错误"

online_update_status "printf '一键安装失败：%s\n' \"\$(printf 'x%.0s' {1..400})\" >&2; exit 1" "${latest_release}" > /dev/null
assert_equals "$(jq -r '.message | length' "${online_update_root}/status/status.json")" "300" \
  "过长的原因应截断到面板接受的 300 字"

output="$(online_update_status "exit 0" "${latest_release}")"
assert_equals "${output}" "complete 面板已更新到 v3.1.2" "安装器成功时状态应为完成"

# SHOULD 2：在线更新自己的锁也在只有 root 能进的目录里（原来是 /run 里面板能打开的 0644 文件）/ SHOULD 2: the online
# update's own lock lives in the root-only directory too (it was a 0644 file in /run the panel could open)
[[ -f ${online_update_root}/locks/update.lock ]] ||
  { printf '断言失败：在线更新自己的锁应在只有 root 能进的目录里\n' >&2; exit 1; }
# SHOULD 2：在线更新放锁的目录不是只有 root 能进时不用它 / SHOULD 2: the online update does not use a lock directory others
# can enter
chmod 0755 "${online_update_root}/locks"
output="$(online_update_status "exit 0" "${latest_release}")"
chmod 0700 "${online_update_root}/locks"
assert_contains "${output}" "不是只有 root 能进的目录，锁不能放在那里" "在线更新放锁的目录不对时应停下"

# 结构 3：安装器或卸载器拿着锁时，在线更新停下并说明，不查新版、不调安装器；拿到锁的更新把它传给安装器。
# Structural change 3: with the installer or uninstaller holding the lock, the online update stops and says so, neither
# asking for the latest release nor running the installer; an update that got the lock hands it to the installer.
rm -f -- "${online_update_root}/one-click-ran"
exec 6>> "${online_update_root}/locks/lock"
flock -n 6
output="$(online_update_status "printf 'RAN\n' > '${online_update_root}/one-click-ran'" "${latest_release}")"
exec 6>&-
assert_equals "${output}" "failed 在线更新失败：安装器或卸载器正在运行，这次不更新；等它结束再试" "安装器或卸载器正在运行时在线更新应停下并说明"
[[ ! -e ${online_update_root}/one-click-ran ]] || { printf '断言失败：安装器或卸载器正在运行时在线更新不能调安装器\n' >&2; exit 1; }
output="$(online_update_status "printf '%s\n' \"\${KIXDNS_PANEL_ROOT_LOCK_FD:-}\" \"\$(readlink /proc/\$\$/fd/8)\" > '${online_update_root}/one-click-ran'" "${latest_release}")"
assert_equals "$(tr '\n' ' ' < "${online_update_root}/one-click-ran")" "8 ${online_update_root}/locks/lock " "在线更新器应把拿着的锁传给安装器"

# 回归（P1）：Token 文件在面板的状态目录里，面板账号能在检查和读取之间把它换成指向 root 才能读的文件的符号链接。按文件属主的
# 身份去读（换了也只能读到那个身份本来就能读的），最多等 5 秒。
# Regression (P1): the token file lives in the panel's state directory, where the panel account can swap it between the
# check and the read for a symlink to a file only root may read. It is read as the file's owner (a swap then only reaches
# what that owner could read anyway), waiting 5 s at most.
token_read_by() {
  printf 'ghp_fromfile\n' > "${online_update_root}/github-token"
  chmod 0600 "${online_update_root}/github-token"
  bash -c "
    source '${online_update_root}/updater.sh'
    stat() { case \$2 in %u | %g) printf '990\\n' ;; *) command stat \"\$@\" ;; esac; }
    setpriv() { printf 'setpriv %s\\n' \"\$*\" >&2; printf 'ghp_fromsetpriv\\n'; }
    # timeout 是外部命令，跑不到上面的替身 / timeout is an external command and would miss the stand-in above
    timeout() { shift; \"\$@\"; }
    prepare_github_api_config
    cat \"\${GITHUB_API_CONFIG}\"
  " 2>&1 || true
  rm -f -- "${online_update_root}/github-token" "${online_update_root}"/status/.github-api.*
}
output="$(token_read_by)"
assert_contains "${output}" "setpriv --reuid=990 --regid=990 --clear-groups -- head -c 300 -- ${online_update_root}/github-token" \
  "在线更新应按 Token 文件属主的身份读它"
assert_contains "${output}" "Bearer ghp_fromsetpriv" "在线更新用的是按属主身份读到的 Token"


printf '安装策略检查通过。\n'
