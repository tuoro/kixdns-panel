#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2016,SC2034
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ONE_CLICK="${PACKAGE_ROOT}/scripts/one-click-install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf -- "${WORK}"' EXIT

assert_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} == *"${needle}"* ]] || {
    printf '断言失败：%s（应包含 %s，实际：%s）\n' "${message}" "${needle}" "${haystack}" >&2
    exit 1
  }
}

assert_not_contains() {
  local haystack=$1
  local needle=$2
  local message=$3
  [[ ${haystack} != *"${needle}"* ]] || {
    printf '断言失败：%s（不应包含 %s，实际：%s）\n' "${message}" "${needle}" "${haystack}" >&2
    exit 1
  }
}

assert_equals() {
  local actual=$1
  local expected=$2
  local message=$3
  [[ ${actual} == "${expected}" ]] || {
    printf '断言失败：%s（期望 %s，实际 %s）\n' "${message}" "${expected}" "${actual}" >&2
    exit 1
  }
}

# 在子 shell 里运行必然失败的函数，返回它写到 stderr 的内容。
# Run a function that must fail in a subshell and hand back its stderr.
expect_failure() {
  local output
  if output="$( ("$@") 2>&1 >/dev/null)"; then
    printf '断言失败：%s 应当失败\n' "$*" >&2
    exit 1
  fi
  printf '%s' "${output}"
}

help="$(bash "${ONE_CLICK}" --help)"
assert_contains "${help}" "--version" "帮助应说明 --version"
assert_contains "${help}" "vX.Y.Z" "帮助示例不应写死版本号"
assert_contains "${help}" "--reinstall" "帮助应说明 --reinstall"
assert_contains "${help}" "bash -s -- --replace-existing" "帮助应说明安装器参数如何透传"
assert_not_contains "${help}" "--keep-existing" "帮助不应再提仅安装面板模式"
assert_not_contains "${help}" "仅安装面板" "帮助不应再提仅安装面板模式"

# source 时脚本末尾的守卫跳过 main，只加载函数；它自带的 set -Eeuo pipefail 正好也用于断言。
# Sourcing skips main via the guard at the end and only loads functions; its set -Eeuo pipefail suits the assertions.
source "${ONE_CLICK}"

# ---- 参数解析 / argument parsing ----
VERSION="" REINSTALL=false INSTALLER_ARGUMENTS=()
parse_arguments --version v3.1.0 --replace-existing -- --kixdns-unit dns.service --reinstall
assert_equals "${VERSION}" v3.1.0 "--version 应被一键安装器消费"
assert_equals "${REINSTALL}" true "写在 -- 之后的 --reinstall 也应被一键安装器消费"
assert_equals "${INSTALLER_ARGUMENTS[*]}" "--replace-existing --kixdns-unit dns.service" "其余参数应原样保留"

VERSION="" REINSTALL=false INSTALLER_ARGUMENTS=()
parse_arguments --reinstall
assert_equals "${REINSTALL}" true "--reinstall 应被识别"
assert_equals "${#INSTALLER_ARGUMENTS[@]}" 0 "--reinstall 不应进入安装器参数"

# ---- 版本标签 / version tag ----
message="$(VERSION=3.1.0 expect_failure validate_version_tag)"
assert_contains "${message}" "必须以 v 开头" "缺少 v 前缀时应说明原因"
assert_contains "${message}" "--version v3.1.0" "缺少 v 前缀时应给出改正后的写法"
message="$(VERSION=latest expect_failure validate_version_tag)"
assert_contains "${message}" "vX.Y.Z" "无法修正的标签应说明格式"
VERSION=v3.1.0 validate_version_tag

# ---- 缺少命令一次列全 / all missing commands at once ----
stub_bin="${WORK}/bin"
mkdir -p "${stub_bin}"
printf '#!/bin/sh\nexit 0\n' > "${stub_bin}/curl"
cp "${stub_bin}/curl" "${stub_bin}/unzip"
chmod +x "${stub_bin}/curl" "${stub_bin}/unzip"
message="$(PATH="${stub_bin}" expect_failure require_commands)"
assert_contains "${message}" "系统缺少命令：jq sha256sum。" "应一次列出全部缺少的命令"
assert_contains "${message}" "apt-get install -y jq coreutils" "应给出 Debian/Ubuntu 安装命令"
require_commands

# ---- GitHub API 失败解释 / API failure explanations ----
message="$(VERSION=v0.0.99 expect_failure explain_api_failure 404 https://api.example/x "")"
assert_contains "${message}" "找不到版本 v0.0.99" "指定版本 404 应说明版本不存在"
assert_contains "${message}" "https://github.com/tuoro/kixdns-panel/releases" "指定版本 404 应指向版本列表"
message="$(VERSION="" expect_failure explain_api_failure 404 https://api.example/x "")"
assert_contains "${message}" "还没有正式版" "最新版 404 应说明没有正式版"
for status in 403 429; do
  message="$(VERSION="" expect_failure explain_api_failure "${status}" https://api.example/x "")"
  assert_contains "${message}" "每小时 60 次" "HTTP ${status} 应解释匿名限额"
  assert_contains "${message}" "/var/lib/kixdns-panel/github-token" "HTTP ${status} 应给出 Token 位置"
  assert_contains "${message}" "docs/deployment.md" "HTTP ${status} 应给出手动安装出路"
done
# --retry 3 时 curl 会把同一错误写多遍。
# With --retry 3 curl writes the same error several times.
message="$(VERSION="" expect_failure explain_api_failure 000 https://api.example/x \
  $'curl: (6) Could not resolve host: api.github.com\ncurl: (6) Could not resolve host: api.github.com\r\n\n')"
assert_contains "${message}" "无法连接 GitHub：curl: (6) Could not resolve host: api.github.com。" "断网时应只带上一次 curl 的错误"
assert_equals "$(wc -l <<< "${message}")" 1 "断网提示应只占一行"
message="$(VERSION="" expect_failure explain_api_failure 502 https://api.example/x "")"
assert_contains "${message}" "HTTP 502（https://api.example/x）" "其它状态应带上状态码和地址"

# ---- 安装器参数识别 / installer flag discovery ----
write_installer() {
  local path=$1
  shift
  local label
  mkdir -p "$(dirname -- "${path}")"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'printf "%%s\\n" "$@" > "${RECORD_FILE}"\n'
    printf 'exit 0\n'
    printf 'parse_arguments() {\n  while [[ $# -gt 0 ]]; do\n    case "$1" in\n'
    for label in "$@"; do
      printf '      %s)\n        ;;\n' "${label}"
    done
    printf '      *) fail "未知参数：$1" ;;\n    esac\n    shift\n  done\n}\n'
  } > "${path}"
}
# v3.1.0 的参数集合；新安装包额外认识 --reinstall，并已去掉 --keep-existing。
# The v3.1.0 flag set; the newer package adds --reinstall and drops --keep-existing.
old_installer="${WORK}/old/install.sh"
new_installer="${WORK}/new/install.sh"
write_installer "${old_installer}" --keep-existing --replace-existing --kixdns-unit --kixdns-config \
  --kixdns-binary --control-socket --panel-only-update '-h | --help'
write_installer "${new_installer}" --replace-existing --kixdns-unit --kixdns-config \
  --kixdns-binary --control-socket --panel-only-update --reinstall '-h | --help'

old_flags="$(installer_flags "${old_installer}")"
assert_equals "$(tr '\n' ' ' <<< "${old_flags}")" \
  "--keep-existing --replace-existing --kixdns-unit --kixdns-config --kixdns-binary --control-socket --panel-only-update -h --help " \
  "应读出安装器 case 标签里的全部参数"
repo_flags="$(installer_flags "${PACKAGE_ROOT}/scripts/install.sh")"
# 一键安装器和安装包一起发布：仓库内 install.sh 的每个参数都必须能被读到，否则会被当成拼写错误挡掉。
# The one-click installer ships with the package: every flag in the repository install.sh must be
# discoverable, or it would be rejected as a typo.
for flag in --replace-existing --reinstall --panel-only-update --kixdns-unit --kixdns-config \
  --kixdns-binary --control-socket -h --help; do
  installer_supports_flag "${repo_flags}" "${flag}" || {
    printf '断言失败：应从仓库内 install.sh 读出 %s；安装器参数解析写法变了吗？\n' "${flag}" >&2
    exit 1
  }
done

REINSTALL=false INSTALLER_ARGUMENTS=(--no-such-flag)
message="$(expect_failure build_installer_arguments "${old_installer}" v3.1.0)"
assert_contains "${message}" "v3.1.0 的安装器不认识参数 --no-such-flag" "未知参数应在运行安装器前被拒绝"

REINSTALL=false INSTALLER_ARGUMENTS=(--replace-existing --kixdns-unit dns.service --panel-only-update)
build_installer_arguments "${old_installer}" v3.1.0
assert_equals "${FINAL_INSTALLER_ARGUMENTS[*]}" "--replace-existing --kixdns-unit dns.service --panel-only-update" \
  "已知参数和它们的取值应原样透传"

REINSTALL=false INSTALLER_ARGUMENTS=(--keep-existing)
build_installer_arguments "${new_installer}" v3.1.1
assert_equals "${FINAL_INSTALLER_ARGUMENTS[*]}" "--keep-existing" "--keep-existing 应交给安装包自己说明已移除"

REINSTALL=true INSTALLER_ARGUMENTS=()
build_installer_arguments "${old_installer}" v3.1.0
assert_equals "${#FINAL_INSTALLER_ARGUMENTS[@]}" 0 "旧安装包不认识 --reinstall，不应转交"
build_installer_arguments "${new_installer}" v3.1.1
assert_equals "${FINAL_INSTALLER_ARGUMENTS[*]}" "--reinstall" "新安装包认识 --reinstall，应转交"

# ---- 同版本短路判断 / same-version short-circuit decision ----
PANEL_ENV="${WORK}/panel.env"
PANEL_SERVER="${WORK}/kixdns-panel-server"
printf '#!/bin/sh\n' > "${PANEL_SERVER}"
chmod +x "${PANEL_SERVER}"
printf 'KIXDNS_MANAGEMENT_ENABLED=true\nKIXDNS_PANEL_INSTALLED_RELEASE=v3.1.0\n' > "${PANEL_ENV}"
REINSTALL=false INSTALLER_ARGUMENTS=()
already_installed v3.1.0 || { printf '断言失败：同版本应判定为已安装\n' >&2; exit 1; }
if already_installed v3.1.1; then printf '断言失败：不同版本不应短路\n' >&2; exit 1; fi
if REINSTALL=true already_installed v3.1.0; then printf '断言失败：--reinstall 不应短路\n' >&2; exit 1; fi
INSTALLER_ARGUMENTS=(--help)
if already_installed v3.1.0; then printf '断言失败：查看安装器帮助不应短路\n' >&2; exit 1; fi
INSTALLER_ARGUMENTS=()
printf 'KIXDNS_MANAGEMENT_ENABLED=false\nKIXDNS_PANEL_INSTALLED_RELEASE=v3.1.0\n' > "${PANEL_ENV}"
if already_installed v3.1.0; then printf '断言失败：旧仅安装面板主机应交给安装包处理\n' >&2; exit 1; fi
printf 'KIXDNS_MANAGEMENT_ENABLED=true\nKIXDNS_PANEL_INSTALLED_RELEASE=v3.1.0\n' > "${PANEL_ENV}"
mv "${PANEL_SERVER}" "${PANEL_SERVER}.gone"
if already_installed v3.1.0; then printf '断言失败：卸载后残留的 panel.env 不应算已安装\n' >&2; exit 1; fi
mv "${PANEL_SERVER}.gone" "${PANEL_SERVER}"

# ---- 端到端（桩 curl） / end to end with a stubbed curl ----
architecture="$(detect_architecture)"
asset="kixdns-panel-linux-${architecture}.zip"
package_source="${WORK}/package-source"
write_installer "${package_source}/kixdns-panel-linux-${architecture}/scripts/install.sh" \
  --keep-existing --replace-existing --kixdns-unit --kixdns-config --kixdns-binary \
  --control-socket --panel-only-update '-h | --help'
python3 - "${package_source}" "${WORK}/${asset}" <<'PY'
import os, sys, zipfile
source, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, "w") as archive:
    for root, _, files in os.walk(source):
        for name in files:
            path = os.path.join(root, name)
            archive.write(path, os.path.relpath(path, source))
PY
digest="$(sha256sum "${WORK}/${asset}" | awk '{ print $1 }')"
STUB_RELEASE="${WORK}/release.json"
jq -n --arg tag v3.1.0 --arg asset "${asset}" --arg digest "sha256:${digest}" '{
  tag_name: $tag,
  assets: [{
    name: $asset, state: "uploaded", size: 40265318, digest: $digest,
    browser_download_url: ("https://github.com/tuoro/kixdns-panel/releases/download/" + $tag + "/" + $asset)
  }]
}' > "${STUB_RELEASE}"
STUB_CALLS="${WORK}/curl-calls"
STUB_ARCHIVE="${WORK}/${asset}"

STUB_ARGV="${WORK}/curl-argv"
# 桩 curl 写在单独文件里，终端下的进度条检查要在 script 分配的伪终端中另起 bash 加载它。
# The curl stub lives in its own file so the terminal progress check can load it in a bash started under script's pty.
cat > "${WORK}/curl-stub.sh" <<'STUB'
# shellcheck disable=SC2317,SC2329
curl() {
  local output=""
  local url="${*: -1}"
  local write_out=""
  printf '%s\n' "$*" >> "${STUB_ARGV}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output=$2; shift ;;
      --write-out) write_out=$2; shift ;;
    esac
    shift
  done
  printf '%s\n' "${url}" >> "${STUB_CALLS}"
  if [[ ${url} == https://api.github.com/* ]]; then
    cp -- "${STUB_RELEASE}" "${output}"
    [[ -z ${write_out} ]] || printf '200'
  else
    cp -- "${STUB_ARCHIVE}" "${output}"
  fi
}
STUB
source "${WORK}/curl-stub.sh"
# 面板是否在运行由桩 systemctl 决定，并记下查询了哪个 unit。
# The stubbed systemctl decides whether the panel runs and records which unit was queried.
STUB_PANEL_ACTIVE=true
SYSTEMCTL_CALLS="${WORK}/systemctl-calls"
systemctl() {
  printf '%s\n' "$*" >> "${SYSTEMCTL_CALLS}"
  [[ $* == "is-active --quiet kixdns-panel.service" && ${STUB_PANEL_ACTIVE} == true ]]
}
require_root() { :; }
TEMP_PARENT="${WORK}"
export RECORD_FILE="${WORK}/installer-arguments"

run_main() {
  rm -f -- "${STUB_CALLS}" "${STUB_ARGV}" "${SYSTEMCTL_CALLS}" "${RECORD_FILE}"
  VERSION="" REINSTALL=false INSTALLER_ARGUMENTS=() FINAL_INSTALLER_ARGUMENTS=()
  (main "$@") 2>&1
}

rm -f -- "${PANEL_ENV}"
output="$(run_main -- --replace-existing)"
assert_contains "${output}" "正在读取最新正式版信息…" "应先提示读取 Release"
assert_contains "${output}" "正在下载 ${asset}（38.4 MB）…" "应在下载前提示文件名和大小"
assert_contains "${output}" "校验通过。" "校验后应提示"
assert_contains "${output}" "准备安装 KixDNS Panel v3.1.0（${architecture}）" "应保留准备安装提示"
assert_equals "$(tr '\n' ' ' < "${RECORD_FILE}")" "--replace-existing " "安装器应收到透传参数"
# 命令替换里 stderr 不是终端：下载不应输出进度条。
# stderr is not a terminal inside command substitution, so the download must stay silent.
download_argv="$(grep -F -- "/releases/download/" "${STUB_ARGV}")"
assert_contains " ${download_argv} " " --silent " "非终端下载应使用 --silent"
assert_not_contains "${download_argv}" "--progress-bar" "非终端下载不应显示进度条"

printf 'KIXDNS_MANAGEMENT_ENABLED=true\nKIXDNS_PANEL_INSTALLED_RELEASE=v3.1.0\n' > "${PANEL_ENV}"
output="$(run_main)"
assert_contains "${output}" "已安装 KixDNS Panel v3.1.0，无需重复安装" "同版本应短路"
assert_contains "${output}" "bash -s -- --reinstall" "短路提示应给出修复性重装命令"
assert_equals "$(wc -l < "${STUB_CALLS}")" 1 "同版本短路不应下载安装包"
[[ ! -e ${RECORD_FILE} ]] || { printf '断言失败：同版本短路不应运行安装器\n' >&2; exit 1; }
assert_equals "$(cat -- "${SYSTEMCTL_CALLS}")" "is-active --quiet kixdns-panel.service" "短路前应确认面板服务在运行"

# 同版本但面板没在运行：不能短路，要提示并转为修复性重装。
# Same release but the panel is not running: do not skip; say so and repair.
STUB_PANEL_ACTIVE=false
output="$(run_main)"
assert_contains "${output}" "已安装 KixDNS Panel v3.1.0，但面板未在运行，将进行修复性重装" "面板未运行时应说明将修复"
assert_not_contains "${output}" "无需重复安装" "面板未运行时不应短路"
assert_equals "$(wc -l < "${STUB_CALLS}")" 2 "面板未运行时应下载安装包"
assert_contains "${output}" "准备安装 KixDNS Panel v3.1.0" "面板未运行时应继续安装"
assert_equals "$(wc -c < "${RECORD_FILE}")" 1 "旧安装包不认识 --reinstall，修复时也不应转交"
STUB_PANEL_ACTIVE=true

output="$(run_main --version v3.1.0 --reinstall)"
assert_contains "${output}" "正在读取版本 v3.1.0 信息…" "指定版本时应提示版本号"
assert_contains "${output}" "准备安装 KixDNS Panel v3.1.0" "--reinstall 应继续安装"
assert_equals "$(wc -c < "${RECORD_FILE}")" 1 "旧安装包不应收到 --reinstall"

rm -f -- "${PANEL_ENV}"
if output="$(run_main --no-such-flag)"; then
  printf '断言失败：未知安装器参数应失败\n' >&2
  exit 1
fi
assert_contains "${output}" "不认识参数 --no-such-flag" "未知参数应说明是哪个参数"
[[ ! -e ${RECORD_FILE} ]] || { printf '断言失败：未知参数不应运行安装器\n' >&2; exit 1; }

printf 'not the release archive\n' > "${WORK}/tampered.zip"
STUB_ARCHIVE="${WORK}/tampered.zip"
if output="$(run_main)"; then
  printf '断言失败：摘要不一致时应失败\n' >&2
  exit 1
fi
assert_contains "${output}" "请不要安装" "摘要不一致时应明确不要安装"
[[ ! -e ${RECORD_FILE} ]] || { printf '断言失败：摘要不一致不应运行安装器\n' >&2; exit 1; }
STUB_ARCHIVE="${WORK}/${asset}"

# ---- 终端下显示进度条 / progress bar on a terminal ----
# script 给子进程分配伪终端，stderr 因而是终端；--version 一行确认桩确实跑过。
# script gives the child a pty so stderr is a terminal; the argv file proves the stub actually ran.
rm -f -- "${STUB_ARGV}"
cat > "${WORK}/tty-download.sh" <<EOF
source "${ONE_CLICK}"
source "${WORK}/curl-stub.sh"
download_archive "https://github.com/tuoro/kixdns-panel/releases/download/v3.1.0/${asset}" "${WORK}/tty.zip"
EOF
STUB_ARGV="${STUB_ARGV}" STUB_CALLS="${STUB_CALLS}" STUB_RELEASE="${STUB_RELEASE}" STUB_ARCHIVE="${STUB_ARCHIVE}" \
  script -qec "bash ${WORK}/tty-download.sh" /dev/null > "${WORK}/tty-output" </dev/null
[[ -s ${STUB_ARGV} ]] || { printf '断言失败：伪终端里的下载没有调用 curl（输出：%s）\n' "$(cat -- "${WORK}/tty-output")" >&2; exit 1; }
download_argv="$(cat -- "${STUB_ARGV}")"
assert_contains "${download_argv}" "--progress-bar" "终端下载应显示进度条"
assert_not_contains " ${download_argv} " " --silent " "终端下载不应使用 --silent"

printf '一键安装策略检查通过。\n'
