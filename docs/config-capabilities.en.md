# Configuration capability contract

[简体中文](config-capabilities.md) | **English**

Configuration capabilities are used to determine whether a given KixDNS binary understands a specific configuration field. A capability name describes behaviour. It is not tied to a version number, commit or patchset number.

## Two kinds of declaration

A running KixDNS returns its capabilities in `capabilities` of `GET /v1/health`. The panel's 配置 (Configuration) page uses this to decide whether a field is editable. The backend enforces the check again before pre-validation, save and history restore.

A kernel package that has not been started declares its configuration capabilities in `KIXDNS_CAPABILITIES.json` inside the package:

```json
{
  "schema_version": 1,
  "config_capabilities": [
    "config_bootstrap_v1",
    "config_panel_block_v1",
    "config_qtype_names_v1",
    "config_query_stats_v1",
    "config_serve_stale_ttl_reset_v2",
    "config_static_cname_response_v1"
  ]
}
```

This file is written into `SHA256SUMS` together with the binary and the source description `KIXDNS_SOURCE.json`. The `manifest.json` published by the fork lists the same capabilities. Before download, the panel runs a preflight with the manifest's capabilities. After download, it checks the manifest digest and the in-package digest, confirms that the in-package capabilities match the manifest, and then saves the capabilities to local version manifest v5. When an old kernel package or old local manifest lacks this field, it is treated as having empty capabilities. The panel does not guess from the version number.

## Current registry

| Configuration capability | Controlled fields | Runtime compatibility alias |
| --- | --- | --- |
| `config_query_stats_v1` | No longer controlled: `settings.statistics_enabled` and `settings.statistics_anonymize_client_ip` only have effect on old kernels. The panel no longer offers these two switches and does not block saving because of them (see "Query statistics configuration" in the control protocol) | `stats_top_v1` |
| `config_static_cname_response_v1` | `static_cname_response` in any rule action list (`actions`, `response_actions_on_match`, `response_actions_on_miss`, including `background_refresh_rule`) | None |
| `config_panel_block_v1` | Not controlled, for information only: the top-level `panel` is the block where the panel keeps its whole model, carried by every config the panel saves, and it blocks neither saving nor switching. Kernels before 2026.11.23.11 ignore it; those from 2026.11.23.11 to 2026.11.25.27 refuse it as a key they do not read, so the kernel's `/v1/config/validate` refuses the save and the panel prompts, from that refusal, an update to the latest kernel; kernels with this capability accept it | None |
| `config_bootstrap_v1` | `settings.bootstrap` (引导 DNS, bootstrap DNS), counted whenever it is written, an empty string included. Kernels before 2026.11.23.11 silently ignore it, and up to 2026.11.23.49 they refuse it as a key they do not read | None |
| `config_qtype_names_v1` | A `qtype` or `response_type` matcher value outside the ten types A, AAAA, CNAME, MX, TXT, NS, PTR, SRV, SOA and OPT (in any case; in `pipeline_select`, every rule and `background_refresh_rule` alike), such as HTTPS, SVCB or `TYPE65`. Earlier kernels fail to compile such a config | None |
| `config_serve_stale_ttl_reset_v2` | No longer controlled: old and new kernels both read `settings.serve_stale_ttl_reset`, so it blocks neither saving nor switching. A kernel with this capability defaults it to off, and on it means "once the background refresh of a stale answer fails, the time counts afresh from that failure"; one without it defaults to on, and on means "every stale answer served starts the time again". The settings form goes by it for the default and the wording | None |

`static_cname_response` is an action built into upstream KixDNS (a fixed CNAME answer). The capability only declares that this binary recognises it. The panel's 域名映射 (Domain mapping) and the 固定 CNAME (Fixed CNAME) action both depend on it. When it is not supported, this action and the 域名映射 template do not appear. Existing mappings are kept as they are, and the 域名映射 page prompts to update or switch the kernel first. Field capabilities are checked by JSON Pointer. Action capabilities are checked by the action's `type`. Query types are checked by the values of `qtype` and `response_type` matchers.

Compatibility aliases are used only to identify an old enhanced build that is already running. The preflight for switching to a target version trusts only digest-validated kernel package capabilities or the local version manifest.

## Failure behaviour

- Forms: unsupported actions do not appear. Existing ones are kept as they are, the page prompts to change them or update the kernel first, and the raw JSON is not rewritten. A setting that needs a capability (引导 DNS, bootstrap DNS) does not appear while unwritten; a written one is still listed, with a red note under the box saying the kernel does not read it, and clearing the box leaves it unwritten. One that only changes a default and a meaning (`serve_stale_ttl_reset`) takes its name, note and default from the kernel's capabilities. While KixDNS reports no capabilities, nothing is said by capability.
- Pre-validating, saving or restoring an incompatible configuration: returns `422 unsupported_config_fields`, naming every missing item at once in registry order, one remedy each.
- Installing or switching to an incompatible version: returns the same error before the service is stopped and the binary is replaced.
- Capability declaration missing or unreadable: conservatively treated as unsupported. Fields are not silently deleted.

KixDNS's own `/v1/config/validate` remains the final compile validation after the capability check. The capability contract is responsible for stopping old-version Serde from silently ignoring ordinary unknown fields. It cannot replace KixDNS's validation of enums, types and cross-field constraints.

## Adding fields

1. Implement the new field on the fork (to the standard of a PR to upstream). Add a stable `config_<功能>_vN` name to `panel/capabilities.json`, and make health return a capability of the same name.
2. Publish a new dated version. Both the manifest and the kernel package carry the new capability.
3. Add an entry to the central registry `REQUIREMENTS` in `config_capabilities.rs`: the capability, and a function that recognises the writing it controls in a config and gives a one-sentence remedy. If what is added is an action, check by the action's `type`. A capability that only changes a default or a meaning, where old and new kernels run the same config, stays out of this table and serves the form only.
4. Declare `requiresCapability` in the frontend field schema. Set `legacyCapabilities` only when an old runtime really does have an equivalent signal.
5. Add backend reject/accept tests, frontend hide/read-only tests and enhanced runtime contract tests.
6. Published versions and installed binaries keep their original identity.

While a capability's semantics stay the same, later versions may keep declaring it. When the semantics or the configuration structure become incompatible, add a new capability version and do not reuse the old name.
