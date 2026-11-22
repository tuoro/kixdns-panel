#!/usr/bin/env bash
# 拼 OpenWrt 安装包：目录结构照 deploy/openwrt/README.md 的「目录布局与来源」，包里带上自带内核的身份（bundle/），
# 三个程序都得是这个架构的静态链接程序。写出 <输出目录>/kixdns-panel-openwrt-<架构>/ 和同名的 .tar.gz。
# CI 和本机都用这一份：本机拼出来的包就能直接拿去真机或虚拟机上试。
# Assembles the OpenWrt package: the layout follows "目录布局与来源" in deploy/openwrt/README.md, the package carries
# the bundled kernel's identity (bundle/), and all three programs must be statically linked programs of this
# architecture. Writes <output>/kixdns-panel-openwrt-<arch>/ and a .tar.gz of the same name. CI and local runs share
# this script, so a package assembled locally can go straight onto a device or a VM.
set -Eeuo pipefail

fail() {
  printf '拼 OpenWrt 安装包失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  printf '用法：%s <x86_64|arm64> <面板程序目录> <musl 内核目录> <GeoSite 目录> <前端 dist> <输出目录>\n' "$0" >&2
  printf '  面板程序目录里要有 kixdns-panel-server、kixdns-panel-helper（musl 版）\n' >&2
  printf '  musl 内核目录是 fetch-kixdns-release.sh … musl 的输出\n' >&2
  exit 2
}

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum -- "$@"
  else
    shasum -a 256 -- "$@"
  fi
}

# 这个架构的静态链接程序 / A statically linked program of this architecture
check_program() {
  local path=$1 machine=$2 headers
  [[ -f ${path} ]] || fail "缺少 ${path}"
  headers="$(LC_ALL=C readelf -h -l -- "${path}")" || fail "${path} 不是 ELF"
  grep -q "Machine:[[:space:]]*${machine}" <<< "${headers}" || fail "${path} 不是 ${machine}"
  if grep -q 'INTERP' <<< "${headers}"; then
    fail "${path} 不是静态链接"
  fi
}

main() {
  [[ $# -eq 6 ]] || usage
  local architecture=$1 programs=$2 kernel=$3 geo=$4 web=$5 output=$6
  local root machine name package file version
  root="$(cd "$(dirname "$0")/.." && pwd)"
  for command in jq readelf tar find; do
    command -v "${command}" >/dev/null || fail "缺少命令 ${command}"
  done
  case ${architecture} in
    x86_64) machine='Advanced Micro Devices X86-64' ;;
    arm64) machine='AArch64' ;;
    *) fail "架构无效：${architecture}" ;;
  esac
  check_program "${programs}/kixdns-panel-server" "${machine}"
  check_program "${programs}/kixdns-panel-helper" "${machine}"
  check_program "${kernel}/kixdns" "${machine}"
  for file in KIXDNS_BUILD_COMMIT KIXDNS_SOURCE.json KIXDNS_CAPABILITIES.json KIXDNS_ARTIFACT_ID \
    KIXDNS_ARTIFACT_NAME KIXDNS_ARTIFACT_DIGEST KIXDNS_BINARY_SHA256; do
    [[ -f ${kernel}/${file} ]] || fail "内核目录缺少 ${file}"
  done
  jq -e --arg architecture "${architecture}" '.arch == $architecture and .libc == "musl"' \
    "${kernel}/KIXDNS_SOURCE.json" >/dev/null || fail "内核不是 ${architecture} 的 musl 版"
  [[ $(sha256 "${kernel}/kixdns" | awk '{ print $1 }') == "$(cat "${kernel}/KIXDNS_BINARY_SHA256")" ]] ||
    fail "内核程序和 KIXDNS_BINARY_SHA256 对不上"
  [[ -f ${geo}/geosite.dat && -f ${geo}/geosite.json ]] || fail "GeoSite 目录缺少 geosite.dat 或 geosite.json"
  [[ -f ${web}/index.html ]] || fail "前端 dist 里没有 index.html，先 npm run build"

  name="kixdns-panel-openwrt-${architecture}"
  package="${output}/${name}"
  rm -rf -- "${package}" "${package}.tar.gz"
  mkdir -p -- "${package}"/{bin,libexec,web,geo,init,etc,bundle}

  cp -- "${root}/deploy/openwrt/install.sh" "${package}/install.sh"
  cp -- "${root}/deploy/openwrt/README.md" "${package}/README.md"
  cp -- "${root}/LICENSE" "${package}/LICENSE"
  cp -- "${kernel}/kixdns" "${package}/bin/kixdns"
  cp -- "${programs}/kixdns-panel-server" "${package}/bin/kixdns-panel-server"
  cp -- "${programs}/kixdns-panel-helper" "${package}/libexec/kixdns-panel-helper"
  cp -- "${root}/deploy/openwrt/panel-update.sh" "${package}/libexec/kixdns-panel-update"
  cp -R -- "${web}/." "${package}/web/"
  for file in geosite.dat geosite.json geoip.dat LICENSE; do
    if [[ -f ${geo}/${file} ]]; then
      cp -- "${geo}/${file}" "${package}/geo/${file}"
    fi
  done
  cp -- "${root}"/deploy/openwrt/init/*.init "${package}/init/"
  # OpenWrt 自己的默认配置：IPv4、IPv6 都听（odhcpd 把路由器的 IPv6 地址发给客户端当 DNS），.lan 交给 5353 上的 dnsmasq
  # OpenWrt's own default config: listening on IPv4 and IPv6 (odhcpd gives clients the router's IPv6 address as DNS), with
  # .lan going to dnsmasq on 5353
  cp -- "${root}/deploy/openwrt/pipeline.json" "${package}/etc/pipeline.json"
  cp -- "${kernel}"/KIXDNS_* "${package}/bundle/"
  if [[ -n ${PANEL_BUILD_COMMIT:-} ]]; then
    [[ ${PANEL_BUILD_COMMIT} =~ ^[0-9a-f]{40}$ ]] || fail "PANEL_BUILD_COMMIT 不是 40 位提交号"
    printf '%s\n' "${PANEL_BUILD_COMMIT}" > "${package}/PANEL_BUILD_COMMIT"
  fi
  # 正式版的包记下 Release 标签：面板按它判断有没有新版，在线更新器核对下载的包就是那个 Release 的。它必须是面板程序
  # 的版本，不然面板启动时就不认
  # A release package records its release tag: the panel decides from it whether a newer one exists, and the online
  # updater checks that the package it downloaded belongs to that release. It must be the panel program's version, or the
  # panel refuses it at start-up
  if [[ -n ${PANEL_RELEASE:-} ]]; then
    [[ ${PANEL_RELEASE} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "PANEL_RELEASE 不是 vX.Y.Z：${PANEL_RELEASE}"
    version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "${root}/crates/panel-server/Cargo.toml" | head -n 1)"
    [[ ${PANEL_RELEASE} == "v${version}" ]] || fail "PANEL_RELEASE ${PANEL_RELEASE} 与面板版本 ${version} 不一致"
    printf '%s\n' "${PANEL_RELEASE}" > "${package}/PANEL_RELEASE"
  fi
  # 上传成 CI 产物时执行位会丢，装的时候 install.sh 也会再设一遍 / Exec bits are lost as a CI artifact; install.sh sets them again
  chmod 0755 "${package}/install.sh" "${package}/bin/kixdns" "${package}/bin/kixdns-panel-server" \
    "${package}/libexec/kixdns-panel-helper" "${package}/libexec/kixdns-panel-update" "${package}"/init/*.init

  # 校验表先写在包外面，免得把自己也算进去 / The checksum list is written outside the package first so it does not list itself
  (
    cd "${package}"
    find . -type f -print | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r file; do
      sha256 "${file}"
    done
  ) > "${output}/.${name}.SHA256SUMS"
  mv -- "${output}/.${name}.SHA256SUMS" "${package}/SHA256SUMS"
  COPYFILE_DISABLE=1 tar -C "${output}" -czf "${package}.tar.gz" "${name}"
  printf 'OpenWrt 安装包：%s.tar.gz（内核 %s）\n' "${package}" "$(jq -r .version "${kernel}/KIXDNS_SOURCE.json")"
}

main "$@"
