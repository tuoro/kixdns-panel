use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::error::{AppError, AppResult};
use crate::geo_data::{
    BuiltinGeosite, GeoDataCleanupResult, GeoDataError, GeoDataManifest, GeoDataSchedule,
    GeoDataSyncRequest, apply_manifest_paths, is_blocklist_path,
};
use crate::geosite_catalog::{CatalogCache, GeositeCategory};
use crate::ip_region::{GeoIpFiles, IpRegion, MAX_ADDRESSES, regions};

use super::{
    AppState, SystemConfigWrite, map_config_error, map_geo_data_error, write_system_config,
};

#[derive(Debug, Deserialize)]
pub(super) struct GeoDataScheduleRequest {
    interval_hours: Option<u64>,
}

pub(super) async fn get_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GeoDataManifest>> {
    authenticate(&state.database, &jar).await?;
    state
        .geo_data
        .current()
        .await
        .map(Json)
        .map_err(map_geo_data_error)
}

pub(super) async fn sync_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<GeoDataSyncRequest>,
) -> AppResult<Json<GeoDataManifest>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .geo_data
        .sync(request)
        .await
        .map_err(map_geo_data_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.sync".to_owned(),
            // 不折行空格：一项里的名字、数字和「个」不拆开，只在「、」后面换行
            // No-break spaces: a name, its number and 个 stay together, so the line breaks only after 、
            format!(
                "GeoIP\u{a0}MMDB\u{a0}{}\u{a0}个、GeoIP\u{a0}DAT\u{a0}{}\u{a0}个、GeoSite\u{a0}{}\u{a0}个",
                usize::from(result.geoip_mmdb.is_some()),
                usize::from(result.geoip_dat.is_some()),
                result.geosite.len()
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

/// 安装包自带的 GeoSite；开发构建没有，返回 null。
/// The `GeoSite` the package brings along; a development build has none and returns null.
pub(super) async fn get_builtin_geosite(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Option<BuiltinGeosite>>> {
    authenticate(&state.database, &jar).await?;
    state
        .geo_data
        .builtin_geosite()
        .map(Json)
        .map_err(map_geo_data_error)
}

/// 一个 `GeoSite` 文件读得怎么样：读到了给出内容摘要（分类在 `catalogs` 里按摘要找），读不到给出原因。
/// How one `GeoSite` file read: its content digest when it read (its categories sit in `catalogs` under
/// it), or why it did not.
#[derive(Debug, Serialize)]
pub(super) struct GeositeFile {
    path: String,
    sha256: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct GeositeCategories {
    /// 要编辑的配置和清单里出现的文件，按配置里的顺序 / The files the config being edited and the manifest name, in config order
    files: Vec<GeositeFile>,
    /// 安装包自带的那份：还没有 `GeoSite` 时配置页先用它列出分类 / The built-in file: with no `GeoSite` yet, the config page lists its categories
    builtin: Option<GeositeFile>,
    /// 按内容摘要放的分类，内置那份和导入后的副本只放一次 / Categories by content digest, so the built-in file and its imported copy appear once
    catalogs: BTreeMap<String, Arc<Vec<GeositeCategory>>>,
}

/// 配置页挑 `GeoSite` 分类用：读出要编辑的配置（待应用的优先）、清单和安装包里的 `GeoSite` 文件各有哪些分类。
/// 只读面板自己知道的路径，不接受页面传来的路径；草稿里新写、还没保存的本地路径，页面会说保存后才能读。
/// For picking `GeoSite` categories on the config page: which categories the `GeoSite` files of the config
/// being edited (pending first), the manifest and the package hold. Only paths the panel already knows are
/// read, never paths sent by the page; a local path typed into the draft and not yet saved is reported by
/// the page as readable after saving.
#[derive(Debug, Deserialize)]
pub(super) struct IpRegionsQuery {
    /// 用逗号隔开的地址 / Addresses separated by commas
    ips: String,
}

#[derive(Debug, Serialize)]
pub(super) struct IpRegionsResponse {
    /// 和请求里的地址一一对应；查不到的是 null / One per address asked, in order; null for one the data does not place
    regions: Vec<Option<IpRegion>>,
}

/// 查询详情和诊断给地址标地区：按正在用的配置里的 `GeoIP` 数据现查，查完就放（见 `ip_region`）。只读配置里写的路径，
/// 不接受页面传来的路径；相对路径不读，面板不知道 `KixDNS` 从哪个目录找它
/// Regions for the addresses of a query detail or a diagnosis: looked up in the `GeoIP` data of the live config and
/// dropped after (see `ip_region`). Only the paths in the config are read, never paths sent by the page; a relative
/// path is not read, since the panel cannot know which directory `KixDNS` resolves it from
pub(super) async fn get_ip_regions(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IpRegionsQuery>,
) -> AppResult<Json<IpRegionsResponse>> {
    authenticate(&state.database, &jar).await?;
    let ips = query
        .ips
        .split(',')
        .map(|ip| ip.trim().parse::<std::net::IpAddr>())
        .collect::<Result<Vec<_>, _>>()
        .ok()
        .filter(|ips| !ips.is_empty() && ips.len() <= MAX_ADDRESSES)
        .ok_or_else(|| {
            AppError::BadRequest(
                "ip_regions_invalid",
                format!("要查的地址写得不对，一次最多 {MAX_ADDRESSES} 个，用逗号隔开"),
            )
        })?;
    let config = state.config.current().await.map_err(map_config_error)?;
    let path = |key: &str| {
        config
            .content
            .pointer(&format!("/settings/{key}"))
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let (mmdb, dat) = (path("geoip_db_path"), path("geoip_dat_path"));
    // 读盘在阻塞线程里做：DAT 要从头读一遍，十几 MB 的文件几十毫秒 / Disk work runs on a blocking thread: a DAT is read
    // through, tens of milliseconds for a file of a dozen MB
    let regions = tokio::task::spawn_blocking(move || {
        regions(
            &ips,
            &GeoIpFiles {
                mmdb: mmdb.as_deref(),
                dat: dat.as_deref(),
            },
        )
    })
    .await
    .map_err(|error| AppError::Internal(anyhow::Error::new(error)))?;
    Ok(Json(IpRegionsResponse { regions }))
}

pub(super) async fn get_geosite_categories(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GeositeCategories>> {
    authenticate(&state.database, &jar).await?;
    let desired = state.config.desired().await.map_err(map_config_error)?;
    let mut paths: Vec<String> = desired
        .content
        .pointer("/settings/geosite_data_paths")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|path| path.as_str().map(str::to_owned))
        .collect();
    let manifest = state.geo_data.current().await.map_err(map_geo_data_error)?;
    paths.extend(manifest.geosite.into_iter().map(|resource| resource.path));
    // 拦截列表合并的文件不列：它的标签归拦截列表页管，不在 GeoSite 分类里挑
    // The blocklists' merged file is left out: its tags belong to the blocklist page, not to the
    // `GeoSite` categories one picks from
    let mut seen = HashSet::new();
    paths.retain(|path| !is_blocklist_path(path) && seen.insert(path.clone()));
    let builtin = state
        .geo_data
        .builtin_geosite_data()
        .map_err(map_geo_data_error)?;
    let cache = Arc::clone(&state.geosite_catalog);
    // 读盘和解析在阻塞线程里做：一个 11 MB 的文件要几十毫秒 / Disk and parsing run on a blocking thread: an 11 MB file takes tens of milliseconds
    let categories =
        tokio::task::spawn_blocking(move || read_geosite_files(&cache, &paths, builtin))
            .await
            .map_err(|error| AppError::Internal(anyhow::Error::new(error)))?;
    Ok(Json(categories))
}

pub(super) fn read_geosite_files(
    cache: &CatalogCache,
    paths: &[String],
    builtin: Option<PathBuf>,
) -> GeositeCategories {
    let mut catalogs = BTreeMap::new();
    let mut read = |path: String| {
        // 内核按自己的工作目录找相对路径，面板不知道那是哪里 / The kernel resolves a relative path from its own working directory, which the panel cannot know
        if !Path::new(&path).is_absolute() {
            return GeositeFile {
                path,
                sha256: None,
                error: Some("写的是相对路径，面板不知道 KixDNS 从哪个目录找它".to_owned()),
            };
        }
        match cache.read(Path::new(&path)) {
            Ok(catalog) => {
                catalogs
                    .entry(catalog.sha256.clone())
                    .or_insert(catalog.categories);
                GeositeFile {
                    path,
                    sha256: Some(catalog.sha256),
                    error: None,
                }
            }
            Err(error) => GeositeFile {
                path,
                sha256: None,
                error: Some(error.to_string()),
            },
        }
    };
    let files: Vec<GeositeFile> = paths.iter().cloned().map(&mut read).collect();
    let builtin = builtin.map(|path| read(path.to_string_lossy().into_owned()));
    cache.retain(
        &files
            .iter()
            .chain(&builtin)
            .map(|file| PathBuf::from(&file.path))
            .collect(),
    );
    GeositeCategories {
        files,
        builtin,
        catalogs,
    }
}

/// 用户在 Geo 设置里点「导入内置 GeoSite」：和「下载并填入配置」一样只准备文件、返回清单，路径由
/// 页面填进草稿，保存后才生效。
/// The user pressed 导入内置 `GeoSite` in the Geo settings: like 下载并填入配置 it only prepares the file
/// and returns the manifest; the page puts the path into the draft, which takes effect on save.
pub(super) async fn import_builtin_geosite(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<GeoDataManifest>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let builtin = state
        .geo_data
        .builtin_geosite()
        .map_err(map_geo_data_error)?;
    let manifest = state
        .geo_data
        .import_builtin_geosite()
        .await
        .map_err(map_geo_data_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.import_builtin".to_owned(),
            builtin.map_or_else(String::new, |builtin| builtin_label(&builtin)),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(manifest))
}

/// 审计里对内置 `GeoSite` 的称呼：文件名加发布标签 / How the audit names the built-in `GeoSite`: the file and its release tag
fn builtin_label(builtin: &BuiltinGeosite) -> String {
    format!("geosite.dat\u{a0}{}", builtin.release)
}

/// 全新安装的首次启动：配置里还没有任何 `GeoSite` 时导入内置的那份，并写进配置（`KixDNS` 还没启动时
/// 存成待应用的版本）。只更新过面板的主机没有这个标记，由用户自己决定要不要导入。
/// The first start of a fresh install: with no `GeoSite` in the config yet, import the built-in one
/// and write it into the config (as a pending version while `KixDNS` has not started). Hosts that only
/// updated the panel have no marker; their users decide whether to import.
pub(super) fn spawn_builtin_geosite_seed(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = seed_builtin_geosite(&state).await {
            tracing::warn!(error = ?error, "导入内置 GeoSite 没有完成，下次启动再试");
        }
    });
}

pub(super) async fn seed_builtin_geosite(state: &AppState) -> anyhow::Result<()> {
    if !state.geo_data.builtin_seed_requested() {
        return Ok(());
    }
    let Some(builtin) = state.geo_data.builtin_geosite()? else {
        state.geo_data.clear_builtin_seed()?;
        return Ok(());
    };
    let desired = state.config.desired().await?;
    let configured = desired
        .content
        .pointer("/settings/geosite_data_paths")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|paths| !paths.is_empty());
    let manifest = state.geo_data.current().await?;
    // 上一次导入了文件、还没写进配置就中断时，清单里已经是这份内置的，接着写配置就行
    // When a previous attempt imported the file but stopped before writing the config, the
    // manifest already holds this built-in copy and only the config write is left
    let imported_before = manifest.geosite.len() == 1
        && manifest.geosite[0].sha256 == builtin.sha256
        && manifest.geosite[0].url == builtin.url;
    if !configured && (manifest.geosite.is_empty() || imported_before) {
        let manifest = if imported_before {
            manifest
        } else {
            state.geo_data.import_builtin_geosite().await?
        };
        let _apply_guard = state.config_apply_lock.lock().await;
        write_system_config(
            state,
            &SystemConfigWrite {
                subject: "新的 Geo 数据",
                message: "导入内置 GeoSite",
                audit_action: "config.geo_data.import_builtin",
                audit_note: Some(builtin_label(&builtin)),
            },
            |candidate| Ok(apply_manifest_paths(candidate, &manifest)?),
        )
        .await?;
    }
    state.geo_data.clear_builtin_seed()?;
    Ok(())
}

pub(super) async fn cleanup_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<GeoDataCleanupResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = remove_unreferenced_geo_data(&state).await?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.cleanup".to_owned(),
            format!(
                "删除 {} 个文件，释放 {}",
                result.removed_files,
                human_bytes(result.reclaimed_bytes)
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

pub(super) async fn get_geo_data_schedule(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GeoDataSchedule>> {
    authenticate(&state.database, &jar).await?;
    state
        .geo_data
        .schedule()
        .get()
        .await
        .map(Json)
        .map_err(map_geo_data_error)
}

pub(super) async fn save_geo_data_schedule(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<GeoDataScheduleRequest>,
) -> AppResult<Json<GeoDataSchedule>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    if request.interval_hours.is_some() {
        let manifest = state.geo_data.current().await.map_err(map_geo_data_error)?;
        if GeoDataSyncRequest::from_manifest(&manifest).is_empty() {
            return Err(AppError::BadRequest(
                "geo_data_schedule_empty",
                "先填一个远程链接并点「下载并填入配置」，才能自动更新".to_owned(),
            ));
        }
    }
    let schedule = state
        .geo_data
        .schedule()
        .set_interval(request.interval_hours)
        .await
        .map_err(map_geo_data_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.schedule".to_owned(),
            schedule
                .interval_hours
                .map_or_else(|| "关闭".to_owned(), schedule_label),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(schedule))
}

/// 定时更新的间隔，和页面上的选项同一种说法 / The schedule interval in the words the page's options use
pub(super) fn schedule_label(hours: u64) -> String {
    match hours {
        24 => "每天".to_owned(),
        168 => "每周".to_owned(),
        other => format!("每 {other} 小时"),
    }
}

/// 自动更新记下的原因：下载出错只记原因本身。页面前面已经写着「上次自动更新失败」，到点也会自己再跑，不再说「没下载成功」「稍后再试」
/// The reason the automatic update records: a failed download keeps only its cause. The page already prefixes 上次自动更新失败, and the update
/// runs again on its own when due, so 没下载成功 and 稍后再试 are not repeated
fn schedule_error(error: &anyhow::Error) -> String {
    match error.downcast_ref::<GeoDataError>() {
        Some(GeoDataError::Download { cause, .. }) => cause.clone(),
        _ => format!("{error:#}"),
    }
}

pub(super) async fn run_due_geo_schedule(state: &AppState) -> anyhow::Result<()> {
    let now = unix_timestamp();
    let schedule = state.geo_data.schedule().get().await?;
    if !schedule.is_due(now) {
        return Ok(());
    }
    state.geo_data.schedule().mark_attempt(now).await?;
    let result = apply_scheduled_geo_update(state).await;
    let error = result.as_ref().err().map(schedule_error);
    state
        .geo_data
        .schedule()
        .mark_result(unix_timestamp(), error)
        .await?;
    result
}

async fn apply_scheduled_geo_update(state: &AppState) -> anyhow::Result<()> {
    let manifest = state.geo_data.current().await?;
    let request = GeoDataSyncRequest::from_manifest(&manifest);
    if request.is_empty() {
        anyhow::bail!("没有填下载链接，自动更新用不上");
    }
    let updated = state.geo_data.sync(request).await?;
    apply_synced_geo_data(state, &updated).await
}

/// 删除当前清单、拦截列表和所有保留配置版本都不引用的 Geo 目录文件；回滚到任一保留版本时，它引用的文件都还在。
/// Delete files in the Geo directory that neither the current manifest, the blocklists nor any
/// retained config version references; rolling back to any retained version still finds every file
/// it points at.
async fn remove_unreferenced_geo_data(state: &AppState) -> AppResult<GeoDataCleanupResult> {
    let retained = state
        .config
        .retained_contents()
        .await
        .map_err(map_config_error)?;
    state
        .blocklists
        .cleanup(&retained)
        .await
        .map_err(map_geo_data_error)
}

/// 定时更新以后清掉不再被引用的旧文件。每次更新都会下载新的内容寻址文件，不在这里清理，旧文件只会越积越多；
/// 清理失败不影响已生效的更新，只记日志，下次运行会再试。`retained` 是在写配置的那把锁里读的保留版本，含刚保存的
/// 那版；清理本身在锁外做，拦截列表正在下载时不拖住别人保存配置。
/// Removes old files nothing references after a scheduled update. Every run downloads new
/// content-addressed files, and without cleaning here the old ones only pile up; a failed cleanup
/// does not undo an applied update, so it is logged and retried next run. `retained` holds the
/// retained versions read under the lock of the config write, the version just saved among them;
/// the cleanup itself runs outside it, so a blocklist download in progress does not hold up saves.
pub(super) async fn clean_up_after_update(
    state: &AppState,
    retained: &[serde_json::Value],
    what: &str,
) {
    match state.blocklists.cleanup(retained).await {
        Ok(result) => tracing::info!(
            removed_files = result.removed_files,
            reclaimed_bytes = result.reclaimed_bytes,
            "{what}定时更新后清理未引用的旧文件"
        ),
        Err(error) => tracing::warn!(error = ?error, "{what}定时更新后清理旧文件失败"),
    }
}

/// 把刚同步好的 Geo 清单写进配置，再清掉不再被引用的旧文件。
/// Write a freshly synced Geo manifest into the config, then remove old files nothing references.
pub(super) async fn apply_synced_geo_data(
    state: &AppState,
    updated: &GeoDataManifest,
) -> anyhow::Result<()> {
    // 保留的版本和写配置在同一把锁里读，免得漏掉刚保存的版本
    // The retained versions are read under the same lock as the config write, so they cannot miss
    // the version just saved
    let retained = {
        let _apply_guard = state.config_apply_lock.lock().await;
        write_system_config(
            state,
            &SystemConfigWrite {
                subject: "新的 Geo 数据",
                message: "定时更新 Geo 数据",
                audit_action: "config.geo_data.schedule.apply",
                audit_note: None,
            },
            |candidate| Ok(apply_manifest_paths(candidate, updated)?),
        )
        .await?;
        state.config.retained_contents().await?
    };
    clean_up_after_update(state, &retained, "Geo 数据").await;
    Ok(())
}

/// 审计详情里的大小写成 KB / MB，不写一长串字节数 / Sizes in audit details read as KB or MB rather than a long byte count
fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["字节", "KB", "MB", "GB"];
    let mut value = bytes;
    let mut unit = 0;
    let mut tenths = 0;
    while value >= 1024 && unit < UNITS.len() - 1 {
        tenths = (value % 1024) * 10 / 1024;
        value /= 1024;
        unit += 1;
    }
    if unit == 0 {
        format!("{value} {}", UNITS[0])
    } else {
        format!("{value}.{tenths} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::{human_bytes, schedule_label};

    #[test]
    fn schedule_reads_like_the_page() {
        assert_eq!(schedule_label(24), "每天");
        assert_eq!(schedule_label(168), "每周");
        assert_eq!(schedule_label(12), "每 12 小时");
    }

    #[test]
    fn sizes_read_in_the_nearest_unit() {
        assert_eq!(human_bytes(512), "512 字节");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
