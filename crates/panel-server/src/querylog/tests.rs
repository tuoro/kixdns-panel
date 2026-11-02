use std::collections::HashSet;

use serde_json::{Map, Value, json};
use tempfile::tempdir;

use super::{
    Cursor, Filter, HOUR_MS, KernelEntry, MIB, PageQuery, QueryLogSettings, QueryLogStore, Record,
    RuleFilter, RuleIndex, StaticKind, static_kind_from_answer,
};

/// 2026-10-15 12:00 UTC 整点 / 2026-10-15 12:00 UTC on the hour
const NOON: u64 = 1_792_065_600_000;
const INSTANCE: u64 = 7;

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("not an object"),
    }
}

/// 一条内核记录：转发给上游的普通查询 / One kernel record: an ordinary forwarded query
fn entry(seq: u64, time: u64, qname: &str, client: &str) -> Map<String, Value> {
    object(json!({
        "seq": seq, "time_unix_ms": time, "client": client, "transport": "udp", "qname": qname,
        "qtype": "A", "latency_us": 900, "status": "completed", "outcome": "forwarded", "rcode": "NOERROR",
        "answers": ["93.184.215.14"], "pipeline": "main", "rule": "forward-all", "upstream": "1.1.1.1:53",
        "steps": [
            {"at_us": 1, "kind": "pipeline", "pipeline": "main"},
            {"at_us": 2, "kind": "rule", "pipeline": "main", "rule": "forward-all", "phase": "request",
             "decision": "forward", "target": "1.1.1.1:53"},
            {"at_us": 3, "kind": "upstream", "upstream": "1.1.1.1:53", "transport": "udp", "via": "udp",
             "result": "success", "latency_us": 800, "rcode": "NOERROR"},
        ],
    }))
}

fn record(seq: u64, time: u64, qname: &str) -> Record {
    Record::Entry {
        instance: INSTANCE,
        entry: KernelEntry::from_map(entry(seq, time, qname, "192.168.1.9")),
        static_kind: None,
    }
}

fn settings() -> QueryLogSettings {
    QueryLogSettings::default()
}

fn everything() -> PageQuery {
    PageQuery {
        filter: Filter::default(),
        before: None,
        after: None,
        limit: 500,
        cutoff_ms: 0,
    }
}

fn ids(page: &super::Page) -> Vec<u64> {
    page.items
        .iter()
        .map(|item| item["id"].as_u64().unwrap())
        .collect()
}

#[test]
fn reads_newest_first_with_panel_ids_and_resumes_after_reopening() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(
            &[
                record(41, NOON, "a.example"),
                record(42, NOON + 1, "b.example"),
            ],
            &settings(),
            NOON + 5,
        )
        .unwrap();
    store
        .append(&[record(43, NOON + 2, "c.example")], &settings(), NOON + 10)
        .unwrap();

    let page = store.read_page(&everything());
    assert_eq!(ids(&page), [3, 2, 1]);
    assert_eq!(page.items[0]["qname"], "c.example");
    assert_eq!(page.items[0]["seq"], 43, "the kernel's fields are kept");
    assert!(
        page.items[0].get("instance").is_none(),
        "internal fields stay inside"
    );
    assert_eq!(page.newest_id, Some(3));
    assert_eq!(page.next_before, None);
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 43
        })
    );

    // 写到一半断了电，最后一块只写下一半（块头说有 36 字节，后面只有 2 个）。重新打开时这段照样读到写完的那页，
    // 不再接着写；编号和游标接着上次
    // A power loss mid-write left half a block (its header promises 36 bytes and only 2 follow). On reopening the
    // segment still reads up to its last whole page and is not continued; ids and the cursor carry on
    drop(store);
    let segment = segment_files(&root).remove(0);
    let mut bytes = std::fs::read(&segment).unwrap();
    bytes.extend_from_slice(&[0x25, 0x01, 0x00, b'{', b'"']);
    std::fs::write(&segment, bytes).unwrap();
    let store = QueryLogStore::open(root.clone()).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 43
        })
    );
    assert_eq!(ids(&store.read_page(&everything())), [3, 2, 1]);
    store
        .append(&[record(44, NOON + 3, "d.example")], &settings(), NOON + 20)
        .unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [4, 3, 2, 1]);
    assert_eq!(
        segment_files(&root).len(),
        2,
        "the cut-off segment is not continued"
    );
}

/// 一个 zstd 段的帧：收尾了几帧，后面还有没有没收尾的 / A zstd segment's frames: how many are finished, and whether an
/// unfinished one follows
fn frames(path: &std::path::Path) -> (usize, bool) {
    let bytes = std::fs::read(path).unwrap();
    let mut start = 0;
    let mut finished = 0;
    while start < bytes.len() {
        match zstd::zstd_safe::find_frame_compressed_size(&bytes[start..]) {
            Ok(length) if length > 0 => {
                finished += 1;
                start += length;
            }
            _ => return (finished, true),
        }
    }
    (finished, false)
}

#[test]
fn a_new_hour_opens_a_new_segment_and_closes_the_old_one() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    for (index, at) in [
        NOON + 1_000,
        NOON + HOUR_MS + 1_000,
        NOON + 2 * HOUR_MS + 1_000,
    ]
    .into_iter()
    .enumerate()
    {
        let seq = index as u64 + 1;
        store
            .append(&[record(seq, at, "x.example")], &settings(), at)
            .unwrap();
        store.maintain(&settings(), at).unwrap();
    }
    let files = segment_files(&root);
    assert_eq!(files.len(), 3);
    assert!(
        files
            .iter()
            .all(|file| file.to_string_lossy().ends_with(".jsonl.zst")),
        "{files:?}"
    );
    assert_eq!(frames(&files[0]), (1, false), "a closed hour is finished");
    assert_eq!(frames(&files[1]), (1, false));
    assert_eq!(
        frames(&files[2]),
        (0, true),
        "the hour being written is still open"
    );

    // 跨段往前翻 / Paging back across segments
    let page = store.read_page(&PageQuery {
        limit: 1,
        ..everything()
    });
    assert_eq!(ids(&page), [3]);
    assert_eq!(page.next_before, Some(3));
    let page = store.read_page(&PageQuery {
        limit: 1,
        before: Some(3),
        ..everything()
    });
    assert_eq!(ids(&page), [2]);
    let page = store.read_page(&PageQuery {
        limit: 5,
        before: Some(2),
        ..everything()
    });
    assert_eq!(ids(&page), [1]);
    assert_eq!(page.next_before, None);

    // 重新打开：每段照样读，游标来自最新一段 / Reopened: every segment still reads, the cursor comes from the newest
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [3, 2, 1]);
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 3
        })
    );
}

/// 旧版写下的一行记录 / One record line as an older version wrote it
fn older_line(id: u64, time: u64) -> String {
    format!(
        "{{\"id\":{id},\"instance\":7,\"seq\":{id},\"time_unix_ms\":{time},\"qname\":\"old.example\"}}\n"
    )
}

#[test]
fn an_older_versions_plain_segment_is_compressed_and_a_crash_mid_way_keeps_one_copy() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    std::fs::create_dir_all(&root).unwrap();
    // 旧版正在写的那段：纯文本，最后断电留下半行 / An older version's segment being written: plain text, ending in half a
    // line from a power loss
    let plain = root.join(format!("{NOON:013}-{:016}.jsonl", 1));
    let zst = root.join(format!("{NOON:013}-{:016}.jsonl.zst", 1));
    let text = format!(
        "{}{}{{\"id\":3,\"inst",
        older_line(1, NOON),
        older_line(2, NOON + 1)
    );
    std::fs::write(&plain, &text).unwrap();
    let store = QueryLogStore::open(root.clone()).unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [2, 1]);
    store.maintain(&settings(), NOON).unwrap();
    assert!(zst.exists() && !plain.exists());
    assert_eq!(frames(&zst), (1, false));
    assert_eq!(ids(&store.read_page(&everything())), [2, 1]);
    store
        .append(&[record(3, NOON + 2, "new.example")], &settings(), NOON + 2)
        .unwrap();
    assert_eq!(
        ids(&store.read_page(&everything())),
        [3, 2, 1],
        "new records go to a segment of their own"
    );
    drop(store);

    // 压好了、纯文本还没删，旁边还有一个半截的临时文件 / Compressed, the plain copy not yet removed, and a half-written temporary file
    std::fs::write(&plain, &text).unwrap();
    std::fs::write(root.join("x.jsonl.zst.tmp"), b"half").unwrap();
    let store = QueryLogStore::open(root.clone()).unwrap();
    assert!(!plain.exists() && zst.exists());
    assert!(!root.join("x.jsonl.zst.tmp").exists());
    assert_eq!(ids(&store.read_page(&everything())), [3, 2, 1]);
}

#[test]
fn an_older_versions_gzip_segment_still_reads() {
    use std::io::Write as _;
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    std::fs::create_dir_all(&root).unwrap();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(format!("{}{}", older_line(1, NOON), older_line(2, NOON + 1)).as_bytes())
        .unwrap();
    std::fs::write(
        root.join(format!("{NOON:013}-{:016}.jsonl.gz", 1)),
        encoder.finish().unwrap(),
    )
    .unwrap();
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [2, 1]);
    store
        .append(&[record(3, NOON + 2, "new.example")], &settings(), NOON + 2)
        .unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [3, 2, 1]);
}

#[test]
fn retention_drops_old_segments_and_hides_old_records() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let six_hours = QueryLogSettings {
        retention_hours: 6,
        ..settings()
    };
    for hour in 0..10 {
        let at = NOON + hour * HOUR_MS + 1_000;
        store
            .append(&[record(hour + 1, at, "x.example")], &six_hours, at)
            .unwrap();
        store.maintain(&six_hours, at).unwrap();
    }
    let now = NOON + 9 * HOUR_MS + 1_000;
    let cutoff = now - 6 * HOUR_MS;
    // 第 0–2 小时那几段的下一段都开在截止之前，删掉 / The segments for hours 0–2 have a successor opened before the cutoff: dropped
    assert_eq!(
        store.usage().oldest_start_ms,
        Some(NOON + 3 * HOUR_MS + 1_000)
    );
    let page = store.read_page(&PageQuery {
        cutoff_ms: cutoff,
        ..everything()
    });
    assert_eq!(ids(&page), [10, 9, 8, 7, 6, 5, 4]);
    let later = store.read_page(&PageQuery {
        cutoff_ms: cutoff + 30 * 60 * 1_000,
        ..everything()
    });
    assert_eq!(
        ids(&later),
        [10, 9, 8, 7, 6, 5],
        "records before the cutoff are hidden"
    );
}

#[test]
fn the_space_cap_drops_the_oldest_and_ids_and_cursor_survive_an_empty_store() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    // 比页面允许的最小值还小，测试才不用写几十 MB / Smaller than the page allows, so the test need not write tens of MB
    let small = QueryLogSettings {
        max_bytes: 300 * 1024,
        ..settings()
    };
    let mut seq = 0;
    for hour in 0..5 {
        let at = NOON + hour * HOUR_MS + 1_000;
        let batch: Vec<Record> = (0..2)
            .map(|_| {
                seq += 1;
                let mut entry = entry(seq, at, "x.example", "192.168.1.9");
                // 十六进制压一半：每段纯文本约 200 KB，压缩后约 100 KB / Hex halves when compressed: about 200 KB plain per
                // segment, about 100 KB compressed
                entry.insert(
                    "error".to_owned(),
                    Value::String(pseudo_random(seq, 100_000)),
                );
                Record::Entry {
                    instance: INSTANCE,
                    entry: KernelEntry::from_map(entry),
                    static_kind: None,
                }
            })
            .collect();
        store.append(&batch, &small, at).unwrap();
        store.maintain(&small, at).unwrap();
        assert!(
            store.usage().bytes <= small.max_bytes,
            "hour {hour}: {}",
            store.usage().bytes
        );
    }
    let kept = ids(&store.read_page(&everything()));
    assert_eq!(kept.first(), Some(&10), "the newest survive");
    assert!(!kept.contains(&1), "the oldest went: {kept:?}");

    store.clear().unwrap();
    assert_eq!(store.usage().bytes, 0);
    assert!(store.read_page(&everything()).items.is_empty());
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 10
        }),
        "nothing is taken twice"
    );
    store
        .append(&[record(11, NOON, "y.example")], &small, NOON + 5 * HOUR_MS)
        .unwrap();
    assert_eq!(
        ids(&store.read_page(&everything())),
        [11],
        "ids keep counting"
    );
}

/// 压不小的十六进制串 / A hex string that does not compress much
fn pseudo_random(seed: u64, length: usize) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    let bytes = (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            DIGITS[(state & 0xf) as usize]
        })
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn gaps_show_without_filters_and_carry_their_count() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    store
        .append(&[record(1, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    store
        .append(
            &[
                Record::Gap {
                    instance: INSTANCE,
                    seq: 38,
                    time_unix_ms: NOON + 5,
                    count: 37,
                },
                record(39, NOON + 6, "b.example"),
            ],
            &settings(),
            NOON + 10,
        )
        .unwrap();
    let page = store.read_page(&everything());
    assert_eq!(
        page.items[1],
        json!({"id": 2, "time_unix_ms": NOON + 5, "gap": 37})
    );
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 39
        })
    );
    let filtered = store.read_page(&PageQuery {
        filter: Filter {
            q: Some("example".to_owned()),
            ..Filter::default()
        },
        ..everything()
    });
    assert_eq!(ids(&filtered), [3, 1], "a filtered list has no gap rows");
}

fn filtered(store: &QueryLogStore, filter: Filter) -> Vec<u64> {
    ids(&store.read_page(&PageQuery {
        filter,
        ..everything()
    }))
}

/// 三条查询和一行漏记：普通转发、被拆开的规则拦下的、问过两个上游又过了两道回答后检查的
/// Three queries and a gap row: an ordinary forward, one blocked by a split rule, one that asked two upstreams and
/// passed two answer checks
fn filter_fixture() -> (tempfile::TempDir, QueryLogStore) {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let mut blocked = entry(2, NOON, "Ads.Example", "192.168.1.20");
    blocked.insert("outcome".to_owned(), "static".into());
    blocked.insert(
        "steps".to_owned(),
        json!([{"at_us": 1, "kind": "rule", "pipeline": "main", "rule": "ads#2", "phase": "request", "decision": "static"}]),
    );
    let mut checked = entry(3, NOON, "cdn.example", "2001:db8::1");
    checked.insert("pipeline".to_owned(), "abroad".into());
    checked.insert(
        "steps".to_owned(),
        json!([
            {"at_us": 1, "kind": "upstream", "upstream": "8.8.8.8:53", "transport": "udp", "via": "udp", "result": "aborted", "latency_us": 5},
            {"at_us": 2, "kind": "upstream", "upstream": "1.1.1.1:53", "transport": "udp", "via": "udp", "result": "success", "latency_us": 9},
            {"at_us": 3, "kind": "rule", "pipeline": "abroad", "rule": "poisoned", "phase": "response", "matched": false},
            {"at_us": 4, "kind": "rule", "pipeline": "abroad", "rule": "cdn-check", "phase": "response", "matched": true, "decision": "jump"},
        ]),
    );
    let records = [
        record(1, NOON, "a.example"),
        Record::Entry {
            instance: INSTANCE,
            entry: KernelEntry::from_map(blocked),
            static_kind: Some(StaticKind::Blocked),
        },
        Record::Entry {
            instance: INSTANCE,
            entry: KernelEntry::from_map(checked),
            static_kind: None,
        },
        Record::Gap {
            instance: INSTANCE,
            seq: 9,
            time_unix_ms: NOON,
            count: 5,
        },
    ];
    store.append(&records, &settings(), NOON).unwrap();
    (directory, store)
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn text_and_outcome_filters_match_like_the_page_describes() {
    let (_directory, store) = filter_fixture();
    let only = |filter: Filter| filtered(&store, filter);
    let q = |text: &str| Filter {
        q: Some(text.to_owned()),
        ..Filter::default()
    };
    assert_eq!(only(q("ads.ex")), [2], "case-insensitive domain");
    assert_eq!(only(q("db8")), [3], "or the client");
    assert_eq!(
        only(Filter {
            pipelines: Some(set(&["abroad"])),
            ..Filter::default()
        }),
        [3]
    );
    assert_eq!(
        only(Filter {
            outcomes: Some(set(&["blocked"])),
            ..Filter::default()
        }),
        [2]
    );
    assert_eq!(
        only(Filter {
            outcomes: Some(set(&["forwarded"])),
            ..Filter::default()
        }),
        [3, 1]
    );
    let client = |address: &str| Filter {
        client: Some(address.to_owned()),
        ..Filter::default()
    };
    assert!(only(client("192.168.1.2")).is_empty(), "exact client");
    assert_eq!(only(client("192.168.1.20")), [2]);

    let page = store.read_page(&everything());
    assert_eq!(
        page.items[2]["outcome"], "blocked",
        "static is told apart for the page"
    );
}

#[test]
fn a_servfail_block_whose_rule_was_not_recognised_still_files_under_blocked() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let failed = |seq: u64, error: Option<&str>| {
        let mut entry = entry(seq, NOON, "ads.example", "192.168.1.20");
        entry.insert("outcome".to_owned(), "failed".into());
        entry.insert("rcode".to_owned(), "SERVFAIL".into());
        entry.insert("answers".to_owned(), json!([]));
        entry.insert(
            "steps".to_owned(),
            json!([{"at_us": 1, "kind": "rule", "pipeline": "main", "rule": "ads", "phase": "request", "decision": "static"}]),
        );
        if let Some(error) = error {
            entry.insert("error".to_owned(), error.into());
        }
        Record::Entry {
            instance: INSTANCE,
            entry: KernelEntry::from_map(entry),
            static_kind: None,
        }
    };
    // 写入时认不出规则（static_kind 为空）的拦截，和 KixDNS 自己出错的一条 / A block whose rule was not recognised when
    // written (no static_kind), and one that is KixDNS's own failure
    store
        .append(
            &[failed(1, None), failed(2, Some("engine failed"))],
            &settings(),
            NOON,
        )
        .unwrap();
    let only = |outcome: &str| {
        filtered(
            &store,
            Filter {
                outcomes: Some(set(&[outcome])),
                ..Filter::default()
            },
        )
    };
    assert_eq!(only("blocked"), [1]);
    assert_eq!(only("failed"), [2], "KixDNS's own failure stays failed");
    let page = store.read_page(&everything());
    assert_eq!(
        page.items[1]["outcome"], "blocked",
        "the page sees what the filter files"
    );
}

#[test]
fn rule_and_upstream_filters_match_the_hit_counts() {
    let (_directory, store) = filter_fixture();
    let only = |filter: Filter| filtered(&store, filter);
    let rule = |name: &str, pipeline: Option<&str>, response: bool| Filter {
        rule: Some(RuleFilter {
            name: name.to_owned(),
            pipeline: pipeline.map(str::to_owned),
            response,
        }),
        ..Filter::default()
    };
    assert_eq!(
        only(rule("ads", None, false)),
        [2],
        "split rules count as one"
    );
    assert!(only(rule("ads", Some("other"), false)).is_empty());
    assert_eq!(only(rule("cdn-check", Some("abroad"), true)), [3]);
    assert!(
        only(rule("poisoned", None, true)).is_empty(),
        "an unmatched check is no hit"
    );
    assert!(
        only(rule("cdn-check", None, false)).is_empty(),
        "phases are kept apart"
    );
    let upstream = Filter {
        upstream: Some("8.8.8.8:53".to_owned()),
        ..Filter::default()
    };
    assert_eq!(only(upstream), [3], "asked, even if it lost");
}

#[test]
fn a_full_page_hands_back_where_to_continue_and_a_budget_stops_short() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let batch: Vec<Record> = (1..=30)
        .map(|seq| {
            record(
                seq,
                NOON + seq,
                if seq % 10 == 0 {
                    "rare.example"
                } else {
                    "common.example"
                },
            )
        })
        .collect();
    store.append(&batch, &settings(), NOON + 100).unwrap();

    let rare = Filter {
        q: Some("rare".to_owned()),
        ..Filter::default()
    };
    let page = store.read_page(&PageQuery {
        filter: rare.clone(),
        limit: 2,
        ..everything()
    });
    assert_eq!(ids(&page), [30, 20]);
    assert_eq!(page.next_before, Some(20), "one more matched further back");
    let rest = store.read_page(&PageQuery {
        filter: rare.clone(),
        limit: 2,
        before: Some(20),
        ..everything()
    });
    assert_eq!(ids(&rest), [10]);
    assert_eq!(rest.next_before, None);

    // 只看 15 条就停：交回看到哪儿，下次从那里接着找 / Stopping after 15 records hands back how far it got for the next read
    let stopped = store.read_page_within(
        &PageQuery {
            filter: rare.clone(),
            limit: 5,
            ..everything()
        },
        15,
    );
    assert_eq!(ids(&stopped), [30, 20]);
    assert_eq!(stopped.next_before, Some(16));
    assert_eq!(stopped.scanned_to_unix_ms, Some(NOON + 16));
    let resumed = store.read_page_within(
        &PageQuery {
            filter: rare,
            limit: 5,
            before: Some(16),
            ..everything()
        },
        15,
    );
    assert_eq!(ids(&resumed), [10]);
    assert_eq!(
        resumed.next_before, None,
        "the budget ran out exactly at the oldest, so nothing is left to continue from"
    );
}

#[test]
fn settings_are_checked_and_tidied() {
    let tidy = QueryLogSettings {
        retention_hours: 6,
        max_bytes: 10 * MIB,
        ignored_domains: vec![
            " Ads.Example. ".to_owned(),
            "*.tracker.test".to_owned(),
            ".ads.example".to_owned(),
            String::new(),
        ],
    }
    .normalized()
    .unwrap();
    assert_eq!(tidy.ignored_domains, ["ads.example", "tracker.test"]);
    assert!(tidy.ignores("ads.example"));
    assert!(tidy.ignores("Pixel.Ads.Example."));
    assert!(!tidy.ignores("bads.example"), "whole labels only");
    assert!(!tidy.ignores("example"));

    for broken in [
        QueryLogSettings {
            retention_hours: 0,
            ..settings()
        },
        QueryLogSettings {
            retention_hours: 8_761,
            ..settings()
        },
        QueryLogSettings {
            max_bytes: 10 * MIB - 1,
            ..settings()
        },
        QueryLogSettings {
            ignored_domains: vec!["not a domain".to_owned()],
            ..settings()
        },
    ] {
        assert!(broken.normalized().is_err());
    }
}

fn decided(phase: &str, rule: &str, matched: Option<bool>) -> Map<String, Value> {
    let mut step = json!({"at_us": 1, "kind": "rule", "pipeline": "main", "rule": rule, "phase": phase, "decision": "static"});
    if let Some(matched) = matched {
        step["matched"] = matched.into();
    }
    object(json!({"outcome": "static", "rcode": "NOERROR", "answers": [], "steps": [step]}))
}

#[test]
fn the_rule_that_answered_tells_a_block_from_a_custom_answer() {
    let index = RuleIndex::from_config(&json!({
        "pipelines": [{
            "id": "main",
            "rules": [
                {"name": "deny", "actions": [{"type": "deny"}]},
                {"name": "nx", "actions": [{"type": "static_response", "rcode": "NXDOMAIN"}]},
                {"name": "zero", "actions": [{"type": "static_ip_response", "ip": "0.0.0.0,::"}]},
                {"name": "mapped", "actions": [{"type": "static_ip_response", "ip": "10.0.0.2"}]},
                {"name": "alias", "actions": [{"type": "static_cname_response", "target": "cdn.example."}]},
                {"name": "empty", "actions": [{"type": "static_response", "rcode": "NOERROR"}]},
                {"name": "servfail", "actions": [{"type": "static_response", "rcode": "SERVFAIL"}]},
                {"name": "one-zero", "actions": [{"type": "static_ip_response", "ip": "0.0.0.0"}]},
                {"name": "dual", "actions": [{"type": "static_ip_response", "ip": "10.0.0.2,2001:db8::2"}]},
                {"name": "three-zero", "actions": [{"type": "static_ip_response", "ip": "0.0.0.0,::,0.0.0.0"}]},
                {"name": "twice", "actions": [{"type": "deny"}]},
                {"name": "twice", "actions": [{"type": "static_ip_response", "ip": "10.0.0.3"}]},
                {"name": "same", "actions": [{"type": "deny"}]},
                {"name": "same", "actions": [{"type": "static_response", "rcode": "NXDOMAIN"}]},
                {"name": "check", "response_actions_on_match": [{"type": "static_ip_response", "ip": "::,0.0.0.0"}],
                 "response_actions_on_miss": [{"type": "static_txt_response", "text": "ok"}]},
            ],
        }],
    }));
    let kind = |entry: &Map<String, Value>| index.classify(entry);
    assert_eq!(
        kind(&decided("request", "deny", None)),
        Some(StaticKind::Blocked)
    );
    assert_eq!(
        kind(&decided("request", "nx", None)),
        Some(StaticKind::Blocked)
    );
    // 空地址拦截回 HTTPS 查询：NOERROR、没有记录，只看回答会当成自定义回答
    // A 空地址 block answering an HTTPS query: NOERROR with no records, which the answer alone would call a custom answer
    let https = decided("request", "zero", None);
    assert_eq!(kind(&https), Some(StaticKind::Blocked));
    assert_eq!(static_kind_from_answer(&https), StaticKind::Answered);
    assert_eq!(
        kind(&decided("request", "mapped", None)),
        Some(StaticKind::Answered)
    );
    assert_eq!(
        kind(&decided("request", "alias", None)),
        Some(StaticKind::Answered)
    );
    // 面板的「空回答」「SERVFAIL」都写成 static_response；只写一个 0.0.0.0 是自定义回答，和读入配置时一样
    // The panel writes 「空回答」 and 「SERVFAIL」 as static_response; a lone 0.0.0.0 is a custom answer, as when a
    // config is read in
    assert_eq!(
        kind(&decided("request", "empty", None)),
        Some(StaticKind::Blocked)
    );
    assert_eq!(
        kind(&decided("request", "servfail", None)),
        Some(StaticKind::Blocked)
    );
    assert_eq!(
        kind(&decided("request", "one-zero", None)),
        Some(StaticKind::Answered)
    );
    assert_eq!(
        kind(&decided("request", "dual", None)),
        Some(StaticKind::Answered)
    );
    assert_eq!(
        kind(&decided("request", "three-zero", None)),
        Some(StaticKind::Answered),
        "only exactly 0.0.0.0 and :: is 空地址"
    );
    // 同名的两条回答不一样就分不清，一样就无所谓 / Two same-named rules answering differently cannot be told apart; alike, they can
    assert_eq!(kind(&decided("request", "twice", None)), None);
    assert_eq!(
        kind(&decided("request", "same", None)),
        Some(StaticKind::Blocked)
    );
    assert_eq!(
        kind(&decided("response", "check", Some(true))),
        Some(StaticKind::Blocked)
    );
    assert_eq!(
        kind(&decided("response", "check", Some(false))),
        Some(StaticKind::Answered)
    );
    assert_eq!(kind(&decided("request", "missing", None)), None);

    // 单记的决定往前找这条规则检查的结果 / A decision recorded on its own looks back for the rule's check result
    let on_its_own = object(json!({"outcome": "static", "steps": [
        {"at_us": 1, "kind": "rule", "pipeline": "main", "rule": "check", "phase": "response", "matched": false},
        {"at_us": 2, "kind": "decision", "pipeline": "main", "rule": "check", "phase": "response", "decision": "static"},
    ]}));
    assert_eq!(kind(&on_its_own), Some(StaticKind::Answered));
}

#[test]
fn without_the_rule_the_answer_decides() {
    let answer = |rcode: &str, answers: Value| {
        object(json!({"outcome": "static", "rcode": rcode, "answers": answers}))
    };
    assert_eq!(
        static_kind_from_answer(&answer("REFUSED", json!([]))),
        StaticKind::Blocked
    );
    assert_eq!(
        static_kind_from_answer(&answer("NXDOMAIN", json!([]))),
        StaticKind::Blocked
    );
    assert_eq!(
        static_kind_from_answer(&answer("NOERROR", json!(["0.0.0.0", "::"]))),
        StaticKind::Blocked
    );
    assert_eq!(
        static_kind_from_answer(&answer("NOERROR", json!(["10.0.0.2"]))),
        StaticKind::Answered
    );
    assert_eq!(
        static_kind_from_answer(&answer("NOERROR", json!([]))),
        StaticKind::Answered
    );
}

fn segment_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|item| item.unwrap().path())
        .filter(|path| {
            let name = path.to_string_lossy();
            name.contains(".jsonl") && !name.ends_with(".tmp")
        })
        .collect();
    files.sort();
    files
}

#[test]
fn reopening_follows_ids_even_when_the_clock_stepped_back() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    let later = NOON + 10 * HOUR_MS;
    store
        .append(
            &[record(1, later, "a.example"), record(2, later, "b.example")],
            &settings(),
            later,
        )
        .unwrap();
    // 时钟往回调了十个小时 / The clock stepped back ten hours
    store
        .append(
            &[record(3, NOON, "c.example"), record(4, NOON, "d.example")],
            &settings(),
            NOON,
        )
        .unwrap();
    drop(store);

    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 4
        })
    );
    assert_eq!(ids(&store.read_page(&everything())), [4, 3, 2, 1]);
    store
        .append(&[record(5, NOON + 1, "e.example")], &settings(), NOON + 1)
        .unwrap();
    assert_eq!(
        ids(&store.read_page(&everything())),
        [5, 4, 3, 2, 1],
        "ids never repeat"
    );
}

#[test]
fn a_failed_compression_still_lets_retention_and_the_cap_run() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    std::fs::create_dir_all(&root).unwrap();
    let hour = QueryLogSettings {
        retention_hours: 1,
        ..settings()
    };
    // 旧版留下的纯文本段压不了：它的临时文件名被一个目录占着 / An older version's plain segment cannot compress: a
    // directory holds its temporary name
    let first = root.join(format!("{NOON:013}-{:016}.jsonl", 1));
    std::fs::write(&first, older_line(1, NOON)).unwrap();
    std::fs::create_dir(format!("{}.zst.tmp", first.display())).unwrap();
    let store = QueryLogStore::open(root.clone()).unwrap();
    for (seq, at) in [(2, NOON + HOUR_MS + 1), (3, NOON + 2 * HOUR_MS + 1)] {
        store
            .append(&[record(seq, at, "x.example")], &hour, at)
            .unwrap();
    }
    let error = store.maintain(&hour, NOON + 2 * HOUR_MS + 2).unwrap_err();
    assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(
        !first.exists(),
        "retention still dropped the segment that would not compress"
    );
    assert_eq!(store.usage().oldest_start_ms, Some(NOON + HOUR_MS + 1));
}

#[test]
fn a_closed_segment_whose_file_is_gone_is_forgotten() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(1, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    store
        .append(
            &[record(2, NOON + HOUR_MS, "b.example")],
            &settings(),
            NOON + HOUR_MS,
        )
        .unwrap();
    std::fs::remove_file(segment_files(&root).remove(0)).unwrap();
    store.maintain(&settings(), NOON + HOUR_MS).unwrap();
    assert_eq!(store.usage().oldest_start_ms, Some(NOON + HOUR_MS));
    assert_eq!(ids(&store.read_page(&everything())), [2]);
}

#[test]
fn clearing_frees_the_space_even_when_the_state_file_cannot_be_written() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(1, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    // 状态文件的位置被一个非空目录占着，写不进去 / A non-empty directory sits where the state file goes, so it cannot be written
    std::fs::create_dir_all(root.join("state.json/blocked")).unwrap();
    store.clear().unwrap();
    assert!(segment_files(&root).is_empty());
    assert_eq!(store.usage().bytes, 0);
}

#[test]
fn a_corrupt_segment_is_skipped_when_opening_and_reading() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    for (seq, at) in [(1, NOON), (2, NOON + HOUR_MS), (3, NOON + 2 * HOUR_MS)] {
        store
            .append(&[record(seq, at, "x.example")], &settings(), at)
            .unwrap();
        store.maintain(&settings(), at).unwrap();
    }
    let middle = segment_files(&root).remove(1);
    let bytes = std::fs::read(&middle).unwrap();
    std::fs::write(&middle, &bytes[..bytes.len() / 2]).unwrap();
    assert_eq!(
        ids(&store.read_page(&everything())),
        [3, 1],
        "the broken hour is skipped, the rest still reads"
    );

    // 最新的那段坏了也照样打开 / Opening works even when the newest segment is broken
    let other = directory.path().join("other");
    let store = QueryLogStore::open(other.clone()).unwrap();
    store
        .append(&[record(1, NOON, "x.example")], &settings(), NOON)
        .unwrap();
    store.maintain(&settings(), NOON + HOUR_MS).unwrap();
    drop(store);
    let newest = segment_files(&other).remove(0);
    let bytes = std::fs::read(&newest).unwrap();
    std::fs::write(&newest, &bytes[..bytes.len() / 2]).unwrap();
    let store = QueryLogStore::open(other).unwrap();
    assert!(store.read_page(&everything()).items.is_empty());
}

#[test]
fn a_cursor_moved_without_writing_survives_a_restart() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(5, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    // 6 到 9 都是忽略的域名，什么也没写 / 6 to 9 were ignored domains, and nothing was written
    store.set_cursor(Cursor {
        instance: INSTANCE,
        seq: 9,
    });
    store.maintain(&settings(), NOON).unwrap();
    drop(store);
    let store = QueryLogStore::open(root.clone()).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 9
        })
    );

    // 之后又写了，就以最后一条为准 / Once something is written after it, the last record counts
    store
        .append(&[record(10, NOON, "b.example")], &settings(), NOON)
        .unwrap();
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 10
        })
    );
}

#[test]
fn an_empty_segment_left_by_a_power_loss_is_removed() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(1, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    drop(store);
    // 新开的一段还没写就断电了，编号和下一段会一样 / A new segment lost power before its first write; its id equals the next one's
    let empty = root.join(format!("{:013}-{:016}.jsonl.zst", NOON + HOUR_MS, 2));
    std::fs::write(&empty, b"").unwrap();
    let store = QueryLogStore::open(root.clone()).unwrap();
    assert!(!empty.exists());
    store
        .append(
            &[record(2, NOON + 2 * HOUR_MS, "b.example")],
            &settings(),
            NOON + 2 * HOUR_MS,
        )
        .unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [2, 1]);
}

/// 一大批记录，第 700 条特别长 / A big batch of records, record 700 especially long
fn long_batch(seqs: std::ops::RangeInclusive<u64>) -> Vec<Record> {
    seqs.map(|seq| {
        let mut entry = entry(seq, NOON + seq, "x.example", "192.168.1.9");
        entry.insert("error".to_owned(), Value::String(long_error(seq)));
        Record::Entry {
            instance: INSTANCE,
            entry: KernelEntry::from_map(entry),
            static_kind: None,
        }
    })
    .collect()
}

fn long_error(id: u64) -> String {
    let length = if id == 700 { 700_000 } else { 700 };
    format!("{id}:{}", "e".repeat(length))
}

/// 一页一页从新往旧翻完，每条都完整 / Pages through from newest to oldest, every record whole
fn read_all(store: &QueryLogStore) -> Vec<u64> {
    let mut seen = Vec::new();
    let mut before = None;
    loop {
        let page = store.read_page(&PageQuery {
            before,
            limit: 500,
            ..everything()
        });
        for item in &page.items {
            let id = item["id"].as_u64().unwrap();
            assert_eq!(item["error"], long_error(id), "record {id} is whole");
            seen.push(id);
        }
        match page.next_before {
            Some(next) => before = Some(next),
            None => return seen,
        }
    }
}

#[test]
fn the_segment_being_written_reads_back_across_its_frames() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    // 一批 500 条约 0.6 MiB（第 700 条一条就 0.7 MiB）：12 批写下好几帧 / A batch of 500 is about 0.6 MiB (record 700
    // alone is 0.7 MiB): 12 batches make several frames
    for batch in 0..12u64 {
        store
            .append(
                &long_batch(batch * 500 + 1..=batch * 500 + 500),
                &settings(),
                NOON,
            )
            .unwrap();
    }
    let file = segment_files(&root).remove(0);
    let (finished, open) = frames(&file);
    assert!(finished >= 2 && open, "{finished} frames, open {open}");
    assert_eq!(read_all(&store), (1..=6_000).rev().collect::<Vec<u64>>());
    store.maintain(&settings(), NOON + HOUR_MS).unwrap();
    assert!(
        store.usage().bytes < 7 * MIB / 10,
        "compressed: {}",
        store.usage().bytes
    );
    assert_eq!(read_all(&store), (1..=6_000).rev().collect::<Vec<u64>>());
}

#[test]
fn an_older_versions_plain_segment_reads_back_across_its_blocks() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    std::fs::create_dir_all(&root).unwrap();
    let mut text = Vec::new();
    for (id, record) in (1..=1_500).zip(long_batch(1..=1_500)) {
        let Record::Entry { entry, .. } = record else {
            unreachable!()
        };
        let mut line = entry.fields().unwrap();
        line.insert("id".to_owned(), id.into());
        serde_json::to_writer(&mut text, &line).unwrap();
        text.push(b'\n');
    }
    std::fs::write(root.join(format!("{NOON:013}-{:016}.jsonl", 1)), text).unwrap();
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(read_all(&store), (1..=1_500).rev().collect::<Vec<u64>>());
}

#[test]
fn a_failed_write_cuts_the_segment_back_and_the_next_batch_opens_a_new_one() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(1, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    let written = store.usage().bytes;
    // 写了一半的那块留在文件尾上；再把文件换成只读的，下一批写不进去 / Half a block is left at the file's end, and the
    // file is swapped for a read-only one, so the next batch cannot be written
    let first = segment_files(&root).remove(0);
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&first)
            .unwrap();
        file.write_all(&[0x25, 0x01, 0x00]).unwrap();
    }
    store.lock().writer.as_mut().unwrap().encoder.get_mut().file =
        std::fs::File::open(&first).unwrap();
    assert!(
        store
            .append(&[record(2, NOON + 1, "b.example")], &settings(), NOON + 1)
            .is_err()
    );
    assert_eq!(std::fs::metadata(&first).unwrap().len(), written);
    store
        .append(&[record(3, NOON + 2, "c.example")], &settings(), NOON + 2)
        .unwrap();
    assert_eq!(segment_files(&root).len(), 2);
    let page = store.read_page(&everything());
    assert_eq!(ids(&page), [2, 1], "the failed batch took no id");
    assert_eq!(page.items[0]["qname"], "c.example");
}

#[test]
fn retention_and_reads_judge_each_segment_by_its_own_hour() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let day = QueryLogSettings {
        retention_hours: 24,
        ..settings()
    };
    // 两小时前写了一条；之后时钟往回跳了 400 天又被校正回来 / One record two hours ago; then the clock jumped back 400 days
    // and was corrected again
    let stepped = NOON - 400 * 24 * HOUR_MS;
    store
        .append(&[record(1, NOON, "recent.example")], &day, NOON)
        .unwrap();
    store
        .append(&[record(2, stepped, "stepped.example")], &day, stepped)
        .unwrap();
    let now = NOON + 2 * HOUR_MS;
    store
        .append(&[record(3, now, "now.example")], &day, now)
        .unwrap();
    // 还没收拾时，过期的那段夹在中间也不挡读更早的 / Before housekeeping, the expired segment in the middle does not stop
    // the read from reaching older ones
    let cutoff = now - 24 * HOUR_MS;
    let before = store.read_page(&PageQuery {
        cutoff_ms: cutoff,
        ..everything()
    });
    assert_eq!(ids(&before), [3, 1]);
    store.maintain(&day, now).unwrap();

    let page = store.read_page(&PageQuery {
        cutoff_ms: now - 24 * HOUR_MS,
        ..everything()
    });
    assert_eq!(
        ids(&page),
        [3, 1],
        "the stepped hour is gone, the recent one stays"
    );
    assert_eq!(store.usage().oldest_start_ms, Some(NOON));
}

#[test]
fn a_cursor_that_only_moved_reaches_disk_at_most_once_a_minute() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(5, NOON, "a.example")], &settings(), NOON)
        .unwrap();
    store.set_cursor(Cursor {
        instance: INSTANCE,
        seq: 9,
    });
    store.maintain(&settings(), NOON).unwrap();
    // 同一分钟里又挪了：先不写，少磨存储 / Moved again within the minute: not written yet, to spare the storage
    store.set_cursor(Cursor {
        instance: INSTANCE,
        seq: 12,
    });
    store.maintain(&settings(), NOON).unwrap();
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 9
        })
    );
}

#[test]
fn ids_never_go_back_when_the_newest_segment_is_unreadable() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(
            &[record(1, NOON, "a.example"), record(2, NOON, "b.example")],
            &settings(),
            NOON,
        )
        .unwrap();
    store.maintain(&settings(), NOON + HOUR_MS).unwrap();
    drop(store);
    let newest = segment_files(&root).remove(0);
    let bytes = std::fs::read(&newest).unwrap();
    std::fs::write(&newest, &bytes[..bytes.len() / 2]).unwrap();

    let store = QueryLogStore::open(root).unwrap();
    store
        .append(
            &[record(3, NOON + HOUR_MS, "c.example")],
            &settings(),
            NOON + HOUR_MS,
        )
        .unwrap();
    assert_eq!(
        ids(&store.read_page(&everything())),
        [3],
        "the new record does not reuse 1 or 2"
    );
}

#[test]
fn an_expired_newest_segment_goes_even_when_nothing_new_arrives() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    let hour = QueryLogSettings {
        retention_hours: 1,
        ..settings()
    };
    store
        .append(&[record(1, NOON, "a.example")], &hour, NOON)
        .unwrap();
    store.maintain(&hour, NOON + 30 * 24 * HOUR_MS).unwrap();
    assert_eq!(store.usage().bytes, 0);
    assert!(segment_files(&root).is_empty());
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 1
        }),
        "the cursor outlives the data"
    );
}

#[test]
fn a_clock_step_while_collecting_does_not_hide_the_record() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let day = QueryLogSettings {
        retention_hours: 24,
        ..settings()
    };
    store
        .append(&[record(1, NOON, "a.example")], &day, NOON)
        .unwrap();
    // 内核在 12:30 记下第 2 条，面板写下它之前时钟往回跳了 48 小时 / The kernel stamped record 2 at 12:30; before the
    // panel wrote it the clock jumped back 48 hours
    let half_past = NOON + HOUR_MS / 2;
    store
        .append(
            &[record(2, half_past, "b.example")],
            &day,
            half_past - 48 * HOUR_MS,
        )
        .unwrap();
    let later = NOON + HOUR_MS + 1;
    store
        .append(&[record(3, later, "c.example")], &day, later)
        .unwrap();
    store.maintain(&day, later).unwrap();
    let page = store.read_page(&PageQuery {
        cutoff_ms: later - 24 * HOUR_MS,
        ..everything()
    });
    assert_eq!(ids(&page), [3, 2, 1]);
}

/// 页面轮询新查询：只看比见过的新的，跨段也在见过的那段停下；页头的「最近一条」不管筛选，清空后没有
/// The page's poll for new queries: only records newer than the ones seen, stopping at the seen segment across
/// segments; the header's newest time ignores the filter, and there is none after clearing
#[test]
fn polls_read_only_newer_records_and_the_newest_time_ignores_filters() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    for (seq, at, qname) in [
        (1, NOON + 1_000, "a.example"),
        (2, NOON + 2_000, "b.example"),
        (3, NOON + HOUR_MS + 1_000, "a.example"),
        (4, NOON + HOUR_MS + 2_000, "b.example"),
        (5, NOON + 2 * HOUR_MS + 1_000, "a.example"),
    ] {
        store
            .append(&[record(seq, at, qname)], &settings(), at)
            .unwrap();
        store.maintain(&settings(), at).unwrap();
    }
    let newer = |after: u64, limit: usize, q: Option<&str>| {
        store.read_page(&PageQuery {
            after: Some(after),
            limit,
            filter: Filter {
                q: q.map(str::to_owned),
                ..Filter::default()
            },
            ..everything()
        })
    };
    assert_eq!(ids(&newer(2, 500, None)), [5, 4, 3]);
    assert_eq!(newer(2, 500, None).next_before, None);
    assert_eq!(ids(&newer(5, 500, None)), Vec::<u64>::new());
    // 新的比一页多：交回接着往前的地方，页面就知道不止这些 / More new ones than a page: where to go on is handed back,
    // so the page knows there are more
    let page = newer(1, 2, None);
    assert_eq!(ids(&page), [5, 4]);
    assert_eq!(page.next_before, Some(4));
    assert_eq!(ids(&newer(2, 500, Some("a."))), [5, 3]);

    // 最近一条的时间：筛不到也照样有，重新打开后还在 / The newest time: there even when the filter finds nothing, and
    // still there after reopening
    let nothing = newer(0, 500, Some("nothing.example"));
    assert!(nothing.items.is_empty());
    assert_eq!(nothing.newest_unix_ms, Some(NOON + 2 * HOUR_MS + 1_000));
    drop(store);
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.read_page(&everything()).newest_unix_ms,
        Some(NOON + 2 * HOUR_MS + 1_000)
    );
    // 保留时间以外的不算 / Outside retention it does not count
    assert_eq!(
        store
            .read_page(&PageQuery {
                cutoff_ms: NOON + 3 * HOUR_MS,
                ..everything()
            })
            .newest_unix_ms,
        None
    );
    store.clear().unwrap();
    assert_eq!(store.read_page(&everything()).newest_unix_ms, None);
}

/// 这一行在旧的写法下是什么样：面板的 `id`、`instance`，内核的字段（去掉面板自己的字段名），最后 `static_kind`
/// The line as the old way wrote it: the panel's `id` and `instance`, the kernel's fields (without the panel's
/// own field names), `static_kind` last
fn line_the_old_way(
    id: u64,
    entry: &Map<String, Value>,
    static_kind: Option<StaticKind>,
) -> Map<String, Value> {
    let mut line = Map::new();
    line.insert("id".to_owned(), id.into());
    line.insert("instance".to_owned(), INSTANCE.into());
    for (key, value) in entry {
        if !matches!(key.as_str(), "id" | "instance" | "static_kind") {
            line.insert(key.clone(), value.clone());
        }
    }
    if let Some(kind) = static_kind {
        line.insert("static_kind".to_owned(), kind.label().into());
    }
    line
}

/// 写下的一行和它的字段顺序 / A written line and its field order
fn written(record: &Record, id: u64) -> (Map<String, Value>, Vec<String>) {
    let mut out = Vec::new();
    record.write_line(id, &mut out).unwrap();
    let line: Map<String, Value> = serde_json::from_slice(&out).unwrap();
    let order = line.keys().cloned().collect();
    (line, order)
}

/// 内核的一条记录照原文写下：字段、值和顺序都和原来拆开再写回去的一样，转义照原文留着
/// A kernel record is written from its text: fields, values and order are those of the old way that
/// took it apart and wrote it back, and its escapes stay as they came
#[test]
fn a_kernel_record_is_written_from_its_text() {
    let text = r#"{"seq":5,"time_unix_ms":1792065600005,"qname":"caf\u00e9.example","outcome":"static","answers":[],"steps":[{"kind":"rule","decision":"static"}]}"#;
    let fields: Map<String, Value> = serde_json::from_str(text).unwrap();
    for static_kind in [None, Some(StaticKind::Blocked)] {
        let record = Record::Entry {
            instance: INSTANCE,
            entry: KernelEntry::new(text.into(), Some(5), Some(1_792_065_600_005)),
            static_kind,
        };
        let (line, order) = written(&record, 42);
        let expected = line_the_old_way(42, &fields, static_kind);
        assert_eq!(line, expected);
        assert_eq!(order, expected.keys().cloned().collect::<Vec<_>>());
        assert_eq!(line["qname"], "café.example");
    }
    let mut out = Vec::new();
    Record::Entry {
        instance: INSTANCE,
        entry: KernelEntry::new(text.into(), Some(5), None),
        static_kind: None,
    }
    .write_line(1, &mut out)
    .unwrap();
    assert!(
        String::from_utf8(out).unwrap().contains(r"caf\u00e9"),
        "the escape stays as the kernel wrote it"
    );
}

/// 内核的记录里碰巧有面板自己的字段名：去掉它们，其余照原来的顺序；空对象只剩面板的两项
/// A kernel record that happens to carry the panel's own field names: they go and the rest keep their order;
/// an empty object leaves only the panel's two
#[test]
fn the_panels_own_field_names_are_dropped_from_a_kernel_record() {
    let fields = object(json!({
        "id": 9, "seq": 3, "instance": 1, "qname": "a.example", "static_kind": "answered", "time_unix_ms": 4,
    }));
    let record = Record::Entry {
        instance: INSTANCE,
        entry: KernelEntry::from_map(fields.clone()),
        static_kind: Some(StaticKind::Answered),
    };
    let (line, order) = written(&record, 42);
    let expected = line_the_old_way(42, &fields, Some(StaticKind::Answered));
    assert_eq!(line, expected);
    assert_eq!(
        order,
        [
            "id",
            "instance",
            "seq",
            "qname",
            "time_unix_ms",
            "static_kind"
        ]
    );
    assert_eq!(record.cursor().map(|cursor| cursor.seq), Some(3));
    assert_eq!(record.time_unix_ms(), Some(4));

    let empty = Record::Entry {
        instance: INSTANCE,
        entry: KernelEntry::from_map(Map::new()),
        static_kind: None,
    };
    let mut out = Vec::new();
    empty.write_line(1, &mut out).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), r#"{"id":1,"instance":7}"#);
}
