#!/usr/bin/env bash
# 从内核仓库的 GitHub Release 取一个版本给完整安装包：发布清单、GitHub 记下的资源、包内
# SHA256SUMS 和来源说明一一对上之后，写出二进制和完整包要带的身份文件。
# Fetches one version from the kernel repository's GitHub Releases for the full package:
# once the release manifest, the assets GitHub lists, the package's SHA256SUMS and its
# source note all agree, writes the binary and the identity files the full package carries.
set -Eeuo pipefail

fail() {
  printf '获取 KixDNS 内核发布失败：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null || fail "缺少命令 $1"
}

usage() {
  printf '用法：%s <仓库> <版本|latest> <x86_64|arm64> <输出目录>\n' "$0" >&2
  exit 2
}

# 日期版本：YYYY.MM.DD，同一天再发布时是 YYYY.MM.DD.N（N 从 2 起，不补零）。
# A date version: YYYY.MM.DD, or YYYY.MM.DD.N (N from 2, no leading zero) for a later release the same day.
valid_version() {
  [[ $1 =~ ^[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])(\.([2-9]|[1-9][0-9]+))?$ ]]
}

elf_machine() {
  LC_ALL=C readelf -h -- "$1" | awk -F: '/Machine:/ { sub(/^[[:space:]]+/, "", $2); print $2 }'
}

main() {
  [[ $# -eq 4 ]] || usage
  local repository=$1
  local version=$2
  local architecture=$3
  local output=$4
  local work release name asset asset_id asset_size asset_digest manifest expected_sha256
  local expected_size package entries checksum_names source capabilities machine

  for command in gh jq sha256sum unzip readelf stat; do
    require_command "${command}"
  done
  [[ ${repository} =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ && ${repository} != *..* ]] ||
    fail "仓库名称无效：${repository}"
  case ${architecture} in
    x86_64) machine='Advanced Micro Devices X86-64' ;;
    arm64) machine='AArch64' ;;
    *) fail "架构无效：${architecture}" ;;
  esac
  if [[ ${version} == latest ]]; then
    version="$(gh api "repos/${repository}/releases/latest" --jq .tag_name)"
  fi
  valid_version "${version}" || fail "版本号无效：${version}"

  release="$(gh api "repos/${repository}/releases/tags/${version}")"
  jq -e '.draft == false and .prerelease == false' <<< "${release}" >/dev/null ||
    fail "${version} 不是正式发布"
  name="kixdns-${version}-linux-${architecture}.zip"
  asset="$(jq -c --arg name "${name}" \
    '[.assets[] | select(.name == $name)] | if length == 1 then .[0] else empty end' <<< "${release}")"
  [[ -n ${asset} ]] || fail "${version} 缺少 ${name}"
  jq -e '[.assets[] | select(.name == "manifest.json")] | length == 1' <<< "${release}" >/dev/null ||
    fail "${version} 缺少发布清单"
  asset_id="$(jq -r .id <<< "${asset}")"
  asset_size="$(jq -r .size <<< "${asset}")"
  asset_digest="$(jq -r '.digest // ""' <<< "${asset}")"
  [[ ${asset_id} =~ ^[1-9][0-9]*$ ]] || fail "内核包编号无效"

  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # 在这里展开：退出时 work 已经离开作用域 / Expand now: work is out of scope at exit
  trap "rm -rf -- '${work}'" EXIT
  gh release download "${version}" --repo "${repository}" \
    --pattern manifest.json --pattern "${name}" --dir "${work}/download"
  manifest="${work}/download/manifest.json"
  package="${work}/download/${name}"

  jq -e --arg repository "${repository}" --arg version "${version}" \
    --arg architecture "${architecture}" --arg name "${name}" '
      .schema_version == 1
      and .repository == $repository
      and .version == $version
      and (.commit | test("^[0-9a-f]{40}$"))
      and ((.upstream_commit // "") | test("^([0-9a-f]{40})?$"))
      and .control_protocol == 1
      and (.config_capabilities | type == "array")
      and .assets[$architecture].name == $name
      and (.assets[$architecture].sha256 | test("^[0-9a-f]{64}$"))
      and (.assets[$architecture].size | type == "number" and . > 0)
    ' "${manifest}" >/dev/null || fail "发布清单和 ${version} 对不上"
  expected_sha256="$(jq -r --arg architecture "${architecture}" '.assets[$architecture].sha256' "${manifest}")"
  expected_size="$(jq -r --arg architecture "${architecture}" '.assets[$architecture].size' "${manifest}")"
  [[ $(sha256sum -- "${package}" | awk '{ print $1 }') == "${expected_sha256}" ]] ||
    fail "${name} 的校验值和发布清单对不上"
  [[ $(stat -c %s -- "${package}") == "${expected_size}" && ${asset_size} == "${expected_size}" ]] ||
    fail "${name} 的大小和发布清单对不上"
  if [[ -n ${asset_digest} ]]; then
    [[ ${asset_digest} == "sha256:${expected_sha256}" ]] || fail "GitHub 记下的 ${name} 校验值和发布清单对不上"
  fi

  # 包里只该有这四个文件，SHA256SUMS 正好列出另外三个。
  # The package holds exactly these four files, and SHA256SUMS lists exactly the other three.
  entries="$(unzip -Z1 -- "${package}" | LC_ALL=C sort)"
  [[ ${entries} == $'KIXDNS_CAPABILITIES.json\nKIXDNS_SOURCE.json\nSHA256SUMS\nkixdns' ]] ||
    fail "${name} 里的文件和预期不一致"
  unzip -q -- "${package}" -d "${work}/package"
  checksum_names="$(awk '{ sub(/^\*/, "", $2); print $2 }' "${work}/package/SHA256SUMS" | LC_ALL=C sort)"
  [[ ${checksum_names} == $'KIXDNS_CAPABILITIES.json\nKIXDNS_SOURCE.json\nkixdns' ]] ||
    fail "${name} 的 SHA256SUMS 列出的文件不对"
  (cd "${work}/package" && sha256sum --check --quiet --strict SHA256SUMS) ||
    fail "${name} 里的文件和 SHA256SUMS 对不上"

  source="${work}/package/KIXDNS_SOURCE.json"
  capabilities="${work}/package/KIXDNS_CAPABILITIES.json"
  jq -e --slurpfile manifest "${manifest}" --arg architecture "${architecture}" '
      .schema_version == 1
      and .repository == $manifest[0].repository
      and .version == $manifest[0].version
      and .commit == $manifest[0].commit
      and (.upstream_commit // null) == ($manifest[0].upstream_commit // null)
      and .arch == $architecture
      and .control_protocol == $manifest[0].control_protocol
    ' "${source}" >/dev/null || fail "${name} 的来源说明和发布清单对不上"
  jq -e --slurpfile manifest "${manifest}" '
      .schema_version == 1 and .config_capabilities == $manifest[0].config_capabilities
    ' "${capabilities}" >/dev/null || fail "${name} 的配置能力和发布清单对不上"
  [[ $(elf_machine "${work}/package/kixdns") == "${machine}" ]] ||
    fail "${name} 里的程序不是 ${architecture} 架构"

  install -d -- "${output}"
  install -m 0755 -- "${work}/package/kixdns" "${output}/kixdns"
  install -m 0644 -- "${source}" "${output}/KIXDNS_SOURCE.json"
  install -m 0644 -- "${capabilities}" "${output}/KIXDNS_CAPABILITIES.json"
  jq -r .commit "${manifest}" > "${output}/KIXDNS_BUILD_COMMIT"
  printf '%s\n' "${asset_id}" > "${output}/KIXDNS_ARTIFACT_ID"
  printf '%s\n' "${name}" > "${output}/KIXDNS_ARTIFACT_NAME"
  printf 'sha256:%s\n' "${expected_sha256}" > "${output}/KIXDNS_ARTIFACT_DIGEST"
  sha256sum -- "${output}/kixdns" | awk '{ print $1 }' > "${output}/KIXDNS_BINARY_SHA256"
  printf 'KixDNS %s（%s）：%s\n' "${version}" "${architecture}" "$(cat "${output}/KIXDNS_BUILD_COMMIT")"
}

main "$@"
