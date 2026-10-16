# KixDNS Panel

[KixDNS](https://github.com/olicesx/kixdns) 的 Web 管理面板。内核来自 fork [tuoro/kixdns](https://github.com/tuoro/kixdns) 按日期版本发布的增强版：上游加修复，再加面板接口；面板只通过本机控制协议与 DNS 数据面通信。

## 界面预览

| 运行概览 | 查询日志 |
| :--: | :--: |
| ![运行概览](docs/images/dashboard.png) | ![查询日志](docs/images/querylog.png) |

| 配置管理 | DNS 诊断 |
| :--: | :--: |
| ![配置管理](docs/images/configuration.png) | ![DNS 诊断](docs/images/diagnostics.png) |

*截图来自本地演示环境，数据均为示例。*

<details>
<summary>移动端预览</summary>

<p>
  <img src="docs/images/dashboard-mobile.png" alt="移动端运行概览" width="320" />
  <img src="docs/images/querylog-mobile.png" alt="移动端查询详情" width="320" />
</p>

</details>

## 能做什么

- **运行概览**：查询量、成功率、缓存命中、延迟与每小时趋势，上游状态、请求分布、规则命中、查询排行
- **配置管理**：规则、上游组、域名映射、基础设置用表单编辑，也可以直接改 JSON；GeoIP/GeoSite 数据托管（完整包自带 GeoSite）；保存前由 KixDNS 自身校验，热加载失败自动回滚，保留版本历史
- **查询日志**：每一次查询从哪个客户端来、命中哪条规则、谁回答的、回了什么，逐步看处理过程；按域名或客户端搜索、按去向筛选，可以下载
- **DNS 诊断**：对本机 KixDNS 发起查询，可以指定客户端 IP，逐步展示命中的规则、缓存与上游；改规则时可以先拿没保存的草稿试跑
- **运行日志与操作审计**：KixDNS journal 实时查看，面板里的每次操作都有记录
- **内核更新**：在面板内把 KixDNS 更新到 fork 最新发布的日期版本，或回到上一个，激活失败自动恢复
- **面板自更新**：系统页一键更新到最新正式版，双重校验摘要，不动 KixDNS
- **安全**：Argon2id 认证、HttpOnly 会话、CSRF 防护、登录限流；面板进程不以 root 运行
- 桌面与手机均可用

## 安装

需要带 systemd 的 Linux x86_64/ARM64，GLIBC 2.35 及以上（Ubuntu 22.04、Debian 12 或更新）。一键安装另需 `curl`、`jq`、`unzip`。

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh | sudo bash
```

装完访问安装器输出的地址（默认端口 `5738`），首次访问创建管理员。KixDNS 默认不自动启动，在「系统」页启动即可。

主机上已有 KixDNS 时，安装器会说明迁移会做什么，并在你同意后迁移为增强版：配置和运行状态保留，卸载面板时可恢复原来的 KixDNS；不同意则什么都不改。**不要把 `5738` 直接暴露到公网**，跨网络访问请走 HTTPS 反向代理。

固定版本安装、手动安装、反向代理、权限模型和卸载见[部署指南](docs/deployment.md)。每个版本的变化见 [Releases](https://github.com/tuoro/kixdns-panel/releases)。

卸载：

```bash
sudo kixdns-panel-uninstall
```

## 开发

```bash
cargo test --workspace --locked
cd web && npm ci && npm test
VITE_DEMO_MODE=true npm run dev   # 演示数据模式
```

## 文档

- [部署指南](docs/deployment.md)：安装、权限、内核更新、运维与卸载
- [系统架构](docs/architecture.md)：组件边界、构建流水线与安全设计
- [增强控制协议 v1](docs/control-protocol-v1.md)：面板与 KixDNS 之间的本机接口
- [配置能力契约](docs/config-capabilities.md)：新配置字段的兼容规则
- [补丁说明](patches/README.md)：v3.4.0 及更早的面板仍在用的冻结补丁集 p28

许可证：GPL-3.0-only。
