use std::fmt;

use serde_json::Value;

pub const CONFIG_QUERY_STATS_V1: &str = "config_query_stats_v1";
pub const CONFIG_STATIC_CNAME_RESPONSE_V1: &str = "config_static_cname_response_v1";
pub const CONFIG_BOOTSTRAP_V1: &str = "config_bootstrap_v1";
pub const CONFIG_QTYPE_NAMES_V1: &str = "config_qtype_names_v1";
const LEGACY_STATS_TOP_V1: &str = "stats_top_v1";
const MAX_CAPABILITIES: usize = 64;

/// 配置里用到了内核不认的东西：每样一句做得到的出路，按注册表的顺序
/// The config uses things the kernel does not know: one remedy that can actually be done for each, in registry order
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedConfigFields(Vec<String>);

impl fmt::Display for UnsupportedConfigFields {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0.join("；"))
    }
}

/// 注册表的一项：能力，和它管的写法。`uses` 在配置用到这种写法时给出路，没用到给 `None`
/// One registry entry: a capability and the writing it controls. `uses` gives the remedy when the config uses that writing,
/// `None` when it does not
struct Requirement {
    capability: &'static str,
    uses: fn(&Value) -> Option<String>,
}

// 挡保存、恢复和版本切换的能力，每项写一次。不在表里的：
// - config_query_stats_v1：排行一直开着，那两个设置写成什么都不挡，内核不认识时直接忽略；
// - config_serve_stale_ttl_reset_v2：新旧内核都认 serve_stale_ttl_reset，只是默认值和含义不同，配置照样能跑，只由表单按它决定默认值和说法；
// - config_panel_block_v1：顶层的 panel 是面板自己的存储，每份保存的配置都带着它。2026.11.23.11 以前的内核忽略它（现有的安装大多是这批），
//   只有 2026.11.23.11 到 2026.11.25.27 的拒收；按能力挡会连那批照常能存的也挡住。拒不拒收由内核自己的校验说了算，被拒时提示更新内核
// The capabilities that block a save, a restore and a version switch, each written once. Not in the table:
// - config_query_stats_v1: rankings are always on, so the two settings block nothing whatever they say, and a kernel that does
//   not know them ignores them;
// - config_serve_stale_ttl_reset_v2: old and new kernels both read serve_stale_ttl_reset, with a different default and meaning,
//   so the config runs either way; only the form goes by it for the default and the wording;
// - config_panel_block_v1: the top-level panel is the panel's own storage, carried by every config it saves. Kernels before
//   2026.11.23.11 ignore it (most installs run one of those), and only those from 2026.11.23.11 to 2026.11.25.27 refuse it;
//   blocking by capability would block the ones that save fine too. Whether it is refused is the kernel's own validation to
//   say, and a refusal prompts a kernel update
const REQUIREMENTS: [Requirement; 3] = [
    // 2026.11.23.11 以前的内核悄悄忽略 bootstrap，写成主机名的上游照旧问系统的解析器；到 2026.11.23.49 当不认的键拒收。写了就算，空的也算
    // Kernels before 2026.11.23.11 ignore bootstrap, and upstreams written with a host name still go to the system resolver; up
    // to 2026.11.23.49 they refuse it as a key they do not read. Written at all counts, empty included
    Requirement {
        capability: CONFIG_BOOTSTRAP_V1,
        uses: |content| {
            content.pointer("/settings/bootstrap").map(|_| {
                "这个内核不认引导 DNS（settings.bootstrap）：在设置里清空它，或者换用支持它的内核".to_owned()
            })
        },
    },
    // 以前的内核只认十种查询类型，别的写法编译不过，配置起不来 / Earlier kernels know ten query types only, and anything else
    // fails to compile, so the config does not start
    Requirement {
        capability: CONFIG_QTYPE_NAMES_V1,
        uses: |content| {
            let names = qtypes_beyond_legacy(content);
            (!names.is_empty()).then(|| {
                format!(
                    "这个内核的查询类型只认 {} 这十种，配置里用了 {}：把它们从条件里去掉，或者换用支持它的内核",
                    LEGACY_QTYPES.join("、"),
                    names.join("、")
                )
            })
        },
    },
    Requirement {
        capability: CONFIG_STATIC_CNAME_RESPONSE_V1,
        uses: |content| {
            config_uses_action(content, "static_cname_response").then(|| {
                "这个内核不支持 CNAME 回答：把回答写成域名的映射和规则改成 IP，或者换用支持它的内核".to_owned()
            })
        },
    },
];

pub fn ensure_config_supported(
    content: &Value,
    capabilities: &[String],
) -> Result<(), UnsupportedConfigFields> {
    let remedies = REQUIREMENTS
        .iter()
        .filter(|requirement| {
            !capabilities
                .iter()
                .any(|capability| capability == requirement.capability)
        })
        .filter_map(|requirement| (requirement.uses)(content))
        .collect::<Vec<_>>();
    if remedies.is_empty() {
        Ok(())
    } else {
        Err(UnsupportedConfigFields(remedies))
    }
}

/// 没有 `config_qtype_names_v1` 的内核认的查询类型（它的 `parse_dns_type`，不分大小写）
/// The query types a kernel without `config_qtype_names_v1` knows (its `parse_dns_type`, in any case)
const LEGACY_QTYPES: [&str; 10] = [
    "A", "AAAA", "CNAME", "MX", "TXT", "NS", "PTR", "SRV", "SOA", "OPT",
];

/// 配置里这十种以外的查询类型，按写的顺序、各一次。请求的 `qtype` 和回答的 `response_type` 都算，`pipeline_select` 和每条规则里的都看
/// The query types in the config beyond those ten, in the order written, once each. A request's `qtype` and an answer's
/// `response_type` both count, in `pipeline_select` and every rule alike
fn qtypes_beyond_legacy(content: &Value) -> Vec<String> {
    let request = items(content, "pipeline_select")
        .chain(rules(content))
        .flat_map(|holder| items(holder, "matchers"))
        .filter(|matcher| has_type(matcher, "qtype"));
    let response = rules(content)
        .flat_map(|rule| items(rule, "response_matchers"))
        .filter(|matcher| has_type(matcher, "response_type"));
    let mut names: Vec<String> = Vec::new();
    for value in request
        .chain(response)
        .filter_map(|matcher| matcher.get("value").and_then(Value::as_str))
    {
        let known = LEGACY_QTYPES
            .iter()
            .any(|name| name.eq_ignore_ascii_case(value));
        if !known && !names.iter().any(|name| name == value) {
            names.push(value.to_owned());
        }
    }
    names
}

fn config_uses_action(content: &Value, action_type: &str) -> bool {
    const ACTION_FIELDS: [&str; 3] = [
        "actions",
        "response_actions_on_match",
        "response_actions_on_miss",
    ];
    rules(content).any(|rule| {
        ACTION_FIELDS
            .iter()
            .any(|field| items(rule, field).any(|action| has_type(action, action_type)))
    })
}

/// 配置里的每条规则：各 pipeline 的，和 `background_refresh_rule` / Every rule in the config: each pipeline's, and `background_refresh_rule`
fn rules(content: &Value) -> impl Iterator<Item = &Value> {
    items(content, "pipelines")
        .flat_map(|pipeline| items(pipeline, "rules"))
        .chain(content.get("background_refresh_rule"))
}

/// `value` 的数组 `field` 里的每一项，不是数组就没有 / Each item of the array `field` of `value`, none when it is no array
fn items<'a>(value: &'a Value, field: &'static str) -> impl Iterator<Item = &'a Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn has_type(item: &Value, kind: &str) -> bool {
    item.get("type").and_then(Value::as_str) == Some(kind)
}

pub fn canonical_runtime_capabilities(capabilities: &[String]) -> Vec<String> {
    let mut canonical = capabilities
        .iter()
        .filter(|capability| capability.starts_with("config_") && valid_capability(capability))
        .cloned()
        .collect::<Vec<_>>();
    if capabilities
        .iter()
        .any(|capability| capability == LEGACY_STATS_TOP_V1)
    {
        canonical.push(CONFIG_QUERY_STATS_V1.to_owned());
    }
    canonical.sort_unstable();
    canonical.dedup();
    canonical
}

pub fn validate_declared_capabilities(capabilities: &[String]) -> Result<(), String> {
    if capabilities.len() > MAX_CAPABILITIES {
        return Err(format!("配置能力不能超过 {MAX_CAPABILITIES} 项"));
    }
    if capabilities
        .iter()
        .any(|capability| !valid_capability(capability))
    {
        return Err("配置能力名称无效".to_owned());
    }
    let mut unique = capabilities.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != capabilities.len() {
        return Err("配置能力不能重复".to_owned());
    }
    Ok(())
}

fn valid_capability(capability: &str) -> bool {
    !capability.is_empty()
        && capability.len() <= 64
        && capability.as_bytes()[0].is_ascii_lowercase()
        && capability
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        CONFIG_BOOTSTRAP_V1, CONFIG_QTYPE_NAMES_V1, CONFIG_QUERY_STATS_V1,
        CONFIG_STATIC_CNAME_RESPONSE_V1, canonical_runtime_capabilities, ensure_config_supported,
        validate_declared_capabilities,
    };

    fn refusal(content: &Value, capabilities: &[&str]) -> Option<String> {
        let capabilities = capabilities
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect::<Vec<_>>();
        ensure_config_supported(content, &capabilities)
            .err()
            .map(|error| error.to_string())
    }

    fn rule(rule: &Value) -> Value {
        json!({"pipelines": [{"id": "default", "rules": [rule]}]})
    }

    // 排行一直开着，这两个设置写成什么、内核报不报能力都不挡：旧版面板写下的配置照样能保存、更新和回退
    // Rankings are always on, so these two settings never block, whatever they say and whatever the kernel reports: configs written by older
    // panels still save, update and roll back
    #[test]
    fn statistics_settings_never_block() {
        let content = json!({"settings": {"statistics_enabled": true, "statistics_anonymize_client_ip": true}});
        assert_eq!(refusal(&content, &[]), None);
    }

    // 新旧内核都认 serve_stale_ttl_reset，只是默认值和含义不同：写成什么都不挡，没有 v2 的内核照样能保存、切换过去
    // Old and new kernels both read serve_stale_ttl_reset, with a different default and meaning: nothing it says blocks, and a
    // kernel without v2 still saves and can be switched to
    #[test]
    fn serve_stale_ttl_reset_never_blocks() {
        for value in [true, false] {
            let content =
                json!({"settings": {"serve_stale": true, "serve_stale_ttl_reset": value}});
            assert_eq!(refusal(&content, &[]), None, "{value}");
        }
    }

    // 面板块是面板自己的存储，不按能力挡：没有 config_panel_block_v1 的内核照样能保存、能切换过去，拒不拒收由内核的校验说
    // The panel block is the panel's own storage and is not blocked by capability: a kernel without config_panel_block_v1
    // still saves and can be switched to, and whether it refuses is the kernel's validation to say
    #[test]
    fn the_panel_block_never_blocks() {
        let content = json!({"pipelines": [], "panel": {"v": 1, "hash": "0", "model": {}}});
        assert_eq!(refusal(&content, &[]), None);
    }

    // 每项能力：配置用到它管的写法，没有这项能力就挡、说出那一句出路，有了就放行；没用到时什么能力都不要
    // Each capability: a config using the writing it controls is blocked without it, naming that remedy, and let through with
    // it; a config not using it needs no capability at all
    #[test]
    fn every_registered_capability_blocks_only_what_it_controls() {
        let cases = [
            (
                CONFIG_BOOTSTRAP_V1,
                json!({"settings": {"bootstrap": "223.5.5.5:53"}}),
                "引导 DNS",
            ),
            (
                CONFIG_QTYPE_NAMES_V1,
                rule(&json!({"matchers": [{"type": "qtype", "value": "HTTPS"}]})),
                "配置里用了 HTTPS",
            ),
            (
                CONFIG_STATIC_CNAME_RESPONSE_V1,
                rule(
                    &json!({"actions": [{"type": "static_cname_response", "target": "origin.example."}]}),
                ),
                "CNAME 回答",
            ),
        ];
        for (capability, content, remedy) in cases {
            let refused = refusal(&content, &[]).unwrap_or_default();
            assert!(refused.contains(remedy), "{capability}: {refused}");
            assert_eq!(refusal(&content, &[capability]), None, "{capability}");
        }
        assert_eq!(refusal(&json!({"pipelines": []}), &[]), None);
    }

    #[test]
    fn names_the_cname_remedy() {
        let content = rule(
            &json!({"actions": [{"type": "static_cname_response", "target": "origin.example."}]}),
        );
        assert_eq!(
            refusal(&content, &[]).unwrap(),
            "这个内核不支持 CNAME 回答：把回答写成域名的映射和规则改成 IP，或者换用支持它的内核"
        );
    }

    #[test]
    fn requires_static_cname_capability_in_every_action_stage() {
        for field in [
            "actions",
            "response_actions_on_match",
            "response_actions_on_miss",
        ] {
            let content = rule(
                &json!({ field: [{ "type": "static_cname_response", "target": "origin.example." }] }),
            );
            assert!(refusal(&content, &[]).is_some(), "{field}");
            assert_eq!(refusal(&content, &[CONFIG_STATIC_CNAME_RESPONSE_V1]), None);
        }

        let background = json!({
            "background_refresh_rule": {
                "actions": [{ "type": "static_cname_response", "target": "origin.example." }]
            }
        });
        assert!(refusal(&background, &[]).is_some());
    }

    // 写了 bootstrap 就要这项能力，空的也要：2026.11.23.11 到 .49 的内核把这个键本身当不认的拒收
    // Writing bootstrap at all takes the capability, empty too: kernels from 2026.11.23.11 to .49 refuse the key itself as
    // one they do not read
    #[test]
    fn bootstrap_written_at_all_needs_the_capability() {
        for value in [json!("223.5.5.5:53"), json!(""), Value::Null] {
            let content = json!({"settings": {"bootstrap": value}});
            assert!(refusal(&content, &[]).is_some(), "{content}");
        }
        assert_eq!(
            refusal(
                &json!({"settings": {"default_upstream": "1.1.1.1:53"}}),
                &[]
            ),
            None
        );
    }

    // 旧内核认的十种怎么写大小写都行；别的类型名和 TYPEnnn 在入口、规则、回答条件和后台刷新规则里都要能力，
    // 提示按写的顺序把用到的每种说一次
    // The ten an old kernel knows pass in any case; other type names and TYPEnnn need the capability in entries, rules, answer
    // conditions and the background refresh rule, and the remedy names each one used once, in the order written
    #[test]
    fn qtype_names_beyond_the_ten_need_the_capability_wherever_they_are_written() {
        let legacy = json!({
            "pipeline_select": [{"pipeline": "default", "matchers": [{"type": "qtype", "value": "aaaa"}]}],
            "pipelines": [{"id": "default", "rules": [{
                "matchers": [{"type": "qtype", "value": "Srv"}],
                "response_matchers": [{"type": "response_type", "value": "CNAME"}]
            }]}]
        });
        assert_eq!(refusal(&legacy, &[]), None);

        let places = [
            json!({"pipeline_select": [{"pipeline": "default", "matchers": [{"type": "qtype", "value": "HTTPS"}]}]}),
            rule(
                &json!({"matchers": [{"operator": "and_not", "type": "qtype", "value": "HTTPS"}]}),
            ),
            rule(&json!({"response_matchers": [{"type": "response_type", "value": "HTTPS"}]})),
            json!({"background_refresh_rule": {"matchers": [{"type": "qtype", "value": "HTTPS"}]}}),
        ];
        for content in places {
            assert!(
                refusal(&content, &[])
                    .is_some_and(|refused| refused.contains("配置里用了 HTTPS：")),
                "{content}"
            );
            assert_eq!(refusal(&content, &[CONFIG_QTYPE_NAMES_V1]), None);
        }

        // 只有 qtype 和 response_type 的值算：别的匹配器的值、查询类别不算 / Only qtype and response_type values count, not
        // other matchers' values or the query class
        let others = rule(&json!({
            "matchers": [{"type": "domain_suffix", "value": "HTTPS"}, {"type": "qclass", "value": "CH"}],
            "response_matchers": [{"type": "response_rcode", "value": "BADCOOKIE"}]
        }));
        assert_eq!(refusal(&others, &[]), None);

        let several = json!({
            "pipeline_select": [{"pipeline": "default", "matchers": [{"type": "qtype", "value": "TYPE65"}]}],
            "pipelines": [{"id": "default", "rules": [
                {"matchers": [{"type": "qtype", "value": "svcb"}, {"type": "qtype", "value": "A"}]},
                {"matchers": [{"type": "qtype", "value": "TYPE65"}], "response_matchers": [{"type": "response_type", "value": "CAA"}]}
            ]}]
        });
        assert_eq!(
            refusal(&several, &[]).unwrap(),
            "这个内核的查询类型只认 A、AAAA、CNAME、MX、TXT、NS、PTR、SRV、SOA、OPT 这十种，配置里用了 TYPE65、svcb、CAA：把它们从条件里去掉，或者换用支持它的内核"
        );
    }

    // 几样都缺时一次说全，按注册表的顺序，用分号隔开 / With several missing all are named at once, in registry order, split by
    // semicolons
    #[test]
    fn names_every_missing_capability_at_once() {
        let content = json!({
            "settings": {"bootstrap": "223.5.5.5:53"},
            "pipelines": [{"id": "default", "rules": [{
                "matchers": [{"type": "qtype", "value": "HTTPS"}],
                "actions": [{"type": "static_cname_response", "target": "origin.example."}]
            }]}]
        });
        let refused = refusal(&content, &[]).unwrap();
        let parts = refused.split('；').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3, "{refused}");
        for (part, remedy) in parts.iter().zip(["引导 DNS", "HTTPS", "CNAME 回答"]) {
            assert!(part.contains(remedy), "{part}");
        }
        assert_eq!(
            refusal(&content, &[CONFIG_QTYPE_NAMES_V1])
                .unwrap()
                .split('；')
                .count(),
            2
        );
    }

    #[test]
    fn canonicalizes_runtime_aliases_and_validates_manifests() {
        let canonical = canonical_runtime_capabilities(&[
            "stats_top_v1".to_owned(),
            "config_future_v1".to_owned(),
        ]);
        assert_eq!(
            canonical,
            vec![
                "config_future_v1".to_owned(),
                CONFIG_QUERY_STATS_V1.to_owned()
            ]
        );
        assert!(validate_declared_capabilities(&canonical).is_ok());
        assert!(
            validate_declared_capabilities(&[
                "config_future_v1".to_owned(),
                "config_future_v1".to_owned(),
            ])
            .is_err()
        );
    }
}
