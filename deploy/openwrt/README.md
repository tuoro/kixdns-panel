# OpenWrt / procd 部署说明

面板默认假定系统里有 systemd 和 journalctl。OpenWrt 没有这两样，所以面板带了一层
可替换的服务后端，并用 procd init 脚本 + 参数把三条路径换掉：

| 上游行为 | OpenWrt 上的替代 | 开关 |
| --- | --- | --- |
| `systemctl show --property=ActiveState,SubState,MainPID` 读服务状态 | `ubus call service list`（能分清「用户停掉」和「崩了没被拉起」），ubus 用不了才退回 pidfile + `/proc/<pid>` | `--service-pidfile` |
| `journalctl -u kixdns -o json` 读日志 | 直接读内核日志文件（只读末尾 8 MiB，游标=文件绝对字节偏移） | `--service-log` |
| helper 用 `systemctl start/stop/restart` 启停 | 执行 `/etc/init.d/kixdns enable start` / `stop disable` / `restart`（持久化语义与 systemd 一致） | `--init-script` |

未设置这三个参数时行为与正式发行版完全一致（仍然走 systemd），所以同一份二进制也能正常
装在有 systemd 的机器上。安装包会随 Release 发布，沿用下面这套目录结构；`install.sh` 就按
它把文件铺到目标系统。

## 目录布局与来源

安装包（payload）解压后的结构，以及每个文件由哪里产生：

```
install.sh                              本文件所在目录的 install.sh
bin/kixdns                              KixDNS 内核，来自 fork tuoro/kixdns 的构建产物（不在本仓库）
bin/kixdns-panel-server                 本仓库 crates/panel-server 的 musl 构建
libexec/kixdns-panel-helper             本仓库 crates/panel-helper 的 musl 构建
web/                                    本仓库 web/ 执行 npm run build 的产物
geo/geosite.dat geo/geosite.json geo/geoip.dat
                                        完整 GeoSite 包（scripts/fetch-builtin-geosite.sh 生成）
init/kixdns.init                        本仓库 deploy/openwrt/init/kixdns.init
init/kixdns-panel.init                  本仓库 deploy/openwrt/init/kixdns-panel.init
init/kixdns-panel-helper.init           本仓库 deploy/openwrt/init/kixdns-panel-helper.init
etc/pipeline.json                       本仓库 deploy/config/pipeline.json（与 systemd 版同款）
```

`install.sh` 把它们装到（`ROOT` 默认 `/`）：

```
/usr/bin/kixdns                         内核
/usr/bin/kixdns-panel-server            面板
/usr/libexec/kixdns-panel-helper        root helper（唯一能启停服务的东西）
/usr/share/kixdns-panel/web             前端静态资源
/usr/share/kixdns-panel/geo             GeoSite 种子
/etc/init.d/{kixdns,kixdns-panel,kixdns-panel-helper}
                                        三个 procd init 脚本
/etc/kixdns/pipeline.json               内核配置（面板接管后以数据库版本为准）
/etc/kixdns-panel/panel.db              面板数据库（必须在 overlay 上，不能放 /var）
/var/log/kixdns.log                     内核日志（面板日志页读它）
/var/run/kixdns.pid                     procd 写的 pid 文件
/run/kixdns/admin.sock                  内核管理 Socket
/run/kixdns-panel/control.sock          helper Socket
```

注意 OpenWrt 的 `/var` 是 tmpfs：数据库若放 `/var/lib/...`（上游默认）重启就丢，所以这里
统一改到 `/etc/kixdns-panel/`。日志放 `/var/log` 也是 tmpfs，重启即清空，需要长期保留就自行
做日志轮转或改到 overlay。

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

按上面的「目录布局与来源」把文件放进一个目录（就是 payload 根），`install.sh`、`init/`
直接取本目录内容；`etc/pipeline.json` 取自 `deploy/config/pipeline.json`（和 systemd 版同一份，
内核要的是 `bind_udp`/`bind_tcp` + 带 `id` 的 `pipelines` 数组）：

```bash
pkg=/tmp/kixdns-panel-openwrt
mkdir -p "$pkg"/{bin,libexec,web,geo,init,etc}
cp target/aarch64-unknown-linux-musl/release/kixdns-panel-server "$pkg/bin/"
cp target/aarch64-unknown-linux-musl/release/kixdns-panel-helper "$pkg/libexec/"
cp -a web/dist/. "$pkg/web/"
cp deploy/openwrt/install.sh "$pkg/"
cp deploy/openwrt/init/*.init "$pkg/init/"
cp deploy/config/pipeline.json "$pkg/etc/pipeline.json"
# geo/ 放 fetch-builtin-geosite.sh 生成的 geosite.dat/geosite.json/geoip.dat
# bin/kixdns 放内核二进制
tar -C "$pkg" -czf kixdns-panel-openwrt-aarch64.tar.gz .
```

## 安装

```sh
sh install.sh              # 全新安装只装面板，内核不启动、也不设为开机自启
START_DNS=1 sh install.sh  # 装完顺手启动内核（占用 53 端口）
```

升级时（重复执行 `install.sh`）脚本会先记下内核原来是否在运行、是否开机自启：原来在运行的，
装完会自动重新 `start`（不会因为升级把 DNS 断掉）；原来就设了开机自启的也保持自启。`START_DNS=1`
依然是显式要求启动内核的意思。

OpenWrt 默认的 dnsmasq 占着 53 端口。启用内核（`START_DNS=1` 或之后手动
`/etc/init.d/kixdns enable && /etc/init.d/kixdns start`）之前，先把 dnsmasq 换到别的端口
（面板里改，或 `uci set dhcp.@dnsmasq[0].port=5353; uci commit dhcp; /etc/init.d/dnsmasq restart`），
否则内核起不来。

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
- 在线更新（面板自更新、内核在线更新）在 musl 上**暂不支持**：更新器目前发的是 glibc 包，
  硬装会把 glibc 二进制塞进 musl 系统。面板会给出明确提示，等 musl 版安装包发布后再打开。
