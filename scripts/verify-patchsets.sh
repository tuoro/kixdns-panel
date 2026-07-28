#!/usr/bin/env bash
set -euo pipefail

base_sha="${1:-}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

fail() {
  printf '补丁集校验失败：%s\n' "$*" >&2
  exit 1
}

has_patches() {
  [[ -d "$1" ]] && find "$1" -maxdepth 1 -type f -name '*.patch' -print -quit | grep -q .
}

validate_lock() {
  local lock_file=$1
  local patchset compatibility source reference patchset_directory
  patchset="$(jq -r '.patchset // empty' "$lock_file")"
  [[ "$patchset" =~ ^[1-9][0-9]*$ ]] || fail "$lock_file 的 patchset 无效"
  patchset_directory="patches/sets/${patchset}"
  has_patches "$patchset_directory/common" || fail "$lock_file 引用的 p${patchset} 缺少通用补丁"

  compatibility="$(jq -r '.compatibility // empty' "$lock_file")"
  if [[ -n "$compatibility" ]]; then
    [[ "$compatibility" =~ ^[A-Za-z0-9._-]+$ ]] || fail "$lock_file 的 compatibility 无效"
    has_patches "$patchset_directory/compatibility/$compatibility" || \
      fail "$lock_file 引用的 p${patchset} 兼容层 $compatibility 不存在或为空"
  fi

  source="$(jq -r '.source // empty' "$lock_file")"
  if [[ "$source" == release ]]; then
    reference="$(jq -r '.release_tag // empty' "$lock_file")"
    if [[ -d "$patchset_directory/release/$reference" ]]; then
      has_patches "$patchset_directory/release/$reference" || \
        fail "$lock_file 对应的 p${patchset} Release 补丁目录为空"
    fi
  elif [[ "$source" != action ]]; then
    fail "$lock_file 的 source 无效"
  fi
}

[[ -d patches/sets ]] || fail 'patches/sets 目录不存在'
mapfile -t patchset_directories < <(find patches/sets -mindepth 1 -maxdepth 1 -type d -print | sort -V)
((${#patchset_directories[@]} > 0)) || fail '没有可用补丁集'
for directory in "${patchset_directories[@]}"; do
  patchset="${directory##*/}"
  [[ "$patchset" =~ ^[1-9][0-9]*$ ]] || fail "补丁集目录名无效：$directory"
  has_patches "$directory/common" || fail "补丁集 p${patchset} 缺少通用补丁"
done

mapfile -t locks < <(
  {
    printf '%s\n' upstream.lock.json upstream.release.lock.json
    find upstreams/actions upstreams/releases -maxdepth 1 -type f -name '*.json' -print
  } | sort -u
)
for lock_file in "${locks[@]}"; do
  [[ -f "$lock_file" ]] || fail "锁文件不存在：$lock_file"
  validate_lock "$lock_file"
done

if [[ -n "$base_sha" ]]; then
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'PR 基准提交无效'
  git cat-file -e "${base_sha}^{commit}" 2>/dev/null || fail '无法读取 PR 基准提交'

  declare -A sealed_patchsets=()
  highest_sealed=0
  if git cat-file -e "${base_sha}:patches/sets" 2>/dev/null; then
    while IFS= read -r patchset; do
      [[ "$patchset" =~ ^[1-9][0-9]*$ ]] || fail "基准分支包含无效补丁集：$patchset"
      sealed_patchsets["$patchset"]=1
      ((patchset > highest_sealed)) && highest_sealed=$patchset
      git diff --quiet "$base_sha" HEAD -- "patches/sets/$patchset" || \
        fail "补丁集 p${patchset} 已封印；请新增更高编号的补丁集"
    done < <(git ls-tree -d --name-only "${base_sha}:patches/sets")
  fi

  for directory in "${patchset_directories[@]}"; do
    patchset="${directory##*/}"
    if [[ -z "${sealed_patchsets[$patchset]:-}" ]] && ((patchset <= highest_sealed)); then
      fail "新补丁集 p${patchset} 必须高于当前最高编号 p${highest_sealed}"
    fi
  done
fi

echo "补丁集校验通过：${#patchset_directories[@]} 个集合，${#locks[@]} 个锁文件"
