# KixDNS Panel 部署指南

## 支持范围

首个生产目标为带 systemd 与 Polkit 的 Linux x86_64/ARM64。安装需要 `systemctl`、`polkit`、`sha256sum` 和 `getent`；下载示例还使用 `curl`、`unzip` 与 `jq`。

完整安装包由 `Build enhanced KixDNS` Action 生成，不依赖 GitHub Release。包中包含 KixDNS Enhanced、Panel Server、Vue 静态资源、服务单元和安装脚本。

## 获取并验证安装包

nightly.link 可以直接下载公共 Action Artifact，不需要 GitHub Token。以下示例额外从 GitHub 公共 API 读取 Artifact digest，验证下载归档与 GitHub 记录一致：

```bash
REPOSITORY=tuoro/kixdns-panel
WORKFLOW=build-enhanced.yml
ARTIFACT=kixdns-panel-linux-x86_64

RUN_ID="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&per_page=1" \
  | jq -r '.workflow_runs[0].id')"
DIGEST="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  | jq -r --arg name "$ARTIFACT" '.artifacts[] | select(.name == $name and .expired == false) | .digest')"

curl -fL -o kixdns-panel.zip \
  "https://nightly.link/${REPOSITORY}/workflows/${WORKFLOW}/main/${ARTIFACT}.zip"
printf '%s  %s\n' "${DIGEST#sha256:}" kixdns-panel.zip | sha256sum --check -
mkdir kixdns-panel && unzip kixdns-panel.zip -d kixdns-panel
cd kixdns-panel
sudo bash ./scripts/install.sh
```

ARM64 使用 `kixdns-panel-linux-arm64`。安装脚本还会校验包内 `SHA256SUMS`，然后启动两个服务。

## 权限模型

安装创建两个不可登录系统账号：

| 账号 | 权限 |
| --- | --- |
| `kixdns` | 运行 DNS 数据面；只读配置；通过 `CAP_NET_BIND_SERVICE` 监听 53 端口 |
| `kixdns-panel` | 写配置、SQLite 与可更新的 KixDNS 二进制；读取管理 Socket 与 journal |

关键路径：

| 路径 | 用途 |
| --- | --- |
| `/etc/kixdns/pipeline.json` | 配置事实来源，面板原子写入 |
| `/etc/kixdns-panel/panel.env` | 面板启动参数 |
| `/var/lib/kixdns-panel/panel.db` | 用户、会话、版本与审计数据 |
| `/var/lib/kixdns-panel/bin/kixdns` | 可自动更新的数据面二进制 |
| `/run/kixdns/admin.sock` | `0660` 本机增强控制通道 |
| `/usr/share/kixdns-panel/web` | 前端静态资源 |

面板进程不以 root 运行。Polkit 规则只允许 `kixdns-panel` 对 `kixdns.service` 执行 `start`、`stop`、`restart`；后端本身也使用相同动作白名单。systemd 单元启用了只读系统目录、私有临时目录、能力边界和地址族限制。

## 初次访问

默认只监听 `127.0.0.1:8080`。本机可直接访问，也可先使用 SSH 隧道：

```bash
ssh -L 8080:127.0.0.1:8080 user@dns-host
```

浏览器打开 `http://127.0.0.1:8080`，首次页面会要求创建管理员。密码至少 12 个字符。

## HTTPS 反向代理

生产环境不要把面板 HTTP 端口直接暴露到公网。以下是 Nginx 的最小代理片段，TLS 证书配置按现有基础设施补充：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

启用 HTTPS 后修改并重启：

```bash
sudo sed -i 's/^KIXDNS_PANEL_SECURE_COOKIE=.*/KIXDNS_PANEL_SECURE_COOKIE=true/' \
  /etc/kixdns-panel/panel.env
sudo systemctl restart kixdns-panel.service
```

## 更新与回滚

面板内的“系统与更新”只更新 KixDNS Enhanced：

1. 从 GitHub 公共 API读取最近成功构建和 Artifact digest。
2. 通过 nightly.link 下载，不需要用户 Token。
3. 校验归档 digest、包内 `SHA256SUMS`、ELF 格式和 CPU 架构。
4. 停止服务、替换二进制并等待增强接口健康。
5. 启动或健康检查失败时自动恢复 `kixdns.previous`。

Panel Server 与 Web 更新需下载新的完整包并重新运行 `scripts/install.sh`。脚本保留现有配置、数据库和环境文件，旧静态资源保存在 `/usr/share/kixdns-panel/web.previous`。
完整包内的 `BUILD_COMMIT` 会写入面板环境，因此刚安装的构建不会被误判为待更新版本；在线更新成功后的数据库记录具有更高优先级。

配置保存也有独立回滚：候选配置先由 KixDNS 自身校验；写入后必须收到新的 `reload_sequence` 且 SHA-256 一致，否则面板恢复旧配置。

## 运维命令

```bash
systemctl status kixdns.service kixdns-panel.service
journalctl -u kixdns.service -n 200 --no-pager
journalctl -u kixdns-panel.service -n 200 --no-pager
sudo systemctl restart kixdns-panel.service
```

常见问题：

- `address already in use`：宿主机已有 DNS 服务占用 53 端口，先调整或停用冲突服务。
- 面板显示控制接口不可用：检查 `/run/kixdns/admin.sock`、两个账号的 `kixdns` 组关系和 KixDNS 日志。
- 服务控制被拒绝：确认 Polkit 已安装且 `/etc/polkit-1/rules.d/50-kixdns-panel.rules` 已加载。
- 日志读取失败：确认 `kixdns-panel` 属于 `systemd-journal` 组，重启面板使组关系生效。

## 卸载

默认卸载保留配置和数据：

```bash
sudo bash ./scripts/uninstall.sh
```

明确清除 `/etc/kixdns`、`/etc/kixdns-panel`、`/var/lib/kixdns-panel` 和系统账号：

```bash
sudo bash ./scripts/uninstall.sh --purge
```

`--purge` 不可恢复，执行前应备份配置和 `panel.db`。
