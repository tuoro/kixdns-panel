# KixDNS Panel 架构

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
                    +---- systemd（经 root helper）
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

面板只依赖版本化的[控制协议](control-protocol-v1.md)，不导入上游 crate，所以上游适配不会迫使管理端跟着改。原始 JSON 是配置的事实来源，表单只改已知字段、保留未知字段；字段支持与否由[配置能力契约](config-capabilities.md)决定，不按版本号猜。

## 内核来源

fork 的 `main` 每推进一次就发布一个日期版本 `YYYY.MM.DD`，同一天再发布是 `YYYY.MM.DD.N`。每个发布带两个架构的内核包 `kixdns-<版本>-linux-<架构>.zip` 和清单 `manifest.json`。清单写明仓库、版本、提交、基于的原版提交、控制协议、配置能力，以及每个包的大小和 SHA-256；包里是 `kixdns`、`KIXDNS_SOURCE.json`（同一份身份加上架构）、`KIXDNS_CAPABILITIES.json` 和 `SHA256SUMS`。发布前在 Ubuntu 22.04 容器里构建、检查 GLIBC 基线、跑 DNS 冒烟测试；fork 每天另做一次依赖审计。

面板按年、月、日、当天第几次逐段比较版本，只有更新的日期版本才提示更新。

### 冻结的补丁集轨道

v3.4.0 及更早的面板只认面板仓库自己按补丁集构建的 Actions 产物（`build-kixdns.yml`）。这条轨道冻结在 p28：上游同步已经停止，`upstream.lock.json`、补丁集和产物名格式都不再改，每周任务只在产物快过期、或快掉出老面板能看到的最近 20 次运行时续建，老面板因此一直有内核可装。老面板升级到新面板以后改从 fork 更新。补丁集的维护方法见[补丁说明](../patches/README.md)。

## 构建与发布

面板和内核用独立工作流，面板提交不会被误当成新的 KixDNS 版本：

- **内核**：由 fork 的发布流程构建和发布（见上）。面板仓库的 `build-kixdns.yml` 经 `build-kixdns-track.yml` 只为老面板续建冻结的 p28
- **面板**：`build-panel.yml` 只监听 Panel Server、Web、部署脚本和面板依赖。每次运行先挑一次 fork 的最新发布（两个架构用同一版），由 `scripts/fetch-kixdns-release.sh` 下载并核对清单、资源摘要、包内 `SHA256SUMS`、来源说明、配置能力和 ELF 架构，不重新编译 KixDNS。这一步在 PR 上也跑。正式版通过面板 GitHub Release 发布
- 发布构建在 Ubuntu 22.04 容器中完成，拒绝依赖高于 `GLIBC_2.35` 符号的二进制；完整包还要在 Ubuntu 22.04 临时机上跑安装、覆盖升级、面板联调、systemd 控制和卸载验收
- PR 只跑对应边界的验证，不上传可安装包；纯文档变更不触发打包

冻结轨道的产物命名为 `kixdns-enhanced-action-<上游 Run>-p<补丁集>-<输入指纹>-linux-<架构>`。输入指纹只由明确列出的构建输入决定：锁文件、所选补丁和依赖修订、能力清单、Rust 工具链、xtask 里准备源码的代码，以及 DNS 冒烟和 GLIBC 基线两个验证脚本。xtask 自己的依赖、自动重基与依赖刷新这两个维护模块、工作流和指纹脚本都不参与，所以常规依赖升级不会触发重建；改了构建方式需要手动强制重建。新增补丁集同样不会改变历史版本的指纹。这个名称格式是老面板识别版本的接口：面板严格解析，多一段就会把这个版本悄悄丢掉，所以格式不能改。新信息只能进指纹，或放进包内的上游锁里，面板按需读取，依赖修订就是这样做的。每个包携带 `KIXDNS_CAPABILITIES.json`，与二进制、上游锁和构建提交一起写入 `SHA256SUMS`。

完整安装包分别记录 `PANEL_BUILD_COMMIT`、内核的 `KIXDNS_BUILD_COMMIT` 与 `KIXDNS_SOURCE.json`、正式版标签 `PANEL_RELEASE`，安装时写入 `KIXDNS_PANEL_INSTALLED_COMMIT`、`KIXDNS_INSTALLED_SOURCE=fork`、`KIXDNS_INSTALLED_COMMIT`、`KIXDNS_PANEL_INSTALLED_RELEASE`。面板只按正式版标签提示自身更新。Panel Server 启动时离线校验安装包自带内核的身份，并以二进制实际摘要纠正数据库中的活动版本记录——GitHub 不可达时本地版本信息照常显示；只更新过面板的主机还留着旧完整包的补丁集身份，照样识别。本机只留当前内核和上一个，以 `source + 包编号 + commit` 为键，启动时和每次切换成功后清理其余版本。还在用旧轨道内核（补丁集 Action 构建或更早的 Release）的主机，新面板启动后在后台换成 fork 的最新版本；换下后用户自己回退到旧内核的，不再替换。

## 安全边界

**进程与权限**

- Panel Server 以独立非 root 账号运行；systemd 单元启用只读系统目录、私有临时目录、能力边界和地址族限制
- 启停和自更新经 root helper 转发：专属 Unix Socket（`0600`）+ `SO_PEERCRED` 校验 UID；只接受安装时确定的 unit 与 `start`、`stop`、`restart`，以及固定的 `panel-update`
- 不接受任意命令或 Shell 片段；KixDNS 没有重载动作，面板也不提供
- 控制协议只走本机 Unix Socket（`0660`），不监听网络端口

**会话与数据**

- 密码 Argon2id；数据库不存明文会话令牌；HttpOnly、SameSite Cookie；所有写操作要求 CSRF 令牌
- 登录前页面不显示任何机器状态
- 指标不带域名、客户端 IP 等高基数或敏感标签
- 配置经同目录临时文件原子替换，写入后必须收到匹配的热加载回执，否则回滚
- GitHub Token 只发往 `api.github.com`；在线更新器和一键安装器通过临时 `0600` curl 配置复用它，不出现在进程参数里

**下载与安装**

- 内核只取固定仓库最新正式发布里本机架构的包，下载地址按仓库和版本号自己拼；前端只能提交页面上看到的包编号，与此刻的最新版本不符就拒绝，不能给 URL 或路径
- 发布标签、清单和 GitHub 记下的资源大小与摘要逐项一致；包内 `KIXDNS_SOURCE.json` 的仓库、版本、提交、原版提交、架构和控制协议与清单一致，配置能力也一致
- 安装前校验外层与包内 SHA-256、ELF 与架构；激活前再校验一次；替换后必须通过健康检查，否则恢复
- 配置保存、历史恢复和版本激活共用后端能力注册表；不兼容的版本在停服务之前就被拒绝，面板不自动删除或降级用户字段
- 面板自更新只认本项目最新正式 Release，校验资产摘要和包内摘要，事务不改 KixDNS 的二进制、配置、身份和启停状态
- Geo 数据只接受 HTTPS，每次解析和重定向都固定公网地址并重新检查，限制体积和文件数；文件以 `0640` 内容寻址存放，`kixdns` 通过同组只读

**与既有安装共存**

- 发现非本面板安装的 KixDNS 时，只有用户明确同意（终端回答 `y` 或 `--replace-existing`）才迁移，否则不改动主机；面板只管理自己安装的增强版
- 迁移保持原运行状态并备份原 unit 和启停状态，增强版起不来时整体回滚，卸载时选择移除增强版即可恢复；早期「仅安装面板」主机的 KixDNS 永远不会被卸载器删除
- 安装器只在用户同意时关闭 systemd-resolved 的本机监听，并记录原 `resolv.conf` 以便回滚和卸载恢复；占用 53 端口的其他程序只报告，不触碰

## 运行平台

生产目标为带 systemd 的 Linux x86_64/ARM64。Panel Server 保持跨平台编译，Windows 服务与命名管道可作为同一接口的适配实现。
