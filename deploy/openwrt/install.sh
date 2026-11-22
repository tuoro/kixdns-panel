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

# 日期版本 YYYY.MM.DD[.N] 逐段按数比，$1 比 $2 新时返回 0；缺的第四段当 1（2026.11.22 就是当天第一版）
# Compares date versions YYYY.MM.DD[.N] part by part as numbers, returning 0 when $1 is newer than $2; a missing fourth
# part counts as 1 (2026.11.22 is the day's first release)
version_gt() {
	a=$1
	b=$2
	while [ -n "$a" ] || [ -n "$b" ]; do
		x=${a%%.*}
		y=${b%%.*}
		if [ "$a" = "$x" ]; then a=""; else a=${a#*.}; fi
		if [ "$b" = "$y" ]; then b=""; else b=${b#*.}; fi
		x=${x:-1}
		y=${y:-1}
		[ "$x" -gt "$y" ] && return 0
		[ "$x" -lt "$y" ] && return 1
	done
	return 1
}

# 正在用的内核如果是面板在线装上的，版本目录里有它的清单（binary_sha256 对得上），从中读出它的版本
# When the kernel in use was installed online by the panel, the version store holds its manifest (matching binary_sha256);
# read its version from there
installed_online_version() {
	[ -f "$DEST_BIN/kixdns" ] || return 1
	current=$(sha256sum "$DEST_BIN/kixdns" | cut -d' ' -f1)
	for manifest in "$DEST_STATE"/versions/*/manifest.json; do
		[ -f "$manifest" ] || continue
		[ "$(jsonfilter -i "$manifest" -e '@.binary_sha256' 2>/dev/null)" = "$current" ] || continue
		tag=$(jsonfilter -i "$manifest" -e '@.release_tag' 2>/dev/null) || continue
		if [ -n "$tag" ]; then
			printf '%s\n' "$tag"
			return 0
		fi
	done
	return 1
}

# 包里自带的内核（bundle/，Release 的安装包才有；手工拼的包没有就照旧总是装包里的内核）。
# 升级时，面板在线装上的内核只要不比包里的旧就留着：安装包不该把内核降级
# The bundled kernel (bundle/, in Release packages; a hand-assembled package without it always installs its kernel as
# before). On an upgrade a kernel the panel installed online stays as long as it is not older than the bundled one: a
# package must not downgrade the kernel
bundled_version=""
if [ -f "$SRC/bundle/KIXDNS_SOURCE.json" ]; then
	bundled_version=$(jsonfilter -i "$SRC/bundle/KIXDNS_SOURCE.json" -e '@.version') || die "bundle/KIXDNS_SOURCE.json 读不出版本"
fi
install_kernel=1
online_version=""
if [ -n "$bundled_version" ] && online_version=$(installed_online_version) &&
	! version_gt "$bundled_version" "$online_version"; then
	install_kernel=0
fi

# 升级时先记下内核原来是否在运行 / 是否开机自启：下面要停掉旧进程才能替换二进制，
# 装完得把原来在运行的重新拉起来，否则升级一次 DNS 就断了；提示也要按真实状态写。
# On upgrade, remember whether the kernel was running / enabled before we stop it to replace
# the binaries, so we can bring it back afterwards and report the real state.
kernel_was_running=0
kernel_was_enabled=0
if [ -x "$DEST_ETC/init.d/kixdns" ]; then
	if pidof kixdns >/dev/null 2>&1 || [ -f "$ROOT/var/run/kixdns.pid" ]; then
		kernel_was_running=1
	fi
	if "$DEST_ETC/init.d/kixdns" enabled >/dev/null 2>&1; then
		kernel_was_enabled=1
	fi
fi

# 先停旧实例，避免 "Text file busy"
for svc in kixdns-panel kixdns-panel-helper kixdns; do
	if [ -x "$DEST_ETC/init.d/$svc" ]; then
		"$DEST_ETC/init.d/$svc" stop 2>/dev/null || true
	fi
done

if [ "$install_kernel" = "1" ]; then
	cp -f "$SRC/bin/kixdns" "$DEST_BIN/kixdns"
else
	say "保留面板在线更新装上的内核 $online_version（不比安装包自带的 $bundled_version 旧）"
fi
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

# 自带内核的身份：元数据放进面板的 bundle 目录（KIXDNS_BUNDLED_METADATA），来源、提交和发布编号写进 panel.env，
# 面板据此认出自带的内核是哪一版，在线更新、回退才有依据
# The bundled kernel's identity: its metadata goes into the panel's bundle directory (KIXDNS_BUNDLED_METADATA) and its
# source, commit and release id into panel.env, so the panel knows which version the bundled kernel is, which online
# updates and rollbacks rely on
if [ -n "$bundled_version" ]; then
	commit=$(cat "$SRC/bundle/KIXDNS_BUILD_COMMIT")
	source_id=$(cat "$SRC/bundle/KIXDNS_ARTIFACT_ID")
	case "$commit" in *[!0-9a-f]* | "") die "bundle/KIXDNS_BUILD_COMMIT 无效" ;; esac
	[ "${#commit}" -eq 40 ] || die "bundle/KIXDNS_BUILD_COMMIT 无效"
	case "$source_id" in *[!0-9]* | "" | 0*) die "bundle/KIXDNS_ARTIFACT_ID 无效" ;; esac
	rm -rf "$DEST_STATE/bundle"
	mkdir -p "$DEST_STATE/bundle"
	cp -f "$SRC"/bundle/KIXDNS_* "$DEST_STATE/bundle/"
	{
		printf 'KIXDNS_INSTALLED_SOURCE=fork\n'
		printf 'KIXDNS_INSTALLED_COMMIT=%s\n' "$commit"
		printf 'KIXDNS_INSTALLED_SOURCE_ID=%s\n' "$source_id"
	} >"$DEST_STATE/panel.env.new"
	chmod 600 "$DEST_STATE/panel.env.new"
	mv -f "$DEST_STATE/panel.env.new" "$DEST_STATE/panel.env"
fi

if [ ! -f "$DEST_ETC/kixdns/pipeline.json" ]; then
	cp -f "$SRC/etc/pipeline.json" "$DEST_ETC/kixdns/pipeline.json"
	say "已写入初始配置 /etc/kixdns/pipeline.json"
else
	say "保留现有 /etc/kixdns/pipeline.json（面板以数据库里的版本为准）"
fi

"$DEST_ETC/init.d/kixdns-panel-helper" enable
"$DEST_ETC/init.d/kixdns-panel" enable
"$DEST_ETC/init.d/kixdns-panel-helper" start
"$DEST_ETC/init.d/kixdns-panel" start

if [ "${START_DNS:-0}" = "1" ]; then
	# 只有显式要求启动内核时才 enable：否则开机自启一个不用的内核会一直占着 53。
	# Only enable the kernel when asked to start it; otherwise a self-starting but unused
	# kernel would keep hogging port 53 after every reboot.
	"$DEST_ETC/init.d/kixdns" enable
	"$DEST_ETC/init.d/kixdns" start
	say "已启动 KixDNS 内核（已设为开机自启）"
elif [ "$kernel_was_running" = "1" ]; then
	# 升级前内核在运行：装完原样拉起来，别让一次升级把 DNS 断掉。
	# The kernel was running before the upgrade: bring it back so the upgrade does not break DNS.
	"$DEST_ETC/init.d/kixdns" start
	say "内核升级前在运行，已重新启动"
else
	if [ "$kernel_was_enabled" = "1" ]; then
		say "内核未启动（升级前也未在运行），仍保持开机自启；需要时执行 /etc/init.d/kixdns start"
	else
		say "内核未启动，也未设为开机自启（确认 53 端口空闲后执行 /etc/init.d/kixdns enable && /etc/init.d/kixdns start）"
	fi
	say "注意：OpenWrt 默认的 dnsmasq 占着 53 端口，启用内核前要先停掉或在面板里把 dnsmasq 挪到别的端口"
fi

say "面板地址：http://<路由器IP>:5738"
