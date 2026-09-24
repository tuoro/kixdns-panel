#!/usr/bin/env bash
set -euo pipefail

lock_file="${1:?缺少上游锁文件}"
architecture="${2:?缺少目标架构}"

[[ -f "$lock_file" ]] || { echo "锁文件不存在：$lock_file" >&2; exit 1; }
[[ "$architecture" =~ ^(x86_64|arm64)$ ]] || { echo "目标架构无效：$architecture" >&2; exit 1; }

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source="$(jq -r .source "$lock_file")"
patchset="$(jq -r .patchset "$lock_file")"
reference="$(bash "$script_directory/lock-reference.sh" "$lock_file")"
[[ "$patchset" =~ ^[1-9][0-9]*$ ]] || {
  echo '上游构建身份无效' >&2
  exit 1
}

# 指纹只由下面明确列出的输入决定：会改变内核二进制，或改变它必须通过的验证的文件。
#   - 锁文件：上游提交、补丁集、兼容层、依赖修订号
#   - 所选补丁：兼容层、Release 专用层、通用层，以及依赖修订
#   - 能力清单：随包发布
#   - Rust 工具链
#   - xtask 源码：prepare 的逻辑；只做维护的模块明确排除，见 maintenance_modules
#   - 验证脚本：DNS 冒烟与 GLIBC 基线，它们变严时历史版本要重新验证
# 不包括 xtask 自己的依赖（只影响工具，不影响内核）、工作流和本脚本；改了构建方式
# 需要手动强制重建。
# The fingerprint depends only on the inputs listed here: files that change the kernel
# binary or the checks it must pass. xtask's own dependencies (they affect the tool, not
# the kernel), the workflows and this script are deliberately left out; a change to how
# kernels are built needs a manual forced rebuild.
maintenance_modules=(
  tools/xtask/src/overlay.rs # 自动重基与并入，只生成新补丁集或新兼容层 / rebase and join, only write new patchsets or layers
  tools/xtask/src/refresh.rs # 审计与依赖刷新，只生成修订 / audit and refresh, only writes revisions
)
files=(
  rust-toolchain.toml
  scripts/dns_smoke.py
  scripts/verify-glibc-baseline.sh
)
while IFS= read -r file; do
  [[ " ${maintenance_modules[*]} " == *" $file "* ]] || files+=("$file")
done < <(find tools/xtask/src -type f -name '*.rs' -print | sort)

patchset_directory="patches/sets/${patchset}"
[[ -d "$patchset_directory/common" ]] || {
  echo "补丁集 p${patchset} 缺少通用补丁目录" >&2
  exit 1
}
capabilities_file="${patchset_directory}/capabilities.json"
[[ -f "$capabilities_file" ]] || {
  echo "补丁集 p${patchset} 缺少能力清单" >&2
  exit 1
}
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

add_patches() {
  local directory=$1 empty_message=$2
  local selected_count=${#files[@]}
  while IFS= read -r file; do files+=("$file"); done < <(find "$directory" -maxdepth 1 -type f -name '*.patch' -print | sort)
  ((${#files[@]} > selected_count)) || {
    echo "$empty_message" >&2
    exit 1
  }
}
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
  add_patches "$compatibility_directory" "补丁集 p${patchset} 的兼容层 ${compatibility} 为空"
fi
release_directory="${patchset_directory}/release/${reference}"
if [[ "$source" == release && -d "$release_directory" ]]; then
  add_patches "$release_directory" "补丁集 p${patchset} 的 Release 目录 ${reference} 为空"
fi
add_patches "$patchset_directory/common" "补丁集 p${patchset} 缺少通用补丁"
# 依赖修订只进指纹，不改名称格式：已安装的面板按固定格式解析 artifact 名。
# A dependency revision enters the fingerprint only and never the name format,
# which installed panels parse strictly.
dependency_revision="$(jq -r '.dependency_revision // empty' "$lock_file")"
if [[ -n "$dependency_revision" ]]; then
  [[ "$dependency_revision" =~ ^[1-9][0-9]*$ ]] || {
    echo '依赖修订编号无效' >&2
    exit 1
  }
  revision_file="patches/dependencies/${source}/${reference}/p${patchset}-r${dependency_revision}.patch"
  [[ -f "$revision_file" ]] || {
    echo "依赖修订不存在：${revision_file}" >&2
    exit 1
  }
  files+=("$revision_file")
fi

fingerprint="$({
  # 规则本身变了就换版本号，让所有身份一起变。 / Bump when the rules change.
  printf 'identity-rules\0%s\n' 2
  printf 'upstream.lock.json\0%s\n' "$(sha256sum "$lock_file" | cut -d ' ' -f1)"
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || { echo "构建输入不存在：$file" >&2; exit 1; }
    printf '%s\0%s\n' "$file" "$(sha256sum "$file" | cut -d ' ' -f1)"
  done
} | sha256sum | cut -c1-12)"

printf 'kixdns-enhanced-%s-%s-p%s-%s-linux-%s\n' \
  "$source" "$reference" "$patchset" "$fingerprint" "$architecture"
