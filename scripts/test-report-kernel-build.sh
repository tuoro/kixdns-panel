#!/usr/bin/env bash
# report-kernel-build.sh 的回归测试：用假的 gh 返回接口形状的作业列表，核对告警的创建、
# 更新、关闭和正文。gh 的 --jq 表达式交给真实 jq 执行，所以过滤逻辑也在测试里。
# Regression test for report-kernel-build.sh: a stub gh returns API-shaped job lists
# and records what happens to the alert. The script's --jq expression runs through real
# jq, so the filtering is tested too.
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

mkdir -p "$temporary/bin"
cat > "$temporary/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'api --paginate')
    while (($#)); do
      if [[ "$1" == --jq ]]; then
        jq -r "$2" "$STUB_JOBS"
        exit 0
      fi
      shift
    done
    exit 1
    ;;
  'issue list')
    cat "$STUB_ISSUES"
    ;;
  'issue create' | 'issue edit' | 'issue close')
    action=$2
    shift 2
    printf '%s' "$action" >> "$STUB_LOG"
    while (($#)); do
      case "$1" in
        --body-file) printf '\n' >> "$STUB_LOG"; cat "$2" >> "$STUB_LOG"; shift ;;
        --comment | --title) shift ;;
        *) printf ' #%s' "$1" >> "$STUB_LOG" ;;
      esac
      shift
    done
    printf '\n' >> "$STUB_LOG"
    ;;
  *)
    echo "unexpected gh $*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$temporary/bin/gh"

job() {
  jq -n --arg name "build / $1" --arg conclusion "$2" \
    '{name: $name, conclusion: (if $conclusion == "" then null else $conclusion end),
      html_url: ("https://github.com/tuoro/kixdns-panel/actions/runs/1/job/" + ($name | length | tostring))}'
}
jobs_file() {
  local output=$1
  shift
  printf '%s\n' "$@" | jq -s '{total_count: length, jobs: .}' > "$output"
}

failing="$temporary/failing.json"
jobs_file "$failing" \
  "$(job 'Find missing packages' success)" \
  "$(job 'Verify upstreams/actions/31574175882.json' failure)" \
  "$(job 'Verify upstreams/actions/34942284951.json' success)" \
  "$(job 'Verify upstreams/actions/34876540113.json' success)" \
  "$(job 'Build upstreams/actions/31574175882.json / x86_64' failure)" \
  "$(job 'Build upstreams/actions/31574175882.json / arm64' failure)" \
  "$(job 'Build upstreams/actions/34942284951.json / x86_64' success)" \
  "$(job 'Build upstreams/actions/34942284951.json / arm64' failure)" \
  "$(job 'Build upstreams/actions/34876540113.json / x86_64' success)" \
  "$(job 'Build upstreams/actions/34876540113.json / arm64' success)" \
  "$(job 'Report failed versions' '')"
passing="$temporary/passing.json"
jobs_file "$passing" \
  "$(job 'Find missing packages' success)" \
  "$(job 'Verify upstreams/actions/34942284951.json' success)" \
  "$(job 'Build upstreams/actions/34942284951.json / x86_64' success)" \
  "$(job 'Build upstreams/actions/34942284951.json / arm64' success)" \
  "$(job 'Report failed versions' '')"

no_issue="$temporary/no-issue.json"
echo '[{"number": 13, "title": "[build] KixDNS Release 内核构建失败"}]' > "$no_issue"
open_issue="$temporary/open-issue.json"
echo '[{"number": 12, "title": "[build] KixDNS Action 内核构建失败"}, {"number": 13, "title": "[build] KixDNS Release 内核构建失败"}]' > "$open_issue"

failures=0
run_report() {
  local jobs=$1 issues=$2
  STUB_LOG="$temporary/log"
  : > "$STUB_LOG"
  PATH="$temporary/bin:$PATH" STUB_JOBS="$jobs" STUB_ISSUES="$issues" STUB_LOG="$STUB_LOG" \
    TRACK_LABEL=Action GITHUB_REPOSITORY=tuoro/kixdns-panel GITHUB_RUN_ID=1 \
    GITHUB_RUN_ATTEMPT=1 GITHUB_SERVER_URL=https://github.com \
    bash "$workspace/scripts/report-kernel-build.sh" > /dev/null
  cat "$STUB_LOG"
}
check() {
  local name=$1 condition=$2
  if ! eval "$condition"; then
    printf '场景失败：%s\n%s\n' "$name" "$log" >&2
    failures=$((failures + 1))
  fi
}

log="$(run_report "$failing" "$no_issue")"
check 'failures open a new alert' '[[ "$(head -n 1 <<< "$log")" == create ]]'
check 'the other track alert is left alone' '[[ "$log" != *"#13"* ]]'
check 'failed verification is listed' '[[ "$log" == *"\`upstreams/actions/31574175882.json\`：[验证失败]"* ]]'
check 'its missing-marker builds are not listed again' '[[ "$log" != *"31574175882.json\` / "* ]]'
check 'a verified entry that failed to build is listed' '[[ "$log" == *"\`upstreams/actions/34942284951.json\` / arm64：[构建失败]"* ]]'
check 'successful entries are not listed' '[[ "$log" != *34876540113* && "$log" != *"34942284951.json\` / x86_64"* ]]'

log="$(run_report "$failing" "$open_issue")"
check 'failures update the open alert' '[[ "$(head -n 1 <<< "$log")" == "edit #12" ]]'

log="$(run_report "$passing" "$open_issue")"
check 'a clean run closes the alert' '[[ "$log" == "close #12" ]]'

log="$(run_report "$passing" "$no_issue")"
check 'a clean run without an alert does nothing' '[[ -z "$log" ]]'

((failures == 0)) || exit 1
echo '内核构建告警校验通过'
