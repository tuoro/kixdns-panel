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

command -v cargo >/dev/null || { echo '缺少命令：cargo' >&2; exit 1; }

# 只记录 xtask 在 Linux 构建主机上的精确依赖，隔离面板专属依赖变化。
xtask_dependencies="$(
  cargo metadata --locked --format-version 1 --filter-platform x86_64-unknown-linux-gnu |
    jq -ceS '
      . as $metadata
      | def direct_dependencies($ids):
          [$metadata.resolve.nodes[]
            | select(.id as $id | $ids | index($id))
            | .deps[].pkg]
          | unique;
        def dependency_closure($ids):
          (($ids + direct_dependencies($ids)) | unique) as $next
          | if ($next | length) == ($ids | length)
            then $next
            else dependency_closure($next)
            end;
        ([$metadata.packages[]
          | select(.name == "xtask" and (.manifest_path | gsub("\\\\"; "/") | endswith("/tools/xtask/Cargo.toml")))
          | .id] | first) as $root
      | if $root == null then error("找不到 xtask package") else $root end
      | dependency_closure([.]) as $ids
      | [$metadata.packages[]
          | select(.id as $id | $ids | index($id))
          | {name, version, source}]
      | sort_by(.name, .version, .source)
    '
)" || { echo '无法解析 xtask 依赖闭包' >&2; exit 1; }

files=(
  rust-toolchain.toml
  tools/xtask/Cargo.toml
  scripts/dns_smoke.py
  scripts/verify-glibc-baseline.sh
  scripts/kixdns-artifact-identity.sh
  .github/workflows/build-kixdns-track.yml
)
while IFS= read -r file; do files+=("$file"); done < <(find tools/xtask/src -type f -print | sort)
patchset_directory="patches/sets/${patchset}"
[[ -d "$patchset_directory/common" ]] || {
  echo "补丁集 p${patchset} 缺少通用补丁目录" >&2
  exit 1
}
capabilities_file="${patchset_directory}/capabilities.json"
legacy_build_inputs=false
if [[ -f "$capabilities_file" ]]; then
  jq -e '
    .schema_version == 1 and
    (.config_capabilities | type == "array") and
    ([.config_capabilities[] | type == "string" and test("^[a-z][a-z0-9_]{0,63}$")] | all) and
    ((.config_capabilities | unique | length) == (.config_capabilities | length))
  ' "$capabilities_file" >/dev/null || {
    echo "补丁集 p${patchset} 的能力清单无效" >&2
    exit 1
  }
  files+=("$capabilities_file")
else
  # 没有能力清单的封印补丁集继续使用引入能力契约前的构建输入摘要。
  legacy_build_inputs=true
fi
compatibility="$(jq -r '.compatibility // empty' "$lock_file")"
if [[ -n "$compatibility" ]]; then
  [[ "$compatibility" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo '上游兼容层身份无效' >&2
    exit 1
  }
  compatibility_directory="${patchset_directory}/compatibility/${compatibility}"
  [[ -d "$compatibility_directory" ]] || {
    echo "补丁集 p${patchset} 缺少兼容层 ${compatibility}" >&2
    exit 1
  }
  selected_count=${#files[@]}
  while IFS= read -r file; do files+=("$file"); done < <(find "$compatibility_directory" -maxdepth 1 -type f -name '*.patch' -print | sort)
  ((${#files[@]} > selected_count)) || {
    echo "补丁集 p${patchset} 的兼容层 ${compatibility} 为空" >&2
    exit 1
  }
fi
release_directory="${patchset_directory}/release/${reference}"
if [[ "$source" == release && -d "$release_directory" ]]; then
  selected_count=${#files[@]}
  while IFS= read -r file; do files+=("$file"); done < <(find "$release_directory" -maxdepth 1 -type f -name '*.patch' -print | sort)
  ((${#files[@]} > selected_count)) || {
    echo "补丁集 p${patchset} 的 Release 目录 ${reference} 为空" >&2
    exit 1
  }
fi
selected_count=${#files[@]}
while IFS= read -r file; do files+=("$file"); done < <(find "$patchset_directory/common" -maxdepth 1 -type f -name '*.patch' -print | sort)
((${#files[@]} > selected_count)) || {
  echo "补丁集 p${patchset} 缺少通用补丁" >&2
  exit 1
}

fingerprint="$({
  [[ -f "$lock_file" ]] || { echo "构建输入不存在：$lock_file" >&2; exit 1; }
  printf 'upstream.lock.json\0%s\n' "$(sha256sum "$lock_file" | cut -d ' ' -f1)"
  printf 'tools/xtask/dependencies\0%s\n' "$(printf '%s' "$xtask_dependencies" | sha256sum | cut -d ' ' -f1)"
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || { echo "构建输入不存在：$file" >&2; exit 1; }
    digest="$(sha256sum "$file" | cut -d ' ' -f1)"
    if [[ "$legacy_build_inputs" == true ]]; then
      case "$file" in
        scripts/kixdns-artifact-identity.sh)
          digest='d47a150c73f952c32f55d33ec1e4d8b37502fd34a02b747c356e91bafed6c7fd'
          ;;
        .github/workflows/build-kixdns-track.yml)
          digest='1cb570b8c0a1d9b793738bfdd16c683f261f619467c777a2fc102e60eced0fe4'
          ;;
      esac
    fi
    printf '%s\0%s\n' "$file" "$digest"
  done
} | sha256sum | cut -c1-12)"

printf 'kixdns-enhanced-%s-%s-p%s-%s-linux-%s\n' \
  "$source" "$reference" "$patchset" "$fingerprint" "$architecture"
