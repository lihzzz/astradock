# 实施边界与当前结果（2026-10-25）

## 1. 分支和隔离

- 分支：`codex/runtime-optimization`。
- 基线：`42e2e641292ba3af607dc8452eb6b1be39fceead`，从原 `hy_dev` 的已提交状态创建独立 worktree。
- 未复制原工作区另一个 agent 的业务改动，只复制本优化方案；根 README / ignore 规则在新 worktree 单独补入。
- 本分支尚未合并。当前是**部分实现，不是全部 11 个工作包完成**。

## 2. 已接入实际桌面的功能

### 保存编码复用

[message-wire](../../shared/lib/runtime/message-wire.ts)已接入[saveSessionSmart](../../src/lib/session/persistence.ts)。用不可变结构见证检测原地/嵌套修改，复用未改变消息的编码结果；getter、toJSON、非普通对象走原编码路径。排队保存仍捕获当时版本，保存失败、revision、删除/替换屏障和完整历史检查未删除。

**与原设计的区别：**当前仍扫描历史字段，准备阶段不是严格 O(delta)；优化的是长字符串重复编码和分配，不是用对象引用冒充内容未变。没有把所有三引擎写入点改成显式 dirty revision。游标继续受 20 个会话/16 MiB 估算预算约束，并保守增加结构见证的预算权重；超出预算的长会话会退回完整准备路径。微基准直接测试有可复用见证的算法，不能据此声称所有 100 MiB 会话的实际保存已加速。

### 只读分页历史

侧栏会话菜单新增“分页历史”，延迟加载独立对话框。它不是主聊天区的替代品，也不自动把主聊天加载/续聊改为分页。

- 主端验证来源和 renderer 身份，按当前有效会话确定读路径；异步读后复核 revision、删除与 repository 身份。
- SQLite 派生索引在独立 worker 构建。热页读取不全文读 source；同消息 ID 按现有 JSONL 规则取最终值，缺 ID 记录有稳定只读 key。
- 页面上限 100 项/1 MiB；大项用按需 base64 chunk，保留 UTF-8 重组能力。只保留一页及当前输出段，虚拟化渲染。
- epoch 与真实 source 文件指纹绑定；追加/替换使旧 cursor 失效。损坏记录显式计数，不将不完整结果标为完整。
- 派生库损坏可重建；缓存上限 6 个库/256 MiB 目标，读取时清理旧库。删除/替换会使 reader 失效并清理自身缓存，清理不递归遍历用户目录。
- 当前安全上限：JSONL 源 128 MiB、单记录 32 MiB，旧 JSON 32 MiB；超出时显式拒绝，原有完整打开/导出路径保留。这些上限不是完整方案所有极端数据已支持的声明。
- 对话框不提供 save/send，页对象与 PersistedSession 类型分离，不能覆盖未加载历史。

## 3. 已有代码但没有接管生产链路的部分

[运行时契约](../../shared/types/runtime.ts)、[状态机](../../shared/lib/runtime/state.ts)、[能力四态](../../shared/lib/runtime/capabilities.ts)、[命令账本](../../electron/src/lib/runtime/journal.ts)、[控制存储](../../electron/src/lib/runtime/control-store.ts)及[无窗口协调内核](../../electron/src/lib/runtime/coordinator.ts)已有隔离测试。

内核覆盖 command/payload 去重、principal 作用域、revision/generation 拒绝、一个活动 root、排队、审批 CAS、未知执行不自动重试、root 终态与中断确认分离。协调器依赖注入的 ProviderRuntimeAdapter；测试使用本地替身，**没有接入真实 Claude/Codex/ACP SDK/进程，没有替换现有发送、审批、自动重试和持久化 owner**。

账本一个 frame 原子记录相关控制实体，写入后 sync 再接受；完整损坏 fail-closed，未确认尾帧可裁剪。当前 64 MiB 容量上限，无生产压缩策略；stale writer lock 不自动抢占，异常退出的离线锁恢复尚未完成。测试中的“重新打开”主要通过释放句柄再重建存储验证持久状态，不能当作操作系统 kill/断电已通过。journal 与实际会话 JSONL 的事务外幂等桥接、迁移/fencing 均尚未接通。

## 4. 验证口径

基线类型检查通过；Electron 运行文件补齐后，基线为 191 个测试文件通过、4 个跳过，1,409 项通过、19 项跳过。第一次失败是新 worktree 使用 ignore-scripts 后缺少 Electron 可执行文件，不作为业务回归。

当前运行结果与数字见[状态记录](implementation-status.md)。已运行的类型、全量 Vitest、构建和生成数据 UI 冒烟均与三引擎真实服务、安装包和数据迁移验收分开报告。

本地证据在 `.cache/runtime-optimization/`：baseline/final 日志、wire-benchmark.json、history-ui.json、history-ui.png。目录不纳入版本控制，汇总结论留在文档。


### 本机编码微基准（60 样本，5 次预热，交错 A/B）

| 数据集 | 消息数 / UTF-8 体积 | 原编码 p50 | 复用见证 p50 | 原编码 / 复用 p95 |
| --- | --- | --- | --- | --- |
| S | 200 / 2.00 MiB | 2.71 ms | 0.16 ms | 4.80 / 0.52 ms |
| M | 2000 / 20.00 MiB | 39.71 ms | 4.37 ms | 52.14 / 10.62 ms |
| L | 10000 / 99.99 MiB | 243.18 ms | 29.24 ms | 327.26 / 38.20 ms |

环境：Windows、Node v22.22.2、AMD Ryzen 7 9800X3D 8-Core Processor、约 32 GiB 内存。每次只修改末条文本，原地嵌套修改另有正确性测试。机器上另有 agent 工作，未强行暂停其任务；此表是局部方向性证据，不是独占机器的发布 SLA。大数据集超过实际 renderer 游标预算时会 fallback，因此这些数字不能直接推广为整应用保存/首屏的加速倍数。

## 5. 仍需完成的主要内容

1. 完整三引擎原始协议 replay transport 与真实 normalizer→repository 链路。
2. 实际 ProviderAdapter、无 renderer 会话投影/正文保存/问答/审批/队列与中断控制。
3. journal→JSONL 幂等应用、watermark、独占启动与自动重试 owner 的实际切换。
4. profile 迁移/回退工具、旧入口全面 writerGeneration fencing，原生进程崩溃恢复和锁恢复。
5. 主聊天区与侧栏的共享 RuntimeClient、活动流和工具输出订阅，而不只是只读分页窗口。
6. S/M/L 完整应用链路 p95、缓存失效、真实引擎和跨平台产物验证。
7. 可选远程仍需独立授权，不因本分支出现客户端端口就默认开放网络。

这些工作不能用“已添加接口/测试”代替。后续仍在本分支推进，全部目标完成并通过门槛后再评审合并。
