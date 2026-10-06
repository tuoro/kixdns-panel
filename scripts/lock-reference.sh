#!/usr/bin/env bash
# 输出锁文件的上游身份：上游 Action 的官方运行编号。版本目录文件名、依赖修订路径和
# artifact 名称都用它。xtask 的 source_reference 是同一规则的 Rust 版本；这份 bash 版本
# 给安装 Rust 之前就要运行的脚本用。
# Prints a lock's upstream identity: the official upstream Action run id. Catalogue file
# names, dependency revision paths and artifact names all use it. xtask's
# source_reference is the same rule in Rust; this copy serves scripts that run before
# Rust is installed.
set -euo pipefail

lock_file="${1:?缺少锁文件}"
# 只读一次：调用方可能传进进程替换，那种文件第二次读是空的。
# Read once: callers may pass a process substitution, which is empty on a second read.
lock="$(cat -- "$lock_file")"
[[ "$(jq -r '.source // empty' <<< "$lock")" == action ]] || {
  echo "锁文件来源无效：$lock_file" >&2
  exit 1
}
reference="$(jq -r '.official_run_id // empty' <<< "$lock")"
[[ "$reference" =~ ^[1-9][0-9]*$ ]] || {
  echo "锁文件上游身份无效：$lock_file" >&2
  exit 1
}
printf '%s\n' "$reference"
