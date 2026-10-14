#!/usr/bin/env bash
# 取一份 Loyalsoldier 的 geosite.dat 放进完整安装包：发布页记下的摘要、它自带的 sha256sum
# 文件和实际下载的内容一致，能解析，并且带着面板模板用到的分类；再附上许可证和来源说明。
# Fetches one Loyalsoldier geosite.dat for the full package: the digest the release lists, its
# own sha256sum file and the downloaded bytes agree, it parses and carries the categories the
# panel's templates use; its licence and a source note go along with it.
set -Eeuo pipefail

readonly REPOSITORY=Loyalsoldier/v2ray-rules-dat
readonly ASSET=geosite.dat
# 面板模板（国内外分流、国内分流、广告拦截）用到的分类 / Categories the panel's templates use
readonly REQUIRED_CATEGORIES=(cn 'geolocation-!cn' category-ads-all)
readonly MAX_BYTES=$((64 * 1024 * 1024))

fail() {
  printf '获取内置 GeoSite 失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  printf '用法：%s <发布标签|latest> <输出目录>\n' "$0" >&2
  exit 2
}

main() {
  [[ $# -eq 2 ]] || usage
  local tag=$1
  local output=$2
  local script_directory work release digest expected size published

  for command in gh jq sha256sum python3 stat base64; do
    command -v "${command}" >/dev/null || fail "缺少命令 ${command}"
  done
  script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  if [[ ${tag} == latest ]]; then
    tag="$(gh api "repos/${REPOSITORY}/releases/latest" --jq .tag_name)"
  fi
  [[ ${tag} =~ ^[0-9]{12}$ ]] || fail "发布标签不是预期的写法：${tag}"

  release="$(gh api "repos/${REPOSITORY}/releases/tags/${tag}")"
  jq -e '.draft == false and .prerelease == false' <<< "${release}" >/dev/null || fail "${tag} 不是正式发布"
  digest="$(jq -r --arg name "${ASSET}" '[.assets[] | select(.name == $name)] | if length == 1 then .[0].digest // "" else error("missing") end' <<< "${release}")" ||
    fail "${tag} 缺少 ${ASSET}"
  published="$(jq -r .published_at <<< "${release}")"

  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # 在这里展开：退出时 work 已经离开作用域 / Expand now: work is out of scope at exit
  trap "rm -rf -- '${work}'" EXIT
  gh release download "${tag}" --repo "${REPOSITORY}" \
    --pattern "${ASSET}" --pattern "${ASSET}.sha256sum" --dir "${work}"
  size="$(stat -c %s -- "${work}/${ASSET}")"
  ((size > 0 && size <= MAX_BYTES)) || fail "${ASSET} 大小异常：${size} 字节"
  (cd "${work}" && sha256sum --check --quiet --strict "${ASSET}.sha256sum") ||
    fail "${ASSET} 和它的 sha256sum 文件对不上"
  expected="$(sha256sum -- "${work}/${ASSET}" | awk '{ print $1 }')"
  if [[ -n ${digest} ]]; then
    [[ ${digest} == "sha256:${expected}" ]] || fail "GitHub 记下的 ${ASSET} 摘要和下载的内容对不上"
  fi
  python3 -I "${script_directory}/verify-geosite.py" "${work}/${ASSET}" "${REQUIRED_CATEGORIES[@]}" ||
    fail "${ASSET} 没通过分类检查"

  install -d -- "${output}"
  install -m 0644 -- "${work}/${ASSET}" "${output}/${ASSET}"
  # 数据按 GPL-3.0 发布：许可证取同一个标签下的文件，和数据一起带走
  # The data is released under GPL-3.0: the licence comes from the same tag and travels with the data
  gh api "repos/${REPOSITORY}/contents/LICENSE?ref=${tag}" --jq .content | base64 -d > "${output}/LICENSE"
  grep -q 'GNU GENERAL PUBLIC LICENSE' "${output}/LICENSE" || fail "许可证不是预期的 GPL"
  jq -n \
    --arg url "https://github.com/${REPOSITORY}/releases/latest/download/${ASSET}" \
    --arg release "${tag}" \
    --arg release_url "https://github.com/${REPOSITORY}/releases/tag/${tag}" \
    --arg published_at "${published}" \
    --arg sha256 "${expected}" \
    --argjson size "${size}" \
    '{schema_version: 1, file: "geosite.dat", url: $url, release: $release, release_url: $release_url,
      published_at: $published_at, sha256: $sha256, size: $size, license: "GPL-3.0"}' \
    > "${output}/geosite.json"
  printf '内置 GeoSite：%s（%s，%s 字节）\n' "${tag}" "${expected:0:12}" "${size}"
}

main "$@"
