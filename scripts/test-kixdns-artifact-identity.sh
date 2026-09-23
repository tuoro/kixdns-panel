#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

copy="$temporary/repository"
mkdir -p "$copy"
(
  cd "$workspace"
  tar \
    --exclude=.git \
    --exclude=.upstream \
    --exclude=target \
    --exclude=node_modules \
    -cf - .
) | tar -C "$copy" -xf -

identity() {
  (
    cd "$copy"
    bash scripts/kixdns-artifact-identity.sh upstream.lock.json x86_64
  )
}

baseline="$(identity)"
printf '\n// artifact identity maintenance-only regression\n' >> "$copy/tools/xtask/src/overlay.rs"
maintenance_identity="$(identity)"
[[ "$maintenance_identity" == "$baseline" ]] || {
  echo '修改自动重基代码不应使 KixDNS artifact 失效' >&2
  exit 1
}

printf '\n// artifact identity maintenance-only regression\n' >> "$copy/tools/xtask/src/refresh.rs"
refresh_identity="$(identity)"
[[ "$refresh_identity" == "$baseline" ]] || {
  echo '修改依赖刷新代码不应使 KixDNS artifact 失效' >&2
  exit 1
}

revised_identity() {
  (
    cd "$copy"
    bash scripts/kixdns-artifact-identity.sh revised.lock.json x86_64
  )
}
jq '.dependency_revision = 1' "$copy/upstream.lock.json" > "$copy/revised.lock.json"
if revised_identity >/dev/null 2>&1; then
  echo '锁引用的依赖修订不存在时必须拒绝生成身份' >&2
  exit 1
fi
revision_file="$copy/patches/dependencies/$(jq -r .source "$copy/upstream.lock.json")/$(jq -r .official_run_id "$copy/upstream.lock.json")/p$(jq -r .patchset "$copy/upstream.lock.json")-r1.patch"
mkdir -p "$(dirname "$revision_file")"
printf 'diff --git a/Cargo.lock b/Cargo.lock\n' > "$revision_file"
revised="$(revised_identity)"
[[ "$revised" != "$baseline" && "${revised%-*-linux-x86_64}" == "${baseline%-*-linux-x86_64}" ]] || {
  echo '依赖修订必须只改变 artifact 指纹，不改变名称格式' >&2
  exit 1
}
printf '+changed\n' >> "$revision_file"
[[ "$(revised_identity)" != "$revised" ]] || {
  echo '依赖修订内容变化必须使 KixDNS artifact 失效' >&2
  exit 1
}

expect_unchanged() {
  [[ "$(identity)" == "$baseline" ]] || {
    echo "$1" >&2
    exit 1
  }
}
expect_changed() {
  local current
  current="$(identity)"
  [[ "$current" != "$baseline" ]] || {
    echo "$1" >&2
    exit 1
  }
  baseline=$current
}

printf '\n# xtask dependency bump\n' >> "$copy/tools/xtask/Cargo.toml"
# 真实改动 xtask 依赖闭包里一个库的版本。 / A real version change inside xtask's dependency closure.
sed -i '/^name = "anyhow"$/{n;s/^version = .*/version = "1.0.0"/}' "$copy/Cargo.lock"
expect_unchanged 'xtask 自己的依赖变化不应使 KixDNS artifact 失效'
printf '\n# build workflow change\n' >> "$copy/.github/workflows/build-kixdns-track.yml"
printf '\n# identity script change\n' >> "$copy/scripts/kixdns-artifact-identity.sh"
expect_unchanged '工作流和指纹脚本的改动不应使 KixDNS artifact 失效'
printf '// prepare helper\n' > "$copy/tools/xtask/src/prepare_helper.rs"
expect_changed '新增的 xtask 模块默认参与 prepare，必须使 KixDNS artifact 失效'
printf '\n# stricter smoke test\n' >> "$copy/scripts/dns_smoke.py"
expect_changed '验证脚本变化必须使 KixDNS artifact 失效'

printf '\n// artifact identity build-input regression\n' >> "$copy/tools/xtask/src/main.rs"
build_identity="$(identity)"
[[ "$build_identity" != "$baseline" ]] || {
  echo '修改 prepare 构建代码必须使 KixDNS artifact 失效' >&2
  exit 1
}

echo 'artifact 指纹边界校验通过'
