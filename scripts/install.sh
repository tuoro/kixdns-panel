#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PANEL_USER="kixdns-panel"
KIXDNS_USER="kixdns"
KIXDNS_GROUP="kixdns"
BACKUP_ROOT=""
INSTALL_MODE="auto"
INSTALL_KIND=""
KIXDNS_SERVICE_UNIT="kixdns.service"
# KixDNS 配置的默认目录，面板固定的位置；uninstall.sh 按同一个位置认出它。
# The KixDNS config's default directory, the panel's fixed location; uninstall.sh recognises it by the same location.
KIXDNS_CONFIG_DIRECTORY=/etc/kixdns
KIXDNS_CONFIG_PATH="${KIXDNS_CONFIG_DIRECTORY}/pipeline.json"
# 主机上已有 KixDNS 的 unit 里写着的配置路径。
# The config path the existing KixDNS's unit names.
KIXDNS_UNIT_CONFIG_PATH=""
KIXDNS_BINARY_PATH="/var/lib/kixdns-panel/bin/kixdns"
MANAGED_KIXDNS_BINARY="/var/lib/kixdns-panel/bin/kixdns"
EXISTING_KIXDNS_BINARY_PATH=""
KIXDNS_CONTROL_SOCKET="/run/kixdns/admin.sock"
KIXDNS_SERVICE_HELPER_SOCKET="/run/kixdns-panel/control.sock"
PANEL_CONFIG_DIRECTORY=/etc/kixdns-panel
PANEL_ENV=/etc/kixdns-panel/panel.env
# 迁移外部 KixDNS 时，面板管理的是原配置的一份副本，放在这个只有面板会建的目录里；原配置和它所在的目录一点不动，
# 卸载时恢复原来的 KixDNS，它用的还是迁移前的那份。uninstall.sh 按同一个位置认出副本。
# Migrating an external KixDNS, the panel manages a copy of the original config, kept in this directory that only the
# panel creates; the original config and its directory are left exactly as they were, so the original KixDNS restored
# on uninstall still runs the pre-migration one. uninstall.sh recognises the copy by the same location.
MIGRATED_KIXDNS_CONFIG_DIRECTORY=/etc/kixdns-panel/kixdns
MIGRATED_KIXDNS_CONFIG=/etc/kixdns-panel/kixdns/pipeline.json
# 迁移前原来的 KixDNS 的配置；只在面板改管它的副本时有值。
# The original KixDNS's config from before migration; set only when the panel manages a copy of it.
ORIGINAL_KIXDNS_CONFIG_PATH=""
# 受管 KixDNS 的服务沙箱看不到的目录：deploy/systemd/kixdns.service 的 ProtectHome 和 PrivateTmp。
# Directories the managed KixDNS's service sandbox cannot see: ProtectHome and PrivateTmp in deploy/systemd/kixdns.service.
KIXDNS_HIDDEN_DIRECTORIES=(/home /root /run/user /tmp /var/tmp)
# 原配置里写的 Geo 文件里面板读不到的那些，每行「  文件：原因」；迁移照常，安装结果里点名。
# The Geo files the original config names that the panel cannot read, one "  file：reason" per line; migration goes ahead and
# the install result names them.
PANEL_UNREADABLE_FILES=""
PANEL_SERVER_BINARY=/usr/local/bin/kixdns-panel-server
# 安装器会建的目录：面板状态目录（和 uninstall.sh 同一个）、在线更新状态目录、前端与自带 GeoSite 的目录、helper 所在的目录。
# The directories the installer creates: the panel's state directory (the same as uninstall.sh's), the online update status
# directory, the directory of the web assets and bundled GeoSite, and the one holding the helper.
PANEL_STATE_DIRECTORY=/var/lib/kixdns-panel
PANEL_UPDATE_DIRECTORY=/var/lib/kixdns-panel-update
PANEL_SHARE_DIRECTORY=/usr/share/kixdns-panel
LIBEXEC_DIRECTORY=/usr/local/libexec
# 这次运行开始时这几个账号和组在不在；回滚只删这次建的。默认当作在，没记下来时什么也不删。
# Whether these accounts and the group existed when this run began; rollback removes only those it created. They count as
# existing by default, so nothing is removed unless recorded.
PANEL_USER_EXISTED=true
KIXDNS_USER_EXISTED=true
KIXDNS_GROUP_EXISTED=true
GITHUB_TOKEN_FILE=/var/lib/kixdns-panel/github-token
# 与 uninstall.sh 相同的固定位置：面板 unit 只允许写 /var/lib/kixdns-panel。
# The same fixed location uninstall.sh uses: the panel unit may only write /var/lib/kixdns-panel.
PANEL_DATABASE=/var/lib/kixdns-panel/panel.db
SYSTEMD_UNIT_DIRECTORY=/etc/systemd/system
EXISTING_PANEL=false
EXISTING_KIXDNS=false
EXISTING_KIXDNS_UNIT=false
EXTERNAL_BACKUP=/var/lib/kixdns-panel/external-backup
CREATED_EXTERNAL_BACKUP=false
PRESERVE_KIXDNS_STATE=false
KIXDNS_WAS_ACTIVE=false
KIXDNS_WAS_ENABLED=false
KIXDNS_BINARY_CHANGED=false
KIXDNS_UNIT_CHANGED=false
KIXDNS_RESTART=false
PANEL_ONLY_UPDATE=false
REINSTALL=false
PANEL_RELEASE=""
PANEL_BUILD_COMMIT=""
KIXDNS_BUILD_COMMIT=""
KIXDNS_SOURCE_ID=""
# 完整包自带内核的来源：现在的安装包都是 fork 发布版；只更新面板时沿用原来的记录。
# Where the full package's kernel came from: current packages carry a fork release; a panel-only update keeps the old record.
KIXDNS_SOURCE=""
PREVIOUS_PANEL_LABEL=""
SERVICE_WAIT_SECONDS=15
SERVICE_STABLE_SECONDS=4

# 端口 53：谁占着、要不要由安装器关闭 systemd-resolved 的本机监听，以及实际改过什么。
# Port 53: who holds it, whether the installer should turn off systemd-resolved's stub, and what it changed.
PORT_CONFLICT=none
PORT_CONFLICT_PORT=""
PORT_HOLDER_NAME=""
PORT_HOLDER_PID=""
PORT_HOLDER_ADDRESS=""
RESOLVED_ACTION=none
RESOLVED_CHANGED=false
RESOLVED_PORT=""
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/kixdns-panel.conf
RESOLV_CONF=/etc/resolv.conf
RESOLVED_UPLINK_RESOLV_CONF=/run/systemd/resolve/resolv.conf
RESOLVED_STATE=/var/lib/kixdns-panel/resolved-stub
ONE_CLICK_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh"
# 和 uninstall.sh 同一个：本地的卸载命令随面板删掉以后接着卸载用的 / The same as uninstall.sh's: what carries an uninstall on
# once the local command is gone with the panel
UNINSTALL_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh"
# v4.3.4 及更早的 panel.env 示例里，可信代理那一行和它上面的说明：默认信任本机代理。现在的示例默认谁都不信，说明是下面两行。
# The trusted-proxies line of the panel.env example up to v4.3.4 and the comment above it: the local proxy was trusted by
# default. The current example trusts none by default, with the two comment lines below.
OLD_TRUSTED_PROXIES_COMMENT='# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。'
OLD_TRUSTED_PROXIES_LINE='KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128'
TRUSTED_PROXIES_COMMENT_1='# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。默认谁都不信。'
TRUSTED_PROXIES_COMMENT_2='# 面板在本机 Nginx 后面时写 127.0.0.1/32,::1/128；代理在容器或别的主机上时写它的精确 CIDR。'
# panel.env 还是旧示例的默认值和说明，这次换了说明：安装结果提醒一次 / panel.env still had the old example's default and
# comment, and this run replaced the comment: the install result says so once
TRUSTED_PROXIES_NOTICE=false

usage() {
  cat <<'EOF'
用法：sudo bash scripts/install.sh [选项]

  --replace-existing    主机上已有不是本面板安装的 KixDNS 时，同意迁移为增强版；无人值守安装必需
  --reinstall           已安装同一版本时仍重新安装，用于修复被改动或损坏的安装
  --panel-only-update   只更新面板，和系统页的「在线更新」一样；不停止也不替换 KixDNS
  --kixdns-unit UNIT    既有 KixDNS 的 systemd unit，默认 kixdns.service
  --kixdns-config PATH  既有 KixDNS 配置路径，默认从 unit 中检测
  --kixdns-binary PATH  既有 KixDNS 程序路径，默认从 unit 中检测
  --control-socket PATH KixDNS 控制 Socket，默认 /run/kixdns/admin.sock
  -h, --help            显示帮助

检测到已有 KixDNS 时，交互终端会先说明迁移会做什么再询问，默认不迁移；无人值守安装
必须带 --replace-existing。迁移保留配置和运行状态，原 unit 会备份，卸载面板时选择
移除增强版即可恢复原来的 KixDNS。

同一版本再次运行且面板在运行时不会改动任何东西；面板没在运行时会自动重新安装修复。
KixDNS 只在程序或 unit 确实变化时才会重启。
EOF
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-existing)
        # 旧参数单独给出去向：该模式从未能正常运行，不能让用户以为只是拼错了。
        # The old flag gets its own answer: the mode never worked, so it must not read like a typo.
        fail "「仅安装面板」模式已移除：它装出的面板无法启动。已有 KixDNS 时改用 --replace-existing 迁移为增强版；迁移会备份原 unit 与运行状态，卸载面板（sudo kixdns-panel-uninstall）时选择移除增强版即可恢复原来的 KixDNS。"
        ;;
      --replace-existing) INSTALL_MODE="managed" ;;
      --reinstall) REINSTALL=true ;;
      --kixdns-unit)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_SERVICE_UNIT=$2
        shift
        ;;
      --kixdns-config)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONFIG_PATH=$2
        shift
        ;;
      --kixdns-binary)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_BINARY_PATH=$2
        shift
        ;;
      --control-socket)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONTROL_SOCKET=$2
        shift
        ;;
      --panel-only-update)
        PANEL_ONLY_UPDATE=true
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "未知参数：$1" ;;
    esac
    shift
  done
}

validate_unit() {
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）：这里放行的名字面板启动时必须也放行。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh): what passes here must pass at panel start.
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${KIXDNS_SERVICE_UNIT} != *..* ]] ||
    fail "KixDNS systemd unit 名称无效"
}

# 路径里的 .、.. 和空的一段（//，或者结尾的 /）都不收：dirname 看到的目录会和真正写进去的目录对不上，配置目录的规则
# （require_dedicated_config_directory）就被绕开了，例如 /etc/kixdns/../x.json 实际放在 /etc。
# Paths with a ., .. or empty component (//, or a trailing /) are refused: the directory dirname sees would differ from the
# one really written to, bypassing the config-directory rules (require_dedicated_config_directory); /etc/kixdns/../x.json,
# say, lands in /etc.
validate_absolute_path() {
  local label=$1
  local path=$2
  [[ ${path} == /* && ${#path} -le 4096 && ! ${path} =~ [[:space:]] &&
    ${path}/ != *//* && ${path}/ != */./* && ${path}/ != */../* ]] ||
    fail "${label}必须是绝对路径，不含空白，也不含 .、.. 或空的一段（//）"
}

environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

state_file_value() {
  local file=$1
  local key=$2
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

fail() {
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

cancel_install() {
  # 取消是用户的选择，不是失败，所以不带「安装失败」前缀。
  # Cancelling is the user's choice, not a failure, so it carries no failure prefix.
  printf '已取消安装，现有 KixDNS 未作修改。\n' >&2
  exit 1
}

abort_install() {
  # 回滚已经挂上之后的失败：fail 的 exit 不会触发 ERR，必须显式回滚。
  # A failure once rollback is armed: fail's exit does not fire ERR, so roll back explicitly.
  printf '安装失败：%s\n' "$*" >&2
  rollback_install 1
}

refuse_legacy_panel() {
  # 旧的「仅安装面板」主机从未跑起来过；在它上面升级只会得到另一个无法管理的面板。
  # Hosts from the removed panel-only mode never ran; upgrading in place would only yield another unmanageable panel.
  # 只剩 panel.env 而面板程序已卸载时不拒绝：那是按提示卸载并保留了配置，重新安装会删掉这个旧键。
  # A leftover panel.env without the panel program is not refused: that is an uninstall that kept the
  # config as advised, and a fresh install strips the stale key.
  [[ -e ${PANEL_SERVER_BINARY} ]] || return 0
  [[ $(environment_value KIXDNS_MANAGEMENT_ENABLED || true) == false ]] || return 0
  fail "这台主机装的是已移除的「仅安装面板」模式，不能直接升级或更新。
先运行 sudo kixdns-panel-uninstall 卸载面板（原来的 KixDNS 保持不变），
再重新安装，并在提示时选择迁移为增强版。"
}

# 一键安装遇到 GitHub 限流时，让用户先用 sudo 写入 Token；面板以 kixdns-panel 运行，读不了 root 的 0600 文件。
# 符号链接不跟随，留给面板报告路径不安全。
# One-click install tells rate-limited users to write the token with sudo; the panel runs as kixdns-panel
# and cannot read a root-owned 0600 file. Symlinks are not followed; the panel reports them as unsafe.
adopt_github_token() {
  [[ -f ${GITHUB_TOKEN_FILE} && ! -L ${GITHUB_TOKEN_FILE} ]] || return 0
  chown -h "${PANEL_USER}:${KIXDNS_GROUP}" -- "${GITHUB_TOKEN_FILE}"
  chmod 0600 -- "${GITHUB_TOKEN_FILE}"
}

load_existing_panel_settings() {
  local value
  [[ -x ${PANEL_SERVER_BINARY} && -f ${PANEL_ENV} ]] || return 0
  EXISTING_PANEL=true
  INSTALL_MODE="managed"
  value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
  value="$(environment_value KIXDNS_CONFIG || true)"
  [[ -z ${value} ]] || KIXDNS_CONFIG_PATH=${value}
  value="$(environment_value KIXDNS_BINARY || true)"
  [[ -z ${value} ]] || KIXDNS_BINARY_PATH=${value}
  value="$(environment_value KIXDNS_CONTROL_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_CONTROL_SOCKET=${value}
  value="$(environment_value KIXDNS_SERVICE_HELPER_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_HELPER_SOCKET=${value}
  PREVIOUS_PANEL_LABEL="$(installed_panel_label)"
}

validate_panel_only_update() {
  [[ ${PANEL_ONLY_UPDATE} == true ]] || return 0
  [[ ${EXISTING_PANEL} == true ]] || fail "--panel-only-update 只适用于已安装的 KixDNS 面板；首次安装去掉这个参数"
}

package_panel_label() {
  if [[ -n ${PANEL_RELEASE} ]]; then
    printf '%s\n' "${PANEL_RELEASE}"
  else
    printf '构建 %.12s\n' "${PANEL_BUILD_COMMIT}"
  fi
}

installed_panel_label() {
  local release
  local commit
  release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  commit="$(environment_value KIXDNS_PANEL_INSTALLED_COMMIT || true)"
  if [[ -n ${release} ]]; then
    printf '%s\n' "${release}"
  elif [[ -n ${commit} ]]; then
    printf '构建 %.12s\n' "${commit}"
  else
    printf '旧版本\n'
  fi
}

same_panel_version_installed() {
  local release
  local commit
  [[ ${EXISTING_PANEL} == true ]] || return 1
  release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  commit="$(environment_value KIXDNS_PANEL_INSTALLED_COMMIT || true)"
  # 正式包比 Release 标签；任一方没有标签（开发构建）时退回比较构建提交。
  # Release packages compare tags; when either side has none (a dev build), fall back to the build commit.
  if [[ -n ${release} && -n ${PANEL_RELEASE} ]]; then
    [[ ${release} == "${PANEL_RELEASE}" ]]
    return
  fi
  [[ -n ${commit} && ${commit,,} == "${PANEL_BUILD_COMMIT,,}" ]]
}

skip_if_already_installed() {
  [[ ${REINSTALL} == false ]] || return 0
  same_panel_version_installed || return 0
  # 版本相同但面板没在运行，说明安装坏了；直接退出等于把它当成好的，改按 --reinstall 修复。
  # Same version but the panel is not running means a broken install; exiting would pass it off as fine, so repair as --reinstall.
  if ! systemctl is-active --quiet kixdns-panel.service 2>/dev/null; then
    printf 'KixDNS 面板 %s 已安装，但面板没有在运行，现在按 --reinstall 重新安装以修复。\n' "$(package_panel_label)"
    REINSTALL=true
    return 0
  fi
  printf 'KixDNS 面板 %s 已安装，未作任何修改。\n' "$(package_panel_label)"
  printf '需要修复安装时，加 --reinstall 重新运行。\n'
  exit 0
}

detect_service_argument() {
  local name=$1
  local exec_start
  exec_start="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${exec_start} =~ --${name}=([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ ${exec_start} =~ --${name}[[:space:]]+([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

# 迁移和升级都要恢复原来的运行状态，所以在任何改动之前记下。必须写成 if：v3.1.0 以
# `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true` 结尾，未启用的 KixDNS 让函数返回非零，set -e 无声退出。
# Migration and upgrade both restore the original running state, so record it before any change. Keep the
# ifs: v3.1.0 ended with `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true`, and a never-enabled KixDNS
# made the function return non-zero so set -e exited silently.
capture_managed_service_state() {
  if systemctl is-active --quiet "${KIXDNS_SERVICE_UNIT}" 2>/dev/null; then
    KIXDNS_WAS_ACTIVE=true
  fi
  if systemctl is-enabled --quiet "${KIXDNS_SERVICE_UNIT}" 2>/dev/null; then
    KIXDNS_WAS_ENABLED=true
  fi
}

detect_existing_kixdns() {
  local detected
  if systemctl cat "${KIXDNS_SERVICE_UNIT}" >/dev/null 2>&1; then
    EXISTING_KIXDNS_UNIT=true
  fi
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]] || command -v kixdns >/dev/null 2>&1 ||
    [[ -e /usr/local/bin/kixdns || -e ${MANAGED_KIXDNS_BINARY} ]]; then
    EXISTING_KIXDNS=true
  fi
  capture_managed_service_state
  [[ ${EXISTING_PANEL} == false ]] || return 0
  detected="$(detect_service_argument config || true)"
  if [[ -n ${detected} ]]; then
    KIXDNS_CONFIG_PATH=${detected}
    KIXDNS_UNIT_CONFIG_PATH=${detected}
  fi
  detected="$(detect_service_argument admin-socket || true)"
  [[ -z ${detected} ]] || KIXDNS_CONTROL_SOCKET=${detected}
  detected="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${detected} =~ path=([^[:space:];]+) ]]; then
    KIXDNS_BINARY_PATH=${BASH_REMATCH[1]}
  elif command -v kixdns >/dev/null 2>&1; then
    KIXDNS_BINARY_PATH="$(command -v kixdns)"
  elif [[ -x /usr/local/bin/kixdns ]]; then
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
  fi
}

running_state_text() {
  if [[ $1 == true ]]; then
    printf '运行中'
  else
    printf '已停止'
  fi
}

print_migration_plan() {
  local enabled="未设开机自启"
  [[ ${KIXDNS_WAS_ENABLED} == false ]] || enabled="开机自启"
  printf '\n检测到主机上已有 KixDNS（不是由本面板安装的）：\n'
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]]; then
    printf '  服务：%s（%s，%s）\n' "${KIXDNS_SERVICE_UNIT}" "$(running_state_text "${KIXDNS_WAS_ACTIVE}")" "${enabled}"
  else
    printf '  服务：没有找到 %s\n' "${KIXDNS_SERVICE_UNIT}"
  fi
  if [[ -f ${KIXDNS_CONFIG_PATH} ]]; then
    printf '  配置：%s\n' "${KIXDNS_CONFIG_PATH}"
  else
    printf '  配置：%s（不存在，将写入默认配置）\n' "${KIXDNS_CONFIG_PATH}"
  fi
  if [[ -e ${KIXDNS_BINARY_PATH} ]]; then
    printf '  程序：%s\n' "${KIXDNS_BINARY_PATH}"
  else
    printf '  程序：没有找到\n'
  fi
  printf '\n迁移为增强版会：\n'
  if ! config_copied_on_migration "${KIXDNS_BINARY_PATH}"; then
    printf '  - 配置文件留在原位置，改由面板管理\n'
  elif [[ -f ${KIXDNS_CONFIG_PATH} ]]; then
    printf '  - 把配置复制到 %s，面板只改这份副本；原来的配置文件和它所在的目录不动\n' "${MIGRATED_KIXDNS_CONFIG}"
  else
    printf '  - 默认配置写到 %s，由面板管理；不在原位置创建文件\n' "${MIGRATED_KIXDNS_CONFIG}"
  fi
  printf '  - 用增强版替换 KixDNS 程序和 systemd unit\n'
  printf '  - 把原 unit 与运行状态备份到 %s\n' "${EXTERNAL_BACKUP}"
  printf '  - 保持原来的运行状态（现在%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
  printf '  - 卸载面板（sudo kixdns-panel-uninstall）时选择移除增强版，即可恢复原来的 KixDNS\n\n'
}

unattended_migration_message() {
  printf '检测到主机上已有 KixDNS（%s），无人值守安装需要明确同意迁移为增强版：\n' "${KIXDNS_SERVICE_UNIT}"
  printf '  sudo bash ./scripts/install.sh --replace-existing\n'
  printf '  curl -fsSL %s | sudo bash -s -- --replace-existing\n' "${ONE_CLICK_URL}"
  printf '迁移保留配置和运行状态，原 unit 备份到 %s，卸载面板时可恢复。' "${EXTERNAL_BACKUP}"
}

# 读一个 y/N 回答，认不出的输入最多再问两次；三次都认不出按「否」处理。
# Read a y/N answer, re-asking up to twice on unrecognised input; three misses count as "no".
ask_yes_no() {
  local question=$1
  local answer
  local attempt
  for ((attempt = 1; attempt <= 3; attempt++)); do
    printf '%s[y/N]：' "${question}" >&3
    answer=""
    IFS= read -r answer <&3 || true
    case ${answer} in
      [yY] | [yY][eE][sS]) return 0 ;;
      "" | [nN] | [nN][oO]) return 1 ;;
      *) printf '输入 y 或 n。\n' >&3 ;;
    esac
  done
  return 1
}

# 主机上已有的 KixDNS 是上次卸载时保留下来的面板自带的那个：它跑的是面板状态目录里的程序。这不是外部安装，没有要迁移的。
# The KixDNS already on the host is the panel's own, kept by an earlier uninstall: it runs the program in the panel's state
# directory. That is no external install and there is nothing to migrate.
existing_kixdns_is_panels_own() {
  [[ ${EXISTING_KIXDNS} == true && ${KIXDNS_BINARY_PATH} == "${MANAGED_KIXDNS_BINARY}" ]]
}

# 迁移前原来的 KixDNS 的备份；和 uninstall.sh 的同名函数一样，以前重装时备份的面板自带 KixDNS 不算。
# The backup of the KixDNS from before migration; as in uninstall.sh's function of the same name, one an older reinstall made
# of the panel's own KixDNS does not count.
external_backup_present() {
  [[ -f ${EXTERNAL_BACKUP}/install.env ]] || return 1
  [[ $(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_BINARY || true) != "${MANAGED_KIXDNS_BINARY}" ]]
}

choose_install_mode() {
  if [[ ${INSTALL_MODE} == "auto" ]] && { [[ ${EXISTING_KIXDNS} == false ]] || existing_kixdns_is_panels_own; }; then
    INSTALL_MODE="managed"
    return 0
  fi
  [[ ${INSTALL_MODE} == "auto" ]] || return 0
  # 裸 exec 上的重定向会永久生效：写成 `exec 3<>/dev/tty 2>/dev/null` 会让之后所有错误和回滚信息消失。
  # A redirection on a bare exec is permanent: `exec 3<>/dev/tty 2>/dev/null` would hide every later error and rollback message.
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    fail "$(unattended_migration_message)"
  fi
  print_migration_plan >&3
  if ask_yes_no "迁移为增强版？"; then
    exec 3>&-
    INSTALL_MODE="managed"
    return 0
  fi
  exec 3>&-
  cancel_install
}

determine_install_kind() {
  if [[ ${PANEL_ONLY_UPDATE} == true ]]; then
    INSTALL_KIND=panel-only
  elif [[ ${EXISTING_PANEL} == true ]]; then
    INSTALL_KIND=upgrade
  elif existing_kixdns_is_panels_own; then
    # 接回上次卸载时保留的面板自带 KixDNS：不备份、不复制配置，接着原地管理 / Taking back the panel's own KixDNS kept by
    # an earlier uninstall: no backup, no config copy, managed in place as before
    INSTALL_KIND=reclaim
  elif [[ ${EXISTING_KIXDNS} == true ]]; then
    INSTALL_KIND=migrate
  else
    INSTALL_KIND=fresh
  fi
  if [[ ${INSTALL_KIND} == upgrade || ${INSTALL_KIND} == migrate || ${INSTALL_KIND} == reclaim ]]; then
    PRESERVE_KIXDNS_STATE=true
  fi
}

# 接回面板自带的 KixDNS 前说明会怎样：不用问，它本来就是面板的。/ Before taking back the panel's own KixDNS, say what happens:
# there is nothing to ask, it was the panel's all along.
print_reclaim_plan() {
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]]; then
    printf '检测到上次卸载时保留的 KixDNS（%s，%s），接着由面板管理。\n' "${KIXDNS_SERVICE_UNIT}" "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
  else
    printf '检测到上次卸载时保留的 KixDNS 程序，接着由面板管理。\n'
  fi
  print_reclaim_backup_note
}

print_reclaim_backup_note() {
  if external_backup_present; then
    printf '迁移前原来的 KixDNS 的备份还在 %s，以后卸载时选择移除增强版即可恢复。\n' "${EXTERNAL_BACKUP}"
  else
    printf '它是面板自己装的，这次不另做备份；以后卸载时选择移除 KixDNS，会把它删掉。\n'
  fi
}

# 上次卸载恢复原来的 KixDNS 没做完（uninstall.sh 的 restore_incomplete 标了记号），备份是有意留着、等重跑卸载接着恢复的。这时
# 安装不能把它当成过期备份换掉：新的备份记的会是恢复到一半的样子，迁移前的状态就丢了。在改动主机之前拒绝。
# An earlier uninstall did not finish restoring the original KixDNS (uninstall.sh's restore_incomplete left its mark), and the
# backup was kept on purpose for a rerun to carry the restore on. Installing must not replace it as stale: the new backup
# would record the half-restored state and the pre-migration one would be lost. Refuse before the host is touched.
refuse_unfinished_restore() {
  local marker=${EXTERNAL_BACKUP}/restore-incomplete
  local options
  local unit
  [[ -f ${marker} ]] || return 0
  options="$(head -n 1 -- "${marker}")"
  [[ ${options} =~ ^--(keep|remove)-config$ ]] || options=--keep-config
  unit="$(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_SERVICE_UNIT || true)"
  [[ ${unit} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${unit} != *..* ]] || unit=${KIXDNS_SERVICE_UNIT}
  fail "上次卸载没有把原来的 KixDNS 恢复完，迁移前的备份还在 ${EXTERNAL_BACKUP}。先查明原因（journalctl -u ${unit} -n 50 --no-pager），再用同样的选项重新运行卸载，恢复做完以后再安装：
  curl -fsSL ${UNINSTALL_URL} | sudo bash -s -- --remove-kixdns ${options} --yes
不再恢复原来的 KixDNS 的话，删掉这份备份再安装：sudo rm -rf ${EXTERNAL_BACKUP}"
}

validate_install_mode() {
  local config_parent
  refuse_unfinished_restore
  validate_unit
  validate_absolute_path "KixDNS 配置路径" "${KIXDNS_CONFIG_PATH}"
  validate_absolute_path "KixDNS 二进制路径" "${KIXDNS_BINARY_PATH}"
  validate_absolute_path "KixDNS 控制 Socket 路径" "${KIXDNS_CONTROL_SOCKET}"
  validate_absolute_path "面板服务控制 helper Socket" "${KIXDNS_SERVICE_HELPER_SOCKET}"
  [[ $(dirname -- "${KIXDNS_SERVICE_HELPER_SOCKET}") == /run/kixdns-panel ]] ||
    fail "面板服务控制 helper Socket 必须位于 /run/kixdns-panel"
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  [[ ${config_parent} != / && ! -L ${config_parent} ]] ||
    fail "KixDNS 配置不能直接位于根目录或符号链接目录"
  if [[ -e ${KIXDNS_CONFIG_PATH} || -L ${KIXDNS_CONFIG_PATH} ]]; then
    [[ -f ${KIXDNS_CONFIG_PATH} && ! -L ${KIXDNS_CONFIG_PATH} ]] ||
      fail "受管 KixDNS 配置必须是普通文件"
  fi
  EXISTING_KIXDNS_BINARY_PATH=${KIXDNS_BINARY_PATH}
  KIXDNS_BINARY_PATH=${MANAGED_KIXDNS_BINARY}
  plan_migrated_config
}

# 面板原子写配置（同一目录里写临时文件再改名），所以 install_configuration 把配置所在的目录交给它：改归 kixdns-panel、
# 权限 0750，面板 unit 的 ReadWritePaths 放开它。安装器不改、也不让面板写它没建的目录，所以这个目录只能是：panel.env 记下的、
# 或者主机上已有 KixDNS 的 unit 写着的配置所在的目录（以前就交给了面板，照旧：v4.3.4 及更早原地迁移的主机因此照常升级）；
# 还不存在、由安装器新建的目录；面板固定的 /etc/kixdns 和迁移副本的目录。除了记录里的，放着 panel.env 的面板配置目录即使
# 还不存在也不行：面板能改 panel.env，下次以 root 运行的安装器就会照着它改别的目录。要在 validate_install_mode 之后、
# 改动主机之前调用：迁移时检查的是副本，不是原配置。
# The panel writes its config atomically (a temporary file in the same directory, then a rename), so install_configuration
# hands it the config's directory: owner kixdns-panel, mode 0750, opened by the panel unit's ReadWritePaths. The installer
# neither changes nor opens for the panel a directory it did not create, so that directory may only be: the directory of
# the config panel.env records or the existing KixDNS's unit names (handed to the panel before and kept as it is, which keeps
# hosts migrated in place by v4.3.4 and earlier upgrading); one that does not exist yet, which the installer creates; the
# panel's fixed /etc/kixdns or the migration copy's directory. Unless recorded, the panel's config directory, which holds
# panel.env, does not qualify even before it exists: a panel that could rewrite panel.env would steer the next installer run,
# as root, onto other directories. Call it after validate_install_mode and before the host is touched: on migration the copy
# is checked, not the original.
require_dedicated_config_directory() {
  local config_parent
  local recorded
  local reason
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  for recorded in "$(environment_value KIXDNS_CONFIG || true)" "${KIXDNS_UNIT_CONFIG_PATH}"; do
    [[ -z ${recorded} || $(dirname -- "${recorded}") != "${config_parent}" ]] || return 0
  done
  if [[ ${config_parent} == "${PANEL_CONFIG_DIRECTORY}" ]]; then
    reason="这里的 panel.env 只能由 root 修改"
  elif [[ ! -e ${config_parent} || ${config_parent} == "${KIXDNS_CONFIG_DIRECTORY}" ||
    ${config_parent} == "${MIGRATED_KIXDNS_CONFIG_DIRECTORY}" ]]; then
    return 0
  else
    reason="这个目录已经存在，安装器不会把它交给面板"
  fi
  fail "KixDNS 配置不能放在 ${config_parent}：面板要能写配置所在的目录，而${reason}。
换一个还不存在的目录，或者去掉 --kixdns-config，用默认的 ${KIXDNS_CONFIG_DIRECTORY}/pipeline.json；要沿用已有的配置，先把它复制过去。"
}

# 外部 KixDNS 迁移时面板改管原配置的副本。面板自己留下的 KixDNS（上次卸载时保留的）不是外部安装，配置本来就归面板；
# 配置已经在副本的位置时也一样，照旧原地管理。
# Migrating an external KixDNS, the panel manages a copy of the original config. The panel's own KixDNS kept by an
# earlier uninstall is no external install and its config is the panel's already; so is a config already where the copy
# goes. Both stay managed in place.
config_copied_on_migration() {
  local binary=$1
  [[ ${binary} != "${MANAGED_KIXDNS_BINARY}" && ${KIXDNS_CONFIG_PATH} != "${MIGRATED_KIXDNS_CONFIG}" ]]
}

plan_migrated_config() {
  [[ ${INSTALL_KIND} == migrate ]] || return 0
  config_copied_on_migration "${EXISTING_KIXDNS_BINARY_PATH}" || return 0
  # install -d 会顺着符号链接改目标的属主和权限 / install -d would change the owner and mode of a symlink's target
  [[ ! -L ${PANEL_CONFIG_DIRECTORY} && ! -L ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} ]] ||
    fail "${PANEL_CONFIG_DIRECTORY} 和 ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} 不能是符号链接"
  ORIGINAL_KIXDNS_CONFIG_PATH=${KIXDNS_CONFIG_PATH}
  KIXDNS_CONFIG_PATH=${MIGRATED_KIXDNS_CONFIG}
  require_original_files_readable
}

# 原配置里写的文件：以 / 开头、存在又不是目录的 JSON 字符串。KixDNS 只读文件；写着却不存在的文件，原来的 KixDNS
# 一样跳过。带转义的字符串不算，路径里没有。
# The files the original config names: JSON strings starting with / that exist and are not directories. KixDNS reads
# files only, and a named file that does not exist is skipped by the original KixDNS too. Strings with escapes do not
# count; paths have none.
original_config_files() {
  local path
  grep -oE '"/[^"\\]*"' -- "${ORIGINAL_KIXDNS_CONFIG_PATH}" 2>/dev/null | sed -e 's/^"//' -e 's/"$//' | sort -u |
    while IFS= read -r path; do
      if [[ -e ${path} && ! -d ${path} ]]; then
        printf '%s\n' "${path}"
      fi
    done
}

# 原配置里写的、面板自己也读的 Geo 文件：settings 里 geosite_data_paths 的每一项，和 geoip_db_path、geoip_dat_path（面板挑
# GeoSite 分类、给 IP 标地区时读，见 panel-server 的 app/geo.rs）。和 original_config_files 一样只算存在又不是目录的绝对路径。
# The Geo files the original config names that the panel reads too: each entry of geosite_data_paths in settings, and
# geoip_db_path and geoip_dat_path (read when picking GeoSite categories and labelling IP regions, see panel-server's
# app/geo.rs). As in original_config_files, only absolute paths that exist and are not directories count.
original_config_geo_files() {
  local flattened
  local path
  flattened="$(tr '\n' ' ' < "${ORIGINAL_KIXDNS_CONFIG_PATH}" 2>/dev/null || true)"
  {
    grep -oE '"geosite_data_paths"[[:space:]]*:[[:space:]]*\[[^]]*\]' <<< "${flattened}" || true
    grep -oE '"geoip_(db|dat)_path"[[:space:]]*:[[:space:]]*"[^"\\]*"' <<< "${flattened}" || true
  } | { grep -oE '"/[^"\\]*"' || true; } | sed -e 's/^"//' -e 's/"$//' | sort -u |
    while IFS= read -r path; do
      if [[ -e ${path} && ! -d ${path} ]]; then
        printf '%s\n' "${path}"
      fi
    done
}

# 以一个服务账号的身份（主组 kixdns）试读一个文件。账号还没建时用 nobody 的 UID 代替：新建的账号同样不拥有任何文件。
# 组还没建时用 nogroup 的 GID，同理。
# Try reading a file as a service account would (its primary group kixdns). Before the account exists, nobody's UID stands
# in for it: a new account owns no files either. Likewise nogroup's GID before the group exists.
account_can_read() {
  local account=$1
  local file=$2
  local group
  group="$(getent group "${KIXDNS_GROUP}" | cut -d: -f3 || true)"
  if id -u "${account}" >/dev/null 2>&1; then
    setpriv --reuid="${account}" --regid="${group:-65534}" --init-groups -- test -r "${file}"
  else
    setpriv --reuid=65534 --regid="${group:-65534}" --clear-groups -- test -r "${file}"
  fi
}

# 受管 KixDNS（kixdns 账号）读不读得到 / Whether the managed KixDNS (the kixdns account) can read it
kixdns_can_read() {
  account_can_read "${KIXDNS_USER}" "$1"
}

# 面板（kixdns-panel 账号，主组同样是 kixdns）读不读得到 / Whether the panel (the kixdns-panel account, whose primary group
# is kixdns too) can read it
panel_can_read() {
  account_can_read "${PANEL_USER}" "$1"
}

# 迁移后 KixDNS 读的是副本，原配置所在的目录不再为它放开（以前原地接管时会归到 kixdns 组）。原配置里写的文件它读不到时，
# 在改动主机之前停下，点名每个文件和原因；否则装好以后分流少了 GeoSite、DoH 证书读不到，原因却不在眼前。
# After migration KixDNS reads the copy, and the original config's directory is no longer opened for it (the in-place
# takeover used to hand it to the kixdns group). When it cannot read a file the original config names, stop before the
# host is touched and name each file and why; otherwise routing would lose its GeoSite or DoH its certificate after the
# install, with the cause nowhere in sight.
require_original_files_readable() {
  local files
  local file
  local directory
  local reason
  local unreadable=""
  files="$(original_config_files || true)"
  [[ -n ${files} ]] || return 0
  type -P setpriv >/dev/null ||
    fail "系统缺少 setpriv（util-linux），无法确认迁移后的 KixDNS 能读到原配置里写的文件"
  while IFS= read -r file; do
    reason=""
    for directory in "${KIXDNS_HIDDEN_DIRECTORIES[@]}"; do
      if [[ ${file} == "${directory}"/* ]]; then
        reason="KixDNS 的服务看不到 ${directory} 里的文件"
        break
      fi
    done
    if [[ -z ${reason} ]] && ! kixdns_can_read "${file}"; then
      reason="kixdns 账号没有读取权限"
    fi
    [[ -z ${reason} ]] || unreadable+="  ${file}：${reason}"$'\n'
  done <<< "${files}"
  [[ -z ${unreadable} ]] || fail "迁移后的 KixDNS 以 kixdns 账号运行，读不到原配置 ${ORIGINAL_KIXDNS_CONFIG_PATH} 里写的这些文件：
${unreadable}迁移不会改动原来的文件和目录。让 kixdns 账号能读到它们（放宽权限，或移到别处并改原配置）后重新运行；现有 KixDNS 未作修改。"
  note_panel_unreadable_files
}

# 面板（kixdns-panel 账号）自己也读原配置里写的 Geo 文件。读不到只是面板上挑 GeoSite 分类、给 IP 标地区时缺了它们，DNS 照常，
# 所以不拒绝迁移，记下来在安装结果里点名，好让人去改权限。面板 unit 和 KixDNS 的 unit 藏起同样的目录，上面已经确认这些文件不在
# 里面，面板读不到就只会是权限。
# The panel (the kixdns-panel account) reads the Geo files the original config names too. When it cannot, the panel only
# lacks them for picking GeoSite categories and labelling IP regions while DNS works as before, so migration is not refused:
# the files are noted and named in the install result so the permissions can be fixed. The panel unit hides the same
# directories as the KixDNS unit, and the files were found above to lie outside them, so permissions are the only reason.
note_panel_unreadable_files() {
  local file
  PANEL_UNREADABLE_FILES=""
  while IFS= read -r file; do
    [[ -n ${file} ]] || continue
    panel_can_read "${file}" || PANEL_UNREADABLE_FILES+="  ${file}：kixdns-panel 账号没有读取权限"$'\n'
  done < <(original_config_geo_files || true)
}

render_kixdns_unit() {
  awk -v config_path="${KIXDNS_CONFIG_PATH}" -v control_socket="${KIXDNS_CONTROL_SOCKET}" '
    /^ConditionPathExists=/ { print "ConditionPathExists=" config_path; next }
    /^ExecStart=/ {
      print "ExecStart=/var/lib/kixdns-panel/bin/kixdns run --config " config_path " --admin-socket " control_socket
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns.service"
}

file_sha256() {
  sha256sum -- "$1" | awk '{ print $1 }'
}

plan_kixdns_changes() {
  local unit_file=${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}
  KIXDNS_BINARY_CHANGED=false
  KIXDNS_UNIT_CHANGED=false
  KIXDNS_RESTART=false
  [[ ${INSTALL_KIND} != panel-only ]] || return 0
  # 同一个 KixDNS 重装时不停服务：DNS 中断只在程序或 unit 真的变了时才值得。
  # Reinstalling the same KixDNS does not stop it: a DNS outage is only worth it when the binary or unit really changed.
  if [[ ! -f ${MANAGED_KIXDNS_BINARY} ]] ||
    [[ $(file_sha256 "${PACKAGE_ROOT}/bin/kixdns") != "$(file_sha256 "${MANAGED_KIXDNS_BINARY}")" ]]; then
    KIXDNS_BINARY_CHANGED=true
  fi
  if [[ ! -f ${unit_file} ]] || [[ $(render_kixdns_unit) != "$(<"${unit_file}")" ]]; then
    KIXDNS_UNIT_CHANGED=true
  fi
  if [[ ${KIXDNS_WAS_ACTIVE} == true && (${KIXDNS_BINARY_CHANGED} == true || ${KIXDNS_UNIT_CHANGED} == true) ]]; then
    KIXDNS_RESTART=true
  fi
}

kixdns_replaced() {
  [[ ${INSTALL_KIND} != panel-only && (${KIXDNS_BINARY_CHANGED} == true || ${KIXDNS_UNIT_CHANGED} == true) ]]
}

# 输出 KixDNS 要监听的「协议 地址」；配置里没写时按上游默认的 0.0.0.0:53。
# Print the "protocol address" pairs KixDNS will listen on; missing settings fall back to upstream's 0.0.0.0:53.
kixdns_listen_addresses() {
  # 迁移的副本要到安装那一步才写出来，在那之前按原配置查 / The migration copy is only written at install time; until then read the original
  local config=${ORIGINAL_KIXDNS_CONFIG_PATH:-${KIXDNS_CONFIG_PATH}}
  local protocol
  local value
  [[ -f ${config} ]] || config=${PACKAGE_ROOT}/deploy/config/pipeline.json
  for protocol in udp tcp; do
    value="$(grep -oE "\"bind_${protocol}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "${config}" 2>/dev/null |
      head -n 1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
    printf '%s %s\n' "${protocol}" "${value:-0.0.0.0:53}"
  done
}

strip_address_host() {
  local host=$1
  host=${host%%\%*}
  host=${host#\[}
  host=${host%\]}
  printf '%s\n' "${host}"
}

addresses_overlap() {
  local wanted=$1
  local held=$2
  case ${wanted} in "" | 0.0.0.0 | :: | \*) return 0 ;; esac
  case ${held} in "" | 0.0.0.0 | :: | \*) return 0 ;; esac
  [[ ${wanted} == "${held}" ]]
}

find_port_conflict() {
  local listeners
  local protocol
  local wanted
  local wanted_host
  local wanted_port
  local netid
  local local_address
  local process
  local held_host
  local name
  local pid
  PORT_CONFLICT=none
  PORT_CONFLICT_PORT=""
  PORT_HOLDER_NAME=""
  PORT_HOLDER_PID=""
  PORT_HOLDER_ADDRESS=""
  command -v ss >/dev/null 2>&1 || return 0
  listeners="$(ss -H -lnptu 2>/dev/null || true)"
  while read -r protocol wanted; do
    wanted_port=${wanted##*:}
    wanted_host="$(strip_address_host "${wanted%:*}")"
    [[ ${wanted_port} =~ ^[0-9]+$ ]] || continue
    while read -r netid _ _ _ local_address _ process; do
      [[ ${netid} == "${protocol}" && ${local_address##*:} == "${wanted_port}" ]] || continue
      held_host="$(strip_address_host "${local_address%:*}")"
      addresses_overlap "${wanted_host}" "${held_host}" || continue
      name=""
      pid=""
      if [[ ${process} =~ \(\(\"([^\"]+)\",pid=([0-9]+) ]]; then
        name=${BASH_REMATCH[1]}
        pid=${BASH_REMATCH[2]}
      fi
      # KixDNS 自己占着端口不算冲突：它正是要被替换或保留的那一个。
      # KixDNS holding the port is no conflict: it is the one being replaced or kept.
      [[ ${name} != kixdns ]] || continue
      # 别的程序优先于 systemd-resolved 报告：只关掉 resolved 解决不了它。
      # Another program outranks systemd-resolved: turning resolved off would not free the port.
      [[ ${PORT_CONFLICT} != other ]] || continue
      PORT_CONFLICT_PORT=${wanted_port}
      PORT_HOLDER_NAME=${name:-未知进程}
      PORT_HOLDER_PID=${pid}
      PORT_HOLDER_ADDRESS=${held_host}
      if [[ ${name} == systemd-resolve* ]]; then
        PORT_CONFLICT=resolved
      else
        PORT_CONFLICT=other
      fi
    done <<< "${listeners}"
  done < <(kixdns_listen_addresses)
}

resolv_conf_uses_stub() {
  if [[ -L ${RESOLV_CONF} ]]; then
    [[ $(readlink -- "${RESOLV_CONF}") == */stub-resolv.conf ]]
  elif [[ -f ${RESOLV_CONF} ]]; then
    grep -qE '^[[:space:]]*nameserver[[:space:]]+127\.0\.0\.53([[:space:]]|$)' "${RESOLV_CONF}"
  else
    return 1
  fi
}

holder_text() {
  printf '%s（PID %s）' "${PORT_HOLDER_NAME}" "${PORT_HOLDER_PID:-未知}"
}

resolved_manual_commands() {
  printf '  sudo mkdir -p %s\n' "$(dirname -- "${RESOLVED_DROPIN}")"
  printf "  printf '[Resolve]\\\\nDNSStubListener=no\\\\n' | sudo tee %s >/dev/null\n" "${RESOLVED_DROPIN}"
  if resolv_conf_uses_stub; then
    printf '  sudo ln -sfn %s %s\n' "${RESOLVED_UPLINK_RESOLV_CONF}" "${RESOLV_CONF}"
  fi
  printf '  sudo systemctl restart systemd-resolved\n'
}

plan_port53() {
  [[ ${INSTALL_KIND} != panel-only ]] || return 0
  find_port_conflict
  if [[ ${PORT_CONFLICT} == resolved ]] && { exec 3<>/dev/tty; } 2>/dev/null; then
    {
      printf '\n端口 %s 被 systemd-resolved 的本机 DNS 缓存（%s）占用，KixDNS 启动时会因此失败。\n' \
        "${PORT_CONFLICT_PORT}" "${PORT_HOLDER_ADDRESS}"
      printf '安装器可以关闭这个监听：\n'
      printf '  - 写入 %s（DNSStubListener=no）\n' "${RESOLVED_DROPIN}"
      if resolv_conf_uses_stub; then
        printf '  - %s 改为指向 %s，本机域名解析照常工作\n' "${RESOLV_CONF}" "${RESOLVED_UPLINK_RESOLV_CONF}"
      fi
      printf '  - 重启 systemd-resolved；卸载时选择移除 KixDNS 会恢复原样\n'
    } >&3
    if ask_yes_no "关闭 systemd-resolved 的 ${PORT_CONFLICT_PORT} 端口监听？"; then
      RESOLVED_ACTION=disable-stub
    else
      printf '保持 systemd-resolved 不变，安装完成后会给出手动处理的命令。\n' >&3
    fi
    exec 3>&-
  fi
  [[ ${PORT_CONFLICT} != none && ${RESOLVED_ACTION} != disable-stub && ${KIXDNS_RESTART} == true ]] || return 0
  # 这次会重启一个原本在运行的 KixDNS，端口不空出来它必然起不来；在改动主机之前就停下。
  # This run restarts a KixDNS that was running; it cannot start without the port, so stop before touching the host.
  if [[ ${PORT_CONFLICT} == resolved ]]; then
    fail "端口 ${PORT_CONFLICT_PORT} 被 systemd-resolved 占用，替换后的 KixDNS 无法启动。
在终端里运行安装器并同意关闭它的监听，或先手动执行：
$(resolved_manual_commands)"
  fi
  fail "端口 ${PORT_CONFLICT_PORT} 被 $(holder_text)占用，替换后的 KixDNS 无法启动；先停用这个程序，或把配置里的 bind_udp/bind_tcp 改到别的端口，然后重新运行。"
}

# glibc 对第一台 DNS 服务器的超时就是 5 秒，丢一个 UDP 包单次查询就会失败；最多试三次，
# 每次 8 秒，任一次成功即可，总共不超过约 26 秒。
# glibc's first-server timeout is 5 s, so one lost UDP packet fails a single lookup; try up to three
# times at 8 s each and accept the first success, about 26 s at most.
name_resolution_works() {
  local attempt
  for ((attempt = 1; attempt <= 3; attempt++)); do
    timeout 8 getent hosts github.com >/dev/null 2>&1 && return 0
    ((attempt == 3)) || sleep 1
  done
  return 1
}

disable_resolved_stub() {
  local resolved_before=false
  local dropin_directory
  local attempt
  [[ ${RESOLVED_ACTION} == disable-stub ]] || return 0
  # 下面重新检测端口会清空冲突信息，先记下是哪个端口。
  # Re-checking the port below clears the conflict details, so remember which port it was.
  RESOLVED_PORT=${PORT_CONFLICT_PORT}
  if name_resolution_works; then
    resolved_before=true
  fi
  dropin_directory="$(dirname -- "${RESOLVED_DROPIN}")"
  install -d -o root -g root -m 0700 "${RESOLVED_STATE}"
  # 先记下原样再动手，回滚和卸载都按这份记录恢复。
  # Record the original first; rollback and uninstall both restore from this record.
  {
    if [[ -d ${dropin_directory} ]]; then
      printf 'RESOLVED_DROPIN_DIRECTORY_CREATED=false\n'
    else
      printf 'RESOLVED_DROPIN_DIRECTORY_CREATED=true\n'
    fi
    if ! resolv_conf_uses_stub; then
      printf 'RESOLV_CONF_KIND=unchanged\n'
    elif [[ -L ${RESOLV_CONF} ]]; then
      printf 'RESOLV_CONF_KIND=symlink\n'
      printf 'RESOLV_CONF_TARGET=%s\n' "$(readlink -- "${RESOLV_CONF}")"
    else
      cp -a -- "${RESOLV_CONF}" "${RESOLVED_STATE}/resolv.conf"
      printf 'RESOLV_CONF_KIND=file\n'
    fi
  } > "${RESOLVED_STATE}/install.env"
  chmod 0600 "${RESOLVED_STATE}/install.env"
  RESOLVED_CHANGED=true
  install -d -o root -g root -m 0755 "${dropin_directory}"
  printf '[Resolve]\nDNSStubListener=no\n' > "${RESOLVED_DROPIN}"
  chmod 0644 "${RESOLVED_DROPIN}"
  if [[ $(state_file_value "${RESOLVED_STATE}/install.env" RESOLV_CONF_KIND) != unchanged ]]; then
    ln -sfn -- "${RESOLVED_UPLINK_RESOLV_CONF}" "${RESOLV_CONF}"
  fi
  systemctl restart systemd-resolved.service
  for ((attempt = 0; attempt < 50; attempt++)); do
    find_port_conflict
    [[ ${PORT_CONFLICT} == resolved ]] || break
    sleep 0.1
  done
  [[ ${PORT_CONFLICT} != resolved ]] ||
    abort_install "关闭监听后端口 ${RESOLVED_PORT} 仍被 systemd-resolved 占用，检查 /etc/systemd/resolved.conf 里的 DNSStubListenerExtra"
  if [[ ${resolved_before} == true ]] && ! name_resolution_works; then
    abort_install "关闭 systemd-resolved 的本机监听后，本机域名解析不可用"
  fi
}

restore_resolved_stub() {
  local state=${RESOLVED_STATE}/install.env
  local kind
  local target
  [[ -f ${state} ]] || return 0
  kind="$(state_file_value "${state}" RESOLV_CONF_KIND || true)"
  target="$(state_file_value "${state}" RESOLV_CONF_TARGET || true)"
  rm -f -- "${RESOLVED_DROPIN}"
  if [[ $(state_file_value "${state}" RESOLVED_DROPIN_DIRECTORY_CREATED || true) == true ]]; then
    rmdir -- "$(dirname -- "${RESOLVED_DROPIN}")" 2>/dev/null || true
  fi
  case ${kind} in
    symlink) [[ -z ${target} ]] || ln -sfn -- "${target}" "${RESOLV_CONF}" ;;
    file)
      rm -f -- "${RESOLV_CONF}"
      cp -a -- "${RESOLVED_STATE}/resolv.conf" "${RESOLV_CONF}"
      ;;
  esac
  systemctl restart systemd-resolved.service
  rm -rf -- "${RESOLVED_STATE}"
}

restore_managed_service_state() {
  [[ ${INSTALL_MODE} == "managed" ]] || return 0
  if [[ ${PRESERVE_KIXDNS_STATE} == false ]]; then
    systemctl disable --now "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
    return 0
  fi
  if [[ ${KIXDNS_WAS_ENABLED} == true ]]; then
    systemctl enable "${KIXDNS_SERVICE_UNIT}" --quiet
  else
    systemctl disable "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
  if [[ ${KIXDNS_WAS_ACTIVE} == true ]]; then
    systemctl restart "${KIXDNS_SERVICE_UNIT}"
  else
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
}

require_root() {
  [[ ${EUID} -eq 0 ]] || fail "要用 root 权限运行"
}

require_file() {
  [[ -f "$1" ]] || fail "安装包缺少 $1"
}

is_private_ipv4() {
  local address=$1
  awk -F. '
    NF != 4 { exit 1 }
    {
      for (part = 1; part <= 4; part++) {
        if ($part !~ /^[0-9]+$/ || $part < 0 || $part > 255) exit 1
      }
      if ($1 == 10 ||
          ($1 == 172 && $2 >= 16 && $2 <= 31) ||
          ($1 == 192 && $2 == 168) ||
          ($1 == 100 && $2 >= 64 && $2 <= 127)) exit 0
      exit 1
    }
  ' <<< "${address}"
}

detect_private_ipv4() {
  local address
  if command -v ip >/dev/null 2>&1; then
    address="$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (field = 1; field <= NF; field++) if ($field == "src") { print $(field + 1); exit } }')"
    if [[ -n ${address} ]] && is_private_ipv4 "${address}"; then
      printf '%s\n' "${address}"
      return 0
    fi
    while IFS= read -r address; do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done < <(ip -o -4 address show scope global 2>/dev/null | awk '{ split($4, parts, "/"); print parts[1] }')
  fi
  if command -v hostname >/dev/null 2>&1; then
    for address in $(hostname -I 2>/dev/null || true); do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done
  fi
  return 1
}

panel_access_url() {
  local bind=$1
  local host
  local port=${bind##*:}
  [[ ${port} =~ ^[0-9]{1,5}$ ]] || port=5738
  case ${bind} in
    0.0.0.0:* | \[::\]:*) host="$(detect_private_ipv4 || true)" ;;
    \[*\]:*) host=${bind%:*} ;;
    *:*) host=${bind%:*} ;;
    *) host="" ;;
  esac
  if [[ -n ${host} ]]; then
    printf 'http://%s:%s\n' "${host}" "${port}"
  else
    printf 'http://<本机内网IP>:%s\n' "${port}"
  fi
}

create_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || groupadd --system "${KIXDNS_GROUP}"
  if ! id -u "${KIXDNS_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${KIXDNS_USER}"
  fi
  if id -u "${PANEL_USER}" >/dev/null 2>&1; then
    usermod --append --groups "${KIXDNS_GROUP}" "${PANEL_USER}"
  else
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /var/lib/kixdns-panel --shell /usr/sbin/nologin "${PANEL_USER}"
  fi
  if getent group systemd-journal >/dev/null; then
    usermod --append --groups systemd-journal "${PANEL_USER}"
  fi
}

backup_path() {
  local source=$1
  local key=$2
  if [[ -e "${source}" || -L "${source}" ]]; then
    cp -a -- "${source}" "${BACKUP_ROOT}/${key}"
  else
    : > "${BACKUP_ROOT}/${key}.missing"
  fi
}

restore_path() {
  local target=$1
  local key=$2
  rm -rf -- "${target}"
  if [[ -e "${BACKUP_ROOT}/${key}" || -L "${BACKUP_ROOT}/${key}" ]]; then
    install -d -- "$(dirname -- "${target}")"
    cp -a -- "${BACKUP_ROOT}/${key}" "${target}"
  fi
}

# 新面板启动时会把数据库迁移到自己的 schema，而面板拒绝打开比自己新的库（db.rs）。
# 回滚只换回旧程序、留着迁移过的库，旧面板就会一直崩溃重启。所以在面板停下、不再写入之后，
# 连同 WAL 和共享内存文件一起备份；标记文件说明备份已完成，回滚只在它存在时才放回。
# On start the new panel migrates the database to its schema, and the panel refuses a database newer
# than itself (db.rs). A rollback that swaps the binary back but keeps the migrated database leaves the
# old panel crash-looping. So back it up, with its WAL and shared-memory files, once the panel has
# stopped writing; the marker says the backup is complete, and rollback restores only when it exists.
backup_panel_database() {
  backup_path "${PANEL_DATABASE}" panel-database
  backup_path "${PANEL_DATABASE}-wal" panel-database-wal
  backup_path "${PANEL_DATABASE}-shm" panel-database-shm
  : > "${BACKUP_ROOT}/panel-database.saved"
}

restore_panel_database() {
  local file
  [[ -f ${BACKUP_ROOT}/panel-database.saved ]] || return 0
  # 三个文件必须成套放回：留下新面板的 WAL 会被 SQLite 重放到旧库上。
  # The three files go back as a set: a WAL left by the new panel would be replayed onto the old database.
  restore_path "${PANEL_DATABASE}" panel-database
  restore_path "${PANEL_DATABASE}-wal" panel-database-wal
  restore_path "${PANEL_DATABASE}-shm" panel-database-shm
  for file in "${PANEL_DATABASE}" "${PANEL_DATABASE}-wal" "${PANEL_DATABASE}-shm"; do
    [[ -e ${file} ]] || continue
    chown "${PANEL_USER}:${KIXDNS_GROUP}" -- "${file}"
    chmod 0600 -- "${file}"
  done
}

rollback_install() {
  local status=$1
  local reason=${2:-failed}
  # -E 让 ERR 陷阱也在子 shell（命令替换、管道）里触发。在子 shell 里回滚会删掉备份，父 shell 收到失败又回滚一次，
  # 这时只剩删除：刚放回的文件被删光。所以只在设下陷阱的那个 shell 里回滚，子 shell 只带着失败退出
  # -E fires the ERR trap inside subshells too (command substitutions, pipelines). A rollback there deleted the backup, and the
  # parent, seeing the failure, rolled back again with only deletion left, removing what was just put back. So only the shell
  # that set the trap rolls back; a subshell just exits with the failure
  [[ -z ${3:-} || ${BASHPID} == "$3" ]] || exit "${status}"
  local outcome=安装未完成
  local panel_running=true
  local host
  local port
  trap - ERR
  # 回滚途中再按 Ctrl-C 或断线不能半途而废，否则主机停在比中断前更糟的状态。
  # A second Ctrl-C or hangup must not abort the rollback half way and leave the host worse off.
  trap '' INT TERM HUP
  set +e
  if [[ ${EXISTING_PANEL} == false ]]; then
    systemctl disable --now kixdns-panel.service kixdns-panel-helper.service 2>/dev/null
  else
    systemctl stop kixdns-panel.service 2>/dev/null
  fi
  if kixdns_replaced; then
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    [[ ${KIXDNS_BINARY_CHANGED} == false ]] || restore_path "${MANAGED_KIXDNS_BINARY}" kixdns
    [[ ${KIXDNS_UNIT_CHANGED} == false ]] ||
      restore_path "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" kixdns-service
  fi
  if [[ ${INSTALL_KIND} != panel-only ]]; then
    restore_path /var/lib/kixdns-panel/bundle bundled-metadata
    restore_managed_config
  fi
  restore_path "${PANEL_SERVER_BINARY}" panel-server
  restore_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install" panel-one-click-install
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-online-update" panel-online-update
  restore_path "${PANEL_SHARE_DIRECTORY}/web" web
  restore_path "${PANEL_SHARE_DIRECTORY}/geo" builtin-geo
  restore_path /etc/systemd/system/kixdns-panel.service panel-service
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-helper" panel-helper
  restore_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  restore_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  restore_path "${PANEL_ENV}" panel-env
  restore_panel_database
  [[ ${RESOLVED_CHANGED} == false ]] || restore_resolved_stub
  systemctl daemon-reload
  [[ ${EXISTING_PANEL} == false ]] || systemctl restart kixdns-panel-helper.service 2>/dev/null
  if [[ ${CREATED_EXTERNAL_BACKUP} == true ]]; then
    # 迁移失败：原 unit 已放回，按迁移前的运行与开机状态恢复。
    # Failed migration: the original unit is back; restore its pre-migration running and boot state.
    if [[ ${KIXDNS_WAS_ENABLED} == true ]]; then
      systemctl enable "${KIXDNS_SERVICE_UNIT}" --quiet
    else
      systemctl disable "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    fi
    if [[ ${KIXDNS_WAS_ACTIVE} == true ]]; then
      systemctl restart "${KIXDNS_SERVICE_UNIT}"
    else
      systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    fi
    rm -rf -- "${EXTERNAL_BACKUP}"
  elif kixdns_replaced; then
    restore_managed_service_state
  fi
  # 这次迁移换下来的旧备份放回去，主机和安装前一样。看回滚备份里实际有没有它，不看上面的标记：旧备份挪走以后、标记设上以前
  # 被中断时，它只在回滚备份里，跟着回滚备份删掉就没了。
  # The old backup this migration replaced goes back, leaving the host as it was before the install. Whether the rollback
  # backup really holds it decides, not the flag above: interrupted after the old backup moved and before the flag was set,
  # it lives only in the rollback backup and would be deleted with it.
  if [[ -e ${BACKUP_ROOT}/external-backup || -L ${BACKUP_ROOT}/external-backup ]]; then
    rm -rf -- "${EXTERNAL_BACKUP}"
    mv -- "${BACKUP_ROOT}/external-backup" "${EXTERNAL_BACKUP}"
  fi
  if [[ ${EXISTING_PANEL} == true ]]; then
    systemctl restart kixdns-panel.service
    # 旧面板可能因为数据库或环境不兼容而起不来；不确认就说「已恢复」会把人引向错误的方向。
    # The old panel may still fail on an incompatible database or environment; claiming "restored"
    # without checking sends the user the wrong way.
    read -r host port < <(panel_probe_address)
    wait_for_service_stable kixdns-panel.service "${host}" "${port}" || panel_running=false
  fi
  # 最后才删这次新建的目录和账号：上面放回 resolv.conf 等还要读状态目录里的记录。
  # The directories and accounts this run created go last: restoring resolv.conf and the rest above still reads records in
  # the state directory.
  remove_new_directories
  remove_new_accounts
  rm -rf -- "${BACKUP_ROOT}"
  [[ ${reason} != interrupted ]] || outcome=安装被中断
  if [[ ${panel_running} == true ]]; then
    printf '%s，已恢复原有程序和服务。\n' "${outcome}" >&2
  else
    printf '%s，已放回原有程序和数据库，但原面板没有恢复运行。\n查看原因：journalctl -u kixdns-panel.service -n 50 --no-pager\n' \
      "${outcome}" >&2
  fi
  exit "${status}"
}

# 这次运行要建的目录还不存在时，把不存在的最上面那一层记下来（install -d 会把上面缺的几层一起建出来）。回滚最后整个删掉它：
# 里面只会有这次运行写的东西，安装器写的，或者刚起来的面板写的，比如写到一半的临时文件。
# When a directory this run will create does not exist yet, record its topmost missing level (install -d creates the missing
# levels above it too). Rollback removes it whole at the end: only what this run wrote can be in it, by the installer or by
# the panel that had just started, such as a temporary file it was half way through writing.
record_new_directory() {
  local directory=$1
  local missing=""
  while [[ ! -e ${directory} && ! -L ${directory} ]]; do
    missing=${directory}
    directory="$(dirname -- "${directory}")"
  done
  [[ -z ${missing} ]] || printf '%s\n' "${missing}" >> "${BACKUP_ROOT}/new-directories"
}

remove_new_directories() {
  local directory
  [[ -f ${BACKUP_ROOT}/new-directories ]] || return 0
  while IFS= read -r directory; do
    [[ ${directory} == /?* ]] || continue
    rm -rf -- "${directory}"
  done < "${BACKUP_ROOT}/new-directories"
}

# 记下这次运行开始时账号和组在不在，回滚时只删这次建的。/ Record whether the accounts and the group existed when this run
# began, so rollback removes only the ones it created.
record_existing_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || KIXDNS_GROUP_EXISTED=false
  id -u "${KIXDNS_USER}" >/dev/null 2>&1 || KIXDNS_USER_EXISTED=false
  id -u "${PANEL_USER}" >/dev/null 2>&1 || PANEL_USER_EXISTED=false
}

remove_new_accounts() {
  [[ ${PANEL_USER_EXISTED} == true ]] || userdel "${PANEL_USER}" 2>/dev/null || true
  [[ ${KIXDNS_USER_EXISTED} == true ]] || userdel "${KIXDNS_USER}" 2>/dev/null || true
  [[ ${KIXDNS_GROUP_EXISTED} == true ]] || groupdel "${KIXDNS_GROUP}" 2>/dev/null || true
}

backup_managed_config() {
  local config_parent
  local metadata
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  backup_path "${KIXDNS_CONFIG_PATH}" kixdns-config
  if [[ -d ${config_parent} ]]; then
    metadata="$(stat -c '%u %g %a' -- "${config_parent}")"
    printf '%s\n' "${metadata}" > "${BACKUP_ROOT}/kixdns-config-directory.meta"
  else
    record_new_directory "${config_parent}"
  fi
}

restore_managed_config() {
  local config_parent
  local owner
  local group
  local mode
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  rm -f -- "${KIXDNS_CONFIG_PATH}"
  if [[ -e ${BACKUP_ROOT}/kixdns-config || -L ${BACKUP_ROOT}/kixdns-config ]]; then
    install -d -- "${config_parent}"
    cp -a -- "${BACKUP_ROOT}/kixdns-config" "${KIXDNS_CONFIG_PATH}"
  fi
  # 这次新建的配置目录在回滚最后和别的新目录一起删（remove_new_directories）
  # A config directory this run created goes at the end of the rollback with the other new ones (remove_new_directories)
  if [[ -f ${BACKUP_ROOT}/kixdns-config-directory.meta ]]; then
    read -r owner group mode < "${BACKUP_ROOT}/kixdns-config-directory.meta"
    chown "${owner}:${group}" -- "${config_parent}"
    chmod "${mode}" -- "${config_parent}"
  fi
}

preserve_external_install() {
  [[ ${INSTALL_KIND} == migrate ]] || return 0
  # 卸载时选了保留、留下来的面板自带 KixDNS（跑的是面板状态目录里的程序）不是外部安装：重装后接着管它，不备份成
  # 「原来的 KixDNS」。否则卸载时会把这个 unit 当原来的放回去并启动，而它的程序已随面板状态目录删掉
  # The panel's own KixDNS kept by an earlier uninstall (it runs the program in the panel's state directory) is not an
  # external install: the reinstall manages it on, and it is not backed up as the original KixDNS. Otherwise uninstall
  # would put this unit back and start it, with its program already deleted along with the panel's state directory
  [[ ${EXISTING_KIXDNS_BINARY_PATH} != "${MANAGED_KIXDNS_BINARY}" ]] || return 0
  # 这时已经有的备份，是以前的卸载恢复了原来的 KixDNS 却没删的（现在的卸载恢复完就删），记的是更早那次迁移前的样子；要恢复的是
  # 主机上现在这个外部 KixDNS，所以换掉。旧的先挪进回滚备份，迁移失败时原样放回。
  # A backup already here was left by an earlier uninstall that restored the original KixDNS without removing it (current
  # ones remove it once restored), and describes the host before an older migration; the one to restore is the external
  # KixDNS on the host now, so it is replaced. The old one moves into the rollback backup first and goes back as it was if
  # the migration fails.
  if [[ -e ${EXTERNAL_BACKUP} || -L ${EXTERNAL_BACKUP} ]]; then
    mv -- "${EXTERNAL_BACKUP}" "${BACKUP_ROOT}/external-backup"
  fi
  CREATED_EXTERNAL_BACKUP=true
  install -d -o root -g root -m 0700 "${EXTERNAL_BACKUP}"
  if [[ -e ${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT} ]]; then
    cp -a -- "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" "${EXTERNAL_BACKUP}/kixdns.service"
  else
    : > "${EXTERNAL_BACKUP}/service-file-missing"
  fi
  {
    printf 'KIXDNS_SERVICE_UNIT=%s\n' "${KIXDNS_SERVICE_UNIT}"
    # 原来的 KixDNS 的配置，和面板管理的那一份分开记：迁移时后者是前者的副本，旧版原地迁移时两者相同。
    # The original KixDNS's config, recorded apart from the one the panel manages: on migration the latter is a copy
    # of the former, and an older in-place migration made them the same.
    printf 'KIXDNS_CONFIG=%s\n' "${ORIGINAL_KIXDNS_CONFIG_PATH:-${KIXDNS_CONFIG_PATH}}"
    printf 'KIXDNS_MANAGED_CONFIG=%s\n' "${KIXDNS_CONFIG_PATH}"
    printf 'KIXDNS_BINARY=%s\n' "${EXISTING_KIXDNS_BINARY_PATH}"
    printf 'KIXDNS_WAS_ACTIVE=%s\n' "${KIXDNS_WAS_ACTIVE}"
    printf 'KIXDNS_WAS_ENABLED=%s\n' "${KIXDNS_WAS_ENABLED}"
    # 卸载恢复、删除面板数据时，只删迁移建的 kixdns 账号和组 / Uninstalling with a restore and the panel data removed deletes
    # only the kixdns account and group the migration created
    printf 'KIXDNS_USER_CREATED=%s\n' "$(kixdns_account_created user)"
    printf 'KIXDNS_GROUP_CREATED=%s\n' "$(kixdns_account_created group)"
  } > "${EXTERNAL_BACKUP}/install.env"
  chmod 0600 "${EXTERNAL_BACKUP}/install.env"
}

# kixdns 账号（user）或组（group）是不是面板建的：这次运行开始时还没有，或者以前的面板建的、卸载时留下并记在保留的
# panel.env 里（KIXDNS_REMOVED，或迁移备份用掉时带过去的 KIXDNS_USER_CREATED、KIXDNS_GROUP_CREATED）。输出 true 或 false。
# Whether the kixdns account (user) or group (group) is the panel's: missing when this run began, or created by an earlier
# panel and left by an uninstall that recorded it in the kept panel.env (KIXDNS_REMOVED, or the KIXDNS_USER_CREATED and
# KIXDNS_GROUP_CREATED carried over when a migration backup was used up). Prints true or false.
kixdns_account_created() {
  local existed=${KIXDNS_USER_EXISTED}
  local key=KIXDNS_USER_CREATED
  if [[ $1 == group ]]; then
    existed=${KIXDNS_GROUP_EXISTED}
    key=KIXDNS_GROUP_CREATED
  fi
  if [[ ${existed} == false || $(environment_value KIXDNS_REMOVED || true) == true ||
    $(environment_value "${key}" || true) == true ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

prepare_rollback() {
  local directory
  BACKUP_ROOT="$(mktemp -d /var/tmp/kixdns-panel-install.XXXXXX)"
  # 回滚要能删掉这次建的一切，所以在建账号、建目录之前记下哪些原来就有 / Rollback must be able to remove everything this run
  # creates, so record what was there before any account or directory is created
  record_existing_accounts
  for directory in "${PANEL_CONFIG_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo" "${PANEL_UPDATE_DIRECTORY}" "${PANEL_SHARE_DIRECTORY}/web" "${PANEL_SHARE_DIRECTORY}/geo" \
    "${LIBEXEC_DIRECTORY}"; do
    record_new_directory "${directory}"
  done
  if [[ ${INSTALL_KIND} != panel-only ]]; then
    backup_path "${MANAGED_KIXDNS_BINARY}" kixdns
    backup_path /var/lib/kixdns-panel/bundle bundled-metadata
    backup_path "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" kixdns-service
    backup_managed_config
  fi
  backup_path "${PANEL_SERVER_BINARY}" panel-server
  backup_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install" panel-one-click-install
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-online-update" panel-online-update
  backup_path "${PANEL_SHARE_DIRECTORY}/web" web
  backup_path "${PANEL_SHARE_DIRECTORY}/geo" builtin-geo
  backup_path /etc/systemd/system/kixdns-panel.service panel-service
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-helper" panel-helper
  backup_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  backup_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  backup_path "${PANEL_ENV}" panel-env
  arm_rollback
}

# 账号以外、这次运行要建的目录：面板状态目录和它下面的几个、在线更新状态目录、helper 所在的目录。
# The directories this run creates besides the accounts: the panel's state directory and those under it, the online update
# status directory, and the one holding the helper.
create_panel_directories() {
  install -d -o root -g root -m 0755 "${LIBEXEC_DIRECTORY}"
  install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 \
    "${PANEL_STATE_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo"
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 "${PANEL_UPDATE_DIRECTORY}"
}

# 改动主机之前确认要写的目标都不是符号链接：install 和 mv 会顺着链接写到别处。
# Before the host is touched, make sure no target to be written is a symlink: install and mv would write through it.
require_regular_targets() {
  [[ ! -L ${PANEL_UPDATE_DIRECTORY} ]] || fail "在线更新状态目录不能是符号链接"
  if [[ ${INSTALL_KIND} != panel-only ]]; then
    [[ ! -L ${MANAGED_KIXDNS_BINARY} ]] || fail "KixDNS 二进制目标不能是符号链接"
  fi
  [[ ! -L ${PANEL_SERVER_BINARY} ]] || fail "面板二进制目标不能是符号链接"
  [[ ! -L /usr/local/bin/kixdns-panel-uninstall ]] || fail "卸载命令目标不能是符号链接"
  [[ ! -L ${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install ]] || fail "一键安装器目标不能是符号链接"
  [[ ! -L ${LIBEXEC_DIRECTORY}/kixdns-panel-online-update ]] || fail "在线更新器目标不能是符号链接"
}

# 出错就回滚，回滚只在这个 shell 里做（rollback_install 里说了为什么）
# Roll back on error, in this shell only (rollback_install says why)
arm_rollback() {
  # shellcheck disable=SC2064 # BASHPID 要在挂陷阱时展开，记下是哪个 shell 挂的 / BASHPID expands now, recording which shell set the trap
  trap "rollback_install \$? failed ${BASHPID}" ERR
  # 只挂 ERR 时，Ctrl-C、SIGTERM 或 SSH 断线会直接杀掉 bash，已停掉的服务不会恢复。
  # With only ERR trapped, Ctrl-C, SIGTERM or an SSH hangup kill bash and stopped services stay stopped.
  trap 'rollback_install 130 interrupted' INT TERM HUP
}

# 安装包自带的 GeoSite（Loyalsoldier 的 geosite.dat、来源说明和 GPL 许可证）。只是安装包里的数据：
# 面板只在全新安装的首次启动、或用户自己点「导入」时用它，之后按用户选的来源和频率更新，面板升级从不替换用户的数据。
# The GeoSite the package brings along (Loyalsoldier's geosite.dat, its source note and GPL licence). It is only package data:
# the panel uses it on a fresh install's first start or when the user presses 导入, then updates follow the source and schedule
# the user chose, and a panel upgrade never replaces the user's data.
install_builtin_geo() {
  local target=${PANEL_SHARE_DIRECTORY}/geo
  local staged="${target}.new"
  local previous="${target}.previous"
  rm -rf -- "${staged}"
  install -d -o root -g root -m 0755 "${staged}"
  install -o root -g root -m 0644 "${PACKAGE_ROOT}/geo/geosite.dat" "${PACKAGE_ROOT}/geo/geosite.json" \
    "${PACKAGE_ROOT}/geo/LICENSE" "${staged}/"
  if [[ -d "${target}" ]]; then
    rm -rf -- "${previous}"
    mv -- "${target}" "${previous}"
  fi
  mv -- "${staged}" "${target}"
  # 回滚用的是安装前的备份，换下来的旧副本留着只占地方（约 11 MB）
  # Rollback restores from the pre-install backup, so the replaced copy would only take up space (about 11 MB)
  rm -rf -- "${previous}"
}

# 全新安装时请首次启动的面板导入一次内置 GeoSite；面板用完就删这个标记。升级和迁移不放：
# 那些主机原有的配置可能有意不用 GeoSite，导入会改变分流结果，由用户自己决定。
# On a fresh install, ask the panel's first start to import the built-in GeoSite once; the panel removes the marker after
# use. Upgrades and migrations get none: their existing configs may leave GeoSite out on purpose, and importing would
# change routing, so the user decides.
request_builtin_geosite_import() {
  [[ ${INSTALL_KIND} == fresh ]] || return 0
  install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 /dev/null \
    /var/lib/kixdns-panel/geo/.import-builtin-geosite
}

install_web() {
  local target=${PANEL_SHARE_DIRECTORY}/web
  local staged="${target}.new"
  local previous="${target}.previous"
  rm -rf -- "${staged}"
  install -d -o root -g root -m 0755 "${staged}"
  cp -a -- "${PACKAGE_ROOT}/web/." "${staged}/"
  chown -R root:root "${staged}"
  if [[ -d "${target}" ]]; then
    rm -rf -- "${previous}"
    mv -- "${target}" "${previous}"
  fi
  mv -- "${staged}" "${target}"
}

render_panel_environment() {
  local source=$1
  local output=$2
  local kixdns_commit=$3
  local panel_commit=$4
  local panel_release=$5
  local kixdns_source_id=$6
  local kixdns_source=$7
  awk -v kixdns_commit="${kixdns_commit}" -v panel_commit="${panel_commit}" \
    -v panel_release="${panel_release}" -v kixdns_source_id="${kixdns_source_id}" \
    -v kixdns_source="${kixdns_source}" \
    -v config_path="${KIXDNS_CONFIG_PATH}" -v binary_path="${KIXDNS_BINARY_PATH}" \
    -v control_socket="${KIXDNS_CONTROL_SOCKET}" -v helper_socket="${KIXDNS_SERVICE_HELPER_SOCKET}" \
    -v service_unit="${KIXDNS_SERVICE_UNIT}" \
    -v old_trusted_comment="${OLD_TRUSTED_PROXIES_COMMENT}" -v old_trusted_line="${OLD_TRUSTED_PROXIES_LINE}" \
    -v trusted_comment_1="${TRUSTED_PROXIES_COMMENT_1}" -v trusted_comment_2="${TRUSTED_PROXIES_COMMENT_2}" '
    # 旧示例的可信代理说明先压着，看下一行：还是旧示例的默认值时只换说明，值留着（为什么见 update_panel_environment）。
    # The trusted-proxies comment of the old example is held to look at the next line: when that is still the old default,
    # only the comment is replaced and the value stays (update_panel_environment says why).
    held_trusted_comment {
      held_trusted_comment = 0
      if ($0 == old_trusted_line) {
        print trusted_comment_1
        print trusted_comment_2
        print
        next
      }
      print old_trusted_comment
    }
    $0 == old_trusted_comment { held_trusted_comment = 1; next }
    # 内核改从 fork 的发布页更新：按补丁集构建找 Artifact 的这几项和它们的说明不再读取，删掉免得误导手工编辑的人。
    # Kernels now update from fork releases: the settings that located patchset Artifacts, and their comments, are no
    # longer read, so drop them to keep hand edits from being misled.
    /^# GitHub API 元数据请求可在系统页配置 Token；Artifact 下载仍通过 nightly\.link。$/ { next }
    /^# x86_64 使用 x86_64，ARM64 使用 arm64；安装脚本会自动填写。$/ { next }
    /^KIXDNS_UPDATE_(REPOSITORY|WORKFLOW|BRANCH|ARTIFACT)=/ { next }
    /^# 完整安装包复用的 KixDNS Action 提交，由安装脚本填写；不要手工修改。$/ {
      print "# 完整安装包自带内核的来源和提交，由安装脚本填写；不要手工修改。"
      next
    }
    /^# 完整安装包自带增强 Artifact 的 GitHub ID，由安装脚本填写。$/ {
      print "# 完整安装包自带内核包在 GitHub 上的编号，由安装脚本填写。"
      next
    }
    # 监听地址是用户的设置，升级不改：改成 127.0.0.1 的人就是不想让面板对外。
    # An upgrade leaves the listen address alone: whoever set 127.0.0.1 wants the panel kept off the network.
    /^KIXDNS_PANEL_BIND=/ { bind_found = 1 }
    /^KIXDNS_CONFIG=/ { print "KIXDNS_CONFIG=" config_path; config_found = 1; next }
    /^KIXDNS_BINARY=/ { print "KIXDNS_BINARY=" binary_path; binary_found = 1; next }
    /^KIXDNS_CONTROL_SOCKET=/ { print "KIXDNS_CONTROL_SOCKET=" control_socket; socket_found = 1; next }
    /^KIXDNS_SERVICE_HELPER_SOCKET=/ { print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket; helper_socket_found = 1; next }
    /^KIXDNS_SERVICE_UNIT=/ { print "KIXDNS_SERVICE_UNIT=" service_unit; unit_found = 1; next }
    # 已移除的管理模式开关：旧文件里的键和说明一并删掉，免得误导手工编辑的人。
    # The removed management switch: drop the key and its comment from old files so hand edits are not misled.
    /^# true：面板管理增强版二进制；false：/ { next }
    /^KIXDNS_MANAGEMENT_ENABLED=/ { next }
    # 卸载器记下的「KixDNS 已不归面板管时留下待删的」：重新装上以后又归面板管，迁移备份已经接着记下（kixdns_account_created）。
    # What the uninstaller recorded as left behind once the KixDNS no longer belonged to the panel: after a reinstall it
    # belongs to the panel again, and a migration backup has carried the record on (kixdns_account_created).
    /^KIXDNS_(REMOVED|USER_CREATED|GROUP_CREATED)=/ { next }
    /^KIXDNS_INSTALLED_SOURCE=/ {
      if (kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      kixdns_source_found = 1
      next
    }
    /^KIXDNS_INSTALLED_COMMIT=/ {
      if (!kixdns_source_found && kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      kixdns_source_found = 1
      print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      kixdns_found = 1
      next
    }
    /^KIXDNS_INSTALLED_SOURCE_ID=/ {
      print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      source_id_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_COMMIT=/ {
      print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      panel_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_RELEASE=/ {
      if (panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
      panel_release_found = 1
      next
    }
    # 内核只跟随 Action 轨道，Release 工作流的设置已不再读取。
    # The kernel follows only the Action track; the Release workflow setting is no longer read.
    /^KIXDNS_UPDATE_RELEASE_WORKFLOW=/ { next }
    { print }
    END {
      if (held_trusted_comment) print old_trusted_comment
      if (!bind_found) print "KIXDNS_PANEL_BIND=0.0.0.0:5738"
      if (!config_found) print "KIXDNS_CONFIG=" config_path
      if (!binary_found) print "KIXDNS_BINARY=" binary_path
      if (!socket_found) print "KIXDNS_CONTROL_SOCKET=" control_socket
      if (!helper_socket_found) print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket
      if (!unit_found) print "KIXDNS_SERVICE_UNIT=" service_unit
      if (!kixdns_source_found && kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      if (!kixdns_found) print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      if (!source_id_found) print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      if (!panel_found) print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      if (!panel_release_found && panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
    }
  ' "${source}" > "${output}"
}

# panel.env 里可信代理还是旧示例的默认值（信任本机代理），上面那行说明也还是旧示例的原样。
# The trusted proxies in panel.env are still the old example's default (the local proxy trusted), with its comment above
# still as the old example had it.
old_trusted_proxies_default() {
  [[ -f $1 ]] || return 1
  awk -v comment="${OLD_TRUSTED_PROXIES_COMMENT}" -v line="${OLD_TRUSTED_PROXIES_LINE}" '
    previous == comment && $0 == line { found = 1 }
    { previous = $0 }
    END { exit !found }
  ' "$1"
}

update_panel_environment() {
  local kixdns_commit=$1
  local kixdns_source_id=$2
  local kixdns_source=$3
  local temporary
  # 旧示例默认信任本机代理，从那时装起的主机都还写着。升级不改这个值：本机 Nginx 后面的人改成谁都不信以后，登录限流把所有人
  # 算在代理一个地址上，几次输错就全被锁住，比它挡住的本机伪造更糟。只把说明换成新示例的，在安装结果里提醒一次；说明换过，
  # 下次就不再提醒。
  # The old example trusted the local proxy by default, and hosts installed back then still say so. An upgrade keeps the
  # value: trusting none behind a local Nginx makes the login limit count everyone against the proxy's one address, locking
  # all out after a few wrong passwords, which is worse than the local spoofing it stops. Only the comment becomes the new
  # example's and the install result says so once; with the comment replaced, the next run says nothing.
  if old_trusted_proxies_default "${PANEL_ENV}"; then
    TRUSTED_PROXIES_NOTICE=true
  fi
  temporary="$(mktemp "${PANEL_CONFIG_DIRECTORY}/.panel.env.XXXXXX")"
  render_panel_environment "${PANEL_ENV}" "${temporary}" "${kixdns_commit}" \
    "${PANEL_BUILD_COMMIT}" "${PANEL_RELEASE}" "${kixdns_source_id}" "${kixdns_source}"
  chown root:"${KIXDNS_GROUP}" "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${PANEL_ENV}"
}

install_configuration() {
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 "${PANEL_CONFIG_DIRECTORY}"
  install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 "$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  if [[ -n ${ORIGINAL_KIXDNS_CONFIG_PATH} && -f ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
    # 迁移：把原配置一字不差地复制给面板管理。原文件只读不写，属主和权限都不动。
    # Migration: copy the original config byte for byte for the panel to manage. The original is only read; its owner
    # and mode stay as they are.
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 -- "${ORIGINAL_KIXDNS_CONFIG_PATH}" "${KIXDNS_CONFIG_PATH}"
  elif [[ ! -e ${KIXDNS_CONFIG_PATH} ]]; then
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 \
      "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${KIXDNS_CONFIG_PATH}"
  else
    chown "${PANEL_USER}:${KIXDNS_GROUP}" -- "${KIXDNS_CONFIG_PATH}"
    chmod 0640 -- "${KIXDNS_CONFIG_PATH}"
  fi
  if [[ ! -e ${PANEL_ENV} ]]; then
    sed -e "s/^KIXDNS_INSTALLED_SOURCE=.*/KIXDNS_INSTALLED_SOURCE=${KIXDNS_SOURCE}/" \
      -e "s/^KIXDNS_INSTALLED_COMMIT=.*/KIXDNS_INSTALLED_COMMIT=${KIXDNS_BUILD_COMMIT}/" \
      -e "s/^KIXDNS_PANEL_INSTALLED_COMMIT=.*/KIXDNS_PANEL_INSTALLED_COMMIT=${PANEL_BUILD_COMMIT}/" \
      -e "s/^KIXDNS_INSTALLED_SOURCE_ID=.*/KIXDNS_INSTALLED_SOURCE_ID=${KIXDNS_SOURCE_ID}/" \
      "${PACKAGE_ROOT}/deploy/panel.env.example" > "${PANEL_ENV}"
    chown root:"${KIXDNS_GROUP}" "${PANEL_ENV}"
    chmod 0640 "${PANEL_ENV}"
  fi
  update_panel_environment "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
}

install_bundled_metadata() {
  local target=/var/lib/kixdns-panel/bundle
  local file
  [[ ${INSTALL_KIND} != panel-only ]] || return 0
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 "${target}"
  # 旧安装包带的是补丁集构建的身份；换成 fork 发布版后这两份不再对应装上的内核，删掉免得混用。
  # Older packages carried a patchset build's identity; with a fork release these two no longer describe the installed
  # kernel, so remove them rather than let them mix.
  rm -f -- "${target}/upstream.lock.json" "${target}/KIXDNS_SOURCE_RUN_ID"
  for file in KIXDNS_BUILD_COMMIT KIXDNS_SOURCE.json KIXDNS_ARTIFACT_ID \
    KIXDNS_ARTIFACT_NAME KIXDNS_ARTIFACT_DIGEST KIXDNS_BINARY_SHA256 \
    KIXDNS_CAPABILITIES.json; do
    install -o root -g "${KIXDNS_GROUP}" -m 0640 \
      "${PACKAGE_ROOT}/${file}" "${target}/${file}"
  done
}

install_services() {
  local kixdns_unit=${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}
  local config_directory
  local panel_temporary
  local helper_temporary
  local kixdns_temporary
  local helper_unit=/etc/systemd/system/kixdns-panel-helper.service
  local panel_uid
  panel_uid="$(id -u "${PANEL_USER}")"
  panel_temporary="$(mktemp /etc/systemd/system/.kixdns-panel.XXXXXX)"
  helper_temporary="$(mktemp /etc/systemd/system/.kixdns-panel-helper.XXXXXX)"
  if [[ ${INSTALL_KIND} != panel-only && ${KIXDNS_UNIT_CHANGED} == true ]]; then
    kixdns_temporary="$(mktemp /etc/systemd/system/.kixdns.XXXXXX)"
    render_kixdns_unit > "${kixdns_temporary}"
    install -o root -g root -m 0644 "${kixdns_temporary}" "${kixdns_unit}"
    rm -f -- "${kixdns_temporary}"
  fi
  awk -v service_unit="${KIXDNS_SERVICE_UNIT}" -v helper_socket="${KIXDNS_SERVICE_HELPER_SOCKET}" \
    -v panel_uid="${panel_uid}" '
    /^ExecStart=/ {
      print "ExecStart=/usr/local/libexec/kixdns-panel-helper --socket " helper_socket " --unit " service_unit " --allowed-uid " panel_uid
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel-helper.service" > "${helper_temporary}"
  install -o root -g root -m 0644 "${helper_temporary}" "${helper_unit}"
  rm -f -- "${helper_temporary}"
  config_directory="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  awk -v service_unit="${KIXDNS_SERVICE_UNIT}" -v config_directory="${config_directory}" '
    /^After=network-online\.target / { print "After=network-online.target " service_unit " kixdns-panel-helper.service"; next }
    /^ReadWritePaths=/ {
      print "ReadWritePaths=" config_directory " /var/lib/kixdns-panel"
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel.service" > "${panel_temporary}"
  install -o root -g root -m 0644 "${panel_temporary}" /etc/systemd/system/kixdns-panel.service
  rm -f -- "${panel_temporary}"
  rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
  systemctl daemon-reload
  systemctl enable kixdns-panel-helper.service kixdns-panel.service --quiet
  if kixdns_replaced; then
    restore_managed_service_state
  fi
  systemctl restart kixdns-panel-helper.service
  systemctl restart kixdns-panel.service
}

port_accepts_connection() {
  local host=$1
  local port=$2
  # install.sh 不要求 curl；bash 自带的 /dev/tcp 足够确认端口在接受连接。
  # install.sh does not require curl; bash's own /dev/tcp is enough to see the port accepting connections.
  # shellcheck disable=SC2016 # $1/$2 由内层 bash 展开 / expanded by the inner bash
  timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "${host}" "${port}" 2>/dev/null
}

# Type=simple 的服务 fork 成功 systemctl 就返回，崩溃循环也会先显示 active。
# 这里要求主进程在比 RestartSec 更长的窗口里保持同一个 PID，必要时端口也已接受连接。
# systemctl returns as soon as a Type=simple service forks, and a crash loop briefly reads active.
# Require the same main PID for longer than RestartSec, and the port accepting connections when given.
wait_for_service_stable() {
  local unit=$1
  local host=${2:-}
  local port=${3:-}
  local tick
  local state
  local pid
  local stable_pid=""
  local stable_ticks=0
  for ((tick = 0; tick < SERVICE_WAIT_SECONDS * 2; tick++)); do
    state="$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
    pid="$(systemctl show --property=MainPID --value "${unit}" 2>/dev/null || true)"
    if [[ ${state} == active && ${pid} =~ ^[1-9][0-9]*$ ]]; then
      if [[ ${pid} == "${stable_pid}" ]]; then
        stable_ticks=$((stable_ticks + 1))
      else
        stable_pid=${pid}
        stable_ticks=0
      fi
      if ((stable_ticks >= SERVICE_STABLE_SECONDS * 2)) &&
        { [[ -z ${port} ]] || port_accepts_connection "${host}" "${port}"; }; then
        return 0
      fi
    else
      stable_pid=""
      stable_ticks=0
    fi
    sleep 0.5
  done
  return 1
}

panel_probe_address() {
  local bind
  local host
  bind="$(environment_value KIXDNS_PANEL_BIND || true)"
  [[ -n ${bind} ]] || bind=0.0.0.0:5738
  host=${bind%:*}
  case ${host} in
    0.0.0.0 | "") host=127.0.0.1 ;;
    \[::\]) host=::1 ;;
    *) host="$(strip_address_host "${host}")" ;;
  esac
  printf '%s %s\n' "${host}" "${bind##*:}"
}

verify_services_started() {
  local host
  local port
  read -r host port < <(panel_probe_address)
  if ! wait_for_service_stable kixdns-panel.service "${host}" "${port}"; then
    abort_install "kixdns-panel.service 启动后没有保持运行（${SERVICE_WAIT_SECONDS} 秒内没有稳定运行并接受 ${port} 端口连接）。
查看原因：journalctl -u kixdns-panel.service -n 50 --no-pager"
  fi
  # 只检查这次亲手重启的 KixDNS：本来就在运行而没被动过的，不该让面板升级跟着回滚。
  # Only check a KixDNS this run restarted: one left untouched should not drag a panel upgrade into rollback.
  [[ ${KIXDNS_RESTART} == true ]] || return 0
  if ! wait_for_service_stable "${KIXDNS_SERVICE_UNIT}"; then
    abort_install "${KIXDNS_SERVICE_UNIT} 替换后没有保持运行。
查看原因：journalctl -u ${KIXDNS_SERVICE_UNIT} -n 50 --no-pager"
  fi
}

print_port53_notice() {
  if [[ ${RESOLVED_CHANGED} == true ]]; then
    printf '端口 %s：已关闭 systemd-resolved 的本机监听；卸载时选择移除 KixDNS 会恢复原样\n' "${RESOLVED_PORT}"
    return 0
  fi
  case ${PORT_CONFLICT} in
    resolved)
      printf '端口 %s：被 systemd-resolved 占用，在面板里启动 KixDNS 前先执行：\n' "${PORT_CONFLICT_PORT}"
      resolved_manual_commands
      ;;
    other)
      printf '端口 %s：被 %s占用，KixDNS 启动会失败；先停用这个程序，或在面板的基础设置里把 UDP / TCP 监听地址改到别的端口\n' \
        "${PORT_CONFLICT_PORT}" "$(holder_text)"
      ;;
  esac
}

print_summary() {
  local panel_url=$1
  local package_label
  package_label="$(package_panel_label)"
  printf '\n'
  if [[ ${INSTALL_KIND} == panel-only ]]; then
    printf '面板更新完成：KixDNS 面板 %s\n' "${package_label}"
  else
    printf '安装完成：KixDNS 面板 %s\n' "${package_label}"
  fi
  printf '面板地址：%s\n' "${panel_url}"
  case ${INSTALL_KIND} in
    fresh)
      printf 'KixDNS：已安装，尚未启动\n'
      ;;
    migrate)
      printf 'KixDNS：已迁移为增强版，保持原来的运行状态（%s）；原 unit 备份在 %s，卸载面板时可恢复\n' \
        "$(running_state_text "${KIXDNS_WAS_ACTIVE}")" "${EXTERNAL_BACKUP}"
      if [[ -z ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
        :
      elif [[ -f ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
        printf '配置：已复制到 %s 由面板管理，原来的 %s 不动\n' "${KIXDNS_CONFIG_PATH}" "${ORIGINAL_KIXDNS_CONFIG_PATH}"
      else
        printf '配置：%s 不存在，面板在 %s 写入了默认配置\n' "${ORIGINAL_KIXDNS_CONFIG_PATH}" "${KIXDNS_CONFIG_PATH}"
      fi
      if [[ -n ${PANEL_UNREADABLE_FILES} ]]; then
        printf 'Geo 文件：面板读不到原配置里写的这些，GeoSite 分类和 IP 地区标注会缺它们，DNS 不受影响：\n%s' \
          "${PANEL_UNREADABLE_FILES}"
        printf '让 kixdns-panel 账号能读到它们，刷新面板页面就有了。\n'
      fi
      ;;
    reclaim)
      printf 'KixDNS：已接回上次卸载时保留的 KixDNS，保持原来的运行状态（%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
      print_reclaim_backup_note
      ;;
    upgrade)
      if [[ ${PREVIOUS_PANEL_LABEL} == "${package_label}" ]]; then
        printf '面板：已重新安装 %s\n' "${package_label}"
      else
        printf '面板：已升级 %s → %s\n' "${PREVIOUS_PANEL_LABEL}" "${package_label}"
      fi
      if ! kixdns_replaced; then
        printf 'KixDNS：未变（%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
      elif [[ ${KIXDNS_RESTART} == true ]]; then
        printf 'KixDNS：已替换并按原状态重启（运行中）\n'
      else
        printf 'KixDNS：已替换，保持原状态（已停止）\n'
      fi
      ;;
    panel-only)
      printf 'KixDNS：未替换，配置与运行状态保持不变\n'
      ;;
  esac
  print_port53_notice
  if [[ ${TRUSTED_PROXIES_NOTICE} == true ]]; then
    printf '反向代理：panel.env 还信任本机代理（旧版的默认值 127.0.0.1/32,::1/128）；这台主机上没有反向代理时，清空它更安全：\n'
    printf "  sudo sed -i 's|^KIXDNS_TRUSTED_PROXIES=.*|KIXDNS_TRUSTED_PROXIES=|' %s && sudo systemctl restart kixdns-panel.service\n" \
      "${PANEL_ENV}"
  fi
  # 下一步放在端口 53 的提醒后面：那条要在启动 KixDNS 之前先做 / The next step comes after the port-53 notice, which has to happen before KixDNS starts
  [[ ${INSTALL_KIND} == fresh ]] && printf '下一步：打开面板地址，创建管理员，然后在概览页点「启动 KixDNS」\n'
  printf '只在可信内网使用面板；公网访问必须配置防火墙和 HTTPS 反向代理。\n'
  printf '构建：面板 %.12s · KixDNS %.12s\n' "${PANEL_BUILD_COMMIT}" "${KIXDNS_BUILD_COMMIT}"
}

main() {
  local panel_bind
  parse_arguments "$@"
  require_root
  command -v systemctl >/dev/null || fail "系统未安装 systemd"
  command -v getent >/dev/null || fail "系统缺少 getent"
  command -v sha256sum >/dev/null || fail "系统缺少 sha256sum"
  require_file "${PACKAGE_ROOT}/bin/kixdns"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-server"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-helper"
  require_file "${PACKAGE_ROOT}/web/index.html"
  require_file "${PACKAGE_ROOT}/geo/geosite.dat"
  require_file "${PACKAGE_ROOT}/geo/geosite.json"
  require_file "${PACKAGE_ROOT}/geo/LICENSE"
  require_file "${PACKAGE_ROOT}/deploy/config/pipeline.json"
  require_file "${PACKAGE_ROOT}/scripts/one-click-install.sh"
  require_file "${PACKAGE_ROOT}/scripts/panel-online-update.sh"
  require_file "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_SOURCE.json"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_NAME"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_DIGEST"
  require_file "${PACKAGE_ROOT}/KIXDNS_BINARY_SHA256"
  require_file "${PACKAGE_ROOT}/KIXDNS_CAPABILITIES.json"
  require_file "${PACKAGE_ROOT}/SHA256SUMS"
  PANEL_BUILD_COMMIT="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT")"
  KIXDNS_BUILD_COMMIT="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT")"
  KIXDNS_SOURCE_ID="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID")"
  KIXDNS_SOURCE=fork
  if [[ -f "${PACKAGE_ROOT}/PANEL_RELEASE" ]]; then
    PANEL_RELEASE="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_RELEASE")"
    [[ "${PANEL_RELEASE}" =~ ^[0-9A-Za-z._-]{1,100}$ ]] || fail "PANEL_RELEASE 标签无效"
  fi
  [[ "${PANEL_BUILD_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "PANEL_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${KIXDNS_BUILD_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "KIXDNS_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${KIXDNS_SOURCE_ID}" =~ ^[1-9][0-9]*$ ]] || fail "KIXDNS_ARTIFACT_ID 无效"

  (cd "${PACKAGE_ROOT}" && sha256sum --check --quiet SHA256SUMS) || fail "安装包摘要校验失败"

  # 所有提问都在改动主机之前问完；之后的步骤要么全部完成，要么全部回滚。
  # Every question is asked before the host is touched; after that the run either completes or rolls back.
  refuse_legacy_panel
  load_existing_panel_settings
  validate_panel_only_update
  skip_if_already_installed
  detect_existing_kixdns
  if [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    choose_install_mode
  fi
  determine_install_kind
  validate_install_mode
  require_dedicated_config_directory
  plan_kixdns_changes
  plan_port53
  require_regular_targets
  [[ ${INSTALL_KIND} != reclaim ]] || print_reclaim_plan

  printf '正在安装文件与服务…\n'
  # 从这里起出错或被中断都回滚，连这次建的账号和目录一起删掉 / From here on an error or interruption rolls back, removing
  # the accounts and directories this run created too
  prepare_rollback
  create_accounts
  create_panel_directories
  adopt_github_token
  preserve_external_install
  systemctl stop kixdns-panel.service 2>/dev/null || true
  backup_panel_database
  systemctl stop kixdns-panel-helper.service 2>/dev/null || true
  if [[ ${INSTALL_KIND} == panel-only ]]; then
    KIXDNS_BUILD_COMMIT="$(environment_value KIXDNS_INSTALLED_COMMIT || true)"
    KIXDNS_SOURCE_ID="$(environment_value KIXDNS_INSTALLED_SOURCE_ID || true)"
    KIXDNS_SOURCE="$(environment_value KIXDNS_INSTALLED_SOURCE || true)"
  elif kixdns_replaced; then
    if [[ ${KIXDNS_RESTART} == true ]]; then
      printf '正在停止 %s 以替换 KixDNS，完成后恢复原状态。\n' "${KIXDNS_SERVICE_UNIT}"
      systemctl stop "${KIXDNS_SERVICE_UNIT}"
    fi
    if [[ ${KIXDNS_BINARY_CHANGED} == true ]]; then
      install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 \
        "${PACKAGE_ROOT}/bin/kixdns" /var/lib/kixdns-panel/bin/.kixdns.new
      mv -fT -- /var/lib/kixdns-panel/bin/.kixdns.new "${MANAGED_KIXDNS_BINARY}"
    fi
  fi
  disable_resolved_stub
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-server" /usr/local/bin/.kixdns-panel-server.new
  mv -fT -- /usr/local/bin/.kixdns-panel-server.new "${PANEL_SERVER_BINARY}"
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/uninstall.sh" /usr/local/bin/.kixdns-panel-uninstall.new
  mv -fT -- /usr/local/bin/.kixdns-panel-uninstall.new /usr/local/bin/kixdns-panel-uninstall
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/one-click-install.sh" /usr/local/libexec/.kixdns-panel-one-click-install.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-one-click-install.new /usr/local/libexec/kixdns-panel-one-click-install
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/panel-online-update.sh" /usr/local/libexec/.kixdns-panel-online-update.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-online-update.new /usr/local/libexec/kixdns-panel-online-update
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-helper" /usr/local/libexec/.kixdns-panel-helper.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-helper.new /usr/local/libexec/kixdns-panel-helper
  install_web
  install_builtin_geo
  install_bundled_metadata
  if [[ ${INSTALL_KIND} == panel-only ]]; then
    update_panel_environment "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
  else
    install_configuration
    request_builtin_geosite_import
  fi
  install_services
  verify_services_started
  trap - ERR INT TERM HUP
  rm -rf -- "${BACKUP_ROOT}"

  panel_bind="$(environment_value KIXDNS_PANEL_BIND || true)"
  [[ -n ${panel_bind} ]] || panel_bind=0.0.0.0:5738
  print_summary "$(panel_access_url "${panel_bind}")"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
