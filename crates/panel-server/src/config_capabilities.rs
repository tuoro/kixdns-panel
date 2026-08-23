use std::fmt;

use serde_json::Value;

pub const CONFIG_QUERY_STATS_V1: &str = "config_query_stats_v1";
pub const CONFIG_STATIC_CNAME_RESPONSE_V1: &str = "config_static_cname_response_v1";
const LEGACY_STATS_TOP_V1: &str = "stats_top_v1";
const MAX_CAPABILITIES: usize = 64;

struct FieldRequirement {
    pointer: &'static str,
    field: &'static str,
    capability: &'static str,
}

const FIELD_REQUIREMENTS: &[FieldRequirement] = &[
    FieldRequirement {
        pointer: "/settings/statistics_enabled",
        field: "settings.statistics_enabled",
        capability: CONFIG_QUERY_STATS_V1,
    },
    FieldRequirement {
        pointer: "/settings/statistics_anonymize_client_ip",
        field: "settings.statistics_anonymize_client_ip",
        capability: CONFIG_QUERY_STATS_V1,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedConfigFields {
    fields: Vec<&'static str>,
}

impl fmt::Display for UnsupportedConfigFields {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "当前 KixDNS 不支持配置字段：{}；请先切换到声明相应配置能力的增强版本，或移除这些字段",
            self.fields.join("、")
        )
    }
}

pub fn ensure_config_supported(
    content: &Value,
    capabilities: &[String],
) -> Result<(), UnsupportedConfigFields> {
    let mut fields = FIELD_REQUIREMENTS
        .iter()
        .filter(|requirement| {
            content.pointer(requirement.pointer).is_some()
                && !supports(capabilities, requirement.capability)
        })
        .map(|requirement| requirement.field)
        .collect::<Vec<_>>();
    if config_uses_action(content, "static_cname_response")
        && !supports(capabilities, CONFIG_STATIC_CNAME_RESPONSE_V1)
    {
        fields.push("actions.static_cname_response");
    }
    if fields.is_empty() {
        Ok(())
    } else {
        Err(UnsupportedConfigFields { fields })
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
            ensure_config_supported(&json!({"settings": {"statistics_enabled": false}}), &[])
                .unwrap_err();
        assert!(error.to_string().contains("settings.statistics_enabled"));
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
            assert!(error.to_string().contains("actions.static_cname_response"));
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
