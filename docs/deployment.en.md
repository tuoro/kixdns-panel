# KixDNS Panel deployment guide

[简体中文](deployment.md) | **English**

## Supported systems

- Linux x86_64/ARM64 with systemd
- GLIBC 2.35 or later: Ubuntu 22.04, Debian 12 or newer distributions
- Requires `systemctl`, `sha256sum`, `getent`. One-line install and the download examples also need `curl`, `jq`, `unzip`

The full package is published on the panel's [GitHub Releases](https://github.com/tuoro/kixdns-panel/releases). It contains KixDNS Enhanced, Panel Server, the frontend static assets, the service units and the install scripts.

## Install

### One-line install

Reads the latest stable Release, picks the package by architecture, validates the SHA-256 provided by GitHub, then calls the installer inside the package:

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh | sudo bash
```

Pinned version:

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh \
  | sudo bash -s -- --version v4.3.3
```

- [Install options](#install-options) also go after `| sudo bash -s --`
- When the same version is already installed and the panel is running, it ends after reading the Release information and does not download the package. Add `--reinstall` to force a repair reinstall. When the panel is not running, it is treated as a repair reinstall automatically
- Reading the Release uses the GitHub API, limited to 60 anonymous requests per hour per egress IP. If it reports HTTP 403/429, retry later, or write a read-only Token and run it again (the install hands the Token to the panel account, and the 系统 (System) page can use it afterwards):

  ```bash
  sudo install -d -m 0755 /var/lib/kixdns-panel
  read -rsp 'GitHub Token: ' token && printf '%s\n' "$token" \
    | sudo install -m 0600 /dev/stdin /var/lib/kixdns-panel/github-token; unset token
  ```

  You can also use the manual install below instead. Release downloads do not go through the API.

### Manual install

```bash
# For ARM64, replace x86_64 with arm64
curl -fL -o kixdns-panel.zip \
  https://github.com/tuoro/kixdns-panel/releases/download/v4.3.3/kixdns-panel-linux-x86_64.zip
mkdir kixdns-panel && unzip kixdns-panel.zip -d kixdns-panel
cd kixdns-panel
sudo bash ./scripts/install.sh
```

The install script validates the `SHA256SUMS` inside the package. A first install does not start KixDNS automatically.

Every question that needs your decision (migrating an existing KixDNS, turning off the systemd-resolved listener on port 53) is asked before the host is changed. After that, the install either completes fully or rolls back fully: a failure midway, Ctrl-C or a lost SSH connection all restore the original programs and services. After the services start, the installer waits until the panel runs stably and accepts connections (a KixDNS restarted during a migration or upgrade must also stay running). Otherwise it also rolls back, and gives the command to view the logs.

### Install options

| Option | Purpose |
| --- | --- |
| `--replace-existing` | Agrees to migrate the existing KixDNS to the enhanced build. Required for unattended installs when an existing KixDNS is found |
| `--reinstall` | Reinstalls even when the same version is already installed. Used to repair a modified or damaged install |
| `--panel-only-update` | Updates only the panel, equivalent to the panel update on the 系统 (System) page. Does not stop or replace KixDNS |
| `--kixdns-unit`, `--kixdns-config`, `--kixdns-binary`, `--control-socket` | Specify these by hand when an existing KixDNS is not in the default location and cannot be detected automatically from the unit |

One-line install puts options after `bash -s --`. They are checked before the installer runs, so a misspelled option does not change the host:

```bash
curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/one-click-install.sh \
  | sudo bash -s -- --replace-existing
```

### Re-running and upgrading

- When the installed panel and the package are the same version (stable packages compare the Release tag, development builds compare the build commit) and the panel is running, the installer only prints 已安装，未作任何修改 (Installed, nothing changed) and exits. To repair the install, add `--reinstall`. When the panel is not running, the installer explains why and reinstalls automatically as with `--reinstall`
- An overwrite install or upgrade stops KixDNS and restarts it according to its previous state only when the KixDNS program or unit actually changed. Otherwise DNS is not interrupted. When KixDNS will be stopped, the installer says so first
- The first line of the result is the installed version, followed by the panel address and the actual KixDNS state. The build commit is on the last line

### Development builds

Action packages from the `main` branch are for verification and development only, and are downloaded anonymously through nightly.link. The example below additionally checks the Artifact digest recorded by GitHub:

```bash
REPOSITORY=tuoro/kixdns-panel
WORKFLOW=build-panel.yml
ARTIFACT=kixdns-panel-linux-x86_64   # or kixdns-panel-linux-arm64

# Take only runs triggered by this repository's own pushes: PRs from forks can also appear in the branch=main results
RUN_ID="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&event=push&per_page=20" \
  | jq -r --arg repo "$REPOSITORY" '[.workflow_runs[] | select(.head_repository.full_name == $repo)][0].id')"
DIGEST="$(curl -fsSL \
  "https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  | jq -r --arg name "$ARTIFACT" '.artifacts[] | select(.name == $name and .expired == false) | .digest')"

curl -fL -o kixdns-panel.zip \
  "https://nightly.link/${REPOSITORY}/workflows/${WORKFLOW}/main/${ARTIFACT}.zip"
printf '%s  %s\n' "${DIGEST#sha256:}" kixdns-panel.zip | sha256sum --check -
```

Development builds do not trigger the panel's update prompt.

### KixDNS already on the host

When the installer finds a KixDNS not installed by this panel, it lists the detected unit, configuration, program and running state, explains what the migration will do, then asks 迁移为增强版？[y/N] (Migrate to the enhanced build?). The default is not to migrate. Answering `n` or pressing Enter cancels the install, and the host is not changed.

Migration does the following:

- The configuration file stays in its original location (the path is written to `panel.env`) and is managed by the panel from then on
- Replaces the KixDNS program and systemd unit with the enhanced build
- Backs up the original unit and its running and boot state to `/var/lib/kixdns-panel/external-backup/`
- Keeps the original running state: what was running keeps running after the migration, what was stopped stays stopped. If the enhanced build fails to start, the whole install rolls back to the pre-migration state
- Choosing to remove the enhanced build when uninstalling the panel puts the original unit back and restores the original running state

An unattended install (no terminal, or through `curl | sudo bash`) migrates only with `--replace-existing`. Otherwise it exits immediately and gives the command.

The 仅安装面板 (panel only) mode of early versions has been removed: the panel it installed could not start. `--keep-existing` is refused. On a host installed in this mode, first run `sudo kixdns-panel-uninstall` (the original KixDNS stays unchanged), then install again and choose migration. If you kept the configuration when uninstalling, you can also reinstall directly, and the leftover old settings are cleared.

### Port 53

KixDNS listens on `0.0.0.0:53` by default. Before changing the host, the installer checks the ports according to `bind_udp`/`bind_tcp` in the configuration:

- **Held by systemd-resolved** (`127.0.0.53`, the Ubuntu default): with a terminal, the installer asks whether to turn off its local listener. The default is not to. If you agree, the installer writes `/etc/systemd/resolved.conf.d/kixdns-panel.conf` (`DNSStubListener=no`), repoints `/etc/resolv.conf` to `/run/systemd/resolve/resolv.conf` when it points at the local cache, restarts systemd-resolved, and confirms that the port is free and local name resolution still works. A failure at any step rolls back. The original `resolv.conf` is recorded in `/var/lib/kixdns-panel/resolved-stub/`. Choosing to remove KixDNS at uninstall restores it (keeping KixDNS only gives the restore command, because KixDNS still uses this port)
- **Declined or unattended**: nothing is changed, and the install result gives the commands to run by hand
- **Held by another program**: reports the process name and PID and never touches it. If this install needs to restart a KixDNS that was running, the install halts before changing the host

## First access

The panel listens on `0.0.0.0:5738` by default. The installer generates the access link from the private IPv4 address of the default route, such as `http://192.168.1.20:5738`. On a host with several network interfaces, if that address is unreachable, use `ip -4 address` to find another one. The first visit creates the administrator. The password must be at least 12 characters.

`0.0.0.0` includes public network interfaces: **do not forward `5738` on your router**, and allow only trusted networks in the firewall or security group. If you only need a reverse proxy on the same host, change `KIXDNS_PANEL_BIND` in `/etc/kixdns-panel/panel.env` to `127.0.0.1:5738` and restart the panel. Upgrades leave this setting as it is.

### Forgotten administrator password

The panel has no password recovery option. Run this on the machine where the panel is installed:

```bash
sudo -u kixdns-panel /usr/local/bin/kixdns-panel-server --database /var/lib/kixdns-panel/panel.db reset-admin
```

It deletes all administrator accounts and login sessions. The configuration, version history and audit trail are kept, and the audit trail gains one 重置管理员 (Reset administrator) entry. After that, opening the panel goes back to 创建管理员 (Create administrator). Open the panel and create a new administrator as soon as possible after the reset: until then, anyone who can reach the panel can create one first. If you changed `KIXDNS_PANEL_DATABASE`, replace the `--database` value with the path in `/etc/kixdns-panel/panel.env`.

## HTTPS reverse proxy

Minimal Nginx snippet (add TLS according to your existing configuration):

```nginx
location / {
    proxy_pass http://127.0.0.1:5738;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

After enabling HTTPS, turn on Secure Cookie:

```bash
sudo sed -i 's/^KIXDNS_PANEL_SECURE_COOKIE=.*/KIXDNS_PANEL_SECURE_COOKIE=true/' \
  /etc/kixdns-panel/panel.env
sudo systemctl restart kixdns-panel.service
```

By default, `X-Forwarded-For` is trusted only from loopback addresses (`127.0.0.1/32,::1/128`). When the proxy is in a container or on another host, write its exact CIDR into `KIXDNS_TRUSTED_PROXIES`. Otherwise rate limiting counts all requests against the proxy address.

## Permission model

Two system accounts that cannot log in:

| Account | Permissions |
| --- | --- |
| `kixdns` | Runs the DNS data plane. Reads the configuration only. Listens on port 53 through `CAP_NET_BIND_SERVICE` |
| `kixdns-panel` | Writes the configuration, SQLite and the managed KixDNS binary. Reads the admin socket and the journal |

The panel process does not run as root. Starting and stopping KixDNS and the panel self-update go through `kixdns-panel-helper`, which runs as root. It listens only on a Unix socket with permission `0600` and checks the caller's UID with `SO_PEERCRED`. It accepts only `start`, `stop`, `restart` and the fixed `panel-update`. It does not execute a shell and does not accept URLs or paths.

**Permission boundary of the logs page**: the logs page needs `kixdns-panel` to be in the `systemd-journal` group, and journald does not support per-unit grants, so this group can read the entire journal of the host. If that is not acceptable, remove `kixdns-panel` from the group and disable the logs page. Do not switch to sudoers rules with wildcards: they widen the scope of command execution.

## Key paths

| Path | Purpose |
| --- | --- |
| `/etc/kixdns/pipeline.json` | KixDNS configuration, written atomically by the panel |
| `/etc/kixdns-panel/panel.env` | Panel startup parameters |
| `/var/lib/kixdns-panel/panel.db` | Users, sessions, configuration history, audit, version records and request volume samples |
| `/var/lib/kixdns-panel/bin/kixdns` | Managed KixDNS binary |
| `/var/lib/kixdns-panel/versions/` | Downloaded KixDNS versions |
| `/var/lib/kixdns-panel/bundle/` | Build identity of the KixDNS bundled with the package |
| `/var/lib/kixdns-panel/geo/` | GeoIP/GeoSite data stored by content digest |
| `/var/lib/kixdns-panel/querylog/` | Query log (directory `0700`, files `0600`): one segment per hour, compressed to `.jsonl.zst` as it is written. `.jsonl.gz` files left by older versions can still be read |
| `/var/lib/kixdns-panel/github-token` | Optional GitHub Token (`0600`) |
| `/var/lib/kixdns-panel-update/` | Online update state, written by root, read-only for the panel |
| `/run/kixdns/admin.sock` | Enhanced control socket (`0660`) |
| `/run/kixdns-panel/control.sock` | helper socket (`0600`) |
| `/usr/local/libexec/kixdns-panel-helper` | root helper |
| `/usr/share/kixdns-panel/web` | Frontend static assets |
| `/usr/share/kixdns-panel/geo` | GeoSite bundled with the package: `geosite.dat`, the source description `geosite.json` and its GPL-3.0 license, replaced as a whole when the panel is upgraded |

The database is bounded: at most 100 configuration history entries, at most 10,000 audit events, and one request volume sample every 60 seconds, kept for only 25 hours. All are cleaned up during writes. The query log is also bounded: the oldest segment is deleted by retention time (default 90 days) and space limit (default 500 MB, counted as the actual compressed size on disk). Both are changed in the query log settings.

## Starting and stopping the service

- There are only three actions: start, stop and restart. There is no 重载 (Reload)
- **启动 (Start)** also enables start on boot, **停止 (Stop)** also disables it, **重启 (Restart)** does not change the boot policy. After a host reboot, your last choice holds
- A first install leaves the service stopped and not enabled. Migration, an overwrite upgrade, and updating or reverting the kernel on the 系统 (System) page all keep the existing running and boot state
- After KixDNS stops, the overview and query rankings keep showing the last data and mark it as no longer updating

Saving the configuration does not restart the service. It goes through KixDNS's file-watch hot reload: KixDNS validates it before the write. After the write, a new `reload_sequence` with a matching digest must arrive, otherwise the panel restores the old configuration.

## KixDNS kernel updates

The kernel comes from stable releases of the fork [tuoro/kixdns](https://github.com/tuoro/kixdns). The version is the date `YYYY.MM.DD`, and another release on the same day is `YYYY.MM.DD.N`. The 系统 (System) page looks only at the latest one, and only a newer dated version shows 有新版本 (New version). Dependency fixes also publish new versions, with no separate notice. 发布说明 (Release notes) links to the release page of this version.

When updating the kernel, the panel:

1. Accepts only the kernel package ID shown on the page, and reads the latest release again. If a new version was published in the meantime, it returns `409`: refresh and update again. It does not accept a URL or path from the frontend
2. First prechecks the current configuration against the configuration capabilities in the release manifest. If they are incompatible, it returns `422 unsupported_config_fields` and does not download, stop the service or change the configuration
3. Downloads the package for the local architecture from the release page, and checks the SHA-256 and size in the manifest, the `SHA256SUMS` inside the package, the source description (repository, version, commit, original commit, architecture, control protocol), the configuration capabilities, the ELF format and the CPU architecture
4. At activation, validates again and replaces the binary, keeping the service's original running state: a running service is restarted once and waits for the health check, and on failure the original version is put back and the service is restarted again. A stopped service is not started, and the new version takes effect at the next start. The switch never changes start on boot
5. Runs the switch in a separate background task, so a browser disconnect midway does not leave it half done

The host keeps only the current kernel and the previous one. 回退 (Revert) at the bottom of 当前安装 (Current install) switches back to the previous kernel without network access. After switching back, the kernel that was current becomes the previous one, and reverting once more switches back again. Older kernels are not kept. If you need one, install the matching older panel version (see the pinned version install above).

Hosts still on an old kernel: the Action kernels built from patchsets in the panel repository (p28 and earlier) and the even earlier Release kernels no longer receive updates. After it starts, a new panel replaces the old kernel in the background with the latest version from the fork, using the same validation and rollback as 更新 (Update). If any step fails, everything stays as it was, the failure is recorded in the audit trail, and it is tried again the next time the panel starts. You can also update by hand on the 系统 page. If you revert to the old kernel yourself after it was replaced, the panel does not replace it again.

Panels at v3.4.0 and earlier have no new kernel left to install: the panel repository no longer builds p28, and the installed kernel keeps running as usual. After the panel is upgraded, the new panel replaces the kernel with the latest version from the fork in the way described above.

For the compatibility rules of new configuration fields, see the [configuration capability contract](config-capabilities.en.md).

## GeoIP and GeoSite data

The configuration page supports two modes:

- **远程链接 (Remote link)**: accepts only direct HTTPS links. The panel downloads the file, stores it in `/var/lib/kixdns-panel/geo/` by SHA-256, and writes the local path into the configuration. The link itself is stored only in the panel database. The per-file limit is 128 MiB, with at most 8 GeoSite files. Links pointing to the local host, private networks or reserved addresses are refused, and every redirect is checked again. After a scheduled update succeeds, old files that neither the current list nor any retained configuration version references any more are deleted automatically, so the files are still there when you roll back to any retained version. Files left over after deleting history versions can be cleaned up by hand on the configuration page
- **本地路径 (Local path)**: uses the existing file directly, without migrating or overwriting it

The full package bundles a [Loyalsoldier](https://github.com/Loyalsoldier/v2ray-rules-dat) `geosite.dat` (GPL-3.0), the latest at packaging time. Before packaging, the release page digest, its accompanying `sha256sum` file and the downloaded content are checked, and the file is confirmed to contain the `cn`, `geolocation-!cn` and `category-ads-all` categories used by the templates.

- **Fresh install**: the panel imports it once at first start and writes its path into the configuration. While KixDNS has not started yet, this is stored as a pending version and takes effect after KixDNS starts
- **Upgrade and migration**: the configuration is not changed. When there is no GeoSite yet, Geo 数据 (Geo data) shows geosite.dat · 安装包自带 · 导入 (geosite.dat · bundled with the package · Import), which you click yourself. Import only fills the draft, and it takes effect after saving
- **GeoSite already present** (a link, a downloaded file or a path in the configuration): no prompt and no import, and the server also refuses it. A panel upgrade replaces only the copy in `/usr/share/kixdns-panel/geo` and does not touch imported files or the configuration
- After import, the source is recorded as Loyalsoldier's `latest` download link. 自动更新 (Auto update) is off by default. After you choose daily or weekly, it updates from this link. You can also change it to your own link

## Panel updates

The 系统 (System) page can update online to the latest stable Release of `tuoro/kixdns-panel`. The command-line equivalent is to run `install.sh --panel-only-update` from the new version's package. You can also download the full package and re-run `install.sh` directly to upgrade. KixDNS is restarted according to its previous state only when the program or unit changed.

- Updates only Panel Server, the frontend, the helper, the install and uninstall scripts and the panel unit. **The KixDNS binary, configuration and running state are not touched**. When the new panel starts, it may upgrade `panel.db` to a new schema
- The browser cannot specify a URL, path or version. After download, the GitHub asset digest is validated first, then the `SHA256SUMS` inside the package
- On failure, the old panel and the pre-update `panel.db` (together with `-wal` and `-shm`) are restored automatically, and the old panel is confirmed to be running stably again. If the old panel still cannot start, the installer says so plainly and gives `journalctl -u kixdns-panel.service -n 50 --no-pager`
- The panel restarts briefly during the update. The page refreshes automatically after it reconnects
- On failure, the 系统 page shows the specific reason (the line reported by the installer or the GitHub request). Click 知道了 (Got it) to dismiss it. The failure notice disappears automatically the next time an update starts, or after the panel is upgraded to the target version in another way
- Full output: `journalctl -u kixdns-panel-update.service -n 200 --no-pager`. The updater runs as a transient `systemd-run --collect` unit. The unit is collected once it ends, so `systemctl status` cannot find it, but the logs remain

Upgrades never need a configuration conversion: the configuration file `version` has always been `1.0`, the control protocol has always been v1, and, except for the removed 仅安装面板 (panel only) mode, any old version can be installed over directly.

## GitHub Token (optional)

The panel calls the GitHub API when it checks versions. The anonymous quota is 60 requests per hour per egress IP. When several devices share one public IP, it is recommended to configure a read-only Token on the 系统 (System) page (Fine-grained or Classic PAT both work).

- Before saving, it is verified by calling GitHub `/rate_limit`
- Stored separately in `/var/lib/kixdns-panel/github-token` (`0600`). It does not go into the database, `panel.env`, audit records or API responses
- Attached only to `api.github.com` requests. Kernel and panel packages are both downloaded from the release page without authentication, so a read-only Token is enough
- After it is deleted, requests are anonymous again immediately

## Operations

```bash
systemctl status kixdns.service kixdns-panel-helper.service kixdns-panel.service
journalctl -u kixdns.service -n 200 --no-pager
journalctl -u kixdns-panel.service -n 200 --no-pager
journalctl -u kixdns-panel-helper.service -n 200 --no-pager
sudo systemctl restart kixdns-panel.service
```

The KixDNS unit runs with `RUST_LOG=info,kixdns::engine::phases=warn`: startup, reload and warnings go into the journal as usual, but per-request response records (`dns_response`, `dns_request_finished`) do not. One line per query would flood the logs page and would also leave client IPs and domain names in the journal. When you need per-request records for temporary troubleshooting, use `sudo systemctl edit kixdns.service` to write the two lines below, then restart KixDNS. This override sits outside the unit, so upgrades do not touch it. When you are done, remember to delete it with the same command and restart:

```ini
[Service]
Environment=RUST_LOG=info
```

| Symptom | Troubleshooting |
| --- | --- |
| `address already in use` | Port 53 is in use, see [Port 53](#port-53). Use `ss -lnptu 'sport = :53'` to see what holds it |
| Control socket unavailable | Check `/run/kixdns/admin.sock`, the `kixdns` group membership of both accounts and the KixDNS logs |
| Service control refused | Check `kixdns-panel-helper.service` and the permissions of `/run/kixdns-panel/control.sock` |
| Online update failed | The 系统 (System) page shows the reason. For the full output use `journalctl -u kixdns-panel-update.service -n 200 --no-pager` (the transient unit is collected when it ends, so `systemctl status` cannot find it). A failure does not touch KixDNS |
| Log read failed | Confirm that `kixdns-panel` is in the `systemd-journal` group, and restart the panel so the group membership takes effect |
| Geo data download failed | Confirm that it is a direct HTTPS link and does not redirect to a login page, a private network or a file over 128 MiB |

## Uninstall

```bash
sudo kixdns-panel-uninstall
```

The uninstaller asks two things: whether to keep KixDNS, and whether to keep the panel configuration, database, version store and Geo data. Deleting the configuration cannot be undone, so back up `pipeline.json` and `panel.db` first.

- On a host installed by migration, choosing to remove the enhanced build first restores the pre-migration unit and running state
- When you choose to remove KixDNS, the systemd-resolved local listener that the installer turned off and `/etc/resolv.conf` are restored with it
- On a host installed in the early 仅安装面板 (panel only) mode, the uninstaller always keeps the original KixDNS
- If the last uninstall kept KixDNS and deleted the configuration, running the uninstaller again still keeps KixDNS, even with `--remove-kixdns`
- When the kept program is gone and only the unit remains (the state left by a repeated uninstall on v3.1.1), a unit created by the panel is removed with the panel. Any other unit is kept as is, with a notice

Unattended:

```bash
# Uninstall the panel only, keep KixDNS and data
sudo kixdns-panel-uninstall --keep-kixdns --keep-config --yes

# Delete everything
sudo kixdns-panel-uninstall --remove-kixdns --remove-config --yes
```

When the local command is not available: `curl -fsSL https://raw.githubusercontent.com/tuoro/kixdns-panel/main/scripts/uninstall.sh | sudo bash`. The old command `sudo bash ./scripts/uninstall.sh --purge` is the same as deleting everything.
