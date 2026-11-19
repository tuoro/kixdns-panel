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
  assert_contains "${output}" "安装失败：路径必须是绝对路径，不含空白，也不含 .、.. 或空的一段（//）" "${bad_path} 应被拒绝"
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
    EXTERNAL_BACKUP="${root}/external-backup"
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
  mkdir -p "${root}/units" "${root}/external-backup" "${root}/rollback"
  printf 'old unit\n' > "${root}/external-backup/kixdns.service"
  printf '%s\n' KIXDNS_SERVICE_UNIT=kixdns.service KIXDNS_CONFIG=/etc/old.json KIXDNS_BINARY=/usr/local/bin/kixdns \
    KIXDNS_WAS_ACTIVE=true KIXDNS_WAS_ENABLED=true > "${root}/external-backup/install.env"
  printf 'current unit\n' > "${root}/units/kixdns.service"
  (
    EXTERNAL_BACKUP="${root}/external-backup"
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
  printf 'AFTER-ROLLBACK=%s %s\n' "$(cat "${root}/external-backup/kixdns.service" 2>/dev/null || printf missing)" \
    "$(grep -c '^KIXDNS_CONFIG=/etc/old.json$' "${root}/external-backup/install.env" 2>/dev/null || true)"
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
  mkdir -p "${root}/units" "${root}/external-backup" "${root}/rollback"
  printf 'old unit\n' > "${root}/external-backup/kixdns.service"
  printf 'KIXDNS_BINARY=/usr/local/bin/kixdns\n' > "${root}/external-backup/install.env"
  printf 'current unit\n' > "${root}/units/kixdns.service"
  (
    EXTERNAL_BACKUP="${root}/external-backup"
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
  printf 'AFTER-INTERRUPT=%s\n' "$(cat "${root}/external-backup/kixdns.service" 2>/dev/null || printf missing)"
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
    EXTERNAL_BACKUP="${root}/external-backup"
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
    render_panel_environment /dev/null "${root}/rendered.env" kixdns-commit panel-commit '' 42 fork
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
    mktemp() { printf '%s\n' "${BACKUP_ROOT}"; }
    accounts_exist() { [[ ${existing} == true || -f ${WORK}/accounts-created ]]; }
    rm -f -- "${WORK}/accounts-created"
    id() { accounts_exist; }
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
    EXTERNAL_BACKUP="${root}/external-backup"
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
    parse_arguments "$@"
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
    printf 'PLANNED %s %s\n' "${INSTALL_KIND}" "${KIXDNS_CONFIG_PATH}"
    install_configuration
    install_services
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
assert_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/kept" "panel.env 记下的目录照旧交给面板"

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
assert_contains "${output}" "install -d -o kixdns-panel -g kixdns -m 0750 ${root}/etc-kixdns" "默认目录照旧交给面板"
assert_contains "${output}" "chown kixdns-panel:kixdns -- ${root}/etc-kixdns/pipeline.json" "默认目录里已有的配置照旧归面板"
output="$(config_directory_run --kixdns-config "${root}/etc-kixdns/custom.json")"
assert_contains "${output}" "PLANNED fresh ${root}/etc-kixdns/custom.json" "默认目录里的其他文件名应可用"

# 放着 panel.env 的面板配置目录不能交给面板，哪怕它还不存在：面板能改 panel.env，下次以 root 运行的安装器就会照着它改别的目录。
# The panel's config directory, which holds panel.env, never goes to the panel, even before it exists: a panel that could
# rewrite panel.env would steer the next installer run, as root, onto other directories.
config_directory_tree
output="$(config_directory_run --kixdns-config "${root}/panel-etc/pipeline.json")"
assert_contains "${output}" "安装失败：KixDNS 配置不能放在 ${root}/panel-etc：面板要能写配置所在的目录，而这里的 panel.env 只能由 root 修改。" \
  "配置放在面板配置目录时应说明为什么拒绝"
assert_contains "${output}" "${config_directory_message}" "拒绝时应说明换到哪里"
assert_not_contains "${output}" "PLANNED" "配置放在面板配置目录时应在改动主机之前拒绝"

# 升级沿用 panel.env 记下的路径：v4.3.4 及更早原地迁移、配置所在目录已经归面板的主机照旧，不在升级时拒绝。
# An upgrade keeps the path panel.env records: hosts migrated in place by v4.3.4 and earlier, whose config directory is the
# panel's already, carry on as before and are not refused on upgrade.
config_directory_tree
mkdir -p "${root}/panel-etc"
printf 'KIXDNS_CONFIG=%s\n' "${root}/etc/foo.json" > "${root}/panel-etc/panel.env"
: > "${root}/panel-server"
chmod 0755 "${root}/panel-server"
output="$(config_directory_run)"
assert_contains "${output}" "PLANNED upgrade ${root}/etc/foo.json" "升级应沿用 panel.env 记下的配置路径"
assert_contains "${output}" "ReadWritePaths=${root}/etc /var/lib/kixdns-panel" "升级时旧主机的面板 unit 照旧"

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
  kixdns-commit panel-commit '' 42 fork
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
render_panel_environment "${WORK}/left-behind.env" "${WORK}/left-behind.out" kixdns-commit panel-commit '' 42 fork
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
  kixdns-commit panel-commit v1.0.0 42 fork
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
  'KIXDNS_INSTALLED_COMMIT=old-commit' \
  '# 完整安装包自带增强 Artifact 的 GitHub ID，由安装脚本填写。' \
  'KIXDNS_INSTALLED_SOURCE_ID=7' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' 42 fork
if grep -q 'KIXDNS_UPDATE_\|nightly\.link\|自动填写。$\|Action 提交\|增强 Artifact' "${environment_output}"; then
  printf '断言失败：升级应删掉不再读取的 Artifact 更新设置和旧说明\n' >&2
  exit 1
fi
identity_lines="$(grep '^KIXDNS_INSTALLED_\|^# 完整安装包' "${environment_output}")"
expected_identity="$(printf '%s\n' \
  '# 完整安装包自带内核的来源和提交，由安装脚本填写；不要手工修改。' \
  'KIXDNS_INSTALLED_SOURCE=fork' \
  'KIXDNS_INSTALLED_COMMIT=kixdns-commit' \
  '# 完整安装包自带内核包在 GitHub 上的编号，由安装脚本填写。' \
  'KIXDNS_INSTALLED_SOURCE_ID=42')"
assert_equals "${identity_lines}" "${expected_identity}" "完整包应在提交前记下内核来源，说明改成新的说法"
# 只更新面板、原来没记来源（旧 Action 内核）：不凭空写上来源。
# A panel-only update with no recorded source (an old Action kernel): no source is made up.
render_panel_environment "${environment_source}" "${environment_output}" \
  old-commit panel-commit '' 7 ''
if grep -q '^KIXDNS_INSTALLED_SOURCE=' "${environment_output}"; then
  printf '断言失败：没有来源记录时不应写出内核来源\n' >&2
  exit 1
fi
printf '%s\n' 'KIXDNS_INSTALLED_SOURCE=fork' 'KIXDNS_INSTALLED_COMMIT=old-commit' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  old-commit panel-commit '' 7 fork
assert_equals "$(grep -c '^KIXDNS_INSTALLED_SOURCE=fork$' "${environment_output}")" "1" \
  "已有的内核来源应原地保留一行"

printf '%s\n' 'KIXDNS_PANEL_BIND=192.168.10.5:6754' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' 42 fork
bind_value="$(awk -F= '$1 == "KIXDNS_PANEL_BIND" { print $2 }' "${environment_output}")"
assert_equals "${bind_value}" "192.168.10.5:6754" "用户自定义监听地址不应被升级覆盖"

printf '%s\n' 'KIXDNS_PANEL_INSTALLED_RELEASE=' > "${environment_source}"
render_panel_environment "${environment_source}" "${environment_output}" \
  kixdns-commit panel-commit '' 42 fork
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
    update_panel_environment kixdns-commit 42 fork
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
output="$(summary_of migrate true true true none false '')"
assert_contains "${output}" "KixDNS：已迁移为增强版，保持原来的运行状态（运行中）；原 unit 备份在 /var/lib/kixdns-panel/external-backup，卸载面板时可恢复" "迁移结果应说明状态与备份"
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
reclaim_backup="${WORK}/reclaim-backup"
rm -rf -- "${reclaim_backup}"
for reclaim_view in plan summary; do
  if [[ ${reclaim_view} == plan ]]; then
    output="$(EXTERNAL_BACKUP=${reclaim_backup} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)"
  else
    output="$(EXTERNAL_BACKUP=${reclaim_backup} summary_of reclaim true true true none false '')"
  fi
  assert_contains "${output}" "它是面板自己装的，这次不另做备份；以后卸载时选择移除 KixDNS，会把它删掉" "接回时应说明不备份、移除会删掉（${reclaim_view}）"
  assert_not_contains "${output}" "原 unit 备份在" "接回时不能说备份了原 unit（${reclaim_view}）"
  assert_not_contains "${output}" "迁移为增强版" "接回不是迁移（${reclaim_view}）"
done
assert_contains "${output}" "KixDNS：已接回上次卸载时保留的 KixDNS，保持原来的运行状态（运行中）" "接回的结果应说明保持运行状态"
assert_contains "$(EXTERNAL_BACKUP=${reclaim_backup} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)" \
  "检测到上次卸载时保留的 KixDNS（kixdns.service，运行中），接着由面板管理" "接回前应说明检测到了什么"
mkdir -p "${reclaim_backup}"
printf 'KIXDNS_BINARY=/usr/local/bin/kixdns\n' > "${reclaim_backup}/install.env"
for reclaim_view in plan summary; do
  if [[ ${reclaim_view} == plan ]]; then
    output="$(EXTERNAL_BACKUP=${reclaim_backup} EXISTING_KIXDNS_UNIT=true KIXDNS_WAS_ACTIVE=true print_reclaim_plan)"
  else
    output="$(EXTERNAL_BACKUP=${reclaim_backup} summary_of reclaim true true true none false '')"
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

printf '安装策略检查通过。\n'
