#!/usr/bin/env bash
# 设计 token 棘轮：前端样式里的字面量色值、字号、圆角只允许减少，不允许增加。
# A ratchet for design tokens: literal colours, font sizes and radii in the
# frontend may only go down, never up.
#
# 新代码一律用 web/src/styles/tokens.css 里的变量。旧代码随各页改版逐步换掉，
# 这个脚本保证在那之前债不会继续长。
# New code uses the variables in web/src/styles/tokens.css. Old code is
# migrated page by page; this keeps the debt from growing in the meantime.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

# 基线：随迁移进度下调，永不上调 / Baseline: lower it as migration proceeds, never raise it
BASELINE_COLOR=491
BASELINE_SIZE=420
BASELINE_RADIUS=119

scan() {
  # tokens.css 是唯一允许出现字面量的文件 / tokens.css is the one file allowed literals
  find web/src -type f \( -name '*.css' -o -name '*.vue' \) ! -path 'web/src/styles/tokens.css' -print0 \
    | xargs -0 grep -ohE "$1" 2>/dev/null | wc -l | tr -d ' '
}

color=$(scan '#[0-9a-fA-F]{3,8}\b')
size=$(scan 'font-size:[[:space:]]*[0-9.]+(px|rem|em)')
radius=$(scan 'border-radius:[[:space:]]*[0-9.]+(px|rem|%)')

status=0
report() {
  local name=$1 now=$2 base=$3
  if (( now > base )); then
    printf '✗ %s：%d 处，超过基线 %d。新代码请使用 tokens.css 里的变量。\n' "$name" "$now" "$base" >&2
    status=1
  elif (( now < base )); then
    printf '✓ %s：%d 处，低于基线 %d —— 请把脚本里的基线下调到 %d。\n' "$name" "$now" "$base" "$now"
  else
    printf '✓ %s：%d 处，与基线持平。\n' "$name" "$now"
  fi
}

report '字面量色值' "$color" "$BASELINE_COLOR"
report '字面量字号' "$size" "$BASELINE_SIZE"
report '字面量圆角' "$radius" "$BASELINE_RADIUS"

exit "$status"
