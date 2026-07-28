# 增强补丁

该目录按文件名顺序保存针对上游锁定提交的补丁。上游源码不进入本仓库；`cargo xtask prepare` 会检出到 `.upstream/kixdns-<source>-<commit>-p<patchset>`，并以 `git apply` 重放所有通用 `.patch` 文件。工具使用来源、补丁版本和内容 SHA-256 标记完整补丁集，支持幂等执行并拒绝混用不同内容。

`release/<tag>/` 中的补丁只用于对应的正式 Release，并先于通用补丁应用。它只对齐较旧正式版与通用补丁所需的上游基线，不复制增强功能实现，也不会影响未来发布。

补丁更新流程：

1. 在 `.upstream/kixdns-<source>-<commit>-p<patchset>` 中完成并验证修改。
2. 对新增文件执行 `git add -N <file>`，使其进入差异。
3. 使用 `git diff --binary --output=<patch>` 重新生成对应补丁。
4. 在干净检出中运行 `cargo xtask prepare`，再执行格式、测试和 Clippy 检查。

补丁不是手工维护的源码副本。修改增强功能时应编辑检出源码并重新生成补丁，避免补丁内容与已验证代码不一致。

## 上游不兼容处理

每日同步按 Action、Release 两条轨道独立验证。某条轨道失败时，工作流会创建或更新对应的 `[compat]` Issue；同一轨道只保留一个开放告警，内容指向最新失败候选和完整日志。失败候选不会进入 `upstreams/`，另一条轨道和已经发布的 Artifact 不受影响。

处理顺序如下：

1. 从 Issue 取得候选提交和官方 Run 或 Release 身份，基于当前锁创建候选锁；不要先覆盖根目录当前锁。
2. 对比当前已验证提交与候选提交，确认失败属于补丁上下文漂移、上游 API 变化还是增强语义变化。
3. 仅有版本结构差异时，在 `compatibility/<名称>/` 增加前置兼容补丁，并只给候选锁设置 `compatibility`；避免改变其他已验证版本。
4. 增强逻辑确需调整时，只重新生成受影响的通用补丁。控制协议字段或语义发生不兼容变化时才提升协议版本。
5. 使用候选锁运行 `cargo xtask prepare`，并执行格式、测试、Clippy、RustSec、构建和 DNS 冒烟检查。
6. 通过拉取请求同时提交补丁、候选锁和对应版本目录。Action、Release 构建工作流会在合并前再次验证；主分支匹配上游候选后，兼容性 Issue 会在下次同步时自动关闭。

这种顺序把适配限制在候选版本：旧锁、旧目录和旧 Artifact 保持可复现，面板服务仅在控制协议确实变化时才需要联动修改。

当前补丁顺序：

1. `0001-panel-observability.patch`：本机控制协议和内部指标。
2. `0002-config-validation.patch`：复用 KixDNS 解析与运行时编译的候选配置校验。
3. `0003-security-dependency-refresh.patch`：刷新存在 RustSec 公告的依赖，并迁移 MaxMind 与 PEM API。
4. `0004-fast-path-rule-metrics.patch`：补齐编译静态规则与规则缓存快速路径的命中计数。
5. `0005-runtime-safety.patch`：让热加载摘要绑定解析快照，并限制动态指标序列数量与标签长度。
