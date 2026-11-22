//! 存新内核前先看空间：只在 musl 版（OpenWrt 这类路由器）上用，systemd 的服务器照旧总是留下上一个。
//!
//! 路由器的 overlay 往往只有几十 MB，内核每份约 9 MB。更新时要多写两份新内核：存进版本目录的一份，
//! 替换前写在程序旁边的临时文件一份；当前内核还没进本地库存时，保留它当上一个还要再存一份。写满 overlay
//! 比不能一键回退糟得多：路由器自己的配置、软件包都写不进去了。所以按剩余空间三选一：
//!
//! - 够留下上一个：照常更新，之后可以一键回退；
//! - 只够放下新内核：先删掉活动版本以外的旧版本，更新后不留上一个，页面说明是空间不够；
//! - 连新内核都放不下：什么都不动，说清要多少、还剩多少。
//!
//! 更新失败时自动换回原来的内核靠的是切换前读进内存的那份，不靠版本目录，所以不留上一个也不会在新内核
//! 起不来时回不去。每一种都给设备留出余量：剩余空间的十分之一，至少 4 MiB。
//!
//! Before storing a new kernel, look at the room left. Used only by musl builds (routers such as `OpenWrt`); systemd servers
//! keep the previous kernel as always.
//!
//! A router's overlay is often a few tens of MB and each kernel about 9 MB. An update writes the new kernel twice: once
//! into the version store and once as the candidate next to the binary; keeping a current kernel that is not in the local
//! store yet as the previous one stores it once more. Filling the overlay is far worse than losing a one-click rollback:
//! the router could no longer save its own config or packages. So by the room left, one of three:
//!
//! - room to keep the previous kernel: update as usual, with a one-click rollback afterwards;
//! - room for the new kernel only: first remove the versions other than the active one, keep no previous kernel after the
//!   update, and say on the page that this is for lack of room;
//! - not even room for the new kernel: touch nothing, and say how much is needed and how much is left.
//!
//! When an update fails, switching back relies on the copy read into memory before the switch, not on the version
//! store, so keeping no previous kernel never strands a kernel that does not start. Each case leaves the device a
//! margin: a tenth of the room left, at least 4 MiB.

use std::path::Path;

use super::UpdateError;

/// 余量的下限 / The least margin left to the device
pub(super) const MIN_MARGIN: u64 = 4 << 20;

/// 这次更新怎么存 / How this update stores kernels
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StoragePlan {
    /// 照常留下上一个 / Keep the previous kernel as usual
    KeepPrevious,
    /// 先删掉活动版本以外的旧版本，更新后不留上一个 / Remove the versions other than the active one first and keep no previous
    /// kernel after the update
    CurrentOnly,
    /// 放不下，不更新 / No room; do not update
    Refuse { needed: u64, available: u64 },
}

/// 算这次更新要的空间 / What the room for this update is reckoned from
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Room {
    /// 版本目录所在的文件系统现在还能写多少 / How much the version store's filesystem can still take now
    pub available: u64,
    /// 删掉活动版本以外的旧版本能腾出多少 / What removing the versions other than the active one frees
    pub reclaimable: u64,
    /// 留下上一个时还要多写的：当前内核还没进本地库存时它的一份 / What keeping the previous kernel adds: the current kernel once
    /// more when it is not in the local store yet
    pub keep_extra: u64,
    /// 新内核这次要写的 / What the new kernel writes this time
    pub incoming: u64,
}

/// 留给设备的余量：剩余空间的十分之一，至少 [`MIN_MARGIN`] / The margin left to the device: a tenth of the room left, at
/// least [`MIN_MARGIN`]
pub(super) fn margin(free: u64) -> u64 {
    (free / 10).max(MIN_MARGIN)
}

pub(super) fn plan(room: Room) -> StoragePlan {
    let keep = room
        .incoming
        .saturating_add(room.keep_extra)
        .saturating_add(margin(room.available));
    if room.available >= keep {
        return StoragePlan::KeepPrevious;
    }
    let total = room.available.saturating_add(room.reclaimable);
    let needed = room.incoming.saturating_add(margin(total));
    if total >= needed {
        StoragePlan::CurrentOnly
    } else {
        StoragePlan::Refuse {
            needed,
            available: total,
        }
    }
}

/// 空间写成保留一位小数的 MiB，比如 `21.8 MiB`：路由器上的用户按 MB 想事 / Room as MiB with one decimal, such as `21.8 MiB`:
/// router owners think in MB
pub(super) fn format_mib(bytes: u64) -> String {
    let tenths = bytes.saturating_mul(10).saturating_add(1 << 19) >> 20;
    format!("{}.{}\u{a0}MiB", tenths / 10, tenths % 10)
}

/// 文件系统上普通用户还能写多少字节 / How many bytes an unprivileged writer can still put on the filesystem
#[cfg(unix)]
pub(super) fn available(path: &Path) -> Result<u64, UpdateError> {
    let stat = rustix::fs::statvfs(path)
        .map_err(|error| UpdateError::Install(format!("读不到剩余空间：{error}")))?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

/// 别的系统不用这一套 / Other systems do not use this
#[cfg(not(unix))]
pub(super) fn available(_path: &Path) -> Result<u64, UpdateError> {
    Ok(u64::MAX)
}

/// 版本目录和程序所在目录是不是同一个文件系统：是的话新内核的两份都算在一处 / Whether the version store and the binary's
/// directory share one filesystem, in which case both copies of the new kernel count against it
#[cfg(unix)]
pub(super) fn same_filesystem(first: &Path, second: &Path) -> Result<bool, UpdateError> {
    use std::os::unix::fs::MetadataExt;

    let device = |path: &Path| {
        std::fs::metadata(path)
            .map(|metadata| metadata.dev())
            .map_err(|error| UpdateError::Install(format!("读不到 {}：{error}", path.display())))
    };
    Ok(device(first)? == device(second)?)
}

#[cfg(not(unix))]
pub(super) fn same_filesystem(_first: &Path, _second: &Path) -> Result<bool, UpdateError> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{MIN_MARGIN, Room, StoragePlan, format_mib, margin, plan};

    /// 一位小数，四舍五入 / One decimal, rounded
    #[test]
    fn room_reads_as_mib_with_one_decimal() {
        assert_eq!(format_mib(0), "0.0\u{a0}MiB");
        assert_eq!(format_mib(22_355 << 10), "21.8\u{a0}MiB");
        assert_eq!(format_mib(4 << 20), "4.0\u{a0}MiB");
        assert_eq!(format_mib((1 << 20) - 1), "1.0\u{a0}MiB");
    }

    const MIB: u64 = 1 << 20;

    /// 新内核两份 18 MiB：空间够就照常留下上一个，当前内核还没进库存时把它那一份也算上
    /// The new kernel twice is 18 MiB: with room the previous one stays, counting the current kernel once more when it
    /// is not in the store yet
    #[test]
    fn room_to_keep_the_previous_kernel() {
        let room = Room {
            available: 64 * MIB,
            reclaimable: 9 * MIB,
            keep_extra: 0,
            incoming: 18 * MIB,
        };
        assert_eq!(plan(room), StoragePlan::KeepPrevious);
        let unstored = Room {
            keep_extra: 9 * MIB,
            ..room
        };
        assert_eq!(plan(unstored), StoragePlan::KeepPrevious);
        // 18 + 9 + 4（余量）= 31 > 30：只能不留上一个，删掉旧版本后放得下
        // 18 + 9 + 4 (margin) = 31 > 30: only without the previous one, which fits once old versions are removed
        let tight = Room {
            available: 30 * MIB,
            ..unstored
        };
        assert_eq!(plan(tight), StoragePlan::CurrentOnly);
    }

    /// 剩余空间只够新内核时，删掉旧版本腾出的空间也算进去；连这样都放不下就不更新，报出要多少、有多少
    /// With room for the new kernel only, what removing old versions frees counts too; when even that is short the update
    /// is refused with what is needed and what is there
    #[test]
    fn room_for_the_new_kernel_only_or_none() {
        let room = Room {
            available: 16 * MIB,
            reclaimable: 9 * MIB,
            keep_extra: 0,
            incoming: 18 * MIB,
        };
        // 16 + 9 = 25 >= 18 + 4
        assert_eq!(plan(room), StoragePlan::CurrentOnly);
        let short = Room {
            available: 12 * MIB,
            reclaimable: 0,
            ..room
        };
        assert_eq!(
            plan(short),
            StoragePlan::Refuse {
                needed: 18 * MIB + MIN_MARGIN,
                available: 12 * MIB,
            }
        );
    }

    /// 余量是剩余空间的十分之一，至少 4 MiB / The margin is a tenth of the room left, at least 4 MiB
    #[test]
    fn the_margin_is_a_tenth_with_a_floor() {
        assert_eq!(margin(0), MIN_MARGIN);
        assert_eq!(margin(20 * MIB), MIN_MARGIN);
        assert_eq!(margin(100 * MIB), 10 * MIB);
        // 大盘照样留十分之一：服务器上不走这一套，路由器上的大 U 盘 overlay 才会走到
        // A large disk still keeps a tenth: servers do not use this, only routers with a large USB overlay get here
        let large = Room {
            available: 1000 * MIB,
            reclaimable: 0,
            keep_extra: 9 * MIB,
            incoming: 18 * MIB,
        };
        assert_eq!(plan(large), StoragePlan::KeepPrevious);
    }
}
