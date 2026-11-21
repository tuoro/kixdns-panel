#!/bin/sh
# KixDNS 面板 —— OpenWrt 安装脚本（不依赖 opkg / ipk，直接铺文件）
#
# 用法（在解压后的 payload 根目录执行）：
#   sh install.sh            # 安装并启动面板（内核先不启动）
#   START_DNS=1 sh install.sh  # 装完连内核一起启动（会占 53，先确认没有别的 DNS）
set -e

ROOT=${ROOT:-/}
SRC=$(cd "$(dirname "$0")" && pwd)

DEST_BIN="$ROOT/usr/bin"
DEST_LIBEXEC="$ROOT/usr/libexec"
DEST_SHARE="$ROOT/usr/share/kixdns-panel"
DEST_ETC="$ROOT/etc"
DEST_STATE="$ROOT/etc/kixdns-panel"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -x "$SRC/bin/kixdns" ] || die "缺少 bin/kixdns"
[ -x "$SRC/bin/kixdns-panel-server" ] || die "缺少 bin/kixdns-panel-server"
[ -x "$SRC/libexec/kixdns-panel-helper" ] || die "缺少 libexec/kixdns-panel-helper"
[ -d "$SRC/web" ] || die "缺少 web/（前端构建产物）"

mkdir -p "$DEST_BIN" "$DEST_LIBEXEC" "$DEST_SHARE" "$DEST_STATE/geo" "$ROOT/etc/kixdns" "$ROOT/var/log" "$ROOT/run/kixdns-panel"

# 先停旧实例，避免 "Text file busy"
for svc in kixdns-panel kixdns-panel-helper kixdns; do
	[ -x "$DEST_ETC/init.d/$svc" ] && "$DEST_ETC/init.d/$svc" stop 2>/dev/null || true
done

cp -f "$SRC/bin/kixdns" "$DEST_BIN/kixdns"
cp -f "$SRC/bin/kixdns-panel-server" "$DEST_BIN/kixdns-panel-server"
cp -f "$SRC/libexec/kixdns-panel-helper" "$DEST_LIBEXEC/kixdns-panel-helper"
chmod 755 "$DEST_BIN/kixdns" "$DEST_BIN/kixdns-panel-server" "$DEST_LIBEXEC/kixdns-panel-helper"

rm -rf "$DEST_SHARE/web"
cp -a "$SRC/web" "$DEST_SHARE/web"

mkdir -p "$DEST_SHARE/geo"
for f in geosite.dat geosite.json geoip.dat; do
	[ -f "$SRC/geo/$f" ] && cp -f "$SRC/geo/$f" "$DEST_SHARE/geo/$f"
done

for svc in kixdns kixdns-panel kixdns-panel-helper; do
	cp -f "$SRC/init/$svc.init" "$DEST_ETC/init.d/$svc"
	chmod 755 "$DEST_ETC/init.d/$svc"
done

if [ ! -f "$DEST_ETC/kixdns/pipeline.json" ]; then
	cp -f "$SRC/etc/pipeline.json" "$DEST_ETC/kixdns/pipeline.json"
	say "已写入初始配置 /etc/kixdns/pipeline.json"
else
	say "保留现有 /etc/kixdns/pipeline.json（面板以数据库里的版本为准）"
fi

"$DEST_ETC/init.d/kixdns-panel-helper" enable
"$DEST_ETC/init.d/kixdns-panel" enable
"$DEST_ETC/init.d/kixdns" enable
"$DEST_ETC/init.d/kixdns-panel-helper" start
"$DEST_ETC/init.d/kixdns-panel" start

if [ "${START_DNS:-0}" = "1" ]; then
	"$DEST_ETC/init.d/kixdns" start
	say "已启动 KixDNS 内核"
else
	say "内核未启动（确认 53 端口空闲后执行 /etc/init.d/kixdns start）"
fi

say "面板地址：http://<路由器IP>:5738"
