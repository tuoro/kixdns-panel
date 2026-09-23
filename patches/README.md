# 增强补丁

`sets/<编号>/` 保存不可变的版本化补丁集，锁文件中的 `patchset` 只读取对应编号。上游源码不进入本仓库；`cargo xtask prepare` 会检出到 `.upstream/kixdns-<source>-<commit>-p<patchset>`（有依赖修订时再加 `-r<修订号>`，可用 `cargo xtask checkout-dir` 查询），以 `git apply` 重放所选集合中的补丁，最后应用锁文件指定的依赖修订。工具使用来源、补丁版本和内容 SHA-256 标记完整补丁集，支持幂等执行并拒绝混用不同内容。

~~~text
sets/27/
  capabilities.json               # Artifact 配置能力声明
  common/                         # 该补丁集的增强实现，所有上游共用
  compatibility/<名称>/           # 锁文件显式选择的前置兼容层：某一份上游特有的写法和依赖锁
  release/<tag>/                  # 对应正式版的可选前置补丁
~~~

补丁按“兼容层、Release 专用层、通用层”的顺序应用。补丁集一旦进入主分支即被封印：CI 拒绝修改已有编号，只允许新增更高编号。没有任何锁引用的补丁集可以删除（Git 历史保留），但编号不回退，最高编号要等更高的补丁集出现后才能删。新增补丁集不会进入旧锁的输入指纹，因此不会重新构建历史增强版。

## 编号的含义

编号表示增强补丁的版本，Action 与 Release 两条轨道共用：同一份增强内容只有一个编号，不同上游写法不同的部分放进各自的兼容层，由锁文件的 `compatibility` 选择。p27 就是这样：通用层是两条轨道一字不差的增强实现，`compatibility/split-main/` 是 Action 上游（同步 `main` 加 `async_main`）的入口改动与依赖锁，`compatibility/tokio-main/` 是 `v0.2.0`（`#[tokio::main]`）的。

Release 从上游 `main` 切出，Action 轨道天天跟着 `main`，所以 Release 的编号不应超过 Action：增强内容相同时同号，新功能先上 Action 时 Action 的号更大，Release 跟上后再同号。版本本身的新旧由上游身份（Run 编号、Release 标签）表达，面板的排序和更新提示也只按上游身份比较。

为了让另一份上游沿用同一个编号，封印有一个例外：已封印的集合可以新增一个**名字未用过**的兼容层目录。已有的锁不会选中新名字，已有构建因此不变。往已有兼容层里加文件、新增 `release/<tag>/`（按标签自动选中）以及任何修改或删除，都会改变已有构建，仍然只能新增更高编号。

手工修改增强功能时的补丁更新流程：

1. 从当前补丁集复制出更高编号，例如从 `sets/22/` 创建 `sets/23/`；不要修改 `sets/22/`。
2. 使用指向新编号的候选锁准备 `.upstream/kixdns-<source>-<commit>-p<patchset>`，并在检出源码中完成修改。
3. 对新增文件执行 `git add -N <file>`，使用 `git diff --binary --output=<新补丁路径>` 重新生成新集合中受影响的补丁。
4. 新增配置字段时同步更新 `capabilities.json`、增强 health 声明和面板的集中能力注册表；不要根据版本号推断字段支持。
5. 在干净检出中运行 `cargo xtask prepare --lock <候选锁>`，再执行格式、测试（`cargo test --lib` 与 `cargo test --bin kixdns`，`main.rs` 里的测试只在后者执行）、Clippy、RustSec 和 DNS 冒烟检查。
6. 同一拉取请求提交新补丁集、候选锁和对应版本目录；旧锁和旧补丁集保持不变。
7. 增强内容两条轨道都要时，同一个新编号同时给两个锁：共同的改动进通用层，只对某一份上游成立的部分（入口写法、依赖锁）进各自的兼容层。

补丁不是手工维护的源码副本。修改增强功能时应编辑检出源码并重新生成补丁，避免补丁内容与已验证代码不一致。

## 上游自动重基

同步任务按 Action、Release 两条轨道独立验证。新 Release 从上游 `main` 切出，先试 Action 轨道的补丁集，再试 Release 自己的。当前补丁集不能精确应用或其锁文件未通过 RustSec 审计时，工作流执行 `cargo xtask rebase --lock <候选锁> --base-commit <当前提交>`：

1. 从版本目录找到当前提交及其补丁集，把兼容层、Release 专用层和通用层依次重建为临时 Git 提交链。
2. 重建提交时排除所有 `Cargo.lock` 差异，避免依赖锁文件的行号和版本变化制造无意义冲突。
3. 把临时提交链 rebase 到候选上游；已经被上游吸收的空提交会被丢弃，Release 专用补丁会映射到新标签。
4. 删除候选锁文件并使用固定 Rust 工具链重新解析依赖，把结果作为通用层最后一个补丁。
5. 复制能力清单、导出更高编号的暂存补丁集，通过密封校验后才同时启用新补丁集和候选锁。
6. 对新源码树运行格式、测试（库与 `kixdns` 二进制）、Clippy、RustSec、构建和 DNS 冒烟；全部成功后才提交审计 PR 并自动合并。

自动重基总是导出一个更高的新编号，只给当前轨道用。Action 先重基时 Action 的号更大，符合上面的编号含义；Release 单独重基时它的号会超过 Action，这时应人工改为在 Action 当前的补丁集里新增兼容层（见封印例外），让两条轨道同号。

整个生成过程使用暂存目录；失败时不会写入半个补丁集或切换当前锁。基础设施或工具错误只会让 Action 失败，不创建兼容性告警。只有 Git rebase 报告代码冲突、依赖无法解析或完整验证失败时，工作流才创建或更新对应的 `[compat]` Issue；同一轨道只保留一个开放告警。失败候选不会进入 `upstreams/`，另一条轨道和已发布 Artifact 不受影响。

## 依赖修订

上游不动时，已锁定版本的依赖也可能出现 RustSec 公告。依赖修订在补丁集之后再调整 `Cargo.lock`，不用新建补丁集，也不用等上游：

~~~text
dependencies/<source>/<上游身份>/p<补丁集>-r<修订号>.patch
~~~

- 锁文件用可选的 `dependency_revision` 选择修订。修订是相对补丁集应用后那份 `Cargo.lock` 的差异，只能改 `Cargo.lock`。每个修订都从补丁集的锁算起，同一时间只应用一个。
- 修订进入 Artifact 输入指纹，名称格式不变，已安装的面板照常解析。
- 修订合并即封印，新修订编号必须更高。不再被锁引用的修订随版本目录清理删除。

`cargo xtask refresh-dependencies --lock <锁文件> --advisory-db <RustSec 数据库>` 生成下一个修订。公告给出修复版本时，精确升到兼容范围内最低的那一版，必需的传递依赖随之抬高；撤回的版本升到最新兼容版。之后重新审计，仍不通过就报错，从不忽略公告。`cargo xtask audit` 只审计，发现问题时退出码为 3。

同步任务每天审计两条轨道的当前版本。未通过就生成修订，完整验证后自动合并并触发构建。修不了时创建或更新 `[security]` Issue，审计恢复后自动关闭。当前版本以外审计不过的旧版本移出版本目录，已发布的产物到期前仍可安装。

## 需要人工处理的上游不兼容

收到 `[compat]` Issue 表示自动重基已经无法安全完成，处理顺序如下：

1. 从 Issue 取得候选提交和官方 Run 或 Release 身份，基于当前锁创建候选锁；不要先覆盖根目录当前锁。
2. 从 Issue 的冲突文件或验证日志确认失败属于上游 API 变化、依赖约束冲突还是增强语义变化；普通上下文漂移应由自动重基处理。
3. 仅有版本结构差异、增强内容不变时，优先在当前补丁集里新增一个名字未用过的 `compatibility/<名称>/`，给候选锁设置 `compatibility`，编号不变；需要改动已有补丁时才创建新的补丁集编号。
4. 增强逻辑确需适配新 API 时，只修改新集合中的通用补丁。控制协议字段或语义发生不兼容变化时才提升协议版本。
5. 使用候选锁运行 `cargo xtask prepare`，并执行格式、测试（库与 `kixdns` 二进制）、Clippy、RustSec、构建和 DNS 冒烟检查。
6. 通过拉取请求同时提交补丁、候选锁和对应版本目录。Action、Release 构建工作流会在合并前再次验证；主分支匹配上游候选后，兼容性 Issue 会在下次同步时自动关闭。

这种顺序把适配限制在候选版本：旧锁、旧目录和旧 Artifact 保持可复现，面板服务仅在控制协议确实变化时才需要联动修改。

当前补丁集 p27 由两条轨道共用（编号以两个锁文件的 `patchset` 为准；自 p19 起，增强逻辑通过上游的 `EngineObserver` 接口接入，不再修改 `src/engine`、`src/watcher.rs` 或配置加载器）。通用层：

1. `0001-query-stats-config.patch`：查询排行的 `statistics_*` 配置字段及其缓存命名空间参与。
2. `0002-panel-control-socket.patch`：`panel.rs` 以 `EngineObserver` 实现指标（上游耗时另有只算拿到响应的一份）、查询排行、配置摘要与诊断轨迹，`panel_trace.rs` 从观察者事件重建轨迹；`--debug` 时 `panel.rs` 把每个引擎事件转发给上游的 `TracingObserver`，使 `kixdns::observe` 事件日志在增强版中仍然可用。

每个兼容层（`split-main` 给 Action，`tokio-main` 给 `v0.2.0`）各有两个补丁：

1. `0001-panel-entry.patch`：`main.rs` 通过 `Engine::builder` 注入观察者并启动本机控制 Socket，在 journald 下把致命错误压成单行 `<3>fatal: …`、把 panic 压成单行 `<2>panicked at …`，让面板的错误过滤器能看到启动失败的原因。两份上游的入口写法不同，改动内容相同；`tokio-main` 的运行时仍按 `v0.2.0` 的方式构建。
2. `0002-dependency-lock.patch`：用固定工具链为这份上游重新解析的 `Cargo.lock`。

p27 由 p25（Action）与 p26（Release）合并而成，准备出的源码与两者逐字节相同。p9 保持旧结构，供 `v0.1.1` 复现。
