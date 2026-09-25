#!/usr/bin/env bash
# 设计 token 棘轮：前端样式里的字面量色值、字号、圆角、字重、阴影、高度、动画时长，
# 以及旧颜色名的引用，只允许减少，不允许增加。
# A ratchet for design tokens: literal colours, font sizes, radii, weights,
# shadows, heights and animation durations in the frontend, and references to
# the old colour names, may only go down, never up.
#
# 新代码一律用 web/src/styles/tokens.css 里的变量。旧代码随各页改版逐步换掉，
# 这个脚本保证在那之前债不会继续长。
# New code uses the variables in web/src/styles/tokens.css. Old code is
# migrated page by page; this keeps the debt from growing in the meantime.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

# 基线：随迁移进度下调，永不上调 / Baseline: lower it as migration proceeds, never raise it
BASELINE_COLOR=501
BASELINE_SIZE=419
BASELINE_RADIUS=120
BASELINE_WEIGHT=85
BASELINE_SHADOW=29
BASELINE_HEIGHT=182
BASELINE_DURATION=13
BASELINE_OLD_NAME=419

styles() {
  # tokens.css 是唯一允许出现字面量的文件 / tokens.css is the one file allowed literals
  find web/src -type f \( -name '*.css' -o -name '*.vue' \) ! -path 'web/src/styles/tokens.css' -print0
}

scan() {
  styles | xargs -0 grep -ohE "$1" 2>/dev/null | wc -l | tr -d ' '
}

# 动画时长要先找到 transition / animation 声明，再数里面的时长。
# Durations are counted inside transition and animation declarations only.
scan_durations() {
  styles | xargs -0 grep -ohE '(transition|animation)[a-z-]*:[^;}]*' 2>/dev/null \
    | grep -oE '[0-9]*\.?[0-9]+m?s\b' | wc -l | tr -d ' '
}

color=$(scan '#[0-9a-fA-F]{3,8}\b')
size=$(scan 'font-size:[[:space:]]*[0-9.]+(px|rem|em)')
radius=$(scan 'border-radius:[[:space:]]*[0-9.]+(px|rem|%)')
weight=$(scan 'font-weight:[[:space:]]*[0-9]+')
# var(...) 与 none 不算字面量 / var(...) and none are not literals
shadow=$(scan 'box-shadow:[[:space:]]*[^vn;[:space:]][^;}]*')
# height、min-height、max-height；排除 line-height / excludes line-height
height=$(scan '(^|[^a-z-])((min|max)-)?height:[[:space:]]*[0-9.]+px')
duration=$(scan_durations)
# 旧颜色名现在只是 tokens.css 的别名 / The old colour names are now aliases of tokens.css
old_name=$(scan 'var\(--(ink|muted|line|surface|canvas|green|green-dark|green-soft|amber|amber-soft|red|red-soft)\)')

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
report '字面量字重' "$weight" "$BASELINE_WEIGHT"
report '字面量阴影' "$shadow" "$BASELINE_SHADOW"
report '字面量高度' "$height" "$BASELINE_HEIGHT"
report '字面量动画时长' "$duration" "$BASELINE_DURATION"
report '旧颜色名引用' "$old_name" "$BASELINE_OLD_NAME"

exit "$status"
