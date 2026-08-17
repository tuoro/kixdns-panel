#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

lock_file="$temporary/upstream.lock.json"
cat > "$lock_file" <<'JSON'
{
  "commit": "2222222222222222222222222222222222222222",
  "official_run_id": 200
}
JSON

select_run() {
  bash "$workspace/scripts/select-kixdns-action-run.sh" "$lock_file"
}

unordered_result="$({
  cat <<'JSON'
{
  "workflow_runs": [
    {
      "id": 300,
      "head_sha": "3333333333333333333333333333333333333333",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    },
    {
      "id": 100,
      "head_sha": "1111111111111111111111111111111111111111",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    }
  ]
}
JSON
} | select_run)"
[[ "$unordered_result" == $'300\t3333333333333333333333333333333333333333\ttrue' ]] || {
  echo "乱序响应没有选择最大运行 ID：$unordered_result" >&2
  exit 1
}

stale_result="$({
  cat <<'JSON'
{
  "workflow_runs": [
    {
      "id": 100,
      "head_sha": "1111111111111111111111111111111111111111",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    }
  ]
}
JSON
} | select_run)"
[[ "$stale_result" == $'200\t2222222222222222222222222222222222222222\tfalse' ]] || {
  echo "历史运行没有保持当前锁定身份：$stale_result" >&2
  exit 1
}

same_result="$({
  cat <<'JSON'
{
  "workflow_runs": [
    {
      "id": 200,
      "head_sha": "2222222222222222222222222222222222222222",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    }
  ]
}
JSON
} | select_run)"
[[ "$same_result" == $'200\t2222222222222222222222222222222222222222\tfalse' ]] || {
  echo "当前运行被错误识别为更新：$same_result" >&2
  exit 1
}

rerun_result="$({
  cat <<'JSON'
{
  "workflow_runs": [
    {
      "id": 400,
      "head_sha": "2222222222222222222222222222222222222222",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    }
  ]
}
JSON
} | select_run)"
[[ "$rerun_result" == $'200\t2222222222222222222222222222222222222222\tfalse' ]] || {
  echo "同一提交的重新运行被错误识别为新版本：$rerun_result" >&2
  exit 1
}

if {
  cat <<'JSON'
{
  "workflow_runs": [
    {
      "id": 200,
      "head_sha": "4444444444444444444444444444444444444444",
      "event": "push",
      "status": "completed",
      "conclusion": "success"
    }
  ]
}
JSON
} | select_run >/dev/null 2>&1; then
  echo '同一运行 ID 的提交漂移没有被拒绝' >&2
  exit 1
fi

if printf '%s\n' '{"workflow_runs": []}' | select_run >/dev/null 2>&1; then
  echo '空的上游运行列表没有被拒绝' >&2
  exit 1
fi

echo '上游 Action 运行选择校验通过'
