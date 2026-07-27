# 增强补丁

该目录按文件名顺序保存针对 `upstream.lock.json` 锁定提交的补丁。上游源码不进入本仓库；`cargo xtask prepare` 会检出到 `.upstream/kixdns-<commit>-p<patchset>`，并以 `git apply` 重放所有 `.patch` 文件。工具使用补丁内容 SHA-256 标记完整补丁集，支持幂等执行并拒绝混用不同内容。

补丁更新流程：

1. 在 `.upstream/kixdns-<commit>` 中完成并验证修改。
2. 对新增文件执行 `git add -N <file>`，使其进入差异。
3. 使用 `git diff --binary --output=<patch>` 重新生成对应补丁。
4. 在干净检出中运行 `cargo xtask prepare`，再执行格式、测试和 Clippy 检查。

补丁不是手工维护的源码副本。修改增强功能时应编辑检出源码并重新生成补丁，避免补丁内容与已验证代码不一致。

当前补丁顺序：

1. `0001-panel-observability.patch`：本机控制协议和内部指标。
2. `0002-config-validation.patch`：复用 KixDNS 解析与运行时编译的候选配置校验。
3. `0003-security-dependency-refresh.patch`：刷新存在 RustSec 公告的依赖，并迁移 MaxMind 与 PEM API。
4. `0004-fast-path-rule-metrics.patch`：补齐编译静态规则与规则缓存快速路径的命中计数。
