# KixDNS Panel

KixDNS 的非 Fork 增强发行版与管理面板。项目按官方 `main` 分支最近成功 Action 的提交构建，不保存上游源码副本；增强能力以可重放补丁维护，管理端通过稳定的本机协议与数据面解耦。

## 已实现能力

- KixDNS 内部请求、并发、缓存、Pipeline、规则和上游指标
- 带代次、SHA-256、重载序号与错误信息的结构化热加载回执
- Argon2id 管理员认证、HttpOnly 会话、CSRF 防护和登录限流
- JSON 配置校验、乐观锁保存、版本历史、回滚和失败自动恢复
- systemd 固定动作控制、journal 日志、固定目标 DNS 诊断
- GitHub 公共元数据 + nightly.link 下载，Artifact 与包内双重摘要校验
- Vue 3 响应式控制台，桌面侧栏与移动端底部导航
- x86_64/ARM64 Action 构建、每日上游兼容性检查和完整 Linux 安装包
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

上游源码仅在构建目录中检出，`cargo xtask prepare` 按 [upstream.lock.json](upstream.lock.json) 应用 [patches](patches)。面板服务不导入上游 crate，只依赖[增强控制协议 v1](docs/control-protocol-v1.md)。

## 快速开始

从 `Build enhanced KixDNS` 最近成功 Action 下载对应架构的完整包，或通过 nightly.link 获取：

```bash
# x86_64；ARM64 将文件名中的 x86_64 改为 arm64
curl -fL -o kixdns-panel.zip \
  https://nightly.link/tuoro/kixdns-panel/workflows/build-enhanced.yml/main/kixdns-panel-linux-x86_64.zip
mkdir kixdns-panel && unzip kixdns-panel.zip -d kixdns-panel
cd kixdns-panel
sudo bash ./scripts/install.sh
```

安装后面板监听 `http://127.0.0.1:5738`。首次访问创建管理员；远程生产访问应使用 HTTPS 反向代理并启用 Secure Cookie。完整步骤、权限模型、升级与卸载见[部署指南](docs/deployment.md)。

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
