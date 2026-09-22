#!/usr/bin/env bash
# 汇总本次内核构建里失败的版本。单个版本失败不再让整次构建失败（否则同批构建成功的
# 包会被面板忽略），所以由这里开告警：有失败就创建或更新 Issue，全部成功就关闭它。
# Summarises which kernel versions failed in this build. A single failing version no
# longer fails the whole run (the panel would otherwise ignore every good package built
# alongside it), so this script raises the alert instead: it creates or updates an issue
# when something failed and closes it once everything passes.
set -euo pipefail

label="${TRACK_LABEL:?缺少轨道名称}"
: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_SERVER_URL:?}"
title="[build] KixDNS ${label} 内核构建失败"
marker="<!-- kixdns-kernel-build:${label} -->"
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

jobs="$(
  gh api --paginate \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs" \
    --jq '.jobs[] | [.name, (.conclusion // "pending"), .html_url] | @tsv'
)"

verify_pattern='(^| / )Verify (upstreams/[A-Za-z0-9._/-]+\.json)$'
build_pattern='(^| / )Build (upstreams/[A-Za-z0-9._/-]+\.json) / ([a-z0-9_]+)$'
declare -A unverified=()
verify_failures=()
build_failures=()
while IFS=$'\t' read -r name conclusion url; do
  [[ "$conclusion" == failure || "$conclusion" == timed_out ]] || continue
  if [[ "$name" =~ $verify_pattern ]]; then
    unverified["${BASH_REMATCH[2]}"]=1
    verify_failures+=("- \`${BASH_REMATCH[2]}\`：[验证失败](${url})")
  fi
done <<< "$jobs"
# 验证没过的版本，构建会因为缺少验证标记而失败，那是同一个问题，不重复列出。
# A version that failed verification also fails its build for lack of a marker; that
# is the same problem and is not listed twice.
while IFS=$'\t' read -r name conclusion url; do
  [[ "$conclusion" == failure || "$conclusion" == timed_out ]] || continue
  if [[ "$name" =~ $build_pattern && -z "${unverified[${BASH_REMATCH[2]}]:-}" ]]; then
    build_failures+=("- \`${BASH_REMATCH[2]}\` / ${BASH_REMATCH[3]}：[构建失败](${url})")
  fi
done <<< "$jobs"

issue="$(
  gh issue list --state open --limit 100 --json number,title |
    jq -r --arg title "$title" '.[] | select(.title == $title) | .number' | head -n 1
)"

if ((${#verify_failures[@]} + ${#build_failures[@]} == 0)); then
  if [[ -n "$issue" ]]; then
    gh issue close "$issue" --comment "本次构建全部成功，告警自动关闭：${run_url}"
  fi
  echo '本次内核构建没有失败的版本'
  exit 0
fi

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
{
  echo "$marker"
  echo "## 部分 KixDNS ${label} 内核没有构建出来"
  echo
  echo "- 构建记录：${run_url}"
  echo
  echo '其余版本已正常构建，面板照常可见。下面的版本这次没有产出新包；旧包到期后会从面板列表消失。'
  echo '审计不过的旧版本会在每日同步时移出版本目录；当前版本审计不过时，同步会另开 `[security]` 告警。'
  if ((${#verify_failures[@]} > 0)); then
    echo
    echo '### 验证失败'
    echo
    printf '%s\n' "${verify_failures[@]}"
  fi
  if ((${#build_failures[@]} > 0)); then
    echo
    echo '### 构建失败'
    echo
    printf '%s\n' "${build_failures[@]}"
  fi
} > "$body_file"

if [[ -n "$issue" ]]; then
  gh issue edit "$issue" --title "$title" --body-file "$body_file"
else
  gh issue create --title "$title" --body-file "$body_file"
fi
printf '有 %s 个版本验证失败、%s 个构建失败，已更新告警\n' "${#verify_failures[@]}" "${#build_failures[@]}"
