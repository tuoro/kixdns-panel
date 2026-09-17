# KixDNS Panel 架构

## 组成

KixDNS Panel 是基于上游 KixDNS 源码自动构建的增强发行版，不是 Fork：上游源码不进本仓库历史，构建时检出锁定的提交再应用 `patches/`。

1. **KixDNS Enhanced**：上游 DNS 数据面，加上本机控制 Socket、指标和配置状态
2. **Panel Server**：认证、配置版本与原子保存、服务控制、版本库存、日志、诊断
3. **Panel Web**：只调用 Panel Server API，不直接碰控制 Socket 或宿主机文件

~~~text
Browser
  |
  v
Panel Web ---- Panel Server ---- SQLite
                    |
                    +---- config/pipeline.json
                    +---- versions/<source>-<artifact-id>-<commit>/
                    +---- geo/<kind>-<sha256>.<ext>
                    +---- systemd（经 root helper）
                    +---- GitHub API / nightly.link
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

## 上游跟随

两条轨道各自一个锁文件，互相独立，一条失败不阻塞另一条：

| 轨道 | 锁文件 | 版本目录 | 跟随 | 保留 |
| --- | --- | --- | --- | --- |
| Action | `upstream.lock.json` | `upstreams/actions/` | 上游 `main` 最近成功的 `build.yml` | 最近 10 个 |
| Release | `upstream.release.lock.json` | `upstreams/releases/` | 上游正式 Release | 从 `v0.1.1` 起只增不减 |

每个锁指向 `patches/sets/<编号>/` 下一个不可变补丁集。补丁集进入主分支即封印，CI 拒绝修改已有编号，适配只能新增更高编号——已发布的版本因此始终可复现。

自动同步发现上游新版本时：

1. 先尝试直接应用当前补丁集
2. 应用失败或依赖未通过 RustSec 审计，就把补丁重建为临时 Git 提交链，rebase 到新上游（`Cargo.lock` 不参与 rebase，之后重新解析），导出更高编号的补丁集
3. 候选通过测试、Clippy、RustSec 和 DNS 冒烟测试后，自动提交审计 PR 更新锁和版本目录
4. 只有代码冲突或验证失败才开 `[compat]` Issue（每条轨道最多一个），附候选身份和日志；恢复后自动关闭。基础设施故障只让工作流失败，不开 Issue

DNS 冒烟测试用隔离端口和 Unix Socket 真实启动增强进程，验证静态应答、规则计数、配置摘要和热加载序号。人工处理流程见[补丁说明](../patches/README.md)。

## 构建与发布

面板和内核用独立工作流，面板提交不会被误当成新的 KixDNS 版本：

- **内核**：`build-kixdns.yml`（Action 轨道）和 `build-kixdns-release.yml`（Release 轨道）共用 `build-kixdns-track.yml`。产物只作为本仓库 Actions Artifact，通过 nightly.link 下载，每周任务提前 7 天续建即将过期的包
- **面板**：`build-panel.yml` 只监听 Panel Server、Web、部署脚本和面板依赖。它复用上游身份完全匹配的内核 Artifact（校验摘要和 ELF 架构），不重新编译 KixDNS。正式版通过面板 GitHub Release 发布
- 发布构建在 Ubuntu 22.04 容器中完成，拒绝依赖高于 `GLIBC_2.35` 符号的二进制；完整包还要在 Ubuntu 22.04 临时机上跑安装、覆盖升级、面板联调、systemd 控制和卸载验收
- PR 只跑对应边界的验证，不上传可安装包；纯文档变更不触发打包

内核 Artifact 命名为 `kixdns-enhanced-<来源>-<上游身份>-p<补丁集>-<输入指纹>-linux-<架构>`。输入指纹覆盖所选补丁集、构建路径、工作流、Rust 工具链和能力清单，所以新增补丁集不会改变历史版本的指纹，也不会触发重新构建。每个包携带 `KIXDNS_CAPABILITIES.json`，与二进制、上游锁和构建提交一起写入 `SHA256SUMS`。

完整安装包分别记录 `PANEL_BUILD_COMMIT`、`KIXDNS_BUILD_COMMIT` 和正式版标签 `PANEL_RELEASE`，安装时写入 `KIXDNS_PANEL_INSTALLED_COMMIT`、`KIXDNS_INSTALLED_COMMIT`、`KIXDNS_PANEL_INSTALLED_RELEASE`。面板只按正式版标签提示自身更新。Panel Server 启动时离线校验安装包自带 KixDNS 的元数据，并以二进制实际摘要纠正数据库中的活动版本记录——GitHub 不可达时本地版本信息照常显示。本地库存以 `source + artifact_id + commit` 为键，因为同一次工作流可能构建多个上游基线。

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

- 版本源只接受固定仓库、固定工作流和按规则解析的 Artifact 名称；前端只能提交来源类型和 Artifact ID，不能给 URL 或路径
- 从 Artifact 名称解析上游身份后，再与包内 `source`、上游身份、提交、补丁集、控制协议和构建提交逐项核对
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
