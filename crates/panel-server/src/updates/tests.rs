use std::io::{Cursor, Write};
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::BoxFuture;
use tempfile::tempdir;

use super::ServiceHost;
use super::install::verify_kernel_source;
use super::validation::{kernel_architecture, kernel_asset_name};
use super::{
    BuildIdentity, GithubRelease, InstalledVersion, MANIFEST_SCHEMA_VERSION, ReleaseAsset,
    ReleaseManifest, RemoteVersion, UpdateError, UpdateManager, UpdateSettings, VersionKey,
    VersionManifest, VersionSource, extract_artifact, load_bundled_manifest, load_verified_version,
    panel_release_asset_name, parse_kernel_version, prune_versions, remote_version, sha256,
    store_version, to_kixdns_update_notice, to_panel_update_notice, update_stored_capabilities,
    validate_commit, validate_digest, validate_github_token, validate_slug, write_github_token,
};
use crate::db::Database;
use crate::operations::ServiceAction;

const TEST_BUILD_COMMIT: &str = "4e8002d08a56afc08be335d0d5ed337c7690f9af";
pub(crate) const TEST_REPOSITORY: &str = "tuoro/kixdns";
pub(crate) const TEST_UPSTREAM_COMMIT: &str = "42981abe52ce53271be50b430594e02601e8b615";
pub(crate) const TEST_VERSION: &str = "2026.10.13.2";
pub(crate) const TEST_CAPABILITIES: &str =
    r#"{"schema_version":1,"config_capabilities":["config_query_stats_v1"]}"#;

/// 各测试共用的设置：fork 仓库、没有完整包身份，路径都在给定目录下。
/// Settings the tests share: the fork repository, no full-package identity, and every path
/// under the given directory.
pub(crate) fn test_settings(directory: &std::path::Path) -> UpdateSettings {
    UpdateSettings {
        kernel_repository: TEST_REPOSITORY.to_owned(),
        installed_source: None,
        installed_commit: None,
        installed_source_id: None,
        panel_installed_commit: None,
        panel_installed_release: None,
        binary_path: directory.join("bin/kixdns"),
        versions_path: directory.join("versions"),
        bundled_metadata: directory.join("bundle"),
        github_token_path: directory.join("github-token"),
    }
}

/// fork 发布包里的 `KIXDNS_SOURCE.json`。 / `KIXDNS_SOURCE.json` in a fork release package.
pub(crate) fn kernel_source_json(version: &str, commit: &str) -> String {
    serde_json::json!({
        "schema_version": 1,
        "repository": TEST_REPOSITORY,
        "version": version,
        "commit": commit,
        "upstream_commit": TEST_UPSTREAM_COMMIT,
        "arch": kernel_architecture(),
        "control_protocol": 1,
    })
    .to_string()
}

/// 按 fork 发布流程的样子打一个内核包：三份文件加 `SHA256SUMS`。
/// Packs a kernel the way the fork's release workflow does: three files plus `SHA256SUMS`.
pub(crate) fn kernel_package(binary: &[u8], source: &str, capabilities: &str) -> Vec<u8> {
    let checksums = format!(
        "{}  kixdns\n{}  KIXDNS_CAPABILITIES.json\n{}  KIXDNS_SOURCE.json\n",
        sha256(binary),
        sha256(capabilities.as_bytes()),
        sha256(source.as_bytes())
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, content) in [
        ("kixdns", binary),
        ("KIXDNS_CAPABILITIES.json", capabilities.as_bytes()),
        ("KIXDNS_SOURCE.json", source.as_bytes()),
        ("SHA256SUMS", checksums.as_bytes()),
    ] {
        writer.start_file(name, options).unwrap();
        writer.write_all(content).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// 已经对过发布清单的 fork 版本；下载地址默认指向 GitHub，安装测试会换成本地服务。
/// A fork version already checked against its manifest; the download address points at
/// GitHub, and install tests swap in a local server.
pub(crate) fn fork_remote(source_id: u64, tag: &str) -> RemoteVersion {
    let artifact = kernel_asset_name(tag);
    RemoteVersion {
        source: VersionSource::Fork,
        source_id,
        commit: TEST_BUILD_COMMIT.to_owned(),
        release_tag: tag.to_owned(),
        upstream_commit: Some(TEST_UPSTREAM_COMMIT.to_owned()),
        created_at: Some("2026-10-13T08:00:00Z".to_owned()),
        source_url: Some(format!(
            "https://github.com/olicesx/kixdns/commit/{TEST_UPSTREAM_COMMIT}"
        )),
        build_url: format!("https://github.com/{TEST_REPOSITORY}/releases/tag/{tag}"),
        download_url: format!(
            "https://github.com/{TEST_REPOSITORY}/releases/download/{tag}/{artifact}"
        ),
        artifact,
        artifact_digest: format!("sha256:{}", "a".repeat(64)),
        control_protocol: 1,
        config_capabilities: vec!["config_query_stats_v1".to_owned()],
    }
}

fn fork_manifest(remote: &RemoteVersion, binary: &[u8]) -> VersionManifest {
    VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Fork),
        source_id: Some(remote.source_id),
        commit: remote.commit.clone(),
        run_id: None,
        release_tag: Some(remote.release_tag.clone()),
        created_at: remote.created_at.clone(),
        source_url: remote.source_url.clone(),
        build_url: Some(remote.build_url.clone()),
        artifact: remote.artifact.clone(),
        artifact_digest: Some(remote.artifact_digest.clone()),
        upstream_repository: Some("olicesx/kixdns".to_owned()),
        upstream_commit: remote.upstream_commit.clone(),
        patchset: None,
        dependency_revision: None,
        control_protocol: Some(1),
        config_capabilities: remote.config_capabilities.clone(),
        binary_sha256: sha256(binary),
        installed_at: 42,
    }
}

/// 存一个可以直接切换过去的 fork 版本，返回它的远端身份和二进制；二进制按包编号区分，
/// 也和同编号的 Action 构建不同。
/// Stores a fork version ready to switch to and returns its remote identity and binary;
/// binaries differ by package id, and from an Action build with the same id.
fn store_fork_build(
    versions_path: &std::path::Path,
    source_id: u64,
    tag: &str,
) -> (RemoteVersion, Vec<u8>) {
    let mut binary = test_elf();
    binary[30] = 1;
    binary[31] = u8::try_from(source_id).unwrap();
    let remote = fork_remote(source_id, tag);
    store_version(versions_path, &fork_manifest(&remote, &binary), &binary).unwrap();
    (remote, binary)
}

const TEST_IDENTITY: &str = r#"{
        "repository":"olicesx/kixdns",
        "source":"action",
        "commit":"374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
        "official_run_id":30235703570,
        "patchset":5,
        "control_protocol":1
    }"#;

fn test_elf() -> Vec<u8> {
    let mut binary = vec![0_u8; 32];
    binary[..4].copy_from_slice(b"\x7fELF");
    binary[5] = 1;
    let machine = match std::env::consts::ARCH {
        "aarch64" => 183_u16,
        _ => 62_u16,
    };
    binary[18..20].copy_from_slice(&machine.to_le_bytes());
    binary
}

#[test]
fn validates_supported_github_tokens_and_rejects_unsafe_content() {
    for token in ["github_pat_example", "ghp_example", "gho_example"] {
        validate_github_token(token).unwrap();
    }
    for token in [
        "",
        "token",
        "ghp_has space",
        "ghp_line\nbreak",
        "ghp_quote\"",
    ] {
        assert!(validate_github_token(token).is_err());
    }
}

#[test]
fn stores_github_token_as_a_private_regular_file() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("github-token");
    write_github_token(&path, "github_pat_example").unwrap();
    let metadata = std::fs::symlink_metadata(&path).unwrap();
    assert!(metadata.file_type().is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), "github_pat_example");
}

fn test_manifest(source_id: u64, commit: &str, binary: &[u8]) -> VersionManifest {
    VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Action),
        source_id: Some(source_id),
        commit: commit.to_owned(),
        run_id: Some(source_id),
        release_tag: None,
        created_at: Some("2026-07-28T00:00:00Z".to_owned()),
        source_url: Some(format!(
            "https://github.com/olicesx/kixdns/actions/runs/{source_id}"
        )),
        build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
        artifact: format!("kixdns-enhanced-action-{source_id}-linux-x86_64"),
        artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
        upstream_repository: Some("olicesx/kixdns".to_owned()),
        upstream_commit: Some("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned()),
        patchset: Some(5),
        dependency_revision: None,
        control_protocol: Some(1),
        config_capabilities: Vec::new(),
        binary_sha256: sha256(binary),
        installed_at: 42,
    }
}

fn write_bundle_metadata(directory: &std::path::Path, binary: &[u8]) {
    std::fs::create_dir_all(directory).unwrap();
    for (name, value) in [
        ("KIXDNS_BUILD_COMMIT", TEST_BUILD_COMMIT.to_owned()),
        ("KIXDNS_SOURCE_RUN_ID", "99".to_owned()),
        ("KIXDNS_ARTIFACT_ID", "42".to_owned()),
        (
            "KIXDNS_ARTIFACT_NAME",
            "kixdns-enhanced-action-30235703570-p5-44e7e6b02316-linux-x86_64".to_owned(),
        ),
        (
            "KIXDNS_ARTIFACT_DIGEST",
            format!("sha256:{}", "a".repeat(64)),
        ),
        ("KIXDNS_BINARY_SHA256", sha256(binary)),
        ("upstream.lock.json", TEST_IDENTITY.to_owned()),
        (
            "KIXDNS_CAPABILITIES.json",
            r#"{"schema_version":1,"config_capabilities":[]}"#.to_owned(),
        ),
    ] {
        std::fs::write(directory.join(name), format!("{value}\n")).unwrap();
    }
}

#[test]
fn imports_verified_bundled_build_identity() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    write_bundle_metadata(directory.path(), &binary);
    let key = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();

    let manifest = load_bundled_manifest(directory.path(), TEST_REPOSITORY, &key, &binary).unwrap();

    assert_eq!(manifest.source_id, Some(42));
    assert_eq!(manifest.run_id, Some(30_235_703_570));
    assert_eq!(manifest.commit, TEST_BUILD_COMMIT);
    assert_eq!(
        manifest.upstream_repository.as_deref(),
        Some("olicesx/kixdns")
    );
    assert_eq!(
        manifest.upstream_commit.as_deref(),
        Some("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25")
    );
    assert_eq!(manifest.patchset, Some(5));
    assert_eq!(manifest.control_protocol, Some(1));
    assert_eq!(
        manifest.build_url.as_deref(),
        Some("https://github.com/tuoro/kixdns-panel/actions/runs/99")
    );
}

#[test]
fn bundled_build_records_its_dependency_revision() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    write_bundle_metadata(directory.path(), &binary);
    let key = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();
    assert_eq!(
        load_bundled_manifest(directory.path(), TEST_REPOSITORY, &key, &binary)
            .unwrap()
            .dependency_revision,
        None
    );

    let mut identity: serde_json::Value = serde_json::from_str(TEST_IDENTITY).unwrap();
    identity["dependency_revision"] = 1.into();
    std::fs::write(
        directory.path().join("upstream.lock.json"),
        format!("{identity}\n"),
    )
    .unwrap();
    let manifest = load_bundled_manifest(directory.path(), TEST_REPOSITORY, &key, &binary).unwrap();
    assert_eq!(manifest.dependency_revision, Some(1));
    assert_eq!(manifest.into_installed(true).dependency_revision, Some(1));
}

#[test]
fn rejects_bundled_identity_for_a_different_binary() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    write_bundle_metadata(directory.path(), &binary);
    let mut changed = binary;
    changed.push(1);
    let key = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();

    assert!(load_bundled_manifest(directory.path(), TEST_REPOSITORY, &key, &changed).is_err());
}

#[tokio::test]
async fn reads_capabilities_from_unmaterialized_bundled_version() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let binary_path = directory.path().join("bin/kixdns");
    let versions_path = directory.path().join("versions");
    let bundled_metadata = directory.path().join("bundle");
    let binary = test_elf();
    write_bundle_metadata(&bundled_metadata, &binary);
    std::fs::write(
        bundled_metadata.join("KIXDNS_CAPABILITIES.json"),
        r#"{"schema_version":1,"config_capabilities":["config_query_stats_v1"]}"#,
    )
    .unwrap();
    let manager = UpdateManager::new(
        database,
        UpdateSettings {
            installed_commit: Some(TEST_BUILD_COMMIT.to_owned()),
            installed_source_id: Some(42),
            binary_path: binary_path.clone(),
            versions_path,
            bundled_metadata,
            ..test_settings(directory.path())
        },
    )
    .unwrap();
    std::fs::write(binary_path, binary).unwrap();

    assert_eq!(
        manager.active_capabilities().await.unwrap(),
        vec!["config_query_stats_v1".to_owned()]
    );
}

#[tokio::test]
async fn bundled_binary_identity_replaces_stale_database_state() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let binary_path = directory.path().join("bin/kixdns");
    let versions_path = directory.path().join("versions");
    let bundled_metadata = directory.path().join("bundle");
    let binary = test_elf();
    write_bundle_metadata(&bundled_metadata, &binary);
    let manager = UpdateManager::new(
        database.clone(),
        UpdateSettings {
            installed_commit: Some(TEST_BUILD_COMMIT.to_owned()),
            installed_source_id: Some(42),
            binary_path: binary_path.clone(),
            versions_path: versions_path.clone(),
            bundled_metadata,
            ..test_settings(directory.path())
        },
    )
    .unwrap();
    std::fs::write(&binary_path, &binary).unwrap();
    let stale_binary = {
        let mut value = test_elf();
        value.push(1);
        value
    };
    let stale_commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let stale_key = VersionKey::tracked(VersionSource::Action, 7, stale_commit).unwrap();
    store_version(
        &versions_path,
        &test_manifest(7, stale_commit, &stale_binary),
        &stale_binary,
    )
    .unwrap();
    database
        .set_setting(super::ACTIVE_VERSION_KEY, stale_key.encoded(), 42)
        .await
        .unwrap();

    manager.initialize_installed_version().await.unwrap();

    let expected = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();
    assert_eq!(
        manager.active_version().await.unwrap(),
        Some(expected.clone())
    );
    let (manifest, stored) = load_verified_version(&versions_path, &expected).unwrap();
    assert_eq!(stored, binary);
    assert_eq!(manifest.source_id, Some(42));
    assert_eq!(
        database
            .get_setting(super::ACTIVE_VERSION_KEY)
            .await
            .unwrap()
            .as_deref(),
        Some(expected.encoded().as_str())
    );
}

/// 新完整包带的 fork 发布版身份：和 `build-panel.yml` 写进包里的文件一一对应。
/// The fork release identity a new full package carries: one file per item `build-panel.yml`
/// writes into the package.
fn write_fork_bundle_metadata(directory: &std::path::Path, binary: &[u8], version: &str) {
    std::fs::create_dir_all(directory).unwrap();
    for (name, value) in [
        ("KIXDNS_BUILD_COMMIT", TEST_BUILD_COMMIT.to_owned()),
        ("KIXDNS_ARTIFACT_ID", "77".to_owned()),
        ("KIXDNS_ARTIFACT_NAME", kernel_asset_name(version)),
        (
            "KIXDNS_ARTIFACT_DIGEST",
            format!("sha256:{}", "a".repeat(64)),
        ),
        ("KIXDNS_BINARY_SHA256", sha256(binary)),
        ("KIXDNS_CAPABILITIES.json", TEST_CAPABILITIES.to_owned()),
        (
            "KIXDNS_SOURCE.json",
            kernel_source_json(version, TEST_BUILD_COMMIT),
        ),
    ] {
        std::fs::write(directory.join(name), format!("{value}\n")).unwrap();
    }
}

#[test]
fn imports_a_verified_fork_release_bundle() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    write_fork_bundle_metadata(directory.path(), &binary, TEST_VERSION);
    let key = VersionKey::tracked(VersionSource::Fork, 77, TEST_BUILD_COMMIT).unwrap();

    let manifest = load_bundled_manifest(directory.path(), TEST_REPOSITORY, &key, &binary).unwrap();

    assert_eq!(manifest.source, Some(VersionSource::Fork));
    assert_eq!(manifest.source_id, Some(77));
    assert_eq!(manifest.run_id, None);
    assert_eq!(manifest.release_tag.as_deref(), Some(TEST_VERSION));
    assert_eq!(manifest.patchset, None);
    assert_eq!(
        manifest.upstream_commit.as_deref(),
        Some(TEST_UPSTREAM_COMMIT)
    );
    assert_eq!(
        manifest.build_url.as_deref(),
        Some("https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2")
    );
    assert_eq!(
        manifest.source_url.as_deref(),
        Some("https://github.com/olicesx/kixdns/commit/42981abe52ce53271be50b430594e02601e8b615")
    );
    assert_eq!(manifest.config_capabilities, vec!["config_query_stats_v1"]);
    // 读出来的身份要能原样存进本机库存。 / The identity read back must be storable as is.
    let stored = tempdir().unwrap();
    store_version(stored.path(), &manifest, &binary).unwrap();
    assert_eq!(
        load_verified_version(stored.path(), &key)
            .unwrap()
            .0
            .into_installed(true)
            .label(),
        TEST_VERSION
    );
}

#[test]
fn rejects_a_fork_bundle_that_does_not_match_its_release() {
    let binary = test_elf();
    let key = VersionKey::tracked(VersionSource::Fork, 77, TEST_BUILD_COMMIT).unwrap();
    let refused = |change: &dyn Fn(&std::path::Path), repository: &str| {
        let directory = tempdir().unwrap();
        write_fork_bundle_metadata(directory.path(), &binary, TEST_VERSION);
        change(directory.path());
        load_bundled_manifest(directory.path(), repository, &key, &binary).is_err()
    };
    assert!(refused(&|_| {}, "someone/kixdns"), "another repository");
    assert!(
        refused(
            &|directory| std::fs::write(
                directory.join("KIXDNS_ARTIFACT_NAME"),
                kernel_asset_name("2026.10.12"),
            )
            .unwrap(),
            TEST_REPOSITORY,
        ),
        "a package name for another version"
    );
    assert!(
        refused(
            &|directory| std::fs::write(
                directory.join("KIXDNS_SOURCE.json"),
                kernel_source_json(TEST_VERSION, "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25"),
            )
            .unwrap(),
            TEST_REPOSITORY,
        ),
        "a source note for another commit"
    );
    assert!(
        refused(
            &|directory| std::fs::remove_file(directory.join("KIXDNS_SOURCE.json")).unwrap(),
            TEST_REPOSITORY,
        ),
        "no source note"
    );
}

#[tokio::test]
async fn a_full_package_with_a_fork_release_is_the_active_kernel() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let binary = test_elf();
    let bundled_metadata = directory.path().join("bundle");
    write_fork_bundle_metadata(&bundled_metadata, &binary, TEST_VERSION);
    let manager = UpdateManager::new(
        database,
        UpdateSettings {
            installed_source: Some("fork".to_owned()),
            installed_commit: Some(TEST_BUILD_COMMIT.to_owned()),
            installed_source_id: Some(77),
            bundled_metadata,
            ..test_settings(directory.path())
        },
    )
    .unwrap();
    std::fs::create_dir_all(directory.path().join("bin")).unwrap();
    std::fs::write(directory.path().join("bin/kixdns"), &binary).unwrap();

    manager.initialize_installed_version().await.unwrap();

    let expected = VersionKey::tracked(VersionSource::Fork, 77, TEST_BUILD_COMMIT).unwrap();
    assert_eq!(manager.active_version().await.unwrap(), Some(expected));
    assert!(
        manager.legacy_kernel_to_replace().await.unwrap().is_none(),
        "a fork kernel is never replaced at start-up"
    );
    assert_eq!(
        manager.active_capabilities().await.unwrap(),
        vec!["config_query_stats_v1".to_owned()]
    );
}

#[tokio::test]
async fn refuses_an_unknown_or_incomplete_installed_source() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let settings = |source: &str, source_id: Option<u64>| UpdateSettings {
        installed_source: Some(source.to_owned()),
        installed_commit: Some(TEST_BUILD_COMMIT.to_owned()),
        installed_source_id: source_id,
        ..test_settings(directory.path())
    };
    // 完整包不会带 Release 内核；fork 内核没有包编号就认不出是哪一个。
    // A full package never brings a Release kernel; a fork kernel without its package id
    // cannot be told apart.
    assert!(UpdateManager::new(database.clone(), settings("release", Some(7))).is_err());
    assert!(UpdateManager::new(database.clone(), settings("nightly", Some(7))).is_err());
    assert!(UpdateManager::new(database.clone(), settings("fork", None)).is_err());
    assert!(UpdateManager::new(database.clone(), settings("fork", Some(7))).is_ok());
    // 旧安装包不写来源：按 Action 构建处理。 / Older packages write no source: an Action build.
    assert!(UpdateManager::new(database, settings(" ", Some(7))).is_ok());
}

#[test]
fn validates_fixed_update_coordinates_and_digests() {
    assert!(validate_slug("tuoro/kixdns", true).is_ok());
    assert!(validate_slug("https://evil.invalid", true).is_err());
    assert!(validate_slug("owner/..", true).is_err());
    assert!(validate_digest(&format!("sha256:{}", "a".repeat(64))).is_ok());
    assert!(validate_digest("sha256:bad").is_err());
    assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
    assert!(validate_commit("not-a-commit").is_err());
    for source in [
        VersionSource::Action,
        VersionSource::Release,
        VersionSource::Fork,
    ] {
        let tracked =
            VersionKey::tracked(source, 42, "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").unwrap();
        assert_eq!(VersionKey::parse(&tracked.encoded()).unwrap(), tracked);
    }
    assert_eq!(
        VersionKey::tracked(
            VersionSource::Fork,
            77,
            "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25"
        )
        .unwrap()
        .directory_name(),
        "fork-77-374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25"
    );
    assert!(VersionKey::parse("nightly:42:374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_err());
}

#[test]
fn date_versions_compare_part_by_part() {
    let version = |tag: &str| parse_kernel_version(tag).unwrap();
    assert!(version("2026.10.13") < version("2026.10.13.2"));
    assert!(version("2026.10.13.2") < version("2026.10.13.10"));
    assert!(version("2026.10.13.10") < version("2026.10.14"));
    assert!(version("2026.09.30.3") < version("2026.10.01"));
    assert!(version("2026.12.31") < version("2027.01.01"));
    assert_eq!(version("2026.10.13"), version("2026.10.13"));
    for tag in [
        "",
        "v2026.10.13",
        "2026.10",
        "2026.1.13",
        "2026.10.3",
        "26.10.13",
        "2026.13.01",
        "2026.00.10",
        "2026.10.32",
        "2026.10.13.1",
        "2026.10.13.0",
        "2026.10.13.02",
        "2026.10.13.",
        "2026.10.13.2.1",
        "2026.10.13-2",
        "2026.10.13.x",
    ] {
        assert!(parse_kernel_version(tag).is_err(), "{tag:?}");
    }
}

/// fork 最新发布的样子：本机架构的包、另一个架构的包和发布清单。
/// What the fork's latest release looks like: this architecture's package, the other
/// architecture's and the manifest.
fn test_release(tag: &str, size: u64, digest: Option<String>) -> GithubRelease {
    let other = if kernel_architecture() == "x86_64" {
        "arm64"
    } else {
        "x86_64"
    };
    GithubRelease {
        tag_name: tag.to_owned(),
        published_at: Some("2026-10-13T08:00:00Z".to_owned()),
        draft: false,
        prerelease: false,
        assets: vec![
            ReleaseAsset {
                id: 77,
                name: kernel_asset_name(tag),
                size,
                digest,
            },
            ReleaseAsset {
                id: 78,
                name: format!("kixdns-{tag}-linux-{other}.zip"),
                size: 9,
                digest: None,
            },
            ReleaseAsset {
                id: 79,
                name: "manifest.json".to_owned(),
                size: 700,
                digest: None,
            },
        ],
    }
}

fn test_release_manifest(tag: &str, size: u64) -> serde_json::Value {
    serde_json::json!({
        "schema_version": 1,
        "repository": TEST_REPOSITORY,
        "version": tag,
        "commit": TEST_BUILD_COMMIT,
        "upstream_commit": TEST_UPSTREAM_COMMIT,
        "control_protocol": 1,
        "config_capabilities": ["config_query_stats_v1"],
        "assets": {
            kernel_architecture(): {
                "name": kernel_asset_name(tag),
                "size": size,
                "sha256": "b".repeat(64),
            },
        },
    })
}

#[test]
fn accepts_the_latest_release_that_matches_its_manifest() {
    let manifest: ReleaseManifest =
        serde_json::from_value(test_release_manifest(TEST_VERSION, 4096)).unwrap();
    let digest = format!("sha256:{}", "b".repeat(64));
    for recorded in [Some(digest.clone()), None] {
        let release = test_release(TEST_VERSION, 4096, recorded);
        let remote = remote_version(TEST_REPOSITORY, &release, &manifest).unwrap();
        assert_eq!(remote.source, VersionSource::Fork);
        assert_eq!(remote.source_id, 77);
        assert_eq!(remote.release_tag, TEST_VERSION);
        assert_eq!(remote.commit, TEST_BUILD_COMMIT);
        assert_eq!(
            remote.upstream_commit.as_deref(),
            Some(TEST_UPSTREAM_COMMIT)
        );
        assert_eq!(remote.artifact_digest, digest);
        assert_eq!(
            remote.download_url,
            format!(
                "https://github.com/tuoro/kixdns/releases/download/2026.10.13.2/{}",
                kernel_asset_name(TEST_VERSION)
            )
        );
        assert_eq!(
            remote.build_url,
            "https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2"
        );
        assert_eq!(remote.config_capabilities, vec!["config_query_stats_v1"]);
    }

    // 第一版发布记的是 base_commit，没有 upstream_commit：照样认，只是不显示原版提交。
    // The first release recorded base_commit rather than upstream_commit: still accepted,
    // only without an upstream commit to show.
    let mut first = test_release_manifest("2026.10.13", 4096);
    first.as_object_mut().unwrap().remove("upstream_commit");
    first["base_commit"] = TEST_UPSTREAM_COMMIT.into();
    let first: ReleaseManifest = serde_json::from_value(first).unwrap();
    let remote = remote_version(
        TEST_REPOSITORY,
        &test_release("2026.10.13", 4096, None),
        &first,
    )
    .unwrap();
    assert_eq!(remote.upstream_commit, None);
    assert_eq!(remote.source_url, None);
}

#[test]
fn refuses_a_release_that_disagrees_with_its_manifest() {
    let refused = |change: &dyn Fn(&mut serde_json::Value, &mut GithubRelease)| {
        let mut manifest = test_release_manifest(TEST_VERSION, 4096);
        let mut release = test_release(TEST_VERSION, 4096, None);
        change(&mut manifest, &mut release);
        let manifest: ReleaseManifest = serde_json::from_value(manifest).unwrap();
        remote_version(TEST_REPOSITORY, &release, &manifest).is_err()
    };
    assert!(!refused(&|_, _| {}), "the unchanged release is accepted");
    assert!(refused(
        &|manifest, _| manifest["repository"] = "someone/kixdns".into()
    ));
    assert!(refused(
        &|manifest, _| manifest["version"] = "2026.10.13".into()
    ));
    assert!(refused(&|manifest, _| manifest["schema_version"] = 2.into()));
    assert!(refused(&|manifest, _| manifest["commit"] = "main".into()));
    assert!(refused(
        &|manifest, _| manifest["upstream_commit"] = "abc".into()
    ));
    assert!(refused(
        &|manifest, _| manifest["control_protocol"] = 2.into()
    ));
    assert!(refused(
        &|manifest, _| manifest["config_capabilities"] = serde_json::json!(["Bad Name"])
    ));
    assert!(refused(
        &|manifest, _| manifest["assets"] = serde_json::json!({})
    ));
    assert!(refused(&|manifest, _| {
        manifest["assets"][kernel_architecture()]["name"] = "kixdns.zip".into();
    }));
    assert!(refused(&|manifest, _| {
        manifest["assets"][kernel_architecture()]["sha256"] = "b".into();
    }));
    assert!(refused(&|manifest, _| {
        manifest["assets"][kernel_architecture()]["size"] = 0.into();
    }));
    assert!(refused(&|_, release| release.prerelease = true));
    assert!(refused(&|_, release| release.draft = true));
    assert!(refused(&|_, release| release.tag_name = "v0.2.0".to_owned()));
    assert!(refused(&|_, release| release.assets[0].size = 4097));
    assert!(refused(&|_, release| release.assets[0].id = 0));
    assert!(refused(&|_, release| {
        release.assets[0].digest = Some(format!("sha256:{}", "c".repeat(64)));
    }));
    assert!(refused(&|_, release| {
        release.assets.remove(0);
    }));
}

#[test]
fn serializes_remote_release_identity() {
    let serialized = serde_json::to_value(fork_remote(77, TEST_VERSION)).unwrap();
    assert_eq!(serialized["source"], "fork");
    assert_eq!(serialized["release_tag"], TEST_VERSION);
    assert_eq!(
        serialized["artifact_digest"],
        format!("sha256:{}", "a".repeat(64))
    );
}

#[test]
fn notifies_only_for_newer_panel_release_with_matching_asset() {
    let no_release = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, None).unwrap();
    assert!(!no_release.available);
    assert!(no_release.latest_version.is_none());

    let release = |tag: &str, asset_name: &str| GithubRelease {
        tag_name: tag.to_owned(),
        published_at: Some("2026-07-30T00:00:00Z".to_owned()),
        draft: false,
        prerelease: false,
        assets: vec![ReleaseAsset {
            id: 1,
            name: asset_name.to_owned(),
            size: 1,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        }],
    };
    let current_version = env!("CARGO_PKG_VERSION");
    let current_tag = format!("v{current_version}");
    let same = release(&current_tag, panel_release_asset_name());
    assert!(
        !to_panel_update_notice(None, Some(&current_tag), Some(&same))
            .unwrap()
            .available
    );
    assert!(
        to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&same))
            .unwrap()
            .available
    );

    let older = release("v0.0.9", panel_release_asset_name());
    assert!(
        !to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&older))
            .unwrap()
            .available
    );

    let wrong_asset = release(&current_tag, "kixdns-panel-windows.zip");
    assert!(
        !to_panel_update_notice(None, None, Some(&wrong_asset))
            .unwrap()
            .available
    );

    let notice = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&same)).unwrap();
    assert!(notice.available);
    assert_eq!(notice.current_version, current_version);
    assert_eq!(notice.latest_version.as_deref(), Some(current_version));
    assert_eq!(
        notice.download_url.as_deref(),
        Some(
            format!(
                "https://github.com/tuoro/kixdns-panel/releases/download/{current_tag}/{}",
                panel_release_asset_name()
            )
            .as_str()
        )
    );

    let major_release = release("v2.0.0", panel_release_asset_name());
    let major_update = to_panel_update_notice(None, Some("v1.0.25"), Some(&major_release)).unwrap();
    assert!(major_update.available);
    assert_eq!(major_update.latest_version.as_deref(), Some("2.0.0"));
}

fn installed_build(
    source: VersionSource,
    release_tag: Option<&str>,
) -> (VersionKey, InstalledVersion) {
    let manifest = VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(source),
        source_id: Some(7),
        commit: TEST_BUILD_COMMIT.to_owned(),
        run_id: (source == VersionSource::Action).then_some(36_374_613_990),
        release_tag: release_tag.map(str::to_owned),
        created_at: None,
        source_url: None,
        build_url: None,
        artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
        artifact_digest: None,
        upstream_repository: None,
        upstream_commit: None,
        patchset: (source == VersionSource::Action).then_some(28),
        dependency_revision: None,
        control_protocol: Some(1),
        config_capabilities: Vec::new(),
        binary_sha256: "b".repeat(64),
        installed_at: 1,
    };
    let key = VersionKey::tracked(source, 7, TEST_BUILD_COMMIT).unwrap();
    (key, manifest.into_installed(true))
}

#[test]
fn kixdns_notice_follows_date_versions() {
    let latest = fork_remote(77, TEST_VERSION);
    let available = |installed: &str| {
        let (active, current) = installed_build(VersionSource::Fork, Some(installed));
        to_kixdns_update_notice(&latest, Some(&active), Some(&current)).available
    };
    assert!(available("2026.10.13"));
    assert!(available("2026.09.30.4"));
    assert!(
        !available("2026.10.13.2"),
        "the same version is not an update"
    );
    assert!(
        !available("2026.10.13.10"),
        "an older release is never offered as an update"
    );
    assert!(!available("2026.10.14"));

    let notice = to_kixdns_update_notice(&latest, None, None);
    assert!(!notice.available, "nothing installed: the page offers 安装");
    assert_eq!(notice.release_tag, TEST_VERSION);
    assert_eq!(
        notice.release_url,
        "https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2"
    );
}

#[test]
fn old_track_kernels_are_offered_the_fork_release() {
    let latest = fork_remote(77, TEST_VERSION);
    // 旧轨道已停止更新：装着 p28 的 Action 内核或更早的 Release 内核，fork 的最新版本就是更新。
    // The old tracks no longer update: with a p28 Action kernel or an earlier Release
    // kernel installed, the fork's newest version is the update.
    for (source, tag) in [
        (VersionSource::Action, None),
        (VersionSource::Release, Some("v0.2.0")),
    ] {
        let (active, current) = installed_build(source, tag);
        assert!(to_kixdns_update_notice(&latest, Some(&active), Some(&current)).available);
        assert!(to_kixdns_update_notice(&latest, Some(&active), None).available);
    }
}

#[test]
fn extracts_a_checksum_verified_release_package() {
    let binary = b"test-binary";
    let source = kernel_source_json(TEST_VERSION, TEST_BUILD_COMMIT);
    let extracted = extract_artifact(&kernel_package(binary, &source, TEST_CAPABILITIES)).unwrap();
    assert_eq!(extracted.binary, binary);
    assert_eq!(extracted.source.version, TEST_VERSION);
    assert_eq!(extracted.config_capabilities, vec!["config_query_stats_v1"]);
    verify_kernel_source(
        &extracted.source,
        TEST_REPOSITORY,
        TEST_VERSION,
        TEST_BUILD_COMMIT,
        Some(TEST_UPSTREAM_COMMIT),
    )
    .unwrap();
}

#[test]
fn rejects_a_tampered_or_incomplete_release_package() {
    let binary = b"test-binary";
    let source = kernel_source_json(TEST_VERSION, TEST_BUILD_COMMIT);
    let package = |entries: &[(&str, &[u8])]| {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    };
    let checksums = format!(
        "{}  kixdns\n{}  KIXDNS_CAPABILITIES.json\n{}  KIXDNS_SOURCE.json\n",
        sha256(binary),
        sha256(TEST_CAPABILITIES.as_bytes()),
        sha256(source.as_bytes())
    );
    // 二进制被换过，校验值对不上。 / The binary was swapped and no longer matches.
    let tampered = package(&[
        ("kixdns", b"other-binary"),
        ("KIXDNS_CAPABILITIES.json", TEST_CAPABILITIES.as_bytes()),
        ("KIXDNS_SOURCE.json", source.as_bytes()),
        ("SHA256SUMS", checksums.as_bytes()),
    ]);
    assert!(extract_artifact(&tampered).is_err());
    // 旧 Action 包的样子：没有 KIXDNS_SOURCE.json。 / An old Action package: no KIXDNS_SOURCE.json.
    let without_source = package(&[
        ("kixdns", binary),
        ("KIXDNS_CAPABILITIES.json", TEST_CAPABILITIES.as_bytes()),
        ("SHA256SUMS", checksums.as_bytes()),
    ]);
    assert!(extract_artifact(&without_source).is_err());
    let unsupported = source.replace("\"schema_version\":1", "\"schema_version\":2");
    assert!(extract_artifact(&kernel_package(binary, &unsupported, TEST_CAPABILITIES)).is_err());
}

#[test]
fn a_package_must_be_the_version_its_manifest_names() {
    let source = |version: &str, commit: &str| {
        serde_json::from_str::<super::KernelSource>(&kernel_source_json(version, commit)).unwrap()
    };
    let check = |source: &super::KernelSource, upstream: Option<&str>| {
        verify_kernel_source(
            source,
            TEST_REPOSITORY,
            TEST_VERSION,
            TEST_BUILD_COMMIT,
            upstream,
        )
    };
    let packaged = source(TEST_VERSION, TEST_BUILD_COMMIT);
    assert!(check(&packaged, Some(TEST_UPSTREAM_COMMIT)).is_ok());
    assert!(check(&packaged, None).is_err(), "upstream commits differ");
    assert!(
        check(
            &source("2026.10.13", TEST_BUILD_COMMIT),
            Some(TEST_UPSTREAM_COMMIT)
        )
        .is_err()
    );
    assert!(
        check(
            &source(TEST_VERSION, "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25"),
            Some(TEST_UPSTREAM_COMMIT)
        )
        .is_err()
    );
    let mut other_arch = packaged.clone();
    other_arch.arch = "riscv64".to_owned();
    assert!(check(&other_arch, Some(TEST_UPSTREAM_COMMIT)).is_err());
    let mut other_repository = packaged.clone();
    other_repository.repository = "someone/kixdns".to_owned();
    assert!(check(&other_repository, Some(TEST_UPSTREAM_COMMIT)).is_err());
    let mut newer_protocol = packaged;
    newer_protocol.control_protocol = 2;
    let error = check(&newer_protocol, Some(TEST_UPSTREAM_COMMIT)).unwrap_err();
    assert!(error.to_string().contains("控制协议不兼容"), "{error}");
}

#[test]
fn stores_and_revalidates_local_versions() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let manifest = VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Action),
        source_id: Some(42),
        commit: commit.to_owned(),
        run_id: Some(42),
        release_tag: None,
        created_at: Some("2026-07-28T00:00:00Z".to_owned()),
        source_url: Some("https://github.com/olicesx/kixdns/actions/runs/42".to_owned()),
        build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
        artifact: "kixdns-enhanced-action-42-linux-x86_64".to_owned(),
        artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
        upstream_repository: Some("olicesx/kixdns".to_owned()),
        upstream_commit: Some(commit.to_owned()),
        patchset: Some(5),
        dependency_revision: None,
        control_protocol: Some(1),
        config_capabilities: Vec::new(),
        binary_sha256: sha256(&binary),
        installed_at: 42,
    };
    let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    store_version(directory.path(), &manifest, &binary).unwrap();
    let (loaded, loaded_binary) = load_verified_version(directory.path(), &key).unwrap();
    assert_eq!(loaded.commit, commit);
    assert_eq!(loaded_binary, binary);

    std::fs::write(
        directory.path().join(key.directory_name()).join("kixdns"),
        b"tampered",
    )
    .unwrap();
    assert!(load_verified_version(directory.path(), &key).is_err());
}

#[test]
fn preserves_v4_source_identity_when_adding_capabilities() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let mut manifest = test_manifest(42, commit, &binary);
    manifest.schema_version = 4;
    let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    store_version(directory.path(), &manifest, &binary).unwrap();

    update_stored_capabilities(
        directory.path(),
        &key,
        vec!["config_query_stats_v1".to_owned()],
    )
    .unwrap();
    let (loaded, _) = load_verified_version(directory.path(), &key).unwrap();

    assert_eq!(loaded.schema_version, MANIFEST_SCHEMA_VERSION);
    assert_eq!(loaded.source_id, Some(42));
    assert_eq!(loaded.config_capabilities, vec!["config_query_stats_v1"]);
}

#[test]
fn prunes_everything_but_the_current_and_the_previous_kernel() {
    let directory = tempdir().unwrap();
    let keys = (40..44)
        .map(|source_id| store_stored_build(directory.path(), source_id, 10))
        .collect::<Vec<_>>();

    prune_versions(directory.path(), &keys[3], Some(&keys[1])).unwrap();

    let kept = keys
        .iter()
        .map(|key| directory.path().join(key.directory_name()).is_dir())
        .collect::<Vec<_>>();
    assert_eq!(kept, [false, true, false, true]);

    prune_versions(directory.path(), &keys[3], None).unwrap();
    assert!(!directory.path().join(keys[1].directory_name()).exists());
    assert!(directory.path().join(keys[3].directory_name()).is_dir());
}

#[cfg(unix)]
#[test]
fn pruning_leaves_a_symlinked_version_directory_and_its_target_alone() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let active = store_stored_build(directory.path(), 43, 10);
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let linked = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    symlink(
        outside.path(),
        directory.path().join(linked.directory_name()),
    )
    .unwrap();

    prune_versions(directory.path(), &active, None).unwrap();

    assert!(outside.path().is_dir());
    assert!(
        std::fs::symlink_metadata(directory.path().join(linked.directory_name()))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn treats_empty_panel_release_as_unset() {
    let directory = tempdir().unwrap();
    let manager = UpdateManager::new(
        Database::open(directory.path().join("panel.db"))
            .await
            .unwrap(),
        UpdateSettings {
            panel_installed_release: Some(String::new()),
            ..test_settings(directory.path())
        },
    )
    .unwrap();

    assert!(manager.panel_release.is_none());
}

#[test]
fn reads_legacy_manifest_without_build_identity() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let commit = "8eb8588ebe3e7965cf40ca161c05ac400ac2f5e5";
    let manifest = VersionManifest {
        schema_version: 1,
        source: None,
        source_id: None,
        commit: commit.to_owned(),
        run_id: None,
        release_tag: None,
        created_at: None,
        source_url: None,
        build_url: None,
        artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
        artifact_digest: None,
        upstream_repository: None,
        upstream_commit: None,
        patchset: None,
        dependency_revision: None,
        control_protocol: None,
        config_capabilities: Vec::new(),
        binary_sha256: sha256(&binary),
        installed_at: 42,
    };

    store_version(directory.path(), &manifest, &binary).unwrap();
    let key = VersionKey::new(VersionSource::Action, commit).unwrap();
    std::fs::rename(
        directory.path().join(key.directory_name()),
        directory.path().join(commit),
    )
    .unwrap();
    let (loaded, _) = load_verified_version(directory.path(), &key).unwrap();
    assert_eq!(loaded.schema_version, 1);
    assert_eq!(loaded.source, Some(VersionSource::Action));
    assert!(loaded.upstream_commit.is_none());
}

#[test]
fn keeps_tracked_builds_with_the_same_commit_separate() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let commit = TEST_BUILD_COMMIT;
    let make_manifest = |source, source_id, run_id, release_tag, artifact: &str| VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(source),
        source_id: Some(source_id),
        commit: commit.to_owned(),
        run_id,
        release_tag,
        created_at: Some("2026-07-28T00:00:00Z".to_owned()),
        source_url: Some("https://github.com/olicesx/kixdns".to_owned()),
        build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
        artifact: artifact.to_owned(),
        artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
        upstream_repository: Some("olicesx/kixdns".to_owned()),
        upstream_commit: Some("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned()),
        patchset: Some(5),
        dependency_revision: None,
        control_protocol: Some(1),
        config_capabilities: Vec::new(),
        binary_sha256: sha256(&binary),
        installed_at: 42,
    };
    let action = make_manifest(
        VersionSource::Action,
        99,
        Some(30_235_703_570),
        None,
        "kixdns-enhanced-action-30235703570-linux-x86_64",
    );
    let release = make_manifest(
        VersionSource::Release,
        100,
        None,
        Some("v0.1.1".to_owned()),
        "kixdns-enhanced-release-v0.1.1-linux-x86_64",
    );
    let previous_action = make_manifest(
        VersionSource::Action,
        101,
        Some(30_231_271_280),
        None,
        "kixdns-enhanced-action-30231271280-linux-x86_64",
    );

    let fork = fork_manifest(&fork_remote(102, TEST_VERSION), &binary);

    store_version(directory.path(), &action, &binary).unwrap();
    store_version(directory.path(), &release, &binary).unwrap();
    store_version(directory.path(), &previous_action, &binary).unwrap();
    store_version(directory.path(), &fork, &binary).unwrap();

    let action_key = VersionKey::tracked(VersionSource::Action, 99, commit).unwrap();
    let release_key = VersionKey::tracked(VersionSource::Release, 100, commit).unwrap();
    let previous_action_key = VersionKey::tracked(VersionSource::Action, 101, commit).unwrap();
    assert!(directory.path().join(action_key.directory_name()).is_dir());
    assert!(directory.path().join(release_key.directory_name()).is_dir());
    assert!(
        directory
            .path()
            .join(previous_action_key.directory_name())
            .is_dir()
    );
    assert_eq!(
        load_verified_version(directory.path(), &action_key)
            .unwrap()
            .0
            .source,
        Some(VersionSource::Action)
    );
    assert_eq!(
        load_verified_version(directory.path(), &release_key)
            .unwrap()
            .0
            .source,
        Some(VersionSource::Release)
    );
    let fork_key = VersionKey::tracked(VersionSource::Fork, 102, commit).unwrap();
    assert_eq!(
        load_verified_version(directory.path(), &fork_key)
            .unwrap()
            .0
            .release_tag
            .as_deref(),
        Some(TEST_VERSION)
    );
}

#[test]
fn a_stored_fork_release_carries_no_patchset() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let remote = fork_remote(77, TEST_VERSION);
    let mut with_patchset = fork_manifest(&remote, &binary);
    with_patchset.patchset = Some(28);
    assert!(store_version(directory.path(), &with_patchset, &binary).is_err());
    let mut bad_tag = fork_manifest(&remote, &binary);
    bad_tag.release_tag = Some("v0.2.0".to_owned());
    assert!(store_version(directory.path(), &bad_tag, &binary).is_err());
    let mut no_protocol = fork_manifest(&remote, &binary);
    no_protocol.control_protocol = None;
    assert!(store_version(directory.path(), &no_protocol, &binary).is_err());
    // 没记原版提交的（第一版发布）照样能存。 / One without an upstream commit (the first release) is still stored.
    let mut first = fork_manifest(&remote, &binary);
    first.upstream_repository = None;
    first.upstream_commit = None;
    store_version(directory.path(), &first, &binary).unwrap();
}

#[test]
fn a_bundled_release_identity_is_refused() {
    // 旧完整包里只会是 Action 构建；带 Release 身份的一律不认。
    // An old full package can only hold an Action build; a Release identity is refused.
    let release = serde_json::json!({
        "repository": "olicesx/kixdns",
        "source": "release",
        "commit": "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
        "release_id": 7,
        "release_tag": "v0.2.0",
        "patchset": 5,
        "control_protocol": 1,
    });
    let release = serde_json::from_value::<BuildIdentity>(release).unwrap();
    assert!(super::validation::validate_build_identity(&release).is_err());
}

/// 记录切换期间对宿主机做了什么的假宿主。
/// A fake host that records what a switch did to the host.
struct FakeHost {
    running: bool,
    failed_health_checks: AtomicUsize,
    /// 依次决定每一次重启会不会被 systemd 拒绝（true 拒绝）；排空后都放行 / Decides, in order, whether each restart is refused by systemd (true refuses); all pass once drained
    refused_restarts: StdMutex<Vec<bool>>,
    calls: StdMutex<Vec<String>>,
}

impl FakeHost {
    fn new(running: bool) -> Self {
        Self {
            running,
            failed_health_checks: AtomicUsize::new(0),
            refused_restarts: StdMutex::new(Vec::new()),
            calls: StdMutex::new(Vec::new()),
        }
    }

    fn failing_first_health_check(running: bool) -> Self {
        let host = Self::new(running);
        host.failed_health_checks.store(1, Ordering::SeqCst);
        host
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ServiceHost for FakeHost {
    fn service_running(&self) -> BoxFuture<'_, Result<bool, UpdateError>> {
        Box::pin(async move { Ok(self.running) })
    }

    fn service_action(&self, action: ServiceAction) -> BoxFuture<'_, Result<(), UpdateError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!("{action:?}"));
            let mut refusals = self.refused_restarts.lock().unwrap();
            if !refusals.is_empty() && refusals.remove(0) {
                return Err(UpdateError::Install(
                    "KixDNS 没能重启：systemd 拒绝了这次操作。查看原因：journalctl -u kixdns.service -n 50 --no-pager".to_owned(),
                ));
            }
            Ok(())
        })
    }

    fn wait_until_healthy(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("Health".to_owned());
            let failing = self
                .failed_health_checks
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok();
            if failing {
                return Err(UpdateError::Install("健康检查失败".to_owned()));
            }
            Ok(())
        })
    }

    fn runtime_capabilities(&self) -> BoxFuture<'_, Result<Vec<String>, UpdateError>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

pub(crate) struct SwitchFixture {
    _directory: tempfile::TempDir,
    pub(crate) manager: UpdateManager,
    pub(crate) database: Database,
    pub(crate) binary_path: std::path::PathBuf,
    versions_path: std::path::PathBuf,
    pub(crate) current: Vec<u8>,
    pub(crate) target: Vec<u8>,
    current_key: VersionKey,
    target_key: VersionKey,
}

impl SwitchFixture {
    /// 回退成功后数据库里应记录的活动版本。
    /// The active version the database should record after a successful rollback.
    pub(crate) fn target_setting(&self) -> String {
        self.target_key.encoded()
    }
}

/// 存一个可切换的版本；二进制按 Artifact ID 区分，`installed_at` 决定装得早晚。
/// Stores a version ready to switch to; binaries differ by artifact id, and
/// `installed_at` says how recently it was installed.
fn store_stored_build(
    versions_path: &std::path::Path,
    source_id: u64,
    installed_at: i64,
) -> VersionKey {
    let mut binary = test_elf();
    binary[31] = u8::try_from(source_id).unwrap();
    let mut manifest = test_manifest(source_id, TEST_BUILD_COMMIT, &binary);
    manifest.installed_at = installed_at;
    store_version(versions_path, &manifest, &binary).unwrap();
    VersionKey::tracked(VersionSource::Action, source_id, TEST_BUILD_COMMIT).unwrap()
}

/// 当前运行 Artifact 42，上一个内核 Artifact 43 留在本机，随时可以回退过去。
/// Artifact 42 is active and the previous kernel, Artifact 43, is kept on this host, ready
/// to roll back to.
pub(crate) async fn switch_fixture() -> SwitchFixture {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let binary_path = directory.path().join("bin/kixdns");
    let versions_path = directory.path().join("versions");
    let manager = UpdateManager::new(
        database.clone(),
        UpdateSettings {
            binary_path: binary_path.clone(),
            versions_path: versions_path.clone(),
            ..test_settings(directory.path())
        },
    )
    .unwrap();
    let current = test_elf();
    let mut target = test_elf();
    target[31] = 7;
    let current_commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let current_key = VersionKey::tracked(VersionSource::Action, 42, current_commit).unwrap();
    let target_key = VersionKey::tracked(VersionSource::Action, 43, TEST_BUILD_COMMIT).unwrap();
    std::fs::write(&binary_path, &current).unwrap();
    store_version(
        &versions_path,
        &test_manifest(42, current_commit, &current),
        &current,
    )
    .unwrap();
    store_version(
        &versions_path,
        &test_manifest(43, TEST_BUILD_COMMIT, &target),
        &target,
    )
    .unwrap();
    database
        .set_setting(super::ACTIVE_VERSION_KEY, current_key.encoded(), 42)
        .await
        .unwrap();
    database
        .set_setting(super::PREVIOUS_VERSION_KEY, target_key.encoded(), 42)
        .await
        .unwrap();
    SwitchFixture {
        _directory: directory,
        manager,
        database,
        binary_path,
        versions_path,
        current,
        target,
        current_key,
        target_key,
    }
}

pub(crate) async fn active_setting(database: &Database) -> Option<String> {
    database
        .get_setting(super::ACTIVE_VERSION_KEY)
        .await
        .unwrap()
}

async fn previous_setting(database: &Database) -> Option<String> {
    database
        .get_setting(super::PREVIOUS_VERSION_KEY)
        .await
        .unwrap()
}

fn empty_config() -> serde_json::Value {
    serde_json::json!({"pipelines": []})
}

#[tokio::test]
async fn switching_a_running_service_restarts_once_without_stop_or_start() {
    let fixture = switch_fixture().await;
    let host = FakeHost::new(true);

    fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap();

    // Start/Stop 经 helper 会 enable/disable，切换版本不能改开机策略。
    // Start/Stop through the helper enable/disable; a switch must not change boot behaviour.
    assert_eq!(host.calls(), ["Restart", "Health"]);
    assert_eq!(std::fs::read(&fixture.binary_path).unwrap(), fixture.target);
    assert_eq!(
        active_setting(&fixture.database).await,
        Some(fixture.target_key.encoded())
    );
}

#[tokio::test]
async fn switching_a_stopped_service_only_replaces_the_binary() {
    let fixture = switch_fixture().await;
    let host = FakeHost::new(false);

    fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap();

    // 停着的服务不能因为切换版本就启动：DNS 不该意外开始监听 53 端口。
    // A stopped service must not start because of a switch: DNS must not
    // unexpectedly begin listening on port 53.
    assert!(host.calls().is_empty(), "{:?}", host.calls());
    assert_eq!(std::fs::read(&fixture.binary_path).unwrap(), fixture.target);
    assert_eq!(
        active_setting(&fixture.database).await,
        Some(fixture.target_key.encoded())
    );
}

#[tokio::test]
async fn unhealthy_switch_restores_the_previous_binary_with_restart_only() {
    let fixture = switch_fixture().await;
    let host = FakeHost::failing_first_health_check(true);

    let error = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap_err();

    assert!(matches!(error, UpdateError::Install(_)), "{error}");
    // 回退的目标比当前旧：失败的说法按构建号称呼两边，不说「新内核」 / A rollback target is older than the current kernel: the failure names both by build, never 新内核
    assert_eq!(error.reason(), "构建 #43 健康检查失败，已换回构建 #42");
    assert_eq!(host.calls(), ["Restart", "Health", "Restart", "Health"]);
    assert_eq!(
        std::fs::read(&fixture.binary_path).unwrap(),
        fixture.current
    );
    assert_eq!(
        active_setting(&fixture.database).await,
        Some(fixture.current_key.encoded())
    );
    // 没换成就不动回退目标。 / A switch that did not happen leaves the rollback target alone.
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(fixture.target_key.encoded())
    );
}

#[tokio::test]
async fn a_switch_that_cannot_go_back_says_both_builds_and_the_next_step() {
    let fixture = switch_fixture().await;
    let host = FakeHost::new(true);
    host.failed_health_checks.store(2, Ordering::SeqCst);

    let error = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap_err();

    // 两边都没起来：各说一次是谁、为什么，最后给一步能做的 / Neither came up: each named once with its cause, ending with one thing to do
    assert_eq!(
        error.reason(),
        "构建 #43 健康检查失败；换回构建 #42 也没有启动起来。KixDNS 现在停着，过一会儿再点「启动」"
    );
}

// systemd 拒绝了第一次重启、换回去成功：主语只说一次，看原因的命令放在最后
// systemd refused the first restart and going back worked: the subject is said once and the command for the cause comes last
#[tokio::test]
async fn a_refused_restart_says_why_once_and_ends_with_the_command() {
    let fixture = switch_fixture().await;
    let host = FakeHost::new(true);
    *host.refused_restarts.lock().unwrap() = vec![true];

    let error = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap_err();

    assert_eq!(
        error.reason(),
        "构建 #43 没能启动：systemd 拒绝了这次操作，已换回构建 #42。查看原因：journalctl -u kixdns.service -n 50 --no-pager"
    );
}

// 新的没起来、换回去时 systemd 又拒绝了重启（崩溃重启太快撞上启动次数上限）：不叠「没能重启：KixDNS 没能重启」，命令放在最后
// The new one failed and systemd refused the restart for going back (a crash loop hit the start limit): no stacked subjects, the command last
#[tokio::test]
async fn a_refused_rollback_restart_reads_as_one_sentence() {
    let fixture = switch_fixture().await;
    let host = FakeHost::failing_first_health_check(true);
    *host.refused_restarts.lock().unwrap() = vec![false, true];

    let error = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap_err();

    assert_eq!(
        error.reason(),
        "构建 #43 健康检查失败；换回构建 #42 也没有启动起来：systemd 拒绝了这次操作。KixDNS 现在停着，过一会儿再点「启动」。查看原因：journalctl -u kixdns.service -n 50 --no-pager"
    );
}

#[tokio::test]
async fn rolling_back_twice_returns_to_the_original_kernel() {
    let fixture = switch_fixture().await;
    let host = FakeHost::new(true);

    let switched = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap();
    assert_eq!(switched.source_id, Some(43));
    assert!(switched.active);
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(fixture.current_key.encoded())
    );

    let restored = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap();
    assert_eq!(restored.source_id, Some(42));
    assert_eq!(
        std::fs::read(&fixture.binary_path).unwrap(),
        fixture.current
    );
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(fixture.target_key.encoded())
    );
}

#[tokio::test]
async fn rollback_without_a_previous_kernel_is_a_conflict() {
    let fixture = switch_fixture().await;
    fixture
        .database
        .delete_setting(super::PREVIOUS_VERSION_KEY)
        .await
        .unwrap();
    let host = FakeHost::new(true);

    let error = fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap_err();

    assert!(matches!(error, UpdateError::Conflict(_)), "{error}");
    assert!(host.calls().is_empty());
    assert_eq!(
        std::fs::read(&fixture.binary_path).unwrap(),
        fixture.current
    );
}

#[tokio::test]
async fn updating_keeps_the_replaced_kernel_as_the_only_other_version() {
    let fixture = switch_fixture().await;
    // 上一个原本是更早的 41；更新到 fork 版本之后，上一个变成刚换下的 42，41 被清掉。
    // The previous kernel was the older 41; after updating to a fork version it becomes
    // the 42 just replaced, and 41 is removed.
    let older = store_stored_build(&fixture.versions_path, 41, 10);
    fixture
        .database
        .set_setting(super::PREVIOUS_VERSION_KEY, older.encoded(), 42)
        .await
        .unwrap();
    let (latest, binary) = store_fork_build(&fixture.versions_path, 77, TEST_VERSION);
    let host = FakeHost::new(true);

    let installed = fixture
        .manager
        .update_locked(&latest, Some(77), &empty_config(), &host)
        .await
        .unwrap();

    assert_eq!(installed.source, Some(VersionSource::Fork));
    assert_eq!(installed.label(), TEST_VERSION);
    assert_eq!(std::fs::read(&fixture.binary_path).unwrap(), binary);
    assert_eq!(
        active_setting(&fixture.database).await,
        Some(VersionKey::remote(&latest).unwrap().encoded())
    );
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(fixture.current_key.encoded())
    );
    assert!(!fixture.versions_path.join(older.directory_name()).exists());
    assert!(
        fixture
            .versions_path
            .join(fixture.current_key.directory_name())
            .is_dir()
    );
}

#[tokio::test]
async fn update_refuses_a_build_other_than_the_one_the_page_showed() {
    let fixture = switch_fixture().await;
    let (latest, _) = store_fork_build(&fixture.versions_path, 77, TEST_VERSION);
    let host = FakeHost::new(true);

    let error = fixture
        .manager
        .update_locked(&latest, Some(44), &empty_config(), &host)
        .await
        .unwrap_err();

    assert!(matches!(error, UpdateError::Conflict(_)), "{error}");
    assert_eq!(
        error.reason(),
        "没有更新内核：又发布了更新的版本，点「检查更新」看过后再更新"
    );
    assert!(host.calls().is_empty());
    assert_eq!(
        std::fs::read(&fixture.binary_path).unwrap(),
        fixture.current
    );
}

#[tokio::test]
async fn a_failed_switch_names_the_date_version() {
    let fixture = switch_fixture().await;
    let (latest, _) = store_fork_build(&fixture.versions_path, 77, TEST_VERSION);
    let host = FakeHost::failing_first_health_check(true);

    let error = fixture
        .manager
        .update_locked(&latest, Some(77), &empty_config(), &host)
        .await
        .unwrap_err();

    // 日期版本以数字开头：接在汉字后面空一格，和页面一样。
    // A date version starts with a digit: it takes a space after Chinese text, as on the page.
    assert_eq!(error.reason(), "2026.10.13.2 健康检查失败，已换回构建 #42");
}

#[tokio::test]
async fn start_up_keeps_the_current_kernel_and_one_previous() {
    let fixture = switch_fixture().await;
    // 旧面板留下的库存：没记过上一个，另有三个版本，装得最晚的是 41。
    // Inventory left by an older panel: no previous recorded and three other versions,
    // of which 41 was installed last.
    fixture
        .database
        .delete_setting(super::PREVIOUS_VERSION_KEY)
        .await
        .unwrap();
    let older = store_stored_build(&fixture.versions_path, 40, 1);
    let newest = store_stored_build(&fixture.versions_path, 41, 1_000);

    fixture
        .manager
        .initialize_installed_version()
        .await
        .unwrap();

    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(newest.encoded())
    );
    let present = [&older, &newest, &fixture.target_key, &fixture.current_key]
        .map(|key| fixture.versions_path.join(key.directory_name()).is_dir());
    assert_eq!(present, [false, true, false, true]);

    // 记过的上一个还在，就照记录留，不按装的早晚另挑。
    // A recorded previous kernel that is still present is kept as recorded.
    let recorded = store_stored_build(&fixture.versions_path, 39, 1);
    fixture
        .database
        .set_setting(super::PREVIOUS_VERSION_KEY, recorded.encoded(), 42)
        .await
        .unwrap();
    fixture
        .manager
        .initialize_installed_version()
        .await
        .unwrap();
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(recorded.encoded())
    );
    assert!(!fixture.versions_path.join(newest.directory_name()).exists());
}

#[tokio::test]
async fn an_old_track_kernel_is_replaced_once_and_left_alone_after_a_rollback() {
    let fixture = switch_fixture().await;
    // 只在线更新过面板的主机还跑着 p28 的 Action 内核：新面板启动时换成 fork 版本。
    // A host that only updated the panel online still runs the p28 Action kernel: the new
    // panel replaces it with the fork version at start-up.
    assert_eq!(
        fixture
            .manager
            .legacy_kernel_to_replace()
            .await
            .unwrap()
            .and_then(|version| version.source_id),
        Some(42)
    );

    let (latest, _) = store_fork_build(&fixture.versions_path, 77, TEST_VERSION);
    let host = FakeHost::new(true);
    fixture
        .manager
        .update_locked(&latest, None, &empty_config(), &host)
        .await
        .unwrap();
    assert!(
        fixture
            .manager
            .legacy_kernel_to_replace()
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        previous_setting(&fixture.database).await,
        Some(fixture.current_key.encoded())
    );

    // 用户自己回退到旧内核：面板重启时不再替换。
    // The user rolls back to the old kernel: a panel restart does not replace it again.
    fixture
        .manager
        .rollback(&empty_config(), &host)
        .await
        .unwrap();
    assert_eq!(
        active_setting(&fixture.database).await,
        Some(fixture.current_key.encoded())
    );
    assert!(
        fixture
            .manager
            .legacy_kernel_to_replace()
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_earlier_release_kernel_is_replaced_too() {
    let fixture = switch_fixture().await;
    let mut release_binary = test_elf();
    release_binary[31] = 9;
    let mut manifest = test_manifest(100, TEST_BUILD_COMMIT, &release_binary);
    manifest.source = Some(VersionSource::Release);
    manifest.run_id = None;
    manifest.release_tag = Some("v0.2.0".to_owned());
    manifest.artifact = "kixdns-enhanced-release-v0.2.0-linux-x86_64".to_owned();
    store_version(&fixture.versions_path, &manifest, &release_binary).unwrap();
    let release_key = VersionKey::tracked(VersionSource::Release, 100, TEST_BUILD_COMMIT).unwrap();
    std::fs::write(&fixture.binary_path, &release_binary).unwrap();
    fixture
        .database
        .set_setting(super::ACTIVE_VERSION_KEY, release_key.encoded(), 42)
        .await
        .unwrap();
    // v3.4.0 把 Release 换成 Action 时记下的旧标记不挡这一次。
    // The old marker v3.4.0 left when it replaced a Release kernel does not block this one.
    fixture
        .database
        .set_setting("release_kernel_replaced_at", "1".to_owned(), 1)
        .await
        .unwrap();

    assert_eq!(
        fixture
            .manager
            .legacy_kernel_to_replace()
            .await
            .unwrap()
            .and_then(|version| version.release_tag),
        Some("v0.2.0".to_owned())
    );
}

#[test]
fn installed_label_matches_the_page() {
    let mut version = InstalledVersion {
        source: Some(VersionSource::Action),
        source_id: Some(7),
        commit: "0123456789abcdef".to_owned(),
        run_id: Some(30_231_271_280),
        release_tag: None,
        created_at: None,
        source_url: None,
        build_url: None,
        artifact: String::new(),
        artifact_digest: None,
        upstream_repository: None,
        upstream_commit: None,
        patchset: None,
        dependency_revision: None,
        control_protocol: None,
        config_capabilities: Vec::new(),
        binary_sha256: String::new(),
        installed_at: 0,
        active: true,
    };
    assert_eq!(version.label(), "构建 #30231271280");
    version.run_id = None;
    version.release_tag = Some("v0.2.0".to_owned());
    assert_eq!(version.label(), "v0.2.0");
    version.source = Some(VersionSource::Fork);
    version.release_tag = Some(TEST_VERSION.to_owned());
    assert_eq!(version.label(), "2026.10.13.2");
    version.release_tag = None;
    assert_eq!(version.label(), "构建 0123456789ab");
}

#[test]
fn a_failed_check_reports_only_its_cause() {
    let error = UpdateError::Network("GitHub 匿名访问次数用完了".to_owned());
    assert_eq!(error.reason(), "GitHub 匿名访问次数用完了");
    assert_eq!(UpdateError::Unsupported.reason(), "当前平台不支持自动更新");
}
