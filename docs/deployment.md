# KixDNS Panel 部署指南

## 支持范围

首个生产目标为带 systemd 与 Polkit 的 Linux x86_64/ARM64。官方 GNU 二进制以 GLIBC 2.35 为最高兼容基线，可运行于 Ubuntu 22.04、Debian 12 及使用更新 GLIBC 的发行版。安装需要 `systemctl`、`polkit`、`sha256sum` 和 `getent`；下载示例还使用 `curl`、`unzip` 与 `jq`。

完整安装包由 `Build KixDNS Panel` Action 生成。KixDNS Enhanced 的上游 Action 与正式 Release 轨道也都只发布为本仓库 Actions Artifact，本仓库当前不创建 GitHub Release。面板工作流复用上游身份、补丁集和架构完全匹配的已校验 Action 轨道 Artifact，不会因面板修改而重新编译数据面。完整包包含 KixDNS Enhanced、Panel Server、Vue 静态资源、服务单元和安装脚本。

## 获取并验证安装包

nightly.link 可以直接下载公共 Action Artifact，不需要 GitHub Token。以下示例额外从 GitHub 公共 API 读取 Artifact digest，验证下载归档与 GitHub 记录一致：

```bash
REPOSITORY=tuoro/kixdns-panel
WORKFLOW=build-panel.yml
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

## 既有 KixDNS 安装

安装脚本检测到非本面板管理的 KixDNS 时不会默认替换。交互终端会要求选择：

- `1` 保留现有 KixDNS，仅安装受限模式面板；面板不下载、替换或删除其二进制，版本更新提示和版本操作会停用。
- `2` 保留现有配置，迁移为面板管理的 KixDNS Enhanced；原有 `/etc/systemd/system/<unit>` 和运行状态会保存到 `/var/lib/kixdns-panel/external-backup/`，以后卸载面板可恢复。
- `3` 取消安装。

无人值守安装必须显式选择，不能依赖默认值：

```bash
# 保留现有服务，仅安装受限模式面板
sudo bash ./scripts/install.sh --keep-existing \
  --kixdns-unit kixdns.service \
  --kixdns-config /etc/kixdns/pipeline.json \
  --kixdns-binary /usr/local/bin/kixdns

# 明确迁移到面板管理的增强版
sudo bash ./scripts/install.sh --replace-existing
```

迁移模式只替换面板约定的 KixDNS 二进制和 unit，既有配置路径会被写入 `panel.env`；迁移前的 unit、启用状态和运行状态会保留。保留模式下，面板仍可按 Polkit 权限控制既有 unit，但原版 KixDNS 不具备增强指标和结构化热加载回执时，对应页面会显示不可用。迁移到增强版必须重新运行安装脚本并明确选择迁移，面板不会通过常驻 root 权限直接改写 systemd。

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
| `/var/lib/kixdns-panel/versions/<source>-<artifact-id>-<commit>/` | 按 Artifact 身份隔离的 KixDNS 二进制与版本清单 |
| `/var/lib/kixdns-panel/geo/` | 按内容摘要保存的 GeoIP 与 GeoSite 数据 |
| `/run/kixdns/admin.sock` | `0660` 本机增强控制通道 |
| `/usr/share/kixdns-panel/web` | 前端静态资源 |

面板进程不以 root 运行。Polkit 规则只允许 `kixdns-panel` 对安装配置中的 KixDNS unit 执行 `start`、`stop`、`restart`；后端本身也使用相同动作白名单。外部模式不会授予面板二进制替换能力。systemd 单元启用了只读系统目录、私有临时目录、能力边界和地址族限制。

日志页依赖 `systemd-journal` 组。journald 本身不支持按 unit 授权，因此该组也能读取宿主机其他 journal；这是当前部署的明确权限边界。不能接受此权限时，应移除 `kixdns-panel` 的 `systemd-journal` 附加组，同时停用面板日志页。不要用带参数通配符的 sudoers 规则替代，它会扩大命令执行范围。

## 初次访问

默认只监听 `127.0.0.1:5738`。本机可直接访问，也可先使用 SSH 隧道：

```bash
ssh -L 5738:127.0.0.1:5738 user@dns-host
```

浏览器打开 `http://127.0.0.1:5738`，首次页面会要求创建管理员。密码至少 12 个字符。

## HTTPS 反向代理

生产环境不要把面板 HTTP 端口直接暴露到公网。以下是 Nginx 的最小代理片段，TLS 证书配置按现有基础设施补充：

```nginx
location / {
    proxy_pass http://127.0.0.1:5738;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

默认仅信任回环地址 `127.0.0.1/32,::1/128` 提供的 `X-Forwarded-For`。如果反向代理运行在容器或另一台主机，必须把它的精确 CIDR 写入 `KIXDNS_TRUSTED_PROXIES`；未受信任的直连请求无法伪造限流来源。后端从右向左剥离可信代理，使用第一个非可信地址作为客户端地址。

启用 HTTPS 后修改并重启：

```bash
sudo sed -i 's/^KIXDNS_PANEL_SECURE_COOKIE=.*/KIXDNS_PANEL_SECURE_COOKIE=true/' \
  /etc/kixdns-panel/panel.env
sudo systemctl restart kixdns-panel.service
```

## KixDNS 安装与版本管理

面板“系统”页管理的是 KixDNS Enhanced 数据面，不会在线替换 Panel Server 或 Web：

1. “Actions”读取 `build-kixdns.yml` 的成功构建并显示包名中的上游官方 Run；“Releases”读取 `build-kixdns-release.yml` 的成功构建并显示包名中的上游正式标签。两者都从本仓库 Actions 通过 nightly.link 匿名下载，不要求用户配置 GitHub Token。Action 最多维护 10 个已验证版本；Release 从 `v0.1.1` 起只追加，不固定限制为两个或其他数量。
2. 安装请求只提交 `release/action` 与 GitHub Artifact ID。后端在固定工作流最近 30 次成功运行中重新解析来源，拒绝前端传入下载 URL 或文件路径。
3. 校验 GitHub Artifact digest、包内 `SHA256SUMS`、`KIXDNS_BUILD_COMMIT`、`KIXDNS_CAPABILITIES.json`、`upstream.lock.json` 的 `source` 与官方 Run/Release 身份、补丁集、控制协议、ELF 格式和 CPU 架构。
4. 使用能力清单预检当前配置；不兼容时返回 `422 unsupported_config_fields`，不会停止服务、写入版本库存或改写配置。
5. 校验完成后按 `source + artifact_id + 构建提交` 写入版本目录，能力保存到本地清单 v5。同一次工作流运行可以批量构建多个上游基线，因此不能只按提交 SHA 复用库存。
6. 激活版本时重新校验清单、能力和二进制 SHA-256，然后停止服务、原子替换运行文件、启动服务并等待增强接口健康；启动或健康检查失败时恢复原状态。

真实包名示例：上游 Action `#30235703570` 当前对应 `kixdns-enhanced-action-30235703570-p8-46ac788fc96c-linux-x86_64`，上游 Release `v0.1.1` 对应 `kixdns-enhanced-release-v0.1.1-p5-c70f631829c0-linux-x86_64`。下载 URL 统一为 `https://nightly.link/tuoro/kixdns-panel/actions/runs/<增强-run-id>/<artifact>.zip`。

已下载版本可直接切换，无需重复联网。面板最多保留 8 个本地版本，清理时始终保留当前版本。完整安装包自带的 KixDNS 会在首次版本操作时自动收录为 Action 轨道库存。Actions Artifact 保留 90 天；每周任务会提前 7 天续建，已过期的远端包不会出现在可安装列表，本地已校验库存不受影响。

SQLite 中配置历史最多保留 100 条，审计事件最多保留 10,000 条；每次写入与清理处于同一事务，服务启动时也会整理旧数据库，避免长期运行造成无界增长。

## GeoIP 与 GeoSite 数据

配置管理页支持“远程链接”和“本地路径”两种模式。远程模式只接受 HTTPS 文件直链；Panel Server 下载后按 SHA-256 写入 `KIXDNS_GEO_DATA`，再把实际本地路径填入待保存配置。链接元数据保存在 SQLite，不会写入 KixDNS 配置。已有本地路径不会被迁移或覆盖，仍可直接使用本地路径模式。

下载端拒绝 URL 用户信息、本机、私网、链路本地和保留地址，每次重定向都会重新解析并固定公网地址；单个文件上限 128 MiB，最多允许 8 个 GeoSite 文件。文件使用 `0640`、内容寻址文件名与原子落盘，`kixdns` 通过同组只读。旧哈希文件不会自动覆盖或清理，以保证配置历史回滚仍能读取原数据。

Panel Server 与 Web 更新仍需下载新的完整包并重新运行 `scripts/install.sh`。脚本保留现有配置、数据库和环境文件，旧静态资源保存在 `/usr/share/kixdns-panel/web.previous`。完整包使用 `PANEL_BUILD_COMMIT` 标识管理面构建，使用 `KIXDNS_BUILD_COMMIT` 标识被复用的数据面构建，并分别写入 `KIXDNS_PANEL_INSTALLED_COMMIT` 与 `KIXDNS_INSTALLED_COMMIT`。正式包还会携带 `PANEL_RELEASE` 并写入 `KIXDNS_PANEL_INSTALLED_RELEASE`；当前开发阶段的 Action 包没有该标签。未来正式发版后，面板只根据 `tuoro/kixdns-panel` 最新正式 GitHub Release 及当前架构的 Release 安装包提示自身更新，不会把日常 Action 构建当作新版，也不会自行执行高权限替换。旧版默认工作流名会迁移到 `build-kixdns.yml`，缺少的 `KIXDNS_UPDATE_RELEASE_WORKFLOW` 会补为 `build-kixdns-release.yml`，已有自定义更新源保持不变。

服务生命周期只支持启动、停止和重启。KixDNS 没有独立的服务重载动作，面板不会提供重载按钮、API、Polkit 动词或 systemd `ExecReload`。配置保存和历史版本恢复使用 KixDNS 的文件监听热加载链路：候选内容先由 KixDNS 自身校验；写入后必须收到新的 `reload_sequence` 且 SHA-256 一致，否则面板恢复旧配置。该回执不等同于服务重载命令。

配置页和版本切换遵循[配置能力契约](config-capabilities.md)。不受当前 KixDNS 支持的新字段不会出现在空配置中；配置已经含有该字段时保持只读并原样保留。JSON/API 不能绕过后端检查，切换到能力不足的本地或远程版本也会在替换二进制前被拒绝。

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
- Geo 数据下载失败：确认填写的是 HTTPS 文件直链，且目标不会重定向到登录页、私网或超过 128 MiB 的文件。

## 卸载

默认卸载保留配置和数据：

```bash
sudo bash ./scripts/uninstall.sh
```

明确清除面板数据（受管模式还会清除面板生成的 `/etc/kixdns`）：

```bash
sudo bash ./scripts/uninstall.sh --purge
```

`--purge` 不可恢复，执行前应备份配置和 `panel.db`。外部模式下，卸载和 `--purge` 都不会删除外部 KixDNS 的 unit、二进制、配置或账号；迁移模式如果存在备份，会先恢复迁移前的 unit 与运行状态。
