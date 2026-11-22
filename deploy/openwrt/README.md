# OpenWrt / procd 部署说明

面板默认假定系统里有 systemd 和 journalctl。OpenWrt 没有这两样，所以面板带了一层
可替换的服务后端，并用 procd init 脚本 + 参数把三条路径换掉：

| 上游行为 | OpenWrt 上的替代 | 开关 |
| --- | --- | --- |
| `systemctl show --property=ActiveState,SubState,MainPID` 读服务状态 | `ubus call service list`（能分清「用户停掉」和「崩了没被拉起」），ubus 用不了才退回 pidfile + `/proc/<pid>` | `--service-pidfile` |
| `journalctl -u kixdns -o json` 读日志 | 直接读内核日志文件（只读末尾 8 MiB，游标=文件绝对字节偏移） | `--service-log` |
| helper 用 `systemctl start/stop/restart` 启停 | 执行 `/etc/init.d/kixdns enable start` / `stop disable` / `restart`（持久化语义与 systemd 一致） | `--init-script` |

未设置这三个参数时行为与正式发行版完全一致（仍然走 systemd），所以同一份二进制也能正常
装在有 systemd 的机器上。安装包 `kixdns-panel-openwrt-<架构>.tar.gz` 随正式 Release 发布，沿用下面这套
目录结构；`install.sh` 就按它把文件铺到目标系统。

## 目录布局与来源

安装包（payload）解压后的结构，以及每个文件由哪里产生：

```
install.sh                              本文件所在目录的 install.sh
README.md LICENSE                       本文件、本仓库的 LICENSE
bin/kixdns                              KixDNS 内核：tuoro/kixdns Release 里的 kixdns-<版本>-linux-<架构>-musl.zip
bin/kixdns-panel-server                 本仓库 crates/panel-server 的 musl 构建
libexec/kixdns-panel-helper             本仓库 crates/panel-helper 的 musl 构建
libexec/kixdns-panel-update             面板在线更新器：本仓库 deploy/openwrt/panel-update.sh
web/                                    本仓库 web/ 执行 npm run build 的产物
geo/geosite.dat geo/geosite.json geo/geoip.dat
                                        完整 GeoSite 包（scripts/fetch-builtin-geosite.sh 生成）
init/kixdns.init                        本仓库 deploy/openwrt/init/kixdns.init
init/kixdns-panel.init                  本仓库 deploy/openwrt/init/kixdns-panel.init
init/kixdns-panel-helper.init           本仓库 deploy/openwrt/init/kixdns-panel-helper.init
init/kixdns-panel-update.init           本仓库 deploy/openwrt/init/kixdns-panel-update.init（在线更新的一次性服务）
etc/pipeline.json                       本仓库 deploy/openwrt/pipeline.json（IPv4、IPv6 都听，.lan 交给 dnsmasq）
bundle/KIXDNS_*                         自带内核的身份（scripts/fetch-kixdns-release.sh … musl 写出的七个文件）
PANEL_BUILD_COMMIT                      面板的构建提交（CI 打的包才有）
PANEL_RELEASE                           面板的正式版标签 vX.Y.Z（Release 里的包才有）
SHA256SUMS                              上面每个文件的 SHA-256
```

`bundle/` 让面板认出自带的内核是哪一版：`install.sh` 把它放进 `/etc/kixdns-panel/bundle`，再把来源、
提交和发布编号写进 `/etc/kixdns-panel/panel.env`，面板的 init 脚本读这三项。`PANEL_RELEASE` 和
`PANEL_BUILD_COMMIT` 也写进 `panel.env`，面板据此判断有没有新的正式版。手工拼的包没有 `bundle/`
也能装，只是面板认不出自带的内核，系统页显示为未知版本，第一次在线更新之后就认得了。

`install.sh` 把它们装到（`ROOT` 默认 `/`）：

```
/usr/bin/kixdns                         内核
/usr/bin/kixdns-panel-server            面板
/usr/libexec/kixdns-panel-helper        root helper（唯一能启停服务的东西）
/usr/libexec/kixdns-panel-update        面板在线更新器（helper 经一次性服务 kixdns-panel-update 运行它）
/usr/share/kixdns-panel/web             前端静态资源
/usr/share/kixdns-panel/geo             GeoSite 种子
/etc/init.d/{kixdns,kixdns-panel,kixdns-panel-helper,kixdns-panel-update}
                                        四个 procd init 脚本（kixdns-panel-update 不开机自启）
/etc/kixdns/pipeline.json               内核配置（面板接管后以数据库版本为准）
/etc/kixdns-panel/panel.db              面板数据库（必须在 overlay 上，不能放 /var）
/etc/kixdns-panel/panel.env             install.sh 写的身份：自带内核的来源、面板的版本
/etc/kixdns-panel/github-token          系统页填的 GitHub Token（同样放在 overlay 上）
/tmp/kixdns-panel/querylog              查询日志（默认放内存，重启清空；见下面的「查询日志」）
/var/log/kixdns.log                     内核日志（面板日志页读它）
/var/run/kixdns.pid                     procd 写的 pid 文件
/run/kixdns/admin.sock                  内核管理 Socket
/run/kixdns-panel/control.sock          helper Socket
```

注意 OpenWrt 的 `/var` 是 tmpfs：数据库若放 `/var/lib/...`（上游默认）重启就丢，所以这里
统一改到 `/etc/kixdns-panel/`。日志放 `/var/log` 也是 tmpfs，重启即清空，需要长期保留就自行
做日志轮转或改到 overlay。

日志写在内存里，所以内核默认的日志级别和 systemd 版一样是 `info,kixdns::engine::phases=warn`：
启动、重载、告警照常记，**逐请求的应答记录不记**。每个查询一行约 250 字节，只增不减地占着路由器的内存，
会让智能流控的内存水位越来越早开始拒绝查询，还会把客户端 IP 和域名留在日志里。临时排查要逐条记录时，
执行 `RUST_LOG=info /etc/init.d/kixdns restart`，下次重启就回到默认。

## 交叉编译

面板和 helper 在 musl 上要链 C 代码（rusqlite 的 bundled SQLite、zstd、rustls 的 ring），
所以必须有一个 musl 的 C 交叉工具链，光 `rustup target add` 不够。下面两种任选其一。

### 方式一：cargo-zigbuild（推荐，一条命令管住 C 工具链）

```bash
rustup target add aarch64-unknown-linux-musl        # x86_64 换 x86_64-unknown-linux-musl
pip install ziglang cargo-zigbuild                  # 或 pipx install ...
cargo zigbuild --release --locked --target aarch64-unknown-linux-musl \
  -p kixdns-panel-server -p kixdns-panel-helper
```

产物在 `target/aarch64-unknown-linux-musl/release/` 下，`kixdns-panel-server` 和
`kixdns-panel-helper` 就是 musl 静态（或接近静态）二进制。

### 方式二：原生 musl/gcc 工具链

x86_64 路由器可以用发行版自带的 musl 工具链；aarch64 需要对应的 musl 交叉编译器
（如 `aarch64-linux-musl-cross`）并把它前缀告诉 cargo：

```bash
rustup target add x86_64-unknown-linux-musl
sudo apt install musl-tools                         # 提供 musl-gcc（仅 x86_64）
cargo build --release --locked --target x86_64-unknown-linux-musl \
  -p kixdns-panel-server -p kixdns-panel-helper
```

交叉编译 aarch64 时把下面的 linker 指到实际工具链：

```bash
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-musl-gcc
export CC_aarch64_unknown_linux_musl=aarch64-linux-musl-gcc
```

### 前端和内核

```bash
cd web && npm ci && npm run build                   # 产物在 web/dist，对应 payload 的 web/
```

`bin/kixdns` 是内核，来自 fork [tuoro/kixdns](https://github.com/tuoro/kixdns) 的 Release，不在
本仓库。从 [`2026.11.22.2`](https://github.com/tuoro/kixdns/releases/tag/2026.11.22.2) 起 Release
已经发布 musl 版内核包 `kixdns-<版本>-linux-<arch>-musl.zip`，直接取包里的 `kixdns` 即可；也可以
用同一套 musl 工具链从内核仓库自己编一份。

## 打包

正式版的 Release 里有 `kixdns-panel-openwrt-x86_64.tar.gz` 和 `kixdns-panel-openwrt-arm64.tar.gz`，直接下载即可。
CI 的 `Package OpenWrt` 每次也会打出同样的包，在 Actions 的运行页面下载（保留 7 天），用来试还没发布的改动。

本机打包用同一个脚本 `scripts/package-openwrt.sh`，它核对三个程序都是这个架构的静态链接程序、内核是 musl 版，
再按上面的目录拼好并写出 `SHA256SUMS`：

```bash
# musl 内核和它的身份（要 gh、jq、GNU 的 sha256sum/stat、readelf）
bash scripts/fetch-kixdns-release.sh tuoro/kixdns latest arm64 dist/kernel-musl musl
# GeoSite
bash scripts/fetch-builtin-geosite.sh <GeoSite 版本> dist/builtin-geo
# 面板和服务助手（见上面的「交叉编译」），放进同一个目录
mkdir -p dist/musl && cp target/aarch64-unknown-linux-musl/release/kixdns-panel-{server,helper} dist/musl/
(cd web && npm ci && npm run build)
bash scripts/package-openwrt.sh arm64 dist/musl dist/kernel-musl dist/builtin-geo web/dist dist
# -> dist/kixdns-panel-openwrt-arm64.tar.gz
```

## 安装

在路由器上下载、解开、运行（arm64 换成你的架构；`uname -m` 是 `aarch64` 就是 arm64）：

```sh
cd /tmp
uclient-fetch -O kixdns-panel-openwrt-arm64.tar.gz \
  https://github.com/tuoro/kixdns-panel/releases/latest/download/kixdns-panel-openwrt-arm64.tar.gz
sha256sum kixdns-panel-openwrt-arm64.tar.gz   # 和 Release 页面上这个文件的 sha256 对一下
tar -xzf kixdns-panel-openwrt-arm64.tar.gz
cd kixdns-panel-openwrt-arm64
sh install.sh              # 全新安装只装面板，内核不启动、也不设为开机自启
START_DNS=1 sh install.sh  # 装完顺手启动内核（占用 53 端口）
```

升级时（重复执行 `install.sh`）脚本会先记下内核原来是否在运行、是否开机自启：原来在运行的，
装完照样在运行（只换面板时内核根本不停，DNS 不断）；原来就设了开机自启的也保持自启。`START_DNS=1`
依然是显式要求启动内核的意思。

升级也不会把内核降级：正在用的内核是面板在线更新装上的、而且不比包里自带的旧，就留着它，只换面板；
包里的更新时照常换上包里的。`sh install.sh --panel-only-update` 只换面板，内核和它的身份一概不动。

升级是整体的：换文件以前先看 `/tmp` 放不放得下备份、闪存放不放得下新文件，再把要换的程序、页面、init 脚本、
身份文件和数据库备份到 `/tmp`；装完要等新面板稳定运行、健康检查答出新版本才算成功。哪一步没成就全部放回，
原来的面板照原样起来。

## 面板在线更新

系统页的「在线更新」在 OpenWrt 上也能用，取的是最新正式 Release 里本架构的 OpenWrt 安装包：

1. 面板请 helper 起一次性 procd 服务 `kixdns-panel-update`，由它运行 `/usr/libexec/kixdns-panel-update`。它是自己的
   procd 实例，安装时停掉面板和 helper，它也照样跑完；它不开机自启，跑完就退出。
2. 更新器用 `uclient-fetch` 读 `tuoro/kixdns-panel` 的最新正式版，不会降级；只认 Release 里这个仓库这个标签下、
   已上传完的 `kixdns-panel-openwrt-<架构>.tar.gz`，下载到 `/tmp`（内存，不多写闪存），按 GitHub 公布的 SHA-256、
   包里的 `SHA256SUMS` 和 `PANEL_RELEASE` 校验，包里只许有普通文件和目录。
3. 校验通过后运行包里的 `install.sh --panel-only-update`：只换面板，内核不停、DNS 不断；装不成就整个放回去。

进度和结果写在 `/var/lib/kixdns-panel-update/status.json`，系统页据此显示；完整输出用 `logread -e kixdns-panel-update` 看。
更新器不带系统页填的 GitHub Token（`uclient-fetch` 只能把它放在命令行上，本机别的进程从 `/proc` 读得到），
匿名额度每小时 60 次，一次更新只用一次。下载和解包大约要包的 4 倍内存，备份现有面板再要 30 MB 左右，
不够时更新器和 `install.sh` 会先说清楚，不会装到一半。

## 53 端口和 dnsmasq

OpenWrt 自带的 dnsmasq 占着 53 端口，同时管 DHCP 和局域网主机名（`.lan`）。内核不用你先去挪它：

- **启用内核**（面板「系统」页的「启动」、`START_DNS=1 sh install.sh`、`/etc/init.d/kixdns enable`）时，内核接管 53：
  - dnsmasq 的 DNS 挪到 5353，DHCP 照常；
  - 每个发地址的 DHCP 段补一条 `6,0.0.0.0`，照样把路由器发给客户端当 DNS（dnsmasq 不在 53 上时自己不发）；
  - 内核 10 秒内没在 53 上收查询，就把 53 原样还回去、不启用，局域网不会没有 DNS。
- **停用内核**（「停止」、`/etc/init.d/kixdns disable`）时，先停下内核，再把 dnsmasq 原样还回去。
- 改了什么记在 UCI 的 `kixdns-panel.handover` 里，还的时候只撤自己改的。DHCP 段里本来就写了 DNS 选项的不动；dnsmasq 原来就不在
  53 上（自己挪过、或者关了 DNS）的也不动。

OpenWrt 安装包的默认内核配置同时听 IPv4 和 IPv6（`[::]:53`，odhcpd 把路由器的 IPv6 地址发给客户端当 DNS），并且有一条规则
「局域网主机名交给 dnsmasq」：`.lan` 结尾的域名转给 `127.0.0.1:5353`，`openwrt.lan`、各台设备的主机名照样解析。这是新装时的
默认配置；以前装的在面板的规则里加同样一条就行。

不想让内核动 dnsmasq（比如自己用别的方式安排 53）：

```sh
touch /etc/config/kixdns-panel
uci set kixdns-panel.main=panel
uci set kixdns-panel.main.dnsmasq_handover='0'
uci commit kixdns-panel
```

## 查询日志

查询日志默认放在内存里（`/tmp/kixdns-panel/querylog`），路由器重启后清空：闪存小，也经不起一直写。
OpenWrt 版默认保存 1 天、最多 16 MB（查询日志是压缩存的，每条几十字节，够家里的网络记好几天）。在面板的
「配置 → 基础设置 → 查询日志」或者「日志 → 查询日志」的「设置」里改；那里会写出存在哪、这台设备最多能设多大：
在内存里要给别的程序和在线更新留至少 64 MB 或四分之一，在磁盘上至少 16 MB 或十分之一。空间被别的东西占了，
查询日志会自己删掉最早的，把空间让出来。

想长期保留，就放到 U 盘之类的外置存储上：

```sh
touch /etc/config/kixdns-panel
uci set kixdns-panel.main=panel
uci set kixdns-panel.main.querylog_dir='/mnt/sda1/kixdns-querylog'
uci commit kixdns-panel
/etc/init.d/kixdns-panel restart
```

目录的上一层（这里是 `/mnt/sda1`）不存在时，比如 U 盘没挂上，面板这次照样放内存，不会写到闪存上去。
以前的版本把查询日志写在闪存上的 `/etc/kixdns-panel/querylog`，升级时会删掉，腾出 overlay。

## 面板的监听地址

面板以 root 运行，所以默认只听 **LAN 口当前的 IPv4 地址**（`network_get_ipaddr lan`），端口 5738，
不听 `0.0.0.0`：防火墙一旦配错，WAN 上也打得开面板。LAN 地址变了（改了 IP、LAN 走 DHCP 拿到了新地址），
procd 会让面板换到新地址上；LAN 还没有地址时，面板先只听 `127.0.0.1`。

要听别的地址，写 UCI（升级不会动它）：

```sh
touch /etc/config/kixdns-panel
uci set kixdns-panel.main=panel
uci set kixdns-panel.main.bind='0.0.0.0:5738'   # 或只给本机反向代理用：127.0.0.1:5738
uci commit kixdns-panel
/etc/init.d/kixdns-panel reload
```

去掉这个设置（`uci delete kixdns-panel.main.bind; uci commit kixdns-panel; /etc/init.d/kixdns-panel reload`）
就回到只听 LAN。

## 与 systemd 版的行为差异

- 进程以 root 运行，没有 `ProtectSystem`/独立 `kixdns` 用户。helper 的 `--allowed-uid` 因此是 0。
- 服务状态优先用 `ubus call service list` 问 procd：实例在但没 running 判为 failed（会触发
  「起不来就退回」），只有服务不在列表里才判为 inactive；ubus 不可用才退回「pid 文件 + `/proc/<pid>`」。
- 面板日志页的级别取每一行时间戳之后的第一个词（tracing 的 INFO/WARN/ERROR），不再在整行里
  搜关键字，避免 `terror.example.com`、`no error` 被误判成错误。
- 启停语义与 systemd 对齐：面板的「启动/停止」对应 `enable+start` / `stop+disable`，重启后
  状态一致。
- **内核在线更新**：musl 版面板取 Release 里的 `-musl` 内核包，核对包里的 `libc` 和程序没有动态加载器后才换上。
  路由器的闪存小，存内核前先看 overlay 还剩多少（每份内核约 9 MB，更新时要多写两份，再给设备留出剩余空间的
  十分之一、至少 4 MB）：
  - 空间够：和 systemd 版一样留下上一个，可以一键回退；
  - 只够放下新内核：先删掉旧版本，更新后**不留上一个**，系统页会说明是空间不够；
  - 连新内核都放不下：不更新，说清要多少、还剩多少。

  不管哪种，新内核起不来时都会用更新前读进内存的那份自动换回去，不依赖本地留没留上一个。
- **面板自更新**取 OpenWrt 安装包，由 procd 的一次性服务运行更新器，见上面的「面板在线更新」。
