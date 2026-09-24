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
  local patchset compatibility source reference patchset_directory revision revision_file
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
  [[ "$source" == action || "$source" == release ]] || fail "$lock_file 的 source 无效"
  reference="$(bash scripts/lock-reference.sh "$lock_file")" || fail "$lock_file 的上游身份无效"
  if [[ "$source" == release && -d "$patchset_directory/release/$reference" ]]; then
    has_patches "$patchset_directory/release/$reference" || \
      fail "$lock_file 对应的 p${patchset} Release 补丁目录为空"
  fi

  revision="$(jq -r '.dependency_revision // empty' "$lock_file")"
  if [[ -n "$revision" ]]; then
    [[ "$revision" =~ ^[1-9][0-9]*$ ]] || fail "$lock_file 的 dependency_revision 无效"
    revision_file="patches/dependencies/${source}/${reference}/p${patchset}-r${revision}.patch"
    [[ -f "$revision_file" ]] || fail "$lock_file 引用的依赖修订不存在：$revision_file"
  fi
}

# 依赖修订只能调整 Cargo.lock，路径编码上游身份、补丁集和修订号。
# A dependency revision may only adjust Cargo.lock; its path encodes the upstream
# version, the patchset and the revision number.
revision_pattern='^patches/dependencies/(action|release)/[A-Za-z0-9._-]+/p[1-9][0-9]*-r[1-9][0-9]*\.patch$'
revision_files=()
if [[ -d patches/dependencies ]]; then
  mapfile -t revision_files < <(find patches/dependencies -type f -print | sort)
fi
for file in "${revision_files[@]}"; do
  [[ "$file" =~ $revision_pattern ]] || fail "依赖修订路径无效：$file"
  mapfile -t touched < <(grep '^diff --git ' "$file")
  [[ ${#touched[@]} -eq 1 && "${touched[0]}" == 'diff --git a/Cargo.lock b/Cargo.lock' ]] || \
    fail "依赖修订只能修改 Cargo.lock：$file"
done

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
    done < <(git ls-tree -d --name-only "${base_sha}:patches/sets")
  fi
  # 封印的补丁集不能修改。没有锁引用的可以整个删除（上面的锁校验会拦住仍被引用的），
  # 但编号不能回退：删掉最高编号时必须已有更高的新补丁集，否则下一个编号会被复用。
  # A sealed patchset never changes. One no lock references may be deleted whole (the
  # lock checks above stop a referenced one), but numbers never go backwards: the highest
  # may only go once a newer patchset exists, or its number would be reused.
  highest_present="${patchset_directories[-1]##*/}"
  for patchset in "${!sealed_patchsets[@]}"; do
    if [[ ! -d "patches/sets/$patchset" ]]; then
      ((patchset != highest_sealed || highest_present > highest_sealed)) || \
        fail "最高编号补丁集 p${patchset} 不能删除"
      continue
    fi
    # 已封印的集合只接受两种改动，都以整个兼容层目录为单位：
    #   - 新增一个名字未用过的兼容层。已有的锁不会选中新名字，已有构建不受影响，另一份
    #     上游因此能沿用同一个编号。
    #   - 整个删除一个兼容层。仍有锁在用时上面的锁校验会报缺失，所以只有没人用的能删。
    # 往已有兼容层里增删改文件、新增 release/<tag>/（按标签自动选中）或改动其余任何文件，
    # 都会改变已有构建，只能新增更高编号的补丁集。
    # A sealed patchset accepts two changes, each a whole compatibility directory:
    #   - a layer under a name never used: no existing lock selects it, so no existing
    #     build changes, and another upstream can share the number;
    #   - removing a layer outright: the lock checks above report it missing while any lock
    #     still uses it, so only unused ones can go.
    # Adding, removing or editing a file inside an existing layer, adding release/<tag>/
    # (selected by tag) or touching anything else changes an existing build and needs a
    # new, higher patchset.
    while IFS=$'\t' read -r status path; do
      [[ -n "$status" ]] || continue
      layer="${path#"patches/sets/$patchset/"}"
      if [[ "$layer" =~ ^compatibility/([A-Za-z0-9._-]+)/[^/]+\.patch$ ]]; then
        directory="patches/sets/$patchset/compatibility/${BASH_REMATCH[1]}"
        existed=false
        git cat-file -e "${base_sha}:${directory}" 2>/dev/null && existed=true
        remains=false
        git cat-file -e "HEAD:${directory}" 2>/dev/null && remains=true
        [[ "$status" == A && "$existed" == false ]] && continue
        [[ "$status" == D && "$existed" == true && "$remains" == false ]] && continue
      fi
      fail "补丁集 p${patchset} 已封印（${layer}）；只能整个新增名字未用过的兼容层或整个删除没人用的兼容层，其余改动请新增更高编号的补丁集"
    done < <(git diff --name-status --no-renames "$base_sha" HEAD -- "patches/sets/$patchset")
  done

  # 依赖修订同样封印：已有的不能修改，同一版本同一补丁集的新修订必须编号更高。
  # Dependency revisions are sealed too: existing ones never change, and a new revision
  # for the same version and patchset must be numbered higher.
  declare -A sealed_revisions=()
  declare -A highest_revision=()
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    sealed_revisions["$file"]=1
    key="${file%-r*.patch}"
    number="${file##*-r}"
    number="${number%.patch}"
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail "基准分支包含无效依赖修订：$file"
    ((number > ${highest_revision[$key]:-0})) && highest_revision["$key"]=$number
    if [[ -f "$file" ]]; then
      git diff --quiet "$base_sha" HEAD -- "$file" || \
        fail "依赖修订 ${file} 已封印；请新增更高编号的修订"
    fi
  done < <(git ls-tree -r --name-only "$base_sha" -- patches/dependencies)
  for file in "${revision_files[@]}"; do
    [[ -z "${sealed_revisions[$file]:-}" ]] || continue
    key="${file%-r*.patch}"
    number="${file##*-r}"
    number="${number%.patch}"
    ((number > ${highest_revision[$key]:-0})) || \
      fail "新依赖修订 ${file} 必须高于已封印的 r${highest_revision[$key]}"
  done

  for directory in "${patchset_directories[@]}"; do
    patchset="${directory##*/}"
    if [[ -z "${sealed_patchsets[$patchset]:-}" ]] && ((patchset <= highest_sealed)); then
      fail "新补丁集 p${patchset} 必须高于当前最高编号 p${highest_sealed}"
    fi
  done
fi

echo "补丁集校验通过：${#patchset_directories[@]} 个集合，${#locks[@]} 个锁文件，${#revision_files[@]} 个依赖修订"
