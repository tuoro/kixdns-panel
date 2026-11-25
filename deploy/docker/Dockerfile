# syntax=docker/dockerfile:1
# KixDNS 面板的容器镜像：面板和内核在一个容器里，服务助手的看管模式（kixdns-panel-helper supervise）是主进程，用户数据都在
# /data。构建上下文由 scripts/package-docker.sh 从 OpenWrt 安装包拼出来：镜像里的程序就是 OpenWrt 上跑的那几个 musl 静态程序，
# /opt/kixdns-panel 的布局也和安装包一样（看管进程和容器里的面板在线更新都按这个布局找文件）。
#   docker build -f deploy/docker/Dockerfile <上下文>
# 目标阶段只有 COPY，没有 RUN：多架构构建不用模拟别的架构。时区数据和用户在构建机自己的架构上准备，都是和架构无关的文件。
#
# The KixDNS panel container image: the panel and the kernel in one container, with the service helper's supervise mode
# (kixdns-panel-helper supervise) as the main process and all user data under /data. The build context is put together
# from the OpenWrt packages by scripts/package-docker.sh: the programs in the image are the musl static programs OpenWrt
# runs, and /opt/kixdns-panel is laid out as the package (the supervisor and the panel's online update in the container
# both look for files by that layout).
# The target stage only COPYs and never RUNs, so a multi-architecture build emulates no other architecture. The time zone
# data and the users are prepared on the build machine's own architecture; both are architecture-independent files.

FROM --platform=$BUILDPLATFORM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS base
# 用户号和看管进程的默认值一样：内核 5533、面板 5738，共用 kixdns 组（5533），和 systemd 版一样分两个用户
# The ids are the supervisor's defaults: kernel 5533, panel 5738, sharing the kixdns group (5533), two users as on systemd
RUN apk add --no-cache tzdata \
  && addgroup -S -g 5533 kixdns \
  && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 5533 -G kixdns kixdns \
  && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 5738 -G kixdns kixdns-panel

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
ARG TARGETARCH
COPY --from=base /etc/passwd /etc/group /etc/shadow /etc/
COPY --from=base /usr/share/zoneinfo /usr/share/zoneinfo
COPY ${TARGETARCH}/ /opt/kixdns-panel/
LABEL org.opencontainers.image.title="KixDNS Panel" \
  org.opencontainers.image.description="KixDNS 面板和内核 / the KixDNS panel and kernel" \
  org.opencontainers.image.source="https://github.com/tuoro/kixdns-panel" \
  org.opencontainers.image.licenses="GPL-3.0-only"
VOLUME /data
EXPOSE 53/udp 53/tcp 5738/tcp
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=5s \
  CMD ["/opt/kixdns-panel/libexec/kixdns-panel-helper", "health"]
ENTRYPOINT ["/opt/kixdns-panel/libexec/kixdns-panel-helper", "supervise"]
