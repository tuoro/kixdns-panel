#!/usr/bin/env bash
set -Eeuo pipefail

# 威胁模型：kixdns-panel 账号当作攻击者，它不能变成 root，也不能左右 root 做什么。root 碰到面板能写的路径、读面板能影响的数据时，
# 都照下面四条（每一处在哪、怎么照做，列在 PR 的清单里）。uninstall.sh 开头是同样的四条。
# Threat model: the kixdns-panel account is treated as an attacker; it must never become root nor steer what root does.
# Wherever root touches a path the panel can write or reads data the panel can influence, these four rules hold (every site
# and how it complies is listed in the PR's inventory). uninstall.sh starts with the same four.
# R1：root 照着做事的记录（迁移前的备份 external-backup、关掉 resolved 监听的记录 resolved-stub，连同里面的 restore-incomplete、
#     *_CREATED，和 /var/lib/kixdns-panel-backup 里的一切）每读一次都先过同一个函数 trusted_record：放记录的目录和它上面每一层都归
#     root、不是符号链接，放记录的目录是 0700；记录里只有归 root 的普通文件，每个只有一个链接。验不过的马上挪出会被信的名字（挪进
#     只有 root 能进的 quarantine，名字带时间），这次和以后都不再用；拒绝时说清是哪一份、为什么、接下来怎么办。旧版放在面板状态
#     目录里的记录只接手一次（之后留下 .adopted 标记）；有了标记，那里再有的不验、不用，直接挪走：「归 root」证明不了是 root 建的，
#     root 自己也会把面板的文件交给 root。
# R1: a record root acts on (the pre-migration backup external-backup, the record of turning resolved's stub off
#     resolved-stub, with the restore-incomplete marker and *_CREATED entries in them, and anything under
#     /var/lib/kixdns-panel-backup) goes through one function, trusted_record, at every read: the records directory and
#     every level above it root's and no symlink, the records directory 0700; the record holding only regular root-owned
#     files with one link each. One that fails leaves every trusted name at once (into the root-only quarantine, its name
#     stamped with the time) and is never used by this run or a later one; the refusal names the copy, the reason and
#     what to do. Records an older version left in the panel's state directory are adopted once (leaving the .adopted
#     marker); with the marker, anything there later is moved away unchecked and never used: being root's proves nothing
#     about who made it, as root itself hands panel files to root.
# R2：面板账号还有任何进程时，root 不碰它能写的路径。先停面板，再以它的身份 kill -KILL -1，一直到 /proc 里没有一个归它（真实、
#     有效或保存的 UID）的活进程，再发一次（换 PID、改成不可转储都躲不掉）；面板一直停着，直到这些路径上的事全做完，回滚也一样：
#     放回文件和属主、删这次建的目录和账号，都在重启旧面板之前。在线更新（--panel-only-update）走同一条路。面板停下之前先停
#     helper（面板能请它以 root 起在线更新），安装器、卸载器和在线更新器同一时间只跑一个（同一把锁，放在只有 root 能进的目录里，
#     整个运行都拿着）。
# R2: root never touches a path the panel account can write while any process of that account exists. The panel is
#     stopped, then kill -KILL -1 runs as the account until /proc shows no live process of it (real, effective or saved
#     UID), and once more (changing PIDs or turning non-dumpable does not escape it); the panel stays stopped until every
#     root operation on such paths is finished, the rollback included: files and owners put back, this run's directories
#     and accounts removed, all before the old panel restarts. The online update (--panel-only-update) takes the same
#     path. The helper stops before the panel (the panel can ask it to start an online update as root), and the
#     installer, the uninstaller and the online updater run one at a time (one lock in a directory only root can enter,
#     held for the whole run).
# R3：面板能写的路径上，root 从不跟着符号链接走：chown 用 -h；chmod 只用在照 R2 停了以后、lstat 查过不是符号链接的目录或普通文件上；
#     已有的、面板能写的目录不用 install -d；这些路径上的重定向、sed -i、cp、mv、rm -rf、find -exec 都要先这样查过。
# R3: on panel-writable paths root never follows a symlink: chown with -h; chmod only on a directory or regular file checked
#     by lstat, under R2, to be no symlink; never install -d on an existing directory the panel can write; no redirection,
#     sed -i, cp, mv, rm -rf, find -exec or tar on such paths without the same check.
# R4：panel.env（和 root 读来定路径的别的东西）只有它和上面每一层目录都归 root、别人写不进时才信；不然 KixDNS 配置的路径照 root 才
#     能改的 KixDNS unit 认，对不上就停下，账号、归属这些照它做决定的项一律不认；重写时它里面的一项也不带过来。写进 panel.env
#     的每一项都照它的格式验过；panel.env、备份、unit 和 KixDNS 配置里来的值经 ENVIRON 交给 awk，不插进 sed、printf 的格式或 eval。
# R4: panel.env (and anything else root reads to decide paths) is trusted only when it and every directory above it are
#     root's and not writable by others; otherwise the KixDNS config path is taken from the KixDNS unit only root can
#     change, a mismatch stops the run, and no key that decides accounts or ownership is taken from it; a rewrite carries
#     nothing of it over. Every value written into panel.env passes its key's format; values from panel.env, a record, a
#     unit or the KixDNS config reach awk through ENVIRON and are never put into a sed script, a printf format or eval.

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PANEL_USER="kixdns-panel"
KIXDNS_USER="kixdns"
KIXDNS_GROUP="kixdns"
BACKUP_ROOT=""
INSTALL_MODE="auto"
INSTALL_KIND=""
KIXDNS_SERVICE_UNIT="kixdns.service"
# KixDNS 配置的默认目录，面板固定的位置；uninstall.sh 按同一个位置认出它。
# The KixDNS config's default directory, the panel's fixed location; uninstall.sh recognises it by the same location.
KIXDNS_CONFIG_DIRECTORY=/etc/kixdns
KIXDNS_CONFIG_PATH="${KIXDNS_CONFIG_DIRECTORY}/pipeline.json"
# 主机上已有 KixDNS 的 unit 里写着的配置路径。
# The config path the existing KixDNS's unit names.
KIXDNS_UNIT_CONFIG_PATH=""
KIXDNS_BINARY_PATH="/var/lib/kixdns-panel/bin/kixdns"
MANAGED_KIXDNS_BINARY="/var/lib/kixdns-panel/bin/kixdns"
EXISTING_KIXDNS_BINARY_PATH=""
KIXDNS_CONTROL_SOCKET="/run/kixdns/admin.sock"
KIXDNS_SERVICE_HELPER_SOCKET="/run/kixdns-panel/control.sock"
PANEL_CONFIG_DIRECTORY=/etc/kixdns-panel
PANEL_ENV=/etc/kixdns-panel/panel.env
# 迁移外部 KixDNS 时，面板管理的是原配置的一份副本，放在这个只有面板会建的目录里；原配置和它所在的目录一点不动，
# 卸载时恢复原来的 KixDNS，它用的还是迁移前的那份。uninstall.sh 按同一个位置认出副本。
# Migrating an external KixDNS, the panel manages a copy of the original config, kept in this directory that only the
# panel creates; the original config and its directory are left exactly as they were, so the original KixDNS restored
# on uninstall still runs the pre-migration one. uninstall.sh recognises the copy by the same location.
MIGRATED_KIXDNS_CONFIG_DIRECTORY=/etc/kixdns-panel/kixdns
MIGRATED_KIXDNS_CONFIG=/etc/kixdns-panel/kixdns/pipeline.json
# 迁移前原来的 KixDNS 的配置；只在面板改管它的副本时有值。升级时换配置位置（CONFIG_CONVERSION）时，是面板这次起不再写的那份。
# The original KixDNS's config from before migration; set only when the panel manages a copy of it. When an upgrade moves the
# config (CONFIG_CONVERSION), it is the one the panel stops writing from this run on.
ORIGINAL_KIXDNS_CONFIG_PATH=""
# 升级时把面板不该写的配置目录交还：legacy 是 v4.3.4 及更早原地迁移的主机，改管副本、原配置交还原来的 KixDNS；shared 是 #288
# 以前全新安装把配置放进公共目录（比如 /etc）的主机，配置挪到 /etc/kixdns。空的时候不换。
# On upgrade, hand back a config directory the panel should not write: legacy is a host migrated in place by v4.3.4 or
# earlier, moved onto a copy with the original handed back to the original KixDNS; shared is a host whose fresh install before
# #288 put the config in a shared directory (/etc, say), with the config moved to /etc/kixdns. Empty means no change.
CONFIG_CONVERSION=""
# 换配置位置时改了属主和权限的路径和改之前的样子，每项「路径|属主:属组 权限」，安装结果里列出来。
# The paths whose owner and mode the move changed, with how they were before, each "path|owner:group mode", listed in the
# install result.
CONVERSION_BEFORE=()
# 受管 KixDNS 的服务沙箱看不到的目录：deploy/systemd/kixdns.service 的 ProtectHome 和 PrivateTmp。
# Directories the managed KixDNS's service sandbox cannot see: ProtectHome and PrivateTmp in deploy/systemd/kixdns.service.
KIXDNS_HIDDEN_DIRECTORIES=(/home /root /run/user /tmp /var/tmp)
# 原配置里写的 Geo 文件里面板读不到的那些，每行「  文件：原因」；迁移照常，安装结果里点名。
# The Geo files the original config names that the panel cannot read, one "  file：reason" per line; migration goes ahead and
# the install result names them.
PANEL_UNREADABLE_FILES=""
PANEL_SERVER_BINARY=/usr/local/bin/kixdns-panel-server
# 安装器会建的目录：面板状态目录（和 uninstall.sh 同一个）、在线更新状态目录、前端与自带 GeoSite 的目录、helper 所在的目录。
# The directories the installer creates: the panel's state directory (the same as uninstall.sh's), the online update status
# directory, the directory of the web assets and bundled GeoSite, and the one holding the helper.
PANEL_STATE_DIRECTORY=/var/lib/kixdns-panel
PANEL_UPDATE_DIRECTORY=/var/lib/kixdns-panel-update
# 面板和 KixDNS 的运行目录 / The runtime directories of the panel and of KixDNS
PANEL_RUNTIME_DIRECTORY=/run/kixdns-panel
KIXDNS_RUNTIME_DIRECTORY=/run/kixdns
PANEL_SHARE_DIRECTORY=/usr/share/kixdns-panel
LIBEXEC_DIRECTORY=/usr/local/libexec
# 这次运行开始时这几个账号和组在不在；回滚只删这次建的。默认当作在，没记下来时什么也不删。
# Whether these accounts and the group existed when this run began; rollback removes only those it created. They count as
# existing by default, so nothing is removed unless recorded.
PANEL_USER_EXISTED=true
KIXDNS_USER_EXISTED=true
KIXDNS_GROUP_EXISTED=true
GITHUB_TOKEN_FILE=/var/lib/kixdns-panel/github-token
# 与 uninstall.sh 相同的固定位置：面板 unit 只允许写 /var/lib/kixdns-panel。
# The same fixed location uninstall.sh uses: the panel unit may only write /var/lib/kixdns-panel.
PANEL_DATABASE=/var/lib/kixdns-panel/panel.db
SYSTEMD_UNIT_DIRECTORY=/etc/systemd/system
# systemd 在 /etc/systemd/system 之后找 unit 的目录 / Where systemd looks for units after /etc/systemd/system
SYSTEMD_VENDOR_DIRECTORIES=(/run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system)
EXISTING_PANEL=false
EXISTING_KIXDNS=false
EXISTING_KIXDNS_UNIT=false
CREATED_EXTERNAL_BACKUP=false
PRESERVE_KIXDNS_STATE=false
KIXDNS_WAS_ACTIVE=false
KIXDNS_WAS_ENABLED=false
KIXDNS_BINARY_CHANGED=false
KIXDNS_UNIT_CHANGED=false
KIXDNS_RESTART=false
PANEL_ONLY_UPDATE=false
REINSTALL=false
PANEL_RELEASE=""
PANEL_BUILD_COMMIT=""
KIXDNS_BUILD_COMMIT=""
KIXDNS_SOURCE_ID=""
# 完整包自带内核的来源：现在的安装包都是 fork 发布版；只更新面板时沿用原来的记录。
# Where the full package's kernel came from: current packages carry a fork release; a panel-only update keeps the old record.
KIXDNS_SOURCE=""
PREVIOUS_PANEL_LABEL=""
SERVICE_WAIT_SECONDS=15
SERVICE_STABLE_SECONDS=4

# 端口 53：谁占着、要不要由安装器关闭 systemd-resolved 的本机监听，以及实际改过什么。
# Port 53: who holds it, whether the installer should turn off systemd-resolved's stub, and what it changed.
PORT_CONFLICT=none
PORT_CONFLICT_PORT=""
PORT_HOLDER_NAME=""
PORT_HOLDER_PID=""
PORT_HOLDER_ADDRESS=""
RESOLVED_ACTION=none
RESOLVED_CHANGED=false
RESOLVED_PORT=""
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/kixdns-panel.conf
RESOLV_CONF=/etc/resolv.conf
RESOLVED_UPLINK_RESOLV_CONF=/run/systemd/resolve/resolv.conf
# 只有 root 能进的目录，放 root 以后要照着做事的记录：迁移前原来的 KixDNS 的备份、关掉 systemd-resolved 监听时的记录。面板账号
# 写不进这里（旧版放在面板的状态目录里，面板能把它们换掉，见 secure_root_records）。和 uninstall.sh 同一个位置。
# A root-only directory for the records root acts on later: the backup of the original KixDNS from before migration and the
# record of turning systemd-resolved's stub off. The panel account cannot write here (older versions kept them in the
# panel's state directory, where the panel could replace them, see secure_root_records). The same place as uninstall.sh's.
ROOT_RECORDS=/var/lib/kixdns-panel-backup
EXTERNAL_BACKUP=${ROOT_RECORDS}/external-backup
RESOLVED_STATE=${ROOT_RECORDS}/resolved-stub
# root 的 UID；策略测试里换成跑测试的用户 / root's UID; the policy tests put the user running them here
ROOT_UID=0
# R1、R4 查「上面每一层都只有 root 能写」查到这里为止；策略测试里换成临时目录 / R1 and R4 check "every level above is root's
# alone" up to here; the policy tests put their scratch directory here
ROOT_CHAIN_TOP=/
# R4：panel.env 能不能信（panel_env_trusted）；不能信时它记的 KixDNS 配置和 unit 名是不是照 unit 对上了 / R4: whether panel.env
# can be trusted (panel_env_trusted); when not, whether the KixDNS config and unit name it records matched the unit
PANEL_ENV_TRUSTED=true
PANEL_ENV_VERIFIED=false
# R2：开头为了挪旧版的记录停了面板（PANEL_STOPPED_EARLY），在真的开始安装（ROOT_WORK_STARTED）之前就退出时照原样重启它
# R2: the panel stopped at the start to move older records (PANEL_STOPPED_EARLY) is restarted as it was when the run ends
# before the install really starts (ROOT_WORK_STARTED)
PANEL_WAS_ACTIVE=false
PANEL_STOPPED_EARLY=false
ROOT_WORK_STARTED=false
ROLLBACK_SHELL=""
# R2：面板停下之前先停 helper（面板能请它以 root 起在线更新），结束时照原样重启；照记录停下时面板和 helper 都不重启
# R2: the helper stops before the panel does (the panel can ask it to start an online update as root) and is restarted as
# it was at the end; a stop over a record restarts neither
HELPER_WAS_ACTIVE=false
KEEP_PANEL_STOPPED=false
# 安装器、卸载器、在线更新器共用的锁（take_root_lock）；/proc 的位置，策略测试里换成临时目录 / The lock the installer,
# uninstaller and online updater share (take_root_lock); where /proc is, a scratch directory in the policy tests
ROOT_LOCK=/run/kixdns-panel-root/lock
PROC_ROOT=/proc
# root 的 GID；策略测试里换成跑测试的用户的 / root's GID; the policy tests put the test user's here
ROOT_GID=0
# quarantine_record 把东西挪去了哪里（删掉时为空）/ Where quarantine_record moved something (empty when it was deleted)
QUARANTINED_TO=""
# SHOULD 3：回滚真的开始了（rollback_install 一进来就设）；在这之前退出时由 on_installer_exit 收拾 / SHOULD 3: the rollback
# really started (set first thing in rollback_install); an exit before that is tidied up by on_installer_exit
ROLLBACK_STARTED=false
ONE_CLICK_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh"
# 和 uninstall.sh 同一个：本地的卸载命令随面板删掉以后接着卸载用的 / The same as uninstall.sh's: what carries an uninstall on
# once the local command is gone with the panel
UNINSTALL_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh"
# v4.3.4 及更早的 panel.env 示例里，可信代理那一行和它上面的说明：默认信任本机代理。现在的示例默认谁都不信，说明是下面两行。
# The trusted-proxies line of the panel.env example up to v4.3.4 and the comment above it: the local proxy was trusted by
# default. The current example trusts none by default, with the two comment lines below.
OLD_TRUSTED_PROXIES_COMMENT='# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。'
OLD_TRUSTED_PROXIES_LINE='KIXDNS_TRUSTED_PROXIES=127.0.0.1/32,::1/128'
TRUSTED_PROXIES_COMMENT_1='# 仅这些代理 CIDR 可以提供 X-Forwarded-For；多个网段用逗号分隔。默认谁都不信。'
TRUSTED_PROXIES_COMMENT_2='# 面板在本机 Nginx 后面时写 127.0.0.1/32,::1/128；代理在容器或别的主机上时写它的精确 CIDR。'
# panel.env 还是旧示例的默认值和说明，这次换了说明：安装结果提醒一次 / panel.env still had the old example's default and
# comment, and this run replaced the comment: the install result says so once
TRUSTED_PROXIES_NOTICE=false

usage() {
  cat <<'EOF'
用法：sudo bash scripts/install.sh [选项]

  --replace-existing    主机上已有不是本面板安装的 KixDNS 时，同意迁移为增强版；无人值守安装必需
  --reinstall           已安装同一版本时仍重新安装，用于修复被改动或损坏的安装
  --panel-only-update   只更新面板，和系统页的「在线更新」一样；不停止也不替换 KixDNS
  --kixdns-unit UNIT    既有 KixDNS 的 systemd unit，默认 kixdns.service
  --kixdns-config PATH  既有 KixDNS 配置路径，默认从 unit 中检测
  --kixdns-binary PATH  既有 KixDNS 程序路径，默认从 unit 中检测
  --control-socket PATH KixDNS 控制 Socket，默认 /run/kixdns/admin.sock
  -h, --help            显示帮助

检测到已有 KixDNS 时，交互终端会先说明迁移会做什么再询问，默认不迁移；无人值守安装
必须带 --replace-existing。迁移保留配置和运行状态，原 unit 会备份，卸载面板时选择
移除增强版即可恢复原来的 KixDNS。

同一版本再次运行且面板在运行时不会改动任何东西；面板没在运行时会自动重新安装修复。
KixDNS 只在程序或 unit 确实变化时才会重启。
EOF
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-existing)
        # 旧参数单独给出去向：该模式从未能正常运行，不能让用户以为只是拼错了。
        # The old flag gets its own answer: the mode never worked, so it must not read like a typo.
        fail "「仅安装面板」模式已移除：它装出的面板无法启动。已有 KixDNS 时改用 --replace-existing 迁移为增强版；迁移会备份原 unit 与运行状态，卸载面板（sudo kixdns-panel-uninstall）时选择移除增强版即可恢复原来的 KixDNS。"
        ;;
      --replace-existing) INSTALL_MODE="managed" ;;
      --reinstall) REINSTALL=true ;;
      --kixdns-unit)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_SERVICE_UNIT=$2
        shift
        ;;
      --kixdns-config)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONFIG_PATH=$2
        shift
        ;;
      --kixdns-binary)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_BINARY_PATH=$2
        shift
        ;;
      --control-socket)
        [[ $# -ge 2 ]] || fail "$1 缺少参数"
        KIXDNS_CONTROL_SOCKET=$2
        shift
        ;;
      --panel-only-update)
        PANEL_ONLY_UPDATE=true
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "未知参数：$1" ;;
    esac
    shift
  done
}

validate_unit() {
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）：这里放行的名字面板启动时必须也放行。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh): what passes here must pass at panel start.
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${KIXDNS_SERVICE_UNIT} != *..* ]] ||
    fail "KixDNS systemd unit 名称无效"
}

# 路径里的 .、.. 和空的一段（//，或者结尾的 /）都不收：dirname 看到的目录会和真正写进去的目录对不上，配置目录的规则
# （require_dedicated_config_directory）就被绕开了，例如 /etc/kixdns/../x.json 实际放在 /etc。
# Paths with a ., .. or empty component (//, or a trailing /) are refused: the directory dirname sees would differ from the
# one really written to, bypassing the config-directory rules (require_dedicated_config_directory); /etc/kixdns/../x.json,
# say, lands in /etc.
validate_absolute_path() {
  local label=$1
  local path=$2
  safe_absolute_path "${path}" ||
    fail "${label}必须是绝对路径，不含空白、控制字符和反斜杠，也不含 .、.. 或空的一段（//）"
}

# 能写进 unit、panel.env 的绝对路径：不含空白、控制字符和反斜杠（awk -v、systemd 都会解开反斜杠），也不含 .、.. 或空的一段。
# An absolute path fit for a unit or panel.env: no whitespace, control character or backslash (awk -v and systemd both
# decode backslashes), and no ., .. or empty segment.
safe_absolute_path() {
  local path=$1
  [[ ${path} == /* && ${#path} -le 4096 && ${path} != *[[:space:][:cntrl:]\\]* &&
    ${path}/ != *//* && ${path}/ != */./* && ${path}/ != */../* ]]
}

# unit 名照 validate_unit 的规则对不对；只在子 shell 里换一下来验，外面的不动。参数：unit 名。
# Whether a unit name passes validate_unit's rule; swapped only inside a subshell to check it. Argument: the unit name.
unit_name_valid() {
  # shellcheck disable=SC2030 # 只在子 shell 里换 / Swapped in the subshell only
  (KIXDNS_SERVICE_UNIT=$1 && validate_unit) > /dev/null 2>&1
}

# MUST 1：写进 panel.env 的每一项照它的格式验：提交是 40 位十六进制，编号是正整数，来源只能是 fork，Release 标签、路径、unit 名照
# 各自的规则；空值表示没记。别的键不归安装器写。参数：键，值。
# MUST 1: every value written into panel.env is checked by its key's format: commits 40 hex digits, ids positive integers,
# the source only fork, release tags, paths and unit names by their own rules; empty means not recorded. Other keys are not
# the installer's to write. Arguments: the key, the value.
panel_env_value_valid() {
  local key=$1
  local value=$2
  case ${key} in
    KIXDNS_INSTALLED_COMMIT | KIXDNS_PANEL_INSTALLED_COMMIT) [[ -z ${value} || ${value} =~ ^[0-9a-fA-F]{40}$ ]] ;;
    KIXDNS_INSTALLED_SOURCE_ID) [[ -z ${value} || ${value} =~ ^[1-9][0-9]{0,18}$ ]] ;;
    KIXDNS_INSTALLED_SOURCE) [[ -z ${value} || ${value} == fork ]] ;;
    KIXDNS_PANEL_INSTALLED_RELEASE) [[ -z ${value} || ${value} =~ ^[0-9A-Za-z._-]{1,100}$ ]] ;;
    KIXDNS_CONFIG | KIXDNS_BINARY | KIXDNS_CONTROL_SOCKET | KIXDNS_SERVICE_HELPER_SOCKET) safe_absolute_path "${value}" ;;
    KIXDNS_SERVICE_UNIT) unit_name_valid "${value}" ;;
    *) return 1 ;;
  esac
}

# panel.env 里的一项。R4：不能信的 panel.env 只给出显示用的几项（版本只用来显示和记回 panel.env，是不是同一版照 root 的面板程序
# 比，见 same_panel_version_installed），KixDNS 配置和 unit 名只在照 unit 对上以后才给，别的（账号、归属、程序和 Socket 的路径）
# 一律不给。
# A setting from panel.env. R4: an untrusted panel.env yields only the few shown in messages (the versions are only shown and
# written back into panel.env; whether this is the same version compares root's panel program, see
# same_panel_version_installed), the KixDNS config and unit name only once they matched the unit, and nothing else
# (accounts, ownership, program and socket paths).
environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  if [[ ${PANEL_ENV_TRUSTED} == false ]]; then
    case ${key} in
      KIXDNS_CONFIG | KIXDNS_SERVICE_UNIT) [[ ${PANEL_ENV_VERIFIED} == true ]] || return 1 ;;
      *) return 1 ;;
    esac
  fi
  AWK_KEY="${key}" awk -F= 'BEGIN { key = ENVIRON["AWK_KEY"] }
    $1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

# R4：panel.env 不能信时（panel_env_trusted），它记的 KixDNS 配置要和 root 才能改的 unit 里写的一样，才照它的配置路径和 unit 名做；
# 对不上就在改动主机之前停下。没记配置的不用对，只说一声。
# R4: when panel.env cannot be trusted (panel_env_trusted), its config path and unit name are acted on only when the
# config it records equals the one in the unit only root can change; a mismatch stops the run before the host is
# touched. One recording no config needs no match and is only mentioned.
check_panel_env_trust() {
  local unit
  local recorded
  local unit_file
  local unit_config=""
  [[ -e ${PANEL_ENV} || -L ${PANEL_ENV} ]] || return 0
  ! panel_env_trusted || return 0
  PANEL_ENV_TRUSTED=false
  unit="$(state_file_value "${PANEL_ENV}" KIXDNS_SERVICE_UNIT || true)"
  # shellcheck disable=SC2031 # 用的是外面没被改过的那个 / The outer, unchanged one is meant
  unit=${unit:-${KIXDNS_SERVICE_UNIT}}
  recorded="$(state_file_value "${PANEL_ENV}" KIXDNS_CONFIG || true)"
  unit_file="${SYSTEMD_UNIT_DIRECTORY}/${unit}"
  if (KIXDNS_SERVICE_UNIT=${unit} && validate_unit) 2>/dev/null; then
    unit_config="$(managed_unit_config "${unit_file}")"
  fi
  if [[ -z ${recorded} ]]; then
    printf '%s 面板能改，它记的不能信：账号和归属这些项这次不照它做。\n' "${PANEL_ENV}"
    return 0
  fi
  if [[ ${recorded} == "${unit_config}" ]]; then
    PANEL_ENV_VERIFIED=true
    printf '%s 面板能改，它记的不能都信：KixDNS 配置照 %s 认（%s），账号和归属这些项这次不照它做。\n' \
      "${PANEL_ENV}" "${unit_file}" "${recorded}"
    return 0
  fi
  fail "${PANEL_ENV} 面板能改，它记的不能信：它写的 KixDNS 配置 ${recorded} 和 ${unit_file} 里的 ${unit_config:-（没有写）} 对不上，安装器不会照它做事。
查明 panel.env 是谁改的以后，把 KIXDNS_CONFIG 改成和 unit 里的一样再运行；现有安装未作修改。"
}

state_file_value() {
  local file=$1
  local key=$2
  [[ -f ${file} ]] || return 1
  AWK_KEY="${key}" awk -F= 'BEGIN { key = ENVIRON["AWK_KEY"] }
    $1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

fail() {
  # 改动主机以后的失败要回滚（abort_install）/ A failure once the host is being changed rolls back (abort_install)
  [[ ${ROOT_WORK_STARTED} == false ]] || abort_install "$@"
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

cancel_install() {
  # 取消是用户的选择，不是失败，所以不带「安装失败」前缀。
  # Cancelling is the user's choice, not a failure, so it carries no failure prefix.
  printf '已取消安装，现有 KixDNS 未作修改。\n' >&2
  exit 1
}

abort_install() {
  # 回滚已经挂上之后的失败：fail 的 exit 不会触发 ERR，必须显式回滚。只在挂回滚的那个 shell 里回滚：在子 shell 里（命令替换）只带着
  # 失败退出，外面的 shell 收到失败再回滚（rollback_install 里说了为什么）。
  # A failure once rollback is armed: fail's exit does not fire ERR, so roll back explicitly. Only the shell that armed the
  # rollback rolls back: in a subshell (a command substitution) it just exits with the failure, and the outer shell rolls
  # back on seeing it (rollback_install says why).
  printf '安装失败：%s\n' "$*" >&2
  rollback_install 1 failed "${ROLLBACK_SHELL}"
}

refuse_legacy_panel() {
  # 旧的「仅安装面板」主机从未跑起来过；在它上面升级只会得到另一个无法管理的面板。
  # Hosts from the removed panel-only mode never ran; upgrading in place would only yield another unmanageable panel.
  # 只剩 panel.env 而面板程序已卸载时不拒绝：那是按提示卸载并保留了配置，重新安装会删掉这个旧键。
  # A leftover panel.env without the panel program is not refused: that is an uninstall that kept the
  # config as advised, and a fresh install strips the stale key.
  [[ -e ${PANEL_SERVER_BINARY} ]] || return 0
  [[ $(environment_value KIXDNS_MANAGEMENT_ENABLED || true) == false ]] || return 0
  fail "这台主机装的是已移除的「仅安装面板」模式，不能直接升级或更新。
先运行 sudo kixdns-panel-uninstall 卸载面板（原来的 KixDNS 保持不变），
再重新安装，并在提示时选择迁移为增强版。"
}

# 一键安装遇到 GitHub 限流时，让用户先用 sudo 写入 Token；面板以 kixdns-panel 运行，读不了 root 的 0600 文件。
# 符号链接不跟随，留给面板报告路径不安全。
# One-click install tells rate-limited users to write the token with sudo; the panel runs as kixdns-panel
# and cannot read a root-owned 0600 file. Symlinks are not followed; the panel reports them as unsafe.
adopt_github_token() {
  [[ -f ${GITHUB_TOKEN_FILE} && ! -L ${GITHUB_TOKEN_FILE} && $(stat -c '%h' -- "${GITHUB_TOKEN_FILE}") == 1 ]] || return 0
  chown -h "${PANEL_USER}:${KIXDNS_GROUP}" -- "${GITHUB_TOKEN_FILE}"
  chmod 0600 -- "${GITHUB_TOKEN_FILE}"
}

load_existing_panel_settings() {
  local value
  [[ -x ${PANEL_SERVER_BINARY} && -f ${PANEL_ENV} ]] || return 0
  EXISTING_PANEL=true
  INSTALL_MODE="managed"
  value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
  value="$(environment_value KIXDNS_CONFIG || true)"
  [[ -z ${value} ]] || KIXDNS_CONFIG_PATH=${value}
  value="$(environment_value KIXDNS_BINARY || true)"
  [[ -z ${value} ]] || KIXDNS_BINARY_PATH=${value}
  value="$(environment_value KIXDNS_CONTROL_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_CONTROL_SOCKET=${value}
  value="$(environment_value KIXDNS_SERVICE_HELPER_SOCKET || true)"
  [[ -z ${value} ]] || KIXDNS_SERVICE_HELPER_SOCKET=${value}
  PREVIOUS_PANEL_LABEL="$(installed_panel_label)"
}

validate_panel_only_update() {
  [[ ${PANEL_ONLY_UPDATE} == true ]] || return 0
  [[ ${EXISTING_PANEL} == true ]] || fail "--panel-only-update 只适用于已安装的 KixDNS 面板；首次安装去掉这个参数"
}

package_panel_label() {
  if [[ -n ${PANEL_RELEASE} ]]; then
    printf '%s\n' "${PANEL_RELEASE}"
  else
    printf '构建 %.12s\n' "${PANEL_BUILD_COMMIT}"
  fi
}

installed_panel_label() {
  local release
  local commit
  release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  commit="$(environment_value KIXDNS_PANEL_INSTALLED_COMMIT || true)"
  if [[ -n ${release} ]]; then
    printf '%s\n' "${release}"
  elif [[ -n ${commit} ]]; then
    printf '构建 %.12s\n' "${commit}"
  else
    printf '旧版本\n'
  fi
}

same_panel_version_installed() {
  local release
  local commit
  [[ ${EXISTING_PANEL} == true ]] || return 1
  # S2、R4：不能信的 panel.env 记的版本只拿来显示：是不是同一版，照 root 的面板程序和包里的比
  # S2, R4: the version an untrusted panel.env records is only shown: whether this is the same version is decided by
  # comparing root's panel program with the package's
  if [[ ${PANEL_ENV_TRUSTED} == false ]]; then
    [[ -f ${PANEL_SERVER_BINARY} && ! -L ${PANEL_SERVER_BINARY} ]] && root_only_path "${PANEL_SERVER_BINARY}" &&
      cmp -s -- "${PANEL_SERVER_BINARY}" "${PACKAGE_ROOT}/bin/kixdns-panel-server"
    return
  fi
  release="$(environment_value KIXDNS_PANEL_INSTALLED_RELEASE || true)"
  commit="$(environment_value KIXDNS_PANEL_INSTALLED_COMMIT || true)"
  # 正式包比 Release 标签；任一方没有标签（开发构建）时退回比较构建提交。
  # Release packages compare tags; when either side has none (a dev build), fall back to the build commit.
  if [[ -n ${release} && -n ${PANEL_RELEASE} ]]; then
    [[ ${release} == "${PANEL_RELEASE}" ]]
    return
  fi
  [[ -n ${commit} && ${commit,,} == "${PANEL_BUILD_COMMIT,,}" ]]
}

# 这次运行开始时面板在不在运行：开头为了挪旧版的记录停了它的话，看停之前 / Whether the panel was running when this run
# began: if it was stopped at the start to move older records, as it was before that
panel_was_running() {
  if [[ ${PANEL_STOPPED_EARLY} == true ]]; then
    [[ ${PANEL_WAS_ACTIVE} == true ]]
  else
    systemctl is-active --quiet kixdns-panel.service 2>/dev/null
  fi
}

skip_if_already_installed() {
  [[ ${REINSTALL} == false ]] || return 0
  same_panel_version_installed || return 0
  # 版本相同但面板没在运行，说明安装坏了；直接退出等于把它当成好的，改按 --reinstall 修复。
  # Same version but the panel is not running means a broken install; exiting would pass it off as fine, so repair as --reinstall.
  if ! panel_was_running; then
    printf 'KixDNS 面板 %s 已安装，但面板没有在运行，现在按 --reinstall 重新安装以修复。\n' "$(package_panel_label)"
    REINSTALL=true
    return 0
  fi
  printf 'KixDNS 面板 %s 已安装，未作任何修改。\n' "$(package_panel_label)"
  printf '需要修复安装时，加 --reinstall 重新运行。\n'
  exit 0
}

detect_service_argument() {
  local name=$1
  local exec_start
  exec_start="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${exec_start} =~ --${name}=([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ ${exec_start} =~ --${name}[[:space:]]+([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

# 迁移和升级都要恢复原来的运行状态，所以在任何改动之前记下。必须写成 if：v3.1.0 以
# `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true` 结尾，未启用的 KixDNS 让函数返回非零，set -e 无声退出。
# Migration and upgrade both restore the original running state, so record it before any change. Keep the
# ifs: v3.1.0 ended with `systemctl is-enabled … && KIXDNS_WAS_ENABLED=true`, and a never-enabled KixDNS
# made the function return non-zero so set -e exited silently.
capture_managed_service_state() {
  if systemctl is-active --quiet "${KIXDNS_SERVICE_UNIT}" 2>/dev/null; then
    KIXDNS_WAS_ACTIVE=true
  fi
  if systemctl is-enabled --quiet "${KIXDNS_SERVICE_UNIT}" 2>/dev/null; then
    KIXDNS_WAS_ENABLED=true
  fi
}

detect_existing_kixdns() {
  local detected
  if systemctl cat "${KIXDNS_SERVICE_UNIT}" >/dev/null 2>&1; then
    EXISTING_KIXDNS_UNIT=true
  fi
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]] || command -v kixdns >/dev/null 2>&1 ||
    [[ -e /usr/local/bin/kixdns || -e ${MANAGED_KIXDNS_BINARY} ]]; then
    EXISTING_KIXDNS=true
  fi
  capture_managed_service_state
  [[ ${EXISTING_PANEL} == false ]] || return 0
  detected="$(detect_service_argument config || true)"
  if [[ -n ${detected} ]]; then
    KIXDNS_CONFIG_PATH=${detected}
    KIXDNS_UNIT_CONFIG_PATH=${detected}
  fi
  detected="$(detect_service_argument admin-socket || true)"
  [[ -z ${detected} ]] || KIXDNS_CONTROL_SOCKET=${detected}
  detected="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${detected} =~ path=([^[:space:];]+) ]]; then
    KIXDNS_BINARY_PATH=${BASH_REMATCH[1]}
  elif command -v kixdns >/dev/null 2>&1; then
    KIXDNS_BINARY_PATH="$(command -v kixdns)"
  elif [[ -x /usr/local/bin/kixdns ]]; then
    KIXDNS_BINARY_PATH=/usr/local/bin/kixdns
  fi
}

running_state_text() {
  if [[ $1 == true ]]; then
    printf '运行中'
  else
    printf '已停止'
  fi
}

print_migration_plan() {
  local enabled="未设开机自启"
  [[ ${KIXDNS_WAS_ENABLED} == false ]] || enabled="开机自启"
  printf '\n检测到主机上已有 KixDNS（不是由本面板安装的）：\n'
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]]; then
    printf '  服务：%s（%s，%s）\n' "${KIXDNS_SERVICE_UNIT}" "$(running_state_text "${KIXDNS_WAS_ACTIVE}")" "${enabled}"
  else
    printf '  服务：没有找到 %s\n' "${KIXDNS_SERVICE_UNIT}"
  fi
  if [[ -f ${KIXDNS_CONFIG_PATH} ]]; then
    printf '  配置：%s\n' "${KIXDNS_CONFIG_PATH}"
  else
    printf '  配置：%s（不存在，将写入默认配置）\n' "${KIXDNS_CONFIG_PATH}"
  fi
  if [[ -e ${KIXDNS_BINARY_PATH} ]]; then
    printf '  程序：%s\n' "${KIXDNS_BINARY_PATH}"
  else
    printf '  程序：没有找到\n'
  fi
  printf '\n迁移为增强版会：\n'
  if ! config_copied_on_migration "${KIXDNS_BINARY_PATH}"; then
    printf '  - 配置文件留在原位置，改由面板管理\n'
  elif [[ -f ${KIXDNS_CONFIG_PATH} ]]; then
    printf '  - 把配置复制到 %s，面板只改这份副本；原来的配置文件和它所在的目录不动\n' "${MIGRATED_KIXDNS_CONFIG}"
  else
    printf '  - 默认配置写到 %s，由面板管理；不在原位置创建文件\n' "${MIGRATED_KIXDNS_CONFIG}"
  fi
  printf '  - 用增强版替换 KixDNS 程序和 systemd unit\n'
  printf '  - 把原 unit 与运行状态备份到 %s\n' "${EXTERNAL_BACKUP}"
  printf '  - 保持原来的运行状态（现在%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
  printf '  - 卸载面板（sudo kixdns-panel-uninstall）时选择移除增强版，即可恢复原来的 KixDNS\n\n'
}

unattended_migration_message() {
  printf '检测到主机上已有 KixDNS（%s），无人值守安装需要明确同意迁移为增强版：\n' "${KIXDNS_SERVICE_UNIT}"
  printf '  sudo bash ./scripts/install.sh --replace-existing\n'
  printf '  curl -fsSL %s | sudo bash -s -- --replace-existing\n' "${ONE_CLICK_URL}"
  printf '迁移保留配置和运行状态，原 unit 备份到 %s，卸载面板时可恢复。' "${EXTERNAL_BACKUP}"
}

# 读一个 y/N 回答，认不出的输入最多再问两次；三次都认不出按「否」处理。
# Read a y/N answer, re-asking up to twice on unrecognised input; three misses count as "no".
ask_yes_no() {
  local question=$1
  local answer
  local attempt
  for ((attempt = 1; attempt <= 3; attempt++)); do
    printf '%s[y/N]：' "${question}" >&3
    answer=""
    IFS= read -r answer <&3 || true
    case ${answer} in
      [yY] | [yY][eE][sS]) return 0 ;;
      "" | [nN] | [nN][oO]) return 1 ;;
      *) printf '输入 y 或 n。\n' >&3 ;;
    esac
  done
  return 1
}

# 只有 root 能进的记录目录 ROOT_RECORDS 要用了：在就确认是 root 的真目录，不在就建。
# The root-only records directory ROOT_RECORDS is needed: when it exists, make sure it is root's own real directory, or
# create it.
ensure_root_records() {
  if [[ -e ${ROOT_RECORDS} || -L ${ROOT_RECORDS} ]]; then
    [[ -d ${ROOT_RECORDS} && ! -L ${ROOT_RECORDS} && $(stat -c '%u %a' -- "${ROOT_RECORDS}") == "${ROOT_UID} 700" ]] ||
      refuse_with_panel_held "${ROOT_RECORDS} 不是只有 root 能进的目录，不能放安装记录；先查看它是怎么来的"
    return 0
  fi
  install -d -o root -g root -m 0700 "${ROOT_RECORDS}"
}

# R1、R4：这个路径和它上面的每一层目录（到 ROOT_CHAIN_TOP 为止）都归 root、都不是符号链接、别人都写不进。
# R1, R4: this path and every directory above it (up to ROOT_CHAIN_TOP) are root's, none is a symlink, and nobody else
# can write any of them.
root_only_path() {
  local path=$1
  while :; do
    [[ -e ${path} && ! -L ${path} ]] || return 1
    [[ $(stat -c '%u' -- "${path}") == "${ROOT_UID}" ]] || return 1
    (((8#$(stat -c '%a' -- "${path}") & 8#022) == 0)) || return 1
    [[ ${path} != "${ROOT_CHAIN_TOP}" && ${path} != / ]] || return 0
    path="$(dirname -- "${path}")"
  done
}

# R1：一份记录（目录）哪里不对，说成一句话；没问题时什么也不输出。记录是 root 建的：目录归 root、不是符号链接、别人写不进，里面
# 只有归 root 的普通文件、每个只有一个链接，还有它该有的 install.env 和里面的那一项。参数：记录，记录的名字。
# R1: what is wrong with a record (a directory), in one sentence; nothing when it is fine. A record is root's making: the
# directory root's, no symlink, not writable by others, holding only regular root-owned files with one link each, and the
# install.env it must have with the key it must hold. Arguments: the record, the record's name.
record_problem() {
  local record=$1
  local name=$2
  local entry
  local key=KIXDNS_SERVICE_UNIT
  [[ ${name} != resolved-stub ]] || key=RESOLV_CONF_KIND
  if [[ -L ${record} ]]; then
    printf '它是符号链接\n'
    return 0
  fi
  if [[ ! -d ${record} ]]; then
    printf '它不是目录\n'
    return 0
  fi
  if [[ $(stat -c '%u' -- "${record}") != "${ROOT_UID}" ]]; then
    printf '它不是 root 建的\n'
    return 0
  fi
  if (((8#$(stat -c '%a' -- "${record}") & 8#022) != 0)); then
    printf '别人能往里写\n'
    return 0
  fi
  while IFS= read -r -d '' entry; do
    # 接手旧位置的记录时（第三个参数是 links），v4.3.4 用 systemctl link 装的 unit 备份成的符号链接可以照它指着的文件算
    # Adopting a record from the old place (third argument links), a symlink v4.3.4 backed up for a unit installed with
    # systemctl link may count by the file it points at
    if [[ ${3:-} == links && -L ${entry} ]] && trusted_record_link "${entry}"; then
      continue
    fi
    if [[ -L ${entry} ]]; then
      printf '里面的 %s 是符号链接，指着的文件或它上面的目录不是只有 root 能改\n' "${entry##*/}"
      return 0
    fi
    if [[ ! -f ${entry} ]]; then
      printf '里面的 %s 不是普通文件\n' "${entry##*/}"
      return 0
    fi
    if [[ $(stat -c '%u' -- "${entry}") != "${ROOT_UID}" ]]; then
      printf '里面的 %s 不是 root 建的\n' "${entry##*/}"
      return 0
    fi
    if [[ $(stat -c '%h' -- "${entry}") != 1 ]]; then
      printf '里面的 %s 有别的硬链接\n' "${entry##*/}"
      return 0
    fi
  done < <(find "${record}" -mindepth 1 -print0)
  if [[ ! -f ${record}/install.env ]]; then
    printf '里面没有 install.env\n'
  elif ! grep -q "^${key}=" -- "${record}/install.env"; then
    printf 'install.env 里没有 %s\n' "${key}"
  fi
}

# R1、(b)：记录里的符号链接能不能照它指着的文件算：链接本身归 root，指着的是普通文件、只有一个链接，它和上面每一层目录都归 root、
# 别人写不进。参数：链接。
# R1, (b): whether a symlink in a record may count by the file it points at: the link itself root's, pointing at a regular
# file with one link that, with every directory above it, is root's and not writable by others. Argument: the link.
trusted_record_link() {
  local link=$1
  local target
  [[ -L ${link} && $(stat -c '%u' -- "${link}") == "${ROOT_UID}" ]] || return 1
  target="$(readlink -f -- "${link}")" || return 1
  [[ -f ${target} && ! -L ${target} && $(stat -c '%h' -- "${target}") == 1 ]] || return 1
  root_only_path "${target}"
}

# (b)：把复制过来的记录里能信的符号链接换成它指着的文件的内容（普通文件，只有 root 能读写），接手以后记录里就只有普通文件。
# 不能信的链接留着，后面的检查会拒绝它。参数：复制过来的记录。
# (b): replace each trusted symlink in a copied record with the content of the file it points at (a regular file only root
# can read and write), so the adopted record holds regular files only. An untrusted link stays for the check after to
# refuse. Argument: the copied record.
materialize_record_links() {
  local entry
  while IFS= read -r -d '' entry; do
    trusted_record_link "${entry}" || continue
    rm -f -- "${entry}.material"
    cp -L -- "${entry}" "${entry}.material"
    chmod 0600 -- "${entry}.material"
    mv -fT -- "${entry}.material" "${entry}"
  done < <(find "$1" -mindepth 1 -maxdepth 1 -type l -print0)
}

# 两个目录在不在同一个文件系统：在才能一次 rename 挪过去。/ Whether two directories are on one filesystem: only then can one
# rename move a thing across.
same_filesystem() {
  [[ $(stat -c '%d' -- "$1") == "$(stat -c '%d' -- "$2")" ]]
}

# R1：一份不能信的记录挪出所有会被信的名字：挪进只有 root 能进的 ROOT_RECORDS/quarantine，名字带上时间；和它不在同一个文件系统时
# 直接删掉。输出挪到了哪里，删掉时输出空行。参数：记录，记录的名字。
# R1: a record that cannot be trusted leaves every name that is trusted: it moves into the root-only
# ROOT_RECORDS/quarantine, its name stamped with the time; on another filesystem it is deleted instead. Prints where it
# went, or an empty line when deleted. Arguments: the record, the record's name.
quarantine_record() {
  local record=$1
  local name=$2
  local destination
  QUARANTINED_TO=""
  # NIT 4：不在命令替换里调用：这里照记录停下时（ensure_root_records），停下的是这次运行本身，面板也照样停着
  # NIT 4: never called inside a command substitution: a stop over a record here (ensure_root_records) stops the run
  # itself, with the panel kept stopped as said
  ensure_root_records
  [[ -d ${ROOT_RECORDS}/quarantine && ! -L ${ROOT_RECORDS}/quarantine ]] ||
    install -d -o root -g root -m 0700 "${ROOT_RECORDS}/quarantine"
  destination="${ROOT_RECORDS}/quarantine/${name}.$(date -u +%Y%m%dT%H%M%SZ).$$"
  if same_filesystem "$(dirname -- "${record}")" "${ROOT_RECORDS}/quarantine"; then
    mv -T -- "${record}" "${destination}"
    # NIT 5：挪进来的整个交给 root（不跟着链接），面板账号删掉以后不留归空 UID 的东西
    # NIT 5: what moved in goes to root as a whole (no link followed), so nothing is left owned by a freed UID once the
    # panel account is gone
    chown -hR "${ROOT_UID}:${ROOT_GID}" -- "${destination}"
    QUARANTINED_TO=${destination}
  else
    rm -rf -- "${record}"
  fi
}

# R1：拒绝一份不能信的记录：先把它挪走（quarantine_record），再停下，说清是哪一份、为什么、它去了哪里、接下来怎么办。参数：记录，
# 记录的名字，哪里不对。
# R1: refuse a record that cannot be trusted: move it away first (quarantine_record), then stop, saying which copy, why,
# where it went and what to do next. Arguments: the record, the record's name, what is wrong.
refuse_record() {
  local destination
  local where
  quarantine_record "$1" "$2"
  destination=${QUARANTINED_TO}
  if [[ -n ${destination} ]]; then
    where="已经挪到只有 root 能进的 ${destination}，这次和以后都不会再用；查看以后确认不要了就删掉：sudo rm -rf ${destination}"
  else
    where="已经删掉，这次和以后都不会再用"
  fi
  refuse_with_panel_held "$1 不能信（$3），不会照它做事。它${where}。
这台主机就当作没有这份记录：确认以后再运行一次，会接着做下去，不再照它恢复。"
}

# R1、S1：照记录停下。开头为了记录停了面板的话（panel_held_for_records，两个脚本各有一份），面板和它的 helper 不再重启：重启了它
# 又能改那些东西，等管理员处理；说清怎么先把面板用起来。参数：说明。
# R1, S1: stop over a record. When the panel was stopped at the start for the records (panel_held_for_records, each script
# has its own), the panel and its helper are not restarted: restarted, it could change those things again before the admin
# can act; how to get the panel running meanwhile is said. Argument: the explanation.
refuse_with_panel_held() {
  if panel_held_for_records; then
    KEEP_PANEL_STOPPED=true
    fail "$1
面板和它账号的进程这时都停着，处理好以后再运行一次就会接着做下去；在那之前要先用面板：sudo systemctl start kixdns-panel-helper.service kixdns-panel.service"
  fi
  fail "$1"
}

# R1：用一份记录之前都走这里。返回 0：记录在、能信；返回 1：没有这份记录。放记录的目录不是只有 root 能进的、或者记录本身不能信
# 时，挪走并停下（refuse_record），不会返回。参数：记录的名字（external-backup 或 resolved-stub）。
# R1: every use of a record goes through here. Returns 0: the record is there and can be trusted; 1: there is no such
# record. When the records directory is not root-only, or the record itself cannot be trusted, it is moved away and the
# run stops (refuse_record), never returning. Argument: the record's name (external-backup or resolved-stub).
trusted_record() {
  local name=$1
  local record=${ROOT_RECORDS}/${name}
  local problem
  [[ -e ${record} || -L ${record} ]] || return 1
  if ! root_only_path "${ROOT_RECORDS}" || [[ $(stat -c '%a' -- "${ROOT_RECORDS}") != 700 ]]; then
    refuse_with_panel_held "${ROOT_RECORDS} 不是只有 root 能进的目录（它或它上面的目录不归 root、别人能写，或者是符号链接），里面的记录都不能信；先查看它是怎么来的"
  fi
  problem="$(record_problem "${record}" "${name}")"
  [[ -n ${problem} ]] || return 0
  refuse_record "${record}" "${name}" "${problem}"
}

# 旧版把记录放在面板的状态目录里 / Older versions kept the records in the panel's state directory
old_records_present() {
  [[ -e ${PANEL_STATE_DIRECTORY}/external-backup || -L ${PANEL_STATE_DIRECTORY}/external-backup ||
    -e ${PANEL_STATE_DIRECTORY}/resolved-stub || -L ${PANEL_STATE_DIRECTORY}/resolved-stub ]]
}

# R1：旧位置的记录只接手一次。这个版本第一次运行时（安装器或卸载器，旧位置有没有记录都一样）在放记录的目录里留下这个标记；有了
# 它，旧位置再出现的东西一律不是 root 写的：不验、不用。root 自己也会把面板的文件交给 root（保留 KixDNS、删除面板数据时），
# 所以「归 root」证明不了是 root 建的。卸载以后标记也留着；管理员删掉整个 ROOT_RECORDS 以后，下次运行才会再验一次旧位置。
# R1: records from the old place are adopted once. The first run of this version (installer or uninstaller, with or without
# records in the old place) leaves this marker in the records directory; from then on anything showing up in the old place
# was not written by root: never checked, never used. Root itself hands panel files to root (keeping KixDNS while removing
# the panel data), so being root's proves nothing about who made it. The marker survives an uninstall; only once the admin
# removes the whole ROOT_RECORDS does a later run look at the old place again.
adoption_done() {
  [[ -f ${ROOT_RECORDS}/.adopted && ! -L ${ROOT_RECORDS}/.adopted ]] && root_only_path "${ROOT_RECORDS}" &&
    [[ $(stat -c '%a' -- "${ROOT_RECORDS}") == 700 ]]
}

mark_adoption_done() {
  adoption_done && return 0
  ensure_root_records
  # 上面有别人能写的一层时，记录本来就一份也不能信（trusted_record 会停下），标记写了也不算数 / With a level above writable by
  # others no record can be trusted anyway (trusted_record stops), and a marker would count for nothing
  root_only_path "${ROOT_RECORDS}" || return 0
  [[ ! -e ${ROOT_RECORDS}/.adopted && ! -L ${ROOT_RECORDS}/.adopted ]] || rm -rf -- "${ROOT_RECORDS}/.adopted"
  printf '%s\n' "这台主机已经接手过旧版放在 ${PANEL_STATE_DIRECTORY} 里的记录（或者那里本来就没有）；那里以后再有的都不用。" \
    > "${ROOT_RECORDS}/.adopted"
}

# R1：已经接手过以后，旧位置的东西不验、不用：挪进 quarantine（不在同一个文件系统就删掉），说一声，接着做。要在面板停了、它的
# 进程都没了以后调用（R2）。
# R1: once adopted, whatever is in the old place is never checked or used: moved into quarantine (deleted on another
# filesystem), said, and the run carries on. Call it once the panel has stopped and its processes are gone (R2).
discard_old_records() {
  local name
  local old
  local destination
  local where
  for name in external-backup resolved-stub; do
    old=${PANEL_STATE_DIRECTORY}/${name}
    [[ -e ${old} || -L ${old} ]] || continue
    quarantine_record "${old}" "${name}"
    destination=${QUARANTINED_TO}
    where="已删掉"
    [[ -z ${destination} ]] || where="挪到了 ${destination}"
    printf '%s 不用（%s）：这台主机已经接手过旧版的记录，之后这里再有的都不是 root 写的。\n' "${old}" "${where}"
  done
}

# R1、R2、S1：这个版本第一次运行时，把旧版留在面板状态目录里的记录挪进只有 root 能进的 ROOT_RECORDS。要在面板停了、它的进程都
# 没了以后调用（R2），这时面板改不了它们：先在原地验（record_problem），能信才挪；同一个文件系统一次 rename，不同的就复制、验过
# 复制的那份再换上、再删原来的。只有 root 能进的那里已经有一份时用那份。没用上的（不能信的、已经有一份的）挪进 quarantine，说一声，
# 当作没有这份记录接着做，不停下。放记录的目录只在验过以后才建。
# R1, R2, S1: on this version's first run, move the records older versions left in the panel's state directory into the
# root-only ROOT_RECORDS. Call it once the panel has stopped and its processes are gone (R2), so the panel cannot change
# them: checked in place first (record_problem), moved only when they can be trusted; one rename on the same filesystem,
# otherwise a copy, checked, put in place, and then the original removed. With a copy already in the root-only place, that
# one is used. One not used (untrusted, or already there) goes into quarantine, this is said, and the run carries on as if
# there were no such record, never stopping. The records directory is only created after the checks pass.
adopt_old_records() {
  local name
  local old
  local new
  local problem
  local destination
  local where
  for name in external-backup resolved-stub; do
    old=${PANEL_STATE_DIRECTORY}/${name}
    new=${ROOT_RECORDS}/${name}
    [[ -e ${old} || -L ${old} ]] || continue
    if [[ -e ${new} || -L ${new} ]]; then
      trusted_record "${name}"
      quarantine_record "${old}" "${name}"
      destination=${QUARANTINED_TO}
      where="已删掉"
      [[ -z ${destination} ]] || where="挪到了 ${destination}"
      printf '%s 没有用（%s）：只有 root 能进的 %s 里已经有一份，用的是那份。\n' "${old}" "${where}" "${new}"
      continue
    fi
    problem="$(record_problem "${old}" "${name}" links)"
    if [[ -n ${problem} ]]; then
      quarantine_record "${old}" "${name}"
      destination=${QUARANTINED_TO}
      where="已删掉"
      [[ -z ${destination} ]] || where="挪到了 ${destination}"
      printf '%s 不能信（%s），没有用它（%s）；这台主机就当作没有这份记录。\n' "${old}" "${problem}" "${where}"
      [[ -z ${destination} || ${problem} != *符号链接* ]] ||
        printf '确认它就是迁移前的备份的话：把里面的符号链接换成它指着的那个文件（sudo cp --remove-destination 指着的文件 那个链接），再 sudo mv %s %s，然后再运行一次。\n' \
          "${destination}" "${new}"
      continue
    fi
    ensure_root_records
    if same_filesystem "${PANEL_STATE_DIRECTORY}" "${ROOT_RECORDS}" && [[ -z "$(find "${old}" -mindepth 1 -type l -print -quit)" ]]; then
      mv -T -- "${old}" "${new}"
    else
      rm -rf -- "${new}.incoming"
      cp -a -- "${old}" "${new}.incoming"
      materialize_record_links "${new}.incoming"
      problem="$(record_problem "${new}.incoming" "${name}")"
      if [[ -n ${problem} ]]; then
        rm -rf -- "${new}.incoming"
        refuse_with_panel_held "复制 ${old} 到 ${new} 时出了问题（${problem}），没有挪；现有安装未作修改"
      fi
      mv -T -- "${new}.incoming" "${new}"
      rm -rf -- "${old}"
    fi
    trusted_record "${name}" || fail "${new} 挪过来以后不见了"
    printf '旧版放在 %s 的记录已验过，挪到只有 root 能进的 %s。\n' "${old}" "${new}"
  done
}

# R1：旧位置有东西时，先让面板停下、它的进程都没了（quiesce_for_records，两个脚本各有一份），再处理：还没接手过就验、能信才挪，
# 接手过了就不验、挪走。最后留下「接手过」的标记。
# R1: with anything in the old place, first stop the panel and every process of its account (quiesce_for_records, each
# script has its own), then deal with it: not yet adopted, check and move what can be trusted; adopted already, move it
# away unchecked. Then leave the "adopted" marker.
secure_root_records() {
  if old_records_present; then
    quiesce_for_records
    if adoption_done; then
      discard_old_records
    else
      adopt_old_records
    fi
  fi
  mark_adoption_done
}

# 安装器、卸载器和在线更新器同一时间只跑一个：同一把锁（ROOT_LOCK，在只有 root 能写的 /run 里，不在任何面板能写的目录里），
# 整个运行都拿着。在线更新器先拿了锁再调安装器时，安装器用它传下来的那一个（KIXDNS_PANEL_ROOT_LOCK_FD）。面板请 helper 起的
# 在线更新因此进不来，不会在这次运行中途重启面板。
# The installer, the uninstaller and the online updater run one at a time: one lock (ROOT_LOCK, in /run, which only root
# can write, outside every directory the panel can write), held for the whole run. When the online updater took it and
# then runs the installer, the installer uses the one handed down (KIXDNS_PANEL_ROOT_LOCK_FD). An online update the panel
# asks the helper for therefore cannot get in, and cannot restart the panel half way through this run.
take_root_lock() {
  local fd=${KIXDNS_PANEL_ROOT_LOCK_FD:-}
  local directory=${ROOT_LOCK%/*}
  if [[ ${fd} =~ ^[0-9]+$ && $(readlink -- "/proc/$$/fd/${fd}" 2>/dev/null) == "${ROOT_LOCK}" ]] && flock -n "${fd}"; then
    return 0
  fi
  # SHOULD 2：锁放在只有 root 能进的目录里：面板打不开它，也就拿不住它（以前 0644 的锁文件面板能只读打开、一直拿着共享锁）
  # SHOULD 2: the lock lives in a directory only root can enter: the panel cannot open it, so it cannot hold it (the 0644
  # lock file before could be opened read-only by the panel and held with a shared lock)
  [[ -e ${directory} || -L ${directory} ]] || install -d -o root -g root -m 0700 "${directory}"
  [[ -d ${directory} && ! -L ${directory} && $(stat -c '%u %a' -- "${directory}") == "${ROOT_UID} 700" ]] ||
    fail "${directory} 不是只有 root 能进的目录，锁不能放在那里；先查看它是怎么来的"
  exec {ROOT_LOCK_FD}>> "${ROOT_LOCK}"
  flock -n "${ROOT_LOCK_FD}" ||
    fail "另一个安装、卸载或在线更新正在运行（同一时间只能有一个$(root_lock_holder)）；等它结束再运行。"
  export KIXDNS_PANEL_ROOT_LOCK_FD=${ROOT_LOCK_FD}
}

# 拿着锁的是谁：从 /proc/locks 按锁文件的设备号和 inode 找出进程，写成「：PID n，程序 x，unit y」；找不到时什么也不输出。
# Who holds the lock: the process found in /proc/locks by the lock file's device and inode, as "：PID n，程序 x，unit y";
# nothing when none is found.
root_lock_holder() {
  local inode
  local device
  local pid
  local name
  local unit
  read -r inode device < <(stat -c '%i %d' -- "${ROOT_LOCK}" 2>/dev/null) || return 0
  [[ ${inode} =~ ^[0-9]+$ && ${device} =~ ^[0-9]+$ ]] || return 0
  # /proc/locks 写的是「主设备号:次设备号:inode」，设备号是十六进制 / /proc/locks reads "major:minor:inode", the numbers in hex
  device="$(printf '%02x:%02x:%s' "$(((device >> 8) & 0xfff | ((device >> 32) & ~0xfff)))" \
    "$(((device & 0xff) | ((device >> 12) & ~0xff)))" "${inode}")"
  pid="$(AWK_DEVICE=${device} awk '$2 != "->" && $6 == ENVIRON["AWK_DEVICE"] { print $5; exit }' "${PROC_ROOT}/locks" 2>/dev/null)"
  [[ ${pid} =~ ^[1-9][0-9]*$ ]] || return 0
  name="$(tr -cd 'A-Za-z0-9._-' < "${PROC_ROOT}/${pid}/comm" 2>/dev/null)"
  # 分隔符不能用 |：那样 \| 成了字面的竖线，不再是「或」/ The delimiter cannot be |: \| would then be a literal bar, not "or"
  unit="$(sed -n 's#^0::.*/\([A-Za-z0-9@._-]*\.\(service\|scope\)\)$#\1#p' "${PROC_ROOT}/${pid}/cgroup" 2>/dev/null | head -n 1)"
  printf '：拿着锁的是 PID %s' "${pid}"
  [[ -z ${name} ]] || printf '，程序 %s' "${name}"
  [[ -z ${unit} ]] || printf '，unit %s' "${unit}"
}

# R2：要停的进程的 UID：kixdns-panel 账号的，和这些面板能写的路径的属主里已经没有账号的（旧版卸载器删掉面板账号以后，它的进程
# 可能还在，新建的账号也可能拿到同一个 UID）。参数：面板能写的路径。
# R2: the UIDs whose processes must stop: the kixdns-panel account's, and any owner of these panel-writable paths that no
# longer has an account (an older uninstaller deleted the panel account while its processes may live on, and a new account
# may get the same UID). Arguments: the panel-writable paths.
panel_process_uids() {
  local uid
  local path
  local owner
  local -A uids=()
  uid="$(id -u kixdns-panel 2>/dev/null || true)"
  [[ -z ${uid} || ${uid} == 0 ]] || uids[${uid}]=1
  for path in "$@"; do
    [[ -e ${path} || -L ${path} ]] || continue
    owner="$(stat -c '%u' -- "${path}" 2>/dev/null || true)"
    [[ -n ${owner} && ${owner} != 0 && ${owner} != "${ROOT_UID}" ]] || continue
    ! getent passwd "${owner}" >/dev/null 2>&1 || continue
    uids[${owner}]=1
  done
  printf '%s\n' "${!uids[@]}"
}

# R2：以这个 UID 的身份给它的进程发信号：kill -1 由内核一次发给它所有的进程，换 PID、改成不可转储都躲不掉，发信号的那一刻
# 正在 fork 的也一样。参数：UID，GID，信号。
# R2: signal a UID's processes as that UID: kill -1 has the kernel send it to all of them at once, so changing PIDs or
# turning non-dumpable does not escape it, nor does a fork under way at that moment. Arguments: UID, GID, signal.
account_signal() {
  setpriv --reuid="$1" --regid="$2" --clear-groups -- bash -c "kill -$3 -1" 2>/dev/null
}

# R2：这个 UID 还有没死的进程：/proc 里任何一个进程的真实、有效或保存的 UID 是它，又不是僵尸。看的是 status 里的 Uid 行，不是
# /proc/<pid> 的属主（不可转储的进程那里写的是 root）。kill -0 -1 问不出来：Linux 上只要还有别的进程，它就算成功。参数：UID。
# R2: this UID still has a live process: any process in /proc whose real, effective or saved UID it is, and that is no
# zombie. The Uid line of status is read, not the owner of /proc/<pid> (root for a non-dumpable process). kill -0 -1
# cannot tell: on Linux it succeeds whenever any other process exists. Argument: the UID.
account_live_processes() {
  local uid=$1
  local file
  local line
  local state
  local real
  local effective
  local saved
  local live
  # 一个线程一个线程地看（/proc/<pid>/task/<tid>/status）：主线程退出成了僵尸、别的线程还在跑的进程也算活着。读不到的：任务已经
  # 不在了就跳过，还在却读不到，当作还活着（宁可停下，也不当作停光了）。
  # Thread by thread (/proc/<pid>/task/<tid>/status): a process whose main thread exited into a zombie while other threads run
  # counts as live. One that cannot be read: skipped when the task is gone, counted as live when it is still there (better
  # to stop than to take it as all gone).
  for file in "${PROC_ROOT}"/[0-9]*/task/[0-9]*/status; do
    state=""
    live=false
    if ! { while IFS= read -r line; do
      case ${line} in
        State:*)
          read -r _ state _ <<< "${line}"
          ;;
        Uid:*)
          read -r _ real effective saved _ <<< "${line}"
          [[ ${real} != "${uid}" && ${effective} != "${uid}" && ${saved} != "${uid}" ]] || live=true
          break
          ;;
      esac
    done < "${file}"; } 2>/dev/null; then
      [[ ! -e ${file%/status} ]] || return 0
      continue
    fi
    [[ ${live} == false || ${state} == Z || ${state} == X ]] || return 0
  done
  return 1
}

# R2：面板停了以后，把面板账号（和旧面板账号留下的 UID）的进程一个不留地停掉（以它的身份 kill -KILL -1，直到 /proc 里没有它活着的
# 进程），停光才返回。停不掉就用第一个参数（fail 或
# abort_install）停下：那些进程还能改面板目录里的文件，root 这时不碰它们。参数：怎么停下，面板能写的路径。
# R2: once the panel has stopped, stop every process of the panel account (and of UIDs an old panel account left), and
# return only when none is left. When they cannot be stopped, stop with the first argument (fail or abort_install): those
# processes could still change files in the panel's directories, so root keeps away from them. Arguments: how to stop,
# the panel-writable paths.
quiesce_panel_account() {
  local refuse=$1
  local uid
  local gid
  local attempt
  local status=0
  shift
  gid="$(getent group kixdns 2>/dev/null | cut -d: -f3 || true)"
  for uid in $(panel_process_uids "$@"); do
    for ((attempt = 0; attempt < 50; attempt++)); do
      account_signal "${uid}" "${gid:-65534}" KILL || true
      if ! account_live_processes "${uid}"; then
        # 看完以后再发一次，查的时候才冒出来的也停掉 / Once more after the look, for one that appeared meanwhile
        account_signal "${uid}" "${gid:-65534}" KILL || true
        continue 2
      fi
      sleep 0.1
    done
    "${refuse}" "面板账号（UID ${uid}）还有停不掉的进程；它们还能改面板目录里的文件，这时不动这些目录" || status=1
  done
  return "${status}"
}

# R4：panel.env 能不能信：它和它上面的每一层目录都归 root、别人写不进、不是符号链接。/ R4: whether panel.env can be
# trusted: it and every directory above it are root's, not writable by others, and no symlink.
panel_env_trusted() {
  root_only_path "${PANEL_ENV}"
}

# R4：unit 文件里 ExecStart 跑面板的 KixDNS 程序时写的 --config；不是这样的 unit 什么也不输出。只认 root 才能改的 unit 文件：它和
# 它所在的目录都归 root、不是符号链接、别人写不进。再往上不查：v4.3.4 把 /etc 交给了面板的主机，正要靠这次升级交还。
# R4: the --config an ExecStart running the panel's KixDNS program names in a unit file; nothing for any other unit. Only a
# unit file root alone can change counts: it and its directory are root's, no symlink, and not writable by others. Nothing
# further up is checked: on hosts where v4.3.4 gave /etc to the panel, this very upgrade is what hands it back.
managed_unit_config() {
  local file=$1
  local path
  for path in "${file}" "$(dirname -- "${file}")"; do
    [[ -e ${path} && ! -L ${path} && $(stat -c '%u' -- "${path}") == "${ROOT_UID}" ]] || return 0
    (((8#$(stat -c '%a' -- "${path}") & 8#022) == 0)) || return 0
  done
  [[ -f ${file} ]] || return 0
  AWK_BINARY="${PANEL_STATE_DIRECTORY}/bin/kixdns" awk 'BEGIN { binary = ENVIRON["AWK_BINARY"] }
    /^ExecStart=/ {
      line = $0
      sub(/^ExecStart=/, "", line)
      count = split(line, words, " ")
      if (words[1] != binary && words[1] != "/var/lib/kixdns-panel/bin/kixdns") next
      for (i = 2; i < count; i++) if (words[i] == "--config") config = words[i + 1]
    }
    END { if (config != "") print config }
  ' "${file}"
}

# 「属主:属组 权限」，权限写成四位八进制；账号或组已经删掉的写成「已删除的面板账号（UID n）」「已删除的组（GID n）」。
# "owner:group mode", the mode as four octal digits; a deleted account or group reads 「已删除的面板账号（UID n）」 or
# 「已删除的组（GID n）」.
owner_and_mode() {
  local mode
  local owner
  local group
  mode="$(stat -c '%a' -- "$1")"
  owner="$(stat -c '%U' -- "$1")"
  [[ ${owner} != UNKNOWN ]] || owner="已删除的面板账号（UID $(stat -c '%u' -- "$1")）"
  group="$(stat -c '%G' -- "$1")"
  [[ ${group} != UNKNOWN ]] || group="已删除的组（GID $(stat -c '%g' -- "$1")）"
  printf '%s:%s %04o\n' "${owner}" "${group}" "$((8#${mode}))"
}

# R1：开头挪旧版的记录之前，照 R2 先停面板和它账号的所有进程；在真的开始安装之前退出时照原样重启面板。
# R1: before records are moved from the old place at the start, stop the panel and every process of its account first (R2);
# when the run ends before the install really starts, the panel is restarted as it was.
quiesce_for_records() {
  [[ ${PANEL_STOPPED_EARLY} == false ]] || return 0
  if systemctl is-active --quiet kixdns-panel.service 2>/dev/null; then
    PANEL_WAS_ACTIVE=true
  fi
  printf '面板能写的 %s 里有旧版记录的名字：先停下面板和它账号的所有进程，再处理它们。\n' "${PANEL_STATE_DIRECTORY}"
  PANEL_STOPPED_EARLY=true
  trap on_installer_exit EXIT
  stop_panel_helper
  systemctl stop kixdns-panel.service 2>/dev/null || true
  stop_panel_processes refuse_with_panel_held
}

# R2：面板停下之前先停 helper：面板停下时还能请它以 root 起在线更新，那次运行会在这次中途重启面板。记下它原来在不在运行。
# R2: stop the helper before the panel: while stopping, the panel could still ask it to start an online update as root,
# and that run would restart the panel half way through this one. Whether it was running is recorded.
stop_panel_helper() {
  if systemctl is-active --quiet kixdns-panel-helper.service 2>/dev/null; then
    HELPER_WAS_ACTIVE=true
  fi
  # 面板的 unit Requires= helper：照常停 helper，systemd 会先把面板停掉，面板停下时 helper 还在，还能替它做事。所以只停 helper 本身
  # The panel's unit Requires= the helper: a plain stop of the helper has systemd stop the panel first, with the helper
  # still there to act for it while it stops. So the helper alone is stopped
  systemctl stop --job-mode=ignore-dependencies kixdns-panel-helper.service 2>/dev/null || true
}

# 开头为了记录停下面板，在真的开始安装之前就退出时：照原样重启 helper 和面板；照记录停下的（refuse_with_panel_held）不重启。
# The panel stopped at the start for the records, and the run ends before the install really starts: the helper and the
# panel are restarted as they were; not after a stop over a record (refuse_with_panel_held).
restart_panel_after_early_stop() {
  # 回滚真的开始以后由回滚管重启 / Once the rollback has really started, restarting is the rollback's business
  [[ ${ROLLBACK_STARTED} == false && ${PANEL_STOPPED_EARLY} == true && ${KEEP_PANEL_STOPPED} == false ]] || return 0
  [[ ${HELPER_WAS_ACTIVE} == false ]] || systemctl start kixdns-panel-helper.service 2>/dev/null || true
  [[ ${PANEL_WAS_ACTIVE} == false ]] || systemctl start kixdns-panel.service 2>/dev/null || true
}

# 面板这时是为了记录停着的：还没真的开始安装 / The panel is stopped for the records right now: the install has not really
# started
panel_held_for_records() {
  [[ ${PANEL_STOPPED_EARLY} == true && ${ROOT_WORK_STARTED} == false && ${ROLLBACK_STARTED} == false ]]
}

# SHOULD 3：安装器退出时都走这里（EXIT）。回滚已经挂上、安装已经开始、回滚却没真的开始（信号落在挂陷阱的空档里，或者 bash 5.2
# 在解析多行的命令替换时收到信号，INT/TERM 的陷阱没能跑起来）：在这里回滚。还没开始安装：删掉准备回滚时建的备份目录，照原样重启
# 开头停下的 helper 和面板。回滚开始以后什么也不做。
# SHOULD 3: every exit of the installer comes here (EXIT). With rollback armed and the install started but the rollback not
# really started (a signal landing in the gap while traps were set, or bash 5.2 receiving a signal while parsing a
# multi-line command substitution, so the INT/TERM trap never ran): roll back here. With the install not started yet:
# remove the backup directory made to prepare the rollback, and restart the helper and the panel stopped at the start as
# they were. Once the rollback has started, nothing.
on_installer_exit() {
  local status=$?
  [[ ${ROLLBACK_STARTED} == false ]] || return 0
  if [[ ${ROOT_WORK_STARTED} == true && -n ${ROLLBACK_SHELL} && ${BASHPID} == "${ROLLBACK_SHELL}" ]]; then
    [[ ${status} != 0 ]] || status=1
    rollback_install "${status}" interrupted "${ROLLBACK_SHELL}"
  fi
  if [[ -n ${BACKUP_ROOT} && ${BACKUP_ROOT} == /var/tmp/kixdns-panel-install.* ]]; then
    rm -rf -- "${BACKUP_ROOT}"
  fi
  restart_panel_after_early_stop
}

# 主机上已有的 KixDNS 是上次卸载时保留下来的面板自带的那个：它跑的是面板状态目录里的程序。这不是外部安装，没有要迁移的。
# The KixDNS already on the host is the panel's own, kept by an earlier uninstall: it runs the program in the panel's state
# directory. That is no external install and there is nothing to migrate.
existing_kixdns_is_panels_own() {
  [[ ${EXISTING_KIXDNS} == true && ${KIXDNS_BINARY_PATH} == "${MANAGED_KIXDNS_BINARY}" ]]
}

# 迁移前原来的 KixDNS 的备份；和 uninstall.sh 的同名函数一样，以前重装时备份的面板自带 KixDNS 不算。
# The backup of the KixDNS from before migration; as in uninstall.sh's function of the same name, one an older reinstall made
# of the panel's own KixDNS does not count.
external_backup_present() {
  trusted_record external-backup || return 1
  [[ $(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_BINARY || true) != "${MANAGED_KIXDNS_BINARY}" ]]
}

choose_install_mode() {
  if [[ ${INSTALL_MODE} == "auto" ]] && { [[ ${EXISTING_KIXDNS} == false ]] || existing_kixdns_is_panels_own; }; then
    INSTALL_MODE="managed"
    return 0
  fi
  [[ ${INSTALL_MODE} == "auto" ]] || return 0
  # 裸 exec 上的重定向会永久生效：写成 `exec 3<>/dev/tty 2>/dev/null` 会让之后所有错误和回滚信息消失。
  # A redirection on a bare exec is permanent: `exec 3<>/dev/tty 2>/dev/null` would hide every later error and rollback message.
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    fail "$(unattended_migration_message)"
  fi
  print_migration_plan >&3
  if ask_yes_no "迁移为增强版？"; then
    exec 3>&-
    INSTALL_MODE="managed"
    return 0
  fi
  exec 3>&-
  cancel_install
}

determine_install_kind() {
  if [[ ${PANEL_ONLY_UPDATE} == true ]]; then
    INSTALL_KIND=panel-only
  elif [[ ${EXISTING_PANEL} == true ]]; then
    INSTALL_KIND=upgrade
  elif existing_kixdns_is_panels_own; then
    # 接回上次卸载时保留的面板自带 KixDNS：不备份、不复制配置，接着原地管理 / Taking back the panel's own KixDNS kept by
    # an earlier uninstall: no backup, no config copy, managed in place as before
    INSTALL_KIND=reclaim
  elif [[ ${EXISTING_KIXDNS} == true ]]; then
    INSTALL_KIND=migrate
  else
    INSTALL_KIND=fresh
  fi
  # 只有全新安装让 KixDNS 保持停止、不开机自启；别的都保持原来的状态。仅更新面板一般不动 KixDNS，可升级时换了配置位置
  # （CONFIG_CONVERSION），unit 要改指新的配置、按原状态重启。
  # Only a fresh install leaves KixDNS stopped and not enabled at boot; every other kind keeps its state. A panel-only update
  # normally leaves KixDNS alone, but when the config moves on upgrade (CONFIG_CONVERSION) the unit is re-pointed at it and
  # restarted as it was.
  if [[ ${INSTALL_KIND} != fresh ]]; then
    PRESERVE_KIXDNS_STATE=true
  fi
}

# 接回面板自带的 KixDNS 前说明会怎样：不用问，它本来就是面板的。/ Before taking back the panel's own KixDNS, say what happens:
# there is nothing to ask, it was the panel's all along.
print_reclaim_plan() {
  if [[ ${EXISTING_KIXDNS_UNIT} == true ]]; then
    printf '检测到上次卸载时保留的 KixDNS（%s，%s），接着由面板管理。\n' "${KIXDNS_SERVICE_UNIT}" "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
  else
    printf '检测到上次卸载时保留的 KixDNS 程序，接着由面板管理。\n'
  fi
  print_reclaim_backup_note
}

print_reclaim_backup_note() {
  if external_backup_present; then
    printf '迁移前原来的 KixDNS 的备份还在 %s，以后卸载时选择移除增强版即可恢复。\n' "${EXTERNAL_BACKUP}"
  else
    printf '它是面板自己装的，这次不另做备份；以后卸载时选择移除 KixDNS，会把它删掉。\n'
  fi
}

# 上次卸载恢复原来的 KixDNS 没做完（uninstall.sh 的 restore_incomplete 标了记号），备份是有意留着、等重跑卸载接着恢复的。这时
# 安装不能把它当成过期备份换掉：新的备份记的会是恢复到一半的样子，迁移前的状态就丢了。在改动主机之前拒绝。
# An earlier uninstall did not finish restoring the original KixDNS (uninstall.sh's restore_incomplete left its mark), and the
# backup was kept on purpose for a rerun to carry the restore on. Installing must not replace it as stale: the new backup
# would record the half-restored state and the pre-migration one would be lost. Refuse before the host is touched.
refuse_unfinished_restore() {
  local marker=${EXTERNAL_BACKUP}/restore-incomplete
  local options
  local unit
  trusted_record external-backup || return 0
  [[ -f ${marker} ]] || return 0
  options="$(head -n 1 -- "${marker}")"
  [[ ${options} =~ ^--(keep|remove)-config$ ]] || options=--keep-config
  # 要查的是备份记下的原来的 unit（只放进提示里，只要字符安全）/ The unit to look into is the original one the backup
  # records (it only goes into the message, so safe characters are enough)
  unit="$(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_SERVICE_UNIT || true)"
  [[ -n ${unit} && ${unit} != *[!A-Za-z0-9:_.@-]* ]] || unit=${KIXDNS_SERVICE_UNIT}
  fail "上次卸载没有把原来的 KixDNS 恢复完，迁移前的备份还在 ${EXTERNAL_BACKUP}。先查明原因（journalctl -u ${unit} -n 50 --no-pager），再用同样的选项重新运行卸载，恢复做完以后再安装：
  curl -fsSL ${UNINSTALL_URL} | sudo bash -s -- --remove-kixdns ${options} --yes
不再恢复原来的 KixDNS 的话，删掉这份备份再安装：sudo rm -rf ${EXTERNAL_BACKUP}"
}

validate_install_mode() {
  local config_parent
  validate_unit
  validate_absolute_path "KixDNS 配置路径" "${KIXDNS_CONFIG_PATH}"
  validate_absolute_path "KixDNS 二进制路径" "${KIXDNS_BINARY_PATH}"
  validate_absolute_path "KixDNS 控制 Socket 路径" "${KIXDNS_CONTROL_SOCKET}"
  validate_absolute_path "面板服务控制 helper Socket" "${KIXDNS_SERVICE_HELPER_SOCKET}"
  [[ $(dirname -- "${KIXDNS_SERVICE_HELPER_SOCKET}") == /run/kixdns-panel ]] ||
    fail "面板服务控制 helper Socket 必须位于 /run/kixdns-panel"
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  [[ ${config_parent} != / && ! -L ${config_parent} ]] ||
    fail "KixDNS 配置不能直接位于根目录或符号链接目录"
  if [[ -e ${KIXDNS_CONFIG_PATH} || -L ${KIXDNS_CONFIG_PATH} ]]; then
    [[ -f ${KIXDNS_CONFIG_PATH} && ! -L ${KIXDNS_CONFIG_PATH} ]] ||
      fail "受管 KixDNS 配置必须是普通文件"
  fi
  EXISTING_KIXDNS_BINARY_PATH=${KIXDNS_BINARY_PATH}
  KIXDNS_BINARY_PATH=${MANAGED_KIXDNS_BINARY}
  plan_migrated_config
  plan_config_conversion
}

# 面板在配置目录里写的文件：配置本身，和面板写到一半留下的临时文件（.kixdns-panel- 加 6 个字母或数字，见 panel-server 的
# temporaries.rs）。参数：文件名，配置的文件名。和 uninstall.sh 的同名函数一字不差（scripts/test-uninstall-policy.sh 校对）。
# The files the panel writes in the config directory: the config itself, and the temporary files a write cut short leaves
# (.kixdns-panel- and 6 letters or digits, see panel-server's temporaries.rs). Arguments: the file name, the config's name.
# Identical to uninstall.sh's function of the same name (checked by scripts/test-uninstall-policy.sh).
panel_written_config_file() {
  [[ $1 == "$2" || $1 =~ ^\.kixdns-panel-[A-Za-z0-9]{6}$ ]]
}

# v4.3.4 及更早原地迁移的主机：外部备份在，备份里原配置就是 panel.env 记的这份，也还没记下副本（新的迁移都记）。配置本来就在
# 副本位置的不算，那是原地管理。
# A host migrated in place by v4.3.4 or earlier: the external backup is there, its original config is the very one panel.env
# records, and it has no copy recorded yet (every new migration records one). A config already where the copy goes does not
# count, being managed in place.
legacy_in_place_migration() {
  local recorded
  external_backup_present || return 1
  recorded="$(environment_value KIXDNS_CONFIG || true)"
  [[ -n ${recorded} && ${recorded} != "${MIGRATED_KIXDNS_CONFIG}" ]] || return 1
  [[ $(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_CONFIG || true) == "${recorded}" ]] || return 1
  [[ -z $(state_file_value "${EXTERNAL_BACKUP}/install.env" KIXDNS_MANAGED_CONFIG || true) ]]
}

# 记下的配置所在的目录还放着配置以外的东西：#288 以前全新安装可以把配置放进 /etc 这样的公共目录。面板固定的 /etc/kixdns 和副本
# 的目录不算，面板写到一半的临时文件也不算。
# The recorded config's directory holds more than the config: before #288 a fresh install could put the config in a shared
# directory such as /etc. The panel's fixed /etc/kixdns and the copy's directory do not count, nor do temporary files the
# panel was half way through writing.
shared_config_directory() {
  local directory
  directory="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  [[ ${directory} != "${KIXDNS_CONFIG_DIRECTORY}" && ${directory} != "${MIGRATED_KIXDNS_CONFIG_DIRECTORY}" &&
    -d ${directory} && ! -L ${directory} ]] || return 1
  [[ -n "$(other_file_in "${directory}" "${KIXDNS_CONFIG_PATH##*/}")" ]]
}

# 目录里第一个不是面板写的东西（见 panel_written_config_file），没有时什么也不输出。参数：目录，配置的文件名。
# The first thing in the directory the panel did not write (see panel_written_config_file); nothing when there is none.
# Arguments: the directory, the config's file name.
other_file_in() {
  local name
  while IFS= read -r -d '' name; do
    if ! panel_written_config_file "${name}" "$2"; then
      printf '%s\n' "$1/${name}"
      return 0
    fi
  done < <(find "$1" -mindepth 1 -maxdepth 1 -printf '%f\0' 2>/dev/null)
}

# 升级时面板不该再写的配置目录：在改动主机之前定下怎么换、记下要改的属主和权限原来的样子（见 CONFIG_CONVERSION）。
# On upgrade, a config directory the panel should no longer write: decide how it moves and record how the owners and modes to
# change were before, all before the host is touched (see CONFIG_CONVERSION).
plan_config_conversion() {
  local directory
  local target=${KIXDNS_CONFIG_DIRECTORY}/pipeline.json
  # 升级、仅更新面板，以及接回卸载时保留的面板自带 KixDNS：它跑的配置也可能是旧版交给面板的那份
  # Upgrades, panel-only updates, and taking back the panel's own KixDNS kept by an uninstall: the config it runs may be the
  # one an older version handed to the panel too
  [[ ${EXISTING_PANEL} == true || ${INSTALL_KIND} == reclaim ]] || return 0
  directory="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  if legacy_in_place_migration; then
    # install -d 会顺着符号链接改目标的属主和权限 / install -d would change the owner and mode of a symlink's target
    [[ ! -L ${PANEL_CONFIG_DIRECTORY} && ! -L ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} ]] ||
      fail "${PANEL_CONFIG_DIRECTORY} 和 ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} 不能是符号链接"
    CONFIG_CONVERSION=legacy
    ORIGINAL_KIXDNS_CONFIG_PATH=${KIXDNS_CONFIG_PATH}
    KIXDNS_CONFIG_PATH=${MIGRATED_KIXDNS_CONFIG}
    CONVERSION_BEFORE=("${directory}|$(owner_and_mode "${directory}")")
    if [[ -f ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
      CONVERSION_BEFORE+=("${ORIGINAL_KIXDNS_CONFIG_PATH}|$(owner_and_mode "${ORIGINAL_KIXDNS_CONFIG_PATH}")")
    fi
  elif ! external_backup_present && shared_config_directory; then
    [[ ! -L ${KIXDNS_CONFIG_DIRECTORY} ]] || fail "${KIXDNS_CONFIG_DIRECTORY} 不能是符号链接"
    [[ ! -e ${target} && ! -L ${target} ]] ||
      fail "KixDNS 配置在 ${directory} 里，这个目录还放着别的文件，不能再交给面板写。安装器要把配置挪到 ${target}，可那里已经有文件。
先把 ${target} 移走再重新运行；现有安装未作修改。"
    CONFIG_CONVERSION=shared
    ORIGINAL_KIXDNS_CONFIG_PATH=${KIXDNS_CONFIG_PATH}
    KIXDNS_CONFIG_PATH=${target}
    CONVERSION_BEFORE=("${directory}|$(owner_and_mode "${directory}")")
  fi
}

# 下面这几个函数和 uninstall.sh 的同名函数一字不差（scripts/test-uninstall-policy.sh 校对）：卸载器单独分发，不能 source 安装器。
# The functions below are identical to uninstall.sh's of the same names (checked by scripts/test-uninstall-policy.sh): the
# uninstaller ships on its own and cannot source the installer.

# 这个路径还归面板账号，或者已经归了一个没有账号的 UID（旧版卸载器删掉面板账号以后留下的）。
# The path still belongs to the panel account, or already to a UID with no account (left once an older uninstaller removed
# the panel account).
panel_owned() {
  local owner
  owner="$(stat -c '%U' -- "$1" 2>/dev/null)" || return 1
  [[ ${owner} == kixdns-panel || ${owner} == UNKNOWN ]]
}

# 把一个面板用过、现在要交还的目录改归 root:root、权限 0755。面板自己的目录（面板配置目录、状态目录和它们下面的）不交还；
# 已经不归面板的（比如管理员自己改回 root 的）照原样留着，不改成 0755。
# Hands a directory the panel used back to root:root with mode 0755. The panel's own directories (its config and state
# directories and what lies below them) are not handed back; one no longer the panel's (one the admin gave back to root
# himself, say) is left as it is, not made 0755.
hand_back_directory() {
  local directory=$1
  case ${directory} in
    "${PANEL_CONFIG_DIRECTORY}" | "${PANEL_CONFIG_DIRECTORY}"/* | "${PANEL_STATE_DIRECTORY}" | "${PANEL_STATE_DIRECTORY}"/*) return 0 ;;
  esac
  [[ -d ${directory} && ! -L ${directory} ]] || return 0
  panel_owned "${directory}" || return 0
  chown -h root:root -- "${directory}"
  chmod 0755 -- "${directory}"
}

# unit 文件（主文件和它的 drop-in，按 systemd 的顺序给）里 [Service] 的一项，最后写的算数。
# A [Service] setting of a unit (the main file and its drop-ins, in systemd's order), the last one written winning.
unit_service_setting() {
  local key=$1
  shift
  AWK_KEY="${key}" awk 'BEGIN { key = ENVIRON["AWK_KEY"] }
    FNR == 1 { section = "" }
    /^[[:space:]]*\[/ { section = $0; gsub(/[[:space:]]/, "", section); next }
    section == "[Service]" && $0 ~ ("^[[:space:]]*" key "[[:space:]]*=") {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
    }
    END { print value }
  ' "$@"
}

# 原配置交还以后的属组和权限，输出「组 权限」。原来的 KixDNS 以 root 运行：只留给 root（0600）；以别的账号运行：给它运行用的组读
# （Group=，没写就是账号的主组，0640）；看不出来（没有备份的 unit、DynamicUser、写着说明符、账号或组不存在）：谁都能读（0644）。
# The group and mode the original config gets back, printed as "group mode". The original KixDNS ran as root: root alone
# (0600); as another account: readable by the group it ran as (Group=, or else the account's primary group, 0640); when it
# cannot be told (no unit backed up, DynamicUser, specifiers, a missing account or group): readable by anyone (0644).
original_config_access() {
  local files=()
  local file
  local user
  local group
  local dynamic
  for file in "$@"; do
    [[ ! -f ${file} ]] || files+=("${file}")
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    printf 'root 0644\n'
    return 0
  fi
  user="$(unit_service_setting User "${files[@]}")"
  group="$(unit_service_setting Group "${files[@]}")"
  dynamic="$(unit_service_setting DynamicUser "${files[@]}")"
  case ${dynamic,,} in
    1 | yes | true | on)
      printf 'root 0644\n'
      return 0
      ;;
  esac
  if [[ ${user} == *%* || ${group} == *%* ]]; then
    printf 'root 0644\n'
  elif [[ -z ${user} || ${user} == root || ${user} == 0 ]]; then
    printf 'root 0600\n'
  elif [[ -n ${group} ]]; then
    if getent group "${group}" >/dev/null 2>&1; then
      printf '%s 0640\n' "${group}"
    else
      printf 'root 0644\n'
    fi
  else
    group="$(getent passwd "${user}" 2>/dev/null | cut -d: -f4 || true)"
    if [[ -n ${group} ]]; then
      printf '%s 0640\n' "${group}"
    else
      printf 'root 0644\n'
    fi
  fi
}

# 原来的 KixDNS 的 unit 文件（主文件和 drop-in，按 systemd 用它们的顺序），给 original_config_access 定交还的组和权限。迁移时
# 备份的（unit-fragment 和 unit-dropin-N.conf，新的迁移都备份）最准；旧版的备份只有 /etc/systemd/system 里的主文件，unit 在别处时
# 连它也没有（service-file-missing），这时按名字在 systemd 的搜索路径上找：主文件跳过 /etc/systemd/system（那里现在是面板的
# unit），drop-in 各目录里同名的只算排在前面的那个，按文件名排序。参数：备份目录，unit 名。
# The original KixDNS's unit files (the main file and the drop-ins, in the order systemd applies them), which decide the
# group and mode handed back through original_config_access. What migration backed up (unit-fragment and
# unit-dropin-N.conf, backed up by every new migration) is exact; older backups hold only the main file from
# /etc/systemd/system, or not even that when the unit lived elsewhere (service-file-missing), and then the files are
# found by name on the systemd search path: the main file skipping /etc/systemd/system (the panel's unit is there now),
# and of drop-ins of the same name only the one in the earlier directory counts, ordered by file name. Arguments: the
# backup directory, the unit name.
original_unit_files() {
  local backup=$1
  local unit=$2
  local directory
  local file
  local name
  local -A dropins=()
  if [[ -f ${backup}/unit-fragment ]]; then
    printf '%s\n' "${backup}/unit-fragment"
    find "${backup}" -maxdepth 1 -name 'unit-dropin-*.conf' -printf '%f\n' | sort -t- -k3 -n |
      while IFS= read -r file; do printf '%s/%s\n' "${backup}" "${file}"; done
    return 0
  fi
  if [[ -f ${backup}/kixdns.service ]]; then
    printf '%s\n' "${backup}/kixdns.service"
  else
    for directory in "${SYSTEMD_VENDOR_DIRECTORIES[@]}"; do
      if [[ -f ${directory}/${unit} ]]; then
        printf '%s\n' "${directory}/${unit}"
        break
      fi
    done
  fi
  for directory in "${SYSTEMD_UNIT_DIRECTORY}" "${SYSTEMD_VENDOR_DIRECTORIES[@]}"; do
    for file in "${directory}/${unit}.d"/*.conf; do
      [[ -f ${file} ]] || continue
      name=${file##*/}
      [[ -n ${dropins[${name}]:-} ]] || dropins[${name}]=${file}
    done
  done
  for name in "${!dropins[@]}"; do
    printf '%s\t%s\n' "${name}" "${dropins[${name}]}"
  done | sort | cut -f2-
}

# 把旧版原地迁移交给面板的原配置和它所在的目录交还给原来的 KixDNS：目录 root:root 0755，文件按 original_config_access。旧版的
# 备份没记下原来的属主和权限，只能这样定。参数：原配置，原来的 unit 的文件（主文件和 drop-in）。
# Hands the original config an older in-place migration gave the panel, and its directory, back to the original KixDNS: the
# directory root:root 0755, the file as original_config_access says. The older backup never recorded the original owner and
# mode, so this is all there is to go on. Arguments: the original config, the files of the original unit (main and drop-ins).
hand_back_original_config() {
  local config=$1
  local group
  local mode
  shift
  hand_back_directory "$(dirname -- "${config}")"
  # 只改面板目录里真的那个文件：符号链接、硬链接到别处的都不碰，改了就改到别处去了 / Only the real file is changed: a symlink
  # or a file hard-linked from elsewhere is left alone, as changing it would change something else
  [[ -f ${config} && ! -L ${config} && $(stat -c '%h' -- "${config}") == 1 ]] || return 0
  read -r group mode < <(original_config_access "$@")
  chown -h "root:${group}" -- "${config}"
  chmod "${mode}" -- "${config}"
}

# 面板原子写配置（同一目录里写临时文件再改名），所以 install_configuration 把配置所在的目录交给它：改归 kixdns-panel、
# 权限 0750，面板 unit 的 ReadWritePaths 放开它。安装器不改、也不让面板写它没建的目录，所以这个目录只能是：panel.env 记下的、
# 或者主机上已有 KixDNS 的 unit 写着的配置所在的目录（以前就交给了面板，照旧；旧版原地迁移交出去的公共目录，validate_install_mode
# 已经换走了，见 plan_config_conversion）；还不存在、由安装器新建的目录；面板固定的 /etc/kixdns 和迁移副本的目录。除了记录里的，
# 放着 panel.env 的面板配置目录即使还不存在也不行：面板能改 panel.env，下次以 root 运行的安装器就会照着它改别的目录。要在
# validate_install_mode 之后、改动主机之前调用：迁移时检查的是副本，不是原配置。
# The panel writes its config atomically (a temporary file in the same directory, then a rename), so install_configuration
# hands it the config's directory: owner kixdns-panel, mode 0750, opened by the panel unit's ReadWritePaths. The installer
# neither changes nor opens for the panel a directory it did not create, so that directory may only be: the directory of
# the config panel.env records or the existing KixDNS's unit names (handed to the panel before and kept as it is; a shared
# directory an older in-place migration gave away has been moved off by validate_install_mode, see plan_config_conversion);
# one that does not exist yet, which the installer creates; the panel's fixed /etc/kixdns or the migration copy's directory.
# Unless recorded, the panel's config directory, which holds panel.env, does not qualify even before it exists: a panel that
# could rewrite panel.env would steer the next installer run, as root, onto other directories. Call it after
# validate_install_mode and before the host is touched: on migration the copy is checked, not the original.
require_dedicated_config_directory() {
  local config_parent
  local recorded
  local reason
  local other
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  for recorded in "$(environment_value KIXDNS_CONFIG || true)" "${KIXDNS_UNIT_CONFIG_PATH}"; do
    [[ -z ${recorded} || $(dirname -- "${recorded}") != "${config_parent}" ]] || return 0
  done
  if [[ ${config_parent} == "${PANEL_CONFIG_DIRECTORY}" ]]; then
    reason="这里的 panel.env 只能由 root 修改"
  elif [[ ${config_parent} == "${KIXDNS_CONFIG_DIRECTORY}" && ! -L ${config_parent} ]]; then
    # 面板固定的 /etc/kixdns：里面只有这份配置（和面板写到一半的临时文件）时才交给面板，放着别的东西就和别的目录一样不交
    # The panel's fixed /etc/kixdns: handed to the panel only while it holds this config alone (and panel temporaries);
    # holding anything else, it is not handed over, like any other directory
    other="$(other_file_in "${config_parent}" "${KIXDNS_CONFIG_PATH##*/}")"
    [[ -n ${other} ]] || return 0
    fail "KixDNS 配置要放在 ${config_parent}，面板要能写这个目录，可里面还放着别的文件（${other}）。先把它们移走再重新运行。"
  elif [[ ! -e ${config_parent} || ${config_parent} == "${MIGRATED_KIXDNS_CONFIG_DIRECTORY}" ]]; then
    return 0
  else
    reason="这个目录已经存在，安装器不会把它交给面板"
  fi
  fail "KixDNS 配置不能放在 ${config_parent}：面板要能写配置所在的目录，而${reason}。
换一个还不存在的目录，或者去掉 --kixdns-config，用默认的 ${KIXDNS_CONFIG_DIRECTORY}/pipeline.json；要沿用已有的配置，先把它复制过去。"
}

# 外部 KixDNS 迁移时面板改管原配置的副本。面板自己留下的 KixDNS（上次卸载时保留的）不是外部安装，配置本来就归面板；
# 配置已经在副本的位置时也一样，照旧原地管理。
# Migrating an external KixDNS, the panel manages a copy of the original config. The panel's own KixDNS kept by an
# earlier uninstall is no external install and its config is the panel's already; so is a config already where the copy
# goes. Both stay managed in place.
config_copied_on_migration() {
  local binary=$1
  [[ ${binary} != "${MANAGED_KIXDNS_BINARY}" && ${KIXDNS_CONFIG_PATH} != "${MIGRATED_KIXDNS_CONFIG}" ]]
}

plan_migrated_config() {
  [[ ${INSTALL_KIND} == migrate ]] || return 0
  config_copied_on_migration "${EXISTING_KIXDNS_BINARY_PATH}" || return 0
  # install -d 会顺着符号链接改目标的属主和权限 / install -d would change the owner and mode of a symlink's target
  [[ ! -L ${PANEL_CONFIG_DIRECTORY} && ! -L ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} ]] ||
    fail "${PANEL_CONFIG_DIRECTORY} 和 ${MIGRATED_KIXDNS_CONFIG_DIRECTORY} 不能是符号链接"
  ORIGINAL_KIXDNS_CONFIG_PATH=${KIXDNS_CONFIG_PATH}
  KIXDNS_CONFIG_PATH=${MIGRATED_KIXDNS_CONFIG}
  require_original_files_readable
}

# 原配置里写的文件：以 / 开头、存在又不是目录的 JSON 字符串。KixDNS 只读文件；写着却不存在的文件，原来的 KixDNS
# 一样跳过。带转义的字符串不算，路径里没有。
# The files the original config names: JSON strings starting with / that exist and are not directories. KixDNS reads
# files only, and a named file that does not exist is skipped by the original KixDNS too. Strings with escapes do not
# count; paths have none.
original_config_files() {
  local path
  grep -oE '"/[^"\\]*"' -- "${ORIGINAL_KIXDNS_CONFIG_PATH}" 2>/dev/null | sed -e 's/^"//' -e 's/"$//' | sort -u |
    while IFS= read -r path; do
      if [[ -e ${path} && ! -d ${path} ]]; then
        printf '%s\n' "${path}"
      fi
    done
}

# 原配置里写的、面板自己也读的 Geo 文件：settings 里 geosite_data_paths 的每一项，和 geoip_db_path、geoip_dat_path（面板挑
# GeoSite 分类、给 IP 标地区时读，见 panel-server 的 app/geo.rs）。和 original_config_files 一样只算存在又不是目录的绝对路径。
# The Geo files the original config names that the panel reads too: each entry of geosite_data_paths in settings, and
# geoip_db_path and geoip_dat_path (read when picking GeoSite categories and labelling IP regions, see panel-server's
# app/geo.rs). As in original_config_files, only absolute paths that exist and are not directories count.
original_config_geo_files() {
  local flattened
  local path
  flattened="$(tr '\n' ' ' < "${ORIGINAL_KIXDNS_CONFIG_PATH}" 2>/dev/null || true)"
  {
    grep -oE '"geosite_data_paths"[[:space:]]*:[[:space:]]*\[[^]]*\]' <<< "${flattened}" || true
    grep -oE '"geoip_(db|dat)_path"[[:space:]]*:[[:space:]]*"[^"\\]*"' <<< "${flattened}" || true
  } | { grep -oE '"/[^"\\]*"' || true; } | sed -e 's/^"//' -e 's/"$//' | sort -u |
    while IFS= read -r path; do
      if [[ -e ${path} && ! -d ${path} ]]; then
        printf '%s\n' "${path}"
      fi
    done
}

# 以一个服务账号的身份（主组 kixdns）试读一个文件。账号还没建时用 nobody 的 UID 代替：新建的账号同样不拥有任何文件。
# 组还没建时用 nogroup 的 GID，同理。
# Try reading a file as a service account would (its primary group kixdns). Before the account exists, nobody's UID stands
# in for it: a new account owns no files either. Likewise nogroup's GID before the group exists.
account_can_read() {
  local account=$1
  local file=$2
  local group
  group="$(getent group "${KIXDNS_GROUP}" | cut -d: -f3 || true)"
  if id -u "${account}" >/dev/null 2>&1; then
    setpriv --reuid="${account}" --regid="${group:-65534}" --init-groups -- test -r "${file}"
  else
    setpriv --reuid=65534 --regid="${group:-65534}" --clear-groups -- test -r "${file}"
  fi
}

# 受管 KixDNS（kixdns 账号）读不读得到 / Whether the managed KixDNS (the kixdns account) can read it
kixdns_can_read() {
  account_can_read "${KIXDNS_USER}" "$1"
}

# 面板（kixdns-panel 账号，主组同样是 kixdns）读不读得到 / Whether the panel (the kixdns-panel account, whose primary group
# is kixdns too) can read it
panel_can_read() {
  account_can_read "${PANEL_USER}" "$1"
}

# 迁移后 KixDNS 读的是副本，原配置所在的目录不再为它放开（以前原地接管时会归到 kixdns 组）。原配置里写的文件它读不到时，
# 在改动主机之前停下，点名每个文件和原因；否则装好以后分流少了 GeoSite、DoH 证书读不到，原因却不在眼前。
# After migration KixDNS reads the copy, and the original config's directory is no longer opened for it (the in-place
# takeover used to hand it to the kixdns group). When it cannot read a file the original config names, stop before the
# host is touched and name each file and why; otherwise routing would lose its GeoSite or DoH its certificate after the
# install, with the cause nowhere in sight.
require_original_files_readable() {
  local files
  local file
  local directory
  local reason
  local unreadable=""
  files="$(original_config_files || true)"
  [[ -n ${files} ]] || return 0
  type -P setpriv >/dev/null ||
    fail "系统缺少 setpriv（util-linux），无法确认迁移后的 KixDNS 能读到原配置里写的文件"
  while IFS= read -r file; do
    reason=""
    for directory in "${KIXDNS_HIDDEN_DIRECTORIES[@]}"; do
      if [[ ${file} == "${directory}"/* ]]; then
        reason="KixDNS 的服务看不到 ${directory} 里的文件"
        break
      fi
    done
    if [[ -z ${reason} ]] && ! kixdns_can_read "${file}"; then
      reason="kixdns 账号没有读取权限"
    fi
    [[ -z ${reason} ]] || unreadable+="  ${file}：${reason}"$'\n'
  done <<< "${files}"
  [[ -z ${unreadable} ]] || fail "迁移后的 KixDNS 以 kixdns 账号运行，读不到原配置 ${ORIGINAL_KIXDNS_CONFIG_PATH} 里写的这些文件：
${unreadable}迁移不会改动原来的文件和目录。让 kixdns 账号能读到它们（放宽权限，或移到别处并改原配置）后重新运行；现有 KixDNS 未作修改。"
  note_panel_unreadable_files
}

# 面板（kixdns-panel 账号）自己也读原配置里写的 Geo 文件。读不到只是面板上挑 GeoSite 分类、给 IP 标地区时缺了它们，DNS 照常，
# 所以不拒绝迁移，记下来在安装结果里点名，好让人去改权限。面板 unit 和 KixDNS 的 unit 藏起同样的目录，上面已经确认这些文件不在
# 里面，面板读不到就只会是权限。
# The panel (the kixdns-panel account) reads the Geo files the original config names too. When it cannot, the panel only
# lacks them for picking GeoSite categories and labelling IP regions while DNS works as before, so migration is not refused:
# the files are noted and named in the install result so the permissions can be fixed. The panel unit hides the same
# directories as the KixDNS unit, and the files were found above to lie outside them, so permissions are the only reason.
note_panel_unreadable_files() {
  local file
  PANEL_UNREADABLE_FILES=""
  while IFS= read -r file; do
    [[ -n ${file} ]] || continue
    panel_can_read "${file}" || PANEL_UNREADABLE_FILES+="  ${file}：kixdns-panel 账号没有读取权限"$'\n'
  done < <(original_config_geo_files || true)
}

# 安装包的 unit，或者仅更新面板时已装的那份（只改配置路径，别的照旧）。/ The package's unit, or the installed one on a
# panel-only update (only the config path changes, the rest stays as it is).
kixdns_unit_template() {
  if [[ ${INSTALL_KIND} == panel-only && -f ${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT} ]]; then
    printf '%s\n' "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}"
  else
    printf '%s\n' "${PACKAGE_ROOT}/deploy/systemd/kixdns.service"
  fi
}

render_kixdns_unit() {
  AWK_CONFIG_PATH="${KIXDNS_CONFIG_PATH}" AWK_CONTROL_SOCKET="${KIXDNS_CONTROL_SOCKET}" awk 'BEGIN {
        config_path = ENVIRON["AWK_CONFIG_PATH"]
        control_socket = ENVIRON["AWK_CONTROL_SOCKET"]
      }
    /^ConditionPathExists=/ { print "ConditionPathExists=" config_path; next }
    /^ExecStart=/ {
      print "ExecStart=/var/lib/kixdns-panel/bin/kixdns run --config " config_path " --admin-socket " control_socket
      next
    }
    { print }
  ' "$(kixdns_unit_template)"
}

file_sha256() {
  sha256sum -- "$1" | awk '{ print $1 }'
}

plan_kixdns_changes() {
  local unit_file=${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}
  KIXDNS_BINARY_CHANGED=false
  KIXDNS_UNIT_CHANGED=false
  KIXDNS_RESTART=false
  # 仅更新面板不换程序；只在升级时换了配置位置（CONFIG_CONVERSION）时改 unit 里的配置路径。
  # A panel-only update never replaces the program; it changes the config path in the unit only when the config moves on
  # upgrade (CONFIG_CONVERSION).
  [[ ${INSTALL_KIND} != panel-only || -n ${CONFIG_CONVERSION} ]] || return 0
  # 同一个 KixDNS 重装时不停服务：DNS 中断只在程序或 unit 真的变了时才值得。
  # Reinstalling the same KixDNS does not stop it: a DNS outage is only worth it when the binary or unit really changed.
  if [[ ${INSTALL_KIND} != panel-only ]] && { [[ ! -f ${MANAGED_KIXDNS_BINARY} ]] ||
    [[ $(file_sha256 "${PACKAGE_ROOT}/bin/kixdns") != "$(file_sha256 "${MANAGED_KIXDNS_BINARY}")" ]]; }; then
    KIXDNS_BINARY_CHANGED=true
  fi
  if [[ ! -f ${unit_file} ]] || [[ $(render_kixdns_unit) != "$(<"${unit_file}")" ]]; then
    KIXDNS_UNIT_CHANGED=true
  fi
  if [[ ${KIXDNS_WAS_ACTIVE} == true && (${KIXDNS_BINARY_CHANGED} == true || ${KIXDNS_UNIT_CHANGED} == true) ]]; then
    KIXDNS_RESTART=true
  fi
}

# 仅更新面板时两个都是 false，除非换了配置位置（plan_kixdns_changes）/ Both are false on a panel-only update unless the config
# moves (plan_kixdns_changes)
kixdns_replaced() {
  [[ ${KIXDNS_BINARY_CHANGED} == true || ${KIXDNS_UNIT_CHANGED} == true ]]
}

# 输出 KixDNS 要监听的「协议 地址」；配置里没写时按上游默认的 0.0.0.0:53。
# Print the "protocol address" pairs KixDNS will listen on; missing settings fall back to upstream's 0.0.0.0:53.
kixdns_listen_addresses() {
  # 迁移的副本要到安装那一步才写出来，在那之前按原配置查 / The migration copy is only written at install time; until then read the original
  local config=${ORIGINAL_KIXDNS_CONFIG_PATH:-${KIXDNS_CONFIG_PATH}}
  local protocol
  local value
  [[ -f ${config} ]] || config=${PACKAGE_ROOT}/deploy/config/pipeline.json
  for protocol in udp tcp; do
    value="$(grep -oE "\"bind_${protocol}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "${config}" 2>/dev/null |
      head -n 1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
    printf '%s %s\n' "${protocol}" "${value:-0.0.0.0:53}"
  done
}

strip_address_host() {
  local host=$1
  host=${host%%\%*}
  host=${host#\[}
  host=${host%\]}
  printf '%s\n' "${host}"
}

addresses_overlap() {
  local wanted=$1
  local held=$2
  case ${wanted} in "" | 0.0.0.0 | :: | \*) return 0 ;; esac
  case ${held} in "" | 0.0.0.0 | :: | \*) return 0 ;; esac
  [[ ${wanted} == "${held}" ]]
}

find_port_conflict() {
  local listeners
  local protocol
  local wanted
  local wanted_host
  local wanted_port
  local netid
  local local_address
  local process
  local held_host
  local name
  local pid
  PORT_CONFLICT=none
  PORT_CONFLICT_PORT=""
  PORT_HOLDER_NAME=""
  PORT_HOLDER_PID=""
  PORT_HOLDER_ADDRESS=""
  command -v ss >/dev/null 2>&1 || return 0
  listeners="$(ss -H -lnptu 2>/dev/null || true)"
  while read -r protocol wanted; do
    wanted_port=${wanted##*:}
    wanted_host="$(strip_address_host "${wanted%:*}")"
    [[ ${wanted_port} =~ ^[0-9]+$ ]] || continue
    while read -r netid _ _ _ local_address _ process; do
      [[ ${netid} == "${protocol}" && ${local_address##*:} == "${wanted_port}" ]] || continue
      held_host="$(strip_address_host "${local_address%:*}")"
      addresses_overlap "${wanted_host}" "${held_host}" || continue
      name=""
      pid=""
      if [[ ${process} =~ \(\(\"([^\"]+)\",pid=([0-9]+) ]]; then
        name=${BASH_REMATCH[1]}
        pid=${BASH_REMATCH[2]}
      fi
      # KixDNS 自己占着端口不算冲突：它正是要被替换或保留的那一个。
      # KixDNS holding the port is no conflict: it is the one being replaced or kept.
      [[ ${name} != kixdns ]] || continue
      # 别的程序优先于 systemd-resolved 报告：只关掉 resolved 解决不了它。
      # Another program outranks systemd-resolved: turning resolved off would not free the port.
      [[ ${PORT_CONFLICT} != other ]] || continue
      PORT_CONFLICT_PORT=${wanted_port}
      PORT_HOLDER_NAME=${name:-未知进程}
      PORT_HOLDER_PID=${pid}
      PORT_HOLDER_ADDRESS=${held_host}
      if [[ ${name} == systemd-resolve* ]]; then
        PORT_CONFLICT=resolved
      else
        PORT_CONFLICT=other
      fi
    done <<< "${listeners}"
  done < <(kixdns_listen_addresses)
}

resolv_conf_uses_stub() {
  if [[ -L ${RESOLV_CONF} ]]; then
    [[ $(readlink -- "${RESOLV_CONF}") == */stub-resolv.conf ]]
  elif [[ -f ${RESOLV_CONF} ]]; then
    grep -qE '^[[:space:]]*nameserver[[:space:]]+127\.0\.0\.53([[:space:]]|$)' "${RESOLV_CONF}"
  else
    return 1
  fi
}

holder_text() {
  printf '%s（PID %s）' "${PORT_HOLDER_NAME}" "${PORT_HOLDER_PID:-未知}"
}

resolved_manual_commands() {
  printf '  sudo mkdir -p %s\n' "$(dirname -- "${RESOLVED_DROPIN}")"
  printf "  printf '[Resolve]\\\\nDNSStubListener=no\\\\n' | sudo tee %s >/dev/null\n" "${RESOLVED_DROPIN}"
  if resolv_conf_uses_stub; then
    printf '  sudo ln -sfn %s %s\n' "${RESOLVED_UPLINK_RESOLV_CONF}" "${RESOLV_CONF}"
  fi
  printf '  sudo systemctl restart systemd-resolved\n'
}

plan_port53() {
  [[ ${INSTALL_KIND} != panel-only ]] || return 0
  find_port_conflict
  if [[ ${PORT_CONFLICT} == resolved ]] && { exec 3<>/dev/tty; } 2>/dev/null; then
    {
      printf '\n端口 %s 被 systemd-resolved 的本机 DNS 缓存（%s）占用，KixDNS 启动时会因此失败。\n' \
        "${PORT_CONFLICT_PORT}" "${PORT_HOLDER_ADDRESS}"
      printf '安装器可以关闭这个监听：\n'
      printf '  - 写入 %s（DNSStubListener=no）\n' "${RESOLVED_DROPIN}"
      if resolv_conf_uses_stub; then
        printf '  - %s 改为指向 %s，本机域名解析照常工作\n' "${RESOLV_CONF}" "${RESOLVED_UPLINK_RESOLV_CONF}"
      fi
      printf '  - 重启 systemd-resolved；卸载时选择移除 KixDNS 会恢复原样\n'
    } >&3
    if ask_yes_no "关闭 systemd-resolved 的 ${PORT_CONFLICT_PORT} 端口监听？"; then
      RESOLVED_ACTION=disable-stub
    else
      printf '保持 systemd-resolved 不变，安装完成后会给出手动处理的命令。\n' >&3
    fi
    exec 3>&-
  fi
  [[ ${PORT_CONFLICT} != none && ${RESOLVED_ACTION} != disable-stub && ${KIXDNS_RESTART} == true ]] || return 0
  # 这次会重启一个原本在运行的 KixDNS，端口不空出来它必然起不来；在改动主机之前就停下。
  # This run restarts a KixDNS that was running; it cannot start without the port, so stop before touching the host.
  if [[ ${PORT_CONFLICT} == resolved ]]; then
    fail "端口 ${PORT_CONFLICT_PORT} 被 systemd-resolved 占用，替换后的 KixDNS 无法启动。
在终端里运行安装器并同意关闭它的监听，或先手动执行：
$(resolved_manual_commands)"
  fi
  fail "端口 ${PORT_CONFLICT_PORT} 被 $(holder_text)占用，替换后的 KixDNS 无法启动；先停用这个程序，或把配置里的 bind_udp/bind_tcp 改到别的端口，然后重新运行。"
}

# glibc 对第一台 DNS 服务器的超时就是 5 秒，丢一个 UDP 包单次查询就会失败；最多试三次，
# 每次 8 秒，任一次成功即可，总共不超过约 26 秒。
# glibc's first-server timeout is 5 s, so one lost UDP packet fails a single lookup; try up to three
# times at 8 s each and accept the first success, about 26 s at most.
name_resolution_works() {
  local attempt
  for ((attempt = 1; attempt <= 3; attempt++)); do
    timeout 8 getent hosts github.com >/dev/null 2>&1 && return 0
    ((attempt == 3)) || sleep 1
  done
  return 1
}

disable_resolved_stub() {
  local resolved_before=false
  local dropin_directory
  local attempt
  [[ ${RESOLVED_ACTION} == disable-stub ]] || return 0
  # 下面重新检测端口会清空冲突信息，先记下是哪个端口。
  # Re-checking the port below clears the conflict details, so remember which port it was.
  RESOLVED_PORT=${PORT_CONFLICT_PORT}
  if name_resolution_works; then
    resolved_before=true
  fi
  dropin_directory="$(dirname -- "${RESOLVED_DROPIN}")"
  ensure_root_records
  # 已经有一份的话先验（R1）：能信就照旧写进去，不能信的挪走、停下 / One already there is checked first (R1): written into as
  # before when it can be trusted, moved away with the run stopped when not
  trusted_record resolved-stub || install -d -o root -g root -m 0700 "${RESOLVED_STATE}"
  # 先记下原样再动手，回滚和卸载都按这份记录恢复。
  # Record the original first; rollback and uninstall both restore from this record.
  {
    if [[ -d ${dropin_directory} ]]; then
      printf 'RESOLVED_DROPIN_DIRECTORY_CREATED=false\n'
    else
      printf 'RESOLVED_DROPIN_DIRECTORY_CREATED=true\n'
    fi
    if ! resolv_conf_uses_stub; then
      printf 'RESOLV_CONF_KIND=unchanged\n'
    elif [[ -L ${RESOLV_CONF} ]]; then
      printf 'RESOLV_CONF_KIND=symlink\n'
      printf 'RESOLV_CONF_TARGET=%s\n' "$(readlink -- "${RESOLV_CONF}")"
    else
      cp -a -- "${RESOLV_CONF}" "${RESOLVED_STATE}/resolv.conf"
      printf 'RESOLV_CONF_KIND=file\n'
    fi
  } > "${RESOLVED_STATE}/install.env"
  chmod 0600 "${RESOLVED_STATE}/install.env"
  RESOLVED_CHANGED=true
  # 已有的目录不改权限（install -d 会改成 0755）/ An existing directory keeps its mode (install -d would make it 0755)
  [[ -d ${dropin_directory} ]] || install -d -o root -g root -m 0755 "${dropin_directory}"
  printf '[Resolve]\nDNSStubListener=no\n' > "${RESOLVED_DROPIN}"
  chmod 0644 "${RESOLVED_DROPIN}"
  if [[ $(state_file_value "${RESOLVED_STATE}/install.env" RESOLV_CONF_KIND) != unchanged ]]; then
    ln -sfn -- "${RESOLVED_UPLINK_RESOLV_CONF}" "${RESOLV_CONF}"
  fi
  systemctl restart systemd-resolved.service
  for ((attempt = 0; attempt < 50; attempt++)); do
    find_port_conflict
    [[ ${PORT_CONFLICT} == resolved ]] || break
    sleep 0.1
  done
  [[ ${PORT_CONFLICT} != resolved ]] ||
    abort_install "关闭监听后端口 ${RESOLVED_PORT} 仍被 systemd-resolved 占用，检查 /etc/systemd/resolved.conf 里的 DNSStubListenerExtra"
  if [[ ${resolved_before} == true ]] && ! name_resolution_works; then
    abort_install "关闭 systemd-resolved 的本机监听后，本机域名解析不可用"
  fi
}

restore_resolved_stub() {
  local state=${RESOLVED_STATE}/install.env
  local kind
  local target
  trusted_record resolved-stub || return 0
  kind="$(state_file_value "${state}" RESOLV_CONF_KIND || true)"
  target="$(state_file_value "${state}" RESOLV_CONF_TARGET || true)"
  rm -f -- "${RESOLVED_DROPIN}"
  if [[ $(state_file_value "${state}" RESOLVED_DROPIN_DIRECTORY_CREATED || true) == true ]]; then
    rmdir -- "$(dirname -- "${RESOLVED_DROPIN}")" 2>/dev/null || true
  fi
  case ${kind} in
    symlink) [[ -z ${target} ]] || ln -sfn -- "${target}" "${RESOLV_CONF}" ;;
    file)
      rm -f -- "${RESOLV_CONF}"
      cp -a -- "${RESOLVED_STATE}/resolv.conf" "${RESOLV_CONF}"
      ;;
  esac
  systemctl restart systemd-resolved.service
  rm -rf -- "${RESOLVED_STATE}"
}

restore_managed_service_state() {
  [[ ${INSTALL_MODE} == "managed" ]] || return 0
  if [[ ${PRESERVE_KIXDNS_STATE} == false ]]; then
    systemctl disable --now "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
    return 0
  fi
  if [[ ${KIXDNS_WAS_ENABLED} == true ]]; then
    systemctl enable "${KIXDNS_SERVICE_UNIT}" --quiet
  else
    systemctl disable "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
  if [[ ${KIXDNS_WAS_ACTIVE} == true ]]; then
    systemctl restart "${KIXDNS_SERVICE_UNIT}"
  else
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true
  fi
}

require_root() {
  [[ ${EUID} -eq 0 ]] || fail "要用 root 权限运行"
}

require_file() {
  [[ -f "$1" ]] || fail "安装包缺少 $1"
}

is_private_ipv4() {
  local address=$1
  awk -F. '
    NF != 4 { exit 1 }
    {
      for (part = 1; part <= 4; part++) {
        if ($part !~ /^[0-9]+$/ || $part < 0 || $part > 255) exit 1
      }
      if ($1 == 10 ||
          ($1 == 172 && $2 >= 16 && $2 <= 31) ||
          ($1 == 192 && $2 == 168) ||
          ($1 == 100 && $2 >= 64 && $2 <= 127)) exit 0
      exit 1
    }
  ' <<< "${address}"
}

detect_private_ipv4() {
  local address
  if command -v ip >/dev/null 2>&1; then
    address="$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (field = 1; field <= NF; field++) if ($field == "src") { print $(field + 1); exit } }')"
    if [[ -n ${address} ]] && is_private_ipv4 "${address}"; then
      printf '%s\n' "${address}"
      return 0
    fi
    while IFS= read -r address; do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done < <(ip -o -4 address show scope global 2>/dev/null | awk '{ split($4, parts, "/"); print parts[1] }')
  fi
  if command -v hostname >/dev/null 2>&1; then
    for address in $(hostname -I 2>/dev/null || true); do
      if is_private_ipv4 "${address}"; then
        printf '%s\n' "${address}"
        return 0
      fi
    done
  fi
  return 1
}

panel_access_url() {
  local bind=$1
  local host
  local port=${bind##*:}
  [[ ${port} =~ ^[0-9]{1,5}$ ]] || port=5738
  case ${bind} in
    0.0.0.0:* | \[::\]:*) host="$(detect_private_ipv4 || true)" ;;
    \[*\]:*) host=${bind%:*} ;;
    *:*) host=${bind%:*} ;;
    *) host="" ;;
  esac
  if [[ -n ${host} ]]; then
    printf 'http://%s:%s\n' "${host}" "${port}"
  else
    printf 'http://<本机内网IP>:%s\n' "${port}"
  fi
}

create_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || groupadd --system "${KIXDNS_GROUP}"
  if ! id -u "${KIXDNS_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${KIXDNS_USER}"
  fi
  if id -u "${PANEL_USER}" >/dev/null 2>&1; then
    usermod --append --groups "${KIXDNS_GROUP}" "${PANEL_USER}"
  else
    useradd --system --gid "${KIXDNS_GROUP}" --home-dir /var/lib/kixdns-panel --shell /usr/sbin/nologin "${PANEL_USER}"
  fi
  if getent group systemd-journal >/dev/null; then
    usermod --append --groups systemd-journal "${PANEL_USER}"
  fi
}

backup_path() {
  local source=$1
  local key=$2
  if [[ -e "${source}" || -L "${source}" ]]; then
    cp -a -- "${source}" "${BACKUP_ROOT}/${key}"
  else
    : > "${BACKUP_ROOT}/${key}.missing"
  fi
}

# 放回备份过的东西：有备份就换回备份，记着「原来没有」就删掉；还没来得及备份（回滚发生在备份之前）就什么也不做。上一级目录只在
# 不存在时才建，已有的目录不改权限：install -d 会把已有目录的权限改成 0755。
# Put back what was backed up: the backup when there is one, nothing when the record says there was nothing; a path not
# backed up yet (rolled back before its backup) is left alone. The parent is created only when missing, and an existing
# directory keeps its mode: install -d would reset an existing directory to 0755.
restore_path() {
  local target=$1
  local key=$2
  local parent
  if [[ -e "${BACKUP_ROOT}/${key}" || -L "${BACKUP_ROOT}/${key}" ]]; then
    rm -rf -- "${target}"
    parent="$(dirname -- "${target}")"
    [[ -d ${parent} ]] || install -d -- "${parent}"
    cp -a -- "${BACKUP_ROOT}/${key}" "${target}"
  elif [[ -e "${BACKUP_ROOT}/${key}.missing" ]]; then
    rm -rf -- "${target}"
  fi
}

# 新面板启动时会把数据库迁移到自己的 schema，而面板拒绝打开比自己新的库（db.rs）。
# 回滚只换回旧程序、留着迁移过的库，旧面板就会一直崩溃重启。所以在面板停下、不再写入之后，
# 连同 WAL 和共享内存文件一起备份；标记文件说明备份已完成，回滚只在它存在时才放回。
# On start the new panel migrates the database to its schema, and the panel refuses a database newer
# than itself (db.rs). A rollback that swaps the binary back but keeps the migrated database leaves the
# old panel crash-looping. So back it up, with its WAL and shared-memory files, once the panel has
# stopped writing; the marker says the backup is complete, and rollback restores only when it exists.
backup_panel_database() {
  backup_path "${PANEL_DATABASE}" panel-database
  backup_path "${PANEL_DATABASE}-wal" panel-database-wal
  backup_path "${PANEL_DATABASE}-shm" panel-database-shm
  : > "${BACKUP_ROOT}/panel-database.saved"
}

restore_panel_database() {
  local file
  [[ -f ${BACKUP_ROOT}/panel-database.saved ]] || return 0
  # 三个文件必须成套放回：留下新面板的 WAL 会被 SQLite 重放到旧库上。
  # The three files go back as a set: a WAL left by the new panel would be replayed onto the old database.
  restore_path "${PANEL_DATABASE}" panel-database
  restore_path "${PANEL_DATABASE}-wal" panel-database-wal
  restore_path "${PANEL_DATABASE}-shm" panel-database-shm
  for file in "${PANEL_DATABASE}" "${PANEL_DATABASE}-wal" "${PANEL_DATABASE}-shm"; do
    [[ -f ${file} && ! -L ${file} ]] || continue
    chown -h "${PANEL_USER}:${KIXDNS_GROUP}" -- "${file}"
    chmod 0600 -- "${file}"
  done
}

rollback_install() {
  local status=$1
  local reason=${2:-failed}
  # -E 让 ERR 陷阱也在子 shell（命令替换、管道）里触发。在子 shell 里回滚会删掉备份，父 shell 收到失败又回滚一次，
  # 这时只剩删除：刚放回的文件被删光。所以只在设下陷阱的那个 shell 里回滚，子 shell 只带着失败退出
  # -E fires the ERR trap inside subshells too (command substitutions, pipelines). A rollback there deleted the backup, and the
  # parent, seeing the failure, rolled back again with only deletion left, removing what was just put back. So only the shell
  # that set the trap rolls back; a subshell just exits with the failure
  [[ -z ${3:-} || ${BASHPID} == "$3" ]] || exit "${status}"
  # 回滚真的开始了：之后的 EXIT 不再插手 / The rollback has really started: EXIT keeps out of it from here
  ROLLBACK_STARTED=true
  local outcome=安装未完成
  local panel_running=true
  local quiesced=true
  local host
  local port
  trap - ERR
  # 回滚途中再按 Ctrl-C 或断线不能半途而废，否则主机停在比中断前更糟的状态。
  # A second Ctrl-C or hangup must not abort the rollback half way and leave the host worse off.
  trap '' INT TERM HUP
  set +e
  # 回滚途中的失败不再回滚 / A failure during the rollback does not roll back again
  ROOT_WORK_STARTED=false
  # R2：先停这次的面板、停光面板账号的所有进程，面板能写的路径上的事全做完，最后才重启旧面板
  # R2: stop this run's panel and every process of the panel account first, finish everything on panel-writable paths, and
  # restart the old panel last
  if [[ ${EXISTING_PANEL} == false ]]; then
    systemctl disable --now kixdns-panel.service kixdns-panel-helper.service 2>/dev/null
  else
    systemctl stop kixdns-panel.service 2>/dev/null
  fi
  stop_panel_processes rollback_cannot_quiesce || quiesced=false
  if kixdns_replaced; then
    systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    [[ ${KIXDNS_UNIT_CHANGED} == false ]] ||
      restore_path "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" kixdns-service
  fi
  if [[ ${quiesced} == true ]]; then
    [[ ${KIXDNS_BINARY_CHANGED} == false ]] || restore_path "${MANAGED_KIXDNS_BINARY}" kixdns
    [[ ${INSTALL_KIND} == panel-only ]] || restore_path /var/lib/kixdns-panel/bundle bundled-metadata
    if [[ ${INSTALL_KIND} != panel-only || -n ${CONFIG_CONVERSION} ]]; then
      restore_managed_config
    fi
    restore_original_config
    restore_panel_database
    restore_path "${PANEL_ENV}" panel-env
    restore_owners
    sweep_new_panel_files
  fi
  restore_path "${PANEL_SERVER_BINARY}" panel-server
  restore_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install" panel-one-click-install
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-online-update" panel-online-update
  restore_path "${PANEL_SHARE_DIRECTORY}/web" web
  restore_path "${PANEL_SHARE_DIRECTORY}/geo" builtin-geo
  restore_path /etc/systemd/system/kixdns-panel.service panel-service
  restore_path "${LIBEXEC_DIRECTORY}/kixdns-panel-helper" panel-helper
  restore_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  restore_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  [[ ${RESOLVED_CHANGED} == false ]] || restore_resolved_stub
  if [[ ${quiesced} == true ]]; then
    remove_new_directories
    remove_new_accounts
  fi
  systemctl daemon-reload
  if [[ ${CREATED_EXTERNAL_BACKUP} == true ]]; then
    # 迁移失败：原 unit 已放回，按迁移前的运行与开机状态恢复。
    # Failed migration: the original unit is back; restore its pre-migration running and boot state.
    if [[ ${KIXDNS_WAS_ENABLED} == true ]]; then
      systemctl enable "${KIXDNS_SERVICE_UNIT}" --quiet
    else
      systemctl disable "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    fi
    if [[ ${KIXDNS_WAS_ACTIVE} == true ]]; then
      systemctl restart "${KIXDNS_SERVICE_UNIT}"
    else
      systemctl stop "${KIXDNS_SERVICE_UNIT}" 2>/dev/null
    fi
    rm -rf -- "${EXTERNAL_BACKUP}"
  elif kixdns_replaced; then
    restore_managed_service_state
  fi
  # 这次迁移换下来的旧备份放回去，主机和安装前一样。看回滚备份里实际有没有它，不看上面的标记：旧备份挪走以后、标记设上以前
  # 被中断时，它只在回滚备份里，跟着回滚备份删掉就没了。
  # The old backup this migration replaced goes back, leaving the host as it was before the install. Whether the rollback
  # backup really holds it decides, not the flag above: interrupted after the old backup moved and before the flag was set,
  # it lives only in the rollback backup and would be deleted with it.
  if [[ -e ${BACKUP_ROOT}/external-backup || -L ${BACKUP_ROOT}/external-backup ]]; then
    rm -rf -- "${EXTERNAL_BACKUP}"
    [[ -d ${ROOT_RECORDS} ]] || install -d -o root -g root -m 0700 "${ROOT_RECORDS}"
    mv -- "${BACKUP_ROOT}/external-backup" "${EXTERNAL_BACKUP}"
  fi
  if [[ ${EXISTING_PANEL} == true ]]; then
    # R2：helper 和旧面板都在最后才重启 / R2: the helper and the old panel restart only at the very end
    systemctl restart kixdns-panel-helper.service 2>/dev/null
    systemctl restart kixdns-panel.service
    # 旧面板可能因为数据库或环境不兼容而起不来；不确认就说「已恢复」会把人引向错误的方向。
    # The old panel may still fail on an incompatible database or environment; claiming "restored"
    # without checking sends the user the wrong way.
    read -r host port < <(panel_probe_address)
    wait_for_service_stable kixdns-panel.service "${host}" "${port}" || panel_running=false
  fi
  rm -rf -- "${BACKUP_ROOT}"
  [[ ${reason} != interrupted ]] || outcome=安装被中断
  if [[ ${quiesced} == false ]]; then
    printf '面板账号还有停不掉的进程，面板目录里的文件、属主和这次建的目录、账号都没有放回或删掉（R2）；停掉那些进程以后重新运行安装器。\n' >&2
  fi
  if [[ ${panel_running} == true ]]; then
    printf '%s，已恢复原有程序和服务。\n' "${outcome}" >&2
  else
    printf '%s，已放回原有程序和数据库，但原面板没有恢复运行。\n查看原因：journalctl -u kixdns-panel.service -n 50 --no-pager\n' \
      "${outcome}" >&2
  fi
  exit "${status}"
}

# 回滚时面板账号的进程停不掉：说一声，面板能写的路径上的事跳过 / The panel account's processes cannot be stopped during the
# rollback: say so, and skip what would touch panel-writable paths
rollback_cannot_quiesce() {
  printf '%s\n' "$*" >&2
  return 1
}

# 这次运行要建的目录还不存在时，把不存在的最上面那一层记下来（install -d 会把上面缺的几层一起建出来）。回滚最后整个删掉它：
# 里面只会有这次运行写的东西，安装器写的，或者刚起来的面板写的，比如写到一半的临时文件。
# When a directory this run will create does not exist yet, record its topmost missing level (install -d creates the missing
# levels above it too). Rollback removes it whole at the end: only what this run wrote can be in it, by the installer or by
# the panel that had just started, such as a temporary file it was half way through writing.
record_new_directory() {
  local directory=$1
  local missing=""
  while [[ ! -e ${directory} && ! -L ${directory} ]]; do
    missing=${directory}
    directory="$(dirname -- "${directory}")"
  done
  [[ -z ${missing} ]] || printf '%s\n' "${missing}" >> "${BACKUP_ROOT}/new-directories"
}

remove_new_directories() {
  local directory
  [[ -f ${BACKUP_ROOT}/new-directories ]] || return 0
  while IFS= read -r directory; do
    [[ ${directory} == /?* ]] || continue
    rm -rf -- "${directory}"
  done < "${BACKUP_ROOT}/new-directories"
}

# 这次运行会改属主、权限的已有目录和文件：记下原来的属主和权限，回滚时放回去。只记真的已经有、不是符号链接的。
# Existing directories and files whose owner and mode this run changes: record how they were, so rollback puts it back. Only
# what really exists and is no symlink is recorded.
record_owner() {
  local path=$1
  local kind=file
  [[ -e ${path} && ! -L ${path} ]] || return 0
  [[ ! -d ${path} ]] || kind=directory
  printf '%s\t%s %s\n' "${path}" "$(stat -c '%u %g %a' -- "${path}")" "${kind}" >> "${BACKUP_ROOT}/owners"
}

restore_owners() {
  local path
  local meta
  local owner
  local group
  local mode
  local kind
  [[ -f ${BACKUP_ROOT}/owners ]] || return 0
  while IFS=$'\t' read -r path meta; do
    read -r owner group mode kind <<< "${meta}"
    # 照 R2 停了以后、lstat 查过还是同一种东西才放回（R3）/ Put back only under R2, onto what lstat still finds to be the
    # same kind of thing (R3)
    [[ ! -L ${path} ]] || continue
    if [[ ${kind} == directory ]]; then
      [[ -d ${path} ]] || continue
    else
      [[ -f ${path} ]] || continue
    fi
    chown -h "${owner}:${group}" -- "${path}"
    chmod "${mode}" -- "${path}"
  done < "${BACKUP_ROOT}/owners"
}

# 回滚时删掉这次运行在状态目录和 KixDNS 配置目录里新写的东西（比如刚起来的面板做数据库迁移时留下的备份）：record_panel_paths 记下
# 了原来有什么。要照 R2 停了以后调用。
# On rollback, remove what this run newly wrote in the state directory and the KixDNS config directory (the backup the
# panel that had just started made while migrating its database, say): record_panel_paths recorded what was there. Call it
# under R2.
sweep_new_panel_files() {
  local tree
  local path
  local -A preexisting=()
  [[ -f ${BACKUP_ROOT}/preexisting ]] || return 0
  while IFS= read -r -d '' path; do
    preexisting[${path}]=1
  done < "${BACKUP_ROOT}/preexisting"
  for tree in "${PANEL_STATE_DIRECTORY}" "$(dirname -- "${KIXDNS_CONFIG_PATH}")"; do
    [[ -d ${tree} && ! -L ${tree} ]] || continue
    while IFS= read -r -d '' path; do
      [[ -n ${preexisting[${path}]:-} ]] || rm -rf -- "${path}"
    done < <(find "${tree}" -xdev -mindepth 1 -depth -print0)
  done
}

# 面板账号能写的目录树：状态目录、配置所在的目录、面板配置目录、在线更新状态目录、运行目录。
# The trees the panel account can write: the state directory, the config's directory, the panel config directory, the
# online update status directory and the runtime directories.
panel_writable_trees() {
  printf '%s\n' "${PANEL_STATE_DIRECTORY}" "$(dirname -- "${KIXDNS_CONFIG_PATH}")" "${PANEL_CONFIG_DIRECTORY}" \
    "${PANEL_UPDATE_DIRECTORY}" "${PANEL_RUNTIME_DIRECTORY}" "${KIXDNS_RUNTIME_DIRECTORY}"
}

# 这次运行之前这些目录树里已经有的路径（这次要建面板账号时才记），回滚时据此分辨哪些是这次建的。
# The paths these trees already held before this run (recorded only when this run creates the panel account), which tells
# rollback what this run made.
record_preexisting_paths() {
  local tree
  : > "${BACKUP_ROOT}/preexisting"
  while IFS= read -r tree; do
    [[ -d ${tree} && ! -L ${tree} ]] || continue
    find "${tree}" -xdev -print0 >> "${BACKUP_ROOT}/preexisting"
  done < <(panel_writable_trees)
}

# 这次建的账号（UID）或组（GID，第二个参数写 group）在这些目录树里还占着的：这次之前没有的就是这次运行（安装器或刚起来的面板）
# 写的，删掉；本来就有的（属主已经按记录放回，还归它的只会是这次改的）交还 root。账号删掉以后不留下归空 ID 的东西。
# What an account (UID) or group (GID, with group as the second argument) this run created still holds in these trees: what
# was not there before was written by this run (the installer or the panel that had just started) and goes; what was there
# (its owner already put back from the record, so still holding it means this run changed it) goes to root. Once the
# account is gone, nothing is left owned by a freed ID.
remove_owned_by() {
  local id=$1
  local test=-uid
  local tree
  local path
  local -A preexisting=()
  [[ ${2:-} != group ]] || test=-gid
  if [[ -f ${BACKUP_ROOT}/preexisting ]]; then
    while IFS= read -r -d '' path; do
      preexisting[${path}]=1
    done < "${BACKUP_ROOT}/preexisting"
  fi
  while IFS= read -r tree; do
    [[ -d ${tree} && ! -L ${tree} ]] || continue
    while IFS= read -r -d '' path; do
      if [[ -n ${preexisting[${path}]:-} ]]; then
        if [[ ${test} == -uid ]]; then chown -h root -- "${path}"; else chgrp -h root -- "${path}"; fi
      else
        rm -rf -- "${path}"
      fi
    done < <(find "${tree}" -xdev -depth "${test}" "${id}" -print0)
  done < <(panel_writable_trees)
}

# 记下这次运行开始时账号和组在不在，回滚时只删这次建的。/ Record whether the accounts and the group existed when this run
# began, so rollback removes only the ones it created.
record_existing_accounts() {
  getent group "${KIXDNS_GROUP}" >/dev/null || KIXDNS_GROUP_EXISTED=false
  id -u "${KIXDNS_USER}" >/dev/null 2>&1 || KIXDNS_USER_EXISTED=false
  id -u "${PANEL_USER}" >/dev/null 2>&1 || PANEL_USER_EXISTED=false
}

remove_new_accounts() {
  local id
  if [[ ${PANEL_USER_EXISTED} == false ]] && id="$(id -u "${PANEL_USER}" 2>/dev/null)" && [[ -n ${id} ]]; then
    remove_owned_by "${id}"
    userdel "${PANEL_USER}" 2>/dev/null || true
  fi
  if [[ ${KIXDNS_USER_EXISTED} == false ]] && id="$(id -u "${KIXDNS_USER}" 2>/dev/null)" && [[ -n ${id} ]]; then
    remove_owned_by "${id}"
    userdel "${KIXDNS_USER}" 2>/dev/null || true
  fi
  if [[ ${KIXDNS_GROUP_EXISTED} == false ]] && id="$(getent group "${KIXDNS_GROUP}" | cut -d: -f3)" && [[ -n ${id} ]]; then
    remove_owned_by "${id}" group
    groupdel "${KIXDNS_GROUP}" 2>/dev/null || true
  fi
}

backup_managed_config() {
  local config_parent
  local metadata
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  backup_path "${KIXDNS_CONFIG_PATH}" kixdns-config
  if [[ -d ${config_parent} ]]; then
    metadata="$(stat -c '%u %g %a' -- "${config_parent}")"
    printf '%s\n' "${metadata}" > "${BACKUP_ROOT}/kixdns-config-directory.meta"
  else
    record_new_directory "${config_parent}"
  fi
}

restore_managed_config() {
  local config_parent
  local owner
  local group
  local mode
  config_parent="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  rm -f -- "${KIXDNS_CONFIG_PATH}"
  if [[ -e ${BACKUP_ROOT}/kixdns-config || -L ${BACKUP_ROOT}/kixdns-config ]]; then
    [[ -e ${config_parent} || -L ${config_parent} ]] || install -d -- "${config_parent}"
    cp -a -- "${BACKUP_ROOT}/kixdns-config" "${KIXDNS_CONFIG_PATH}"
  fi
  # 这次新建的配置目录在回滚最后和别的新目录一起删（remove_new_directories）
  # A config directory this run created goes at the end of the rollback with the other new ones (remove_new_directories)
  if [[ -f ${BACKUP_ROOT}/kixdns-config-directory.meta && -d ${config_parent} && ! -L ${config_parent} ]]; then
    read -r owner group mode < "${BACKUP_ROOT}/kixdns-config-directory.meta"
    chown -h "${owner}:${group}" -- "${config_parent}"
    chmod "${mode}" -- "${config_parent}"
  fi
}

# 换配置位置时面板不再写的那份配置：回滚要放回它的内容、属主和权限（cp -a 原样带着），还有它所在目录的属主和权限；旧版原地迁移
# 的主机上还有这次补记了副本的外部备份。
# The config the panel stops writing when the config moves: rollback puts back its content, owner and mode (cp -a carries
# them as they were) and the owner and mode of its directory; on a host an older version migrated in place, also the external
# backup this run added the copy to.
backup_original_config() {
  local directory
  [[ ${CONFIG_CONVERSION} != legacy ]] || trusted_record external-backup || fail "迁移前的备份不见了"
  [[ -n ${CONFIG_CONVERSION} ]] || return 0
  directory="$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")"
  backup_path "${ORIGINAL_KIXDNS_CONFIG_PATH}" original-config
  stat -c '%u %g %a' -- "${directory}" > "${BACKUP_ROOT}/original-config-directory.meta"
  [[ ${CONFIG_CONVERSION} != legacy ]] || backup_path "${EXTERNAL_BACKUP}/install.env" external-backup-environment
}

restore_original_config() {
  local directory
  local owner
  local group
  local mode
  [[ -n ${CONFIG_CONVERSION} && -f ${BACKUP_ROOT}/original-config-directory.meta ]] || return 0
  directory="$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")"
  restore_path "${ORIGINAL_KIXDNS_CONFIG_PATH}" original-config
  read -r owner group mode < "${BACKUP_ROOT}/original-config-directory.meta"
  if [[ -d ${directory} && ! -L ${directory} ]]; then
    chown -h "${owner}:${group}" -- "${directory}"
    chmod "${mode}" -- "${directory}"
  fi
  [[ ${CONFIG_CONVERSION} != legacy ]] || restore_path "${EXTERNAL_BACKUP}/install.env" external-backup-environment
}

preserve_external_install() {
  local fragment
  local dropin
  local dropins=()
  local dropin_count=0
  [[ ${INSTALL_KIND} == migrate ]] || return 0
  # 卸载时选了保留、留下来的面板自带 KixDNS（跑的是面板状态目录里的程序）不是外部安装：重装后接着管它，不备份成
  # 「原来的 KixDNS」。否则卸载时会把这个 unit 当原来的放回去并启动，而它的程序已随面板状态目录删掉
  # The panel's own KixDNS kept by an earlier uninstall (it runs the program in the panel's state directory) is not an
  # external install: the reinstall manages it on, and it is not backed up as the original KixDNS. Otherwise uninstall
  # would put this unit back and start it, with its program already deleted along with the panel's state directory
  [[ ${EXISTING_KIXDNS_BINARY_PATH} != "${MANAGED_KIXDNS_BINARY}" ]] || return 0
  # 这时已经有的备份，是以前的卸载恢复了原来的 KixDNS 却没删的（现在的卸载恢复完就删），记的是更早那次迁移前的样子；要恢复的是
  # 主机上现在这个外部 KixDNS，所以换掉。旧的先挪进回滚备份，迁移失败时原样放回。
  # A backup already here was left by an earlier uninstall that restored the original KixDNS without removing it (current
  # ones remove it once restored), and describes the host before an older migration; the one to restore is the external
  # KixDNS on the host now, so it is replaced. The old one moves into the rollback backup first and goes back as it was if
  # the migration fails.
  if trusted_record external-backup; then
    mv -- "${EXTERNAL_BACKUP}" "${BACKUP_ROOT}/external-backup"
  fi
  CREATED_EXTERNAL_BACKUP=true
  ensure_root_records
  install -d -o root -g root -m 0700 "${EXTERNAL_BACKUP}"
  if [[ -e ${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT} ]]; then
    cp -a -- "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" "${EXTERNAL_BACKUP}/kixdns.service"
  else
    : > "${EXTERNAL_BACKUP}/service-file-missing"
  fi
  # 原来的 unit 不管放在哪，连同它的 drop-in 都存一份内容：以后交还配置时照它们定组和权限（original_unit_files）。恢复只放回
  # /etc/systemd/system 里那份（上面的 kixdns.service），别处的本来就没动过。
  # Whatever its place, the original unit's content is saved with its drop-ins: they later decide the group and mode of
  # the config handed back (original_unit_files). A restore puts back only the copy from /etc/systemd/system
  # (kixdns.service above); one elsewhere was never touched.
  fragment="$(systemctl show --property=FragmentPath --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ -n ${fragment} && -f ${fragment} ]]; then
    cat -- "${fragment}" > "${EXTERNAL_BACKUP}/unit-fragment"
  else
    fragment=""
  fi
  read -ra dropins <<< "$(systemctl show --property=DropInPaths --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  for dropin in "${dropins[@]}"; do
    [[ -f ${dropin} ]] || continue
    dropin_count=$((dropin_count + 1))
    cat -- "${dropin}" > "${EXTERNAL_BACKUP}/unit-dropin-${dropin_count}.conf"
  done
  {
    printf 'KIXDNS_SERVICE_UNIT=%s\n' "${KIXDNS_SERVICE_UNIT}"
    # 原来的 KixDNS 的配置，和面板管理的那一份分开记：迁移时后者是前者的副本，旧版原地迁移时两者相同。
    # The original KixDNS's config, recorded apart from the one the panel manages: on migration the latter is a copy
    # of the former, and an older in-place migration made them the same.
    printf 'KIXDNS_CONFIG=%s\n' "${ORIGINAL_KIXDNS_CONFIG_PATH:-${KIXDNS_CONFIG_PATH}}"
    printf 'KIXDNS_MANAGED_CONFIG=%s\n' "${KIXDNS_CONFIG_PATH}"
    printf 'KIXDNS_BINARY=%s\n' "${EXISTING_KIXDNS_BINARY_PATH}"
    [[ -z ${fragment} ]] || printf 'KIXDNS_UNIT_FRAGMENT=%s\n' "${fragment}"
    printf 'KIXDNS_WAS_ACTIVE=%s\n' "${KIXDNS_WAS_ACTIVE}"
    printf 'KIXDNS_WAS_ENABLED=%s\n' "${KIXDNS_WAS_ENABLED}"
    # 卸载恢复、删除面板数据时，只删迁移建的 kixdns 账号和组 / Uninstalling with a restore and the panel data removed deletes
    # only the kixdns account and group the migration created
    printf 'KIXDNS_USER_CREATED=%s\n' "$(kixdns_account_created user)"
    printf 'KIXDNS_GROUP_CREATED=%s\n' "$(kixdns_account_created group)"
  } > "${EXTERNAL_BACKUP}/install.env"
  # kixdns.service 是 cp -a 来的，留着原来的权限，恢复时照样放回 / kixdns.service came by cp -a with its own mode, which a
  # restore puts back as it was
  find "${EXTERNAL_BACKUP}" -maxdepth 1 \( -name install.env -o -name 'unit-*' \) -exec chmod 0600 -- {} +
}

# kixdns 账号（user）或组（group）是不是面板建的：这次运行开始时还没有，或者以前的面板建的、卸载时留下并记在保留的
# panel.env 里（KIXDNS_REMOVED，或迁移备份用掉时带过去的 KIXDNS_USER_CREATED、KIXDNS_GROUP_CREATED）。输出 true 或 false。
# Whether the kixdns account (user) or group (group) is the panel's: missing when this run began, or created by an earlier
# panel and left by an uninstall that recorded it in the kept panel.env (KIXDNS_REMOVED, or the KIXDNS_USER_CREATED and
# KIXDNS_GROUP_CREATED carried over when a migration backup was used up). Prints true or false.
kixdns_account_created() {
  local existed=${KIXDNS_USER_EXISTED}
  local key=KIXDNS_USER_CREATED
  if [[ $1 == group ]]; then
    existed=${KIXDNS_GROUP_EXISTED}
    key=KIXDNS_GROUP_CREATED
  fi
  if [[ ${existed} == false || $(environment_value KIXDNS_REMOVED || true) == true ||
    $(environment_value "${key}" || true) == true ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

prepare_rollback() {
  local directory
  BACKUP_ROOT="$(mktemp -d /var/tmp/kixdns-panel-install.XXXXXX)"
  # 回滚要能删掉这次建的一切，所以在建账号、建目录之前记下哪些原来就有 / Rollback must be able to remove everything this run
  # creates, so record what was there before any account or directory is created
  record_existing_accounts
  # 这里只记 root 自己的目录；面板能写的，等它的进程都没了以后再记（record_panel_paths，R2）/ Only root's own directories are
  # recorded here; the panel-writable ones wait until its processes are gone (record_panel_paths, R2)
  for directory in "${ROOT_RECORDS}" "${PANEL_UPDATE_DIRECTORY}" "${PANEL_SHARE_DIRECTORY}/web" "${PANEL_SHARE_DIRECTORY}/geo" \
    "${LIBEXEC_DIRECTORY}"; do
    record_new_directory "${directory}"
  done
  # 仅更新面板也会在换配置位置时改 KixDNS 的 unit / A panel-only update changes the KixDNS unit too when the config moves
  if [[ ${INSTALL_KIND} != panel-only || -n ${CONFIG_CONVERSION} ]]; then
    backup_path "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}" kixdns-service
  fi
  backup_path "${PANEL_SERVER_BINARY}" panel-server
  backup_path /usr/local/bin/kixdns-panel-uninstall panel-uninstall
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install" panel-one-click-install
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-online-update" panel-online-update
  backup_path "${PANEL_SHARE_DIRECTORY}/web" web
  backup_path "${PANEL_SHARE_DIRECTORY}/geo" builtin-geo
  backup_path /etc/systemd/system/kixdns-panel.service panel-service
  backup_path "${LIBEXEC_DIRECTORY}/kixdns-panel-helper" panel-helper
  backup_path /etc/systemd/system/kixdns-panel-helper.service panel-helper-service
  backup_path /etc/polkit-1/rules.d/50-kixdns-panel.rules polkit-rule
  backup_path "${PANEL_ENV}" panel-env
  arm_rollback
}

# R2：面板停了、它账号的进程都没了以后，记下面板能写的路径原来的样子：哪些目录这次要新建、要改属主的原来的属主和权限、这些目录树里
# 原来有什么（回滚据此删掉这次建的、放回改过的）。
# R2: once the panel has stopped and its account's processes are gone, record how the panel-writable paths were: which
# directories this run creates, the owners and modes of what it re-owns, and what these trees held (rollback removes what
# this run made and puts back what it changed by these).
record_panel_paths() {
  local directory
  for directory in "${PANEL_CONFIG_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo"; do
    record_new_directory "${directory}"
  done
  for directory in "${PANEL_STATE_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo" "${PANEL_UPDATE_DIRECTORY}" "${PANEL_CONFIG_DIRECTORY}" "${GITHUB_TOKEN_FILE}"; do
    record_owner "${directory}"
  done
  record_preexisting_paths
}

# 面板账号能写的东西的备份：面板停了、它的进程都没了以后才做，备份的就是它最后的样子，之后也不会被换掉。回滚只放回备份过的
# （restore_path），在这之前回滚不会动它们。
# Backups of what the panel account can write: taken once the panel has stopped and its processes are gone, so they are
# its last state and cannot be swapped afterwards. Rollback puts back only what was backed up (restore_path), so rolling
# back before this leaves them alone.
backup_panel_state() {
  if [[ ${INSTALL_KIND} != panel-only ]]; then
    backup_path "${MANAGED_KIXDNS_BINARY}" kixdns
    backup_path "${PANEL_STATE_DIRECTORY}/bundle" bundled-metadata
  fi
  if [[ ${INSTALL_KIND} != panel-only || -n ${CONFIG_CONVERSION} ]]; then
    backup_managed_config
  fi
  backup_original_config
}

# R2：面板停了，可 kixdns-panel 账号（和旧面板账号留下的 UID）可能还有别的进程，它们还能改面板目录里的东西：一个不留地停掉
# （quiesce_panel_account），之后 root 在这些目录里查过再做的事才不会被半路换掉。参数：停不掉时怎么停下，默认 abort_install。
# R2: the panel has stopped, but the kixdns-panel account (and UIDs an old panel account left) may have other processes,
# which could still change things in the panel's directories: stop every one (quiesce_panel_account), so what root then
# checks and does there cannot be swapped half way. Argument: how to stop when they cannot be stopped, abort_install by
# default.
stop_panel_processes() {
  quiesce_panel_account "${1:-abort_install}" "${PANEL_STATE_DIRECTORY}" "${PANEL_CONFIG_DIRECTORY}" \
    "$(dirname -- "${KIXDNS_CONFIG_PATH}")" ${ORIGINAL_KIXDNS_CONFIG_PATH:+"$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")"}
}

# R3：面板能写的目录：没有就建（install -d），已经有就查过不是符号链接、确实是目录，再 chown -h、chmod，不用 install -d（它会顺着
# 符号链接改目标，还会把已有目录改成 0755）。要照 R2 停了以后调用。参数：目录，属主，属组，权限。
# R3: a directory the panel can write: created when missing (install -d); when there, checked to be a real directory and
# no symlink, then chown -h and chmod, never install -d (which follows a symlink to its target and resets an existing
# directory to 0755). Call it under R2. Arguments: the directory, owner, group, mode.
ensure_directory() {
  local path=$1
  local owner=$2
  local group=$3
  local mode=$4
  [[ ! -L ${path} ]] || abort_install "${path} 不能是符号链接"
  if [[ -e ${path} ]]; then
    [[ -d ${path} ]] || abort_install "${path} 应该是目录"
    chown -h "${owner}:${group}" -- "${path}"
    chmod "${mode}" -- "${path}"
  else
    install -d -o "${owner}" -g "${group}" -m "${mode}" "${path}"
  fi
}

# 账号以外、这次运行要建的目录：面板状态目录和它下面的几个、在线更新状态目录、helper 所在的目录。
# The directories this run creates besides the accounts: the panel's state directory and those under it, the online update
# status directory, and the one holding the helper.
create_panel_directories() {
  local directory
  [[ -d ${LIBEXEC_DIRECTORY} ]] || install -d -o root -g root -m 0755 "${LIBEXEC_DIRECTORY}"
  for directory in "${PANEL_STATE_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo"; do
    ensure_directory "${directory}" "${PANEL_USER}" "${KIXDNS_GROUP}" 0750
  done
  ensure_directory "${PANEL_UPDATE_DIRECTORY}" root "${KIXDNS_GROUP}" 0750
}

# 改动主机之前确认要写的目标都不是符号链接：install 和 mv 会顺着链接写到别处。
# Before the host is touched, make sure no target to be written is a symlink: install and mv would write through it.
# 参数是出错时怎么停：默认 fail；回滚挂上以后用 abort_install。面板要等停了、它的进程都没了再查（stop_panel_processes），查过以后
# 它就改不了这些路径了。
# The argument says how to stop on a problem: fail by default, abort_install once rollback is armed. The check waits until
# the panel has stopped and its processes are gone (stop_panel_processes), after which it can no longer change these paths.
require_regular_targets() {
  local refuse=${1:-fail}
  local path
  local directory
  [[ ! -L ${PANEL_UPDATE_DIRECTORY} ]] || "${refuse}" "在线更新状态目录不能是符号链接"
  [[ ! -L ${PANEL_SERVER_BINARY} ]] || "${refuse}" "面板二进制目标不能是符号链接"
  [[ ! -L /usr/local/bin/kixdns-panel-uninstall ]] || "${refuse}" "卸载命令目标不能是符号链接"
  [[ ! -L ${LIBEXEC_DIRECTORY}/kixdns-panel-one-click-install ]] || "${refuse}" "一键安装器目标不能是符号链接"
  [[ ! -L ${LIBEXEC_DIRECTORY}/kixdns-panel-online-update ]] || "${refuse}" "在线更新器目标不能是符号链接"
  # 面板能写的目录：要改它们的属主、权限，或者往里写东西 / Directories the panel can write, whose owner and mode are changed
  # or that are written into
  for directory in "${PANEL_STATE_DIRECTORY}" "${PANEL_STATE_DIRECTORY}/bin" "${PANEL_STATE_DIRECTORY}/versions" \
    "${PANEL_STATE_DIRECTORY}/geo" "${PANEL_STATE_DIRECTORY}/bundle" "$(dirname -- "${KIXDNS_CONFIG_PATH}")" \
    ${ORIGINAL_KIXDNS_CONFIG_PATH:+"$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")"}; do
    [[ ! -L ${directory} ]] || "${refuse}" "${directory} 不能是符号链接"
    [[ ! -e ${directory} || -d ${directory} ]] || "${refuse}" "${directory} 应该是目录"
  done
  # 面板能写的目录里、安装器要读、改属主或权限的文件 / Files in the panel's directories the installer reads or re-owns
  for path in "${MANAGED_KIXDNS_BINARY}" "${KIXDNS_CONFIG_PATH}" ${ORIGINAL_KIXDNS_CONFIG_PATH:+"${ORIGINAL_KIXDNS_CONFIG_PATH}"} \
    "${PANEL_ENV}"; do
    [[ -e ${path} || -L ${path} ]] || continue
    [[ ! -L ${path} ]] || "${refuse}" "${path} 不能是符号链接"
    [[ -f ${path} ]] || "${refuse}" "${path} 应该是普通文件"
    [[ $(stat -c '%h' -- "${path}") == 1 ]] || "${refuse}" "${path} 有别的硬链接，安装器不会读它、改它的属主"
  done
}

# 出错就回滚，回滚只在这个 shell 里做（rollback_install 里说了为什么）
# Roll back on error, in this shell only (rollback_install says why)
arm_rollback() {
  # SHOULD 3：先挂陷阱，再记下回滚的 shell：反过来时，信号落在中间就既不回滚、EXIT 也以为回滚会管
  # SHOULD 3: traps first, then the rollback shell is recorded: the other way round, a signal in between got no rollback
  # while EXIT took it that the rollback would see to things
  # shellcheck disable=SC2064 # BASHPID 要在挂陷阱时展开，记下是哪个 shell 挂的 / BASHPID expands now, recording which shell set the trap
  trap "rollback_install \$? failed ${BASHPID}" ERR
  # 只挂 ERR 时，Ctrl-C、SIGTERM 或 SSH 断线会直接杀掉 bash，已停掉的服务不会恢复。
  # With only ERR trapped, Ctrl-C, SIGTERM or an SSH hangup kill bash and stopped services stay stopped.
  # shellcheck disable=SC2064 # 同上 / As above
  trap "rollback_install 130 interrupted ${BASHPID}" INT TERM HUP
  ROLLBACK_SHELL=${BASHPID}
}

# 安装包自带的 GeoSite（Loyalsoldier 的 geosite.dat、来源说明和 GPL 许可证）。只是安装包里的数据：
# 面板只在全新安装的首次启动、或用户自己点「导入」时用它，之后按用户选的来源和频率更新，面板升级从不替换用户的数据。
# The GeoSite the package brings along (Loyalsoldier's geosite.dat, its source note and GPL licence). It is only package data:
# the panel uses it on a fresh install's first start or when the user presses 导入, then updates follow the source and schedule
# the user chose, and a panel upgrade never replaces the user's data.
install_builtin_geo() {
  local target=${PANEL_SHARE_DIRECTORY}/geo
  local staged="${target}.new"
  local previous="${target}.previous"
  rm -rf -- "${staged}"
  install -d -o root -g root -m 0755 "${staged}"
  install -o root -g root -m 0644 "${PACKAGE_ROOT}/geo/geosite.dat" "${PACKAGE_ROOT}/geo/geosite.json" \
    "${PACKAGE_ROOT}/geo/LICENSE" "${staged}/"
  if [[ -d "${target}" ]]; then
    rm -rf -- "${previous}"
    mv -- "${target}" "${previous}"
  fi
  mv -- "${staged}" "${target}"
  # 回滚用的是安装前的备份，换下来的旧副本留着只占地方（约 11 MB）
  # Rollback restores from the pre-install backup, so the replaced copy would only take up space (about 11 MB)
  rm -rf -- "${previous}"
}

# 全新安装时请首次启动的面板导入一次内置 GeoSite；面板用完就删这个标记。升级和迁移不放：
# 那些主机原有的配置可能有意不用 GeoSite，导入会改变分流结果，由用户自己决定。
# On a fresh install, ask the panel's first start to import the built-in GeoSite once; the panel removes the marker after
# use. Upgrades and migrations get none: their existing configs may leave GeoSite out on purpose, and importing would
# change routing, so the user decides.
request_builtin_geosite_import() {
  [[ ${INSTALL_KIND} == fresh ]] || return 0
  # 面板能写的目录里先删掉同名的东西再写（R3）/ In a panel-writable directory, whatever has the name goes first (R3)
  rm -f -- "${PANEL_STATE_DIRECTORY}/geo/.import-builtin-geosite"
  install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 /dev/null "${PANEL_STATE_DIRECTORY}/geo/.import-builtin-geosite"
}

install_web() {
  local target=${PANEL_SHARE_DIRECTORY}/web
  local staged="${target}.new"
  local previous="${target}.previous"
  rm -rf -- "${staged}"
  install -d -o root -g root -m 0755 "${staged}"
  cp -a -- "${PACKAGE_ROOT}/web/." "${staged}/"
  chown -R root:root "${staged}"
  if [[ -d "${target}" ]]; then
    rm -rf -- "${previous}"
    mv -- "${target}" "${previous}"
  fi
  mv -- "${staged}" "${target}"
}

# MUST 1：仅更新面板时内核没换，panel.env 里记的内核来源、提交、编号照旧写回：只在 panel.env 能信、每一项都照格式验过时；
# 不然照 root 的事实定：面板目录里的内核程序和这个安装包的一字不差，就是这个包的；都不是就写成空（面板当作没记）。
# MUST 1: a panel-only update keeps the kernel, so the kernel source, commit and id panel.env records are written back: only
# when panel.env can be trusted and each one passes its format; otherwise root's facts decide: a kernel program in the
# panel's directory identical to this package's is this package's; if neither, they are written empty (the panel takes
# that as not recorded).
installed_kixdns_labels() {
  local commit
  local source_id
  local source
  local package_sum
  if [[ ${PANEL_ENV_TRUSTED} == true ]]; then
    commit="$(environment_value KIXDNS_INSTALLED_COMMIT || true)"
    source_id="$(environment_value KIXDNS_INSTALLED_SOURCE_ID || true)"
    source="$(environment_value KIXDNS_INSTALLED_SOURCE || true)"
    if panel_env_value_valid KIXDNS_INSTALLED_COMMIT "${commit}" &&
      panel_env_value_valid KIXDNS_INSTALLED_SOURCE_ID "${source_id}" &&
      panel_env_value_valid KIXDNS_INSTALLED_SOURCE "${source}"; then
      KIXDNS_BUILD_COMMIT=${commit}
      KIXDNS_SOURCE_ID=${source_id}
      KIXDNS_SOURCE=${source}
      return 0
    fi
  fi
  package_sum="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_BINARY_SHA256" 2>/dev/null || true)"
  if [[ -f ${MANAGED_KIXDNS_BINARY} && ! -L ${MANAGED_KIXDNS_BINARY} && ${package_sum} =~ ^[0-9a-f]{64}$ &&
    $(file_sha256 "${MANAGED_KIXDNS_BINARY}") == "${package_sum}" ]]; then
    return 0
  fi
  KIXDNS_BUILD_COMMIT=""
  KIXDNS_SOURCE_ID=""
  KIXDNS_SOURCE=""
}

render_panel_environment() {
  local source=$1
  local output=$2
  local kixdns_commit=$3
  local panel_commit=$4
  local panel_release=$5
  local kixdns_source_id=$6
  local kixdns_source=$7
  local pair
  # MUST 1：写进去的每一项先照格式验，不对就停下；值经 ENVIRON 交给 awk（awk -v 会把 \n 这样的写法解开成换行，多出一行就是多出一项）
  # MUST 1: each value written is checked by its format first, and a bad one stops the run; values reach awk through
  # ENVIRON (awk -v decodes escapes such as \n into a new line, and a new line is a new setting)
  for pair in "KIXDNS_INSTALLED_COMMIT=${kixdns_commit}" "KIXDNS_PANEL_INSTALLED_COMMIT=${panel_commit}" \
    "KIXDNS_PANEL_INSTALLED_RELEASE=${panel_release}" "KIXDNS_INSTALLED_SOURCE_ID=${kixdns_source_id}" \
    "KIXDNS_INSTALLED_SOURCE=${kixdns_source}" "KIXDNS_CONFIG=${KIXDNS_CONFIG_PATH}" "KIXDNS_BINARY=${KIXDNS_BINARY_PATH}" \
    "KIXDNS_CONTROL_SOCKET=${KIXDNS_CONTROL_SOCKET}" "KIXDNS_SERVICE_HELPER_SOCKET=${KIXDNS_SERVICE_HELPER_SOCKET}" \
    "KIXDNS_SERVICE_UNIT=${KIXDNS_SERVICE_UNIT}"; do
    panel_env_value_valid "${pair%%=*}" "${pair#*=}" || fail "要写进 panel.env 的 ${pair%%=*} 格式不对，没有写"
  done
  AWK_KIXDNS_COMMIT=${kixdns_commit} AWK_PANEL_COMMIT=${panel_commit} AWK_PANEL_RELEASE=${panel_release} \
    AWK_KIXDNS_SOURCE_ID=${kixdns_source_id} AWK_KIXDNS_SOURCE=${kixdns_source} AWK_CONFIG_PATH=${KIXDNS_CONFIG_PATH} \
    AWK_BINARY_PATH=${KIXDNS_BINARY_PATH} AWK_CONTROL_SOCKET=${KIXDNS_CONTROL_SOCKET} \
    AWK_HELPER_SOCKET=${KIXDNS_SERVICE_HELPER_SOCKET} AWK_SERVICE_UNIT=${KIXDNS_SERVICE_UNIT} \
    AWK_OLD_TRUSTED_COMMENT=${OLD_TRUSTED_PROXIES_COMMENT} AWK_OLD_TRUSTED_LINE=${OLD_TRUSTED_PROXIES_LINE} \
    AWK_TRUSTED_COMMENT_1=${TRUSTED_PROXIES_COMMENT_1} AWK_TRUSTED_COMMENT_2=${TRUSTED_PROXIES_COMMENT_2} awk '
    BEGIN {
      kixdns_commit = ENVIRON["AWK_KIXDNS_COMMIT"]
      panel_commit = ENVIRON["AWK_PANEL_COMMIT"]
      panel_release = ENVIRON["AWK_PANEL_RELEASE"]
      kixdns_source_id = ENVIRON["AWK_KIXDNS_SOURCE_ID"]
      kixdns_source = ENVIRON["AWK_KIXDNS_SOURCE"]
      config_path = ENVIRON["AWK_CONFIG_PATH"]
      binary_path = ENVIRON["AWK_BINARY_PATH"]
      control_socket = ENVIRON["AWK_CONTROL_SOCKET"]
      helper_socket = ENVIRON["AWK_HELPER_SOCKET"]
      service_unit = ENVIRON["AWK_SERVICE_UNIT"]
      old_trusted_comment = ENVIRON["AWK_OLD_TRUSTED_COMMENT"]
      old_trusted_line = ENVIRON["AWK_OLD_TRUSTED_LINE"]
      trusted_comment_1 = ENVIRON["AWK_TRUSTED_COMMENT_1"]
      trusted_comment_2 = ENVIRON["AWK_TRUSTED_COMMENT_2"]
    }
    # 旧示例的可信代理说明先压着，看下一行：还是旧示例的默认值时只换说明，值留着（为什么见 update_panel_environment）。
    # The trusted-proxies comment of the old example is held to look at the next line: when that is still the old default,
    # only the comment is replaced and the value stays (update_panel_environment says why).
    held_trusted_comment {
      held_trusted_comment = 0
      if ($0 == old_trusted_line) {
        print trusted_comment_1
        print trusted_comment_2
        print
        next
      }
      print old_trusted_comment
    }
    $0 == old_trusted_comment { held_trusted_comment = 1; next }
    # 内核改从 fork 的发布页更新：按补丁集构建找 Artifact 的这几项和它们的说明不再读取，删掉免得误导手工编辑的人。
    # Kernels now update from fork releases: the settings that located patchset Artifacts, and their comments, are no
    # longer read, so drop them to keep hand edits from being misled.
    /^# GitHub API 元数据请求可在系统页配置 Token；Artifact 下载仍通过 nightly\.link。$/ { next }
    /^# x86_64 使用 x86_64，ARM64 使用 arm64；安装脚本会自动填写。$/ { next }
    /^KIXDNS_UPDATE_(REPOSITORY|WORKFLOW|BRANCH|ARTIFACT)=/ { next }
    /^# 完整安装包复用的 KixDNS Action 提交，由安装脚本填写；不要手工修改。$/ {
      print "# 完整安装包自带内核的来源和提交，由安装脚本填写；不要手工修改。"
      next
    }
    /^# 完整安装包自带增强 Artifact 的 GitHub ID，由安装脚本填写。$/ {
      print "# 完整安装包自带内核包在 GitHub 上的编号，由安装脚本填写。"
      next
    }
    # 监听地址是用户的设置，升级不改：改成 127.0.0.1 的人就是不想让面板对外。
    # An upgrade leaves the listen address alone: whoever set 127.0.0.1 wants the panel kept off the network.
    /^KIXDNS_PANEL_BIND=/ { bind_found = 1 }
    /^KIXDNS_CONFIG=/ { print "KIXDNS_CONFIG=" config_path; config_found = 1; next }
    /^KIXDNS_BINARY=/ { print "KIXDNS_BINARY=" binary_path; binary_found = 1; next }
    /^KIXDNS_CONTROL_SOCKET=/ { print "KIXDNS_CONTROL_SOCKET=" control_socket; socket_found = 1; next }
    /^KIXDNS_SERVICE_HELPER_SOCKET=/ { print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket; helper_socket_found = 1; next }
    /^KIXDNS_SERVICE_UNIT=/ { print "KIXDNS_SERVICE_UNIT=" service_unit; unit_found = 1; next }
    # 已移除的管理模式开关：旧文件里的键和说明一并删掉，免得误导手工编辑的人。
    # The removed management switch: drop the key and its comment from old files so hand edits are not misled.
    /^# true：面板管理增强版二进制；false：/ { next }
    /^KIXDNS_MANAGEMENT_ENABLED=/ { next }
    # 卸载器记下的「KixDNS 已不归面板管时留下待删的」：重新装上以后又归面板管，迁移备份已经接着记下（kixdns_account_created）。
    # What the uninstaller recorded as left behind once the KixDNS no longer belonged to the panel: after a reinstall it
    # belongs to the panel again, and a migration backup has carried the record on (kixdns_account_created).
    /^KIXDNS_(REMOVED|USER_CREATED|GROUP_CREATED)=/ { next }
    /^KIXDNS_INSTALLED_SOURCE=/ {
      if (kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      kixdns_source_found = 1
      next
    }
    /^KIXDNS_INSTALLED_COMMIT=/ {
      if (!kixdns_source_found && kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      kixdns_source_found = 1
      print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      kixdns_found = 1
      next
    }
    /^KIXDNS_INSTALLED_SOURCE_ID=/ {
      print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      source_id_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_COMMIT=/ {
      print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      panel_found = 1
      next
    }
    /^KIXDNS_PANEL_INSTALLED_RELEASE=/ {
      if (panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
      panel_release_found = 1
      next
    }
    # 内核只跟随 Action 轨道，Release 工作流的设置已不再读取。
    # The kernel follows only the Action track; the Release workflow setting is no longer read.
    /^KIXDNS_UPDATE_RELEASE_WORKFLOW=/ { next }
    { print }
    END {
      if (held_trusted_comment) print old_trusted_comment
      if (!bind_found) print "KIXDNS_PANEL_BIND=0.0.0.0:5738"
      if (!config_found) print "KIXDNS_CONFIG=" config_path
      if (!binary_found) print "KIXDNS_BINARY=" binary_path
      if (!socket_found) print "KIXDNS_CONTROL_SOCKET=" control_socket
      if (!helper_socket_found) print "KIXDNS_SERVICE_HELPER_SOCKET=" helper_socket
      if (!unit_found) print "KIXDNS_SERVICE_UNIT=" service_unit
      if (!kixdns_source_found && kixdns_source != "") print "KIXDNS_INSTALLED_SOURCE=" kixdns_source
      if (!kixdns_found) print "KIXDNS_INSTALLED_COMMIT=" kixdns_commit
      if (!source_id_found) print "KIXDNS_INSTALLED_SOURCE_ID=" kixdns_source_id
      if (!panel_found) print "KIXDNS_PANEL_INSTALLED_COMMIT=" panel_commit
      if (!panel_release_found && panel_release != "") print "KIXDNS_PANEL_INSTALLED_RELEASE=" panel_release
    }
  ' "${source}" > "${output}"
}

# panel.env 里可信代理还是旧示例的默认值（信任本机代理），上面那行说明也还是旧示例的原样。
# The trusted proxies in panel.env are still the old example's default (the local proxy trusted), with its comment above
# still as the old example had it.
old_trusted_proxies_default() {
  [[ -f $1 ]] || return 1
  AWK_COMMENT="${OLD_TRUSTED_PROXIES_COMMENT}" AWK_LINE="${OLD_TRUSTED_PROXIES_LINE}" awk 'BEGIN {
        comment = ENVIRON["AWK_COMMENT"]
        line = ENVIRON["AWK_LINE"]
      }
    previous == comment && $0 == line { found = 1 }
    { previous = $0 }
    END { exit !found }
  ' "$1"
}

update_panel_environment() {
  local kixdns_commit=$1
  local kixdns_source_id=$2
  local kixdns_source=$3
  local temporary
  local source=${PANEL_ENV}
  local destination
  # 旧示例默认信任本机代理，从那时装起的主机都还写着。升级不改这个值：本机 Nginx 后面的人改成谁都不信以后，登录限流把所有人
  # 算在代理一个地址上，几次输错就全被锁住，比它挡住的本机伪造更糟。只把说明换成新示例的，在安装结果里提醒一次；说明换过，
  # 下次就不再提醒。
  # The old example trusted the local proxy by default, and hosts installed back then still say so. An upgrade keeps the
  # value: trusting none behind a local Nginx makes the login limit count everyone against the proxy's one address, locking
  # all out after a few wrong passwords, which is worse than the local spoofing it stops. Only the comment becomes the new
  # example's and the install result says so once; with the comment replaced, the next run says nothing.
  if [[ ${PANEL_ENV_TRUSTED} == false ]]; then
    # MUST 1：面板能改的 panel.env 一项也不带过来：照安装包的示例重写，值只用 root 的事实和安装器验过的设置
    # MUST 1: nothing is carried over from a panel.env the panel can change: it is rewritten from the package's example,
    # with values only from root's facts and settings the installer checked
    source="${PACKAGE_ROOT}/deploy/panel.env.example"
  elif old_trusted_proxies_default "${PANEL_ENV}"; then
    TRUSTED_PROXIES_NOTICE=true
  fi
  temporary="$(mktemp "${PANEL_CONFIG_DIRECTORY}/.panel.env.XXXXXX")"
  render_panel_environment "${source}" "${temporary}" "${kixdns_commit}" \
    "${PANEL_BUILD_COMMIT}" "${PANEL_RELEASE}" "${kixdns_source_id}" "${kixdns_source}"
  chown -h root:"${KIXDNS_GROUP}" -- "${temporary}"
  chmod 0640 -- "${temporary}"
  if [[ ${PANEL_ENV_TRUSTED} == false && ( -e ${PANEL_ENV} || -L ${PANEL_ENV} ) ]]; then
    quarantine_record "${PANEL_ENV}" panel.env
    destination="已删掉"
    [[ -z ${QUARANTINED_TO} ]] || destination="挪到了 ${QUARANTINED_TO}"
    printf '%s 面板能改，这次照安装包的示例重写，里面原来的设置一项也没用（%s）；要用其中的设置（比如监听地址），核对以后照着改 %s，再 sudo systemctl restart kixdns-panel.service。\n' \
      "${PANEL_ENV}" "${destination}" "${PANEL_ENV}"
  fi
  mv -fT -- "${temporary}" "${PANEL_ENV}"
}

install_configuration() {
  ensure_directory "${PANEL_CONFIG_DIRECTORY}" root "${KIXDNS_GROUP}" 0750
  ensure_directory "$(dirname -- "${KIXDNS_CONFIG_PATH}")" "${PANEL_USER}" "${KIXDNS_GROUP}" 0750
  if [[ -n ${ORIGINAL_KIXDNS_CONFIG_PATH} && -f ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
    # 迁移：把原配置一字不差地复制给面板管理。原文件只读不写，属主和权限都不动。
    # Migration: copy the original config byte for byte for the panel to manage. The original is only read; its owner
    # and mode stay as they are.
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 -- "${ORIGINAL_KIXDNS_CONFIG_PATH}" "${KIXDNS_CONFIG_PATH}"
  elif [[ ! -e ${KIXDNS_CONFIG_PATH} ]]; then
    install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0640 \
      "${PACKAGE_ROOT}/deploy/config/pipeline.json" "${KIXDNS_CONFIG_PATH}"
  else
    chown -h "${PANEL_USER}:${KIXDNS_GROUP}" -- "${KIXDNS_CONFIG_PATH}"
    chmod 0640 -- "${KIXDNS_CONFIG_PATH}"
  fi
  hand_back_config_directory
  if [[ ! -e ${PANEL_ENV} || -L ${PANEL_ENV} ]]; then
    rm -f -- "${PANEL_ENV}"
    render_panel_environment "${PACKAGE_ROOT}/deploy/panel.env.example" "${PANEL_ENV}" "${KIXDNS_BUILD_COMMIT}" \
      "${PANEL_BUILD_COMMIT}" "${PANEL_RELEASE}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
    chown -h root:"${KIXDNS_GROUP}" -- "${PANEL_ENV}"
    chmod 0640 -- "${PANEL_ENV}"
  fi
  update_panel_environment "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
}

# 升级时换了配置位置：面板不再写原来那份，把它（和它所在的目录）交还。旧版原地迁移的主机，原配置一字不动地留给原来的 KixDNS，
# 外部备份补记副本，卸载恢复时就和新的迁移一样删副本、放回原 unit；公共目录里的配置已经复制到 /etc/kixdns，删掉旧的。
# The config moved on upgrade: the panel no longer writes the old one, so it (and its directory) is handed back. On a host
# an older version migrated in place, the original stays exactly as it is for the original KixDNS and the external backup
# gains the copy, so an uninstall restore removes the copy and puts the original unit back as for a new migration; a config
# in a shared directory has been copied to /etc/kixdns, and the old one goes.
hand_back_config_directory() {
  local temporary
  local unit_files=()
  case ${CONFIG_CONVERSION} in
    legacy)
      trusted_record external-backup || fail "迁移前的备份不见了"
      mapfile -t unit_files < <(original_unit_files "${EXTERNAL_BACKUP}" "${KIXDNS_SERVICE_UNIT}")
      hand_back_original_config "${ORIGINAL_KIXDNS_CONFIG_PATH}" "${unit_files[@]}"
      temporary="$(mktemp "${EXTERNAL_BACKUP}/.install.env.XXXXXX")"
      {
        grep -v -E '^KIXDNS_(MANAGED_CONFIG|LEGACY_IN_PLACE)=' -- "${EXTERNAL_BACKUP}/install.env" || true
        printf 'KIXDNS_MANAGED_CONFIG=%s\n' "${KIXDNS_CONFIG_PATH}"
        # 原配置里留的是升级这时面板保存的内容，不是迁移前的；卸载恢复时照实说 / The original holds what the panel had saved
        # at this upgrade, not the pre-migration content; an uninstall restore says so
        printf 'KIXDNS_LEGACY_IN_PLACE=true\n'
      } > "${temporary}"
      chmod 0600 -- "${temporary}"
      mv -fT -- "${temporary}" "${EXTERNAL_BACKUP}/install.env"
      ;;
    shared)
      rm -f -- "${ORIGINAL_KIXDNS_CONFIG_PATH}"
      hand_back_directory "$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")"
      ;;
  esac
}

install_bundled_metadata() {
  local target=/var/lib/kixdns-panel/bundle
  local file
  [[ ${INSTALL_KIND} != panel-only ]] || return 0
  ensure_directory "${target}" root "${KIXDNS_GROUP}" 0750
  # 旧安装包带的是补丁集构建的身份；换成 fork 发布版后这两份不再对应装上的内核，删掉免得混用。
  # Older packages carried a patchset build's identity; with a fork release these two no longer describe the installed
  # kernel, so remove them rather than let them mix.
  rm -f -- "${target}/upstream.lock.json" "${target}/KIXDNS_SOURCE_RUN_ID"
  for file in KIXDNS_BUILD_COMMIT KIXDNS_SOURCE.json KIXDNS_ARTIFACT_ID \
    KIXDNS_ARTIFACT_NAME KIXDNS_ARTIFACT_DIGEST KIXDNS_BINARY_SHA256 \
    KIXDNS_CAPABILITIES.json; do
    rm -f -- "${target:?}/${file}"
    install -o root -g "${KIXDNS_GROUP}" -m 0640 \
      "${PACKAGE_ROOT}/${file}" "${target}/${file}"
  done
}

install_services() {
  local kixdns_unit=${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}
  local config_directory
  local panel_temporary
  local helper_temporary
  local kixdns_temporary
  local helper_unit=/etc/systemd/system/kixdns-panel-helper.service
  local panel_uid
  panel_uid="$(id -u "${PANEL_USER}")"
  panel_temporary="$(mktemp /etc/systemd/system/.kixdns-panel.XXXXXX)"
  helper_temporary="$(mktemp /etc/systemd/system/.kixdns-panel-helper.XXXXXX)"
  if [[ ${KIXDNS_UNIT_CHANGED} == true ]]; then
    kixdns_temporary="$(mktemp /etc/systemd/system/.kixdns.XXXXXX)"
    render_kixdns_unit > "${kixdns_temporary}"
    install -o root -g root -m 0644 "${kixdns_temporary}" "${kixdns_unit}"
    rm -f -- "${kixdns_temporary}"
  fi
  AWK_SERVICE_UNIT="${KIXDNS_SERVICE_UNIT}" AWK_HELPER_SOCKET="${KIXDNS_SERVICE_HELPER_SOCKET}" \
    AWK_PANEL_UID="${panel_uid}" awk 'BEGIN {
        service_unit = ENVIRON["AWK_SERVICE_UNIT"]
        helper_socket = ENVIRON["AWK_HELPER_SOCKET"]
        panel_uid = ENVIRON["AWK_PANEL_UID"]
      }
    /^ExecStart=/ {
      print "ExecStart=/usr/local/libexec/kixdns-panel-helper --socket " helper_socket " --unit " service_unit " --allowed-uid " panel_uid
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel-helper.service" > "${helper_temporary}"
  install -o root -g root -m 0644 "${helper_temporary}" "${helper_unit}"
  rm -f -- "${helper_temporary}"
  config_directory="$(dirname -- "${KIXDNS_CONFIG_PATH}")"
  AWK_SERVICE_UNIT="${KIXDNS_SERVICE_UNIT}" AWK_CONFIG_DIRECTORY="${config_directory}" awk 'BEGIN {
        service_unit = ENVIRON["AWK_SERVICE_UNIT"]
        config_directory = ENVIRON["AWK_CONFIG_DIRECTORY"]
      }
    /^After=network-online\.target / { print "After=network-online.target " service_unit " kixdns-panel-helper.service"; next }
    /^ReadWritePaths=/ {
      print "ReadWritePaths=" config_directory " /var/lib/kixdns-panel"
      next
    }
    { print }
  ' "${PACKAGE_ROOT}/deploy/systemd/kixdns-panel.service" > "${panel_temporary}"
  install -o root -g root -m 0644 "${panel_temporary}" /etc/systemd/system/kixdns-panel.service
  rm -f -- "${panel_temporary}"
  rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
  systemctl daemon-reload
  systemctl enable kixdns-panel-helper.service kixdns-panel.service --quiet
  if kixdns_replaced; then
    restore_managed_service_state
  fi
  systemctl restart kixdns-panel-helper.service
  systemctl restart kixdns-panel.service
}

port_accepts_connection() {
  local host=$1
  local port=$2
  # install.sh 不要求 curl；bash 自带的 /dev/tcp 足够确认端口在接受连接。
  # install.sh does not require curl; bash's own /dev/tcp is enough to see the port accepting connections.
  # shellcheck disable=SC2016 # $1/$2 由内层 bash 展开 / expanded by the inner bash
  timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "${host}" "${port}" 2>/dev/null
}

# Type=simple 的服务 fork 成功 systemctl 就返回，崩溃循环也会先显示 active。
# 这里要求主进程在比 RestartSec 更长的窗口里保持同一个 PID，必要时端口也已接受连接。
# systemctl returns as soon as a Type=simple service forks, and a crash loop briefly reads active.
# Require the same main PID for longer than RestartSec, and the port accepting connections when given.
wait_for_service_stable() {
  local unit=$1
  local host=${2:-}
  local port=${3:-}
  local tick
  local state
  local pid
  local stable_pid=""
  local stable_ticks=0
  for ((tick = 0; tick < SERVICE_WAIT_SECONDS * 2; tick++)); do
    state="$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
    pid="$(systemctl show --property=MainPID --value "${unit}" 2>/dev/null || true)"
    if [[ ${state} == active && ${pid} =~ ^[1-9][0-9]*$ ]]; then
      if [[ ${pid} == "${stable_pid}" ]]; then
        stable_ticks=$((stable_ticks + 1))
      else
        stable_pid=${pid}
        stable_ticks=0
      fi
      if ((stable_ticks >= SERVICE_STABLE_SECONDS * 2)) &&
        { [[ -z ${port} ]] || port_accepts_connection "${host}" "${port}"; }; then
        return 0
      fi
    else
      stable_pid=""
      stable_ticks=0
    fi
    sleep 0.5
  done
  return 1
}

panel_probe_address() {
  local bind
  local host
  bind="$(environment_value KIXDNS_PANEL_BIND || true)"
  [[ -n ${bind} ]] || bind=0.0.0.0:5738
  host=${bind%:*}
  case ${host} in
    0.0.0.0 | "") host=127.0.0.1 ;;
    \[::\]) host=::1 ;;
    *) host="$(strip_address_host "${host}")" ;;
  esac
  printf '%s %s\n' "${host}" "${bind##*:}"
}

verify_services_started() {
  local host
  local port
  read -r host port < <(panel_probe_address)
  if ! wait_for_service_stable kixdns-panel.service "${host}" "${port}"; then
    abort_install "kixdns-panel.service 启动后没有保持运行（${SERVICE_WAIT_SECONDS} 秒内没有稳定运行并接受 ${port} 端口连接）。
查看原因：journalctl -u kixdns-panel.service -n 50 --no-pager"
  fi
  # 只检查这次亲手重启的 KixDNS：本来就在运行而没被动过的，不该让面板升级跟着回滚。
  # Only check a KixDNS this run restarted: one left untouched should not drag a panel upgrade into rollback.
  [[ ${KIXDNS_RESTART} == true ]] || return 0
  if ! wait_for_service_stable "${KIXDNS_SERVICE_UNIT}"; then
    abort_install "${KIXDNS_SERVICE_UNIT} 替换后没有保持运行。
查看原因：journalctl -u ${KIXDNS_SERVICE_UNIT} -n 50 --no-pager"
  fi
}

print_port53_notice() {
  if [[ ${RESOLVED_CHANGED} == true ]]; then
    printf '端口 %s：已关闭 systemd-resolved 的本机监听；卸载时选择移除 KixDNS 会恢复原样\n' "${RESOLVED_PORT}"
    return 0
  fi
  case ${PORT_CONFLICT} in
    resolved)
      printf '端口 %s：被 systemd-resolved 占用，在面板里启动 KixDNS 前先执行：\n' "${PORT_CONFLICT_PORT}"
      resolved_manual_commands
      ;;
    other)
      printf '端口 %s：被 %s占用，KixDNS 启动会失败；先停用这个程序，或在面板的基础设置里把 UDP / TCP 监听地址改到别的端口\n' \
        "${PORT_CONFLICT_PORT}" "$(holder_text)"
      ;;
  esac
}

# 升级时换了配置位置：说清配置现在在哪、原来那份怎样了，列出改了属主和权限的路径（改之前 → 现在）。
# The config moved on upgrade: say where it is now and what became of the old one, listing the paths whose owner and mode
# changed (before → now).
print_conversion_summary() {
  local entry
  local path
  local now
  local changes=""
  # 只列真改了的路径 / Only paths that really changed are listed
  for entry in "${CONVERSION_BEFORE[@]}"; do
    path=${entry%%|*}
    [[ -e ${path} ]] || continue
    now="$(owner_and_mode "${path}")"
    [[ ${now} != "${entry#*|}" ]] || continue
    changes+="  ${path}：${entry#*|} → ${now}"$'\n'
  done
  case ${CONFIG_CONVERSION} in
    legacy)
      printf '配置：改为管理副本 %s，以后在面板里改的都写进副本；原配置 %s 留着升级这时的内容，交还给原来的 KixDNS\n' \
        "${KIXDNS_CONFIG_PATH}" "${ORIGINAL_KIXDNS_CONFIG_PATH}"
      [[ -z ${changes} ]] || printf '旧版迁移时把原配置交给了面板，没有记下它原来的属主和权限，这次改成：\n%s' "${changes}"
      ;;
    shared)
      printf '配置：从 %s 挪到 %s；%s 里还放着别的文件，面板不再写它\n%s' "${ORIGINAL_KIXDNS_CONFIG_PATH}" \
        "${KIXDNS_CONFIG_PATH}" "$(dirname -- "${ORIGINAL_KIXDNS_CONFIG_PATH}")" "${changes}"
      ;;
  esac
}

print_summary() {
  local panel_url=$1
  local package_label
  package_label="$(package_panel_label)"
  printf '\n'
  if [[ ${INSTALL_KIND} == panel-only ]]; then
    printf '面板更新完成：KixDNS 面板 %s\n' "${package_label}"
  else
    printf '安装完成：KixDNS 面板 %s\n' "${package_label}"
  fi
  printf '面板地址：%s\n' "${panel_url}"
  case ${INSTALL_KIND} in
    fresh)
      printf 'KixDNS：已安装，尚未启动\n'
      ;;
    migrate)
      printf 'KixDNS：已迁移为增强版，保持原来的运行状态（%s）；原 unit 备份在 %s，卸载面板时可恢复\n' \
        "$(running_state_text "${KIXDNS_WAS_ACTIVE}")" "${EXTERNAL_BACKUP}"
      if [[ -z ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
        :
      elif [[ -f ${ORIGINAL_KIXDNS_CONFIG_PATH} ]]; then
        printf '配置：已复制到 %s 由面板管理，原来的 %s 不动\n' "${KIXDNS_CONFIG_PATH}" "${ORIGINAL_KIXDNS_CONFIG_PATH}"
      else
        printf '配置：%s 不存在，面板在 %s 写入了默认配置\n' "${ORIGINAL_KIXDNS_CONFIG_PATH}" "${KIXDNS_CONFIG_PATH}"
      fi
      if [[ -n ${PANEL_UNREADABLE_FILES} ]]; then
        printf 'Geo 文件：面板读不到原配置里写的这些，GeoSite 分类和 IP 地区标注会缺它们，DNS 不受影响：\n%s' \
          "${PANEL_UNREADABLE_FILES}"
        printf '让 kixdns-panel 账号能读到它们，刷新面板页面就有了。\n'
      fi
      ;;
    reclaim)
      printf 'KixDNS：已接回上次卸载时保留的 KixDNS，保持原来的运行状态（%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
      print_reclaim_backup_note
      ;;
    upgrade)
      if [[ ${PREVIOUS_PANEL_LABEL} == "${package_label}" ]]; then
        printf '面板：已重新安装 %s\n' "${package_label}"
      else
        printf '面板：已升级 %s → %s\n' "${PREVIOUS_PANEL_LABEL}" "${package_label}"
      fi
      if ! kixdns_replaced; then
        printf 'KixDNS：未变（%s）\n' "$(running_state_text "${KIXDNS_WAS_ACTIVE}")"
      elif [[ ${KIXDNS_RESTART} == true ]]; then
        printf 'KixDNS：已替换并按原状态重启（运行中）\n'
      else
        printf 'KixDNS：已替换，保持原状态（已停止）\n'
      fi
      ;;
    panel-only)
      if ! kixdns_replaced; then
        printf 'KixDNS：未替换，配置与运行状态保持不变\n'
      elif [[ ${KIXDNS_RESTART} == true ]]; then
        printf 'KixDNS：程序未替换，unit 改用新的配置路径，已按原状态重启（运行中）\n'
      else
        printf 'KixDNS：程序未替换，unit 改用新的配置路径，保持原状态（已停止）\n'
      fi
      ;;
  esac
  print_conversion_summary
  print_port53_notice
  if [[ ${TRUSTED_PROXIES_NOTICE} == true ]]; then
    printf '反向代理：panel.env 还信任本机代理（旧版的默认值 127.0.0.1/32,::1/128）；这台主机上没有反向代理时，清空它更安全：\n'
    printf "  sudo sed -i 's|^KIXDNS_TRUSTED_PROXIES=.*|KIXDNS_TRUSTED_PROXIES=|' %s && sudo systemctl restart kixdns-panel.service\n" \
      "${PANEL_ENV}"
  fi
  # 下一步放在端口 53 的提醒后面：那条要在启动 KixDNS 之前先做 / The next step comes after the port-53 notice, which has to happen before KixDNS starts
  [[ ${INSTALL_KIND} == fresh ]] && printf '下一步：打开面板地址，创建管理员，然后在概览页点「启动 KixDNS」\n'
  printf '只在可信内网使用面板；公网访问必须配置防火墙和 HTTPS 反向代理。\n'
  # panel.env 不能信、内核又和包里的不一样时不知道内核的提交 / The kernel commit is unknown when panel.env cannot be trusted and
  # the kernel differs from the package's
  printf '构建：面板 %.12s · KixDNS %.12s\n' "${PANEL_BUILD_COMMIT}" "${KIXDNS_BUILD_COMMIT:-未知}"
}

main() {
  local panel_bind
  parse_arguments "$@"
  require_root
  command -v systemctl >/dev/null || fail "系统未安装 systemd"
  command -v flock >/dev/null || fail "系统缺少 flock"
  # 同一时间只跑一个安装、卸载或在线更新，整个运行都拿着锁 / One install, uninstall or online update at a time, the lock held
  # for the whole run
  take_root_lock
  # SHOULD 3：从这里起每个退出都经过 on_installer_exit；挂回滚之前的信号也照常退出，让它收拾
  # SHOULD 3: from here on every exit goes through on_installer_exit; a signal before the rollback is armed exits normally
  # too, for it to tidy up
  trap on_installer_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  command -v getent >/dev/null || fail "系统缺少 getent"
  command -v sha256sum >/dev/null || fail "系统缺少 sha256sum"
  require_file "${PACKAGE_ROOT}/bin/kixdns"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-server"
  require_file "${PACKAGE_ROOT}/bin/kixdns-panel-helper"
  require_file "${PACKAGE_ROOT}/web/index.html"
  require_file "${PACKAGE_ROOT}/geo/geosite.dat"
  require_file "${PACKAGE_ROOT}/geo/geosite.json"
  require_file "${PACKAGE_ROOT}/geo/LICENSE"
  require_file "${PACKAGE_ROOT}/deploy/config/pipeline.json"
  require_file "${PACKAGE_ROOT}/scripts/one-click-install.sh"
  require_file "${PACKAGE_ROOT}/scripts/panel-online-update.sh"
  require_file "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT"
  require_file "${PACKAGE_ROOT}/KIXDNS_SOURCE.json"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_NAME"
  require_file "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_DIGEST"
  require_file "${PACKAGE_ROOT}/KIXDNS_BINARY_SHA256"
  require_file "${PACKAGE_ROOT}/KIXDNS_CAPABILITIES.json"
  require_file "${PACKAGE_ROOT}/SHA256SUMS"
  PANEL_BUILD_COMMIT="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_BUILD_COMMIT")"
  KIXDNS_BUILD_COMMIT="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_BUILD_COMMIT")"
  KIXDNS_SOURCE_ID="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/KIXDNS_ARTIFACT_ID")"
  KIXDNS_SOURCE=fork
  if [[ -f "${PACKAGE_ROOT}/PANEL_RELEASE" ]]; then
    PANEL_RELEASE="$(tr -d '[:space:]' < "${PACKAGE_ROOT}/PANEL_RELEASE")"
    [[ "${PANEL_RELEASE}" =~ ^[0-9A-Za-z._-]{1,100}$ ]] || fail "PANEL_RELEASE 标签无效"
  fi
  [[ "${PANEL_BUILD_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "PANEL_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${KIXDNS_BUILD_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "KIXDNS_BUILD_COMMIT 不是完整提交 SHA"
  [[ "${KIXDNS_SOURCE_ID}" =~ ^[1-9][0-9]*$ ]] || fail "KIXDNS_ARTIFACT_ID 无效"

  (cd "${PACKAGE_ROOT}" && sha256sum --check --quiet SHA256SUMS) || fail "安装包摘要校验失败"

  # 所有提问都在改动主机之前问完；之后的步骤要么全部完成，要么全部回滚。
  # Every question is asked before the host is touched; after that the run either completes or rolls back.
  # R4：先看 panel.env 能不能信，之后读它都照这个 / R4: whether panel.env can be trusted comes first; every later read follows it
  check_panel_env_trust
  refuse_legacy_panel
  # 先把旧版放在面板状态目录里的记录挪进只有 root 能进的地方、验过，再读它们 / First move the records older versions kept in
  # the panel's state directory into the root-only place and check them, then read them
  secure_root_records
  # 上次卸载没恢复完时什么都不问就停下 / When an earlier uninstall did not finish the restore, stop before asking anything
  refuse_unfinished_restore
  load_existing_panel_settings
  validate_panel_only_update
  skip_if_already_installed
  detect_existing_kixdns
  if [[ ${PANEL_ONLY_UPDATE} == false ]]; then
    choose_install_mode
  fi
  determine_install_kind
  validate_install_mode
  require_dedicated_config_directory
  plan_kixdns_changes
  plan_port53
  [[ ${INSTALL_KIND} != reclaim ]] || print_reclaim_plan

  printf '正在安装文件与服务…\n'
  # 从这里起出错或被中断都回滚，连这次建的账号和目录一起删掉 / From here on an error or interruption rolls back, removing
  # the accounts and directories this run created too
  prepare_rollback
  ROOT_WORK_STARTED=true
  # R2：面板账号能写的目录里，root 做的每件事都等面板停了、它的进程都没了以后，再查一遍才做 / R2: everything root does in a
  # directory the panel account can write waits until the panel has stopped and its processes are gone, then is checked once
  # more
  [[ ${PANEL_STOPPED_EARLY} == true ]] || stop_panel_helper
  systemctl stop kixdns-panel.service 2>/dev/null || true
  stop_panel_processes
  record_panel_paths
  require_regular_targets abort_install
  backup_panel_state
  backup_panel_database
  create_accounts
  # 新建的面板账号可能拿到旧账号空出来的 UID，那个 UID 的进程也要停光 / A new panel account may get a UID an old one freed,
  # whose processes must be gone too
  stop_panel_processes
  create_panel_directories
  adopt_github_token
  preserve_external_install
  if [[ ${INSTALL_KIND} == panel-only ]]; then
    installed_kixdns_labels
  fi
  if kixdns_replaced; then
    if [[ ${KIXDNS_RESTART} == true ]]; then
      printf '正在停止 %s 以替换 KixDNS，完成后恢复原状态。\n' "${KIXDNS_SERVICE_UNIT}"
      systemctl stop "${KIXDNS_SERVICE_UNIT}"
    fi
    if [[ ${KIXDNS_BINARY_CHANGED} == true ]]; then
      rm -f -- /var/lib/kixdns-panel/bin/.kixdns.new
      install -o "${PANEL_USER}" -g "${KIXDNS_GROUP}" -m 0750 \
        "${PACKAGE_ROOT}/bin/kixdns" /var/lib/kixdns-panel/bin/.kixdns.new
      mv -fT -- /var/lib/kixdns-panel/bin/.kixdns.new "${MANAGED_KIXDNS_BINARY}"
    fi
  fi
  disable_resolved_stub
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-server" /usr/local/bin/.kixdns-panel-server.new
  mv -fT -- /usr/local/bin/.kixdns-panel-server.new "${PANEL_SERVER_BINARY}"
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/uninstall.sh" /usr/local/bin/.kixdns-panel-uninstall.new
  mv -fT -- /usr/local/bin/.kixdns-panel-uninstall.new /usr/local/bin/kixdns-panel-uninstall
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/one-click-install.sh" /usr/local/libexec/.kixdns-panel-one-click-install.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-one-click-install.new /usr/local/libexec/kixdns-panel-one-click-install
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/scripts/panel-online-update.sh" /usr/local/libexec/.kixdns-panel-online-update.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-online-update.new /usr/local/libexec/kixdns-panel-online-update
  install -o root -g root -m 0755 "${PACKAGE_ROOT}/bin/kixdns-panel-helper" /usr/local/libexec/.kixdns-panel-helper.new
  mv -fT -- /usr/local/libexec/.kixdns-panel-helper.new /usr/local/libexec/kixdns-panel-helper
  install_web
  install_builtin_geo
  install_bundled_metadata
  if [[ ${INSTALL_KIND} == panel-only && -z ${CONFIG_CONVERSION} ]]; then
    update_panel_environment "${KIXDNS_BUILD_COMMIT}" "${KIXDNS_SOURCE_ID}" "${KIXDNS_SOURCE}"
  else
    install_configuration
    request_builtin_geosite_import
  fi
  install_services
  verify_services_started
  ROOT_WORK_STARTED=false
  trap - ERR INT TERM HUP
  rm -rf -- "${BACKUP_ROOT}"

  panel_bind="$(environment_value KIXDNS_PANEL_BIND || true)"
  [[ -n ${panel_bind} ]] || panel_bind=0.0.0.0:5738
  print_summary "$(panel_access_url "${panel_bind}")"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
