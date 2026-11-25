#!/usr/bin/env bash
# 拼容器镜像的构建上下文：从 OpenWrt 安装包（scripts/package-openwrt.sh 打的）里取出镜像要的文件，每个架构一个目录（Docker 的
# 架构名：amd64、arm64），布局照旧，默认配置换成 systemd 版的那份。CI 和本机都用这一份。
#   用法：package-docker.sh <输出目录> <kixdns-panel-openwrt-<架构>.tar.gz>…
#   然后：docker build -f deploy/docker/Dockerfile <输出目录>
# 看管进程和容器里的面板在线更新按这个布局找文件：OpenWrt 安装包的布局改了，这里和它们要一起改
#
# Puts together the container image's build context: the files the image needs are taken from the OpenWrt packages
# (made by scripts/package-openwrt.sh), one directory per architecture (Docker's names: amd64, arm64), in the same layout,
# with the systemd default config in place of OpenWrt's. CI and local runs share this script.
# The supervisor and the panel's online update in the container look for files by this layout: a change to the OpenWrt
# package's layout has to change them together
set -Eeuo pipefail

fail() {
  printf '拼容器镜像的构建上下文失败：%s\n' "$*" >&2
  exit 1
}

main() {
  [[ $# -ge 2 ]] || {
    printf '用法：%s <输出目录> <kixdns-panel-openwrt-<架构>.tar.gz>…\n' "$0" >&2
    exit 2
  }
  local output=$1 root package name architecture file
  shift
  root="$(cd "$(dirname "$0")/.." && pwd)"
  mkdir -p -- "${output}"
  # 不是 local：退出时的 trap 还要用它 / Not local: the exit trap still needs it
  work="$(mktemp -d)"
  trap 'rm -rf -- "${work}"' EXIT
  for package in "$@"; do
    name="$(basename -- "${package}" .tar.gz)"
    case ${name} in
      kixdns-panel-openwrt-x86_64) architecture=amd64 ;;
      kixdns-panel-openwrt-arm64) architecture=arm64 ;;
      *) fail "不认识的安装包：${package}" ;;
    esac
    tar -xzf "${package}" -C "${work}"
    for file in bin/kixdns bin/kixdns-panel-server libexec/kixdns-panel-helper web/index.html geo/geosite.json \
      bundle/KIXDNS_SOURCE.json LICENSE; do
      [[ -f ${work}/${name}/${file} ]] || fail "${package} 里缺少 ${file}"
    done
    rm -rf -- "${output:?}/${architecture}"
    mkdir -p -- "${output}/${architecture}/libexec" "${output}/${architecture}/etc"
    cp -R -- "${work}/${name}/bin" "${work}/${name}/web" "${work}/${name}/geo" "${work}/${name}/bundle" \
      "${output}/${architecture}/"
    cp -- "${work}/${name}/libexec/kixdns-panel-helper" "${output}/${architecture}/libexec/"
    cp -- "${work}/${name}/LICENSE" "${output}/${architecture}/"
    # 正式版才有 PANEL_RELEASE；PANEL_BUILD_COMMIT 是 CI 写的 / Only releases have PANEL_RELEASE; CI writes PANEL_BUILD_COMMIT
    for file in PANEL_RELEASE PANEL_BUILD_COMMIT; do
      [[ ! -f ${work}/${name}/${file} ]] || cp -- "${work}/${name}/${file}" "${output}/${architecture}/"
    done
    cp -- "${root}/deploy/config/pipeline.json" "${output}/${architecture}/etc/pipeline.json"
    chmod 0755 "${output}/${architecture}/bin/kixdns" "${output}/${architecture}/bin/kixdns-panel-server" \
      "${output}/${architecture}/libexec/kixdns-panel-helper"
    printf '容器镜像 %s：%s\n' "${architecture}" "${output}/${architecture}"
  done
}

main "$@"
