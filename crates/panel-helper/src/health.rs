//! `health`：镜像的健康检查（Dockerfile 的 HEALTHCHECK）。面板答得上 `/api/v1/health`、内核没有崩到看管进程放弃，就是健康；
//! 用户自己停了内核、内核正在重拉都不算不健康
//!
//! `health`: the image's health check (the Dockerfile's HEALTHCHECK). Healthy while the panel answers `/api/v1/health`
//! and the kernel has not crashed so often that the supervisor gave up; a kernel the user stopped, or one being brought
//! back, does not make it unhealthy

use std::error::Error;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, clap::Parser)]
#[command(
    name = "health",
    about = "镜像的健康检查：面板答得上、内核没有崩到放弃"
)]
pub struct Args {
    /// 面板的监听地址，和面板读同一个环境变量 / The panel's listen address, from the same variable the panel reads
    #[arg(long, env = "KIXDNS_PANEL_BIND", default_value = "0.0.0.0:5738")]
    bind: SocketAddr,

    /// 看管进程的 helper 套接字 / The supervisor's helper socket
    #[arg(long, default_value = "/run/kixdns-panel/control.sock")]
    socket: PathBuf,
}

pub fn run(args: &Args) -> Result<(), Box<dyn Error>> {
    // 听所有地址的面板从本机回环连 / A panel listening on every address is reached over loopback
    let panel = match args.bind.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::from((Ipv4Addr::LOCALHOST, args.bind.port()))
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::from((Ipv6Addr::LOCALHOST, args.bind.port()))
        }
        _ => args.bind,
    };
    let mut stream = TcpStream::connect_timeout(&panel, TIMEOUT)
        .map_err(|error| format!("连不上面板 {panel}：{error}"))?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.write_all(format!("GET /api/v1/health HTTP/1.0\r\nHost: {panel}\r\n\r\n").as_bytes())?;
    let mut status = [0; 12];
    stream.read_exact(&mut status)?;
    if !status.starts_with(b"HTTP/1.") || &status[8..] != b" 200" {
        return Err(format!(
            "面板的健康检查没有回 200：{}",
            String::from_utf8_lossy(&status)
        )
        .into());
    }

    let mut supervisor = UnixStream::connect(&args.socket)
        .map_err(|error| format!("连不上看管进程 {}：{error}", args.socket.display()))?;
    supervisor.set_read_timeout(Some(TIMEOUT))?;
    supervisor.write_all(b"status")?;
    supervisor.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    supervisor.take(256).read_to_string(&mut reply)?;
    match reply.trim().strip_prefix("OK ") {
        Some(state) if state.starts_with("failed ") => Err(
            "内核连着崩，看管进程已经不再拉起它；看 /data/logs/kixdns.log，在面板里点「启动」再试"
                .into(),
        ),
        Some(_) => Ok(()),
        None => Err(format!("看管进程没有答出内核状态：{}", reply.trim()).into()),
    }
}
