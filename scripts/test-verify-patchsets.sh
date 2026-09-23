#!/usr/bin/env bash
# 补丁集与依赖修订的封印规则回归测试：每个场景在夹具仓库里改动一处，核对校验结果。
# Regression test for the patchset and dependency revision sealing rules: each case
# changes one thing in a fixture repository and checks the verdict.
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

fixture="$temporary/fixture"
mkdir -p "$fixture/scripts"
cp "$workspace/scripts/verify-patchsets.sh" "$workspace/scripts/lock-reference.sh" "$fixture/scripts/"

lock() {
  local source=$1 reference=$2 patchset=$3
  if [[ "$source" == action ]]; then
    jq -n --argjson run "$reference" --argjson patchset "$patchset" \
      '{repository: "olicesx/kixdns", source: "action", commit: ("a" * 40), official_run_id: $run, patchset: $patchset, control_protocol: 1}'
  else
    jq -n --arg tag "$reference" --argjson patchset "$patchset" \
      '{repository: "olicesx/kixdns", source: "release", commit: ("b" * 40), release_id: 1, release_tag: $tag, patchset: $patchset, control_protocol: 1}'
  fi
}

revision() {
  printf 'diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-%s\n+%s\n' "$1" "$2"
}

(
  cd "$fixture"
  git init --quiet
  git config user.name patchset-test
  git config user.email patchset-test@example.com
  # 3 号空缺：用来检验新补丁集不能低于已封印的最高编号。
  # Number 3 is left free to check that a new patchset cannot sit below the highest.
  for patchset in 1 2 4; do
    mkdir -p "patches/sets/$patchset/common"
    printf 'diff --git a/src/lib.rs b/src/lib.rs\n' > "patches/sets/$patchset/common/0001-source.patch"
  done
  mkdir -p upstreams/actions upstreams/releases patches/dependencies/action/11
  lock action 11 2 > upstream.lock.json
  lock release v1 2 > upstream.release.lock.json
  cp upstream.lock.json upstreams/actions/11.json
  cp upstream.release.lock.json upstreams/releases/v1.json
  revision old sealed > patches/dependencies/action/11/p2-r2.patch
  git add --all
  git commit --quiet -m base
)
base="$(git -C "$fixture" rev-parse HEAD)"

failures=0
scenario() {
  local name=$1 expected=$2 message=$3 change=$4
  local work="$temporary/work"
  rm -rf "$work"
  git clone --quiet "$fixture" "$work"
  (
    cd "$work"
    git config user.name patchset-test
    git config user.email patchset-test@example.com
    eval "$change"
    git add --all
    git commit --quiet --allow-empty -m change
  )
  local output status
  set +e
  output="$(cd "$work" && bash scripts/verify-patchsets.sh "$base" 2>&1)"
  status=$?
  set -e
  if [[ "$expected" == pass && $status -eq 0 ]] ||
    [[ "$expected" == fail && $status -ne 0 && "$output" == *"$message"* ]]; then
    return
  fi
  printf '场景失败：%s（期望 %s，退出码 %s）\n%s\n' "$name" "$expected" "$status" "$output" >&2
  failures=$((failures + 1))
}

scenario 'unchanged tree' pass '' ':'
scenario 'new revision above the sealed one' pass '' '
  revision sealed newer > patches/dependencies/action/11/p2-r3.patch
  jq ".dependency_revision = 3" upstream.lock.json > lock.new && mv lock.new upstream.lock.json
  cp upstream.lock.json upstreams/actions/11.json'
scenario 'first revision of another version' pass '' '
  mkdir -p patches/dependencies/release/v1
  revision old new > patches/dependencies/release/v1/p2-r1.patch
  jq ".dependency_revision = 1" upstream.release.lock.json > lock.new && mv lock.new upstream.release.lock.json
  cp upstream.release.lock.json upstreams/releases/v1.json'
scenario 'delete an unreferenced patchset' pass '' 'git rm --quiet -r patches/sets/1'
scenario 'delete an unreferenced revision' pass '' 'git rm --quiet patches/dependencies/action/11/p2-r2.patch'
scenario 'replace the highest patchset with a newer one' pass '' '
  git rm --quiet -r patches/sets/4
  mkdir -p patches/sets/5/common
  printf "diff --git a/src/lib.rs b/src/lib.rs\n" > patches/sets/5/common/0001-source.patch'

scenario 'edit a sealed revision' fail '已封印' 'revision old changed > patches/dependencies/action/11/p2-r2.patch'
scenario 'new revision below the sealed one' fail '必须高于' 'revision old other > patches/dependencies/action/11/p2-r1.patch'
scenario 'revision touching source' fail '只能修改 Cargo.lock' '
  { revision old new; printf "diff --git a/src/lib.rs b/src/lib.rs\n"; } > patches/dependencies/action/11/p2-r3.patch'
scenario 'revision at an invalid path' fail '依赖修订路径无效' '
  revision old new > patches/dependencies/action/11/r3.patch'
scenario 'action lock without a run id' fail '上游身份无效' '
  jq "del(.official_run_id)" upstream.lock.json > lock.new && mv lock.new upstream.lock.json'
scenario 'release lock with an unsafe tag' fail '上游身份无效' '
  jq ".release_tag = \"../v1\"" upstream.release.lock.json > lock.new && mv lock.new upstream.release.lock.json'
scenario 'lock references a missing revision' fail '引用的依赖修订不存在' '
  jq ".dependency_revision = 9" upstream.lock.json > lock.new && mv lock.new upstream.lock.json'
scenario 'delete the highest patchset' fail '最高编号补丁集 p4 不能删除' 'git rm --quiet -r patches/sets/4'
scenario 'delete a referenced patchset' fail '缺少通用补丁' 'git rm --quiet -r patches/sets/2'
scenario 'edit a sealed patchset' fail '已封印' 'printf "changed\n" >> patches/sets/1/common/0001-source.patch'
scenario 'new patchset below the highest' fail '新补丁集 p3 必须高于当前最高编号 p4' '
  mkdir -p patches/sets/3/common
  printf "diff --git a/src/lib.rs b/src/lib.rs\n" > patches/sets/3/common/0001-source.patch'

((failures == 0)) || exit 1
echo '补丁集封印规则校验通过'
