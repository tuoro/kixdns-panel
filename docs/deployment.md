# KixDNS Panel 部署指南

## 支持范围

- 带 systemd 的 Linux x86_64/ARM64
- GLIBC 2.35 及以上：Ubuntu 22.04、Debian 12 或更新发行版
- 需要 `systemctl`、`sha256sum`、`getent`；一键安装和下载示例另需 `curl`、`jq`、`unzip`

完整安装包在面板的 [GitHub Releases](https://github.com/tuoro/kixdns-panel/releases) 发布，包含 KixDNS Enhanced、Panel Server、前端静态资源、服务单元和安装脚本。

## 安装

### 一键安装

读取最新正式 Release，按架构选包，校验 GitHub 提供的 SHA-256 后调用包内安装器：

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh | sudo bash
```

固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh \
  | sudo bash -s -- --version v3.0.1
```

### 手动安装

```bash
# ARM64 把 x86_64 换成 arm64
curl -fL -o kixdns-panel.zip \
  https://github.com/tuoro/kixdns-panel/releases/download/v3.0.1/kixdns-panel-linux-x86_64.zip
mkdir kixdns-panel && unzip kixdns-panel.zip -d kixdns-panel
cd kixdns-panel
sudo bash ./scripts/install.sh
```

安装脚本会校验包内 `SHA256SUMS`。首次安装不会自动启动 KixDNS。

### 开发构建

`main` 分支的 Action 包只用于验证和开发，通过 nightly.link 匿名下载。下面的示例额外核对 GitHub 记录的 Artifact digest：

```bash
REPOSITORY=tuoro/kixdns-panel
WORKFLOW=build-panel.yml
ARTIFACT=kixdns-panel-linux-x86_64   # 或 kixdns-panel-linux-arm64

RUN_ID="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&per_page=1" \
  | jq -r '.workflow_runs[0].id')"
DIGEST="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  | jq -r --arg name "$ARTIFACT" '.artifacts[] | select(.name == $name and .expired == false) | .digest')"

curl -fL -o kixdns-panel.zip \
  "https://nightly.link/${REPOSITORY}/workflows/${WORKFLOW}/main/${ARTIFACT}.zip"
printf '%s  %s\n' "${DIGEST#sha256:}" kixdns-panel.zip | sha256sum --check -
```

开发构建不会触发面板的更新提示。

### 主机上已有 KixDNS

安装脚本不会默认替换非本面板管理的 KixDNS，交互终端会让你选择：

| 选项 | 效果 |
| --- | --- |
| `1` 仅安装面板 | 保留原 KixDNS；面板可控制其启停，但不下载、替换或删除二进制，版本管理停用。原版不具备增强指标时对应页面显示不可用；原 unit 若把 `StandardOutput`/`StandardError` 改到了 journald 之外（文件、`null` 等），日志页只能看到 systemd 自己的启停记录，并会常驻提示 |
| `2` 迁移为增强版 | 保留原配置路径（写入 `panel.env`），替换二进制和 unit；原 unit 与启停状态备份到 `/var/lib/kixdns-panel/external-backup/`，卸载时可恢复 |
| `3` 取消 | — |

无人值守安装必须显式选择：

```bash
sudo bash ./scripts/install.sh --keep-existing \
  --kixdns-unit kixdns.service \
  --kixdns-config /etc/kixdns/pipeline.json \
  --kixdns-binary /usr/local/bin/kixdns

sudo bash ./scripts/install.sh --replace-existing
```

从「仅安装面板」改为迁移，需要重新运行安装脚本并选择迁移。

## 首次访问

默认监听 `0.0.0.0:5738`。安装器会用默认路由对应的内网 IPv4 生成访问链接，如 `http://192.168.1.20:5738`；多网卡时地址不通可用 `ip -4 address` 找其他地址。首次访问创建管理员，密码至少 12 个字符。

`0.0.0.0` 包括公网网卡：**不要在路由器上映射 `5738`**，防火墙或安全组只放行可信网段。只需本机反向代理时，把 `/etc/kixdns-panel/panel.env` 的 `KIXDNS_PANEL_BIND` 改为 `127.0.0.1:5738` 并重启面板。升级只会把旧默认值 `127.0.0.1:5738` 迁移为新默认值，自定义值不变。

## HTTPS 反向代理

Nginx 最小片段（TLS 按现有配置补充）：

```nginx
location / {
    proxy_pass http://127.0.0.1:5738;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

启用 HTTPS 后打开 Secure Cookie：

```bash
sudo sed -i 's/^KIXDNS_PANEL_SECURE_COOKIE=.*/KIXDNS_PANEL_SECURE_COOKIE=true/' \
  /etc/kixdns-panel/panel.env
sudo systemctl restart kixdns-panel.service
```

默认只信任回环地址（`127.0.0.1/32,::1/128`）传来的 `X-Forwarded-For`。代理在容器或其他主机上时，把它的精确 CIDR 写入 `KIXDNS_TRUSTED_PROXIES`，否则限流会把所有请求算到代理地址上。

## 权限模型

两个不可登录的系统账号：

| 账号 | 权限 |
| --- | --- |
| `kixdns` | 运行 DNS 数据面；只读配置；通过 `CAP_NET_BIND_SERVICE` 监听 53 端口 |
| `kixdns-panel` | 写配置、SQLite 与受管 KixDNS 二进制；读管理 Socket 与 journal |

面板进程不以 root 运行。启停 KixDNS 和面板自更新经由 root 运行的 `kixdns-panel-helper` 完成：它只监听权限 `0600` 的 Unix Socket 并用 `SO_PEERCRED` 核对调用方 UID，只接受 `start`、`stop`、`restart` 和固定的 `panel-update`，不执行 Shell、不接受 URL 或路径。

**日志页的权限边界**：日志页需要 `kixdns-panel` 属于 `systemd-journal` 组，而 journald 不支持按 unit 授权，所以该组能读宿主机全部 journal。不接受的话，把 `kixdns-panel` 移出该组并停用日志页；不要改用带通配符的 sudoers 规则，那会扩大命令执行范围。

## 关键路径

| 路径 | 用途 |
| --- | --- |
| `/etc/kixdns/pipeline.json` | KixDNS 配置，面板原子写入 |
| `/etc/kixdns-panel/panel.env` | 面板启动参数 |
| `/var/lib/kixdns-panel/panel.db` | 用户、会话、配置历史、审计、版本记录与请求量采样 |
| `/var/lib/kixdns-panel/bin/kixdns` | 受管 KixDNS 二进制 |
| `/var/lib/kixdns-panel/versions/` | 已下载的 KixDNS 版本 |
| `/var/lib/kixdns-panel/bundle/` | 安装包自带 KixDNS 的构建身份 |
| `/var/lib/kixdns-panel/geo/` | 按内容摘要保存的 GeoIP/GeoSite 数据 |
| `/var/lib/kixdns-panel/github-token` | 可选 GitHub Token（`0600`） |
| `/var/lib/kixdns-panel-update/` | 在线更新状态，root 写、面板只读 |
| `/run/kixdns/admin.sock` | 增强控制通道（`0660`） |
| `/run/kixdns-panel/control.sock` | helper 通道（`0600`） |
| `/usr/local/libexec/kixdns-panel-helper` | root helper |
| `/usr/share/kixdns-panel/web` | 前端静态资源 |

数据库有界：配置历史最多 100 条，审计事件最多 10,000 条，请求量采样每 60 秒一个、只留 25 小时，都在写入时顺带清理。

## 服务启停

- 只有启动、停止、重启三个动作；没有「重载」
- **启动**同时启用开机自启，**停止**同时禁用，**重启**不改变开机策略——宿主机重启后保持你最后的选择
- 首次安装为停止且未启用；覆盖升级保留原有启停与开机状态
- KixDNS 停止后，概览和查询排行继续显示最后一次数据并标明已停止更新

配置保存不重启服务，而是走 KixDNS 的文件监听热加载：写入前由 KixDNS 校验，写入后必须等到新的 `reload_sequence` 且摘要一致，否则面板恢复旧配置。

## KixDNS 版本管理

「系统」页有两个版本源，都是本仓库 Action 构建的增强包：

- **Actions**：跟随上游 `main` 的成功构建，保留最近 10 个
- **Releases**：跟随上游正式发布，从 `v0.1.1` 起只增不减（`v0.1.0` 早于增强协议，无法提供）

安装一个版本时，面板：

1. 只接受来源类型和 Artifact ID，在固定工作流的最近 30 次成功运行里重新查找，不接受前端给的 URL 或路径
2. 校验 Artifact digest、包内 `SHA256SUMS`、上游身份、补丁集、控制协议、ELF 格式与 CPU 架构
3. 用包内能力清单预检当前配置，不兼容就返回 `422 unsupported_config_fields`，不停服务、不改配置
4. 激活时再次校验，停服务 → 替换二进制 → 启动 → 等待健康检查；失败则恢复原状态

已下载的版本可离线切换，本地最多保留 8 个（始终保留当前版本）。Actions Artifact 在 GitHub 上保留 90 天，每周任务会提前 7 天续建；远端过期不影响本地已下载的版本。

新配置字段的兼容规则见[配置能力契约](config-capabilities.md)。

## GeoIP 与 GeoSite 数据

配置页支持两种模式：

- **远程链接**：只接受 HTTPS 直链。面板下载后按 SHA-256 存入 `/var/lib/kixdns-panel/geo/`，把本地路径写进配置；链接本身只存在面板数据库。单文件上限 128 MiB，GeoSite 最多 8 个。拒绝指向本机、私网和保留地址的链接，每次重定向都重新检查。旧文件不自动清理，以便回滚历史配置
- **本地路径**：直接使用已有文件，不迁移、不覆盖

## 面板更新

「系统」页可在线更新到 `tuoro/kixdns-panel` 最新正式 Release，也可以下载完整包重新运行 `install.sh`。

- 只更新 Panel Server、前端、helper、安装与卸载脚本和面板 unit；**KixDNS 二进制、配置、数据库和启停状态都不动**
- 浏览器不能指定 URL、路径或版本；下载后先校验 GitHub 资产摘要，再校验包内 `SHA256SUMS`
- 失败自动恢复旧面板；更新期间面板短暂重启，页面重连后自动刷新
- 失败详情：`journalctl -u kixdns-panel-update.service`

升级从不需要转换配置：配置文件 `version` 一直是 `1.0`，控制协议一直是 v1，任意旧版可以直接覆盖安装。

## GitHub Token（可选）

面板检查版本时调用 GitHub API，匿名配额是每个出口 IP 每小时 60 次。同一公网 IP 下有多台设备时，建议在「系统」页配置只读 Token（Fine-grained 或 Classic PAT 均可）。

- 保存前先调用 GitHub `/rate_limit` 验证
- 单独存放在 `/var/lib/kixdns-panel/github-token`（`0600`），不进数据库、`panel.env`、审计记录或 API 响应
- 只附加到 `api.github.com` 请求，nightly.link 和 Release 下载不带认证
- 删除后立即恢复匿名

## 运维

```bash
systemctl status kixdns.service kixdns-panel-helper.service kixdns-panel.service
journalctl -u kixdns.service -n 200 --no-pager
journalctl -u kixdns-panel.service -n 200 --no-pager
journalctl -u kixdns-panel-helper.service -n 200 --no-pager
sudo systemctl restart kixdns-panel.service
```

| 现象 | 排查 |
| --- | --- |
| `address already in use` | 宿主机已有服务占用 53 端口，先停用或调整 |
| 控制接口不可用 | 检查 `/run/kixdns/admin.sock`、两个账号的 `kixdns` 组关系和 KixDNS 日志 |
| 服务控制被拒绝 | 检查 `kixdns-panel-helper.service` 与 `/run/kixdns-panel/control.sock` 权限 |
| 在线更新失败 | `systemctl status kixdns-panel-update.service`；失败不会动 KixDNS |
| 日志读取失败 | 确认 `kixdns-panel` 在 `systemd-journal` 组，重启面板使组关系生效 |
| Geo 数据下载失败 | 确认是 HTTPS 直链，且不会重定向到登录页、私网或超过 128 MiB 的文件 |

## 卸载

```bash
sudo kixdns-panel-uninstall
```

卸载器会问两件事：是否保留 KixDNS，是否保留面板配置、数据库、版本库和 Geo 数据。删除配置不可恢复，先备份 `pipeline.json` 和 `panel.db`。

- 「仅安装面板」模式下，原 KixDNS 的二进制、unit、配置和账号始终保留
- 迁移模式下选择移除增强版，会先恢复迁移前的 unit 和启停状态

无人值守：

```bash
# 只卸面板，保留 KixDNS 和数据
sudo kixdns-panel-uninstall --keep-kixdns --keep-config --yes

# 全部删除
sudo kixdns-panel-uninstall --remove-kixdns --remove-config --yes
```

没有本地命令时：`curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh | sudo bash`。旧命令 `sudo bash ./scripts/uninstall.sh --purge` 等同于全部删除。
