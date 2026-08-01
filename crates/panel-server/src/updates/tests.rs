use std::io::{Cursor, Write};

use tempfile::tempdir;

use super::validation::ParsedArtifactReference;
use super::{
    BuildIdentity, GithubRelease, MANIFEST_SCHEMA_VERSION, ReleaseAsset, RemoteVersion,
    TrackReference, UpdateError, UpdateManager, UpdateSettings, VersionKey, VersionManifest,
    VersionSource, delete_stored_version, extract_artifact, load_verified_version,
    panel_release_asset_name, parse_artifact_reference, sha256, store_version,
    to_kixdns_update_notice, to_panel_update_notice, update_stored_capabilities, validate_commit,
    validate_digest, validate_remote_build_identity, validate_slug,
};
use crate::db::Database;

const TEST_BUILD_COMMIT: &str = "4e8002d08a56afc08be335d0d5ed337c7690f9af";

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

fn test_checksums(binary: &[u8], identity: &str) -> String {
    format!(
        "{}  kixdns\n{}  upstream.lock.json\n{}  KIXDNS_BUILD_COMMIT\n",
        sha256(binary),
        sha256(identity.as_bytes()),
        sha256(TEST_BUILD_COMMIT.as_bytes())
    )
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
        control_protocol: Some(1),
        config_capabilities: Vec::new(),
        binary_sha256: sha256(binary),
        installed_at: 42,
    }
}

#[test]
fn validates_fixed_update_coordinates_and_digests() {
    assert!(validate_slug("tuoro/kixdns-panel", true).is_ok());
    assert!(validate_slug("https://evil.invalid", true).is_err());
    assert!(validate_slug("build-kixdns.yml", false).is_ok());
    assert!(validate_slug("../../workflow", false).is_err());
    assert!(validate_slug("..", false).is_err());
    assert!(validate_slug("owner/..", true).is_err());
    assert!(validate_digest(&format!("sha256:{}", "a".repeat(64))).is_ok());
    assert!(validate_digest("sha256:bad").is_err());
    assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
    assert!(validate_commit("not-a-commit").is_err());
    let tracked = VersionKey::tracked(
        VersionSource::Action,
        42,
        "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
    )
    .unwrap();
    assert_eq!(VersionKey::parse(&tracked.encoded()).unwrap(), tracked);
    assert!(matches!(
        parse_artifact_reference(
            "kixdns-enhanced-linux-x86_64",
            VersionSource::Action,
            "kixdns-enhanced-action-30235703570-linux-x86_64"
        ),
        Some(ParsedArtifactReference {
            reference: TrackReference::Action(30_235_703_570),
            patchset: None,
        })
    ));
    assert!(matches!(
        parse_artifact_reference(
            "kixdns-enhanced-linux-x86_64",
            VersionSource::Release,
            "kixdns-enhanced-release-v0.1.1-linux-x86_64"
        ),
        Some(ParsedArtifactReference {
            reference: TrackReference::Release(tag),
            patchset: None,
        }) if tag == "v0.1.1"
    ));
    assert!(matches!(
        parse_artifact_reference(
            "kixdns-enhanced-linux-x86_64",
            VersionSource::Action,
            "kixdns-enhanced-action-30235703570-p5-44e7e6b02316-linux-x86_64"
        ),
        Some(ParsedArtifactReference {
            reference: TrackReference::Action(30_235_703_570),
            patchset: Some(5),
        })
    ));
    assert!(
        parse_artifact_reference(
            "kixdns-enhanced-linux-x86_64",
            VersionSource::Release,
            "kixdns-enhanced-release-../../bad-linux-x86_64"
        )
        .is_none()
    );
}

#[test]
fn serializes_remote_artifact_identity() {
    let artifact_digest = format!("sha256:{}", "a".repeat(64));
    let remote = RemoteVersion {
        source: VersionSource::Action,
        source_id: 42,
        commit: "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned(),
        run_id: Some(42),
        release_tag: None,
        patchset: None,
        created_at: "2026-07-28T00:00:00Z".to_owned(),
        source_url: "https://github.com/olicesx/kixdns/actions/runs/42".to_owned(),
        build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned(),
        artifact: "kixdns-enhanced-action-42-linux-x86_64".to_owned(),
        artifact_digest: artifact_digest.clone(),
        download_url: "https://nightly.link/example/actions/runs/42/artifact.zip".to_owned(),
        installed: false,
        active: false,
    };

    let serialized = serde_json::to_value(remote).unwrap();
    assert_eq!(serialized["artifact_digest"], artifact_digest);
}

#[test]
fn notifies_only_for_newer_panel_release_with_matching_asset() {
    let no_release = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, None).unwrap();
    assert!(!no_release.available);
    assert!(no_release.latest_version.is_none());

    let release = |tag: &str, asset_name: &str| GithubRelease {
        tag_name: tag.to_owned(),
        published_at: Some("2026-07-30T00:00:00Z".to_owned()),
        assets: vec![ReleaseAsset {
            name: asset_name.to_owned(),
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        }],
    };
    let same = release("v1.0.0", panel_release_asset_name());
    assert!(
        !to_panel_update_notice(None, Some("v1.0.0"), Some(&same))
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

    let wrong_asset = release("v1.0.1", "kixdns-panel-windows.zip");
    assert!(
        !to_panel_update_notice(None, None, Some(&wrong_asset))
            .unwrap()
            .available
    );

    let newer = release("v1.0.1", panel_release_asset_name());
    let notice = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&newer)).unwrap();
    assert!(notice.available);
    assert_eq!(notice.current_version, "1.0.0");
    assert_eq!(notice.latest_version.as_deref(), Some("1.0.1"));
    assert_eq!(
        notice.download_url.as_deref(),
        Some(
            format!(
                "https://github.com/tuoro/kixdns-panel/releases/download/v1.0.1/{}",
                panel_release_asset_name()
            )
            .as_str()
        )
    );
}

#[test]
fn legacy_kixdns_identity_is_not_treated_as_exact_build() {
    let remote = RemoteVersion {
        source: VersionSource::Action,
        source_id: 42,
        commit: TEST_BUILD_COMMIT.to_owned(),
        run_id: Some(7),
        release_tag: None,
        patchset: Some(5),
        created_at: "2026-07-30T00:00:00Z".to_owned(),
        source_url: "https://github.com/olicesx/kixdns/actions/runs/7".to_owned(),
        build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/8".to_owned(),
        artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
        artifact_digest: format!("sha256:{}", "a".repeat(64)),
        download_url: "https://nightly.link/example.zip".to_owned(),
        installed: false,
        active: false,
    };
    let legacy = VersionKey::new(VersionSource::Action, TEST_BUILD_COMMIT).unwrap();
    assert!(to_kixdns_update_notice(&remote, Some(&legacy)).available);

    let exact = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();
    assert!(!to_kixdns_update_notice(&remote, Some(&exact)).available);
}

#[test]
fn extracts_only_checksum_verified_binary() {
    let binary = b"test-binary";
    let checksum = test_checksums(binary, TEST_IDENTITY);
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("kixdns", options).unwrap();
    writer.write_all(binary).unwrap();
    writer.start_file("SHA256SUMS", options).unwrap();
    writer.write_all(checksum.as_bytes()).unwrap();
    writer.start_file("upstream.lock.json", options).unwrap();
    writer.write_all(TEST_IDENTITY.as_bytes()).unwrap();
    writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
    writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
    let archive = writer.finish().unwrap().into_inner();

    let extracted = extract_artifact(&archive).unwrap();
    assert_eq!(extracted.binary, binary);
    assert_eq!(extracted.identity.patchset, 5);
    assert_eq!(extracted.build_commit, TEST_BUILD_COMMIT);
    assert!(extracted.config_capabilities.is_empty());

    let wrong_checksum = checksum.replace(&sha256(binary), &"0".repeat(64));
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer.start_file("kixdns", options).unwrap();
    writer.write_all(binary).unwrap();
    writer.start_file("SHA256SUMS", options).unwrap();
    writer.write_all(wrong_checksum.as_bytes()).unwrap();
    writer.start_file("upstream.lock.json", options).unwrap();
    writer.write_all(TEST_IDENTITY.as_bytes()).unwrap();
    writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
    writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
    let tampered = writer.finish().unwrap().into_inner();
    assert!(extract_artifact(&tampered).is_err());
}

#[test]
fn extracts_checksum_verified_config_capabilities() {
    let binary = b"test-binary";
    let capabilities = br#"{"schema_version":1,"config_capabilities":["config_query_stats_v1"]}"#;
    let checksum = format!(
        "{}  kixdns\n{}  upstream.lock.json\n{}  KIXDNS_CAPABILITIES.json\n{}  KIXDNS_BUILD_COMMIT\n",
        sha256(binary),
        sha256(TEST_IDENTITY.as_bytes()),
        sha256(capabilities),
        sha256(TEST_BUILD_COMMIT.as_bytes())
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("kixdns", options).unwrap();
    writer.write_all(binary).unwrap();
    writer.start_file("SHA256SUMS", options).unwrap();
    writer.write_all(checksum.as_bytes()).unwrap();
    writer.start_file("upstream.lock.json", options).unwrap();
    writer.write_all(TEST_IDENTITY.as_bytes()).unwrap();
    writer
        .start_file("KIXDNS_CAPABILITIES.json", options)
        .unwrap();
    writer.write_all(capabilities).unwrap();
    writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
    writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
    let archive = writer.finish().unwrap().into_inner();

    let extracted = extract_artifact(&archive).unwrap();
    assert_eq!(extracted.config_capabilities, vec!["config_query_stats_v1"]);
}

#[test]
fn rejects_incompatible_control_protocol() {
    let binary = b"test-binary";
    let incompatible = TEST_IDENTITY.replace("\"control_protocol\":1", "\"control_protocol\":2");
    let checksum = test_checksums(binary, &incompatible);
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("kixdns", options).unwrap();
    writer.write_all(binary).unwrap();
    writer.start_file("SHA256SUMS", options).unwrap();
    writer.write_all(checksum.as_bytes()).unwrap();
    writer.start_file("upstream.lock.json", options).unwrap();
    writer.write_all(incompatible.as_bytes()).unwrap();
    writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
    writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
    let archive = writer.finish().unwrap().into_inner();

    assert!(extract_artifact(&archive).is_err());
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
fn deletes_only_verified_local_version_directories() {
    let directory = tempdir().unwrap();
    let binary = test_elf();
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    store_version(
        directory.path(),
        &test_manifest(42, commit, &binary),
        &binary,
    )
    .unwrap();

    let deleted = delete_stored_version(directory.path(), &key).unwrap();

    assert_eq!(deleted.source_id, Some(42));
    assert!(!deleted.active);
    assert!(!directory.path().join(key.directory_name()).exists());

    std::fs::write(
        directory.path().join(key.directory_name()),
        b"not-a-directory",
    )
    .unwrap();
    assert!(matches!(
        delete_stored_version(directory.path(), &key),
        Err(UpdateError::Verification(_))
    ));
    assert!(directory.path().join(key.directory_name()).is_file());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_version_directory_when_deleting() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    symlink(outside.path(), directory.path().join(key.directory_name())).unwrap();

    assert!(matches!(
        delete_stored_version(directory.path(), &key),
        Err(UpdateError::Verification(_))
    ));
    assert!(outside.path().is_dir());
}

#[tokio::test]
async fn treats_empty_panel_release_as_unset() {
    let directory = tempdir().unwrap();
    let manager = UpdateManager::new(
        Database::open(directory.path().join("panel.db"))
            .await
            .unwrap(),
        UpdateSettings {
            repository: "tuoro/kixdns-panel".to_owned(),
            workflow: "build-kixdns.yml".to_owned(),
            release_workflow: "build-kixdns-release.yml".to_owned(),
            branch: "main".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            installed_commit: None,
            panel_installed_commit: None,
            panel_installed_release: Some(String::new()),
            management_enabled: true,
            binary_path: directory.path().join("bin/kixdns"),
            versions_path: directory.path().join("versions"),
        },
    )
    .unwrap();

    assert!(manager.panel_release.is_none());
}

#[tokio::test]
async fn refuses_to_delete_the_active_version() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let binary_path = directory.path().join("bin/kixdns");
    let versions_path = directory.path().join("versions");
    let manager = UpdateManager::new(
        database.clone(),
        UpdateSettings {
            repository: "tuoro/kixdns-panel".to_owned(),
            workflow: "build-kixdns.yml".to_owned(),
            release_workflow: "build-kixdns-release.yml".to_owned(),
            branch: "main".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            installed_commit: None,
            panel_installed_commit: None,
            panel_installed_release: None,
            management_enabled: true,
            binary_path: binary_path.clone(),
            versions_path: versions_path.clone(),
        },
    )
    .unwrap();
    let binary = test_elf();
    let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
    let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
    std::fs::write(binary_path, &binary).unwrap();
    store_version(&versions_path, &test_manifest(42, commit, &binary), &binary).unwrap();
    database
        .set_setting(super::ACTIVE_VERSION_KEY, key.encoded(), 42)
        .await
        .unwrap();

    let error = manager
        .delete_version(VersionSource::Action, "42")
        .await
        .unwrap_err();

    assert!(matches!(error, UpdateError::Invalid(_)));
    assert!(versions_path.join(key.directory_name()).is_dir());
}

#[tokio::test]
async fn external_mode_never_manages_kixdns_versions() {
    let directory = tempdir().unwrap();
    let binary_path = directory.path().join("bin/kixdns");
    std::fs::create_dir_all(binary_path.parent().unwrap()).unwrap();
    std::fs::write(&binary_path, test_elf()).unwrap();
    let manager = UpdateManager::new(
        Database::open(directory.path().join("panel.db"))
            .await
            .unwrap(),
        UpdateSettings {
            repository: "tuoro/kixdns-panel".to_owned(),
            workflow: "build-kixdns.yml".to_owned(),
            release_workflow: "build-kixdns-release.yml".to_owned(),
            branch: "main".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            installed_commit: None,
            panel_installed_commit: None,
            panel_installed_release: None,
            management_enabled: false,
            binary_path,
            versions_path: directory.path().join("versions"),
        },
    )
    .unwrap();

    let catalog = manager.catalog(VersionSource::Release).await.unwrap();
    assert!(!catalog.management_enabled);
    assert!(catalog.binary_present);
    assert!(catalog.remote_versions.is_empty());
    assert!(catalog.installed_versions.is_empty());
    assert!(matches!(
        manager
            .delete_version(VersionSource::Action, TEST_BUILD_COMMIT)
            .await,
        Err(UpdateError::Invalid(message)) if message.contains("外部 KixDNS")
    ));
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

    store_version(directory.path(), &action, &binary).unwrap();
    store_version(directory.path(), &release, &binary).unwrap();
    store_version(directory.path(), &previous_action, &binary).unwrap();

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
}

#[test]
fn verifies_package_identity_against_selected_track() {
    let identity = serde_json::from_str::<BuildIdentity>(TEST_IDENTITY).unwrap();
    let remote = RemoteVersion {
        source: VersionSource::Action,
        source_id: 99,
        commit: TEST_BUILD_COMMIT.to_owned(),
        run_id: Some(30_235_703_570),
        release_tag: None,
        patchset: Some(5),
        created_at: "2026-07-28T00:00:00Z".to_owned(),
        source_url: "https://github.com/olicesx/kixdns/actions/runs/30235703570".to_owned(),
        build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned(),
        artifact: "kixdns-enhanced-action-30235703570-linux-x86_64".to_owned(),
        artifact_digest: format!("sha256:{}", "a".repeat(64)),
        download_url: "https://nightly.link/example/artifact.zip".to_owned(),
        installed: false,
        active: false,
    };
    assert!(validate_remote_build_identity(&remote, &identity).is_ok());
    let mut wrong_track = remote;
    wrong_track.source = VersionSource::Release;
    wrong_track.run_id = None;
    wrong_track.release_tag = Some("v0.1.1".to_owned());
    assert!(validate_remote_build_identity(&wrong_track, &identity).is_err());
}
