use std::fmt;

use serde_json::Value;

pub const CONFIG_QUERY_STATS_V1: &str = "config_query_stats_v1";
pub const CONFIG_STATIC_CNAME_RESPONSE_V1: &str = "config_static_cname_response_v1";
const LEGACY_STATS_TOP_V1: &str = "stats_top_v1";
const MAX_CAPABILITIES: usize = 64;

struct FieldRequirement {
    pointer: &'static str,
    /// 依附的上一级开关：它没开着时这一项用不到能力（照写，偏好留着），和页面 settingNeedsCapability 同一条规则
    /// The switch this one depends on: while it is not on, this one needs no capability (still written, the preference kept), the page's settingNeedsCapability rule
    parent: Option<&'static str>,
    /// 页面上这一项的叫法，提示里用它，不用配置键 / What the page calls the setting; messages use it, not the config key
    label: &'static str,
    capability: &'static str,
}

const FIELD_REQUIREMENTS: &[FieldRequirement] = &[
    FieldRequirement {
        pointer: "/settings/statistics_enabled",
        parent: None,
        label: "启用查询排行",
        capability: CONFIG_QUERY_STATS_V1,
    },
    FieldRequirement {
        pointer: "/settings/statistics_anonymize_client_ip",
        parent: Some("/settings/statistics_enabled"),
        label: "客户端 IP 脱敏",
        capability: CONFIG_QUERY_STATS_V1,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedConfigFields {
    fields: Vec<&'static str>,
    cname: bool,
}

// 每一类给一条做得到的出路：设置要关掉（关着的不需要这项能力），CNAME 要改成 IP
// One remedy per kind that can actually be done: settings are switched off (off needs no capability); CNAME answers must become IPs
impl fmt::Display for UnsupportedConfigFields {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let it = if self.fields.len() > 1 {
            "它们"
        } else {
            "这一项"
        };
        let fields = self.fields.join("、");
        let them = if self.fields.len() > 1 {
            "它们"
        } else {
            "它"
        };
        // 句中点名设置时加「」，和页面上的写法一样 / Settings named mid-sentence take 「」, as the page writes them
        let quoted = self
            .fields
            .iter()
            .map(|field| format!("「{field}」"))
            .collect::<Vec<_>>()
            .join("、");
        // 两类都有时说一句：先列出来，再一起给出路，主语和出路各说一次
        // Both kinds: one sentence that lists them, then the ways out together, subject and remedy each said once
        match (self.fields.is_empty(), self.cname) {
            (false, false) => write!(
                formatter,
                "这个内核不支持配置里的：{fields}。在基础设置里关掉{it}再保存，或者换用支持{them}的内核"
            ),
            (true, true) => formatter.write_str(
                "这个内核不支持 CNAME 回答：把回答写成域名的映射和规则改成 IP，或者换用支持它的内核",
            ),
            (false, true) => write!(
                formatter,
                "这个内核不支持：{fields}、CNAME 回答。关掉{quoted}、把写成域名的回答改成 IP，或者换用支持它们的内核"
            ),
            (true, false) => Ok(()),
        }
    }
}

pub fn ensure_config_supported(
    content: &Value,
    capabilities: &[String],
) -> Result<(), UnsupportedConfigFields> {
    let fields = FIELD_REQUIREMENTS
        .iter()
        // 写着「关」（false）不算用到：内核缺省就是关，没有这项能力的内核会把不认识的键直接忽略，结果一样。
        // 只有开着才需要这项能力（不然开了也不起作用）；安装包自带的配置就写着 false，不能因此挡住更新或回退
        // Written as off (false) does not count as used: off is the kernel's default, and a kernel without the capability ignores the
        // unknown key, with the same result. Only on needs the capability (otherwise it would silently do nothing); the shipped config
        // writes false, which must not block an update or rollback
        .filter(|requirement| {
            content
                .pointer(requirement.pointer)
                .is_some_and(|value| value != &Value::Bool(false))
                && requirement
                    .parent
                    .is_none_or(|parent| content.pointer(parent) == Some(&Value::Bool(true)))
                && !supports(capabilities, requirement.capability)
        })
        .map(|requirement| requirement.label)
        .collect::<Vec<_>>();
    let cname = config_uses_action(content, "static_cname_response")
        && !supports(capabilities, CONFIG_STATIC_CNAME_RESPONSE_V1);
    if fields.is_empty() && !cname {
        Ok(())
    } else {
        Err(UnsupportedConfigFields { fields, cname })
    }
}

fn config_uses_action(content: &Value, action_type: &str) -> bool {
    content
        .get("background_refresh_rule")
        .is_some_and(|rule| rule_uses_action(rule, action_type))
        || content
            .get("pipelines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|pipeline| pipeline.get("rules").and_then(Value::as_array))
            .flatten()
            .any(|rule| rule_uses_action(rule, action_type))
}

fn rule_uses_action(rule: &Value, action_type: &str) -> bool {
    const ACTION_FIELDS: [&str; 3] = [
        "actions",
        "response_actions_on_match",
        "response_actions_on_miss",
    ];
    ACTION_FIELDS.iter().any(|field| {
        rule.get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|action| action.get("type").and_then(Value::as_str) == Some(action_type))
    })
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

fn supports(capabilities: &[String], required: &str) -> bool {
    capabilities.iter().any(|capability| capability == required)
        || (required == CONFIG_QUERY_STATS_V1
            && capabilities
                .iter()
                .any(|capability| capability == LEGACY_STATS_TOP_V1))
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
    use serde_json::json;

    use super::{
        CONFIG_QUERY_STATS_V1, CONFIG_STATIC_CNAME_RESPONSE_V1, canonical_runtime_capabilities,
        ensure_config_supported, validate_declared_capabilities,
    };

    #[test]
    fn rejects_controlled_fields_without_capability() {
        let error =
            ensure_config_supported(&json!({"settings": {"statistics_enabled": true}}), &[])
                .unwrap_err();
        assert!(error.to_string().contains("启用查询排行"));
    }

    // 上一级关着时，依附它的开关写着 true 也不需要能力：v3.4.0 写下的配置可能就是这样，更新或回退不该被一个看不见的设置挡住
    // With its parent off, a dependent switch written as true needs no capability: a config written by v3.4.0 may hold exactly that, and an update
    // or rollback must not be blocked by a setting whose row is hidden
    #[test]
    fn ignores_dependent_switches_whose_parent_is_off() {
        let content = json!({"settings": {"statistics_enabled": false, "statistics_anonymize_client_ip": true}});
        assert!(ensure_config_supported(&content, &[]).is_ok());
        let on = json!({"settings": {"statistics_enabled": true, "statistics_anonymize_client_ip": true}});
        assert!(ensure_config_supported(&on, &[]).is_err());
    }

    // 关着的开关不需要能力：安装包自带的配置写着 false，更新或回退到没有统计的内核不该被挡
    // A switch that is off needs no capability: the shipped config writes false, and updating or rolling back to a kernel without statistics must not be blocked
    #[test]
    fn accepts_controlled_switches_that_are_off() {
        let content = json!({"settings": {"statistics_enabled": false, "statistics_anonymize_client_ip": false}});
        assert!(ensure_config_supported(&content, &[]).is_ok());
    }

    // 两类都有时一句话：主语和出路各说一次 / Both kinds in one sentence: subject and remedy each said once
    #[test]
    fn both_kinds_read_as_one_sentence() {
        let content = json!({
            "settings": {"statistics_enabled": true},
            "pipelines": [{"id": "default", "rules": [{"actions": [{"type": "static_cname_response", "target": "origin.example."}]}]}]
        });
        let message = ensure_config_supported(&content, &[])
            .unwrap_err()
            .to_string();
        assert_eq!(
            message,
            "这个内核不支持：启用查询排行、CNAME 回答。关掉「启用查询排行」、把写成域名的回答改成 IP，或者换用支持它们的内核"
        );
    }

    #[test]
    fn accepts_formal_and_legacy_capabilities() {
        let content = json!({"settings": {"statistics_enabled": true}});
        assert!(ensure_config_supported(&content, &[CONFIG_QUERY_STATS_V1.to_owned()]).is_ok());
        assert!(ensure_config_supported(&content, &["stats_top_v1".to_owned()]).is_ok());
    }

    #[test]
    fn ignores_fields_that_are_not_present() {
        assert!(ensure_config_supported(&json!({"settings": {}}), &[]).is_ok());
    }

    #[test]
    fn requires_static_cname_capability_in_every_action_stage() {
        for field in [
            "actions",
            "response_actions_on_match",
            "response_actions_on_miss",
        ] {
            let content = json!({
                "pipelines": [{
                    "id": "default",
                    "rules": [{ field: [{ "type": "static_cname_response", "target": "origin.example." }] }]
                }]
            });
            let error = ensure_config_supported(&content, &[]).unwrap_err();
            assert!(error.to_string().contains("CNAME 回答"));
            assert!(
                ensure_config_supported(&content, &[CONFIG_STATIC_CNAME_RESPONSE_V1.to_owned()])
                    .is_ok()
            );
        }

        let background = json!({
            "background_refresh_rule": {
                "actions": [{ "type": "static_cname_response", "target": "origin.example." }]
            }
        });
        assert!(ensure_config_supported(&background, &[]).is_err());
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
