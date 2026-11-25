#!/usr/bin/env bash
# 容器镜像的验收：用 CI 刚拼的镜像把用户会走的路走一遍。
#   带着搬来的配置起容器（host 网络）→ 配置改给面板、导入成第一个版本 → 建管理员 → 内核以普通用户听低端口、能解析
#   → 保存一次配置 → 经面板重启、停止内核 → 重建容器：数据、管理员、停着的内核都还在 → docker stop 干净退出
#   → 桥接网络加端口映射、全新的数据卷：默认配置听 53，照样能解析
# 用法：test-docker-image.sh <镜像>
#
# Acceptance of the container image: the image CI just built walks the paths a user takes.
#   Start with a config brought over (host networking) → the config handed to the panel and imported as the first version
#   → create the administrator → the kernel listens on a low port as an ordinary user and answers → save a config → restart
#   and stop the kernel from the panel → rebuild the container: data, administrator and the stopped kernel all remain →
#   docker stop exits cleanly → bridge networking with port mapping on a new volume: the default config listens on 53 and
#   answers
set -Eeuo pipefail

IMAGE=${1:?用法：$0 <镜像>}
NAME=kixdns-docker-acceptance
PANEL=127.0.0.1:15738
# 低端口：内核以普通用户听上它，靠的是看管进程交给它的 CAP_NET_BIND_SERVICE。不用 53，runner 上的 systemd-resolved 占着它
# A low port: the kernel, an ordinary user, binds it through the CAP_NET_BIND_SERVICE the supervisor hands it. Not 53,
# which the runner's systemd-resolved holds
DNS_PORT=553
WORK="$(mktemp -d)"
DATA=${WORK}/data

log() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$? name
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

start_container() {
  docker run -d --name "${NAME}" --network host -v "${DATA}:/data" -e "KIXDNS_PANEL_BIND=${PANEL}" "${IMAGE}" >/dev/null
  wait_until 60 "面板健康" curl -sSf "http://${PANEL}/api/v1/health"
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

  log "经面板停止内核，重建容器以后还是停着"
  api POST /service/stop >/dev/null || fail "面板停止内核失败"
  [[ $(api GET /service | jq -r .active_state) == inactive ]] || fail "停止以后内核不是 inactive"
  docker rm -f "${NAME}" >/dev/null
  start_container
  [[ $(curl -sSf "http://${PANEL}/api/v1/setup") == *'"required":false'* ]] || fail "重建以后要重新建管理员：数据库没留下"
  login || fail "重建以后用原来的密码登录不上"
  [[ $(api GET /service | jq -r .active_state) == inactive ]] || fail "重建以后停着的内核自己起来了"
  api GET /config/versions | grep -q 'acceptance' || fail "重建以后配置的版本历史没了"
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
