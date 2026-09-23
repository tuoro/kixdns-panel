#!/usr/bin/env bash
# 删除不再被任何锁引用的补丁集和依赖修订；最高编号的补丁集保留，编号不回退。
# Git 历史保留被删的内容。删完之后由 verify-patchsets.sh 兜底核对。
# Removes patchsets and dependency revisions no lock references any more; the
# highest-numbered patchset stays so numbers never go backwards. Git history keeps
# what is removed, and verify-patchsets.sh checks the result afterwards.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

mapfile -t locks < <(
  {
    printf '%s\n' upstream.lock.json upstream.release.lock.json
    find upstreams/actions upstreams/releases -maxdepth 1 -type f -name '*.json' -print
  } | sort -u
)

declare -A referenced_sets=()
declare -A referenced_revisions=()
for lock_file in "${locks[@]}"; do
  patchset="$(jq -r .patchset "$lock_file")"
  [[ "$patchset" =~ ^[1-9][0-9]*$ ]] || {
    echo "锁文件补丁集无效：$lock_file" >&2
    exit 1
  }
  referenced_sets["$patchset"]=1
  revision="$(jq -r '.dependency_revision // empty' "$lock_file")"
  if [[ -n "$revision" ]]; then
    source="$(jq -r .source "$lock_file")"
    reference="$(bash scripts/lock-reference.sh "$lock_file")"
    referenced_revisions["patches/dependencies/${source}/${reference}/p${patchset}-r${revision}.patch"]=1
  fi
done

highest="$(find patches/sets -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -n | tail -n 1)"
removed=()
while IFS= read -r directory; do
  patchset="${directory##*/}"
  if [[ -z "${referenced_sets[$patchset]:-}" && "$patchset" != "$highest" ]]; then
    rm -rf -- "$directory"
    removed+=("p${patchset}")
  fi
done < <(find patches/sets -mindepth 1 -maxdepth 1 -type d -print | sort -V)

if [[ -d patches/dependencies ]]; then
  while IFS= read -r file; do
    if [[ -z "${referenced_revisions[$file]:-}" ]]; then
      rm -f -- "$file"
      removed+=("$file")
    fi
  done < <(find patches/dependencies -type f -print | sort)
  find patches/dependencies -mindepth 1 -type d -empty -delete
fi

if ((${#removed[@]} > 0)); then
  printf '已删除未引用的补丁数据：%s\n' "${removed[*]}"
else
  echo '没有未引用的补丁数据'
fi
