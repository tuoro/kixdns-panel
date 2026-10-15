use std::fmt;

use serde_json::Value;

pub const CONFIG_QUERY_STATS_V1: &str = "config_query_stats_v1";
pub const CONFIG_STATIC_CNAME_RESPONSE_V1: &str = "config_static_cname_response_v1";
const LEGACY_STATS_TOP_V1: &str = "stats_top_v1";
const MAX_CAPABILITIES: usize = 64;

/// 配置里用到了内核不支持的东西。现在只有一类：写成域名的回答（CNAME）。
/// The config uses something the kernel does not support. Only one kind is left: answers written as a domain (CNAME).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedConfigFields;

// 给一条做得到的出路：CNAME 要改成 IP / One remedy that can actually be done: CNAME answers must become IPs
impl fmt::Display for UnsupportedConfigFields {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "这个内核不支持 CNAME 回答：把回答写成域名的映射和规则改成 IP，或者换用支持它的内核",
        )
    }
}

// 查询排行的两个设置（statistics_enabled、statistics_anonymize_client_ip）不再挡保存：排行一直开着，内核不认识这两个键时直接忽略
// The two ranking settings (statistics_enabled, statistics_anonymize_client_ip) no longer block a save: rankings are always on, and a kernel
// that does not know the keys simply ignores them
pub fn ensure_config_supported(
    content: &Value,
    capabilities: &[String],
) -> Result<(), UnsupportedConfigFields> {
    if config_uses_action(content, "static_cname_response")
        && !capabilities
            .iter()
            .any(|capability| capability == CONFIG_STATIC_CNAME_RESPONSE_V1)
    {
        Err(UnsupportedConfigFields)
    } else {
        Ok(())
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

    // 排行一直开着，这两个设置写成什么、内核报不报能力都不挡：旧版面板写下的配置照样能保存、更新和回退
    // Rankings are always on, so these two settings never block, whatever they say and whatever the kernel reports: configs written by older
    // panels still save, update and roll back
    #[test]
    fn statistics_settings_never_block() {
        let content = json!({"settings": {"statistics_enabled": true, "statistics_anonymize_client_ip": true}});
        assert_eq!(ensure_config_supported(&content, &[]), Ok(()));
    }

    #[test]
    fn names_the_cname_remedy() {
        let content = json!({
            "pipelines": [{"id": "default", "rules": [{"actions": [{"type": "static_cname_response", "target": "origin.example."}]}]}]
        });
        assert_eq!(
            ensure_config_supported(&content, &[])
                .unwrap_err()
                .to_string(),
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
