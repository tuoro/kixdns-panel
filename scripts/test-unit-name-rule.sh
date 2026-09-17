#!/usr/bin/env bash
# shellcheck disable=SC1090,SC1091,SC2034
# systemd unit 名的规则在五处各写一遍：panel-server 的 Operations::new、panel-helper
# 的 validate_unit（Rust），以及 install.sh 一处、uninstall.sh 两处（bash 正则）。
# 装机脚本放行而面板拒绝的名字会写进 panel.env，然后面板整个起不来——不只是日志页。
# 这里把 bash 里的正则原样抓出来，用和 Rust 测试一字不差的名单过一遍，两边不能悄悄漂开。
#
# The unit-name rule is written five times: Operations::new in panel-server and
# validate_unit in panel-helper (Rust), plus once in install.sh and twice in
# uninstall.sh (bash regexes). A name the installer admits but the panel rejects
# lands in panel.env and then the whole panel refuses to start, not just the log
# page. This pulls the bash regex out verbatim and runs the same fixture list as
# the Rust tests, so the two languages cannot drift silently.
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALLER="${PACKAGE_ROOT}/scripts/install.sh"
UNINSTALLER="${PACKAGE_ROOT}/scripts/uninstall.sh"

fail() {
  printf '断言失败：%s\n' "$1" >&2
  exit 1
}

# 与 crates/panel-server/src/operations.rs 和 crates/panel-helper/src/main.rs 的
# unit_name_rule_matches_the_installer_fixtures 一字不差。
# Verbatim the list in unit_name_rule_matches_the_installer_fixtures in
# crates/panel-server/src/operations.rs and crates/panel-helper/src/main.rs.
printf -v longest '%*s' 120 ''
printf -v too_long '%*s' 121 ''
longest="${longest// /k}.service"
too_long="${too_long// /k}.service"
[[ ${#longest} -eq 128 && ${#too_long} -eq 129 ]] || fail "长度夹具算错了"
ACCEPTED=(kixdns.service kixdns@x.service k.service 0k.service a-b_c.d.service "${longest}")
REJECTED=(_kixdns.service -x.service .hidden.service @inst.service a..b.service kixdns "" "${too_long}")

# 把每一处 `=~ ^...\.service$` 原样抓出来；数量和内容都要对得上，少一处就是有人改了写法。
# Pull every `=~ ^...\.service$` out verbatim; count and text must both match,
# one fewer means someone rewrote the site.
extract_patterns() {
  grep -oE '=~ \^[^ ]+\\\.service\$' "$1" | sed 's/^=~ //'
}

mapfile -t install_patterns < <(extract_patterns "${INSTALLER}")
mapfile -t uninstall_patterns < <(extract_patterns "${UNINSTALLER}")
[[ ${#install_patterns[@]} -eq 1 ]] || fail "install.sh 应有且只有一处 unit 名正则，实际 ${#install_patterns[@]} 处"
[[ ${#uninstall_patterns[@]} -eq 2 ]] || fail "uninstall.sh 应有两处 unit 名正则，实际 ${#uninstall_patterns[@]} 处"
[[ ${install_patterns[0]} == "${uninstall_patterns[0]}" && ${install_patterns[0]} == "${uninstall_patterns[1]}" ]] ||
  fail "install.sh 与 uninstall.sh 的 unit 名正则不一致"
pattern=${install_patterns[0]}

# 正则本身写不出「不含 ..」，每一处都靠同一行上的 != *..* 补上；数一数它们没被漏掉。
# The regex cannot express "no ..", so each site adds != *..* on the same line;
# count that none of them dropped it.
[[ $(grep -cE '=~ \^[^ ]+\\\.service\$ && \$\{[A-Z_]+\} != \*\.\.\*' "${INSTALLER}") -eq 1 ]] ||
  fail "install.sh 的 unit 名检查缺少 != *..* 守卫"
[[ $(grep -cE '=~ \^[^ ]+\\\.service\$ && \$\{[A-Z_]+\} != \*\.\.\*' "${UNINSTALLER}") -eq 2 ]] ||
  fail "uninstall.sh 的 unit 名检查缺少 != *..* 守卫"

matches_rule() {
  [[ $1 =~ ${pattern} && $1 != *..* ]]
}

for unit in "${ACCEPTED[@]}"; do
  matches_rule "${unit}" || fail "bash 规则应接受 ${unit}"
done
for unit in "${REJECTED[@]}"; do
  ! matches_rule "${unit}" || fail "bash 规则应拒绝 '${unit}'"
done

# 再用 install.sh 真正的 validate_unit 走一遍，防止抓出来的正则和函数里跑的不是同一个。
# Run the installer's real validate_unit too, so the extracted regex cannot
# differ from what the function actually executes.
source "${INSTALLER}"
for unit in "${ACCEPTED[@]}"; do
  (KIXDNS_SERVICE_UNIT=${unit}; validate_unit) >/dev/null 2>&1 || fail "install.sh validate_unit 应接受 ${unit}"
done
for unit in "${REJECTED[@]}"; do
  ! (KIXDNS_SERVICE_UNIT=${unit}; validate_unit) >/dev/null 2>&1 || fail "install.sh validate_unit 应拒绝 '${unit}'"
done

printf 'unit 名规则：bash 与 Rust 夹具一致（%d 接受，%d 拒绝）\n' "${#ACCEPTED[@]}" "${#REJECTED[@]}"
