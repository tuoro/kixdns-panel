# KixDNS Panel architecture

[简体中文](architecture.md) | **English**

## Components

KixDNS Panel is the management panel for KixDNS. The kernel comes from the fork [tuoro/kixdns](https://github.com/tuoro/kixdns). Its `main` is upstream plus fixes (the fixes are made to the standard of a PR to upstream and are meant to be submitted upstream in the same form), plus the panel interface. Releases use dated versions. The panel repository does not hold kernel source code.

1. **KixDNS kernel**: the upstream DNS data plane, plus a local control socket, metrics and configuration state
2. **Panel Server**: authentication, configuration versions and atomic save, service control, version inventory, logs, diagnostics
3. **Panel Web**: calls only the Panel Server API. It does not touch the control socket or host files directly

~~~text
Browser
  |
  v
Panel Web ---- Panel Server ---- SQLite
                    |
                    +---- config/pipeline.json
                    +---- versions/<source>-<package-id>-<commit>/
                    +---- geo/<kind>-<sha256>.<ext>
                    +---- systemd (via root helper)
                    +---- GitHub API / Release download
                    |
                    v
             /run/kixdns/admin.sock
                    |
                    v
              KixDNS Enhanced
                    |
                    v
             UDP / TCP / DoH
~~~

The panel depends only on the versioned [control protocol](control-protocol-v1.en.md). It does not import upstream crates, so adapting to upstream does not force the management side to change with it. The raw JSON is the source of truth for configuration. Forms change only known fields and keep unknown fields. Whether a field is supported is decided by the [configuration capability contract](config-capabilities.en.md), not guessed from the version number.

## Kernel source

Each time the fork's `main` advances, it publishes a dated version `YYYY.MM.DD`. Another release on the same day is `YYYY.MM.DD.N`. Each release carries kernel packages for two architectures, `kixdns-<版本>-linux-<架构>.zip`, and a manifest, `manifest.json`. The manifest states the repository, version, commit, the upstream commit it is based on, control protocol, configuration capabilities, and the size and SHA-256 of each package. A package contains `kixdns`, `KIXDNS_SOURCE.json` (the same identity plus the architecture), `KIXDNS_CAPABILITIES.json` and `SHA256SUMS`. Before release, the build runs in an Ubuntu 22.04 container, the GLIBC baseline is checked, and a DNS smoke test runs. The fork also runs a separate dependency audit once a day.

The panel compares versions part by part: year, month, day, and the number of the release that day. It prompts for an update only for a newer dated version.

### Former patchset kernels

The panel repository used to build kernels from patchsets (p28 and earlier). It no longer builds them, and the patchsets and their build process have been deleted. A new panel recognises this kind of kernel only when it is already installed on the host, and after it starts it replaces that kernel with the fork's latest version. Panels of v3.4.0 and earlier have no new kernel to install. An installed kernel keeps running as usual, and after the panel is upgraded, updates come from the fork instead.

## Build and release

The panel and the kernel use separate workflows, so a panel commit is not mistaken for a new KixDNS version:

- **Kernel**: built and released by the fork's release process (see above).
- **Panel**: `build-panel.yml` watches only Panel Server, Web, the deployment scripts and the panel dependencies. Each run first picks the fork's latest release once (the same version for both architectures). `scripts/fetch-kixdns-release.sh` downloads it and checks the manifest, asset digests, the in-package `SHA256SUMS`, the source description, configuration capabilities and the ELF architecture. It does not recompile KixDNS. This step also runs on PRs. Stable releases are published through the panel's GitHub Release.
- Release builds run in an Ubuntu 22.04 container and refuse binaries that depend on symbols above `GLIBC_2.35`. The full package also has to run install, in-place upgrade, panel integration, systemd control and uninstall acceptance on a temporary Ubuntu 22.04 machine.
- PRs run only the validation for the matching boundary and do not upload installable packages. Documentation-only changes do not trigger packaging.

Each kernel package carries `KIXDNS_CAPABILITIES.json`, which is written into `SHA256SUMS` together with the binary and the source description.

The full package separately records `PANEL_BUILD_COMMIT`, the kernel's `KIXDNS_BUILD_COMMIT` and `KIXDNS_SOURCE.json`, and the stable release tag `PANEL_RELEASE`. At install time it writes `KIXDNS_PANEL_INSTALLED_COMMIT`, `KIXDNS_INSTALLED_SOURCE=fork`, `KIXDNS_INSTALLED_COMMIT` and `KIXDNS_PANEL_INSTALLED_RELEASE`. The panel prompts for its own update only by stable release tag. When Panel Server starts, it validates offline the identity of the kernel bundled with the package and corrects the active version record in the database using the binary's actual digest. When GitHub is unreachable, local version information still displays as usual. A host where only the panel has been updated still holds the patchset identity of the old full package, and that identity is still recognised. The machine keeps only the current kernel and the previous one, keyed by `source + 包编号 + commit`, and cleans up the other versions at startup and after each successful switch. On a host still using an old-track kernel (a patchset Action build or an earlier Release), the new panel replaces it in the background with the fork's latest version after it starts. If the user goes back to the old kernel themselves after the replacement, it is not replaced again.

## Security boundaries

**Processes and permissions**

- Panel Server runs under a separate non-root account. The systemd unit enables read-only system directories, a private temporary directory and address family restrictions.
- Start/stop and self-update are forwarded through the root helper: a dedicated Unix socket (`0600`) plus `SO_PEERCRED` validation of the UID. It accepts only the unit determined at install time with `start`, `stop`, `restart`, and the fixed `panel-update`.
- It does not accept arbitrary commands or shell fragments. KixDNS has no reload action, and the panel does not provide one either.
- The control protocol runs only over a local Unix socket (`0660`) and does not listen on a network port.

**Sessions and data**

- Passwords use Argon2id. The database does not store plaintext session tokens. Cookies are HttpOnly and SameSite. All write operations require a CSRF token.
- Before login, pages show no machine state.
- Metrics carry no high-cardinality or sensitive labels such as domain names or client IPs.
- The query log records the domain name and the full client address of every query. It is kept only in `/var/lib/kixdns-panel/querylog/` (directory `0700`, files `0600`) and can be viewed only after login. Retention time and the space limit both have upper bounds.
- Configuration is replaced atomically through a temporary file in the same directory. After the write, a matching hot reload acknowledgement must be received, otherwise it is rolled back.
- The GitHub token is sent only to `api.github.com`. The online updater and the one-click installer reuse it through a temporary `0600` curl config, and it does not appear in process arguments.

**Download and install**

- The kernel is taken only from the latest stable release of the fixed repository, using the package for this machine's architecture. The download URL is built locally from the repository and version number. The frontend can only submit a package ID seen on the page, and it is refused if it does not match the current latest version. The frontend cannot supply a URL or path.
- The release tag, the manifest, and the asset size and digest recorded by GitHub agree item by item. The repository, version, commit, upstream commit, architecture and control protocol in the package's `KIXDNS_SOURCE.json` agree with the manifest, and so do the configuration capabilities.
- Before install, the outer and in-package SHA-256, the ELF and the architecture are validated. They are validated once more before activation. After replacement, the health check must pass, otherwise the previous state is restored.
- Configuration save, history restore and version activation share the backend capability registry. An incompatible version is refused before the service is stopped. The panel does not automatically delete or downgrade user fields.
- Panel self-update accepts only this project's latest stable Release and validates the asset digest and the in-package digest. The transaction does not change KixDNS's binary, configuration, identity or start/stop state.
- Geo data is accepted over HTTPS only. Each resolution and redirect pins a public address and checks it again. Size and file count are limited. Files are stored content-addressed with mode `0640`, and `kixdns` has read-only access through the shared group.
- The GeoSite bundled in the package is kept read-only in `/usr/share/kixdns-panel/geo`. On import, its SHA-256 and size are checked against `geosite.json`, then it is copied into content-addressed storage, with its source recorded as its download link. On a fresh install, a one-time marker left by the install script triggers the import on first start. If GeoSite already exists, the server refuses the import. An upgrade does not change the user's data or configuration.
- When a GeoSite category is picked on the 配置 (Configuration) page, the panel reads each category's domain count and attributes the way the kernel reads them (`.dat` is protobuf, the rest are read as V2Ray JSON; names are case-insensitive; for categories with the same name, the file loaded later wins), and caches the result per file. It reads only files it knows: the configuration being edited, the manifest and the copy in the package. It does not accept paths sent from the page.

**Coexisting with existing installs**

- When a KixDNS not installed by this panel is found, it is migrated only if the user explicitly agrees (answering `y` in the terminal, or `--replace-existing`). Otherwise the host is not changed. The panel manages only the enhanced build it installed itself.
- Migration keeps the original running state and backs up the original unit and start/stop state. If the enhanced build cannot start, everything is rolled back. Choosing to remove the enhanced build at uninstall is enough to restore it. The KixDNS on early 仅安装面板 (panel-only install) hosts is never deleted by the uninstaller.
- The installer turns off the local listener of systemd-resolved only when the user agrees, and records the original `resolv.conf` for rollback and for restoring on uninstall. Other programs occupying port 53 are only reported and not touched.

## Runtime platforms

The production target is Linux x86_64/ARM64 with systemd. Panel Server stays cross-platform at compile time. Windows services and named pipes may serve as adapter implementations of the same interface.
