#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="tuoro/kixdns-panel"
readonly GITHUB_TOKEN_FILE="/var/lib/kixdns-panel/github-token"
VERSION=""
TEMP_DIRECTORY=""
GITHUB_API_CONFIG=""
INSTALLER_ARGUMENTS=()

fail() {
  printf '一键安装失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh | sudo bash

可选参数：
  --version TAG  安装指定正式版本，例如 v1.0.23；默认安装最新正式版
  --             后续参数原样传给安装器
  -h, --help     显示帮助

检测到现有 KixDNS 时，安装器会通过终端询问是仅安装面板，还是迁移到 KixDNS Enhanced。
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
      --)
        shift
        INSTALLER_ARGUMENTS=("$@")
        return
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
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "系统缺少命令 $1"
}

detect_architecture() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s\n' x86_64 ;;
    aarch64 | arm64) printf '%s\n' arm64 ;;
    *) fail "仅支持 Linux x86_64 和 ARM64" ;;
  esac
}

cleanup() {
  if [[ -n ${TEMP_DIRECTORY} && ${TEMP_DIRECTORY} == /var/tmp/kixdns-panel-one-click.* ]]; then
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

main() {
  local api_url
  local architecture
  local asset_digest
  local asset_name
  local asset_record
  local asset_url
  local archive
  local extract_directory
  local package_root
  local release_json
  local tag
  local -a package_roots
  local -a github_api_args=()

  parse_arguments "$@"
  [[ ${EUID} -eq 0 ]] || fail "请使用 sudo bash 运行一键安装命令"
  [[ -z ${VERSION} || ${VERSION} =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] ||
    fail "版本标签格式无效"
  require_command curl
  require_command jq
  require_command sha256sum
  require_command unzip

  TEMP_DIRECTORY="$(mktemp -d /var/tmp/kixdns-panel-one-click.XXXXXX)"
  trap cleanup EXIT
  prepare_github_api_config
  if [[ -n ${GITHUB_API_CONFIG} ]]; then
    github_api_args=(--config "${GITHUB_API_CONFIG}")
  fi

  architecture="$(detect_architecture)"
  asset_name="kixdns-panel-linux-${architecture}.zip"
  if [[ -n ${VERSION} ]]; then
    api_url="https://api.github.com/repos/${REPOSITORY}/releases/tags/${VERSION}"
  else
    api_url="https://api.github.com/repos/${REPOSITORY}/releases/latest"
  fi
  release_json="$(curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'User-Agent: kixdns-panel-one-click-installer' \
    "${github_api_args[@]}" \
    "${api_url}")" || fail "无法读取 GitHub Release 信息"
  tag="$(jq -er '.tag_name | select(type == "string")' <<< "${release_json}")" ||
    fail "Release 标签缺失"
  [[ ${tag} =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] ||
    fail "Release 标签格式无效"
  [[ -z ${VERSION} || ${tag} == "${VERSION}" ]] || fail "Release 标签与请求版本不一致"

  asset_record="$(jq -er --arg name "${asset_name}" '
    [.assets[] | select(.name == $name and .state == "uploaded")]
    | if length == 1 then .[0] else error("asset count") end
    | [.browser_download_url, .digest] | @tsv
  ' <<< "${release_json}")" || fail "Release 不包含当前架构安装包"
  IFS=$'\t' read -r asset_url asset_digest <<< "${asset_record}"
  [[ ${asset_url} == "https://github.com/${REPOSITORY}/releases/download/${tag}/${asset_name}" ]] ||
    fail "安装包下载地址不可信"
  [[ ${asset_digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "安装包缺少有效的 SHA-256 摘要"

  archive="${TEMP_DIRECTORY}/${asset_name}"
  extract_directory="${TEMP_DIRECTORY}/package"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 600 \
    --output "${archive}" "${asset_url}" || fail "下载安装包失败"
  printf '%s  %s\n' "${asset_digest#sha256:}" "${archive}" |
    sha256sum --check --strict --status || fail "安装包 SHA-256 校验失败"
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

  printf '准备安装 KixDNS Panel %s（%s）\n' "${tag}" "${architecture}"
  bash "${package_root}/scripts/install.sh" "${INSTALLER_ARGUMENTS[@]}"
}

main "$@"
