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

printf '\n// artifact identity build-input regression\n' >> "$copy/tools/xtask/src/main.rs"
build_identity="$(identity)"
[[ "$build_identity" != "$baseline" ]] || {
  echo '修改 prepare 构建代码必须使 KixDNS artifact 失效' >&2
  exit 1
}

echo 'artifact 指纹边界校验通过'
