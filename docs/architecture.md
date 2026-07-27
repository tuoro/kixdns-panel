# KixDNS Panel 架构

## 产品边界

KixDNS Panel 是一个基于上游 KixDNS 源码自动构建的增强发行版，而不是上游仓库的 Fork。上游源码不进入本仓库历史；构建任务按 `upstream.lock.json` 检出指定提交，应用 `patches/` 中的补丁，验证后生成增强版二进制。

系统由三个相互隔离的部分组成：

1. **KixDNS Enhanced**：保留上游 DNS 数据面，增加本机管理 Socket、指标和结构化配置状态。
2. **Panel Server**：负责认证、配置版本、原子保存、服务控制、更新、日志和诊断。
3. **Panel Web**：只调用 Panel Server API，不直接访问 KixDNS 管理 Socket 或宿主机文件。

~~~text
Browser
  |
  v
Panel Web ---- Panel Server ---- SQLite
                    |
                    +---- config/pipeline.json
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
- 上游升级以官方 `main` 分支最近成功 Action 的提交 SHA 为候选。
- 只有补丁应用、编译、测试和 DNS 冒烟测试均成功时，候选版本才可发布。
- 构建失败不会覆盖当前增强版，并生成兼容性告警。

每日同步 Action 只读取上游官方 `build.yml` 最近一次成功运行。新提交通过补丁重放、测试和 Clippy 后才创建锁定文件更新 PR；失败时主分支和现有 Artifact 都保持不变。面板 Web/Server 只依赖控制协议版本，因此上游适配不会迫使管理端同步修改。

## 安全边界

- 管理通道默认使用 Unix Socket，权限为 `0660`；不监听公网管理端口。
- Panel Server 不接受任意命令和 Shell 片段，服务控制使用固定参数适配器。
- 配置通过同目录临时文件、刷新和原子替换落盘，并保留可回滚版本。
- 浏览器会话使用 HttpOnly、SameSite Cookie；所有写操作要求 CSRF 令牌。
- 密码使用 Argon2id，数据库不保存明文会话令牌。
- 指标禁止域名、客户端 IP 等高基数或敏感标签。
- Panel Server 以独立非 root 账号运行；systemd 控制同时受 API 白名单和精确到 unit/verb 的 Polkit 规则限制。
- 自动更新只接受固定仓库、工作流、分支与 Artifact 名称，安装前校验外层和包内 SHA-256、ELF 与架构。

## 运行平台

首个生产目标为 Linux x86_64/ARM64，支持 systemd 与 Unix Socket。Panel Server 保持跨平台编译；Windows 服务和命名管道作为同一接口的适配实现。
