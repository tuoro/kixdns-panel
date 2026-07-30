# 配置能力契约

配置能力用于判断某个 KixDNS 二进制是否理解特定配置字段。能力名称描述行为，不绑定上游版本号、提交或补丁集编号。

## 两类声明

运行中的 KixDNS 通过 `GET /v1/health` 的 `capabilities` 返回能力。面板配置页据此决定字段是否可编辑，后端在预验证、保存和历史恢复前再次强制检查。

尚未启动的 KixDNS Artifact 通过包内 `KIXDNS_CAPABILITIES.json` 声明配置能力：

```json
{
  "schema_version": 1,
  "config_capabilities": [
    "config_query_stats_v1"
  ]
}
```

该文件与二进制、上游锁和构建提交一起写入 `SHA256SUMS`。面板下载后先验证 GitHub Artifact digest 和包内摘要，再将能力保存到本地版本清单 v5。旧 Artifact 或旧本地清单没有该字段时按空能力处理，不根据版本号猜测。

## 当前注册表

| 配置能力 | 受控字段 | 运行时兼容别名 |
| --- | --- | --- |
| `config_query_stats_v1` | `settings.statistics_enabled`、`settings.statistics_anonymize_client_ip` | `stats_top_v1` |

兼容别名只用于识别已经运行的旧增强版。目标版本切换预检只信任经摘要校验的 Artifact 能力或本地版本清单。

## 失败行为

- 不支持且配置中没有字段：表单隐藏该字段。
- 不支持但字段已经存在：表单只读保留，JSON 原文不被改写。
- 预验证、保存或恢复不兼容配置：返回 `422 unsupported_config_fields`。
- 安装或切换到不兼容版本：在停止服务和替换二进制之前返回相同错误。
- 缺少或无法读取能力声明：保守视为不支持，不静默删除字段。

KixDNS 自身的 `/v1/config/validate` 仍是能力检查后的最终编译校验。能力契约负责阻止旧版 Serde 静默忽略普通未知字段，不能替代 KixDNS 对枚举、类型和跨字段约束的验证。

## 新增字段

1. 为新上游候选创建更高编号的不可变补丁集，不修改历史集合。
2. 在新集合的 `capabilities.json` 增加稳定的 `config_<功能>_vN` 名称，并让增强版 health 返回同名能力。
3. 在 `config_capabilities.rs` 的集中注册表中绑定 JSON Pointer、展示字段名和能力。
4. 在前端字段 schema 中声明 `requiresCapability`；仅在确有旧运行时等价信号时设置 `legacyCapabilities`。
5. 补充后端拒绝/接受测试、前端隐藏/只读测试及增强运行契约测试。
6. 只把新候选锁切换到新补丁集。旧锁、旧 Artifact 和已安装二进制保持原身份。

同一能力语义不变时可以被后续补丁集继续声明；语义或配置结构不兼容时新增能力版本，不复用旧名称。
