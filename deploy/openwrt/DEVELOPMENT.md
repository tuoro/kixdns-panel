# OpenWrt 版的实现、编译和打包

给开发者看的。用户的安装和使用见 [README.md](README.md)。

## 服务后端

面板默认按 systemd 工作。OpenWrt 上没有 systemd 和 journalctl，面板的 init 脚本用三个参数把这三条路换掉：

| systemd 下 | OpenWrt 上 | 参数 |
| --- | --- | --- |
| `systemctl show` 读服务状态 | `ubus call service list`（分得清「用户停掉」和「崩了没被拉起」），ubus 用不了才退回 pid 文件 + `/proc/<pid>` | `--service-pidfile` |
| `journalctl -u kixdns` 读日志 | 直接读内核日志文件（只读末尾 8 MiB，游标是文件里的字节偏移） | `--service-log` |
| helper 调 `systemctl` 启停 | helper 执行 `/etc/init.d/kixdns enable start` / `stop disable` / `restart` | `--init-script` |

不给这些参数时行为和 systemd 版完全一样，同一份程序在两边都能用。和 systemd 版的其他差别：

- 进程以 root 运行，没有独立账号，helper 的 `--allowed-uid` 是 0；helper 只执行 root 所有、别人写不进的 init 脚本和更新器。
- 服务状态：实例在但没 running 判为 failed（会触发「起不来就退回」），服务不在列表里才判为 inactive。
- 日志页的级别取每行时间戳后的第一个词（INFO/WARN/ERROR），不在整行里搜关键字。
- 数据库放在 `/etc/kixdns-panel/`：OpenWrt 的 `/var` 在内存里，重启就丢。
- 内核日志级别和 systemd 版一样是 `info,kixdns::engine::phases=warn`，不逐条记查询：每条约 250 字节，写在内存里只增不减，
  会让智能流控的内存水位越来越早拒绝查询。内核启动时、以及面板每 5 分钟检查一次，日志超过 8 MiB 就复制到 `kixdns.log.1`、
  原文件截成 0（内核以追加方式写，截短以后接着从头写）。
- 内核在线更新取 Release 里的 `-musl` 内核包，核对 `libc` 和程序没有动态加载器。存之前看闪存：
  - 空间够就照常留下上一个；
  - 只够放新内核就先删旧的、不留上一个（系统页会说明）；
  - 放不下就不更新。
  新内核起不来时，用更新前读进内存的那份换回去。
- 查询日志默认放 `/tmp/kixdns-panel/querylog`（`KIXDNS_QUERYLOG_DIR`），musl 版默认保存 1 天、最多 16 MiB；上限不超过所在
  文件系统给得起的（内存里至少给别人留 64 MiB 或四分之一，磁盘上至少 16 MiB 或十分之一）。

## 安装包

`scripts/package-openwrt.sh` 拼出 `kixdns-panel-openwrt-<架构>.tar.gz`，解开是：

```
install.sh                         deploy/openwrt/install.sh
README.md LICENSE
bin/kixdns                         内核：tuoro/kixdns Release 里的 kixdns-<版本>-linux-<架构>-musl.zip
bin/kixdns-panel-server            crates/panel-server 的 musl 构建
libexec/kixdns-panel-helper        crates/panel-helper 的 musl 构建
libexec/kixdns-panel-update        deploy/openwrt/one-click-install.sh（一键安装和面板在线更新是同一个脚本）
libexec/kixdns-panel-uninstall     deploy/openwrt/uninstall.sh
web/                               web/ 执行 npm run build 的产物
geo/                               内置 GeoSite（scripts/fetch-builtin-geosite.sh）
init/*.init                        deploy/openwrt/init/ 的四个 procd init 脚本
etc/pipeline.json                  deploy/openwrt/pipeline.json：[::]:53，.lan 转给 127.0.0.1:5353 的 dnsmasq
bundle/KIXDNS_*                    自带内核的身份（scripts/fetch-kixdns-release.sh … musl 写出的七个文件）
PANEL_BUILD_COMMIT PANEL_RELEASE   面板的构建提交、正式版标签（正式版的包才有 PANEL_RELEASE）
SHA256SUMS                         上面每个文件的 SHA-256
```

`install.sh` 装到：`/usr/bin/{kixdns,kixdns-panel-server}`、`/usr/libexec/kixdns-panel-{helper,update,uninstall}`、
`/usr/share/kixdns-panel/{web,geo}`、`/etc/init.d/{kixdns,kixdns-panel,kixdns-panel-helper,kixdns-panel-update}`，
身份写进 `/etc/kixdns-panel/{bundle,panel.env}`。`panel.env` 里是自带内核的来源、提交、发布编号，以及面板的提交和正式版标签，
面板的 init 脚本只认这五项。

## install.sh

- 升级是整体的：先看 `/tmp` 放不放得下备份、闪存放不放得下新文件，再把要换的程序、页面、init 脚本、身份文件和数据库备份到
  `/tmp`。新面板要在 procd 里稳定 3 秒、健康检查答出新版本（`PANEL_WAIT_SECONDS`，默认 90 秒），否则全部放回，原来的服务按原
  状态起来。
- 新面板程序先在本机跑一次 `--version`，架构不对在动文件以前就停下。
- 只在换内核程序时才停内核。面板在线装上的内核不比包里的旧就留着，不降级。`--panel-only-update` 只换面板，内核和它的身份都不动。
- `START_DNS=1` 等面板装好、健康检查过了才启用内核，装不成回滚时不会留下一个接管了 53 的内核。
- 和在线更新、卸载共用 `/var/lock/kixdns-panel-install.lock`。

## 一键安装和面板在线更新

`deploy/openwrt/one-click-install.sh`，装在路由器上就是 `/usr/libexec/kixdns-panel-update`：

- **不带参数是一键安装**：读最新正式版（或 `--version` 指定的），取本架构的包，校验以后运行完整的 `install.sh`。
- **`--panel-update` 是面板的在线更新**：面板请 helper 执行 `/etc/init.d/kixdns-panel-update start`。这个一次性 procd
  服务没有 respawn、不开机自启，带 `--panel-update` 运行脚本。它是自己的 procd 实例，安装器停掉面板和 helper 时不会跟着停。
  它不降级，运行 `install.sh --panel-only-update`，进度写进 `/var/lib/kixdns-panel-update/status.json`（root 0644）给面板读。
  正在跑时 helper 拒绝再起一个。

两种方式共用：
- 下载：从 `api.github.com/repos/…/releases/assets/<编号>`（`Accept: application/octet-stream`）下载，跳转到
  `release-assets.githubusercontent.com`，不走 `github.com`（有的网络里它的地址时通时不通，uclient-fetch 只试第一个）；
  读 Release 和下载都最多试 3 次。
- 校验：只认这个仓库这个标签下、已上传完的包；按 GitHub 公布的 SHA-256、包里的 `SHA256SUMS` 和 `PANEL_RELEASE` 校验；
  包里只许有普通文件和目录，解包不带属主。下载和解包放 `/tmp`。
- 不带 GitHub Token：uclient-fetch 只能把它放在命令行上，`/proc` 里别人读得到；匿名额度每小时 60 次够用。

## 53 端口

`/etc/init.d/kixdns` 重写了 `enable` / `disable`：

- `enable` 把 dnsmasq 挪到 5353，给每个发地址的 DHCP 段补 `6,0.0.0.0`（dnsmasq 不在 53 上时自己不发 DNS 选项），再启动
  内核。内核 10 秒内没在 53 上收查询，就原样还回去、不启用，返回失败。
- `disable` 先停内核，再还回去。
- 改了什么记在 UCI `kixdns-panel.handover`，只撤自己改的。dnsmasq 原来就不在 53 上的不动；`kixdns-panel.main.dnsmasq_handover=0`
  可以整个关掉。
- 认内核进程按 `/proc/<pid>/exe`：经 `#!/bin/sh /etc/rc.common` 运行的 init 脚本进程名也是 `kixdns`，`pidof` 会认到自己。

## 编译

面板和 helper 在 musl 上要链 C 代码（SQLite、zstd、ring），用 cargo-zigbuild 最省事：

```bash
rustup target add aarch64-unknown-linux-musl        # x86_64 换 x86_64-unknown-linux-musl
pip install ziglang cargo-zigbuild
cargo zigbuild --release --locked --target aarch64-unknown-linux-musl -p kixdns-panel-server -p kixdns-panel-helper
(cd web && npm ci && npm run build)
```

也可以用发行版的 musl 工具链（x86_64 上 `apt install musl-tools`；aarch64 设
`CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER` 和 `CC_aarch64_unknown_linux_musl` 指向交叉编译器）。

## 打包

```bash
bash scripts/fetch-kixdns-release.sh tuoro/kixdns latest arm64 dist/kernel-musl musl   # 要 gh、jq、GNU sha256sum、readelf
bash scripts/fetch-builtin-geosite.sh <GeoSite 版本> dist/builtin-geo
mkdir -p dist/musl && cp target/aarch64-unknown-linux-musl/release/kixdns-panel-{server,helper} dist/musl/
bash scripts/package-openwrt.sh arm64 dist/musl dist/kernel-musl dist/builtin-geo web/dist dist
# -> dist/kixdns-panel-openwrt-arm64.tar.gz；PANEL_RELEASE=vX.Y.Z 时写进正式版标签（要和 Cargo 版本一致）
```

脚本会核对三个程序都是这个架构的静态链接程序、内核是 musl 版。

## CI

- `Package OpenWrt` 每次都打出两个架构的包（Actions 里保留 7 天）。
- `Accept OpenWrt` 在 OpenWrt 官方的 rootfs 容器里（x86_64、arm64 各测 25.12 和 24.10，镜像按各架构的 manifest digest 固定）
  用 `scripts/test-openwrt-package.sh` 把包从头走一遍：
  1. 安装，在面板里启停内核（接管和交还 53、`.lan`、IPv6）；
  2. 在线更新（宿主机上放一个假的 Release），装到一半失败时的回滚；
  3. 卸载、重装，`--purge`；
  4. 经管道一键安装。
- 不过就不发布：正式版时两个包随 Release 上传。
- 容器里有三个坑：
  - 默认网络配置会把 eth0 收进 br-lan，preinit 也会清掉它的地址，所以验收给容器一个固定地址的 docker 网络，eth0 配成静态 WAN；
  - 防火墙在 LAN 起来时会重载，所以启动前就换成全部放行；
  - `/tmp` 启动时被内存盘盖住，安装包放 `/root`。
