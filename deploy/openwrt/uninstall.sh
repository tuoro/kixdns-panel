#!/bin/sh
# shellcheck shell=sh
# KixDNS 面板 —— OpenWrt 卸载脚本（install.sh 装到 /usr/libexec/kixdns-panel-uninstall）
#
# 用法：
#   sh /usr/libexec/kixdns-panel-uninstall               # 卸掉面板和内核；配置、数据库、内核版本库留着，重装就回来
#   sh /usr/libexec/kixdns-panel-uninstall --purge       # 连配置和数据一起删，找不回来
#   sh /usr/libexec/kixdns-panel-uninstall --keep-kernel # 只卸面板，内核照常运行（它的配置和 53 端口都不动）
#
# 卸内核前先停用它：接管过的 53 端口原样还给 dnsmasq（见 /etc/init.d/kixdns 的 disable），局域网不会没有 DNS。
# Removing the kernel disables it first: a port 53 it took over goes back to dnsmasq as it was (see disable in
# /etc/init.d/kixdns), so the LAN never goes without DNS.
set -e

ROOT=${ROOT:-/}
ROOT=${ROOT%/}
LOCK_FILE="$ROOT/var/lock/kixdns-panel-install.lock"

say() { printf '%s\n' "$*"; }
die() {
	printf '错误：%s\n' "$*" >&2
	exit 1
}

PURGE=0
KEEP_KERNEL=0
for argument in "$@"; do
	case $argument in
	--purge) PURGE=1 ;;
	--keep-kernel) KEEP_KERNEL=1 ;;
	-h | --help)
		sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) die "不认识的参数：$argument（--help 看用法）" ;;
	esac
done

[ "$(id -u)" = 0 ] || [ "$ROOT" != "" ] || die "要以 root 运行"

# 和安装、在线更新用同一把锁：它们正在改文件时不卸 / The same lock as installs and online updates: nothing is removed while they
# change files
if command -v flock >/dev/null 2>&1; then
	mkdir -p "${LOCK_FILE%/*}"
	exec 8>>"$LOCK_FILE"
	flock -n 8 || die "安装或面板在线更新正在运行，等它结束再卸载"
fi

# 查询日志放在哪：删配置以前先读出来 / Where the query log lives: read before the config goes
querylog_dir=$(uci -q get kixdns-panel.main.querylog_dir 2>/dev/null) || querylog_dir=""

stop_and_disable() {
	init="$ROOT/etc/init.d/$1"
	[ -x "$init" ] || return 0
	"$init" stop >/dev/null 2>&1 || true
	"$init" disable >/dev/null 2>&1 || true
}

# 先停面板这边：在线更新、面板、服务助手 / The panel's side first: the online update, the panel, the service helper
for svc in kixdns-panel-update kixdns-panel kixdns-panel-helper; do
	stop_and_disable "$svc"
done
if [ "$KEEP_KERNEL" = 0 ]; then
	# disable 先停内核，再把接管过的 53 还给 dnsmasq / disable stops the kernel, then gives a taken-over port 53 back to dnsmasq
	if [ -x "$ROOT/etc/init.d/kixdns" ]; then
		"$ROOT/etc/init.d/kixdns" disable || true
		"$ROOT/etc/init.d/kixdns" stop >/dev/null 2>&1 || true
	fi
fi

# 程序换掉以前等进程真的退出（按 /proc/<pid>/exe 认，不用 pidof） / Wait for the processes to really exit before removing
# programs (recognised through /proc/<pid>/exe, not pidof)
running() {
	for process in /proc/[0-9]*; do
		for program in "$@"; do
			case "$(readlink "$process/exe" 2>/dev/null)" in
			"$program" | "$program (deleted)") return 0 ;;
			esac
		done
	done
	return 1
}
programs="$ROOT/usr/bin/kixdns-panel-server $ROOT/usr/libexec/kixdns-panel-helper"
[ "$KEEP_KERNEL" = 1 ] || programs="$programs $ROOT/usr/bin/kixdns"
waited=0
# shellcheck disable=SC2086 # 路径里没有空格，按词拆开就是要的 / The paths hold no spaces; word splitting is intended
while running $programs && [ "$waited" -lt 10 ]; do
	sleep 1
	waited=$((waited + 1))
done

rm -f "$ROOT/usr/bin/kixdns-panel-server" \
	"$ROOT/usr/libexec/kixdns-panel-helper" \
	"$ROOT/usr/libexec/kixdns-panel-update" \
	"$ROOT/etc/init.d/kixdns-panel" \
	"$ROOT/etc/init.d/kixdns-panel-helper" \
	"$ROOT/etc/init.d/kixdns-panel-update"
rm -rf "$ROOT/usr/share/kixdns-panel" "$ROOT/run/kixdns-panel" "$ROOT/var/lib/kixdns-panel-update" \
	"$ROOT/tmp/kixdns-panel"
if [ "$KEEP_KERNEL" = 0 ]; then
	rm -f "$ROOT/usr/bin/kixdns" "$ROOT/etc/init.d/kixdns"
	rm -rf "$ROOT/run/kixdns"
fi

if [ "$PURGE" = 1 ]; then
	rm -rf "$ROOT/etc/kixdns-panel"
	# UCI 指到别处（U 盘）的查询日志也删：目录名是用户自己定的，只删它本身 / A query log the UCI option placed elsewhere (a USB
	# drive) goes too: the directory was named by the user, and only it is removed
	case $querylog_dir in
	/?*) rm -rf "$ROOT$querylog_dir" ;;
	esac
	if [ "$KEEP_KERNEL" = 1 ]; then
		# 内核还在：接管 53 的记录得留着，以后停用内核时才还得回去 / The kernel stays: the port 53 handover record must stay, so
		# disabling the kernel later can still give it back
		uci -q delete kixdns-panel.main 2>/dev/null || true
		uci -q commit kixdns-panel 2>/dev/null || true
	else
		rm -f "$ROOT/etc/config/kixdns-panel"
		rm -rf "$ROOT/etc/kixdns"
		rm -f "$ROOT/var/log/kixdns.log" "$ROOT/var/log/kixdns.log.1"
	fi
fi

# 卸载器自己最后删：正在跑的脚本已经读进来了 / The uninstaller removes itself last: the running script is already read in
rm -f "$ROOT/usr/libexec/kixdns-panel-uninstall"

if [ "$KEEP_KERNEL" = 1 ]; then
	say "已卸载 KixDNS 面板；内核照常运行（/etc/init.d/kixdns 管它，配置在 /etc/kixdns/pipeline.json）"
else
	say "已卸载 KixDNS 面板和内核"
	if [ "$(uci -q get 'dhcp.@dnsmasq[0].port' 2>/dev/null)" = 5353 ]; then
		say "注意：dnsmasq 的 DNS 还在 5353 上（不是这里挪的，没有动）；要它回到 53：uci delete dhcp.@dnsmasq[0].port; uci commit dhcp; /etc/init.d/dnsmasq restart"
	fi
fi
if [ "$PURGE" = 1 ]; then
	say "配置、数据库、内核版本库和查询日志都已删除"
else
	say "配置、数据库和内核版本库留在 /etc/kixdns-panel 和 /etc/kixdns，重装就回来；不要了就删掉：rm -rf /etc/kixdns-panel /etc/kixdns /etc/config/kixdns-panel"
fi
