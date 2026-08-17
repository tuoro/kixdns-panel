#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo "用法：$0 <当前 Action 锁文件>" >&2
  exit 2
fi

lock_file=$1
[[ -f "$lock_file" && ! -L "$lock_file" ]] || {
  echo "Action 锁文件不存在或不是普通文件：$lock_file" >&2
  exit 1
}

current_reference="$(jq -er '.official_run_id | select(type == "number" and . > 0)' "$lock_file")"
current_commit="$(jq -er '.commit | select(type == "string" and test("^[0-9a-f]{40}$"))' "$lock_file")"

selection="$(jq -er '
    [
      .workflow_runs[]?
      | select(.event == "push" and .status == "completed" and .conclusion == "success")
      | select((.id | type) == "number" and .id > 0)
      | select((.head_sha | type) == "string" and (.head_sha | test("^[0-9a-f]{40}$")))
      | {reference: .id, commit: .head_sha}
    ]
    | if length == 0 then error("没有有效的上游 push 成功运行") else max_by(.reference) end
    | [.reference, .commit]
    | @tsv
  ')" || {
  echo '官方 Action 元数据无效' >&2
  exit 1
}

IFS=$'\t' read -r reference commit <<< "$selection"
[[ "$reference" =~ ^[0-9]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo '官方 Action 候选身份无效' >&2
  exit 1
}

if ((reference < current_reference)); then
  echo "忽略倒退的上游 Action 运行：${reference} < ${current_reference}" >&2
  printf '%s\t%s\tfalse\n' "$current_reference" "$current_commit"
  exit 0
fi

if ((reference == current_reference)); then
  [[ "$commit" == "$current_commit" ]] || {
    echo "同一上游 Action 运行对应了不同提交：${reference}" >&2
    exit 1
  }
  printf '%s\t%s\tfalse\n' "$current_reference" "$current_commit"
  exit 0
fi

if [[ "$commit" == "$current_commit" ]]; then
  printf '%s\t%s\tfalse\n' "$current_reference" "$current_commit"
  exit 0
fi

printf '%s\t%s\ttrue\n' "$reference" "$commit"
