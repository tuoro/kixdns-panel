# KixDNS Panel 架构

## 产品边界

KixDNS Panel 是一个基于上游 KixDNS 源码自动构建的增强发行版，而不是上游仓库的 Fork。上游源码不进入本仓库历史；当前锁位于 `upstream.lock.json` 和 `upstream.release.lock.json`，可切换目录位于 `upstreams/actions` 和 `upstreams/releases`。构建任务检出目录中的已验证提交，应用 `patches/` 后生成增强版二进制。

系统由三个相互隔离的部分组成：

1. **KixDNS Enhanced**：保留上游 DNS 数据面，增加本机管理 Socket、指标和结构化配置状态。
2. **Panel Server**：负责认证、配置版本、原子保存、服务控制、KixDNS 版本库存、日志和诊断。
3. **Panel Web**：只调用 Panel Server API，不直接访问 KixDNS 管理 Socket 或宿主机文件。

~~~text
Browser
  |
  v
Panel Web ---- Panel Server ---- SQLite
                    |
                    +---- config/pipeline.json
                    +---- versions/<source>-<artifact-id>-<commit>/
                    +---- systemd / Windows Service
                    +---- GitHub metadata / artifact provider
                    |
                    v
             local control socket
                    |
                    v
              KixDNS Enhanced
                    |
                    v
             UDP / TCP / DoH
~~~

## 兼容性策略

- 面板只依赖版本化的控制协议，不导入上游 KixDNS crate。
- 原始 JSON 是配置事实来源；可视化表单只修改已知字段并保留未知字段。
- Action 轨道追加官方 `main` 分支最近成功 Action，最多保留 10 个已验证候选；Release 轨道从 `v0.1.1` 增强基线起追加正式发布，不设固定数量上限。
- 只有补丁应用、编译、测试和 DNS 冒烟测试均成功时，候选版本才可发布。
- DNS 冒烟测试使用隔离端口和 Unix Socket，验证静态应答、快速路径规则计数、配置摘要及热加载序号。
- Action 与 Release 独立验证；一条轨道失败不会阻塞另一条轨道推进。
- 兼容性验证失败不会覆盖当前增强版，并按轨道创建或更新唯一的 GitHub Issue；验证恢复后自动关闭告警。
- 每个锁绑定 `patches/sets/<patchset>/` 中的不可变补丁集；适配新 API 必须新增更高编号，已发布版本继续使用原集合。
- 面板和增强版使用各自的锁文件；两者必须通过 RustSec 审计，安全依赖迁移以独立可重放补丁维护。

每日同步分别读取上游官方 `build.yml` 最近一次成功运行和最新正式 Release。两条轨道串行且相互隔离，候选通过补丁重放、测试、Clippy、RustSec 审计和 DNS 冒烟测试后，机器人为对应轨道创建审计 PR，更新当前锁并追加版本目录。兼容性失败时，工作流更新该轨道的 `[compat]` Issue，附候选身份、提交、日志摘要和完整运行链接；主分支、另一条轨道与现有 Artifact 都保持不变。锁文件固定已验证提交以保证构建可复现，但自动同步会持续推进这些固定点。面板 Web/Server 只依赖控制协议版本，因此上游适配不会迫使管理端同步修改。

## 构建边界

面板和增强内核使用独立工作流，避免把面板提交误认为新的 KixDNS 版本：

- `build-kixdns.yml` 监听 Action 目录，`build-kixdns-release.yml` 监听 Release 目录；两者复用 `build-kixdns-track.yml` 的库存检查、验证和打包步骤。
- Artifact 名称为 `kixdns-enhanced-<来源>-<上游身份>-p<补丁集>-<输入指纹>-linux-<架构>`。输入指纹只覆盖锁文件选择的补丁集以及构建工具、工作流和 Rust 工具链；新增更高补丁集不会改变历史版本指纹，目录新增版本时只补建缺失项。
- 构建库存会校验全部锁的补丁集引用。拉取请求和直接推送均不得修改主分支已有集合，只能新增高于当前最大值的编号。
- 每周库存检查会续建缺失或将在 7 天内过期的包；Artifact 仍使用 GitHub 的 90 天保留期，本仓库不创建 GitHub Release。
- `build-panel.yml` 只监听 Panel Server、Web、部署脚本和面板依赖。它从最近成功的内核工作流复用上游身份完全匹配的 Artifact，经包内 SHA-256 和 ELF 架构校验后生成完整安装包，不重新编译 KixDNS。
- PR 只执行对应边界的验证 Job，不上传可安装 Artifact；README、截图等纯文档变化不触发打包工作流。

完整包分别保存 `PANEL_BUILD_COMMIT` 和 `KIXDNS_BUILD_COMMIT`。前者标识管理面构建，后者标识数据面构建；`KIXDNS_SOURCE_RUN_ID` 保留被复用内核的 Action Run。Artifact digest 只用于验证 ZIP 传输内容，包内 `binary_sha256` 才是 KixDNS 二进制内容身份。

## 安全边界

- 管理通道默认使用 Unix Socket，权限为 `0660`；不监听公网管理端口。
- Panel Server 不接受任意命令和 Shell 片段，服务控制使用固定参数适配器。
- 配置通过同目录临时文件、刷新和原子替换落盘，并保留可回滚版本。
- 浏览器会话使用 HttpOnly、SameSite Cookie；所有写操作要求 CSRF 令牌。
- 密码使用 Argon2id，数据库不保存明文会话令牌。
- 指标禁止域名、客户端 IP 等高基数或敏感标签。
- Panel Server 以独立非 root 账号运行；systemd 控制同时受 API 白名单和精确到 unit/verb 的 Polkit 规则限制。
- KixDNS 版本源只接受固定仓库、两条工作流、分支和按规则解析的 Artifact 名称；安装请求只携带来源类型和 GitHub Artifact ID，前端不能指定 URL 或文件路径。
- 后端从 Artifact 名称解析上游官方 Run 或 Release 标签，再校验包内 `source`、上游身份、提交、补丁集、控制协议和本仓库构建提交。两条轨道使用独立远端缓存与 `source + artifact_id + commit` 本地库存键，同一次工作流可安全暴露多个版本。
- 安装前校验外层和包内 SHA-256、ELF 与架构，激活前再次校验本地清单与二进制摘要；替换后必须通过健康检查，否则恢复原状态。
- 服务动作白名单只有 `start`、`stop`、`restart`。配置文件监听产生的结构化热加载回执属于增强控制协议，不是 systemd 服务重载能力。

## 运行平台

首个生产目标为 Linux x86_64/ARM64，支持 systemd 与 Unix Socket。Panel Server 保持跨平台编译；Windows 服务和命名管道作为同一接口的适配实现。
