#!/usr/bin/env bash
set -euo pipefail

lock_file="${1:?缺少上游锁文件}"
architecture="${2:?缺少目标架构}"

[[ -f "$lock_file" ]] || { echo "锁文件不存在：$lock_file" >&2; exit 1; }
[[ "$architecture" =~ ^(x86_64|arm64)$ ]] || { echo "目标架构无效：$architecture" >&2; exit 1; }

source="$(jq -r .source "$lock_file")"
patchset="$(jq -r .patchset "$lock_file")"
case "$source" in
  action) reference="$(jq -r .official_run_id "$lock_file")" ;;
  release) reference="$(jq -r .release_tag "$lock_file")" ;;
  *) echo "未知上游来源：$source" >&2; exit 1 ;;
esac
[[ "$reference" =~ ^[A-Za-z0-9._-]+$ && "$patchset" =~ ^[1-9][0-9]*$ ]] || {
  echo '上游构建身份无效' >&2
  exit 1
}

files=(
  "$lock_file"
  Cargo.lock
  rust-toolchain.toml
  tools/xtask/Cargo.toml
  scripts/dns_smoke.py
  scripts/kixdns-artifact-identity.sh
  .github/workflows/build-kixdns-track.yml
)
while IFS= read -r file; do files+=("$file"); done < <(find tools/xtask/src -type f -print | sort)
while IFS= read -r file; do files+=("$file"); done < <(find patches -maxdepth 1 -type f -name '*.patch' -print | sort)
compatibility="$(jq -r '.compatibility // empty' "$lock_file")"
if [[ -n "$compatibility" && -d "patches/compatibility/$compatibility" ]]; then
  while IFS= read -r file; do files+=("$file"); done < <(find "patches/compatibility/$compatibility" -type f -name '*.patch' -print | sort)
fi
if [[ "$source" == release && -d "patches/release/$reference" ]]; then
  while IFS= read -r file; do files+=("$file"); done < <(find "patches/release/$reference" -type f -name '*.patch' -print | sort)
fi

fingerprint="$({
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || { echo "构建输入不存在：$file" >&2; exit 1; }
    printf '%s\0' "$file"
    sha256sum "$file"
  done
} | sha256sum | cut -c1-12)"

printf 'kixdns-enhanced-%s-%s-p%s-%s-linux-%s\n' \
  "$source" "$reference" "$patchset" "$fingerprint" "$architecture"
