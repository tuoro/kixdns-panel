# KixDNS Panel 架构

**简体中文** | [English](architecture.en.md)

## 组成

KixDNS Panel 是 KixDNS 的管理面板。内核来自 fork [tuoro/kixdns](https://github.com/tuoro/kixdns)：它的 `main` 是上游加修复（修复按给上游提 PR 的标准做，准备同样提给上游），再加面板接口；发布用日期版本。面板仓库不放内核源码。

1. **KixDNS 内核**：上游 DNS 数据面，加上本机控制 Socket、指标和配置状态
2. **Panel Server**：认证、配置版本与原子保存、服务控制、版本库存、日志、诊断
3. **Panel Web**：只调用 Panel Server API，不直接碰控制 Socket 或宿主机文件

~~~text
Browser
  |
  v
Panel Web ---- Panel Server ---- SQLite
                    |
                    +---- config/pipeline.json
                    +---- versions/<source>-<package-id>-<commit>/
                    +---- geo/<kind>-<sha256>.<ext>
                    +---- systemd、procd 或容器的看管进程（经 root helper）
                    +---- GitHub API / Release 下载
                    |
                    v
             /run/kixdns/admin.sock
                    |
                    v
              KixDNS Enhanced
                    |
                    v
             UDP / TCP / DoH
~~~

在容器里，服务助手换成看管模式（`kixdns-panel-helper supervise`）当主进程：它把内核和面板当子进程跑（都不是 root），崩了照 procd 的规矩拉起，记住用户的启停，对面板提供和 systemd、OpenWrt 上一样的 helper 套接字（多一个 `status`，面板据此分清在重拉、起不来和被停下）。面板跑镜像里的和 `/data/panel` 里在线装的两份中更新的那份，换面板时内核不停。

面板只依赖版本化的[控制协议](control-protocol-v1.md)，不导入上游 crate，所以上游适配不会迫使管理端跟着改。原始 JSON 是配置的事实来源，表单只改已知字段、保留未知字段；字段支持与否由[配置能力契约](config-capabilities.md)决定，不按版本号猜。

## 内核来源

fork 的 `main` 每推进一次就发布一个日期版本 `YYYY.MM.DD`，同一天再发布是 `YYYY.MM.DD.N`。每个发布带两个架构的内核包：glibc 版 `kixdns-<版本>-linux-<架构>.zip`，和给 OpenWrt 用的静态链接 musl 版 `kixdns-<版本>-linux-<架构>-musl.zip`；外加清单 `manifest.json`。清单写明仓库、版本、提交、基于的原版提交、控制协议、配置能力，以及每个包的大小和 SHA-256；包里是 `kixdns`、`KIXDNS_SOURCE.json`（同一份身份加上架构）、`KIXDNS_CAPABILITIES.json` 和 `SHA256SUMS`。发布前在 Ubuntu 22.04 容器里构建、检查 GLIBC 基线、跑 DNS 冒烟测试；fork 每天另做一次依赖审计。

面板按年、月、日、当天第几次逐段比较版本，只有更新的日期版本才提示更新。

### 以前的补丁集内核

面板仓库以前按补丁集构建过内核（p28 及更早），现在已经不再构建，补丁集和构建流程也都删了。新面板只识别主机上已经装下的这种内核，启动后把它换成 fork 的最新版本。v3.4.0 及更早的面板没有新内核可装，已装的照常运行，升级面板以后改从 fork 更新。

## 构建与发布

面板和内核用独立工作流，面板提交不会被误当成新的 KixDNS 版本：

- **内核**：由 fork 的发布流程构建和发布（见上）。
- **面板**：`build-panel.yml` 只监听 Panel Server、Web、部署脚本和面板依赖。每次运行先挑一次 fork 的最新发布（两个架构用同一版），由 `scripts/fetch-kixdns-release.sh` 下载并核对清单、资源摘要、包内 `SHA256SUMS`、来源说明、配置能力和 ELF 架构，不重新编译 KixDNS。这一步在 PR 上也跑。正式版通过面板 GitHub Release 发布
- 发布构建在 Ubuntu 22.04 容器中完成，拒绝依赖高于 `GLIBC_2.35` 符号的二进制；完整包还要在 Ubuntu 22.04 临时机上跑安装、覆盖升级、面板联调、systemd 控制和卸载验收
- **OpenWrt 安装包**：面板和服务助手编成 musl 静态程序，配上 fork 的 musl 内核，由 `scripts/package-openwrt.sh` 拼成 `kixdns-panel-openwrt-<架构>.tar.gz`；在 OpenWrt 官方 rootfs 容器里（x86_64、arm64 各测 25.12 和 24.10）跑安装、启停内核、在线更新、回滚、卸载和一键安装验收，不过就不发布
- **容器镜像**：`scripts/package-docker.sh` 从同一个 OpenWrt 安装包取出程序、网页、GeoSite 和内核身份，`deploy/docker/Dockerfile` 拼成 alpine 镜像（目标阶段只有 COPY，多架构构建不用模拟）；两个架构各在原生 runner 上跑 `scripts/test-docker-image.sh`：搬来的配置、建管理员、低端口解析、保存配置、经面板重启停止内核、从本机的假 Release 在线更新（期间 DNS 一直答）、新版起不来时退回、重建容器以后数据和在线装的版本都在、桥接网络。PR 上也跑；正式版资产传好以后推到 `ghcr.io/tuoro/kixdns-panel`（`X.Y.Z`、`X.Y`、`latest`）
- PR 只跑对应边界的验证，不发布；OpenWrt 包在 PR 上也打出来并验收，作为保留 7 天的 CI 产物。纯文档变更不触发打包

每个内核包携带 `KIXDNS_CAPABILITIES.json`，与二进制和来源说明一起写入 `SHA256SUMS`。

完整安装包分别记录 `PANEL_BUILD_COMMIT`、内核的 `KIXDNS_BUILD_COMMIT` 与 `KIXDNS_SOURCE.json`、正式版标签 `PANEL_RELEASE`，安装时写入 `KIXDNS_PANEL_INSTALLED_COMMIT`、`KIXDNS_INSTALLED_SOURCE=fork`、`KIXDNS_INSTALLED_COMMIT`、`KIXDNS_PANEL_INSTALLED_RELEASE`。面板只按正式版标签提示自身更新。Panel Server 启动时离线校验安装包自带内核的身份，并以二进制实际摘要纠正数据库中的活动版本记录——GitHub 不可达时本地版本信息照常显示；只更新过面板的主机还留着旧完整包的补丁集身份，照样识别。本机只留当前内核和上一个，以 `source + 包编号 + commit` 为键，启动时和每次切换成功后清理其余版本。还在用旧轨道内核（补丁集 Action 构建或更早的 Release）的主机，新面板启动后在后台换成 fork 的最新版本；换下后用户自己回退到旧内核的，不再替换。

## 安全边界

**进程与权限**

- Panel Server 以独立非 root 账号运行；systemd 单元启用只读系统目录、私有临时目录和地址族限制。OpenWrt 上没有独立账号，面板以 root 运行，默认只听 LAN 口的地址；helper 只执行 root 所有、别人写不进的 init 脚本和更新器
- 容器里看管进程是唯一的 root 进程：它重新执行自己（`run-as`）降成内核和面板的用户再 exec 目标程序，内核只在 ambient 集合里带 `CAP_NET_BIND_SERVICE`，两者都设 `no_new_privs`，所以 root 从不执行 `/data` 里面板写得进的文件。`/data` 本身面板写不进，看管进程的记录放在只归 root 的 `/data/supervisor/`；用户放进 `config/` 的文件只按 `O_NOFOLLOW` 打开再改属主，不跟链接
- 启停和自更新经 root helper 转发：专属 Unix Socket（`0600`）+ `SO_PEERCRED` 校验 UID；只接受安装时确定的 unit 与 `start`、`stop`、`restart`，以及固定的 `panel-update`
- 不接受任意命令或 Shell 片段；KixDNS 没有重载动作，面板也不提供
- 控制协议只走本机 Unix Socket（`0660`），不监听网络端口

**会话与数据**

- 密码 Argon2id；数据库不存明文会话令牌；HttpOnly、SameSite Cookie；所有写操作要求 CSRF 令牌
- 登录前页面不显示任何机器状态
- 指标不带域名、客户端 IP 等高基数或敏感标签
- 查询日志记下每条查询的域名和完整的客户端地址，只放在 `/var/lib/kixdns-panel/querylog/`（目录 `0700`、文件 `0600`），登录后才能看；保留时间和空间上限都有上界
- 配置经同目录临时文件原子替换，写入后必须收到匹配的热加载回执，否则回滚
- GitHub Token 只发往 `api.github.com`；在线更新器和一键安装器通过临时 `0600` curl 配置复用它，不出现在进程参数里

**下载与安装**

- 内核只取固定仓库最新正式发布里本机架构的包，下载地址按仓库和版本号自己拼；前端只能提交页面上看到的包编号，与此刻的最新版本不符就拒绝，不能给 URL 或路径
- 发布标签、清单和 GitHub 记下的资源大小与摘要逐项一致；包内 `KIXDNS_SOURCE.json` 的仓库、版本、提交、原版提交、架构和控制协议与清单一致，配置能力也一致
- 安装前校验外层与包内 SHA-256、ELF 与架构；激活前再校验一次；替换后必须通过健康检查，否则恢复
- 配置保存、历史恢复和版本激活共用后端能力注册表；不兼容的版本在停服务之前就被拒绝，面板不自动删除或降级用户字段
- 面板自更新只认本项目最新正式 Release，校验资产摘要和包内摘要，事务不改 KixDNS 的二进制、配置、身份和启停状态。OpenWrt 上由一次性 procd 服务运行更新器，从 GitHub API 的资产地址下载 OpenWrt 包，装不成整个放回。容器里面板自己下载同一个 OpenWrt 包、核对 SHA-256，只解出面板、网页和 GeoSite（拒绝链接、特殊文件和带 `..` 的路径），标签对得上才放进 `/data/panel/<版本>/`，再请看管进程换上；新版本起不来由看管进程退回上一份
- 内核在线更新按本机的 libc 取包（musl 版面板取 `-musl` 包，并核对程序没有动态加载器）；OpenWrt 上存新内核之前先看闪存还剩多少，只够放新内核时不留上一个
- Geo 数据只接受 HTTPS，每次解析和重定向都固定公网地址并重新检查，限制体积和文件数；文件以 `0640` 内容寻址存放，`kixdns` 通过同组只读
- 安装包自带的 GeoSite 只读放在 `/usr/share/kixdns-panel/geo`，导入时按 `geosite.json` 核对 SHA-256 和大小再复制进内容寻址存储，来源记为它的下载链接。全新安装由安装脚本留下的一次性标记触发首次启动导入；已有 GeoSite 时服务端拒绝导入，升级不改用户的数据和配置
- 配置页挑 GeoSite 分类时，面板按内核的读法读出每个分类的域名数和属性（`.dat` 是 protobuf，其余按 V2Ray JSON；名字不分大小写，同名分类后加载的文件为准），按文件缓存。只读自己知道的文件：要编辑的配置、清单和安装包里的那份，不接受页面传来的路径

**与既有安装共存**

- 发现非本面板安装的 KixDNS 时，只有用户明确同意（终端回答 `y` 或 `--replace-existing`）才迁移，否则不改动主机；面板只管理自己安装的增强版
- 迁移保持原运行状态并备份原 unit 和启停状态，增强版起不来时整体回滚，卸载时选择移除增强版即可恢复；早期「仅安装面板」主机的 KixDNS 永远不会被卸载器删除
- 安装器只在用户同意时关闭 systemd-resolved 的本机监听，并记录原 `resolv.conf` 以便回滚和卸载恢复；占用 53 端口的其他程序只报告，不触碰
- OpenWrt 上启用内核时接管 dnsmasq 的 53 端口：dnsmasq 的 DNS 挪到 5353，DHCP 照常并补上 DNS 选项，`.lan` 主机名由内核转给它；内核没起来就自动还回去。停用内核时原样还回去，只撤记在 UCI 里的、自己改过的设置

## 运行平台

生产目标为带 systemd 的 Linux x86_64/ARM64，OpenWrt 24.10 和 25.12（procd，x86_64/arm64），以及 Docker（amd64/arm64，看管进程当主进程）。Panel Server 保持跨平台编译，Windows 服务与命名管道可作为同一接口的适配实现。
