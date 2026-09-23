#!/usr/bin/env bash
# 输出锁文件的上游身份：Action 是官方运行编号，Release 是标签。版本目录文件名、依赖修订
# 路径和 artifact 名称都用它。xtask 的 source_reference 是同一规则的 Rust 版本；这份
# bash 版本给安装 Rust 之前就要运行的脚本用。
# Prints a lock's upstream identity: the official run id for action, the tag for release.
# Catalogue file names, dependency revision paths and artifact names all use it. xtask's
# source_reference is the same rule in Rust; this copy serves scripts that run before
# Rust is installed.
set -euo pipefail

lock_file="${1:?缺少锁文件}"
# 只读一次：调用方可能传进进程替换，那种文件第二次读是空的。
# Read once: callers may pass a process substitution, which is empty on a second read.
lock="$(cat -- "$lock_file")"
source="$(jq -r '.source // empty' <<< "$lock")"
case "$source" in
  action)
    reference="$(jq -r '.official_run_id // empty' <<< "$lock")"
    pattern='^[1-9][0-9]*$'
    ;;
  release)
    reference="$(jq -r '.release_tag // empty' <<< "$lock")"
    pattern='^[A-Za-z0-9._-]{1,100}$'
    ;;
  *)
    echo "锁文件来源无效：$lock_file" >&2
    exit 1
    ;;
esac
[[ "$reference" =~ $pattern ]] || {
  echo "锁文件上游身份无效：$lock_file" >&2
  exit 1
}
printf '%s\n' "$reference"
