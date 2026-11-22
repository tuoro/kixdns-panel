#!/usr/bin/env bash
# OpenWrt 安装包的验收：在 OpenWrt 官方的 rootfs 容器里（procd 当 1 号进程）把 CI 刚打的包从头走一遍。
#   全新安装 → 面板健康 → 在面板里启动内核（接管 53 端口、能解析、.lan 交给 dnsmasq）→ 停止（53 还给 dnsmasq）
#   → 在线更新（本机起一个假的 Release）→ 装到一半失败时整个放回 → 卸载、重装接上原来的数据 → --purge
# 用法：test-openwrt-package.sh <kixdns-panel-openwrt-<架构>.tar.gz> <镜像>
#
# Acceptance of the OpenWrt package: inside OpenWrt's official rootfs container (procd as PID 1) the package CI just built
# goes through its whole life: fresh install → panel healthy → start the kernel from the panel (port 53 taken over, queries
# answered, .lan handed to dnsmasq) → stop (53 back to dnsmasq) → online update (from a fake release served here) → a
# failure halfway put back whole → uninstall and a reinstall that picks the data up again → --purge
# 单引号里的 $ 是留给容器里的 sh 展开的 / The $ inside single quotes is left for the sh in the container to expand
# shellcheck disable=SC2016
set -Eeuo pipefail

PACKAGE=${1:?用法：$0 <安装包 tar.gz> <镜像>}
IMAGE=${2:?用法：$0 <安装包 tar.gz> <镜像>}
NAME=kixdns-openwrt-acceptance
PORT=5738
WORK="$(mktemp -d)"
SERVER_PID=""

log() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if ((status != 0)) && docker inspect "${NAME}" >/dev/null 2>&1; then
    printf '\n---- 容器里的日志 / logs from the container ----\n' >&2
    docker exec "${NAME}" sh -c 'logread | tail -80; echo; tail -40 /var/log/kixdns.log 2>/dev/null' >&2 || true
  fi
  [[ -z ${SERVER_PID} ]] || kill "${SERVER_PID}" 2>/dev/null || true
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

# 在容器里跑一段 sh / Run a piece of sh inside the container
owrt() { docker exec "${NAME}" sh -c "$1"; }

# 等到条件成立，最多这么多秒 / Wait until the condition holds, for at most this many seconds
wait_until() {
  local seconds=$1 what=$2
  shift 2
  for ((i = 0; i < seconds; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "${seconds} 秒内没有等到：${what}"
}

container_ip() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${NAME}"; }

# 面板接口：带着会话 cookie 和 CSRF 头 / The panel API, with the session cookie and the CSRF header
api() {
  local method=$1 path=$2 body=${3:-}
  local csrf
  csrf="$(awk '$6 == "kixdns_csrf" { print $7 }' "${WORK}/cookies" 2>/dev/null | tail -n 1)"
  local -a args=(-sS --max-time 60 -b "${WORK}/cookies" -c "${WORK}/cookies" -X "${method}" -H "x-csrf-token: ${csrf}")
  [[ -z ${body} ]] || args+=(-H 'content-type: application/json' --data "${body}")
  curl "${args[@]}" -w '\n%{http_code}' "http://${PANEL}/api/v1${path}"
}
# 接口回的 HTTP 状态码（最后一行）/ The HTTP status (last line) of an API answer
status_of() { tail -n 1 <<<"$1"; }

kernel_on_53() { owrt 'netstat -lnup 2>/dev/null | grep -E "[:.]53[[:space:]]" | grep -q kixdns'; }
dnsmasq_on() { owrt "netstat -lnup 2>/dev/null | grep -E '[:.]$1[[:space:]]' | grep -q dnsmasq"; }
resolves() { owrt "nslookup $1 127.0.0.1 2>/dev/null | grep -q '^Address: ${2:-}'"; }

main() {
  [[ -f ${PACKAGE} ]] || fail "找不到安装包 ${PACKAGE}"
  local package_name
  package_name="$(basename "${PACKAGE}" .tar.gz)"

  log "启动 OpenWrt 容器 ${IMAGE}"
  # 默认的网络配置会把容器的 eth0 收进 br-lan、换成 192.168.1.1，容器就断网了，宿主机也连不上它。换成一个空网桥当 LAN
  # （照样有 192.168.1.1，dnsmasq 照样在上面发 DHCP），eth0 留给 docker
  # The default network config takes the container's eth0 into br-lan as 192.168.1.1, cutting the container off and the
  # host from it. The LAN becomes an empty bridge instead (still 192.168.1.1, still served by dnsmasq), and eth0 stays
  # docker's
  cat >"${WORK}/network" <<'UCI'
config interface 'loopback'
	option device 'lo'
	option proto 'static'
	option ipaddr '127.0.0.1/8'

config globals 'globals'
	option ula_prefix 'fd00:6b69:7864::/48'

config device
	option name 'br-lan'
	option type 'bridge'
	option bridge_empty '1'

config interface 'lan'
	option device 'br-lan'
	option proto 'static'
	option ipaddr '192.168.1.1/24'
	option ip6assign '60'
UCI
  docker create --name "${NAME}" --privileged "${IMAGE}" /sbin/init >/dev/null
  docker cp "${WORK}/network" "${NAME}:/etc/config/network"
  docker start "${NAME}" >/dev/null
  wait_until 60 "procd 和 ubus 起来" owrt 'ubus call system board'
  owrt 'grep DISTRIB_DESCRIPTION /etc/openwrt_release'
  # 防火墙不归这里验：关掉，宿主机才连得上面板 / The firewall is not under test here: off, so the host reaches the panel
  owrt '/etc/init.d/firewall stop; /etc/init.d/firewall disable' >/dev/null 2>&1 || true
  # 让面板听所有地址，宿主机才连得上 / The panel listens on every address, so the host can reach it
  owrt "touch /etc/config/kixdns-panel; uci set kixdns-panel.main=panel; uci set kixdns-panel.main.bind='0.0.0.0:${PORT}'; uci commit kixdns-panel"
  PANEL="$(container_ip):${PORT}"
  # dnsmasq 认得的一个主机名，用来看 .lan 有没有交给它 / A host name dnsmasq knows, to see whether .lan reaches it
  owrt 'echo "10.9.9.9 probehost" >> /etc/hosts; /etc/init.d/dnsmasq restart'
  wait_until 20 "dnsmasq 在 53 上" dnsmasq_on 53

  log "全新安装"
  # OpenWrt 启动时在 /tmp 挂上内存盘，docker cp 拷到 /tmp 的会被它盖住：放在 /root / OpenWrt mounts a RAM disk on /tmp at boot,
  # hiding whatever docker cp put there: /root it is
  docker cp "${PACKAGE}" "${NAME}:/root/package.tar.gz"
  owrt "mkdir -p /root/package && tar -xzf /root/package.tar.gz -C /root/package && cd /root/package/${package_name} && sh install.sh"
  owrt 'for s in kixdns-panel kixdns-panel-helper; do ubus call service list "{\"name\":\"$s\"}" | grep -q "\"running\": true" || exit 1; done'
  local version
  version="$(curl -sS "http://${PANEL}/api/v1/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  [[ -n ${version} ]] || fail "面板没有答出健康检查"
  printf '面板 %s 已就绪\n' "${version}"
  owrt '[ ! -e /etc/rc.d/S95kixdns ] && grep -q "\[::\]:53" /etc/kixdns/pipeline.json' || fail "新装时内核不该开机自启，默认配置要听 [::]:53"

  log "初始化管理员、登录"
  local password
  password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  curl -sS -c "${WORK}/cookies" -H 'content-type: application/json' \
    --data "{\"username\":\"admin\",\"password\":\"${password}\"}" "http://${PANEL}/api/v1/setup" >/dev/null
  [[ $(status_of "$(api GET /auth/session)") == 200 ]] || fail "初始化以后没有登录上"

  log "在面板里启动内核：接管 53 端口"
  local answer
  answer="$(api POST /service/start)"
  [[ $(status_of "${answer}") == 200 ]] || fail "面板启动内核失败：${answer}"
  wait_until 20 "内核在 53 上" kernel_on_53
  dnsmasq_on 5353 || fail "dnsmasq 没有挪到 5353"
  owrt '[ "$(uci -q get kixdns-panel.handover)" = dnsmasq ] && uci -q get dhcp.lan.dhcp_option | grep -q "6,0.0.0.0"' ||
    fail "接管记录或 DHCP 的 DNS 选项不对"
  wait_until 20 "经内核解析 probehost.lan（.lan 交给 dnsmasq）" resolves probehost.lan 10.9.9.9
  wait_until 20 "经内核解析 example.com" resolves example.com
  owrt 'nslookup example.com ::1 2>/dev/null | grep -q "^Address: "' || fail "内核没有在 IPv6 上答"

  log "在面板里停止内核：53 还给 dnsmasq"
  answer="$(api POST /service/stop)"
  [[ $(status_of "${answer}") == 200 ]] || fail "面板停止内核失败：${answer}"
  wait_until 20 "dnsmasq 回到 53" dnsmasq_on 53
  owrt '[ -z "$(uci -q get kixdns-panel.handover)" ] && [ -z "$(uci -q get dhcp.@dnsmasq[0].port)" ] &&
    ! uci -q get dhcp.lan.dhcp_option | grep -q "6,0.0.0.0" && [ ! -e /etc/rc.d/S95kixdns ]' ||
    fail "停止以后没有原样还回去"
  wait_until 20 "经 dnsmasq 解析 probehost.lan" resolves probehost.lan 10.9.9.9

  log "在线更新：本机放一个假的 Release"
  # 包里补上 PANEL_RELEASE（PR 上打的包没有），重写校验表 / The package gains PANEL_RELEASE (packages built on pull requests
  # lack it), and its checksum list is written again
  owrt "cd /root/package/${package_name} && printf 'v%s\n' '${version}' > PANEL_RELEASE &&
    find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS &&
    cd /root/package && tar -czf /root/release.tar.gz ${package_name}"
  mkdir -p "${WORK}/release/download/v${version}"
  docker cp "${NAME}:/root/release.tar.gz" "${WORK}/release/download/v${version}/${package_name}.tar.gz"
  local gateway digest size
  gateway="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "${NAME}")"
  digest="$(sha256sum "${WORK}/release/download/v${version}/${package_name}.tar.gz" | cut -d' ' -f1)"
  size="$(stat -c %s "${WORK}/release/download/v${version}/${package_name}.tar.gz")"
  cat >"${WORK}/release/release.json" <<JSON
{"tag_name":"v${version}","assets":[{"name":"${package_name}.tar.gz","state":"uploaded","size":${size},
"digest":"sha256:${digest}","browser_download_url":"http://${gateway}:8765/download/v${version}/${package_name}.tar.gz"}]}
JSON
  (cd "${WORK}/release" && exec python3 -m http.server 8765 --bind 0.0.0.0) >/dev/null 2>&1 &
  SERVER_PID=$!
  owrt "sed -i -e 's|^RELEASE_API=.*|RELEASE_API=\"http://${gateway}:8765/release.json\"|' \
    -e 's|^DOWNLOAD_PREFIX=.*|DOWNLOAD_PREFIX=\"http://${gateway}:8765/download\"|' /usr/libexec/kixdns-panel-update"
  wait_until 10 "假的 Release 能取到" owrt "uclient-fetch -q -O /dev/null http://${gateway}:8765/release.json"
  owrt '/etc/init.d/kixdns-panel-update start'
  wait_until 120 "在线更新完成" owrt 'grep -q "\"complete\"" /var/lib/kixdns-panel-update/status.json'
  owrt 'cat /var/lib/kixdns-panel-update/status.json; echo'
  owrt "grep -q '^KIXDNS_PANEL_INSTALLED_RELEASE=v${version}$' /etc/kixdns-panel/panel.env" || fail "panel.env 没有记下 v${version}"
  wait_until 30 "更新后面板健康" curl -sSf "http://${PANEL}/api/v1/health"

  log "装到一半失败：整个放回原来的面板"
  owrt "cd /root/package/${package_name} && sed -i 's|command /usr/bin/kixdns-panel-server|command /usr/bin/kixdns-panel-server-missing|' init/kixdns-panel.init"
  if owrt "cd /root/package/${package_name} && PANEL_WAIT_SECONDS=20 sh install.sh --panel-only-update"; then
    fail "坏的包装上了"
  fi
  wait_until 30 "放回以后面板健康" curl -sSf "http://${PANEL}/api/v1/health"
  owrt 'grep -q "command /usr/bin/kixdns-panel-server$" /etc/init.d/kixdns-panel' || fail "init 脚本没有放回"

  log "卸载：配置和数据留着，重装接上"
  answer="$(api POST /service/start)"
  [[ $(status_of "${answer}") == 200 ]] || fail "面板启动内核失败：${answer}"
  wait_until 20 "内核在 53 上" kernel_on_53
  owrt 'sh /usr/libexec/kixdns-panel-uninstall'
  wait_until 20 "卸载以后 dnsmasq 回到 53" dnsmasq_on 53
  owrt '! ls /usr/bin/kixdns* /etc/init.d/kixdns* /etc/rc.d/*kixdns* 2>/dev/null && [ -f /etc/kixdns-panel/panel.db ]' ||
    fail "卸载以后程序没删干净，或者数据没留下"
  owrt "cd /root/package/${package_name} && sed -i 's/kixdns-panel-server-missing/kixdns-panel-server/' init/kixdns-panel.init && sh install.sh"
  [[ $(curl -sS "http://${PANEL}/api/v1/setup") == *'"required":false'* ]] || fail "重装以后没有接上原来的数据库"

  log "卸载 --purge"
  owrt 'sh /usr/libexec/kixdns-panel-uninstall --purge'
  owrt '! ls -d /etc/kixdns-panel /etc/kixdns /etc/config/kixdns-panel 2>/dev/null' || fail "--purge 没有删干净"
  dnsmasq_on 53 || fail "--purge 以后 dnsmasq 不在 53 上"

  log "通过"
}

main "$@"
