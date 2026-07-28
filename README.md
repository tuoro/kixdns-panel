# KixDNS Panel

KixDNS 的非 Fork 增强发行版与管理面板。项目同时跟踪上游最新正式 Release 和 `main` 分支最近成功 Action，不保存上游源码副本；增强能力以可重放补丁维护，管理端通过稳定的本机协议与数据面解耦。

## 界面预览

| 运行概览 | 配置管理 |
| :--: | :--: |
| ![运行概览](docs/images/dashboard.png) | ![配置管理](docs/images/configuration.png) |

| 系统与更新 | DNS 诊断 |
| :--: | :--: |
| ![系统与更新](docs/images/system.png) | ![DNS 诊断](docs/images/diagnostics.png) |

*截图来自本地演示环境，运行指标、构建版本与查询结果均为示例数据。*

## 已实现能力

- KixDNS 内部请求、并发、缓存、Pipeline、规则和上游指标
- 带代次、SHA-256、重载序号与错误信息的结构化热加载回执
- Argon2id 管理员认证、HttpOnly 会话、CSRF 防护和登录限流
- 与上游编辑器功能对齐的结构化表单、原始 JSON、流程预览及导入导出
- KixDNS 编译校验、乐观锁保存、版本历史、回滚和失败自动恢复
- 面板内安装 KixDNS、切换 Releases/Actions 版本源并回切本地版本
- systemd 启动、停止、重启固定动作控制，journal 日志与固定目标 DNS 诊断
- 上游 Releases/Actions 都由本仓库 Action 生成增强 Artifact，并通过 nightly.link 匿名下载
- 版本激活健康检查、失败自动恢复与最多 8 个本地版本的受控库存
- Vue 3 响应式控制台，桌面侧栏与移动端底部导航
- 面板与两条增强内核轨道独立构建 x86_64/ARM64 Artifact，每日自动跟随已验证上游
- 发布前真实启动增强进程，验证 DNS 应答、内部指标与结构化热加载回执

## 架构

```text
Browser -> Panel Web -> Panel Server -> SQLite / 配置 / systemd
                              |
                              v
                    /run/kixdns/admin.sock
                              |
                              v
                       KixDNS Enhanced
```

上游源码仅在构建目录中检出。[upstream.lock.json](upstream.lock.json) 跟踪成功 Action，[upstream.release.lock.json](upstream.release.lock.json) 跟踪正式 Release；`cargo xtask prepare --lock <文件>` 按对应锁应用 [patches](patches)。面板服务不导入上游 crate，只依赖[增强控制协议 v1](docs/control-protocol-v1.md)。

### 版本轨道示例

| 面板版本源 | 上游身份 | 增强工作流 | x86_64 Artifact |
| --- | --- | --- | --- |
| Actions | 官方 Run `#30235703570`，提交 `374d63ccfdde` | `build-kixdns.yml` | `kixdns-enhanced-action-30235703570-linux-x86_64` |
| Releases | 正式版 `v0.1.1`，提交 `647c5b1d2af6` | `build-kixdns-release.yml` | `kixdns-enhanced-release-v0.1.1-linux-x86_64` |

两种包都来自本仓库 Actions，并通过 nightly.link 下载；`Releases` 只表示其上游源码基线来自 `olicesx/kixdns` 正式发布。本仓库当前不创建 GitHub Release。同一次面板提交可能同时构建两条轨道，因此本地库存使用 `来源 + 构建提交` 区分版本。

## 快速开始

从 `Build KixDNS Panel` 最近成功 Action 下载对应架构的完整包，或通过 nightly.link 获取：

```bash
# x86_64；ARM64 将文件名中的 x86_64 改为 arm64
curl -fL -o kixdns-panel.zip \
  https://nightly.link/tuoro/kixdns-panel/workflows/build-panel.yml/main/kixdns-panel-linux-x86_64.zip
mkdir kixdns-panel && unzip kixdns-panel.zip -d kixdns-panel
cd kixdns-panel
sudo bash ./scripts/install.sh
```

安装后面板监听 `http://127.0.0.1:5738`。首次访问创建管理员；远程生产访问应使用 HTTPS 反向代理并启用 Secure Cookie。登录后可在“系统”页安装或切换 KixDNS 构建，并控制服务启动、停止和重启。KixDNS 没有独立的服务重载动作，因此面板不提供重载按钮或 API；配置保存后的文件监听热加载是另一条独立链路。完整步骤、权限模型、版本管理与卸载见[部署指南](docs/deployment.md)。

## 本地开发

```bash
cargo test --workspace --locked
cd web
npm ci
npm test
npm run dev
```

前端演示数据模式：

```bash
VITE_DEMO_MODE=true npm run dev
```

更多设计细节见[系统架构](docs/architecture.md)，补丁维护方法见[补丁说明](patches/README.md)。本项目采用 GPL-3.0-only 许可证。
