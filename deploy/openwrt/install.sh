#!/bin/sh
# KixDNS 面板 —— OpenWrt 安装脚本（不依赖 opkg / ipk，直接铺文件）
#
# 用法（在解压后的 payload 根目录执行）：
#   sh install.sh                       # 安装或升级面板（新装时内核先不启动）
#   START_DNS=1 sh install.sh           # 装完连内核一起启动（会占 53，先确认没有别的 DNS）
#   sh install.sh --panel-only-update   # 只更新面板，不动内核；面板的在线更新就是这样跑的
#
# 升级是整体的：换文件以前先把要换的程序、页面、init 脚本、身份文件和数据库备份到 /tmp，装完等新面板稳定运行、
# 健康检查答出新版本；哪一步没成就全部放回，原来的面板照原样起来。
# Upgrades are all or nothing: before any file is replaced, the programs, pages, init scripts, identity files and the
# database it replaces are backed up to /tmp; once installed, the new panel must keep running and answer the health check
# with the new version. If any step fails everything is put back and the old panel comes back as it was.
set -e

ROOT=${ROOT:-/}
SRC=$(cd "$(dirname "$0")" && pwd)

DEST_BIN="$ROOT/usr/bin"
DEST_LIBEXEC="$ROOT/usr/libexec"
DEST_SHARE="$ROOT/usr/share/kixdns-panel"
DEST_ETC="$ROOT/etc"
DEST_STATE="$ROOT/etc/kixdns-panel"
LOCK_FILE="$ROOT/var/lock/kixdns-panel-install.lock"
# 新面板起来、答出健康检查最多等这么久（秒）；路由器上第一次启动要读内置 GeoSite，慢一些
# How long (seconds) the new panel may take to come up and answer the health check; the first start on a router reads
# the built-in GeoSite and is slower
PANEL_WAIT_SECONDS=90
SERVICES="kixdns kixdns-panel kixdns-panel-helper kixdns-panel-update"

say() { printf '%s\n' "$*"; }
die() {
	printf '错误：%s\n' "$*" >&2
	exit 1
}

PANEL_ONLY=0
for argument in "$@"; do
	case $argument in
	--panel-only-update) PANEL_ONLY=1 ;;
	-h | --help)
		sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) die "不认识的参数：$argument（--help 看用法）" ;;
	esac
done

[ -x "$SRC/bin/kixdns" ] || die "缺少 bin/kixdns"
[ -x "$SRC/bin/kixdns-panel-server" ] || die "缺少 bin/kixdns-panel-server"
[ -x "$SRC/libexec/kixdns-panel-helper" ] || die "缺少 libexec/kixdns-panel-helper"
[ -f "$SRC/libexec/kixdns-panel-update" ] || die "缺少 libexec/kixdns-panel-update"
[ -d "$SRC/web" ] || die "缺少 web/（前端构建产物）"
for svc in $SERVICES; do
	[ -f "$SRC/init/$svc.init" ] || die "缺少 init/$svc.init"
done
if [ "$PANEL_ONLY" = 1 ] && [ ! -x "$DEST_BIN/kixdns-panel-server" ]; then
	die "--panel-only-update 只用于已经装好面板的路由器；新装直接运行 sh install.sh"
fi

# 同一时间只有一个安装（或在线更新里的安装）在改文件 / One install at a time (the online update's included) changes files
# 极简固件里没有 flock 就不加锁 / A minimal image without flock goes without the lock
if command -v flock >/dev/null 2>&1; then
	mkdir -p "${LOCK_FILE%/*}"
	exec 8>>"$LOCK_FILE"
	flock -n 8 || die "另一个安装或面板在线更新正在运行，等它结束再试"
fi

# 新面板程序先在这台设备上跑一次：架构不对、程序坏了，在动任何文件以前就停下
# Run the new panel program once on this device first: a wrong architecture or a broken program stops the install before
# any file is touched
new_version=$("$SRC/bin/kixdns-panel-server" --version 2>/dev/null | awk 'NF >= 2 { print $NF; exit }') || new_version=""
[ -n "$new_version" ] || die "安装包里的面板程序在这台设备上跑不起来（架构不对？）"

# 面板自己的身份：正式版的包带 PANEL_RELEASE（vX.Y.Z，必须和程序版本一致），CI 构建只带 PANEL_BUILD_COMMIT
# The panel's own identity: a release package carries PANEL_RELEASE (vX.Y.Z, which must match the program's version), a CI
# build only PANEL_BUILD_COMMIT
panel_commit=""
panel_release=""
if [ -f "$SRC/PANEL_BUILD_COMMIT" ]; then
	panel_commit=$(cat "$SRC/PANEL_BUILD_COMMIT")
	case "$panel_commit" in *[!0-9a-f]* | "") die "PANEL_BUILD_COMMIT 无效" ;; esac
	[ "${#panel_commit}" -eq 40 ] || die "PANEL_BUILD_COMMIT 无效"
fi
if [ -f "$SRC/PANEL_RELEASE" ]; then
	panel_release=$(cat "$SRC/PANEL_RELEASE")
	[ "$panel_release" = "v$new_version" ] || die "PANEL_RELEASE（$panel_release）与面板程序版本 $new_version 不一致"
fi

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
# 升级时，面板在线装上的内核只要不比包里的旧就留着：安装包不该把内核降级。只更新面板时内核和它的身份都不动，
# 和 systemd 版的 --panel-only-update 一样：内核在面板里单独更新
# The bundled kernel (bundle/, in Release packages; a hand-assembled package without it always installs its kernel as
# before). On an upgrade a kernel the panel installed online stays as long as it is not older than the bundled one: a
# package must not downgrade the kernel. A panel-only update leaves the kernel and its identity alone, as the systemd
# --panel-only-update does: the kernel is updated in the panel on its own
bundled_version=""
if [ -f "$SRC/bundle/KIXDNS_SOURCE.json" ]; then
	bundled_version=$(jsonfilter -i "$SRC/bundle/KIXDNS_SOURCE.json" -e '@.version') || die "bundle/KIXDNS_SOURCE.json 读不出版本"
fi
install_kernel=1
online_version=""
if [ "$PANEL_ONLY" = 1 ]; then
	install_kernel=0
elif [ -n "$bundled_version" ] && online_version=$(installed_online_version) &&
	! version_gt "$bundled_version" "$online_version"; then
	install_kernel=0
fi
write_identity=0
if [ "$PANEL_ONLY" = 0 ] && [ -n "$bundled_version" ]; then
	write_identity=1
	kernel_commit=$(cat "$SRC/bundle/KIXDNS_BUILD_COMMIT")
	kernel_source_id=$(cat "$SRC/bundle/KIXDNS_ARTIFACT_ID")
	case "$kernel_commit" in *[!0-9a-f]* | "") die "bundle/KIXDNS_BUILD_COMMIT 无效" ;; esac
	[ "${#kernel_commit}" -eq 40 ] || die "bundle/KIXDNS_BUILD_COMMIT 无效"
	case "$kernel_source_id" in *[!0-9]* | "" | 0*) die "bundle/KIXDNS_ARTIFACT_ID 无效" ;; esac
fi

# 剩余空间（KiB）和占用（KiB，不存在的算 0）/ Free space (KiB) and usage (KiB, 0 for what does not exist)
free_kib() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }
used_kib() {
	total=0
	for path in "$@"; do
		[ -e "$path" ] || continue
		size=$(du -sk "$path" | cut -f1)
		total=$((total + size))
	done
	printf '%s\n' "$total"
}

# 要换掉的东西：备份到 /tmp，装不成就放回。键是备份里的名字 / What gets replaced: backed up to /tmp and put back when the
# install fails. The key is its name in the backup
backup_items() {
	[ "$install_kernel" = 0 ] || printf '%s\n' "kixdns $DEST_BIN/kixdns"
	printf '%s\n' \
		"panel-server $DEST_BIN/kixdns-panel-server" \
		"panel-helper $DEST_LIBEXEC/kixdns-panel-helper" \
		"panel-update $DEST_LIBEXEC/kixdns-panel-update" \
		"web $DEST_SHARE/web" \
		"geo $DEST_SHARE/geo" \
		"bundle $DEST_STATE/bundle" \
		"panel-env $DEST_STATE/panel.env" \
		"panel-db $DEST_STATE/panel.db" \
		"panel-db-wal $DEST_STATE/panel.db-wal" \
		"panel-db-shm $DEST_STATE/panel.db-shm" \
		"pipeline $DEST_ETC/kixdns/pipeline.json"
	for svc in $SERVICES; do
		printf '%s\n' "init-$svc $DEST_ETC/init.d/$svc"
	done
}

# 放得下备份吗（/tmp），闪存放得下新文件吗：新的比旧的多出来的部分再留 1 MiB
# Does the backup fit (/tmp), and do the new files fit on flash: what the new ones add over the old, plus 1 MiB
# shellcheck disable=SC2046 # 路径里没有空格，按词拆开就是要的 / The paths hold no spaces; word splitting is intended
check_space() {
	backup_kib=$(used_kib $(backup_items | cut -d' ' -f2))
	tmp_free=$(free_kib /tmp)
	[ "$tmp_free" -ge $((backup_kib + 4096)) ] ||
		die "/tmp 剩余 $((tmp_free / 1024)) MiB，备份现有面板要 $(((backup_kib + 4096) / 1024)) MiB；先腾出内存再试"
	new_kib=$(used_kib "$SRC/bin/kixdns-panel-server" "$SRC/libexec" "$SRC/web" "$SRC/geo")
	old_kib=$(used_kib "$DEST_BIN/kixdns-panel-server" "$DEST_LIBEXEC/kixdns-panel-helper" \
		"$DEST_LIBEXEC/kixdns-panel-update" "$DEST_SHARE/web" "$DEST_SHARE/geo")
	if [ "$install_kernel" = 1 ]; then
		new_kib=$((new_kib + $(used_kib "$SRC/bin/kixdns")))
		old_kib=$((old_kib + $(used_kib "$DEST_BIN/kixdns")))
	fi
	grow_kib=$((new_kib - old_kib))
	[ "$grow_kib" -gt 0 ] || grow_kib=0
	mkdir -p "$DEST_BIN"
	flash_free=$(free_kib "$DEST_BIN")
	[ "$flash_free" -ge $((grow_kib + 1024)) ] ||
		die "闪存剩余 $((flash_free / 1024)) MiB，装新版要 $(((grow_kib + 1024) / 1024)) MiB；先腾出空间再试"
}

service_pid() {
	command -v ubus >/dev/null 2>&1 || return 0
	ubus call service list "{\"name\":\"$1\"}" 2>/dev/null |
		jsonfilter -e "@[\"$1\"].instances.*.pid" 2>/dev/null | head -n 1
}

# procd 的 stop 不等进程退出就返回；等它真的退出再换程序，免得 Text file busy
# procd's stop returns before the process exits; wait until it really has before replacing programs, so there is no
# Text file busy
# 参数：服务名、程序名 / Arguments: the service name and the program name
stop_service() {
	[ -x "$DEST_ETC/init.d/$1" ] || return 0
	"$DEST_ETC/init.d/$1" stop 2>/dev/null || true
	waited=0
	while { [ -n "$(service_pid "$1")" ] || pidof "$2" >/dev/null 2>&1; } && [ "$waited" -lt 10 ]; do
		sleep 1
		waited=$((waited + 1))
	done
}

# 先写到旁边再改名：正在跑的脚本（在线更新器自己）不会读到写了一半的文件，cp 也不带包里的属主过来
# Write next to the target, then rename: a running script (the online updater itself) never reads a half-written file,
# and cp does not carry the package's owner over
install_file() {
	cp -f "$1" "$2.new"
	chmod "$3" "$2.new"
	mv -f "$2.new" "$2"
}

backup_all() {
	backup_items | while read -r key path; do
		if [ -e "$path" ] || [ -L "$path" ]; then
			cp -a "$path" "$BACKUP/$key"
		else
			: >"$BACKUP/$key.missing"
		fi
	done
}

restore_all() {
	backup_items | while read -r key path; do
		if [ -e "$BACKUP/$key" ] || [ -L "$BACKUP/$key" ]; then
			rm -rf "$path"
			mkdir -p "${path%/*}"
			cp -a "$BACKUP/$key" "$path"
		elif [ -e "$BACKUP/$key.missing" ]; then
			rm -rf "$path"
		fi
	done
}

# 面板健康检查要连的地址：从正在跑的面板进程的环境里读监听地址 / Where the health check connects: the listen address
# read from the running panel process's environment
health_url() {
	bind=$(tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | sed -n 's/^KIXDNS_PANEL_BIND=//p' | head -n 1)
	[ -n "$bind" ] || bind=127.0.0.1:5738
	host=${bind%:*}
	case $host in
	0.0.0.0 | "") host=127.0.0.1 ;;
	"[::]") host="[::1]" ;;
	esac
	printf 'http://%s:%s/api/v1/health\n' "$host" "${bind##*:}"
}

# 新面板稳定运行（procd 里的 pid 连续 3 秒不变）并且健康检查答出期望的版本；没有 ubus（不是 OpenWrt）就不查
# The new panel keeps running (the same pid in procd for 3 seconds in a row) and the health check answers with the
# expected version; without ubus (not OpenWrt) there is nothing to check
wait_panel_healthy() {
	command -v ubus >/dev/null 2>&1 || return 0
	expected=$1
	tick=0
	last=""
	stable=0
	while [ "$tick" -lt "$PANEL_WAIT_SECONDS" ]; do
		pid=$(service_pid kixdns-panel)
		if [ -n "$pid" ] && [ "$pid" = "$last" ]; then
			stable=$((stable + 1))
		else
			stable=0
			last=$pid
		fi
		if [ "$stable" -ge 3 ]; then
			answer=$(uclient-fetch -q -T 3 -O - "$(health_url "$pid")" 2>/dev/null) || answer=""
			if [ -n "$answer" ] &&
				[ "$(printf '%s' "$answer" | jsonfilter -e '@.version' 2>/dev/null)" = "$expected" ]; then
				return 0
			fi
		fi
		sleep 1
		tick=$((tick + 1))
	done
	return 1
}

# 装到一半失败：停掉新起来的，全部放回，原来的服务按原样起来
# A failure halfway: stop what came up new, put everything back, and bring the original services back as they were
rollback() {
	set +e
	printf '%s\n' "安装没有完成，正在放回原来的面板…" >&2
	stop_service kixdns-panel kixdns-panel-server
	stop_service kixdns-panel-helper kixdns-panel-helper
	[ "$install_kernel" = 0 ] || stop_service kixdns kixdns
	restore_all
	for svc in kixdns-panel kixdns-panel-helper; do
		if [ -x "$DEST_ETC/init.d/$svc" ]; then
			if [ -f "$BACKUP/enabled-$svc" ]; then
				"$DEST_ETC/init.d/$svc" enable
			else
				"$DEST_ETC/init.d/$svc" disable
			fi
		else
			rm -f "$DEST_ETC"/rc.d/[SK][0-9][0-9]"$svc"
		fi
	done
	if [ "$panel_existed" = 1 ]; then
		"$DEST_ETC/init.d/kixdns-panel-helper" start
		"$DEST_ETC/init.d/kixdns-panel" start
	fi
	if [ "$kernel_was_running" = 1 ] && [ -x "$DEST_ETC/init.d/kixdns" ]; then
		# 没停过的内核只在 init 脚本变了时才会被 procd 重启 / A kernel never stopped is restarted by procd only when its
		# init script changed
		"$DEST_ETC/init.d/kixdns" start
	fi
	if [ "$panel_existed" = 0 ]; then
		printf '%s\n' "已撤掉这次装上的文件。" >&2
	elif wait_panel_healthy "$old_version"; then
		printf '%s\n' "已恢复原来的面板 $old_version。" >&2
	else
		printf '%s\n' "已放回原来的程序和数据库，但原来的面板没有恢复运行；查看原因：logread -e kixdns-panel" >&2
	fi
}

BACKUP=""
CHANGING=0
finish() {
	status=$1
	trap - EXIT INT TERM HUP
	if [ "$status" != 0 ] && [ "$CHANGING" = 1 ]; then
		rollback
	fi
	case $BACKUP in
	/tmp/kixdns-panel-install.*) rm -rf "$BACKUP" ;;
	esac
	exit "$status"
}
trap 'finish $?' EXIT
trap 'exit 130' INT TERM HUP

check_space

# 升级时先记下各服务原来的状态：下面要停掉旧进程才能替换程序，装完按原状态拉起来，否则升级一次 DNS 就断了；
# 装不成时也按这个放回去
# On upgrade, note each service's state first: the old processes are stopped below to replace the programs and brought
# back as they were afterwards, or an upgrade would cut DNS; a failed install restores this state too
panel_existed=0
old_version=""
if [ -x "$DEST_BIN/kixdns-panel-server" ]; then
	panel_existed=1
	old_version=$("$DEST_BIN/kixdns-panel-server" --version 2>/dev/null | awk 'NF >= 2 { print $NF; exit }') || old_version=""
fi
kernel_was_running=0
kernel_was_enabled=0
if [ -x "$DEST_ETC/init.d/kixdns" ]; then
	if [ -n "$(service_pid kixdns)" ] || pidof kixdns >/dev/null 2>&1; then
		kernel_was_running=1
	fi
	if "$DEST_ETC/init.d/kixdns" enabled >/dev/null 2>&1; then
		kernel_was_enabled=1
	fi
fi

BACKUP=$(mktemp -d /tmp/kixdns-panel-install.XXXXXX)
for svc in kixdns-panel kixdns-panel-helper; do
	if [ -x "$DEST_ETC/init.d/$svc" ] && "$DEST_ETC/init.d/$svc" enabled >/dev/null 2>&1; then
		: >"$BACKUP/enabled-$svc"
	fi
done

# 面板停了数据库才不再变，这时备份的才是完整的一份；内核只在要换它的程序时才停
# The database stops changing once the panel stops, so the backup taken then is whole; the kernel is stopped only when
# its program is replaced
CHANGING=1
stop_service kixdns-panel kixdns-panel-server
stop_service kixdns-panel-helper kixdns-panel-helper
[ "$install_kernel" = 0 ] || stop_service kixdns kixdns
backup_all

mkdir -p "$DEST_BIN" "$DEST_LIBEXEC" "$DEST_SHARE" "$DEST_STATE/geo" "$ROOT/etc/kixdns" "$ROOT/var/log" "$ROOT/run/kixdns-panel" \
	"$DEST_ETC/init.d"

if [ "$install_kernel" = "1" ]; then
	install_file "$SRC/bin/kixdns" "$DEST_BIN/kixdns" 755
elif [ "$PANEL_ONLY" = 0 ]; then
	say "保留面板在线更新装上的内核 $online_version（不比安装包自带的 $bundled_version 旧）"
fi
install_file "$SRC/bin/kixdns-panel-server" "$DEST_BIN/kixdns-panel-server" 755
install_file "$SRC/libexec/kixdns-panel-helper" "$DEST_LIBEXEC/kixdns-panel-helper" 755
install_file "$SRC/libexec/kixdns-panel-update" "$DEST_LIBEXEC/kixdns-panel-update" 755

# 不用 cp -a：包里文件的属主是打包机器上的账号，装到路由器上要归 root
# Not cp -a: the package's files belong to an account on the packaging machine, and on the router they belong to root
rm -rf "$DEST_SHARE/web"
cp -R "$SRC/web" "$DEST_SHARE/web"

mkdir -p "$DEST_SHARE/geo"
for f in geosite.dat geosite.json geoip.dat; do
	[ ! -f "$SRC/geo/$f" ] || install_file "$SRC/geo/$f" "$DEST_SHARE/geo/$f" 644
done

for svc in $SERVICES; do
	install_file "$SRC/init/$svc.init" "$DEST_ETC/init.d/$svc" 755
done

# 自带内核的身份：元数据放进面板的 bundle 目录（KIXDNS_BUNDLED_METADATA），来源、提交和发布编号写进 panel.env，
# 面板据此认出自带的内核是哪一版，在线更新、回退才有依据。只更新面板时沿用原来的
# The bundled kernel's identity: its metadata goes into the panel's bundle directory (KIXDNS_BUNDLED_METADATA) and its
# source, commit and release id into panel.env, so the panel knows which version the bundled kernel is, which online
# updates and rollbacks rely on. A panel-only update keeps the existing one
if [ "$write_identity" = 1 ]; then
	rm -rf "$DEST_STATE/bundle"
	mkdir -p "$DEST_STATE/bundle"
	for f in "$SRC"/bundle/KIXDNS_*; do
		install_file "$f" "$DEST_STATE/bundle/${f##*/}" 644
	done
fi
{
	if [ "$write_identity" = 1 ]; then
		printf 'KIXDNS_INSTALLED_SOURCE=fork\n'
		printf 'KIXDNS_INSTALLED_COMMIT=%s\n' "$kernel_commit"
		printf 'KIXDNS_INSTALLED_SOURCE_ID=%s\n' "$kernel_source_id"
	elif [ -f "$BACKUP/panel-env" ]; then
		grep -E '^KIXDNS_INSTALLED_(SOURCE|COMMIT|SOURCE_ID)=' "$BACKUP/panel-env" || true
	fi
	# 面板启动时核对 KIXDNS_PANEL_INSTALLED_RELEASE 和程序版本，不一致就不启动：两者总是一起换
	# The panel checks KIXDNS_PANEL_INSTALLED_RELEASE against its program version at start-up and refuses to start when
	# they differ: the two are always replaced together
	[ -z "$panel_commit" ] || printf 'KIXDNS_PANEL_INSTALLED_COMMIT=%s\n' "$panel_commit"
	[ -z "$panel_release" ] || printf 'KIXDNS_PANEL_INSTALLED_RELEASE=%s\n' "$panel_release"
} >"$DEST_STATE/panel.env.new"
chmod 600 "$DEST_STATE/panel.env.new"
mv -f "$DEST_STATE/panel.env.new" "$DEST_STATE/panel.env"

if [ ! -f "$DEST_ETC/kixdns/pipeline.json" ]; then
	install_file "$SRC/etc/pipeline.json" "$DEST_ETC/kixdns/pipeline.json" 644
	say "已写入初始配置 /etc/kixdns/pipeline.json"
else
	say "保留现有 /etc/kixdns/pipeline.json（面板以数据库里的版本为准）"
fi

"$DEST_ETC/init.d/kixdns-panel-helper" enable
"$DEST_ETC/init.d/kixdns-panel" enable
"$DEST_ETC/init.d/kixdns-panel-helper" start
"$DEST_ETC/init.d/kixdns-panel" start

if [ "${START_DNS:-0}" = "1" ] && [ "$PANEL_ONLY" = 0 ]; then
	# 只有显式要求启动内核时才 enable：否则开机自启一个不用的内核会一直占着 53。
	# Only enable the kernel when asked to start it; otherwise a self-starting but unused
	# kernel would keep hogging port 53 after every reboot.
	"$DEST_ETC/init.d/kixdns" enable
	"$DEST_ETC/init.d/kixdns" start
	kernel_message="已启动 KixDNS 内核（已设为开机自启）"
elif [ "$kernel_was_running" = "1" ]; then
	# 升级前内核在运行：换了程序的话装完原样拉起来，别让一次升级把 DNS 断掉；没换程序的内核没停过，start 只在 init 脚本
	# 变了时才让 procd 重启它
	# The kernel was running before the upgrade: when its program was replaced, bring it back so the upgrade does not
	# break DNS; a kernel whose program stayed was never stopped, and start has procd restart it only when its init
	# script changed
	"$DEST_ETC/init.d/kixdns" start
	if [ "$install_kernel" = 1 ]; then
		kernel_message="内核升级前在运行，已重新启动"
	else
		kernel_message="内核照常运行"
	fi
elif [ "$kernel_was_enabled" = "1" ]; then
	kernel_message="内核未启动（升级前也未在运行），仍保持开机自启；需要时执行 /etc/init.d/kixdns start"
else
	kernel_message="内核未启动，也未设为开机自启（确认 53 端口空闲后执行 /etc/init.d/kixdns enable && /etc/init.d/kixdns start）
注意：OpenWrt 默认的 dnsmasq 占着 53 端口，启用内核前要先停掉或在面板里把 dnsmasq 挪到别的端口"
fi

wait_panel_healthy "$new_version" ||
	die "新面板 $new_version 启动后没有正常运行（${PANEL_WAIT_SECONDS} 秒内没有稳定运行并答出健康检查）；查看原因：logread -e kixdns-panel"
CHANGING=0

say "$kernel_message"
if [ -n "$panel_release" ]; then
	say "面板 $panel_release 已就绪：http://<路由器IP>:5738"
else
	say "面板 $new_version 已就绪：http://<路由器IP>:5738"
fi
