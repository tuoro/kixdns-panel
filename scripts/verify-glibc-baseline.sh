#!/usr/bin/env bash
set -euo pipefail

binary="${1:?缺少待检查的 ELF 文件}"
baseline="${2:-2.35}"
readelf_command="${READELF:-readelf}"

[[ -f "${binary}" ]] || {
  echo "ELF 文件不存在：${binary}" >&2
  exit 1
}
[[ "${baseline}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  echo "GLIBC 基线版本无效：${baseline}" >&2
  exit 1
}
command -v "${readelf_command}" >/dev/null || {
  echo "缺少命令：${readelf_command}" >&2
  exit 1
}

mapfile -t versions < <(
  LC_ALL=C "${readelf_command}" --version-info --wide "${binary}" 2>/dev/null |
    grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' |
    sed 's/^GLIBC_//' |
    sort -Vu
)
if ((${#versions[@]} == 0)); then
  echo "没有从 ${binary} 中找到 GLIBC 符号版本" >&2
  exit 1
fi

highest="${versions[${#versions[@]} - 1]}"
if [[ "$(printf '%s\n%s\n' "${baseline}" "${highest}" | sort -V | tail -n 1)" != "${baseline}" ]]; then
  echo "${binary} 需要 GLIBC_${highest}，超过允许的 GLIBC_${baseline}" >&2
  exit 1
fi

echo "GLIBC 基线校验通过：${binary} 最高需要 GLIBC_${highest}（允许 GLIBC_${baseline}）"
