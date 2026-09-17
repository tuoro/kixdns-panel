#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="tuoro/kixdns-panel"
readonly GITHUB_TOKEN_FILE="/var/lib/kixdns-panel/github-token"
readonly ONE_CLICK_URL="https://raw.githubusercontent.com/${REPOSITORY}/main/scripts/one-click-install.sh"
readonly RELEASES_URL="https://github.com/${REPOSITORY}/releases"
readonly TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'
# 测试会改写这些路径；它们不是 readonly，以便策略测试在沙箱中运行。
# Tests rewrite these paths, so they are not readonly and the policy test can run sandboxed.
PANEL_ENV="/etc/kixdns-panel/panel.env"
PANEL_SERVER="/usr/local/bin/kixdns-panel-server"
TEMP_PARENT="/var/tmp"
VERSION=""
REINSTALL=false
TEMP_DIRECTORY=""
GITHUB_API_CONFIG=""
INSTALLER_ARGUMENTS=()
FINAL_INSTALLER_ARGUMENTS=()

fail() {
  printf '一键安装失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
用法：curl -fsSL ${ONE_CLICK_URL} | sudo bash

带参数时：curl -fsSL ${ONE_CLICK_URL} | sudo bash -s -- [参数]

可选参数：
  --version TAG  安装指定正式版本，例如 vX.Y.Z；默认安装最新正式版
  --reinstall    已安装同一版本时仍重新安装，用于修复
  -h, --help     显示帮助

其余参数原样传给安装包内的安装器。主机上已有 KixDNS 时，无人值守安装需要
显式迁移：curl -fsSL ${ONE_CLICK_URL} | sudo bash -s -- --replace-existing
EOF
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        [[ $# -ge 2 ]] || fail "$1 缺少版本标签"
        VERSION=$2
        shift 2
        ;;
      --reinstall)
        REINSTALL=true
        shift
        ;;
      --)
        shift
        INSTALLER_ARGUMENTS+=("$@")
        break
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        INSTALLER_ARGUMENTS+=("$1")
        shift
        ;;
    esac
  done
  # --reinstall 写在 -- 之后也归一键安装器处理：旧安装包不认识它，是否转交要看安装包。
  # --reinstall after -- is still ours: old packages reject it, so forwarding depends on the package.
  local argument
  local -a remaining=()
  for argument in "${INSTALLER_ARGUMENTS[@]}"; do
    if [[ ${argument} == --reinstall ]]; then
      REINSTALL=true
    else
      remaining+=("${argument}")
    fi
  done
  INSTALLER_ARGUMENTS=("${remaining[@]}")
}

validate_version_tag() {
  [[ -z ${VERSION} || ${VERSION} =~ ${TAG_PATTERN} ]] && return 0
  if [[ v${VERSION} =~ ${TAG_PATTERN} ]]; then
    fail "版本标签必须以 v 开头，请改用 --version v${VERSION}"
  fi
  fail "版本标签 ${VERSION} 格式无效，应形如 vX.Y.Z；可用版本见 ${RELEASES_URL}"
}

require_root() {
  [[ ${EUID} -eq 0 ]] || fail "请使用 sudo bash 运行一键安装命令"
}

require_commands() {
  local command_name
  local -a missing=()
  local -a packages=()
  for command_name in curl jq sha256sum unzip; do
    command -v "${command_name}" >/dev/null 2>&1 && continue
    missing+=("${command_name}")
    # sha256sum 属于 coreutils，apt 里没有同名包。
    # sha256sum ships in coreutils; apt has no package by that name.
    if [[ ${command_name} == sha256sum ]]; then
      packages+=(coreutils)
    else
      packages+=("${command_name}")
    fi
  done
  ((${#missing[@]} == 0)) && return 0
  fail "系统缺少命令：${missing[*]}。Debian/Ubuntu 可先运行 apt-get update && apt-get install -y ${packages[*]}，然后重新执行一键安装命令"
}

detect_architecture() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s\n' x86_64 ;;
    aarch64 | arm64) printf '%s\n' arm64 ;;
    *) fail "仅支持 Linux x86_64 和 ARM64" ;;
  esac
}

cleanup() {
  if [[ -n ${TEMP_DIRECTORY} && ${TEMP_DIRECTORY} == "${TEMP_PARENT}"/kixdns-panel-one-click.* ]]; then
    rm -rf -- "${TEMP_DIRECTORY}"
  fi
}

prepare_github_api_config() {
  local mode
  local token
  [[ -e ${GITHUB_TOKEN_FILE} ]] || return 0
  [[ -f ${GITHUB_TOKEN_FILE} && ! -L ${GITHUB_TOKEN_FILE} ]] || fail "GitHub Token 文件不安全"
  mode="$(stat -c '%a' -- "${GITHUB_TOKEN_FILE}")"
  [[ ${mode} =~ ^[0-7]{3,4}$ ]] || fail "GitHub Token 文件权限无效"
  (((8#${mode} & 8#077) == 0)) || fail "GitHub Token 文件权限必须为 0600"
  [[ $(stat -c '%s' -- "${GITHUB_TOKEN_FILE}") -le 257 ]] || fail "GitHub Token 文件过大"
  token="$(<"${GITHUB_TOKEN_FILE}")"
  [[ ${token} =~ ^(github_pat_|gh[pousr]_)[A-Za-z0-9_-]+$ ]] || fail "GitHub Token 格式无效"
  GITHUB_API_CONFIG="${TEMP_DIRECTORY}/github-api.conf"
  (umask 077; printf 'header = "Authorization: Bearer %s"\n' "${token}" > "${GITHUB_API_CONFIG}")
  unset token
}

# 只凭 HTTP 状态码区分“版本不存在”“限流”“断网”，用户才知道下一步该做什么。
# Branch on the HTTP status so users can tell a missing tag, a rate limit and a dead network apart.
explain_api_failure() {
  local status=$1
  local api_url=$2
  local curl_error=$3
  case "${status}" in
    404)
      if [[ -n ${VERSION} ]]; then
        fail "找不到版本 ${VERSION}，可用版本见 ${RELEASES_URL}"
      fi
      fail "仓库还没有正式版，请到 ${RELEASES_URL} 查看"
      ;;
    403 | 429)
      fail "GitHub API 拒绝了请求（HTTP ${status}），通常是匿名访问超出限额：每个出口 IP 每小时 60 次。可稍后重试；或把 GitHub Token 写入 ${GITHUB_TOKEN_FILE}（权限 0600）后重试；或按 docs/deployment.md 的「手动安装」下载安装包"
      ;;
    000)
      # --retry 每次重试都会写一行同样的错误，只留最后一行。
      # --retry writes the same error once per attempt; keep only the last line.
      curl_error="$(tr -d '\r' <<< "${curl_error}" | awk 'NF { line = $0 } END { print line }')"
      fail "无法连接 GitHub：${curl_error:-未知网络错误}。请检查网络和 DNS 后重试"
      ;;
    *)
      fail "读取 Release 信息失败：HTTP ${status}（${api_url}），请稍后重试"
      ;;
  esac
}

fetch_release_json() {
  local api_url=$1
  local body_file="${TEMP_DIRECTORY}/release.json"
  local error_file="${TEMP_DIRECTORY}/release.err"
  local status
  local -a github_api_args=()
  if [[ -n ${GITHUB_API_CONFIG} ]]; then
    github_api_args=(--config "${GITHUB_API_CONFIG}")
  fi
  # 不用 --fail：要拿到 4xx 的状态码才能解释原因。
  # No --fail: the 4xx status is what lets us explain the failure.
  status="$(curl --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'User-Agent: kixdns-panel-one-click-installer' \
    "${github_api_args[@]}" \
    --output "${body_file}" --write-out '%{http_code}' \
    "${api_url}" 2>"${error_file}")" || true
  [[ ${status} =~ ^[0-9]{3}$ ]] || status=000
  if [[ ${status} != 200 ]]; then
    explain_api_failure "${status}" "${api_url}" "$(cat -- "${error_file}" 2>/dev/null || true)"
  fi
  cat -- "${body_file}"
}

panel_env_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

# 同版本重跑时在下载前结束，省下整包下载，也不打扰正在运行的 KixDNS。
# Stop a same-version re-run before the download: saves the transfer and leaves KixDNS alone.
already_installed() {
  local tag=$1
  local argument
  [[ ${REINSTALL} == false ]] || return 1
  [[ -x ${PANEL_SERVER} ]] || return 1
  [[ $(panel_env_value KIXDNS_PANEL_INSTALLED_RELEASE || true) == "${tag}" ]] || return 1
  # 旧「仅安装面板」主机的面板从未跑起来，交给安装包给出迁移指引。
  # Legacy panel-only hosts never ran; let the package print the migration guidance.
  [[ $(panel_env_value KIXDNS_MANAGEMENT_ENABLED || true) != false ]] || return 1
  for argument in "${INSTALLER_ARGUMENTS[@]}"; do
    [[ ${argument} != -h && ${argument} != --help ]] || return 1
  done
  return 0
}

print_already_installed() {
  local tag=$1
  local hint="--reinstall"
  [[ -z ${VERSION} ]] || hint="--version ${VERSION} --reinstall"
  printf '已安装 KixDNS Panel %s，无需重复安装；如需修复性重装：curl -fsSL %s | sudo bash -s -- %s\n' \
    "${tag}" "${ONE_CLICK_URL}" "${hint}"
}

# 读安装器 parse_arguments 里的 case 标签，判断这个版本认不认识某个参数。
# 所有发布过的 install.sh 都用这种写法，也覆盖 --panel-only-update 这类不写进帮助的参数。
# Read the case labels in the installer's parse_arguments to learn which flags that package knows.
# Every released install.sh uses this shape, and it also covers hidden flags like --panel-only-update.
installer_flags() {
  local installer=$1
  awk '
    /^parse_arguments\(\) *\{/ { inside = 1; next }
    inside && /^}/ { exit }
    inside && /^[[:space:]]*-[-A-Za-z0-9 |]*\)/ {
      label = $0
      sub(/\).*/, "", label)
      count = split(label, parts, "|")
      for (i = 1; i <= count; i++) {
        gsub(/[[:space:]]/, "", parts[i])
        if (parts[i] != "") print parts[i]
      }
    }
  ' "${installer}"
}

installer_supports_flag() {
  local flag=$2
  grep -qxF -- "${flag}" <<< "$1"
}

# 下载后、运行安装器前检查参数，这样拼错的参数不会碰到主机，新版本加的参数也不会被一键安装器挡住。
# Check flags after download but before the installer runs: typos never touch the host,
# and flags added by newer packages are not blocked by this script.
build_installer_arguments() {
  local installer=$1
  local tag=$2
  local argument
  local known
  known="$(installer_flags "${installer}")"
  FINAL_INSTALLER_ARGUMENTS=()
  for argument in "${INSTALLER_ARGUMENTS[@]}"; do
    if [[ -n ${known} && ${argument} == -* ]] &&
      [[ ${argument} != --keep-existing ]] &&
      ! installer_supports_flag "${known}" "${argument}"; then
      # --keep-existing 总是原样转交：新安装包会自己说明该模式已移除以及如何迁移。
      # --keep-existing always passes through: newer packages explain its removal themselves.
      fail "KixDNS Panel ${tag} 的安装器不认识参数 ${argument}，未改动系统。请检查拼写，或用 --version 选择支持该参数的版本"
    fi
    FINAL_INSTALLER_ARGUMENTS+=("${argument}")
  done
  if [[ ${REINSTALL} == true ]] && installer_supports_flag "${known}" --reinstall; then
    FINAL_INSTALLER_ARGUMENTS+=(--reinstall)
  fi
}

validate_archive_entries() {
  local archive=$1
  local entry
  while IFS= read -r entry; do
    [[ -n ${entry} ]] || continue
    case "${entry}" in
      /* | ../* | */../* | */..) fail "安装包包含越界路径" ;;
    esac
    [[ ${entry} != *\\* ]] || fail "安装包包含非标准路径分隔符"
  done < <(unzip -Z1 "${archive}")
}

download_archive() {
  local asset_url=$1
  local archive=$2
  local progress=--silent
  # 进度条只给终端看；systemd 日志和管道输出保持干净。
  # The progress bar is for terminals only; journald and piped logs stay clean.
  [[ -t 2 ]] && progress=--progress-bar
  curl --fail "${progress}" --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 600 \
    --output "${archive}" "${asset_url}" ||
    fail "下载安装包失败，未改动系统。请检查网络后重新运行一键安装命令"
}

main() {
  local api_url
  local architecture
  local asset_digest
  local asset_name
  local asset_record
  local asset_size
  local asset_url
  local archive
  local extract_directory
  local package_root
  local release_json
  local tag
  local -a package_roots

  parse_arguments "$@"
  validate_version_tag
  require_root
  require_commands

  TEMP_DIRECTORY="$(mktemp -d "${TEMP_PARENT}/kixdns-panel-one-click.XXXXXX")"
  trap cleanup EXIT
  prepare_github_api_config

  architecture="$(detect_architecture)"
  asset_name="kixdns-panel-linux-${architecture}.zip"
  if [[ -n ${VERSION} ]]; then
    api_url="https://api.github.com/repos/${REPOSITORY}/releases/tags/${VERSION}"
    printf '正在读取版本 %s 信息…\n' "${VERSION}"
  else
    api_url="https://api.github.com/repos/${REPOSITORY}/releases/latest"
    printf '正在读取最新正式版信息…\n'
  fi
  release_json="$(fetch_release_json "${api_url}")"
  tag="$(jq -er '.tag_name | select(type == "string")' <<< "${release_json}")" ||
    fail "Release 标签缺失"
  [[ ${tag} =~ ${TAG_PATTERN} ]] || fail "Release 标签格式无效"
  [[ -z ${VERSION} || ${tag} == "${VERSION}" ]] || fail "Release 标签与请求版本不一致"

  if already_installed "${tag}"; then
    print_already_installed "${tag}"
    return 0
  fi

  asset_record="$(jq -er --arg name "${asset_name}" '
    [.assets[] | select(.name == $name and .state == "uploaded")]
    | if length == 1 then .[0] else error("asset count") end
    | [.browser_download_url, .digest, .size] | @tsv
  ' <<< "${release_json}")" || fail "Release 不包含当前架构安装包"
  IFS=$'\t' read -r asset_url asset_digest asset_size <<< "${asset_record}"
  [[ ${asset_url} == "https://github.com/${REPOSITORY}/releases/download/${tag}/${asset_name}" ]] ||
    fail "安装包下载地址不可信"
  [[ ${asset_digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "安装包缺少有效的 SHA-256 摘要"
  [[ ${asset_size} =~ ^[0-9]+$ ]] || fail "Release 安装包大小无效"

  archive="${TEMP_DIRECTORY}/${asset_name}"
  extract_directory="${TEMP_DIRECTORY}/package"
  printf '正在下载 %s（%s MB）…\n' "${asset_name}" \
    "$(awk -v bytes="${asset_size}" 'BEGIN { printf "%.1f", bytes / 1048576 }')"
  download_archive "${asset_url}" "${archive}"
  printf '%s  %s\n' "${asset_digest#sha256:}" "${archive}" |
    sha256sum --check --strict --status ||
    fail "安装包 SHA-256 与 GitHub 公布的摘要不一致，已丢弃且未改动系统。请重试一次；仍不一致请不要安装，并到 https://github.com/${REPOSITORY}/issues 报告"
  validate_archive_entries "${archive}"
  install -d -m 0700 "${extract_directory}"
  unzip -q "${archive}" -d "${extract_directory}"
  mapfile -t package_roots < <(
    find "${extract_directory}" -mindepth 1 -maxdepth 1 -type d \
      -name "kixdns-panel-linux-${architecture}" -print
  )
  ((${#package_roots[@]} == 1)) || fail "安装包目录结构无效"
  package_root=${package_roots[0]}
  [[ -f ${package_root}/scripts/install.sh ]] || fail "安装包缺少安装器"
  printf '校验通过。\n'

  build_installer_arguments "${package_root}/scripts/install.sh" "${tag}"
  printf '准备安装 KixDNS Panel %s（%s）\n' "${tag}" "${architecture}"
  bash "${package_root}/scripts/install.sh" "${FINAL_INSTALLER_ARGUMENTS[@]}"
}

# 通过管道运行时 BASH_SOURCE 为空；只有策略测试 source 本文件时才跳过 main。
# BASH_SOURCE is empty when piped; main is skipped only when the policy test sources this file.
if [[ ${#BASH_SOURCE[@]} -eq 0 || ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
