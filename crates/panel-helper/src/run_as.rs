//! `run-as`：看管进程降权以后再执行内核和面板。工作区不许写 unsafe，fork 以后、exec 以前插不进代码，所以看管进程以 root
//! 起一个自己（`/proc/self/exe run-as …`），由它换成目标用户、只留该留的能力，再 exec 目标程序：root 自己从不执行面板写得进的
//! 文件（/data 里在线装的内核和面板）
//!
//! `run-as`: the supervisor runs the kernel and the panel with lowered privileges. The workspace forbids unsafe, so no code
//! can run between fork and exec; the supervisor, as root, starts itself (`/proc/self/exe run-as …`), which becomes the
//! target user, keeps only the capability it should, and execs the target program: root itself never executes a file the
//! panel can write (the kernels and panels installed online under /data)

use std::error::Error;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::process::Command;

use rustix::fs::Mode;
use rustix::process::{Gid, Resource, Rlimit, Uid, getgid, getuid, setrlimit, umask};
use rustix::thread::{
    CapabilitySet, CapabilitySets, capabilities, configure_capability_in_ambient_set,
    set_capabilities, set_keep_capabilities, set_no_new_privs, set_thread_groups,
    set_thread_res_gid, set_thread_res_uid,
};

#[derive(Debug, clap::Parser)]
#[command(name = "run-as", about = "看管进程内部用：降权后执行一个程序")]
pub struct Args {
    #[arg(long)]
    uid: u32,

    #[arg(long)]
    gid: u32,

    /// 把 `CAP_NET_BIND_SERVICE` 交给它（自己有时），内核才能听 53 这样的低端口
    /// Hand it `CAP_NET_BIND_SERVICE` (when held), so the kernel can listen on low ports such as 53
    #[arg(long)]
    bind_service: bool,

    /// 文件描述符上限，软的硬的都设成它 / The file descriptor limit, both soft and hard
    #[arg(long)]
    nofile: Option<u64>,

    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    command: Vec<OsString>,
}

/// 只在出错时返回：成功时这个进程已经变成了目标程序 / Returns only on failure: on success this process has become the target
pub fn run(args: &Args) -> Result<(), Box<dyn Error>> {
    if let Some(limit) = args.nofile {
        setrlimit(
            Resource::Nofile,
            Rlimit {
                current: Some(limit),
                maximum: Some(limit),
            },
        )?;
    }
    let bind = CapabilitySet::NET_BIND_SERVICE;
    let keep = args.bind_service && capabilities(None)?.permitted.contains(bind);
    let (uid, gid) = (Uid::from_raw(args.uid), Gid::from_raw(args.gid));
    // 已经是目标用户（看管进程不是 root 时，比如测试里）就没什么可换的；这个进程只有一个线程，按线程换就是整个进程
    // Already the target user (a supervisor that is not root, in tests say) has nothing to change; this process has a single
    // thread, so the per-thread calls change the whole process
    if getuid() != uid || getgid() != gid {
        set_keep_capabilities(keep)?;
        set_thread_groups(&[])?;
        set_thread_res_gid(gid, gid, gid)?;
        set_thread_res_uid(uid, uid, uid)?;
    }
    // 换用户时留下的能力里只要这一个，并放进 ambient 集合，exec 以后它还在（和 systemd 的 AmbientCapabilities 一样）
    // Of the capabilities kept across the user change only this one stays, raised into the ambient set so it survives the
    // exec (as systemd's AmbientCapabilities does)
    if keep {
        set_capabilities(
            None,
            CapabilitySets {
                effective: bind,
                permitted: bind,
                inheritable: bind,
            },
        )?;
        configure_capability_in_ambient_set(bind, true)?;
    }
    set_no_new_privs(true)?;
    // 和 systemd 的 UMask=0027 一样：写出来的配置、数据 kixdns 组读得到，别人读不到
    // As systemd's UMask=0027: the config and data written are readable by the kixdns group and nobody else
    umask(Mode::from_raw_mode(0o027));
    let error = Command::new(&args.command[0])
        .args(&args.command[1..])
        .exec();
    Err(format!("执行 {} 失败：{error}", args.command[0].to_string_lossy()).into())
}
