#!/usr/bin/env bash
# 容器镜像的验收：用 CI 刚拼的镜像把用户会走的路走一遍。
#   带着搬来的配置起容器（host 网络）→ 配置改给面板、导入成第一个版本 → 建管理员 → 内核以普通用户听低端口、能解析
#   → 保存一次配置 → 经面板重启内核 → 面板在线更新（本机起一个假的 Release，用的就是镜像拼自的那个 OpenWrt 安装包）：换上在线装的
#   那份、更新期间 DNS 一直答、内核不重启 → 更新到起不来的新版：看管进程退回上一份、系统页说为什么 → 停止内核 → 重建容器：数据、
#   管理员、停着的内核、在线装的版本都还在 → docker stop 干净退出 → 桥接网络加端口映射、全新的数据卷：默认配置听 53，照样能解析
# 用法：test-docker-image.sh <镜像> <镜像拼自的 kixdns-panel-openwrt-<架构>.tar.gz>
#
# Acceptance of the container image: the image CI just built walks the paths a user takes.
#   Start with a config brought over (host networking) → the config handed to the panel and imported as the first version
#   → create the administrator → the kernel listens on a low port as an ordinary user and answers → save a config → restart
#   the kernel from the panel → an online panel update (from a fake release served here, carrying the very OpenWrt package
#   the image was made from): the online copy takes over, DNS answers throughout and the kernel is not restarted → an
#   update to a new version that does not come up: the supervisor goes back to the copy before and the system page says
#   why → stop the kernel → rebuild the container: data, administrator, the stopped kernel and the online copy all remain
#   → docker stop exits cleanly → bridge networking with port mapping on a new volume: the default config listens on 53
#   and answers
set -Eeuo pipefail

IMAGE=${1:?用法：$0 <镜像> <OpenWrt 安装包 tar.gz>}
PACKAGE=${2:?用法：$0 <镜像> <OpenWrt 安装包 tar.gz>}
NAME=kixdns-docker-acceptance
PANEL=127.0.0.1:15738
# 低端口：内核以普通用户听上它，靠的是看管进程交给它的 CAP_NET_BIND_SERVICE。不用 53，runner 上的 systemd-resolved 占着它
# A low port: the kernel, an ordinary user, binds it through the CAP_NET_BIND_SERVICE the supervisor hands it. Not 53,
# which the runner's systemd-resolved holds
DNS_PORT=553
# 假的 Release：面板从这里读最新发布、下载安装包 / The fake release: the panel reads the latest release and downloads the
# package from here
RELEASE_PORT=8765
WORK="$(mktemp -d)"
DATA=${WORK}/data
SERVER_PID=""
WATCH_PID=""

log() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$? name
  [[ -z ${SERVER_PID} ]] || kill "${SERVER_PID}" 2>/dev/null || true
  [[ -z ${WATCH_PID} ]] || kill "${WATCH_PID}" 2>/dev/null || true
  for name in "${NAME}" "${NAME}-bridge"; do
    if ((status != 0)) && docker inspect "${name}" >/dev/null 2>&1; then
      printf '\n---- %s 的日志 / logs of %s ----\n' "${name}" "${name}" >&2
      docker logs --tail 80 "${name}" >&2 || true
      docker exec "${name}" sh -c 'tail -40 /data/logs/kixdns.log; cat /data/supervisor/state.json' >&2 || true
    fi
    docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  # 卷里的文件归容器里的用户，用镜像自己的 rm 删 / The volume's files belong to the container's users, so the image's own
  # rm removes them
  docker run --rm -v "${WORK}:/work" --entrypoint /bin/rm "${IMAGE}" -rf /work/data /work/bridge >/dev/null 2>&1 || true
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

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

# 面板接口：带着会话 cookie 和 CSRF 头，只输出回答，状态码不是 2xx 时失败 / The panel API with the session cookie and the CSRF
# header; prints the answer and fails on a status other than 2xx
api() {
  local method=$1 path=$2 body=${3:-} csrf
  csrf="$(awk '$6 == "kixdns_csrf" { print $7 }' "${WORK}/cookies" 2>/dev/null | tail -n 1)"
  local -a args=(-sSf --max-time 60 -b "${WORK}/cookies" -c "${WORK}/cookies" -X "${method}" -H "x-csrf-token: ${csrf}")
  [[ -z ${body} ]] || args+=(-H 'content-type: application/json' --data "${body}")
  curl "${args[@]}" "http://${PANEL}/api/v1${path}"
}

# 经 UDP 问一个 A 记录，有答案才算 / Asks for an A record over UDP; only an answer counts
resolves() {
  python3 - "$1" "$2" <<'PY'
import random, socket, struct, sys

port, name = int(sys.argv[1]), sys.argv[2]
query = struct.pack(">HHHHHH", random.randrange(65536), 0x0100, 1, 0, 0, 0)
query += b"".join(bytes([len(label)]) + label.encode() for label in name.split(".")) + b"\0\0\1\0\1"
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
    client.settimeout(3)
    client.sendto(query, ("127.0.0.1", port))
    answer = client.recv(4096)
sys.exit(0 if answer[:2] == query[:2] and answer[3] & 0x0F == 0 and answer[6:8] != b"\0\0" else 1)
PY
}

# 内核在跑时的 pid / The kernel's pid while it runs
kernel_pid() { api GET /service | jq -er 'select(.active_state == "active") | .main_pid'; }

# 面板在线更新的状态是不是 $1 / Whether the panel online update's state is $1
update_state() { [[ $(api GET /panel-update | jq -r .state) == "$1" ]]; }

# 把镜像拼自的那个 OpenWrt 安装包标成正式版 $1（补上 PANEL_RELEASE），当作假 Release 的资产放出去
# The OpenWrt package the image was made from, marked as release $1 (PANEL_RELEASE added), becomes the fake release's asset
publish_release() {
  local tag=$1 name top digest size
  name="$(basename "${PACKAGE}")"
  top=${name%.tar.gz}
  rm -rf -- "${WORK}/repack"
  mkdir -p "${WORK}/repack" "${WORK}/release"
  tar -xzf "${PACKAGE}" -C "${WORK}/repack"
  printf '%s\n' "${tag}" >"${WORK}/repack/${top}/PANEL_RELEASE"
  tar -czf "${WORK}/release/${name}" -C "${WORK}/repack" "${top}"
  digest="$(sha256sum "${WORK}/release/${name}" | cut -d' ' -f1)"
  size="$(stat -c %s "${WORK}/release/${name}")"
  cat >"${WORK}/release/release.json" <<JSON
{"tag_name":"${tag}","published_at":"2026-11-26T00:00:00Z","assets":[{"id":7,"name":"${name}","size":${size},
"digest":"sha256:${digest}","browser_download_url":"http://127.0.0.1:${RELEASE_PORT}/${name}"}]}
JSON
}

# 在后台一直问（每秒几次），没答上的记一笔；DNS_MISSES 有内容就是断过 / Keeps asking in the background (a few times a
# second), noting each unanswered query; anything in DNS_MISSES means DNS went away
watch_dns() {
  : >"${WORK}/dns-misses"
  (while :; do
    resolves "${DNS_PORT}" example.com || date +%T.%N >>"${WORK}/dns-misses"
    sleep 0.2
  done) &
  WATCH_PID=$!
}
stop_watching_dns() {
  kill "${WATCH_PID}"
  wait "${WATCH_PID}" 2>/dev/null || true
  WATCH_PID=""
  [[ ! -s ${WORK}/dns-misses ]] || fail "$1期间有 $(wc -l <"${WORK}/dns-misses") 次查询没有答上"
}

start_container() {
  docker run -d --name "${NAME}" --network host -v "${DATA}:/data" -e "KIXDNS_PANEL_BIND=${PANEL}" \
    -e "KIXDNS_PANEL_RELEASE_API=http://127.0.0.1:${RELEASE_PORT}/release.json" "${IMAGE}" >/dev/null
  wait_until 60 "面板健康" curl -sSf "http://${PANEL}/api/v1/health"
}

# 正在跑的面板程序，按命令行认：/proc/<pid>/exe 要能 ptrace 才读得到，容器里的 root 没有这个能力
# The panel program that runs, told by its command line: /proc/<pid>/exe needs the right to ptrace, which root in the
# container lacks
panel_program() {
  docker exec "${NAME}" sh -c 'for process in /proc/[0-9]*; do tr "\0" "\n" <"${process}/cmdline" | head -n 1; done' 2>/dev/null |
    grep '/kixdns-panel-server$'
}

login() {
  rm -f -- "${WORK}/cookies"
  curl -sSf -c "${WORK}/cookies" -H 'content-type: application/json' \
    --data "{\"username\":\"admin\",\"password\":\"${PASSWORD}\"}" "http://${PANEL}/api/v1/auth/login" >/dev/null
}

main() {
  log "从现有安装搬来：配置先放进 /data/config"
  mkdir -p "${DATA}/config"
  jq --arg bind "127.0.0.1:${DNS_PORT}" '.settings.bind_udp = $bind | .settings.bind_tcp = $bind' \
    deploy/config/pipeline.json >"${DATA}/config/pipeline.json"
  chmod 600 "${DATA}/config/pipeline.json"

  log "起容器（host 网络）"
  start_container
  [[ $(docker exec "${NAME}" stat -c '%u:%g %a' /data/config/pipeline.json) == '5738:5533 640' ]] ||
    fail "搬来的配置没有改给面板（要 5738:5533 640）"
  docker exec "${NAME}" /opt/kixdns-panel/libexec/kixdns-panel-helper health || fail "镜像的健康检查不过"
  wait_until 60 "容器的健康状态变成 healthy" \
    bash -c "[[ \$(docker inspect -f '{{.State.Health.Status}}' ${NAME}) == healthy ]]"

  log "建管理员"
  PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  curl -sSf -c "${WORK}/cookies" -H 'content-type: application/json' \
    --data "{\"username\":\"admin\",\"password\":\"${PASSWORD}\"}" "http://${PANEL}/api/v1/setup" >/dev/null
  api GET /auth/session >/dev/null || fail "建好管理员以后没有登录上"
  api GET /config/versions | grep -q '导入启动时配置' || fail "搬来的配置没有导入成第一个版本"

  log "内核以普通用户听 ${DNS_PORT}，能解析"
  wait_until 30 "内核在跑" kernel_pid
  wait_until 30 "经内核解析 example.com" resolves "${DNS_PORT}" example.com
  local pid
  pid="$(kernel_pid)"
  docker exec "${NAME}" sh -c "grep -q '^Uid:[[:space:]]*5533[[:space:]]' /proc/${pid}/status &&
    grep -q '^CapEff:[[:space:]]*0000000000000400$' /proc/${pid}/status &&
    grep -q '^CapAmb:[[:space:]]*0000000000000400$' /proc/${pid}/status &&
    grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/${pid}/status &&
    grep -q '^Max open files *65536 *65536 ' /proc/${pid}/limits" ||
    fail "内核不是只带 CAP_NET_BIND_SERVICE、描述符上限 65536 的 5533 用户"
  docker exec "${NAME}" sh -c "grep -q '^Uid:[[:space:]]*5738[[:space:]]' /proc/\$(pidof kixdns-panel-server)/status" ||
    fail "面板不是 5738 用户"

  log "保存一次配置"
  local config body
  config="$(api GET /config)"
  body="$(jq -c '{content: (.content | .settings.min_ttl = 60), expected_sha256: .sha256, message: "acceptance"}' <<<"${config}")"
  [[ $(api PUT /config "${body}" | jq -r .apply_state) == applied ]] || fail "保存的配置没有生效"
  docker exec "${NAME}" grep -q '"min_ttl": 60' /data/config/pipeline.json || fail "配置文件没有写进 /data/config"
  wait_until 20 "保存以后照样能解析" resolves "${DNS_PORT}" example.org

  log "经面板重启内核"
  api POST /service/restart >/dev/null || fail "面板重启内核失败"
  [[ $(kernel_pid) != "${pid}" ]] || fail "重启以后内核还是原来那个进程"
  wait_until 30 "重启以后能解析" resolves "${DNS_PORT}" example.com

  log "面板在线更新：换上在线装的那份，更新期间 DNS 一直答、内核不重启"
  local version kernel online
  version="$(curl -sSf "http://${PANEL}/api/v1/health" | jq -r .version)"
  (cd "${WORK}" && mkdir -p release && cd release && exec python3 -m http.server "${RELEASE_PORT}" --bind 127.0.0.1) \
    >/dev/null 2>&1 &
  SERVER_PID=$!
  kernel="$(kernel_pid)"
  # 正式版的镜像已经是这一版，不会再提示更新到它；PR 和 main 上的镜像没有正式版身份，更新到同一版本就是一次完整的在线更新
  # A release image already is this version and is not offered it again; images on pull requests and main carry no
  # release identity, so an update to the same version is a whole online update
  online=false
  if docker exec "${NAME}" test -f /opt/kixdns-panel/PANEL_RELEASE; then
    printf '正式版的镜像：已经是 v%s，跳过更新到同一版本\n' "${version}"
  else
    publish_release "v${version}"
    wait_until 10 "假的 Release 能取到" curl -sSf "http://127.0.0.1:${RELEASE_PORT}/release.json"
    watch_dns
    api POST /panel-update >/dev/null || fail "面板在线更新没有开始"
    wait_until 120 "在线更新完成" update_state complete
    stop_watching_dns "在线更新"
    [[ $(panel_program) == "/data/panel/${version}/bin/kixdns-panel-server" ]] || fail "跑的不是在线装的那份：$(panel_program)"
    [[ $(api GET /container | jq -r .online) == true ]] || fail "系统页没说跑的是在线装的那份"
    [[ $(kernel_pid) == "${kernel}" ]] || fail "面板在线更新时内核被重启了"
    online=true
  fi

  log "更新到起不来的新版：看管进程退回上一份，系统页说为什么"
  # 程序还是这一版，标签却是 v99.0.0：面板启动时认出不一致就退出，正好是「新版起不来」
  # The program is still this version but the tag says v99.0.0: the panel exits at start on the mismatch, which is exactly
  # a new version that does not come up
  publish_release v99.0.0
  watch_dns
  api POST /panel-update >/dev/null || fail "面板在线更新没有开始"
  wait_until 180 "退回上一份" update_state failed
  stop_watching_dns "退回"
  local message
  message="$(api GET /panel-update | jq -r .message)"
  [[ ${message} == *"v99.0.0 没能起来"*"连着退出了 3 次"* ]] || fail "系统页没说为什么退回：${message}"
  [[ $(api GET /container | jq -r .online) == "${online}" ]] || fail "没有退回上一份"
  [[ $(kernel_pid) == "${kernel}" ]] || fail "退回时内核被重启了"

  log "经面板停止内核，重建容器以后还是停着"
  api POST /service/stop >/dev/null || fail "面板停止内核失败"
  [[ $(api GET /service | jq -r .active_state) == inactive ]] || fail "停止以后内核不是 inactive"
  docker rm -f "${NAME}" >/dev/null
  start_container
  [[ $(curl -sSf "http://${PANEL}/api/v1/setup") == *'"required":false'* ]] || fail "重建以后要重新建管理员：数据库没留下"
  login || fail "重建以后用原来的密码登录不上"
  [[ $(api GET /service | jq -r .active_state) == inactive ]] || fail "重建以后停着的内核自己起来了"
  api GET /config/versions | grep -q 'acceptance' || fail "重建以后配置的版本历史没了"
  [[ $(api GET /container | jq -r .online) == "${online}" ]] || fail "重建以后在线装的那份没接着跑"
  docker exec "${NAME}" cat /data/supervisor/state.json | jq -e '.failed_panels["99.0.0"]' >/dev/null ||
    fail "重建以后忘了 v99.0.0 起不来"
  api POST /service/start >/dev/null || fail "面板启动内核失败"
  wait_until 30 "启动以后能解析" resolves "${DNS_PORT}" example.com

  log "docker stop：看管进程停下面板和内核，干净退出"
  docker stop -t 15 "${NAME}" >/dev/null
  [[ $(docker inspect -f '{{.State.ExitCode}}' "${NAME}") == 0 ]] || fail "docker stop 以后退出码不是 0"
  docker rm "${NAME}" >/dev/null

  log "桥接网络加端口映射、全新的数据卷：默认配置听 53"
  docker run -d --name "${NAME}-bridge" -p 127.0.0.1:15353:53/udp -p 127.0.0.1:15739:5738/tcp \
    -v "${WORK}/bridge:/data" "${IMAGE}" >/dev/null
  wait_until 60 "桥接网络下面板健康" curl -sSf http://127.0.0.1:15739/api/v1/health
  wait_until 30 "桥接网络下经映射的 53 解析" resolves 15353 example.com

  log "通过"
}

main "$@"
