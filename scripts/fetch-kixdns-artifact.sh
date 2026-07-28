#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT=''
SCRIPT_DIRECTORY=''
WAIT_ATTEMPTS="${KIXDNS_ARTIFACT_WAIT_ATTEMPTS:-1}"
WAIT_SECONDS="${KIXDNS_ARTIFACT_WAIT_SECONDS:-20}"

fail() {
  printf '获取 KixDNS Artifact 失败：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null || fail "缺少命令 $1"
}

validate_slug() {
  local value=$1
  local label=$2
  [[ "${value}" =~ ^[A-Za-z0-9._/-]+$ && "${value}" != *..* ]] || fail "${label}格式无效"
}

validate_wait_policy() {
  [[ "${WAIT_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || fail 'Artifact 等待次数无效'
  [[ "${WAIT_SECONDS}" =~ ^[1-9][0-9]*$ ]] || fail 'Artifact 等待间隔无效'
  ((WAIT_ATTEMPTS <= 90)) || fail 'Artifact 等待次数超过上限'
  ((WAIT_SECONDS <= 60)) || fail 'Artifact 等待间隔超过上限'
}

workflow_is_pending() {
  local repository=$1
  local workflow=$2
  local branch=$3
  local response
  response="$(
    gh api --method GET "repos/${repository}/actions/workflows/${workflow}/runs" \
      -f branch="${branch}" -f per_page=30
  )"
  jq -e '[.workflow_runs[] | select(
    .event != "pull_request" and .status != "completed"
  )] | length > 0' <<< "${response}" >/dev/null
}

artifact_identity() {
  jq -ceS '{repository, source, commit, official_run_id, release_id, release_tag, compatibility, patchset, control_protocol}' "$1"
}

tracked_artifact() {
  local base=$1
  local lock_file=$2
  local architecture="${base##*-linux-}"
  [[ "${architecture}" =~ ^(x86_64|arm64)$ ]] || return 1
  bash "${SCRIPT_DIRECTORY}/kixdns-artifact-identity.sh" "${lock_file}" "${architecture}"
}

validate_architecture() {
  local artifact=$1
  local binary=$2
  local machine
  machine="$(LC_ALL=C readelf -h -- "${binary}" | awk -F: '/Machine:/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
  case "${artifact}" in
    *-x86_64) [[ "${machine}" == 'Advanced Micro Devices X86-64' ]] ;;
    *-arm64) [[ "${machine}" == 'AArch64' ]] ;;
    *) return 1 ;;
  esac
}

validate_candidate() {
  local directory=$1
  local run_commit=$2
  local expected_identity=$3
  local candidate_commit

  [[ -f "${directory}/kixdns" && ! -L "${directory}/kixdns" ]] || return 1
  [[ -f "${directory}/SHA256SUMS" && ! -L "${directory}/SHA256SUMS" ]] || return 1
  [[ -f "${directory}/upstream.lock.json" && ! -L "${directory}/upstream.lock.json" ]] || return 1
  (cd "${directory}" && sha256sum --check --strict --quiet SHA256SUMS) || return 1
  [[ "$(artifact_identity "${directory}/upstream.lock.json")" == "${expected_identity}" ]] || return 1
  validate_architecture "${ARTIFACT}" "${directory}/kixdns" || return 1

  candidate_commit="${run_commit}"
  if [[ -f "${directory}/KIXDNS_BUILD_COMMIT" ]]; then
    [[ ! -L "${directory}/KIXDNS_BUILD_COMMIT" ]] || return 1
    candidate_commit="$(tr -d '[:space:]' < "${directory}/KIXDNS_BUILD_COMMIT")"
    [[ "${candidate_commit}" == "${run_commit}" ]] || return 1
  fi
  [[ "${candidate_commit}" =~ ^[0-9a-f]{40}$ ]]
}

main() {
  [[ $# -eq 6 ]] || fail "用法：$0 <repository> <workflow> <branch> <artifact> <upstream-lock> <destination>"
  local repository=$1
  local workflow=$2
  local branch=$3
  ARTIFACT=$4
  local lock_file=$5
  local destination=$6
  local expected_identity
  local run_id
  local run_commit
  local staging
  SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

  require_command gh
  require_command jq
  require_command readelf
  require_command sha256sum
  validate_wait_policy
  validate_slug "${repository}" '仓库'
  validate_slug "${workflow}" '工作流'
  validate_slug "${branch}" '分支'
  validate_slug "${ARTIFACT}" 'Artifact'
  [[ -f "${lock_file}" && ! -L "${lock_file}" ]] || fail '上游锁定文件无效'
  [[ ! -e "${destination}" ]] || fail '目标目录已经存在'
  expected_identity="$(artifact_identity "${lock_file}")" || fail '上游锁定身份无效'
  ARTIFACT="$(tracked_artifact "${ARTIFACT}" "${lock_file}")" || fail '无法生成轨道 Artifact 名称'

  local attempt
  for ((attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++)); do
    while IFS=$'\t' read -r run_id run_commit; do
      [[ "${run_id}" =~ ^[0-9]+$ && "${run_commit}" =~ ^[0-9a-f]{40}$ ]] || continue
      staging="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kixdns-artifact.XXXXXX")"
      if gh run download "${run_id}" --repo "${repository}" --name "${ARTIFACT}" --dir "${staging}" >/dev/null 2>&1 \
        && validate_candidate "${staging}" "${run_commit}" "${expected_identity}"; then
        install -d -m 0755 "${destination}"
        install -m 0755 "${staging}/kixdns" "${destination}/kixdns"
        cp -- "${staging}/upstream.lock.json" "${destination}/upstream.lock.json"
        printf '%s\n' "${run_commit}" > "${destination}/KIXDNS_BUILD_COMMIT"
        printf '%s\n' "${run_id}" > "${destination}/KIXDNS_SOURCE_RUN_ID"
        rm -rf -- "${staging}"
        printf '已复用 KixDNS 构建：Run #%s，提交 %s\n' "${run_id}" "${run_commit}"
        return
      fi
      rm -rf -- "${staging}"
    done < <(
      gh api --method GET "repos/${repository}/actions/workflows/${workflow}/runs" \
        -f branch="${branch}" -f status=success -f per_page=30 \
        --jq '.workflow_runs[] | select(.event != "pull_request") | [.id, .head_sha] | @tsv'
    )

    if ((attempt == WAIT_ATTEMPTS)) || ! workflow_is_pending "${repository}" "${workflow}" "${branch}"; then
      break
    fi
    printf '等待 KixDNS Artifact：%s（第 %s/%s 次）\n' "${ARTIFACT}" "${attempt}" "${WAIT_ATTEMPTS}"
    sleep "${WAIT_SECONDS}"
  done

  fail "最近 30 次成功运行中没有身份匹配的 ${ARTIFACT}；请先手动运行 ${workflow}"
}

main "$@"
