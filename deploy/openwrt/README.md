# 在 OpenWrt 上使用 KixDNS 面板

支持 OpenWrt 24.10 和 25.12，x86_64 和 arm64（`uname -m` 是 `aarch64`）。闪存（overlay）至少留出约 60 MB，
内存建议 256 MB 以上。面板、服务助手和内核都是静态链接的程序，不依赖 opkg 或 apk 装别的包。

> [!IMPORTANT]
> **请打开智能流控。** 它默认是关的，路由器内存又小：不开的话，有设备猛发查询、上游又回得慢时，内核可能被系统因为内存不足
> 杀掉，DNS 跟着断。打开的办法见下面「[启用 DNS](#启用-dns)」。

## 安装

在路由器上执行：

```sh
uclient-fetch -qO- https://raw.githubusercontent.com/tuoro/kixdns-panel/main/deploy/openwrt/one-click-install.sh | sh
```

它会取最新正式版里本架构的安装包，按 GitHub 公布的 SHA-256 校验以后安装。装完用浏览器打开 `http://<路由器 LAN 地址>:5738`，
第一次访问时创建管理员。

- 加 `| sh -s -- --start-dns` 装完就启动 DNS（见下一节）；不加的话内核先不启动，在面板里点「启动」就行。
- 加 `--version v4.3.7` 装指定的版本，加 `--reinstall` 重装同一个版本。
- 不想用一条命令的，也可以到 [Releases](https://github.com/tuoro/kixdns-panel/releases) 下载
  `kixdns-panel-openwrt-<架构>.tar.gz`，解开以后运行 `sh install.sh`。

## 启用 DNS

在面板「系统」页点「启动」。内核会接管 53 端口：

- OpenWrt 自带的 dnsmasq 的 DNS 挪到 5353，DHCP 照常，客户端照样把路由器当 DNS。
- `.lan` 结尾的局域网主机名由内核转给 dnsmasq，照样解析。
- 内核起不来时，10 秒后自动把 53 还给 dnsmasq，局域网不会没有 DNS。

点「停止」时，53 原样还给 dnsmasq。

**然后打开智能流控**：「配置 → 基础设置 → 智能流控」，保存后按提示重启一次 KixDNS。

- **为什么要开。** 内核默认不开流控。有设备一下子发来大量查询、上游又回得慢时，等上游回答的查询越积越多，内核占的内存
  跟着涨。我们在 256 MB 内存、可用约 70 MB 的路由器环境里试过：每秒 8000 个查询、上游 1.5 秒才回，十几秒内内核就被系统
  因为内存不足杀掉。procd 会把它拉起来，但一小时里被杀 5 次就不再拉，DNS 就停了。
- **开了以后。** 同样的情况内核没事：可用内存快不够时，发得多的那台设备收到 SERVFAIL，别的设备照常解析。平时查询不多时
  它什么都不拦。拦了多少、拦的是哪台设备，看面板概览页的「智能流控」卡片。

## 更新

面板和内核都在面板「系统」页在线更新。更新面板时内核不停、DNS 不断，装不成会自动放回原来的版本。
重新运行上面那条安装命令也能升级到最新版。

## 卸载

```sh
sh /usr/libexec/kixdns-panel-uninstall               # 卸掉面板和内核，配置和数据留着，重装就回来
sh /usr/libexec/kixdns-panel-uninstall --purge       # 连配置和数据一起删，找不回来
sh /usr/libexec/kixdns-panel-uninstall --keep-kernel # 只卸面板，内核照常运行
```

卸内核前会先把 53 端口还给 dnsmasq。

## 常用设置

下面的设置都写在 UCI 里，升级不会动它们。第一次设之前先执行：

```sh
touch /etc/config/kixdns-panel && uci set kixdns-panel.main=panel
```

**面板监听的地址。** 面板默认只听 LAN 口的 IPv4 地址，端口 5738，不听 `0.0.0.0`：防火墙一旦配错，WAN 上也打得开面板。
LAN 地址变了，面板会跟着换。要改：

```sh
uci set kixdns-panel.main.bind='0.0.0.0:5738'   # 或只给本机反向代理用：127.0.0.1:5738
uci commit kixdns-panel && /etc/init.d/kixdns-panel reload
```

**查询日志放在哪。** 默认放在内存里，路由器重启后清空：闪存小，也经不起一直写。默认保存 1 天、最多 16 MB，可以在面板
「配置 → 基础设置 → 查询日志」里改，那里会写出这台设备最多能设多大。想长期保留，就放到 U 盘上：

```sh
uci set kixdns-panel.main.querylog_dir='/mnt/sda1/kixdns-querylog'
uci commit kixdns-panel && /etc/init.d/kixdns-panel restart
```

U 盘没挂上时，面板会先放回内存，不会写到闪存上。

**不让内核动 dnsmasq。** 比如你自己另外安排了 53 端口：

```sh
uci set kixdns-panel.main.dnsmasq_handover='0'
uci commit kixdns-panel
```

## 文件放在哪

| 位置 | 内容 |
| --- | --- |
| `/etc/kixdns-panel/` | 面板数据库、内核版本库、身份文件（闪存，重启保留） |
| `/etc/kixdns/pipeline.json` | 内核配置（面板以数据库里的版本为准） |
| `/etc/config/kixdns-panel` | 上面那些 UCI 设置 |
| `/tmp/kixdns-panel/querylog` | 查询日志（内存，重启清空） |
| `/var/log/kixdns.log` | 内核日志（内存，超过 8 MiB 挪到 `kixdns.log.1`） |

## 出了问题

```sh
logread -e kixdns-panel          # 面板、服务助手和在线更新的日志
tail -n 50 /var/log/kixdns.log   # 内核的日志（面板「日志」页里也看得到）
```

DNS 时不时断几秒、内核进程号一直在变：执行 `dmesg | grep -i "killed process"`，看到 `kixdns` 就是内存不够被系统杀了，
打开智能流控（见「[启用 DNS](#启用-dns)」）。

内核日志默认不逐条记查询，免得占满内存。临时要逐条记：`RUST_LOG=info /etc/init.d/kixdns restart`，下次重启就回到默认。

实现细节、自己编译和打包见 [DEVELOPMENT.md](DEVELOPMENT.md)。
