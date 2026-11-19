#!/usr/bin/env bash
set -Eeuo pipefail

# 威胁模型：kixdns-panel 账号当作攻击者，它不能变成 root，也不能左右 root 做什么。root 碰到面板能写的路径、读面板能影响的数据时，
# 都照下面四条（每一处在哪、怎么照做，列在 PR 的清单里）。install.sh 开头是同样的四条。
# Threat model: the kixdns-panel account is treated as an attacker; it must never become root nor steer what root does.
# Wherever root touches a path the panel can write or reads data the panel can influence, these four rules hold (every site
# and how it complies is listed in the PR's inventory). install.sh starts with the same four.
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
#     helper（面板能请它以 root 起在线更新），安装器、卸载器和在线更新器同一时间只跑一个（同一把锁，整个运行都拿着）。
# R2: root never touches a path the panel account can write while any process of that account exists. The panel is
#     stopped, then kill -KILL -1 runs as the account until /proc shows no live process of it (real, effective or saved
#     UID), and once more (changing PIDs or turning non-dumpable does not escape it); the panel stays stopped until every
#     root operation on such paths is finished, the rollback included: files and owners put back, this run's directories
#     and accounts removed, all before the old panel restarts. The online update (--panel-only-update) takes the same
#     path. The helper stops before the panel (the panel can ask it to start an online update as root), and the
#     installer, the uninstaller and the online updater run one at a time (one lock, held for the whole run).
# R3：面板能写的路径上，root 从不跟着符号链接走：chown 用 -h；chmod 只用在照 R2 停了以后、lstat 查过不是符号链接的目录或普通文件上；
#     已有的、面板能写的目录不用 install -d；这些路径上的重定向、sed -i、cp、mv、rm -rf、find -exec 都要先这样查过。
# R3: on panel-writable paths root never follows a symlink: chown with -h; chmod only on a directory or regular file checked
#     by lstat, under R2, to be no symlink; never install -d on an existing directory the panel can write; no redirection,
#     sed -i, cp, mv, rm -rf, find -exec or tar on such paths without the same check.
# R4：panel.env（和 root 读来定路径的别的东西）只有它和上面每一层目录都归 root、别人写不进时才信；不然 KixDNS 配置的路径照 root 才
#     能改的 KixDNS unit 认，对不上就停下，账号、归属这些照它做决定的项一律不认。
# R4: panel.env (and anything else root reads to decide paths) is trusted only when it and every directory above it are
#     root's and not writable by others; otherwise the KixDNS config path is taken from the KixDNS unit only root can
#     change, a mismatch stops the run, and no key that decides accounts or ownership is taken from it.

PANEL_CONFIG_DIRECTORY=/etc/kixdns-panel
PANEL_STATE_DIRECTORY=/var/lib/kixdns-panel
SYSTEMD_UNIT_DIRECTORY=/etc/systemd/system
# systemd 在 /etc/systemd/system 之后找 unit 的目录 / Where systemd looks for units after /etc/systemd/system
SYSTEMD_VENDOR_DIRECTORIES=(/run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system)
PANEL_ENV=/etc/kixdns-panel/panel.env
# 本地的卸载命令随面板一起删掉以后，接着卸载用的是这一份（docs/deployment.md 的「卸载」）。
# Once the local uninstall command is removed with the panel, this copy carries on (「卸载」 in docs/deployment.md).
UNINSTALL_URL="https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh"
# 全新安装时安装器为 KixDNS 配置建的目录；panel.env 记下的配置在这里时，它才随 KixDNS 删掉。
# The directory the installer creates for the KixDNS config on a fresh install; it goes with KixDNS only when the
# config panel.env records is in it.
KIXDNS_CONFIG_DIRECTORY=/etc/kixdns
KIXDNS_RUNTIME_DIRECTORY=/run/kixdns
# panel.env 记下的、面板管理的 KixDNS 配置；迁移来的主机上是原配置的副本。备份里记的是迁移前原来的 KixDNS 的配置。
# The KixDNS config panel.env records, the one the panel manages; on a migrated host it is a copy of the original. The
# backup records the original KixDNS's config from before migration.
MANAGED_CONFIG=""
ORIGINAL_CONFIG=""
# 只有 root 能进的目录，放 root 以后要照着做事的记录：迁移前原来的 KixDNS 的备份、关掉 systemd-resolved 监听时的记录。面板账号
# 写不进这里（旧版放在面板的状态目录里，面板能把它们换掉，见 secure_root_records）。和 install.sh 同一个位置。
# A root-only directory for the records root acts on later: the backup of the original KixDNS from before migration and the
# record of turning systemd-resolved's stub off. The panel account cannot write here (older versions kept them in the
# panel's state directory, where the panel could replace them, see secure_root_records). The same place as install.sh's.
ROOT_RECORDS=/var/lib/kixdns-panel-backup
EXTERNAL_BACKUP=${ROOT_RECORDS}/external-backup
RESOLVED_STATE=${ROOT_RECORDS}/resolved-stub
# root 的 UID；策略测试里换成跑测试的用户 / root's UID; the policy tests put the user running them here
ROOT_UID=0
# R1、R4 查「上面每一层都只有 root 能写」查到这里为止；策略测试里换成临时目录 / R1 and R4 check "every level above is root's
# alone" up to here; the policy tests put their scratch directory here
ROOT_CHAIN_TOP=/
# R4：panel.env 能不能信；不能信时它记的 KixDNS 配置和 unit 名是不是照 unit 对上了 / R4: whether panel.env can be trusted;
# when not, whether the KixDNS config and unit name it records matched the unit
PANEL_ENV_TRUSTED=true
PANEL_ENV_VERIFIED=false
# R2：开头为了挪旧版的记录停了面板，在真的开始卸载之前就退出（取消）时照原样重启它 / R2: the panel stopped at the start to
# move older records is restarted as it was when the run ends (is cancelled) before the uninstall really starts
PANEL_WAS_ACTIVE=false
PANEL_STOPPED_EARLY=false
UNINSTALL_STARTED=false
# R2：面板停下之前先停 helper，结束时照原样重启；照记录停下时面板和 helper 都不重启 / R2: the helper stops before the panel and
# is restarted as it was at the end; a stop over a record restarts neither
HELPER_WAS_ACTIVE=false
KEEP_PANEL_STOPPED=false
# S4：面板配置目录里有 unit 用着的配置，配置到 unit / S4: configs in the panel config directory a unit uses, config to unit
declare -A USED_PANEL_CONFIGS=()
# 和 install.sh 同一把锁（take_root_lock）；/proc 的位置，策略测试里换成临时目录 / The same lock as install.sh's
# (take_root_lock); where /proc is, a scratch directory in the policy tests
ROOT_LOCK=/run/kixdns-panel-root.lock
PROC_ROOT=/proc
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/kixdns-panel.conf
RESOLV_CONF=/etc/resolv.conf
KIXDNS_MANAGED=false
KIXDNS_SERVICE_UNIT=kixdns.service
KIXDNS_ACTION=auto
CONFIG_ACTION=auto
ASSUME_YES=false
PURGE=false
HAS_EXTERNAL_BACKUP=false
ORIGINAL_UNIT=""
ORIGINAL_ENABLED=false
ORIGINAL_ACTIVE=false
RESTORED_EXTERNAL=false
KIXDNS_KEPT_EARLIER=false
# 迁移建的 kixdns 账号和组（备份里记的）：恢复、删除面板数据时一起删 / The kixdns account and group the migration created
# (recorded in the backup): removed with the panel data on a restore
ORIGINAL_USER_CREATED=false
ORIGINAL_GROUP_CREATED=false
# 升级时已经从旧版的原地迁移改管副本（KIXDNS_LEGACY_IN_PLACE）：原配置里是那时面板保存的内容 / An upgrade already moved this
# host from an older in-place migration onto a copy (KIXDNS_LEGACY_IN_PLACE): the original holds what the panel had saved then
ORIGINAL_LEGACY_IN_PLACE=false
# 恢复时交还原配置改了的属主和权限，每行「  路径：改之前 → 现在」/ The owners and modes changed handing the original config
# back on restore, one "  path：before → now" per line
HANDED_BACK=""
# KixDNS 已不归面板管时，保留的 panel.env 记下的待删的东西：面板自己的 KixDNS 已移除、它的配置和 kixdns 账号留着
# （KIXDNS_REMOVED），或者迁移建的 kixdns 账号、组（KIXDNS_USER_CREATED、KIXDNS_GROUP_CREATED）。删除面板数据时一起删。
# What the kept panel.env records as left to remove once the KixDNS is no longer the panel's: the panel's own KixDNS was
# removed, leaving its config and the kixdns account (KIXDNS_REMOVED), or the kixdns account and group a migration created
# (KIXDNS_USER_CREATED, KIXDNS_GROUP_CREATED). They go when the panel data is removed.
LEFT_REMOVED=false
LEFT_USER_CREATED=false
LEFT_GROUP_CREATED=false
# 指向面板目录里、但程序已经不在的 unit：前者由面板创建、随面板移除，后者不是面板创建的、原样保留。
# Units pointing at the panel's kixdns after the binary is gone: panel-created ones go with the panel, others stay.
DEAD_PANEL_UNITS=()
DEAD_FOREIGN_UNITS=()
# 和 install.sh 一样：放回去的原来的 KixDNS 要在这么长时间里起来，并保持同一个主进程这么久。
# As in install.sh: the original KixDNS put back must come up within this long and keep one main process for this long.
SERVICE_WAIT_SECONDS=15
SERVICE_STABLE_SECONDS=4

fail() {
  printf '卸载失败：%s\n' "$*" >&2
  exit 1
}

cancel_uninstall() {
  # 取消是用户的选择，不是失败，所以不带「卸载失败」前缀。
  # Cancelling is the user's choice, not a failure, so it carries no failure prefix.
  printf '已取消卸载，未作任何修改。\n' >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：sudo kixdns-panel-uninstall [选项]

默认通过交互终端依次询问 KixDNS 和配置数据的处理方式。

  --keep-kixdns     仅卸载面板，保留当前 KixDNS
  --remove-kixdns   同时移除面板管理的 KixDNS；迁移过来的会移除增强版、恢复原来的 KixDNS
  --keep-config     保留面板配置、数据库、版本库和 Geo 数据
  --remove-config   删除面板配置与运行数据
  --yes             跳过最终确认；仍须明确指定缺少的处理方式
  --purge           兼容旧命令，等同 --remove-kixdns --remove-config --yes
  -h, --help        显示帮助

无人值守示例：
  sudo kixdns-panel-uninstall --keep-kixdns --keep-config --yes
  sudo kixdns-panel-uninstall --remove-kixdns --remove-config --yes
EOF
}

set_choice() {
  local variable=$1
  local value=$2
  local current=${!variable}
  [[ ${current} == auto || ${current} == "${value}" ]] || fail "存在互相冲突的卸载选项"
  printf -v "${variable}" '%s' "${value}"
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge)
        [[ ${PURGE} == false && ${KIXDNS_ACTION} == auto && ${CONFIG_ACTION} == auto ]] ||
          fail "--purge 不能与其他处理选项同时使用"
        PURGE=true
        KIXDNS_ACTION=remove
        CONFIG_ACTION=remove
        ASSUME_YES=true
        ;;
      --keep-kixdns)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice KIXDNS_ACTION keep
        ;;
      --remove-kixdns)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice KIXDNS_ACTION remove
        ;;
      --keep-config)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice CONFIG_ACTION keep
        ;;
      --remove-config)
        [[ ${PURGE} == false ]] || fail "--purge 不能与其他处理选项同时使用"
        set_choice CONFIG_ACTION remove
        ;;
      --yes) ASSUME_YES=true ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "未知参数 $1" ;;
    esac
    shift
  done
}

# panel.env 里的一项。R4：不能信的 panel.env 里，KixDNS 配置和 unit 名只在照 unit 对上以后才给，别的（归属、待删的账号）一律不给。
# A setting from panel.env. R4: from an untrusted panel.env the KixDNS config and unit name come only once they matched the
# unit, and nothing else (ownership, accounts left to remove) ever does.
environment_value() {
  local key=$1
  [[ -f ${PANEL_ENV} ]] || return 1
  if [[ ${PANEL_ENV_TRUSTED} == false ]]; then
    case ${key} in
      KIXDNS_CONFIG | KIXDNS_SERVICE_UNIT) [[ ${PANEL_ENV_VERIFIED} == true ]] || return 1 ;;
      *) return 1 ;;
    esac
  fi
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${PANEL_ENV}"
}

# 迁移前的备份里的一项；每次都先验（R1）/ A setting from the pre-migration backup, checked every time (R1)
backup_value() {
  local key=$1
  trusted_record external-backup || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${EXTERNAL_BACKUP}/install.env"
}

# R4：panel.env 不能信时，它记的 KixDNS 配置要和 root 才能改的 unit 里写的一样，才照它的配置路径和 unit 名认 KixDNS；对不上就当作
# KixDNS 不归面板管：它、它的配置和 kixdns 账号都保留，不删。说一声。
# R4: when panel.env cannot be trusted, its config path and unit name decide which KixDNS is the panel's only when the
# config it records equals the one in the unit only root can change; otherwise the KixDNS counts as not the panel's and
# it, its config and the kixdns account are all kept, not removed. This is said.
check_panel_env_trust() {
  local unit
  local recorded
  local unit_file
  local unit_config=""
  [[ -e ${PANEL_ENV} || -L ${PANEL_ENV} ]] || return 0
  ! panel_env_trusted || return 0
  PANEL_ENV_TRUSTED=false
  unit="$(state_value "${PANEL_ENV}" KIXDNS_SERVICE_UNIT || true)"
  unit=${unit:-${KIXDNS_SERVICE_UNIT}}
  recorded="$(state_value "${PANEL_ENV}" KIXDNS_CONFIG || true)"
  unit_file="${SYSTEMD_UNIT_DIRECTORY}/${unit}"
  if [[ ${unit} == *.service && ${unit} != */* && ${unit} != *..* ]]; then
    unit_config="$(managed_unit_config "${unit_file}")"
  fi
  if [[ -n ${recorded} && ${recorded} == "${unit_config}" ]]; then
    PANEL_ENV_VERIFIED=true
    printf '%s 面板能改，它记的不能都信：KixDNS 配置照 %s 认（%s），账号和归属这些项这次不照它做。\n' \
      "${PANEL_ENV}" "${unit_file}" "${recorded}"
    return 0
  fi
  printf '%s 面板能改，它记的不能信：它写的 KixDNS 配置和 %s 对不上，这次当作 KixDNS 不归面板管，KixDNS、它的配置和 kixdns 账号都保留。\n' \
    "${PANEL_ENV}" "${unit_file}"
}

unit_runs_managed_binary() {
  local file=$1
  [[ -f ${file} && ! -L ${file} ]] || return 1
  awk -v binary="${PANEL_STATE_DIRECTORY}/bin/kixdns" '
    /^[[:space:]]*ExecStart[[:space:]]*=/ && index($0, binary) { found = 1 }
    END { exit !found }
  ' "${file}"
}

# 这个 unit 跑的不是面板的程序：/etc/systemd/system 里的文件写着别的程序，或者 systemd 实际加载的那一份（可能在
# /usr/local/lib/systemd/system 之类的别处，也可能被 drop-in 改过 ExecStart）跑的是别的程序。没有这个 unit 时不算。
# This unit does not run the panel's program: the file in /etc/systemd/system names another one, or the copy systemd really
# loads (perhaps elsewhere, such as /usr/local/lib/systemd/system, or with ExecStart changed by a drop-in) runs another one.
# A unit that does not exist does not count.
unit_runs_other_program() {
  local unit=$1
  local file=${SYSTEMD_UNIT_DIRECTORY}/${unit}
  local exec_start
  if [[ -f ${file} ]] && ! unit_runs_managed_binary "${file}"; then
    return 0
  fi
  exec_start="$(systemctl show --property=ExecStart --value "${unit}" 2>/dev/null || true)"
  [[ ${exec_start} =~ path=([^[:space:];]+) ]] || return 1
  [[ ${BASH_REMATCH[1]} != "${PANEL_STATE_DIRECTORY}/bin/kixdns" ]]
}

# 保留只对真实存在的程序有意义：普通文件、不是符号链接、可执行。
# Keeping only means something for a binary that is really there: a regular, non-symlink, executable file.
managed_binary_present() {
  local binary=${PANEL_STATE_DIRECTORY}/bin/kixdns
  [[ -f ${binary} && ! -L ${binary} && -x ${binary} ]]
}

# 面板写出的 unit 带面板的 Documentation= 行，或者是安装器渲染的 ExecStart 形状。
# A unit the panel wrote carries the panel's Documentation= line or the ExecStart shape the installer renders.
unit_created_by_panel() {
  local file=$1
  awk -v binary="${PANEL_STATE_DIRECTORY}/bin/kixdns" '
    /^Documentation=https:\/\/github\.com\/tuoro\/kixdns-panel[[:space:]]*$/ { found = 1 }
    $1 == "ExecStart=" binary && $2 == "run" && $3 == "--config" && $4 ~ /^\// &&
      $5 == "--admin-socket" && $6 ~ /^\// && NF == 6 { found = 1 }
    END { exit !found }
  ' "${file}"
}

# 还有 unit 在运行面板目录里的 kixdns 时，就不能整个删掉状态目录。
# While any unit still runs the kixdns inside the panel's state directory, that directory must not be removed wholesale.
managed_binary_in_use() {
  local file
  managed_binary_present || return 1
  for file in "${SYSTEMD_UNIT_DIRECTORY}"/*.service; do
    unit_runs_managed_binary "${file}" && return 0
  done
  return 1
}

detect_kept_kixdns() {
  local file
  local unit
  # 上一次卸载选择保留 KixDNS 并删除配置时，panel.env 已经没了，但 unit 仍在运行面板目录里的程序。
  # 这时按「面板管理、已选择保留」处理；否则第二次卸载会把保留的程序连同状态目录删掉，重启后主机没有 DNS。
  # When an earlier uninstall kept KixDNS and removed the config, panel.env is gone but a unit still
  # runs the binary in the panel's directory. Treat it as panel-managed and kept; otherwise a second run
  # deletes the kept binary with the state directory and the host has no DNS after the next reboot.
  # 程序已经不在（v3.1.1 的重复卸载会删掉它、留下 unit）时没有可保留的东西：不能强制保留，否则删除配置时找不到二进制而失败。
  # When the binary is gone (v3.1.1's repeated uninstall deleted it and left the unit) there is nothing to keep:
  # forcing keep would make removing the config fail on the missing binary.
  for file in "${SYSTEMD_UNIT_DIRECTORY}"/*.service; do
    unit_runs_managed_binary "${file}" || continue
    unit=${file##*/}
    case ${unit} in
      kixdns-panel.service | kixdns-panel-helper.service | kixdns-panel-update.service) continue ;;
    esac
    # 文件写着面板的程序，systemd 却按 drop-in 跑别的：那是别人的服务，不当成面板留下的 / The file names the panel's program
    # but systemd runs another one through a drop-in: someone else's service, not one the panel left
    ! unit_runs_other_program "${unit}" || continue
    if ! managed_binary_present; then
      if unit_created_by_panel "${file}"; then
        DEAD_PANEL_UNITS+=("${unit}")
        printf '%s 指向的 KixDNS 程序已不存在；这个服务由面板创建，随面板一起移除。\n' "${unit}"
      else
        DEAD_FOREIGN_UNITS+=("${unit}")
        printf '%s 指向的 KixDNS 程序已不存在；这个服务不是面板创建的，保留不动。\n' "${unit}"
      fi
      continue
    fi
    KIXDNS_SERVICE_UNIT=${unit}
    KIXDNS_MANAGED=true
    KIXDNS_KEPT_EARLIER=true
    return 0
  done
}

load_settings() {
  local value
  check_panel_env_trust
  if [[ ${PANEL_ENV_TRUSTED} == false && ${PANEL_ENV_VERIFIED} == false ]]; then
    # 认不出哪个 KixDNS 是面板的：都保留（R4）/ Which KixDNS is the panel's cannot be told: everything is kept (R4)
    KIXDNS_MANAGED=false
  elif [[ -f ${PANEL_ENV} ]]; then
    # 现在的安装器不再写 KIXDNS_MANAGEMENT_ENABLED；值是 false 表示 KixDNS 不归面板管：已移除的「仅安装面板」模式留下的，
    # 或者卸载放回了原来的 KixDNS、保留了 panel.env（mark_kixdns_unmanaged）。没有 panel.env 时无法确认归属，同样按不归面板管
    # 处理，宁可保留。
    # Current installers no longer write KIXDNS_MANAGEMENT_ENABLED; false means the KixDNS is not the panel's: left by the
    # removed panel-only mode, or by an uninstall that put the original KixDNS back and kept panel.env
    # (mark_kixdns_unmanaged). Without panel.env ownership is unknown, so keep it.
    value="$(environment_value KIXDNS_MANAGEMENT_ENABLED || true)"
    [[ -z ${value} || ${value} =~ ^(true|false)$ ]] ||
      fail "panel.env 里的 KixDNS 管理模式无效"
    [[ ${value} == false ]] || KIXDNS_MANAGED=true
    value="$(environment_value KIXDNS_SERVICE_UNIT || true)"
    [[ -z ${value} ]] || KIXDNS_SERVICE_UNIT=${value}
    MANAGED_CONFIG="$(environment_value KIXDNS_CONFIG || true)"
    [[ $(environment_value KIXDNS_REMOVED || true) != true ]] || LEFT_REMOVED=true
    [[ $(environment_value KIXDNS_USER_CREATED || true) != true ]] || LEFT_USER_CREATED=true
    [[ $(environment_value KIXDNS_GROUP_CREATED || true) != true ]] || LEFT_GROUP_CREATED=true
  else
    detect_kept_kixdns
  fi
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh).
  [[ ${KIXDNS_SERVICE_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${KIXDNS_SERVICE_UNIT} != *..* ]] ||
    fail "panel.env 里的 KixDNS 服务名称无效"
  if external_backup_present; then
    HAS_EXTERNAL_BACKUP=true
  fi
  # panel.env 说归面板管，可它的 unit 已经换成跑别的程序（保留配置卸载后，用户换上了自己的 KixDNS）：它不再是面板的，
  # 和不归面板管一样整个保留，不停、不删 unit、不删 /etc/kixdns 和 kixdns 账号。看的是 systemd 实际加载的那个 unit，
  # 不只是 /etc/systemd/system 里的文件：用户的 unit 可能放在别处。还有外部备份时不这样认：那是迁移来的主机恢复到一半，
  # unit 是放回去的原 unit，要照旧把恢复做完。
  # panel.env says the panel's, but its unit now runs another program (after a keep-config uninstall the user put their own
  # KixDNS in): it is no longer the panel's and is kept whole, as an unmanaged one is: not stopped, its unit, /etc/kixdns
  # and the kixdns account not removed. What counts is the unit systemd really loads, not only the file in
  # /etc/systemd/system: the user's unit may live elsewhere. Not so with an external backup still there: that is a migrated
  # host part way through a restore, the unit is the original put back, and the restore must finish as before.
  if [[ ${KIXDNS_MANAGED} == true && ${HAS_EXTERNAL_BACKUP} == false ]] && unit_runs_other_program "${KIXDNS_SERVICE_UNIT}"; then
    KIXDNS_MANAGED=false
  fi
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
    if [[ -L ${entry} || ! -f ${entry} ]]; then
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
  # 输出的只有去处，别的都不往标准输出写 / Only the destination goes to standard output
  ensure_root_records > /dev/null
  [[ -d ${ROOT_RECORDS}/quarantine && ! -L ${ROOT_RECORDS}/quarantine ]] ||
    install -d -o root -g root -m 0700 "${ROOT_RECORDS}/quarantine" > /dev/null
  destination="${ROOT_RECORDS}/quarantine/${name}.$(date -u +%Y%m%dT%H%M%SZ).$$"
  if same_filesystem "$(dirname -- "${record}")" "${ROOT_RECORDS}/quarantine"; then
    mv -T -- "${record}" "${destination}"
    printf '%s\n' "${destination}"
  else
    rm -rf -- "${record}"
    printf '\n'
  fi
}

# R1：拒绝一份不能信的记录：先把它挪走（quarantine_record），再停下，说清是哪一份、为什么、它去了哪里、接下来怎么办。参数：记录，
# 记录的名字，哪里不对。
# R1: refuse a record that cannot be trusted: move it away first (quarantine_record), then stop, saying which copy, why,
# where it went and what to do next. Arguments: the record, the record's name, what is wrong.
refuse_record() {
  local destination
  local where
  destination="$(quarantine_record "$1" "$2")"
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
    destination="$(quarantine_record "${old}" "${name}")"
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
      destination="$(quarantine_record "${old}" "${name}")"
      where="已删掉"
      [[ -z ${destination} ]] || where="挪到了 ${destination}"
      printf '%s 没有用（%s）：只有 root 能进的 %s 里已经有一份，用的是那份。\n' "${old}" "${where}" "${new}"
      continue
    fi
    problem="$(record_problem "${old}" "${name}")"
    if [[ -n ${problem} ]]; then
      destination="$(quarantine_record "${old}" "${name}")"
      where="已删掉"
      [[ -z ${destination} ]] || where="挪到了 ${destination}"
      printf '%s 不能信（%s），没有用它（%s）；这台主机就当作没有这份记录。\n' "${old}" "${problem}" "${where}"
      continue
    fi
    ensure_root_records
    if same_filesystem "${PANEL_STATE_DIRECTORY}" "${ROOT_RECORDS}"; then
      mv -T -- "${old}" "${new}"
    else
      rm -rf -- "${new}.incoming"
      cp -a -- "${old}" "${new}.incoming"
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
  if [[ ${fd} =~ ^[0-9]+$ && $(readlink -- "/proc/$$/fd/${fd}" 2>/dev/null) == "${ROOT_LOCK}" ]] && flock -n "${fd}"; then
    return 0
  fi
  exec {ROOT_LOCK_FD}>> "${ROOT_LOCK}"
  flock -n "${ROOT_LOCK_FD}" ||
    fail "另一个安装、卸载或在线更新正在运行（同一时间只能有一个）；等它结束再运行。"
  export KIXDNS_PANEL_ROOT_LOCK_FD=${ROOT_LOCK_FD}
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
  awk -v binary="${PANEL_STATE_DIRECTORY}/bin/kixdns" '
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

# R1：开头挪旧版的记录之前，照 R2 先停面板和它账号的所有进程；在真的开始卸载之前退出（比如取消）时照原样重启面板。
# R1: before records are moved from the old place at the start, stop the panel and every process of its account first (R2);
# when the run ends before the uninstall really starts (a cancel, say), the panel is restarted as it was.
quiesce_for_records() {
  [[ ${PANEL_STOPPED_EARLY} == false ]] || return 0
  if systemctl is-active --quiet kixdns-panel.service 2>/dev/null; then
    PANEL_WAS_ACTIVE=true
  fi
  if systemctl is-active --quiet kixdns-panel-helper.service 2>/dev/null; then
    HELPER_WAS_ACTIVE=true
  fi
  printf '面板能写的 %s 里有旧版记录的名字：先停下面板和它账号的所有进程，再处理它们。\n' "${PANEL_STATE_DIRECTORY}"
  PANEL_STOPPED_EARLY=true
  trap restart_panel_after_early_stop EXIT
  # R2：先停 helper，面板停下时就请不动它以 root 做事 / R2: the helper first, so the panel cannot have it do anything as root
  # while stopping
  systemctl stop kixdns-panel-helper.service 2>/dev/null || true
  systemctl stop kixdns-panel.service 2>/dev/null || true
  stop_panel_processes refuse_with_panel_held
}

# 开头为了记录停下面板，在真的开始卸载之前就退出（取消）时照原样重启 helper 和面板；照记录停下的不重启。
# The panel stopped at the start for the records, and the run ends (is cancelled) before the uninstall really starts: the
# helper and the panel are restarted as they were; not after a stop over a record.
restart_panel_after_early_stop() {
  [[ ${PANEL_STOPPED_EARLY} == true && ${UNINSTALL_STARTED} == false && ${KEEP_PANEL_STOPPED} == false ]] || return 0
  [[ ${HELPER_WAS_ACTIVE} == false ]] || systemctl start kixdns-panel-helper.service 2>/dev/null || true
  [[ ${PANEL_WAS_ACTIVE} == false ]] || systemctl start kixdns-panel.service 2>/dev/null || true
}

# 面板这时是为了记录停着的：还没真的开始卸载 / The panel is stopped for the records right now: the uninstall has not really
# started
panel_held_for_records() {
  [[ ${PANEL_STOPPED_EARLY} == true && ${UNINSTALL_STARTED} == false ]]
}

# 迁移前原来的 KixDNS 的备份。以前重装会把卸载时留下的面板自带 KixDNS 也备份成「原来的」：它跑的是面板状态目录里的程序，
# 放回去就是一个程序已被删掉、却开机启动的服务。这样的备份不算
# The backup of the KixDNS from before migration. An older reinstall also backed up the panel's own KixDNS kept by an
# uninstall as the original: it runs the program in the panel's state directory, so putting it back gave a service enabled
# at boot whose program is gone. Such a backup does not count
external_backup_present() {
  trusted_record external-backup || return 1
  [[ $(backup_value KIXDNS_BINARY || true) != "${PANEL_STATE_DIRECTORY}/bin/kixdns" ]]
}

# 迁移外部 KixDNS 时面板管理的配置副本所在的目录，和 install.sh 的 MIGRATED_KIXDNS_CONFIG_DIRECTORY 是同一个；只有面板会建它。
# The directory of the config copy the panel manages after migrating an external KixDNS, the same as install.sh's
# MIGRATED_KIXDNS_CONFIG_DIRECTORY; only the panel creates it.
migrated_config_directory() {
  printf '%s/kixdns\n' "${PANEL_CONFIG_DIRECTORY}"
}

# panel.env 记下的配置是迁移副本，而且不是原来的 KixDNS 自己的配置（那是配置本来就放在副本位置、原地接管的情况）。
# panel.env names the migration copy as the config, and it is not the original KixDNS's own config (which happens when
# the config already sat where the copy goes and was managed in place).
managed_config_is_copy() {
  [[ ${MANAGED_CONFIG} == "$(migrated_config_directory)/pipeline.json" && ${MANAGED_CONFIG} != "${ORIGINAL_CONFIG}" ]]
}

open_terminal() {
  # 裸 exec 上的重定向会永久生效：写成 `exec 3<>/dev/tty 2>/dev/null` 会让之后所有错误信息消失。
  # A redirection on a bare exec is permanent: `exec 3<>/dev/tty 2>/dev/null` would hide every later error.
  { exec 3<>/dev/tty; } 2>/dev/null ||
    fail "当前没有交互终端；要写明 KixDNS 和配置怎么处理，并加 --yes"
}

close_terminal() {
  exec 3>&- 3<&-
}

choose_kixdns_action() {
  local choice=""
  if [[ ${KIXDNS_KEPT_EARLIER} == true ]]; then
    if [[ ${KIXDNS_ACTION} == remove ]]; then
      printf '上次卸载保留了 KixDNS（%s），面板配置已删除，无法确认如何安全移除；这次同样保留。\n' "${KIXDNS_SERVICE_UNIT}"
    fi
    KIXDNS_ACTION=keep
    return
  fi
  if [[ ${KIXDNS_MANAGED} != true ]]; then
    if [[ ${KIXDNS_ACTION} == remove && ${#DEAD_PANEL_UNITS[@]} -eq 0 && ${#DEAD_FOREIGN_UNITS[@]} -eq 0 ]]; then
      printf '这台机器的 KixDNS 不归面板管理，为防止误删，只卸载面板、保留它。\n'
    fi
    KIXDNS_ACTION=keep
    return
  fi
  [[ ${KIXDNS_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n选择 KixDNS 的处理方式：\n' >&3
  printf '  1. 仅卸载面板，保留当前 KixDNS\n' >&3
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    printf '  2. 移除增强版，恢复原来的 KixDNS\n' >&3
  else
    printf '  2. 同时移除面板管理的 KixDNS\n' >&3
  fi
  printf '  3. 取消卸载（默认）\n' >&3
  printf '选 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) KIXDNS_ACTION=keep ;;
    2) KIXDNS_ACTION=remove ;;
    *) cancel_uninstall ;;
  esac
}

choose_config_action() {
  local choice=""
  [[ ${CONFIG_ACTION} == auto ]] || return 0
  open_terminal
  printf '\n选择配置与运行数据的处理方式：\n' >&3
  printf '  1. 保留配置、数据库、版本库和 Geo 数据\n' >&3
  printf '  2. 删除全部面板配置与运行数据\n' >&3
  printf '  3. 取消卸载（默认）\n' >&3
  printf '选 [1-3]：' >&3
  IFS= read -r choice <&3 || true
  close_terminal
  case ${choice} in
    1) CONFIG_ACTION=keep ;;
    2) CONFIG_ACTION=remove ;;
    *) cancel_uninstall ;;
  esac
}

confirm_uninstall() {
  local answer=""
  [[ ${ASSUME_YES} == true ]] && return
  open_terminal
  printf '\n卸载计划：\n' >&3
  if [[ ${KIXDNS_ACTION} == keep ]]; then
    printf '  - 保留 KixDNS\n' >&3
  elif [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    # 和上面的选项同一句话：迁移过来的主机上，移除的是增强版，原来的 KixDNS 会放回去
    printf '  - 移除增强版，恢复原来的 KixDNS\n' >&3
  else
    printf '  - 移除面板管理的 KixDNS\n' >&3
  fi
  if [[ ${CONFIG_ACTION} == keep ]]; then
    printf '  - 保留面板配置与运行数据\n' >&3
  else
    printf '  - 删除面板配置与运行数据\n' >&3
  fi
  printf '确认继续？[y/N]：' >&3
  IFS= read -r answer <&3 || true
  close_terminal
  [[ ${answer} =~ ^([yY]|[yY][eE][sS])$ ]] || cancel_uninstall
}

validate_non_interactive() {
  if [[ ${ASSUME_YES} == true && (${KIXDNS_ACTION} == auto || ${CONFIG_ACTION} == auto) ]]; then
    fail "--yes 必须与完整的 KixDNS 和配置处理选项一起使用"
  fi
}

load_external_backup() {
  [[ ${HAS_EXTERNAL_BACKUP} == true ]] || return 0
  ORIGINAL_UNIT="$(backup_value KIXDNS_SERVICE_UNIT || true)"
  ORIGINAL_ENABLED="$(backup_value KIXDNS_WAS_ENABLED || true)"
  ORIGINAL_ACTIVE="$(backup_value KIXDNS_WAS_ACTIVE || true)"
  ORIGINAL_CONFIG="$(backup_value KIXDNS_CONFIG || true)"
  [[ $(backup_value KIXDNS_USER_CREATED || true) != true ]] || ORIGINAL_USER_CREATED=true
  [[ $(backup_value KIXDNS_GROUP_CREATED || true) != true ]] || ORIGINAL_GROUP_CREATED=true
  [[ $(backup_value KIXDNS_LEGACY_IN_PLACE || true) != true ]] || ORIGINAL_LEGACY_IN_PLACE=true
  # 规则以 panel-server 的 Operations::new 为准（scripts/test-unit-name-rule.sh 校对）。
  # The rule is panel-server's Operations::new (checked by scripts/test-unit-name-rule.sh).
  [[ ${ORIGINAL_UNIT} =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$ && ${ORIGINAL_UNIT} != *..* ]] ||
    fail "原来的 KixDNS 的备份里，服务名称无效"
  [[ ${ORIGINAL_ENABLED} =~ ^(true|false)$ && ${ORIGINAL_ACTIVE} =~ ^(true|false)$ ]] ||
    fail "原来的 KixDNS 的备份里，运行状态无效"
}

validate_removal_targets() {
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]] && managed_config_is_copy; then
    [[ ! -L ${PANEL_CONFIG_DIRECTORY} ]] || fail "配置目录不能是符号链接"
  fi
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  [[ ! -L ${PANEL_CONFIG_DIRECTORY} && ! -L ${PANEL_STATE_DIRECTORY} ]] ||
    fail "配置目录不能是符号链接"
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == keep ]]; then
    [[ -f ${PANEL_STATE_DIRECTORY}/bin/kixdns && ! -L ${PANEL_STATE_DIRECTORY}/bin/kixdns ]] ||
      fail "找不到需要保留的 KixDNS 二进制"
  fi
}

stop_unit() {
  local unit=$1
  systemctl disable --now "${unit}" 2>/dev/null || true
  systemctl stop "${unit}" 2>/dev/null || true
  systemctl kill --kill-who=all "${unit}" 2>/dev/null || true
  systemctl reset-failed "${unit}" 2>/dev/null || true
}

wait_for_unit_inactive() {
  local unit=$1
  local attempt
  for ((attempt = 0; attempt < 50; attempt++)); do
    systemctl is-active --quiet "${unit}" || return 0
    sleep 0.1
  done
  fail "无法停止服务 ${unit}"
}

remove_account() {
  local account=$1
  getent passwd "${account}" >/dev/null 2>&1 || return 0
  [[ ${account} != kixdns-panel ]] || stop_panel_processes
  userdel "${account}" 2>/dev/null ||
    fail "删不掉账号 ${account}：先停掉这个账号的其他进程"
}

# 这个账号还有进程在跑。不靠 pgrep：精简的系统上没有 procps。/proc 里每个进程目录的属主就是它的有效 UID。
# The account still has processes running. pgrep is not relied on, as minimal systems lack procps: the owner of each
# process directory in /proc is its effective UID.
account_has_processes() {
  local uid
  local entry
  uid="$(id -u "$1" 2>/dev/null)" || return 1
  for entry in /proc/[0-9]*; do
    [[ $(stat -c '%u' -- "${entry}" 2>/dev/null) != "${uid}" ]] || return 0
  done
  return 1
}

# 删掉面板的 kixdns 账号（参数 user 或 user=true）和 kixdns 组（参数 group 或 group=true）。面板的 KixDNS 这时已经停了、unit 已经删了：账号还有进程在跑，
# 或者 systemd 加载的同名 unit 写着用它，就是别人的服务在用（比如保留配置卸载后用户自己装的 KixDNS），账号和组都留着，不去
# 杀它的进程。kixdns-panel 账号的主组也是 kixdns，所以要先删 kixdns-panel。
# Removes the panel's kixdns account (argument user) and kixdns group (argument group). The panel's KixDNS has stopped and
# its unit is gone by now: an account that still has processes, or that the loaded unit of that name says it runs as, is in
# use by someone else's service (the user's own KixDNS installed after a keep-config uninstall, say), so the account and the
# group both stay and its processes are not killed. kixdns-panel has kixdns as its primary group too, so it goes first.
# R2：面板停了，可 kixdns-panel 账号（和旧面板账号留下的 UID）可能还有别的进程，它们还能改面板目录里的东西：以它的身份
# kill -1，一个不留地停掉（quiesce_panel_account）。
# R2: the panel has stopped, but the kixdns-panel account (and UIDs an old panel account left) may have other processes
# that could still change things in the panel's directories: stop every one with kill -1 as that account
# (quiesce_panel_account).
stop_panel_processes() {
  quiesce_panel_account "${1:-fail}" "${PANEL_STATE_DIRECTORY}" "${PANEL_CONFIG_DIRECTORY}" "${KIXDNS_CONFIG_DIRECTORY}" \
    ${MANAGED_CONFIG:+"$(dirname -- "${MANAGED_CONFIG}")"}
}

# 一个能安全交还、能读的文件：普通文件，不是符号链接，只有一个链接（硬链接到别处的，改它就改到别处去了）。
# A file that can be handed back and read safely: a regular file, no symlink, one link only (changing one hard-linked from
# elsewhere would change something else).
plain_single_file() {
  [[ -f $1 && ! -L $1 && $(stat -c '%h' -- "$1") == 1 ]]
}

remove_kixdns_account() {
  local item
  local remove_user=false
  local remove_group=false
  for item in "$@"; do
    case ${item} in
      user | user=true) remove_user=true ;;
      group | group=true) remove_group=true ;;
    esac
  done
  if getent passwd kixdns >/dev/null 2>&1; then
    if account_has_processes kixdns ||
      [[ $(systemctl show --property=User --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true) == kixdns ]]; then
      if [[ ${remove_user} == true || ${remove_group} == true ]]; then
        printf 'kixdns 账号还有别的进程或服务在用，保留它和 kixdns 组。\n'
      fi
      return 0
    fi
    if [[ ${remove_user} == true ]]; then
      userdel kixdns 2>/dev/null || fail "删不掉账号 kixdns：先停掉这个账号的其他进程"
    fi
  fi
  if [[ ${remove_group} == true ]]; then
    groupdel kixdns 2>/dev/null || true
  fi
}

# 面板在 /etc/kixdns 里写的文件：panel.env 记下的配置，和面板写到一半留下的临时文件（.kixdns-panel- 加 6 个字母或数字，
# 见 panel-server 的 temporaries.rs）。参数：文件名，配置的文件名。
# The files the panel writes in /etc/kixdns: the config panel.env records, and the temporary files a write cut short leaves
# (.kixdns-panel- and 6 letters or digits, see panel-server's temporaries.rs). Arguments: the file name, the config's name.
panel_written_config_file() {
  [[ $1 == "$2" || $1 =~ ^\.kixdns-panel-[A-Za-z0-9]{6}$ ]]
}

# 主机上各个 service unit 的 ExecStart 用 -c、--config 或 --config= 指着的配置，一行一个「unit<TAB>配置」。用户自己装的 KixDNS
# 可能就用着面板以前的配置（KixDNS 的文档写的正是 /etc/kixdns/pipeline.json），属主看不出是谁的，只能看有没有 unit 在用：加载了的
# unit 和装着的 unit 文件都算，一次查完。
# The config each service unit's ExecStart names with -c, --config or --config=, one "unit<TAB>config" per line. A KixDNS
# the user installed may use the panel's former config (KixDNS's own docs name exactly /etc/kixdns/pipeline.json), and its
# owner cannot tell whose it is: only whether a unit uses it can. Loaded units and installed unit files both count, all
# asked at once.
configs_named_by_units() {
  local units=()
  local line
  local id=""
  local exec_start=""
  local command
  local commands
  local program
  local rest
  local found
  mapfile -t units < <(
    {
      systemctl list-units --all --type=service --plain --no-legend --no-pager 2>/dev/null || true
      systemctl list-unit-files --type=service --plain --no-legend --no-pager 2>/dev/null || true
    } | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\.service$/) { print $i; break } }' | grep -v '@\.service$' | sort -u
  )
  [[ ${#units[@]} -gt 0 ]] || return 0
  while IFS= read -r line; do
    case ${line} in
      Id=*) id=${line#Id=} ;;
      ExecStart=*) exec_start+=" ${line#ExecStart=}" ;;
      '')
        # 一条命令一条命令地看（systemctl show 里每条是「{ path=程序 ; argv[]=… }」）。S3：看不出指着哪里的配置参数，只在程序是
        # KixDNS 时才算（sh 的 -c、别的程序的相对路径都不是）；任何程序写着的绝对路径都算，留着它不会删错。
        # Command by command (each reads "{ path=program ; argv[]=… }" in systemctl show). S3: a config argument that cannot
        # be told counts only when the program is KixDNS (sh's -c, another program's relative path are not); an absolute
        # path any program names counts, since keeping it cannot remove the wrong thing.
        commands=${exec_start}
        while [[ ${commands} == *"path="* ]]; do
          commands=${commands#*path=}
          command=${commands%%path=*}
          [[ ${command} != "${commands}" ]] || commands=""
          [[ -z ${commands} ]] || commands=${commands#"${command}"}
          program=${command%%[[:space:];]*}
          rest=${command#*"argv[]="}
          found=false
          while [[ ${rest} =~ (^|[[:space:]])(-c|--config)(=|[[:space:]]+)([^[:space:];]+)(.*)$ ]]; do
            found=true
            # 写成变量、说明符或相对路径的看不出指着哪里，前面加 ? / One written as a variable, a specifier or a relative path
            # cannot be told, and gets a leading ?
            if [[ ${BASH_REMATCH[4]} == /* && ${BASH_REMATCH[4]} != *[\$%]* ]]; then
              printf '%s\t%s\n' "${id}" "${BASH_REMATCH[4]}"
            elif [[ ${program##*/} == kixdns ]]; then
              printf '%s\t?%s\n' "${id}" "${BASH_REMATCH[4]}"
            fi
            rest=${BASH_REMATCH[5]}
          done
          # 跑 KixDNS 程序却没写配置参数的，同样看不出 / A KixDNS program with no config argument cannot be told either
          [[ ${found} == true || ${program##*/} != kixdns ]] || printf '%s\t?\n' "${id}"
        done
        id=""
        exec_start=""
        ;;
    esac
  done < <(systemctl show --property=Id --property=ExecStart "${units[@]}" 2>/dev/null || true; printf '\n')
}

# 有 unit 用着、所以不删的配置：归面板的改归 root，组和权限按那个 unit 运行用的账号定（original_config_access），列出改了什么。
# 参数：unit，配置。
# A config kept because a unit uses it: when it is the panel's it goes to root, with the group and mode the account that
# unit runs as decides (original_config_access), and what changed is listed. Arguments: the unit, the config.
hand_named_config_to_root() {
  local unit=$1
  local config=$2
  local directory
  local unit_files=()
  local group
  local mode
  local path
  local before
  local paths=()
  local befores=()
  local changes=""
  directory="$(dirname -- "${config}")"
  for path in "${config}" "${directory}"; do
    [[ -e ${path} ]] || continue
    paths+=("${path}")
    befores+=("$(owner_and_mode "${path}")")
  done
  if plain_single_file "${config}" && panel_owned "${config}"; then
    mapfile -t unit_files < <(kept_unit_files "${unit}")
    read -r group mode < <(original_config_access "${unit_files[@]}")
    chown -h "root:${group}" -- "${config}"
    chmod "$(narrowed_mode "${config}" "${mode}")" -- "${config}"
  fi
  hand_back_directory "${directory}"
  for path in "${!paths[@]}"; do
    before=${befores[${path}]}
    [[ ${before} != "$(owner_and_mode "${paths[${path}]}")" ]] || continue
    changes+="  ${paths[${path}]}：${before} → $(owner_and_mode "${paths[${path}]}")"$'\n'
  done
  if [[ -n ${changes} ]]; then
    printf '%s 还在用 %s，这份配置留着，交还 root：\n%s' "${unit}" "${config}" "${changes}"
  else
    printf '%s 还在用 %s，这份配置留着。\n' "${unit}" "${config}"
  fi
}

# 有 KixDNS 的 unit 的配置参数看不出指着哪里（变量、说明符、相对路径，或者没写），/etc/kixdns 可能就是它用的：整个留着，面板写到
# 一半的临时文件删掉，归面板的文件改归 root，组和权限不变（只去掉组和别人的写权限，不放宽），目录交还 root:root 0755，并说明。
# 参数：目录，unit，参数。
# A KixDNS unit whose config argument cannot be told (a variable, a specifier, a relative path, or none): /etc/kixdns may be
# the one it uses, so it stays whole; panel temporaries go, the panel's files go to root with group and mode as they were
# (only group and others lose write, nothing is widened), the directory is handed back as root:root 0755, and this is said.
# Arguments: the directory, unit, argument.
keep_unclear_kixdns_config() {
  local directory=$1
  local unit=$2
  local argument=$3
  local name
  local path
  while IFS= read -r -d '' name; do
    path=${directory}/${name}
    if [[ ${name} =~ ^\.kixdns-panel-[A-Za-z0-9]{6}$ ]] && panel_owned "${path}"; then
      rm -f -- "${path}"
    elif plain_single_file "${path}" && panel_owned "${path}"; then
      chown -h root -- "${path}"
      chmod go-w -- "${path}"
    fi
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  hand_back_directory "${directory}"
  if [[ -n ${argument} ]]; then
    printf '%s 的配置参数写成 %s，看不出它用的是哪份配置，%s 整个留着，归面板的改归 root。\n' "${unit}" "${argument}" "${directory}"
  else
    printf '%s 跑的 KixDNS 没写配置参数，看不出它用的是哪份配置，%s 整个留着，归面板的改归 root。\n' "${unit}" "${directory}"
  fi
}

# 删除面板数据时，删掉面板为 KixDNS 配置用的 /etc/kixdns：里面只有面板写的文件时整个删掉；还有别的（比如用户自己的 KixDNS
# 的配置）时只删面板写的，目录留着，交还 root。配置不在 /etc/kixdns 时什么也不删。
# Removing the panel data removes the /etc/kixdns the panel used for the KixDNS config: whole when it holds only files the
# panel wrote; with anything else in it (the config of the user's own KixDNS, say) only the panel's files go and the
# directory stays, handed back to root. With the config elsewhere, nothing is removed.
remove_panel_kixdns_config() {
  local config=${MANAGED_CONFIG:-${KIXDNS_CONFIG_DIRECTORY}/pipeline.json}
  local directory=${KIXDNS_CONFIG_DIRECTORY}
  local name
  local others=false
  local unit
  local named
  local unclear=""
  local -A named_by=()
  local kept=()
  [[ $(dirname -- "${config}") == "${directory}" && -d ${directory} && ! -L ${directory} ]] || return 0
  while IFS=$'\t' read -r unit named; do
    if [[ ${named} == \?* ]]; then
      [[ -n ${unclear} ]] || unclear="${unit}"$'\t'"${named#\?}"
      continue
    fi
    [[ ${named} != "${directory}"/* || -n ${named_by[${named}]:-} ]] || named_by[${named}]=${unit}
  done < <(configs_named_by_units)
  if [[ -n ${unclear} ]]; then
    keep_unclear_kixdns_config "${directory}" "${unclear%%$'\t'*}" "${unclear#*$'\t'}"
    return 0
  fi
  while IFS= read -r -d '' name; do
    if ! panel_written_config_file "${name}" "${config##*/}" || [[ -d ${directory}/${name} && ! -L ${directory}/${name} ]]; then
      others=true
    elif [[ -n ${named_by[${directory}/${name}]:-} ]]; then
      # 面板写的，可有 unit 用着：不删 / The panel wrote it, but a unit uses it: not removed
      kept+=("${directory}/${name}")
    fi
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  if [[ ${others} == false && ${#kept[@]} -eq 0 ]]; then
    rm -rf -- "${directory}"
    return 0
  fi
  while IFS= read -r -d '' name; do
    [[ -z ${named_by[${directory}/${name}]:-} ]] || continue
    if panel_written_config_file "${name}" "${config##*/}" && [[ ! -d ${directory}/${name} || -L ${directory}/${name} ]]; then
      rm -f -- "${directory:?}/${name}"
    fi
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  for named in "${kept[@]}"; do
    hand_named_config_to_root "${named_by[${named}]}" "${named}"
  done
  hand_back_directory "${directory}"
  [[ ${others} == false ]] || printf '%s 里还有不是面板写的文件，目录留着，只删了面板写的配置。\n' "${directory}"
}

# S3：交还的文件不放宽权限：算出来的权限和它现在的取交集。参数：文件，算出来的权限。
# S3: a file handed back is never widened: the computed mode intersected with its current one. Arguments: the file, the
# computed mode.
narrowed_mode() {
  printf '%04o\n' "$((8#$2 & 8#$(stat -c '%a' -- "$1")))"
}

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
  awk -v key="${key}" '
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
    find "${backup}" -maxdepth 1 -name 'unit-dropin-*.conf' -printf '%f\n' | sort -t- -k3 -n | sed "s|^|${backup}/|"
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

remove_panel_components() {
  # R2：先停在线更新和 helper，面板停下时就请不动它们以 root 做事 / R2: the online update and the helper first, so the panel
  # cannot have them do anything as root while stopping
  stop_unit kixdns-panel-update.service
  wait_for_unit_inactive kixdns-panel-update.service
  stop_unit kixdns-panel-helper.service
  wait_for_unit_inactive kixdns-panel-helper.service
  stop_unit kixdns-panel.service
  wait_for_unit_inactive kixdns-panel.service
  # R2：服务停了，面板账号的进程也停光，再删东西 / R2: services stopped, the panel account's processes gone too, then removals
  stop_panel_processes
  rm -f -- /etc/systemd/system/kixdns-panel.service
  rm -f -- /etc/systemd/system/kixdns-panel-helper.service
  rm -f -- /etc/polkit-1/rules.d/50-kixdns-panel.rules
  rm -f -- /usr/local/bin/kixdns-panel-server
  rm -f -- /usr/local/bin/kixdns-panel-uninstall
  rm -f -- /usr/local/libexec/kixdns-panel-helper
  rm -f -- /usr/local/libexec/kixdns-panel-one-click-install
  rm -f -- /usr/local/libexec/kixdns-panel-online-update
  rm -rf -- /run/kixdns-panel
  rm -rf -- /usr/share/kixdns-panel
  rm -rf -- /var/lib/kixdns-panel-update
}

remove_dead_kixdns_units() {
  local unit
  for unit in "${DEAD_PANEL_UNITS[@]}"; do
    stop_unit "${unit}"
    wait_for_unit_inactive "${unit}"
    rm -f -- "${SYSTEMD_UNIT_DIRECTORY}/${unit}"
  done
}

remove_managed_kixdns() {
  [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]] || return 0
  stop_unit "${KIXDNS_SERVICE_UNIT}"
  wait_for_unit_inactive "${KIXDNS_SERVICE_UNIT}"
  rm -f -- "${SYSTEMD_UNIT_DIRECTORY}/${KIXDNS_SERVICE_UNIT}"
  rm -f -- "${PANEL_STATE_DIRECTORY}/bin/kixdns" "${PANEL_STATE_DIRECTORY}/bin/.kixdns.new"
  rm -rf -- "${KIXDNS_RUNTIME_DIRECTORY}"
  # 迁移来的主机上，增强版用的是原配置的副本：随增强版一起删掉。原配置一直没动过，不用放回。
  # On a migrated host the enhanced KixDNS ran a copy of the original config: it goes with it. The original was never
  # touched, so there is nothing to put back.
  if managed_config_is_copy; then
    rm -rf -- "$(migrated_config_directory)"
  fi
  if [[ ${HAS_EXTERNAL_BACKUP} == true ]]; then
    trusted_record external-backup || fail "迁移前的备份不见了"
    if [[ -f ${EXTERNAL_BACKUP}/kixdns.service ]]; then
      install -o root -g root -m 0644 "${EXTERNAL_BACKUP}/kixdns.service" \
        "${SYSTEMD_UNIT_DIRECTORY}/${ORIGINAL_UNIT}"
    fi
    hand_back_in_place_config
    RESTORED_EXTERNAL=true
  else
    # 面板自己的 KixDNS 已经移除：保留的 panel.env 不能再说它归面板管，否则以后用户装上同名的 KixDNS，再运行卸载器会把它当成
    # 面板的停掉、删掉。它的配置和 kixdns 账号留着，记下来等删除面板数据时再删。
    # The panel's own KixDNS is gone: the kept panel.env must stop saying it is the panel's, or once the user installs a
    # KixDNS of the same name, running the uninstaller again stops and removes it as the panel's. Its config and the kixdns
    # account stay, recorded to go when the panel data is removed.
    mark_kixdns_unmanaged KIXDNS_REMOVED=true
  fi
}

remove_panel_state() {
  [[ ${CONFIG_ACTION} == remove ]] || return 0
  local state=${PANEL_STATE_DIRECTORY}
  local kept_kixdns=false
  local panel_kixdns_left=false
  rm -f -- "${state}/github-token"
  # 保留的 KixDNS 就在状态目录里：只要还有 unit 指向它，就只删面板自己的数据，绝不整个删目录。
  # The kept KixDNS lives in the state directory: while any unit points at it, remove only the panel's data, never the whole directory.
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == keep ]] || managed_binary_in_use; then
    kept_kixdns=true
    hand_kept_kixdns_to_root
  else
    remove_state_directory "${state}"
  fi
  # 迁移前的备份是面板数据的一部分：恢复时已经用掉；保留 KixDNS 删除数据时和以前一样删掉。只剩空目录时一并删掉。
  # The pre-migration backup is part of the panel data: a restore has used it up already; keeping KixDNS and removing the
  # data removes it as before. The records directory goes too once empty.
  rm -rf -- "${EXTERNAL_BACKUP}"
  rmdir -- "${ROOT_RECORDS}" 2>/dev/null || true
  if [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove && ${HAS_EXTERNAL_BACKUP} == false ]] ||
    [[ ${KIXDNS_MANAGED} == false && ${LEFT_REMOVED} == true ]]; then
    # 全新安装的主机，面板的 KixDNS 这次或上次卸载时移除了：安装器为配置建的 /etc/kixdns 和 kixdns 账号一起删。按 panel.env
    # 记下的配置路径认，配置不在那里就不删别的目录；没记路径的旧 panel.env 按安装器的默认位置。面板账号还在的时候做：交还时列出的
    # 改之前的样子还写得出它的名字。
    # A freshly installed host whose KixDNS this or an earlier uninstall removed: the /etc/kixdns the installer created for
    # the config and the kixdns account go too. It is recognised from the config path panel.env records, and no other
    # directory is removed; an old panel.env without the path means the installer's default location. Done while the panel
    # account still exists, so the before-values listed for what is handed back still name it.
    panel_kixdns_left=true
    remove_panel_kixdns_config
  fi
  collect_used_panel_configs "${kept_kixdns}"
  hand_used_panel_configs_to_root
  remove_account kixdns-panel
  if [[ ${panel_kixdns_left} == true ]]; then
    remove_kixdns_account user group
  elif [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == remove ]]; then
    # 迁移来的主机这次恢复了原来的 KixDNS：只删迁移建的账号和组 / A migrated host whose original KixDNS this run restored:
    # only the account and group the migration created go
    remove_kixdns_account "user=${ORIGINAL_USER_CREATED}" "group=${ORIGINAL_GROUP_CREATED}"
  elif [[ ${KIXDNS_MANAGED} == false ]]; then
    # 上次卸载恢复了原来的 KixDNS、保留了 panel.env：它记下了迁移建的账号和组 / An earlier uninstall restored the original
    # KixDNS and kept panel.env, which records the account and group the migration created
    remove_kixdns_account "user=${LEFT_USER_CREATED}" "group=${LEFT_GROUP_CREATED}"
  fi
  # panel.env 是判断 KixDNS 归属的依据，最后才删：中途失败后重跑仍能认出面板管理的 KixDNS。
  # panel.env is how ownership is decided, so it goes last: a rerun after a mid-way failure still recognises the managed KixDNS.
  remove_panel_config_directory
  print_quarantine_note
}

# S4：面板配置目录里有 unit 用着的配置（保留的 KixDNS 的、迁移副本，或者 v4.3.4 放在 /etc/kixdns-panel 里的）：记下来，删除面板
# 数据时留着。参数：保留了 KixDNS 没有（true/false）。
# S4: configs in the panel config directory that a unit uses (the kept KixDNS's, a migration copy, or one v4.3.4 put in
# /etc/kixdns-panel): recorded so that removing the panel data keeps them. Argument: whether KixDNS was kept (true/false).
collect_used_panel_configs() {
  local kept_kixdns=$1
  local directory=${PANEL_CONFIG_DIRECTORY}
  local unit
  local named
  local config
  USED_PANEL_CONFIGS=()
  [[ -d ${directory} && ! -L ${directory} ]] || return 0
  while IFS=$'\t' read -r unit named; do
    [[ ${named} == "${directory}"/* && -z ${USED_PANEL_CONFIGS[${named}]:-} ]] || continue
    plain_single_file "${named}" || continue
    USED_PANEL_CONFIGS[${named}]=${unit}
  done < <(configs_named_by_units)
  [[ ${kept_kixdns} == true ]] || return 0
  config="$(kept_kixdns_config)"
  if [[ ${config} == "${directory}"/* ]] && plain_single_file "${config}"; then
    USED_PANEL_CONFIGS[${config}]=${USED_PANEL_CONFIGS[${config}]:-${KIXDNS_SERVICE_UNIT}}
  fi
}

# S4：有 unit 用着的、还归面板的配置交给 root，组照用着它的 unit（不放宽），说明改了什么。面板账号还在的时候做，列出的改之前的
# 样子还写得出它的名字。
# S4: the configs a unit uses that are still the panel's go to root, with the group of the unit using them (never wider),
# and what changed is said. Done while the panel account still exists, so the before-values listed still name it.
hand_used_panel_configs_to_root() {
  local config
  for config in "${!USED_PANEL_CONFIGS[@]}"; do
    # 保留的 KixDNS 的配置已经由 hand_kept_kixdns_to_root 交给了 root / The kept KixDNS's config went to root in
    # hand_kept_kixdns_to_root already
    panel_owned "${config}" || continue
    hand_named_config_to_root "${USED_PANEL_CONFIGS[${config}]}" "${config}"
  done
}

# 删除面板配置目录。S4：有 unit 用着的配置在里面时，只留那些配置所在的那一层，别的都删，目录交给 root（组不变、去掉组和别人的写
# 权限）；没有就整个删掉。
# Removing the panel config directory. S4: with configs a unit uses inside, only the level holding them stays, everything
# else goes, and the directory goes to root (group as it was, group and others losing write); otherwise it goes whole.
remove_panel_config_directory() {
  local directory=${PANEL_CONFIG_DIRECTORY}
  local config
  local top
  local name
  local -A tops=()
  if [[ ! -d ${directory} || -L ${directory} ]]; then
    rm -f -- "${directory}"
    return 0
  fi
  if [[ ${#USED_PANEL_CONFIGS[@]} -eq 0 ]]; then
    rm -rf -- "${directory}"
    return 0
  fi
  for config in "${!USED_PANEL_CONFIGS[@]}"; do
    top=${config#"${directory}"/}
    tops[${top%%/*}]=1
  done
  while IFS= read -r -d '' name; do
    [[ -n ${tops[${name}]:-} ]] || rm -rf -- "${directory:?}/${name}"
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
  chown -h root -- "${directory}"
  chmod go-w -- "${directory}"
}

# 卸载以后只有 root 能进的 quarantine 里还有挪走的东西：说一声，留给管理员查看、删掉。
# After the uninstall something moved away is still in the root-only quarantine: say so, for the admin to look at and remove.
print_quarantine_note() {
  [[ -d ${ROOT_RECORDS}/quarantine && ! -L ${ROOT_RECORDS}/quarantine ]] || return 0
  [[ -n "$(find "${ROOT_RECORDS}/quarantine" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]] || return 0
  printf '只有 root 能进的 %s 里还有挪走的、不能信的记录，留着给你查看；不要了就删掉：sudo rm -rf %s\n' \
    "${ROOT_RECORDS}/quarantine" "${ROOT_RECORDS}/quarantine"
}

# 删掉面板的状态目录。它单独挂载时（比如一个文件系统专门放它）删不掉挂载点：里面清空了就留着挂载点、说一声。参数：目录。
# Remove the panel's state directory. When it is mounted on its own (a filesystem kept just for it, say), the mount point
# cannot go: once it is empty, the mount point stays and this is said. Argument: the directory.
remove_state_directory() {
  local state=$1
  rm -rf -- "${state}" 2>/dev/null && return 0
  if mountpoint -q -- "${state}" && [[ -z "$(find "${state}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    printf '%s 是单独挂载的文件系统：里面已经清空，挂载点留着。\n' "${state}"
    return 0
  fi
  fail "删不掉 ${state}"
}

# 一个 unit（默认是保留的 KixDNS 的）里 systemd 加载的那几个文件：主文件和 drop-in，一行一个。
# The files systemd loads for a unit (the kept KixDNS's by default): the main file and the drop-ins, one per line.
kept_unit_files() {
  local unit=${1:-${KIXDNS_SERVICE_UNIT}}
  local fragment
  local dropins
  local file
  fragment="$(systemctl show --property=FragmentPath --value "${unit}" 2>/dev/null || true)"
  printf '%s\n' "${fragment:-${SYSTEMD_UNIT_DIRECTORY}/${unit}}"
  dropins="$(systemctl show --property=DropInPaths --value "${unit}" 2>/dev/null || true)"
  if [[ -n ${dropins} ]]; then
    tr ' ' '\n' <<< "${dropins}"
  else
    for file in "${SYSTEMD_UNIT_DIRECTORY}/${unit}.d"/*.conf; do
      [[ ! -f ${file} ]] || printf '%s\n' "${file}"
    done
  fi
}

# 保留的 KixDNS 读的配置：它的 unit 的 --config，看不出来时用 panel.env 记下的。
# The config the kept KixDNS reads: its unit's --config, or what panel.env records when that cannot be told.
kept_kixdns_config() {
  local exec_start
  exec_start="$(systemctl show --property=ExecStart --value "${KIXDNS_SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ ${exec_start} =~ --config[=[:space:]]+([^[:space:];]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ -n ${MANAGED_CONFIG} ]]; then
    printf '%s\n' "${MANAGED_CONFIG}"
  fi
}

# 保留 KixDNS、删除面板数据时，面板账号随后就删：它名下还留着的东西会归一个空出来的 UID，以后建的账号拿到这个 UID 就能改正在
# 运行的 DNS 的配置。所以在状态目录里只留保留的 KixDNS 要用的：它的程序，它的配置里写着的、状态目录里的文件（比如面板导入的
# GeoSite），和安装器关掉 resolved 监听时的记录（恢复命令要用，本来就归 root）；别的都是面板的数据，删掉。留下的、和它的配置连同
# 所在的目录一起交给 root，组和权限按 systemd 加载的 unit 运行用的账号定（original_config_access）：程序和目录可进可运行，文件只读，
# 不再交给 kixdns 账号自己，DNS 进程改写不了自己的程序和配置。放着别的东西的公共目录（旧版原地迁移留下的）只交还 root:root 0755。
# Keeping KixDNS and removing the panel data, the panel account goes right after: whatever it still owns would fall to a
# freed UID, and a later account given that UID could rewrite the running DNS's config. So the state directory keeps only
# what the kept KixDNS needs: its program, the files in the state directory its config names (such as the GeoSite the panel
# imported), and the record the installer left when it turned resolved's stub off (the restore commands need it, and it is
# root's anyway); everything else is panel data and goes. What is left, and its config with the config's directory, goes to
# root, with group and mode set by the account the loaded unit runs as (original_config_access): the program and directories
# can be entered and run, files only read, and nothing is handed to the kixdns account itself, so the DNS process cannot
# rewrite its own program or config. A shared directory holding other things (left by an older in-place migration) is only
# handed back as root:root 0755.
hand_kept_kixdns_to_root() {
  local state=${PANEL_STATE_DIRECTORY}
  local config
  local directory
  local group
  local mode
  local directory_mode
  local path
  local name
  local unit_files=()
  local -A keep=(["${state}/bin/kixdns"]=1)
  # R1：交给 root 之前先删掉 root 会读的记录名字（这次运行开头已经接手过真的），面板在这之后放进来的也就交不到 root 手里
  # R1: before anything goes to root, the record names root reads are removed (the genuine ones were adopted at the start of
  # this run), so nothing the panel put there since can end up root's
  rm -rf -- "${state}/external-backup" "${state}/resolved-stub"
  mapfile -t unit_files < <(kept_unit_files)
  read -r group mode < <(original_config_access "${unit_files[@]}")
  case ${mode} in
    0600) directory_mode=0700 ;;
    0640) directory_mode=0750 ;;
    *) directory_mode=0755 ;;
  esac
  config="$(kept_kixdns_config)"
  if [[ -n ${config} ]] && plain_single_file "${config}"; then
    # 只留它真要读的 Geo 数据（状态目录的 geo 里的）；配置里写着别的面板数据（比如 panel.db）也不留
    # Only the Geo data it really reads (in the state directory's geo) stays; other panel data the config names (panel.db,
    # say) does not
    while IFS= read -r path; do
      kept_geo_path "${path}" || continue
      keep[${path}]=1
    done < <(grep -oE '"/[^"\\]*"' -- "${config}" 2>/dev/null | sed -e 's/^"//' -e 's/"$//' | sort -u)
  fi
  while IFS= read -r -d '' path; do
    [[ -n ${keep[${path}]:-} ]] || rm -f -- "${path}"
  done < <(find "${state}" \( -type f -o -type l \) -print0)
  find "${state}" -mindepth 1 -depth -type d -empty ! -path "${state}/bin" -delete
  while IFS= read -r -d '' path; do
    [[ -d ${path} && ! -L ${path} ]] || plain_single_file "${path}" || continue
    chown -h "root:${group}" -- "${path}"
    if [[ -d ${path} || ${path} == "${state}/bin/kixdns" ]]; then
      chmod "${directory_mode}" -- "${path}"
    else
      chmod "${mode}" -- "${path}"
    fi
  done < <(find "${state}" ! -type l -print0)
  if [[ -n ${config} ]] && plain_single_file "${config}"; then
    directory="$(dirname -- "${config}")"
    # 面板写到一半留下的临时文件是面板的数据 / Temporary files a panel write cut short are panel data
    while IFS= read -r -d '' name; do
      if [[ ${name} =~ ^\.kixdns-panel-[A-Za-z0-9]{6}$ ]] && panel_owned "${directory}/${name}"; then
        rm -f -- "${directory:?}/${name}"
      fi
    done < <(find "${directory}" -mindepth 1 -maxdepth 1 -printf '%f\0')
    if panel_owned "${config}"; then
      chown -h "root:${group}" -- "${config}"
      chmod "${mode}" -- "${config}"
    fi
    if [[ ! -d ${directory} || -L ${directory} ]]; then
      # 配置所在的目录换成了符号链接：不跟着它改（R3）/ The config's directory became a symlink: not followed (R3)
      :
    elif [[ ${directory} == "${PANEL_CONFIG_DIRECTORY}"/* ]] ||
      { panel_owned "${directory}" && [[ -z $(find "${directory}" -mindepth 1 -maxdepth 1 ! -name "${config##*/}" -print -quit) ]]; }; then
      # 只放着这份配置的目录（包括迁移副本的目录）：交给 unit 运行用的组 / A directory holding this config alone (the
      # migration copy's included): handed to the group the unit runs as
      chown -h "root:${group}" -- "${directory}"
      chmod "${directory_mode}" -- "${directory}"
      if [[ ${directory} == "${PANEL_CONFIG_DIRECTORY}"/* && -d ${PANEL_CONFIG_DIRECTORY} && ! -L ${PANEL_CONFIG_DIRECTORY} ]]; then
        chown -h "root:${group}" -- "${PANEL_CONFIG_DIRECTORY}"
        chmod "${directory_mode}" -- "${PANEL_CONFIG_DIRECTORY}"
      fi
    elif panel_owned "${directory}"; then
      hand_back_directory "${directory}"
    fi
  fi
  printf '保留的 KixDNS 用到的程序、配置和文件改归 root，面板的其他数据已删除。\n'
}

# 保留的 KixDNS 的配置里写着、要留下的 Geo 文件：绝对路径，在状态目录的 geo/ 下面，没有空白、控制字符，没有 . 或 .. 这样的一段，
# 是普通文件、只有一个链接。别的都不留。参数：路径。
# A Geo file the kept KixDNS's config names and that stays: an absolute path under the state directory's geo/, with no
# whitespace, no control character, no . or .. segment, a regular file with one link. Nothing else stays. Argument: the path.
kept_geo_path() {
  local path=$1
  [[ ${path} == "${PANEL_STATE_DIRECTORY}/geo/"?* && ${path} != *[[:space:][:cntrl:]]* ]] || return 1
  [[ ${path}/ != */./* && ${path}/ != */../* && ${path} != *//* ]] || return 1
  plain_single_file "${path}"
}

state_value() {
  local file=$1
  local key=$2
  [[ -f ${file} ]] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

# 与 install.sh 的 restore_resolved_stub 保持一致：卸载器单独分发，不能 source 安装器。
# Mirrors install.sh's restore_resolved_stub: the uninstaller ships on its own and cannot source the installer.
restore_resolved_stub() {
  local state=${RESOLVED_STATE}/install.env
  local kind
  local target
  trusted_record resolved-stub || return 0
  kind="$(state_value "${state}" RESOLV_CONF_KIND || true)"
  target="$(state_value "${state}" RESOLV_CONF_TARGET || true)"
  if [[ ${KIXDNS_ACTION} == keep ]]; then
    # 保留的 KixDNS 还在用这个端口，恢复 resolved 的监听会让它下次启动失败。
    # The kept KixDNS still uses the port; restoring resolved's stub would break its next start.
    printf 'systemd-resolved 的本机监听保持关闭，保留的 KixDNS 继续使用 53 端口。以后要恢复：\n'
    printf '  sudo rm %s\n' "${RESOLVED_DROPIN}"
    if [[ ${kind} == symlink && -n ${target} ]]; then
      printf '  sudo ln -sfn %s %s\n' "${target}" "${RESOLV_CONF}"
    elif [[ ${kind} == file ]]; then
      # 现在的 resolv.conf 是指向上游列表的链接；不加 --remove-destination，cp 会顺着链接改写上游列表。
      # resolv.conf is now a link to the uplink list; without --remove-destination cp would write through it.
      printf '  sudo cp -a --remove-destination %s/resolv.conf %s\n' "${RESOLVED_STATE}" "${RESOLV_CONF}"
    fi
    printf '  sudo systemctl restart systemd-resolved\n'
    return 0
  fi
  rm -f -- "${RESOLVED_DROPIN}"
  if [[ $(state_value "${state}" RESOLVED_DROPIN_DIRECTORY_CREATED || true) == true ]]; then
    rmdir -- "$(dirname -- "${RESOLVED_DROPIN}")" 2>/dev/null || true
  fi
  case ${kind} in
    symlink) [[ -z ${target} ]] || ln -sfn -- "${target}" "${RESOLV_CONF}" ;;
    file)
      rm -f -- "${RESOLV_CONF}"
      cp -a -- "${RESOLVED_STATE}/resolv.conf" "${RESOLV_CONF}"
      ;;
  esac
  systemctl restart systemd-resolved.service || true
  rm -rf -- "${RESOLVED_STATE}"
  printf 'systemd-resolved 的本机监听与 %s 已恢复原样。\n' "${RESOLV_CONF}"
}

# 原来的 KixDNS 没能按迁移前的状态起来：备份和 panel.env 都还在，用同样的选项重新运行卸载就从头接着恢复。本地的卸载命令已经
# 随面板删掉，给出从网上运行的写法。
# The original KixDNS did not come back as it was before migration: the backup and panel.env are still there, and running
# the uninstall again with the same options carries the restore through. The local uninstall command is gone with the
# panel, so the way to run it from the web is given.
restore_incomplete() {
  # 给有意留下的备份标上「恢复没做完」和这次的选项：安装器看到它，就不会把它当成旧卸载器留下的过期备份、换成恢复到一半的
  # 样子，而是让人先把卸载做完（install.sh 的 refuse_unfinished_restore）。恢复做完时它随备份一起删掉。
  # Mark the backup left on purpose as "restore not finished", with this run's options: seeing it, the installer does not
  # take it for a stale backup an older uninstaller left and replace it with the half-restored state, but asks for the
  # uninstall to be finished first (refuse_unfinished_restore in install.sh). It goes with the backup once the restore is done.
  printf -- '--%s-config\n' "${CONFIG_ACTION}" > "${EXTERNAL_BACKUP}/restore-incomplete" 2>/dev/null || true
  fail "原来的 KixDNS（${ORIGINAL_UNIT}）没能按迁移前的状态恢复，备份还在 ${EXTERNAL_BACKUP}。
查明原因（journalctl -u ${ORIGINAL_UNIT} -n 50 --no-pager）后用同样的选项重新运行卸载，会接着恢复：
  curl -fsSL ${UNINSTALL_URL} | sudo bash -s -- --remove-kixdns --${CONFIG_ACTION}-config --yes"
}

# 原来的 KixDNS 放回去以后，这台主机上的 KixDNS 就不归面板管了：在保留的 panel.env 里记下，再运行卸载器不会把它当成面板的
# 去停、去删（备份已经用掉，靠它认不出来了）。用的是已移除的「仅安装面板」模式留下的同一个键：v3.1.1 起的卸载器都这样认它，
# 安装器重新安装时会删掉它。
# Once the original KixDNS is back, the KixDNS on this host is no longer the panel's: the kept panel.env records it, so
# running the uninstaller again does not stop or remove it as the panel's (the backup is used up and can no longer tell).
# It is the same key the removed panel-only mode left: uninstallers since v3.1.1 all read it this way, and the installer
# drops it on a reinstall.
# 参数是要一起记下的、等删除面板数据时再删的东西（KIXDNS_REMOVED=true、KIXDNS_USER_CREATED=true 之类，见 LEFT_REMOVED）。
# The arguments are what to record with it, left to go when the panel data is removed (KIXDNS_REMOVED=true,
# KIXDNS_USER_CREATED=true and so on, see LEFT_REMOVED).
mark_kixdns_unmanaged() {
  local temporary
  local extra
  [[ -f ${PANEL_ENV} ]] || return 0
  extra="$(printf '%s\n' "$@")"
  temporary="$(mktemp "${PANEL_CONFIG_DIRECTORY}/.panel.env.XXXXXX")"
  awk -v extra="${extra}" '
    !/^KIXDNS_(MANAGEMENT_ENABLED|REMOVED|USER_CREATED|GROUP_CREATED)=/ { print }
    END { print "KIXDNS_MANAGEMENT_ENABLED=false"; if (extra != "") print extra }
  ' "${PANEL_ENV}" > "${temporary}"
  chown --reference="${PANEL_ENV}" -- "${temporary}"
  chmod --reference="${PANEL_ENV}" -- "${temporary}"
  mv -fT -- "${temporary}" "${PANEL_ENV}"
}

port_accepts_connection() {
  local host=$1
  local port=$2
  # install.sh 不要求 curl；bash 自带的 /dev/tcp 足够确认端口在接受连接。
  # install.sh does not require curl; bash's own /dev/tcp is enough to see the port accepting connections.
  # shellcheck disable=SC2016 # $1/$2 由内层 bash 展开 / expanded by the inner bash
  timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "${host}" "${port}" 2>/dev/null
}

# 和 install.sh 的同名函数一字不差（scripts/test-uninstall-policy.sh 校对）：卸载器单独分发，不能 source 安装器。
# Identical to install.sh's function of the same name (checked by scripts/test-uninstall-policy.sh): the uninstaller ships
# on its own and cannot source the installer.
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

# 旧版安装器原地迁移、还没升级改管副本就直接恢复的主机：原配置和它所在的目录还归面板（kixdns-panel 账号删掉以后就归了一个不存在
# 的 UID，以非 root 账号运行的原来的 KixDNS 也读不到）。启动原来的 KixDNS 之前，像升级时那样交还给它（hand_back_original_config），
# 记下改了什么。面板自己目录里的不动。
# A host an older installer migrated in place and restored without an upgrade having moved it onto a copy: the original
# config and its directory still belong to the panel (to a UID that no longer exists once the kixdns-panel account goes, and
# out of reach of an original KixDNS running as a non-root account). Before the original KixDNS starts, hand them back to it
# as an upgrade does (hand_back_original_config) and record what changed. Nothing in the panel's own directory is touched.
hand_back_in_place_config() {
  local unit_files=()
  local directory
  local path
  local before
  local paths=()
  local befores=()
  [[ -n ${ORIGINAL_CONFIG} && ${ORIGINAL_CONFIG} == "${MANAGED_CONFIG}" ]] || return 0
  [[ -z $(backup_value KIXDNS_MANAGED_CONFIG || true) ]] || return 0
  case ${ORIGINAL_CONFIG} in
    "${PANEL_CONFIG_DIRECTORY}"/* | "${PANEL_STATE_DIRECTORY}"/*) return 0 ;;
  esac
  directory="$(dirname -- "${ORIGINAL_CONFIG}")"
  for path in "${directory}" "${ORIGINAL_CONFIG}"; do
    [[ -e ${path} ]] || continue
    paths+=("${path}")
    befores+=("$(owner_and_mode "${path}")")
  done
  mapfile -t unit_files < <(original_unit_files "${EXTERNAL_BACKUP}" "${ORIGINAL_UNIT}")
  hand_back_original_config "${ORIGINAL_CONFIG}" "${unit_files[@]}"
  for path in "${!paths[@]}"; do
    before=${befores[${path}]}
    [[ ${before} != "$(owner_and_mode "${paths[${path}]}")" ]] || continue
    HANDED_BACK+="  ${paths[${path}]}：${before} → $(owner_and_mode "${paths[${path}]}")"$'\n'
  done
}

# 保留 KixDNS 和面板数据（--keep-kixdns --keep-config）的旧版原地迁移、没升级过的主机：面板的 KixDNS 接着用原配置，可旧版把
# 原配置所在的目录（可能是 /etc 这样的公共目录）交给了面板。面板卸载了，目录交还 root:root 0755（hand_back_directory）并列出来；
# 配置文件留给接着运行的 KixDNS 读（它和面板账号、面板数据一起留着），以后重装时升级会交还它。
# A host an older version migrated in place and never upgraded, uninstalled keeping KixDNS and the panel data
# (--keep-kixdns --keep-config): the panel's KixDNS goes on with the original config, but the older version gave the panel
# the original's directory (a shared one such as /etc, maybe). The panel is gone, so the directory goes back as
# root:root 0755 (hand_back_directory) and is listed; the config file stays readable for the KixDNS that keeps running
# (it stays with the panel account and data), and a later reinstall hands it back when it upgrades.
hand_back_kept_in_place_directory() {
  local config
  local directory
  local before
  local after
  [[ ${KIXDNS_MANAGED} == true && ${KIXDNS_ACTION} == keep && ${CONFIG_ACTION} == keep && ${HAS_EXTERNAL_BACKUP} == true ]] ||
    return 0
  config="$(backup_value KIXDNS_CONFIG || true)"
  [[ -n ${config} && ${config} == "${MANAGED_CONFIG}" && -z $(backup_value KIXDNS_MANAGED_CONFIG || true) ]] || return 0
  directory="$(dirname -- "${config}")"
  [[ -d ${directory} && ! -L ${directory} ]] || return 0
  before="$(owner_and_mode "${directory}")"
  hand_back_directory "${directory}"
  after="$(owner_and_mode "${directory}")"
  [[ ${before} != "${after}" ]] || return 0
  printf '旧版迁移时把原配置所在的目录交给了面板，面板卸载以后交还：\n  %s：%s → %s\n' "${directory}" "${before}" "${after}"
}

restore_external_state() {
  [[ ${RESTORED_EXTERNAL} == true ]] || return 0
  if [[ ${ORIGINAL_ENABLED} == true ]]; then
    systemctl enable "${ORIGINAL_UNIT}" --quiet || restore_incomplete
  else
    systemctl disable "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  if [[ ${ORIGINAL_ACTIVE} == true ]]; then
    systemctl start "${ORIGINAL_UNIT}" || restore_incomplete
    # start 在 Type=simple 的服务 fork 以后就返回 0：起来又崩溃的不算恢复。
    # start returns 0 once a Type=simple service forks: one that comes up and crashes is not restored.
    wait_for_service_stable "${ORIGINAL_UNIT}" || restore_incomplete
  else
    systemctl stop "${ORIGINAL_UNIT}" 2>/dev/null || true
  fi
  # 恢复做完才用掉备份：先记下 KixDNS 已不归面板管，再删备份。中途失败时备份还在，重新运行能接着恢复；以后再迁移，安装器按那时
  # 主机上的 KixDNS 重新备份，不会沿用这份旧的。
  # The backup is used up only once the restore is done: first record that the KixDNS is no longer the panel's, then remove
  # the backup. A failure part way leaves the backup, so a rerun carries the restore through; a later migration backs up
  # the KixDNS the host has then instead of keeping this old one.
  # 迁移建的 kixdns 账号和组随备份记录一起带进 panel.env，以后删除面板数据时再删 / The record of the kixdns account and group
  # the migration created moves into panel.env with it, so a later removal of the panel data removes them then
  mark_kixdns_unmanaged "KIXDNS_USER_CREATED=${ORIGINAL_USER_CREATED}" "KIXDNS_GROUP_CREATED=${ORIGINAL_GROUP_CREATED}"
  rm -rf -- "${EXTERNAL_BACKUP}"
  rmdir -- "${ROOT_RECORDS}" 2>/dev/null || true
  printf '原来的 KixDNS 已恢复，运行状态和迁移前一样。\n'
  if [[ -n ${ORIGINAL_CONFIG} && ${ORIGINAL_CONFIG} == "${MANAGED_CONFIG}" ]]; then
    # 旧版安装器原地迁移的主机：面板改的就是原配置，迁移前的内容没有留底，不能说成恢复了。
    # A host an older installer migrated in place: the panel edited the original config itself and the pre-migration
    # content was never kept, so it must not read as restored.
    printf '它用的配置 %s 是面板最后保存的内容：旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底。\n' "${ORIGINAL_CONFIG}"
    if [[ -n ${HANDED_BACK} ]]; then
      printf '旧版迁移时把原配置交给了面板，没有记下它原来的属主和权限，交还给原来的 KixDNS 时改成：\n%s' "${HANDED_BACK}"
    fi
  elif [[ ${ORIGINAL_LEGACY_IN_PLACE} == true ]] && managed_config_is_copy && [[ -f ${ORIGINAL_CONFIG} ]]; then
    # 升级时才从旧版的原地迁移改管副本：原配置里留的是那时面板保存的内容，同样不是迁移前的。
    # Moved onto a copy only at an upgrade from an older in-place migration: the original holds what the panel had saved
    # then, which is not the pre-migration content either.
    printf '它用的配置 %s 是升级到新版那时面板保存的内容（旧版安装器迁移时直接改用了这个文件，迁移前的内容没有留底），之后改的副本已删除。\n' \
      "${ORIGINAL_CONFIG}"
  elif managed_config_is_copy && [[ -f ${ORIGINAL_CONFIG} ]]; then
    printf '它用的是迁移前的配置 %s，面板改过的副本已删除。\n' "${ORIGINAL_CONFIG}"
  fi
}

print_result() {
  printf 'KixDNS 面板已卸载。\n'
  if [[ ${#DEAD_PANEL_UNITS[@]} -gt 0 || ${#DEAD_FOREIGN_UNITS[@]} -gt 0 ]]; then
    printf '面板目录里的 KixDNS 程序已不存在，没有可保留的 KixDNS。\n'
  elif [[ ${KIXDNS_ACTION} == keep ]]; then
    printf 'KixDNS 已保留并继续独立运行。\n'
  elif [[ ${RESTORED_EXTERNAL} == false ]]; then
    printf '面板管理的 KixDNS 已移除。\n'
  fi
  if [[ ${CONFIG_ACTION} == keep ]]; then
    printf '面板配置与运行数据已保留，可供以后重新安装。\n'
  else
    printf '面板配置与运行数据已删除。\n'
  fi
}

main() {
  parse_arguments "$@"
  [[ ${EUID} -eq 0 ]] || fail "要用 root 权限运行"
  command -v systemctl >/dev/null 2>&1 || fail "系统未安装 systemd"
  command -v flock >/dev/null 2>&1 || fail "系统缺少 flock"
  # 同一时间只跑一个安装、卸载或在线更新，整个运行都拿着锁 / One install, uninstall or online update at a time, the lock held
  # for the whole run
  take_root_lock
  run_uninstall
}

# 权限检查之后的全部步骤；拆出来是为了策略测试能在临时目录里把整个流程连跑两次。
# Every step after the privilege checks; split out so the policy test can run the whole flow twice in a temporary tree.
run_uninstall() {
  # 先把旧版放在面板状态目录里的记录挪进只有 root 能进的地方、验过，再读它们 / First move the records older versions kept in
  # the panel's state directory into the root-only place and check them, then read them
  secure_root_records
  load_settings
  validate_non_interactive
  choose_kixdns_action
  choose_config_action
  confirm_uninstall
  if [[ ${HAS_EXTERNAL_BACKUP} == true && ${KIXDNS_ACTION} == remove ]]; then
    load_external_backup
  fi
  validate_removal_targets
  # 从这里起真的开始卸载：开头为了挪记录停下的面板不再重启 / The uninstall really starts here: the panel stopped at the start to
  # move records is not restarted any more
  UNINSTALL_STARTED=true
  remove_panel_components
  # 面板停了：它的账号的进程也一个不留地停掉，之后在面板的目录里查过再做的事才不会被半路换掉
  # The panel has stopped: every process of its account goes too, so what is checked and done in its directories afterwards
  # cannot be swapped half way
  stop_panel_processes
  remove_dead_kixdns_units
  remove_managed_kixdns
  hand_back_kept_in_place_directory
  restore_resolved_stub
  systemctl daemon-reload
  # 先把原来的 KixDNS 恢复完，再删面板数据：恢复中途失败时 panel.env 和备份都还在，重新运行能认出、接着恢复。
  # Finish restoring the original KixDNS before the panel data goes: a restore failing part way leaves panel.env and the
  # backup, so a rerun recognises it and carries on.
  restore_external_state
  remove_panel_state
  print_result
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
