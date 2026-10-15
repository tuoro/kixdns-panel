use std::collections::HashSet;

use serde_json::{Map, Value, json};
use tempfile::tempdir;

use super::{
    Cursor, Filter, HOUR_MS, MIB, PageQuery, QueryLogSettings, QueryLogStore, Record, RuleFilter,
    RuleIndex, StaticKind, static_kind_from_answer,
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
        entry: entry(seq, time, qname, "192.168.1.9"),
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

    // 断电留下半行：重新打开时截掉，编号和游标接着上次 / Half a line left by a power loss is cut on reopening; ids and the
    // cursor carry on
    drop(store);
    let segment = std::fs::read_dir(&root)
        .unwrap()
        .map(|item| item.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .unwrap();
    let mut bytes = std::fs::read(&segment).unwrap();
    bytes.extend_from_slice(b"{\"id\":4,\"instance\":7,\"se");
    std::fs::write(&segment, bytes).unwrap();
    let store = QueryLogStore::open(root).unwrap();
    assert_eq!(
        store.cursor(),
        Some(Cursor {
            instance: INSTANCE,
            seq: 43
        })
    );
    store
        .append(&[record(44, NOON + 3, "d.example")], &settings(), NOON + 20)
        .unwrap();
    assert_eq!(ids(&store.read_page(&everything())), [4, 3, 2, 1]);
}

#[test]
fn a_new_hour_opens_a_new_segment_and_the_old_one_is_compressed() {
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
    let mut names: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|item| item.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.contains("jsonl"))
        .collect();
    names.sort();
    assert_eq!(names.len(), 3);
    let suffix = |name: &str, ending: &str| name.to_ascii_lowercase().ends_with(ending);
    assert!(suffix(&names[0], ".jsonl.gz") && suffix(&names[1], ".jsonl.gz"));
    assert!(
        suffix(&names[2], ".jsonl"),
        "the hour being written stays plain"
    );

    // 跨压缩段往前翻 / Paging back across compressed segments
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

    // 重新打开：压缩段照样读，游标来自最新一段 / Reopened: compressed segments still read, the cursor comes from the newest
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

#[test]
fn reopening_after_a_crash_mid_compression_keeps_one_copy() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("querylog");
    let store = QueryLogStore::open(root.clone()).unwrap();
    store
        .append(&[record(1, NOON, "x.example")], &settings(), NOON)
        .unwrap();
    store.maintain(&settings(), NOON + HOUR_MS).unwrap();
    drop(store);
    // 压好了、纯文本还没删，旁边还有一个半截的临时文件 / Compressed, the plain copy not yet removed, and a half-written temporary file
    let gz = std::fs::read_dir(&root)
        .unwrap()
        .map(|item| item.unwrap().path())
        .find(|path| {
            path.to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".jsonl.gz")
        })
        .unwrap();
    let plain = gz.with_extension("");
    std::fs::write(
        &plain,
        b"{\"id\":1,\"instance\":7,\"seq\":1,\"time_unix_ms\":0}\n",
    )
    .unwrap();
    std::fs::write(root.join("x.jsonl.gz.tmp"), b"half").unwrap();

    let store = QueryLogStore::open(root.clone()).unwrap();
    assert!(!plain.exists() && gz.exists());
    assert!(!root.join("x.jsonl.gz.tmp").exists());
    assert_eq!(ids(&store.read_page(&everything())), [1]);
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
                    entry,
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
            entry: blocked,
            static_kind: Some(StaticKind::Blocked),
        },
        Record::Entry {
            instance: INSTANCE,
            entry: checked,
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
        .filter(|path| path.to_string_lossy().contains(".jsonl"))
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
    let store = QueryLogStore::open(root.clone()).unwrap();
    let hour = QueryLogSettings {
        retention_hours: 1,
        ..settings()
    };
    store
        .append(&[record(1, NOON, "a.example")], &hour, NOON)
        .unwrap();
    // 让第一段压缩不了：它的临时文件名被一个目录占着 / The first segment cannot compress: a directory holds its temporary name
    let first = segment_files(&root).remove(0);
    std::fs::create_dir(format!("{}.gz.tmp", first.display())).unwrap();
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
    let empty = root.join(format!("{:013}-{:016}.jsonl", NOON + HOUR_MS, 2));
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

#[test]
fn the_segment_being_written_reads_back_across_its_blocks() {
    let directory = tempdir().unwrap();
    let store = QueryLogStore::open(directory.path().join("querylog")).unwrap();
    let batch: Vec<Record> = (1..=1_500)
        .map(|seq| {
            let mut entry = entry(seq, NOON + seq, "x.example", "192.168.1.9");
            // 第 700 条比两块还长 / Record 700 is longer than two blocks
            let length = if seq == 700 { 700_000 } else { 700 };
            entry.insert(
                "error".to_owned(),
                Value::String(format!("{seq}:{}", "e".repeat(length))),
            );
            Record::Entry {
                instance: INSTANCE,
                entry,
                static_kind: None,
            }
        })
        .collect();
    store.append(&batch, &settings(), NOON).unwrap();
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
            let length = if id == 700 { 700_000 } else { 700 };
            assert_eq!(
                item["error"],
                format!("{id}:{}", "e".repeat(length)),
                "record {id} is whole"
            );
            seen.push(id);
        }
        match page.next_before {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    assert_eq!(seen, (1..=1_500).rev().collect::<Vec<u64>>());
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
