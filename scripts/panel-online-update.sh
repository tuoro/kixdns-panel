#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="tuoro/kixdns-panel"
readonly STATUS_DIRECTORY="/var/lib/kixdns-panel-update"
readonly STATUS_FILE="${STATUS_DIRECTORY}/status.json"
readonly PANEL_ENV="/etc/kixdns-panel/panel.env"
readonly INSTALLER="/usr/local/libexec/kixdns-panel-one-click-install"
readonly PANEL_SERVER="/usr/local/bin/kixdns-panel-server"
TARGET_VERSION=""

write_status() {
  local state=$1
  local message=$2
  local temporary
  [[ -d ${STATUS_DIRECTORY} && ! -L ${STATUS_DIRECTORY} ]] || return 1
  temporary="$(mktemp "${STATUS_DIRECTORY}/.status.XXXXXX")"
  jq -n \
    --arg state "${state}" \
    --arg message "${message}" \
    --arg target_version "${TARGET_VERSION}" \
    --argjson updated_at "$(date +%s)" \
    '{state: $state, message: $message, target_version: $target_version, updated_at: $updated_at}' \
    > "${temporary}"
  chown root:kixdns "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${STATUS_FILE}"
}

fail_update() {
  local status=$?
  trap - ERR
  write_status failed "在线更新失败，请查看 kixdns-panel-update.service 日志" || true
  exit "${status}"
}

environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

trusted_root_executable() {
  local mode
  local path=$1
  [[ -x ${path} && -f ${path} && ! -L ${path} ]] || return 1
  [[ $(stat -c '%u' -- "${path}") == 0 ]] || return 1
  mode="$(stat -c '%a' -- "${path}")"
  [[ ${mode} =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#${mode} & 8#022) == 0))
}

main() {
  local current_release
  local current_version_floor
  local current_binary_release
  local latest_json
  local latest_version
  local newest
  if ! command -v curl >/dev/null || ! command -v jq >/dev/null || \
    ! command -v flock >/dev/null; then
    printf '%s\n' '面板在线更新缺少 curl、jq 或 flock' >&2
    return 127
  fi
  trap fail_update ERR
  trusted_root_executable "${INSTALLER}" || return 126
  trusted_root_executable "${PANEL_SERVER}" || return 126
  exec 9>/run/kixdns-panel-update.lock
  flock -n 9 || {
    TARGET_VERSION=""
    write_status failed "已有面板在线更新任务正在执行"
    return 1
  }
  write_status checking "正在检查最新正式版"
  sleep 2
  latest_json="$(curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'User-Agent: kixdns-panel-online-updater' \
    "https://api.github.com/repos/${REPOSITORY}/releases/latest")"
  latest_version="$(jq -er '.tag_name | select(type == "string")' <<< "${latest_json}")"
  [[ ${latest_version} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  TARGET_VERSION=${latest_version}
  current_release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  current_binary_release="v$("${PANEL_SERVER}" --version | awk 'NF >= 2 { print $NF; exit }')"
  [[ ${current_binary_release} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  current_version_floor=${current_binary_release}
  if [[ -n ${current_release} ]]; then
    [[ ${current_release} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    current_version_floor="$(printf '%s\n%s\n' "${current_release}" "${current_binary_release}" |
      sort -V | tail -n 1)"
  fi
  newest="$(printf '%s\n%s\n' "${current_version_floor}" "${latest_version}" | sort -V | tail -n 1)"
  [[ ${newest} == "${latest_version}" ]] || return 1
  if [[ ${current_release} == "${latest_version}" ]]; then
    write_status complete "当前面板已经是最新正式版"
    return
  fi
  write_status downloading "正在下载并校验 ${latest_version}"
  "${INSTALLER}" --version "${latest_version}" -- --panel-only-update
  write_status complete "面板已更新到 ${latest_version}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
