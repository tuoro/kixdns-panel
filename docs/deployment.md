# KixDNS Panel 部署指南

## 支持范围

首个生产目标为带 systemd 的 Linux x86_64/ARM64。官方 GNU 二进制以 GLIBC 2.35 为最高兼容基线，可运行于 Ubuntu 22.04、Debian 12 及使用更新 GLIBC 的发行版。安装需要 `systemctl`、`sha256sum` 和 `getent`；下载示例还使用 `curl`、`unzip` 与 `jq`。

完整安装包由 `Build KixDNS Panel` Action 生成，并在面板 GitHub Release 中发布；当前正式版本为 `v1.0.3`。KixDNS Enhanced 的上游 Action 与正式 Release 轨道仍只发布为本仓库 Actions Artifact。面板工作流复用上游身份、补丁集和架构完全匹配的已校验 Action 轨道 Artifact，不会因面板修改而重新编译数据面。完整包包含 KixDNS Enhanced、Panel Server、Vue 静态资源、服务单元和安装脚本。

## 一键安装

一键安装命令会读取最新正式 Release，按当前架构选择安装包，校验 GitHub API 返回的资产 SHA-256 摘要，然后调用包内安装器：

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh | sudo bash
```

固定版本时追加 `--version`，例如：

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh \
  | sudo bash -s -- --version v1.0.3
```

一键脚本需要 `curl`、`jq`、`unzip` 和 `sha256sum`。安装器检测到已有 KixDNS 时会在终端交互询问“仅安装面板”或“安装 KixDNS Enhanced 并由面板管理”；无人值守环境仍须显式使用 `--keep-existing` 或 `--replace-existing`。

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

ARM64 使用 `kixdns-panel-linux-arm64`。安装脚本还会校验包内 `SHA256SUMS`，启动 Panel Server 和受限服务控制 helper；首次受管安装不会自动启动 KixDNS。

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

迁移模式只替换面板约定的 KixDNS 二进制和 unit，既有配置路径会被写入 `panel.env`；迁移前的 unit、启用状态和运行状态会保留。保留模式下，面板仍可通过受限 helper 控制既有 unit，但原版 KixDNS 不具备增强指标和结构化热加载回执时，对应页面会显示不可用。迁移到增强版必须重新运行安装脚本并明确选择迁移，helper 不提供二进制或 systemd unit 改写能力。

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
| `/var/lib/kixdns-panel/bundle/` | 完整安装包自带 KixDNS 的只读构建身份 |
| `/var/lib/kixdns-panel-update/` | root 写入、面板只读的在线更新状态 |
| `/var/lib/kixdns-panel/geo/` | 按内容摘要保存的 GeoIP 与 GeoSite 数据 |
| `/run/kixdns/admin.sock` | `0660` 本机增强控制通道 |
| `/run/kixdns-panel/control.sock` | `0600`、仅面板 UID 可用的服务控制 helper 通道 |
| `/usr/local/libexec/kixdns-panel-helper` | root 运行的固定动作服务控制 helper |
| `/usr/share/kixdns-panel/web` | 前端静态资源 |

面板进程不以 root 运行。独立的 `kixdns-panel-helper` 以 root 运行，但只监听本机 Unix Socket：文件所有者固定为 `kixdns-panel` 且权限为 `0600`，连接后再通过 `SO_PEERCRED` 校验 UID。helper 的 unit 名称和面板 UID 由 root 安装器写入，KixDNS 控制只接受 `start`、`stop`、`restart`；面板更新只接受固定的 `panel-update` 动作并启动 root 所有的固定更新器。两条路径都不执行 Shell，也不接受 URL、文件路径或任意 unit。外部模式不会授予面板替换 KixDNS 二进制的能力。systemd 单元启用了只读系统目录、私有临时目录、能力边界和地址族限制。

日志页依赖 `systemd-journal` 组。journald 本身不支持按 unit 授权，因此该组也能读取宿主机其他 journal；这是当前部署的明确权限边界。不能接受此权限时，应移除 `kixdns-panel` 的 `systemd-journal` 附加组，同时停用面板日志页。不要用带参数通配符的 sudoers 规则替代，它会扩大命令执行范围。

## 初次访问

默认监听 `0.0.0.0:5738`，允许同一可信内网中的设备访问。安装完成时会优先使用默认路由对应的 RFC 1918 或 CGNAT IPv4 地址生成链接，例如：

```bash
http://192.168.1.20:5738
```

首次页面会要求创建管理员，密码至少 12 个字符。多网卡主机若展示的地址不可达，可运行 `ip -4 address` 查看其他内网地址；服务仍监听全部 IPv4 网卡。升级安装只会把旧版默认值 `127.0.0.1:5738` 迁移为新默认值，已有自定义 `KIXDNS_PANEL_BIND` 不会被覆盖。

`0.0.0.0` 也包括公网网卡，因此不要在路由器上映射 `5738`，云主机安全组或主机防火墙也应只允许可信网段。若只需本机反向代理，可将 `/etc/kixdns-panel/panel.env` 中的 `KIXDNS_PANEL_BIND` 改回 `127.0.0.1:5738` 并重启面板。

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

面板“系统”页分别管理 KixDNS Enhanced 数据面版本和面板正式版更新：

1. “Actions”读取 `build-kixdns.yml` 的成功构建并显示包名中的上游官方 Run；“Releases”读取 `build-kixdns-release.yml` 的成功构建并显示包名中的上游正式标签。两者都从本仓库 Actions 通过 nightly.link 匿名下载，不要求用户配置 GitHub Token。Action 最多维护 10 个已验证版本；Release 从 `v0.1.1` 起只追加，不固定限制为两个或其他数量。
2. 安装请求只提交 `release/action` 与 GitHub Artifact ID。后端在固定工作流最近 30 次成功运行中重新解析来源，拒绝前端传入下载 URL 或文件路径。
3. 校验 GitHub Artifact digest、包内 `SHA256SUMS`、`KIXDNS_BUILD_COMMIT`、`KIXDNS_CAPABILITIES.json`、`upstream.lock.json` 的 `source` 与官方 Run/Release 身份、补丁集、控制协议、ELF 格式和 CPU 架构。
4. 使用能力清单预检当前配置；不兼容时返回 `422 unsupported_config_fields`，不会停止服务、写入版本库存或改写配置。
5. 校验完成后按 `source + artifact_id + 构建提交` 写入版本目录，能力保存到本地清单 v5。同一次工作流运行可以批量构建多个上游基线，因此不能只按提交 SHA 复用库存。
6. 激活版本时重新校验清单、能力和二进制 SHA-256，然后停止服务、原子替换运行文件、启动服务并等待增强接口健康；启动或健康检查失败时恢复原状态。

真实包名示例：上游 Action `#30235703570` 当前对应 `kixdns-enhanced-action-30235703570-p8-46ac788fc96c-linux-x86_64`，上游 Release `v0.1.1` 对应 `kixdns-enhanced-release-v0.1.1-p8-1598ba62c01f-linux-x86_64`。下载 URL 统一为 `https://nightly.link/tuoro/kixdns-panel/actions/runs/<增强-run-id>/<artifact>.zip`。

已下载版本可直接切换，无需重复联网。面板最多保留 8 个本地版本，清理时始终保留当前版本。完整安装包自带的 KixDNS 会在面板启动时校验二进制 SHA-256，并离线收录完整 Artifact、上游和补丁身份；GitHub 暂时不可达时本地安装信息仍会显示。Actions Artifact 保留 90 天；每周任务会提前 7 天续建，已过期的远端包不会出现在可安装列表，本地已校验库存不受影响。

SQLite 中配置历史最多保留 100 条，审计事件最多保留 10,000 条；每次写入与清理处于同一事务，服务启动时也会整理旧数据库，避免长期运行造成无界增长。

## GeoIP 与 GeoSite 数据

配置管理页支持“远程链接”和“本地路径”两种模式。远程模式只接受 HTTPS 文件直链；Panel Server 下载后按 SHA-256 写入 `KIXDNS_GEO_DATA`，再把实际本地路径填入待保存配置。链接元数据保存在 SQLite，不会写入 KixDNS 配置。已有本地路径不会被迁移或覆盖，仍可直接使用本地路径模式。

下载端拒绝 URL 用户信息、本机、私网、链路本地和保留地址，每次重定向都会重新解析并固定公网地址；单个文件上限 128 MiB，最多允许 8 个 GeoSite 文件。文件使用 `0640`、内容寻址文件名与原子落盘，`kixdns` 通过同组只读。旧哈希文件不会自动覆盖或清理，以保证配置历史回滚仍能读取原数据。

Panel Server 与 Web 可以在“系统”页在线更新，也可以手动下载完整包重新运行 `scripts/install.sh`。在线更新只接受 `tuoro/kixdns-panel` 最新稳定三段式 Release，浏览器不能提交 URL、路径或版本参数；root 更新器按当前架构下载正式资产，先校验 GitHub API 提供的 SHA-256，再校验包内 `SHA256SUMS`。内部 `--panel-only-update` 事务只替换 Panel Server、Web、helper、一键安装器、卸载器和面板 systemd unit，保留 KixDNS 二进制、构建身份、配置、数据库以及运行/启用状态；失败会恢复旧面板。更新期间面板会短暂重启，页面恢复连接后自动刷新。失败详情可查看 `journalctl -u kixdns-panel-update.service`。

完整包使用 `PANEL_BUILD_COMMIT` 标识管理面构建，使用 `KIXDNS_BUILD_COMMIT` 标识被复用的数据面构建，并分别写入 `KIXDNS_PANEL_INSTALLED_COMMIT` 与 `KIXDNS_INSTALLED_COMMIT`。正式包携带 `PANEL_RELEASE` 并写入 `KIXDNS_PANEL_INSTALLED_RELEASE`；当前正式版本为 `v1.0.3`，后续版本仍通过正式 GitHub Release 发布。日常 Action 构建不会触发面板正式版更新。旧版默认工作流名会迁移到 `build-kixdns.yml`，缺少的 `KIXDNS_UPDATE_RELEASE_WORKFLOW` 会补为 `build-kixdns-release.yml`，已有自定义 KixDNS 更新源保持不变。

服务生命周期只支持启动、停止和重启。首次受管安装保持 `inactive + disabled`；面板“启动”同时启用开机启动，“停止”同时禁用开机启动，“重启”不改变开机策略，因此宿主机重启后会保持用户最后选择的启停状态。覆盖升级会分别保留安装前的运行状态和启用状态。KixDNS 停止后概览与查询排行继续展示最后一次成功快照，并明确提示数据停止更新；配置页在停止状态显示“未启动，无法确认当前 KixDNS 配置能力”，受能力约束的已有字段只读保留。

KixDNS 没有独立的服务重载动作，面板不会提供重载按钮、API、helper 动作或 systemd `ExecReload`。配置保存和历史版本恢复使用 KixDNS 的文件监听热加载链路：候选内容先由 KixDNS 自身校验；写入后必须收到新的 `reload_sequence` 且 SHA-256 一致，否则面板恢复旧配置。该回执不等同于服务重载命令。

配置页和版本切换遵循[配置能力契约](config-capabilities.md)。不受当前 KixDNS 支持的新字段不会出现在空配置中；配置已经含有该字段时保持只读并原样保留。JSON/API 不能绕过后端检查，切换到能力不足的本地或远程版本也会在替换二进制前被拒绝。

## 运维命令

```bash
systemctl status kixdns.service kixdns-panel-helper.service kixdns-panel.service
journalctl -u kixdns.service -n 200 --no-pager
journalctl -u kixdns-panel.service -n 200 --no-pager
journalctl -u kixdns-panel-helper.service -n 200 --no-pager
sudo systemctl restart kixdns-panel.service
```

常见问题：

- `address already in use`：宿主机已有 DNS 服务占用 53 端口，先调整或停用冲突服务。
- 面板显示控制接口不可用：检查 `/run/kixdns/admin.sock`、两个账号的 `kixdns` 组关系和 KixDNS 日志。
- 服务控制被拒绝：检查 `kixdns-panel-helper.service`、`/run/kixdns-panel/control.sock` 权限和 helper 日志；覆盖旧版安装时旧 Polkit 规则会被自动清理。
- 面板在线更新失败：运行 `systemctl status kixdns-panel-update.service` 和 `journalctl -u kixdns-panel-update.service`；失败不会替换 KixDNS，安装事务会恢复原面板文件。
- 日志读取失败：确认 `kixdns-panel` 属于 `systemd-journal` 组，重启面板使组关系生效。
- Geo 数据下载失败：确认填写的是 HTTPS 文件直链，且目标不会重定向到登录页、私网或超过 128 MiB 的文件。

## 卸载

安装后推荐使用全局卸载命令：

```bash
sudo kixdns-panel-uninstall
```

卸载器会依次询问两项：是否保留当前 KixDNS，以及是否保留面板配置、数据库、版本库和 Geo 数据。选择“删除配置”不可恢复，执行前应备份 `pipeline.json` 和 `panel.db`。外部模式下，为避免误删用户已有服务，KixDNS 的二进制、unit、配置和账号始终保留；迁移模式选择移除增强版时，会先恢复迁移前的外部 unit 和运行状态。

无人值守示例：

```bash
# 仅卸载面板，保留 KixDNS 和面板数据
sudo kixdns-panel-uninstall --keep-kixdns --keep-config --yes

# 卸载面板并删除面板管理的 KixDNS、配置和运行数据
sudo kixdns-panel-uninstall --remove-kixdns --remove-config --yes
```

旧命令 `sudo bash ./scripts/uninstall.sh --purge` 仍然兼容，等同于第二个示例。没有本地命令时，可以执行 `curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh | sudo bash`，交互逻辑完全相同。
