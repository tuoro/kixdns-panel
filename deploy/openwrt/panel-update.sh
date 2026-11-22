#!/bin/sh
# shellcheck shell=sh
# KixDNS 面板 —— OpenWrt 上的面板在线更新器（装到 /usr/libexec/kixdns-panel-update）。
# 面板点「在线更新」后，服务助手让 procd 起 /etc/init.d/kixdns-panel-update 这个一次性服务来跑它：它在自己的 procd 实例里，
# 安装器停掉面板和服务助手时它不会跟着被停。它读 tuoro/kixdns-panel 的最新正式 Release，下载本架构的 OpenWrt 安装包，
# 按 GitHub 公布的 SHA-256 和包里的 SHA256SUMS 校验，再用 install.sh --panel-only-update 只更新面板（内核不动）。
# 进度和结果写进状态文件，系统页据此显示；完整输出在 logread -e kixdns-panel-update。
#
# KixDNS panel: the online updater on OpenWrt (installed as /usr/libexec/kixdns-panel-update). When the panel's online
# update is pressed, the service helper has procd start the one-shot service /etc/init.d/kixdns-panel-update, which runs
# this: it lives in its own procd instance, so the installer stopping the panel and the helper does not stop it. It reads
# the newest stable release of tuoro/kixdns-panel, downloads this architecture's OpenWrt package, checks it against the
# SHA-256 GitHub publishes and the package's SHA256SUMS, then updates only the panel (not the kernel) with
# install.sh --panel-only-update. Progress and the outcome go into the status file the system page shows; the full output
# is in logread -e kixdns-panel-update.
set -u

REPOSITORY="tuoro/kixdns-panel"
RELEASE_API="https://api.github.com/repos/${REPOSITORY}/releases/latest"
DOWNLOAD_PREFIX="https://github.com/${REPOSITORY}/releases/download"
# 面板读的状态文件（panel_update.rs 的 STATUS_FILE）：root 所有、组和其他用户不可写，否则面板不认
# The status file the panel reads (STATUS_FILE in panel_update.rs): root's and not writable by group or others, or the
# panel ignores it
STATUS_DIRECTORY="/var/lib/kixdns-panel-update"
STATUS_FILE="${STATUS_DIRECTORY}/status.json"
LOCK_FILE="/var/lock/kixdns-panel-update.lock"
PANEL_ENV="/etc/kixdns-panel/panel.env"
PANEL_SERVER="/usr/bin/kixdns-panel-server"
# 下载和解包放在 /tmp（内存）：路由器的闪存小，也不该为一次更新多写一遍
# Downloads and the unpacked package go to /tmp (memory): router flash is small and should not take an extra write per
# update
WORK_PARENT="/tmp"
# 面板只接受 300 字以内的消息；从安装器输出里取的原因按字节限长，多字节字符也不会超
# The panel accepts messages up to 300 characters; a reason taken from the installer's output is bounded in bytes, so
# multibyte characters cannot exceed it either
MAX_REASON_BYTES=240

TARGET_VERSION=""
WORK=""

cleanup() {
	case ${WORK} in
	"${WORK_PARENT}"/kixdns-panel-update.*) rm -rf -- "${WORK}" ;;
	esac
}

write_status() {
	state=$1
	message=$2
	[ -d "${STATUS_DIRECTORY}" ] || mkdir -p "${STATUS_DIRECTORY}" || return 1
	[ -d "${STATUS_DIRECTORY}" ] && [ ! -L "${STATUS_DIRECTORY}" ] || return 1
	chmod 0755 "${STATUS_DIRECTORY}" || return 1
	temporary="${STATUS_DIRECTORY}/.status.$$"
	# jshn 负责 JSON 转义；它用到没设过的变量，在 set -u 下跑不了 / jshn takes care of JSON escaping; it reads variables
	# never set, so it cannot run under set -u
	(
		set +u
		# shellcheck source=/dev/null
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_string state "${state}"
		json_add_string message "${message}"
		json_add_string target_version "${TARGET_VERSION}"
		json_add_int updated_at "$(date +%s)"
		json_dump
	) >"${temporary}" || {
		rm -f -- "${temporary}"
		return 1
	}
	chmod 0644 "${temporary}" && mv -f -- "${temporary}" "${STATUS_FILE}"
}

# 记下失败并退出；原因同时进 logd / Record the failure and exit; the reason also goes to logd
fail() {
	trap - INT TERM HUP
	printf '%s\n' "$1" >&2
	write_status failed "在线更新失败：$1" || true
	exit 1
}

# 从安装器的 stderr 里挑原因：带「错误：」或「失败」的最后一行，没有就用最后一个非空行；去掉控制字符和「错误：」前缀，
# 太长就不用（交给日志）
# Pick the reason out of the installer's stderr: the last line carrying 错误： or 失败, else the last non-empty line;
# control characters and the 错误： prefix are dropped, and a line too long is not used (the log has it)
failure_reason() {
	reason=$(tr -d '\000-\010\013-\037\177' <"$1" | awk '
		NF { last = $0; if (index($0, "错误：") || index($0, "失败")) picked = $0 }
		END { out = (picked != "" ? picked : last); sub(/^错误：/, "", out); print out }
	')
	# 安装器装到一半失败时会整个放回；放回成功就说一声，管理员知道面板还是原来那一版
	# An installer failing halfway puts everything back; when that worked say so, so the admin knows the panel is still
	# the old version
	if grep -q '^已恢复原来的面板' "$1"; then
		reason="${reason}；原来的面板已恢复"
	fi
	if [ -n "${reason}" ] && [ "$(printf '%s' "${reason}" | wc -c)" -le "${MAX_REASON_BYTES}" ]; then
		printf '%s\n' "${reason}"
	else
		printf '%s\n' "安装没有完成，详情见 logread -e kixdns-panel-update"
	fi
}

# vX.Y.Z / vX.Y.Z only
valid_release() {
	case $1 in
	v*) ;;
	*) return 1 ;;
	esac
	version=${1#v}
	case ${version} in
	*[!0-9.]* | .* | *. | *..*) return 1 ;;
	esac
	[ "$(printf '%s' "${version}" | tr -cd . | wc -c)" -eq 2 ]
}

# 两个 vX.Y.Z 逐段按数比，$1 比 $2 新时返回 0 / Compares two vX.Y.Z part by part as numbers, returning 0 when $1 is newer
release_gt() {
	a=${1#v}
	b=${2#v}
	while [ -n "${a}" ] || [ -n "${b}" ]; do
		x=${a%%.*}
		y=${b%%.*}
		if [ "${a}" = "${x}" ]; then a=""; else a=${a#*.}; fi
		if [ "${b}" = "${y}" ]; then b=""; else b=${b#*.}; fi
		x=${x:-0}
		y=${y:-0}
		[ "${x}" -gt "${y}" ] && return 0
		[ "${x}" -lt "${y}" ] && return 1
	done
	return 1
}

environment_value() {
	[ -f "${PANEL_ENV}" ] || return 0
	sed -n "s/^$1=//p" "${PANEL_ENV}" | head -n 1
}

# 不带 GitHub Token：uclient-fetch 只能把它放在命令行上，本机别的账号从 /proc 就能读到；匿名额度（每小时 60 次）够一次更新用
# No GitHub token: uclient-fetch takes it on the command line only, where other accounts on the host read it from /proc;
# the anonymous allowance (60 an hour) is plenty for one update
fetch() {
	uclient-fetch -q -T 30 -U kixdns-panel-online-updater -O "$2" "$1"
}

detect_architecture() {
	case $(uname -m) in
	aarch64 | arm64) printf 'arm64\n' ;;
	x86_64 | amd64) printf 'x86_64\n' ;;
	*) return 1 ;;
	esac
}

# /tmp 还有多少 KiB / How many KiB /tmp still has
free_kib() {
	df -Pk "$1" | awk 'NR == 2 { print $4 }'
}

# 包里只该有 <包目录>/ 下的普通文件和目录：没有绝对路径、没有 ..、没有链接和设备文件
# The package holds only regular files and directories under <package directory>/: no absolute paths, no .., no links
# or device files
validate_archive() {
	archive=$1
	root=$2
	tar -tzf "${archive}" >"${WORK}/entries" || return 1
	tar -tvzf "${archive}" >"${WORK}/listing" || return 1
	[ -s "${WORK}/entries" ] || return 1
	awk -v root="${root}" '
		{
			if ($0 != root && $0 != root "/" && index($0, root "/") != 1) exit 1
			if ($0 ~ /(^|\/)\.\.(\/|$)/) exit 1
		}
	' "${WORK}/entries" || return 1
	awk '{ kind = substr($1, 1, 1); if (kind != "-" && kind != "d") exit 1 }' "${WORK}/listing"
}

main() {
	[ "$(id -u)" = 0 ] || {
		printf '%s\n' '面板在线更新要以 root 运行' >&2
		exit 1
	}
	for command_name in uclient-fetch jsonfilter sha256sum tar flock; do
		command -v "${command_name}" >/dev/null 2>&1 || fail "缺少 ${command_name}"
	done
	mkdir -p "${LOCK_FILE%/*}"
	exec 9>>"${LOCK_FILE}"
	if ! flock -n 9; then
		# 另一个更新正在写状态文件；这里再写一份失败会盖掉它的进度
		# Another update owns the status file; writing a failure here would overwrite its progress
		printf '%s\n' '已有面板在线更新任务正在执行' >&2
		exit 1
	fi
	trap cleanup EXIT
	trap 'fail "在线更新被中断"' INT TERM HUP
	write_status checking "正在检查最新正式版" || {
		printf '%s\n' "写不了状态文件 ${STATUS_FILE}" >&2
		exit 1
	}

	architecture=$(detect_architecture) || fail "不支持这台设备的架构 $(uname -m)"
	asset="kixdns-panel-openwrt-${architecture}.tar.gz"
	WORK=$(mktemp -d "${WORK_PARENT}/kixdns-panel-update.XXXXXX") || fail "无法在 ${WORK_PARENT} 建临时目录"
	chmod 0700 "${WORK}"

	fetch "${RELEASE_API}" "${WORK}/release.json" ||
		fail "读取最新正式版失败：路由器连不上 GitHub，或者 GitHub 暂时限制了匿名访问；稍后再试"
	tag=$(jsonfilter -i "${WORK}/release.json" -e '@.tag_name') ||
		fail "GitHub 返回的最新正式版信息无法解析"
	valid_release "${tag}" || fail "最新正式版标签 ${tag} 不是 vX.Y.Z 格式"
	TARGET_VERSION=${tag}

	current_release=$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE)
	binary_release="v$("${PANEL_SERVER}" --version 2>/dev/null | awk 'NF >= 2 { print $NF; exit }')"
	valid_release "${binary_release}" || fail "无法读取当前面板程序的版本"
	floor=${binary_release}
	if [ -n "${current_release}" ]; then
		valid_release "${current_release}" || fail "panel.env 里记录的面板版本无效"
		! release_gt "${current_release}" "${floor}" || floor=${current_release}
	fi
	! release_gt "${floor}" "${tag}" || fail "最新正式版 ${tag} 低于当前面板 ${floor}，不会降级"
	if [ "${current_release}" = "${tag}" ]; then
		write_status complete "当前面板已经是最新正式版"
		return 0
	fi

	# 只认 Release 里刚好一个、已上传完的本架构安装包，地址必须是这个仓库这个标签下的
	# Exactly one uploaded package for this architecture in the release, at this repository's address for this tag
	filter="@.assets[@.name='${asset}' && @.state='uploaded']"
	count=$(jsonfilter -i "${WORK}/release.json" -e "${filter}.name" | wc -l)
	[ "${count}" -eq 1 ] || fail "Release ${tag} 里没有本架构（${architecture}）的 OpenWrt 安装包"
	url=$(jsonfilter -i "${WORK}/release.json" -e "${filter}.browser_download_url")
	digest=$(jsonfilter -i "${WORK}/release.json" -e "${filter}.digest")
	size=$(jsonfilter -i "${WORK}/release.json" -e "${filter}.size")
	[ "${url}" = "${DOWNLOAD_PREFIX}/${tag}/${asset}" ] || fail "安装包下载地址不可信"
	case ${digest} in
	sha256:*) digest=${digest#sha256:} ;;
	*) fail "安装包缺少有效的 SHA-256 摘要" ;;
	esac
	case ${digest} in
	*[!0-9a-f]* | "") fail "安装包缺少有效的 SHA-256 摘要" ;;
	esac
	[ "${#digest}" -eq 64 ] || fail "安装包缺少有效的 SHA-256 摘要"
	case ${size} in
	*[!0-9]* | "") fail "Release 安装包大小无效" ;;
	esac

	# 下载的包加上解开的大约是包的 4 倍，再留 8 MiB / The download plus its unpacked copy is about four times the
	# package; keep 8 MiB on top
	need_kib=$((size * 4 / 1024 + 8192))
	have_kib=$(free_kib "${WORK}")
	[ "${have_kib}" -ge "${need_kib}" ] ||
		fail "${WORK_PARENT} 剩余 $((have_kib / 1024)) MiB，下载和解包要 $((need_kib / 1024)) MiB；先腾出内存再试"

	write_status downloading "正在下载并校验 ${tag}"
	archive="${WORK}/${asset}"
	fetch "${url}" "${archive}" || fail "下载安装包失败，检查网络后再试"
	[ "$(sha256sum "${archive}" | cut -d' ' -f1)" = "${digest}" ] ||
		fail "安装包 SHA-256 与 GitHub 公布的摘要不一致，已丢弃；再试一次，仍不一致就不要安装，并到 https://github.com/${REPOSITORY}/issues 报告"
	package_name="kixdns-panel-openwrt-${architecture}"
	validate_archive "${archive}" "${package_name}" || fail "安装包里有不该有的路径或文件类型"
	mkdir -p "${WORK}/package"
	tar -xozf "${archive}" -C "${WORK}/package" || fail "解开安装包失败"
	rm -f -- "${archive}"
	package="${WORK}/package/${package_name}"
	[ -f "${package}/SHA256SUMS" ] && [ -f "${package}/install.sh" ] || fail "安装包目录结构无效"
	(cd "${package}" && sha256sum -c -s SHA256SUMS) || fail "安装包里的文件与 SHA256SUMS 不符"
	[ "$(cat "${package}/PANEL_RELEASE" 2>/dev/null)" = "${tag}" ] || fail "安装包记录的版本与 Release ${tag} 不一致"

	write_status downloading "正在安装 ${tag}，面板会重启一下"
	errors="${WORK}/errors"
	if ! sh "${package}/install.sh" --panel-only-update 2>"${errors}"; then
		cat -- "${errors}" >&2
		fail "$(failure_reason "${errors}")"
	fi
	cat -- "${errors}" >&2
	write_status complete "面板已更新到 ${tag}"
}

main "$@"
