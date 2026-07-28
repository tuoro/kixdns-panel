#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PANEL_USER="kixdns-panel"
KIXDNS_USER="kixdns"
KIXDNS_GROUP="kixdns"
BACKUP_ROOT=""

fail() {
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || fail "请使用 root 权限运行"
}

require_file() {
  [[ -f "$1" ]] || fail "安装包缺少 $1"
}

detect_artifact() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s\n' 'kixdns-enhanced-linux-x86_64' ;;
    aarch64 | arm64) printf '%s\n' 'kixdns-enhanced-linux-arm64' ;;
    *) fail "仅支持 Linux x86_64 和 ARM64" ;;
  esac
}

create_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || groupadd --system "${KIXDNS_GROUP}"
  if id -u "${KIXDNS_USER}" >/dev/null 2>&1; then
    usermod --gid "${KIXDNS_GROUP}" "${KIXDNS_USER}"
  else
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${KIXDNS_USER}"
  fi
  if id -u "${PANEL_USER}" >/dev/null 2>&1; then
    usermod --gid "${KIXDNS_GROUP}" "${PANEL_USER}"
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

rollback_install() {
  local status=$1
  trap - ERR
  set +e
  restore_path /var/lib/kixdns-panel/bin/kixdns kixdns
  restore_path /usr/local/bin/kixdns-panel-server panel-server
  restore_path /usr/share/kixdns-panel/web web
  restore_path /etc/systemd/system/kixdns.service kixdns-service
  restore_path /etc/systemd/system/kixdns-panel.service panel-service
  restore_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  restore_path /etc/kixdns-panel/panel.env panel-env
  systemctl daemon-reload
  systemctl restart kixdns.service kixdns-panel.service
  rm -rf -- "${BACKUP_ROOT}"
  printf '安装未完成，已恢复原有程序和服务。\n' >&2
  exit "${status}"
}

prepare_rollback() {
  BACKUP_ROOT="$(mktemp -d /var/tmp/kixdns-panel-install.XXXXXX)"
  backup_path /var/lib/kixdns-panel/bin/kixdns kixdns
  backup_path /usr/local/bin/kixdns-panel-server panel-server
  backup_path /usr/share/kixdns-panel/web web
  backup_path /etc/systemd/system/kixdns.service kixdns-service
  backup_path /etc/systemd/system/kixdns-panel.service panel-service
  backup_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  backup_path /etc/kixdns-panel/panel.env panel-env
  trap 'rollback_install $?' ERR
}

install_web() {
  local target=/usr/share/kixdns-panel/web
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

set_installed_commit() {
  local commit=$1
  local target=/etc/kixdns-panel/panel.env
  local temporary
  temporary="$(mktemp /etc/kixdns-panel/.panel.env.XXXXXX)"
  if grep -q '^KIXDNS_INSTALLED_COMMIT=' "${target}"; then
    sed "s/^KIXDNS_INSTALLED_COMMIT=.*/KIXDNS_INSTALLED_COMMIT=${commit}/" "${target}" > "${temporary}"
  else
    cp -- "${target}" "${temporary}"
    printf 'KIXDNS_INSTALLED_COMMIT=%s\n' "${commit}" >> "${temporary}"
  fi
  chown root:"${KIXDNS_GROUP}" "${temporary}"
  chmod 0640 "${temporary}"
  mv -fT -- "${temporary}" "${target}"
}

install_configuration() {
  local build_commit=$1
  local artifact
  artifact="$(detect_artifact)"
  install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 /etc/kixdns
  install -d -o root -g "${KIXDNS_GROUP}" -m 0750 /etc/kixdns-panel
  if [[ ! -e /etc/kixdns/pipeline.json ]]; then
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 "${PACKAGE_ROOT}/deploy/config/pipeline.json" /etc/kixdns/pipeline.json
  fi
  if [[ ! -e /etc/kixdns-panel/panel.env ]]; then
    sed -e "s/^KIXDNS_UPDATE_ARTIFACT=.*/KIXDNS_UPDATE_ARTIFACT=${artifact}/" \
      -e "s/^KIXDNS_INSTALLED_COMMIT=.*/KIXDNS_INSTALLED_COMMIT=${build_commit}/" \
      "${PACKAGE_ROOT}/deploy/panel.env.example" > /etc/kixdns-panel/panel.env
    chown root:"${KIXDNS_GROUP}" /etc/kixdns-panel/panel.env
    chmod 0640 /etc/kixdns-panel/panel.env
  fi
  set_installed_commit "${build_commit}"
}

install_services() {
  install -o root -g root -m 0644 "${PACKAGE_ROOT}/deploy/systemd/kixdns.service" /etc/systemd/system/kixdns.service
  install -o root -g root -m 0644 "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel.service" /etc/systemd/system/kixdns-panel.service
  install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
  install -o root -g root -m 0644 "${PACKAGE_ROOT}/deploy/polkit/50-kixdns-panel.rules" /etc/polkit-1/rules.d/50-kixdns-panel.rules
  systemctl daemon-reload
  systemctl enable kixdns.service kixdns-panel.service
  systemctl restart kixdns.service
  systemctl restart kixdns-panel.service
}

main() {
  local build_commit
  require_root
  command -v systemctl >/dev/null || fail "系统未安装 systemd"
  command -v getent >/dev/null || fail "系统缺少 getent"
  command -v pkaction >/dev/null || fail "系统未安装 polkit"
  require_file "${PACKAGE_ROOT}/bin/kixdns"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-server"
  require_file "${PACKAGE_ROOT}/web/index.html"
  require_file "${PACKAGE_ROOT}/deploy/config/pipeline.json"
  require_file "${PACKAGE_ROOT}/BUILD_COMMIT"
  build_commit="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/BUILD_COMMIT")"
  [[ "${build_commit}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "BUILD_COMMIT 不是完整提交 SHA"

  if [[ -f "${PACKAGE_ROOT}/SHA256SUMS" ]]; then
    (cd "${PACKAGE_ROOT}" && sha256sum --check --quiet SHA256SUMS) || fail "安装包摘要校验失败"
  fi

  create_accounts
  install -d -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 /var/lib/kixdns-panel /var/lib/kixdns-panel/bin
  [[ ! -L /var/lib/kixdns-panel/bin/kixdns ]] || fail "KixDNS 二进制目标不能是符号链接"
  [[ ! -L /usr/local/bin/kixdns-panel-server ]] || fail "面板二进制目标不能是符号链接"
  prepare_rollback
  systemctl stop kixdns-panel.service kixdns.service 2>/dev/null || true
  install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 "${PACKAGE_ROOT}/bin/kixdns" /var/lib/kixdns-panel/bin/.kixdns.new
  mv -fT -- /var/lib/kixdns-panel/bin/.kixdns.new /var/lib/kixdns-panel/bin/kixdns
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-server" /usr/local/bin/.kixdns-panel-server.new
  mv -fT -- /usr/local/bin/.kixdns-panel-server.new /usr/local/bin/kixdns-panel-server
  install_web
  install_configuration "${build_commit}"
  install_services
  trap - ERR
  rm -rf -- "${BACKUP_ROOT}"

  printf '\n安装完成。\n'
  printf '面板地址：http://127.0.0.1:4165\n'
  printf '首次访问时创建管理员账号；远程访问请先配置 HTTPS 反向代理。\n'
}

main "$@"
