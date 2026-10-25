# 测试、性能预算与验收证据

日期：2026-10-25。以下 **58 个编号构成目标验收矩阵，不是已全部通过的测试数**。当前运行的既有/新增测试及范围见实施记录；原始协议、真实引擎、迁移和跨平台目标尚未全部实现。

## 1. 证据分级与测试边界

| 级别 | 证据 | 不能证明什么 |
| --- | --- | --- |
| E1 | 源码/文档静态阅读、类型与路径核对 | 运行正确、性能达标 |
| E2 | 纯 reducer/schema、去重/能力/分页规则测试 | 实际进程和持久恢复 |
| E3 | 原始协议 replay + 真实 adapter + 临时 repository/journal + 主端/客户端集成 | 供应商当前服务真实行为 |
| E4 | 明确授权的真实 Agent、隔离 profile、真实 Electron UI | 所有平台或新版本一直可用 |
| E5 | 目标平台生产安装包、升级/降级、灰度证据 | 未测试平台和不同文件系统的耐久性 |

正常 CI 使用 synthetic fixtures，不调用付费模型、不读取用户会话和系统凭据。真实协议录制须先授权与脱敏；raw debug 内容默认本地保存、设容量/有效期，不上传产品遥测。使用临时目录时，Windows 清理前校验绝对目标位于本次 fixture 根内；不得删除用户项目或跟随 junction 清理外部目录。

## 2. Workload 与采样

### 2.1 可重复数据集

| 数据集 | 每个被测长会话的最终消息数 | 目标源 JSONL 字节 | 会话目录规模 | 主要用途 |
| --- | --- | --- | --- | --- |
| S | 200 | 约 2 MiB | 20 个摘要 | 日常会话 |
| M | 2,000 | 约 20 MiB | 200 个摘要 | 长会话与切换 |
| L | 10,000 | 约 100 MiB | 1,000 个摘要 | 极端历史和冷索引 |
| X | 复用 M | 另含单个 2 MiB 消息/输出、图片引用 | 200 | 大项分块、编码与预算 |

源字节是 UTF-8 编码后实际文件体积，生成器允许 ±5% 并记录精确值。目标体积包含 header 和同 ID 更新记录，**不是净文本体积或 JS heap**。生成数据包含中文、emoji、长代码块、工具结果、子 Agent、旧 schema 缺失字段及 20% 消息的追加更新；固定 seed、内容 hash 和可验证的最终折叠结果。不同并发场景复用确定的文件拷贝，不能在一次 A/B 中改变数据。

并发档位：单会话；4 个运行会话（1 前台 + 3 后台）；10 个运行会话（2 分屏 + 8 后台）。replay 总文本输入分别为 20、100、500 delta/s，明确是**每环境合计**，附控制事件/审批/终态；不把这些负载宣称为实际供应商吞吐。连续流式压力 10 分钟，再空闲 5 分钟测释放；来回切换 50 次测泄漏趋势。

### 2.2 采样纪律

- 同一 CPU/内存/磁盘/OS、应用 commit、Electron 版本、窗口尺寸、缩放、主题和构建模式；A/B 交错，禁用无关后台任务。
- 热场景先预热 5 次，再至少 60 次有效样本，记录 p50/p95/max；p95 用 nearest-rank，保留每次原始值。
- 冷分两类：进程冷/缓存冷（重新开隔离 profile 或失效派生索引），不伪称 OS page cache 已清空。不擅自执行系统清缓存命令。
- 开发模式用于诊断，生产构建用于验收；profile 主进程、renderer、worker 与 Agent 子进程分开报告。
- 首屏以真实内容可交互 paint 为终点，不以骨架屏或 IPC 返回为终点。流式延迟从收到 provider frame 到 paint，不包含远端推理时间。
- UI 演示、微基准、回放集成、真实 Provider 各自报告，不能相互替代。

### 2.3 初始性能预算（待 G0 冻结，不是已测结果）

| 指标 | 初始预算 / 正确性约束 |
| --- | --- |
| 热切换 M / L 到首个有效历史窗口 | p95 ≤ 300 ms / 700 ms；同时报告底层读字节、decode 和 render 分段 |
| 已有索引的历史页读取 | ≤100 条或 ≤1 MiB UTF-8 wire JSON，先达者截止；超大正文改 ref/chunk，不能任意突破 |
| 页面控制信息 | 不随全部历史正文增长；页外控制元数据另限 64 KiB，超过须分批/有界读取 |
| summary 首屏（1,000 个目录项） | 使用分页/有界摘要；单响应 ≤512 KiB，无正文/内联附件；不从历史全量解析生成摘要 |
| 固定历史、一次尾消息变更 | 序列化消息数只随 dirty 集合增加；结构性 full fallback 单独统计；不得丢更新 |
| 100 delta/s 总输入的可见流 | 收到帧到 paint p95 ≤100 ms；审批/终态不能被输出队列饿死 |
| 主端事件循环 | 100 delta/s 场景 p95 delay ≤20 ms；需与基线/机器信息一起解释 |
| 长会话虚拟化 | 非活动历史不随每个 token 重渲染；DOM 行数受视口+overscan 控制，而不是固定宣称 20 个 |
| 缓存/订阅 | 活跃订阅数符合视图引用计数；空闲释放后无单调增长；缓存限额记录编码/估算口径，不当作 RSS 上限 |
| 不相关路径回归 | 相同 workload 的 p95 或峰值资源不得无解释恶化 >10%；显著噪声时补样本/重复批次，不择优挑结果 |

预算既看绝对目标，也看基线。若现状优于目标，不允许以“仍达标”为由接受显著退化；若目标在指定设备不合理，必须在优化实验前公开修订 ADR 与理由。**冷索引构建不受热页首屏预算约束，但必须报告总耗时、峰值内存、字节、进度、取消响应和恢复能力。** 不要求冷构建常数时间。

## 3. 耐久、完整性与安全承诺

G1 应冻结部署实际支持的故障级别：

| 数据类别 | 目标要求 |
| --- | --- |
| 已返回 accepted 的用户输入、Run 与命令回执 | 在承诺的进程崩溃级别 RPO=0；外部派发前完成耐久记录 |
| 审批决定、终态、删除/替换/迁移屏障 | 不丢失已确认状态；未知 native 执行结果保持 unknown，不变成可自动重试 |
| 尚未 acknowledged 的输入 | UI 保留为未确认；以原 ID 查询，不能视为已执行或自动生成新 ID |
| 纯显示流式文本 | 区分 liveSeq 与 durableSeq；允许合并。managed 模式目标按不长于现有 5 秒 checkpoint 上界持久化，终态/审批前 flush；故障损失范围须说明 |
| 未发送草稿 | 客户端本地状态；未经单独实现/验证不承诺跨退出恢复 |
| 工具输出 | 截断/丢失/部分载入显式标注；不能影响工具成功/失败和审批事实 |

`fs.write`/rename 完成不自动等于断电耐久。若产品声明 OS 崩溃/断电可恢复，需针对所选后端验证 flush/fsync、目录项、WAL/同步参数与目标文件系统，并在 E5 报告；没有这类测试只能承诺已验证的进程崩溃范围。外部工具副作用不在本地事务内，严格 exactly-once 不作为承诺。

## 4. 用例矩阵

### 4.1 身份与领域映射

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| ID01 | 同逻辑会话多次恢复/更换 runtime | AppThread 不变，runtime generation 递增；旧事件不能污染新状态 |
| ID02 | 不同项目/引擎同 native ID、显式 fork、旧无 turnId 历史 | 不误合并；legacy run 标为未知来源；fork/转交显式关系 |
| ID03 | 替换链、归档、TaskRun、workspace 迁移 | 身份映射完整、墓碑有效、任务不被自动验收、cwd 不漂移 |

### 4.2 命令与持久化

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| CMD01 | 相同 commandId/payload 连续、并发和重启后提交 | 一份回执/用户消息/Run；最多一次原始派发 |
| CMD02 | 同 ID 不同 payload、相同文本不同创作 ID | 前者冲突，后者按用户意图成为两个有序 Run；不按内容去重 |
| CMD03 | ack 丢失、客户端超时/重连 | 查询原回执；同一消息乐观占位收敛，不产生新命令 |
| CMD04 | 原子提交前后 kill、磁盘满、worker 无响应 | 未提交不返回 accepted/不派发；已接受输入恢复后存在 |
| CMD05 | 外部派发后、终态落盘前 kill | 原生核对或 unknown；不自动重放有副作用操作 |
| CMD06 | journal 已提交/JSONL 未写、JSONL 已写/watermark 未写 | 重放幂等；消息正文/顺序正确，watermark 不领先内容 |
| CMD07 | profile 并发启动、lease 到期/假死、日志保留/损坏 | 同 profile 单 writer；未知存储不能自动重建空库后接受重复请求 |
| CMD08 | 删除/替换/迁移后迟到发送、保存、重试或审批 | 明确拒绝，不能复活会话或回调新 generation |

### 4.3 生命周期与竞态

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| LIFE01 | 两个 pane 同时 create/resume；启动前/握手中取消 | 一个逻辑启动 owner；取消后不残留进程或迟到发送 |
| LIFE02 | root 正在运行，子 Agent/工具先完成/失败 | root 仅由其合法终态关闭；节点关联保留 |
| LIFE03 | interrupt 请求成功但终态迟到，stop 失败 | 展示中断请求中；失败不释放占用并启动重复进程 |
| LIFE04 | 最小化、无 renderer、重载、两 pane 交接 | managed 继续接收/保存/处理队列；客户端恢复从一致快照开始 |
| LIFE05 | 同请求两次审批、两端不同决定、旧 callback | CAS 一个决定；过期/旧 generation 不调用新回调 |
| LIFE06 | 记忆预检中删除、认证返回时取消、迟到模型切换 | 每个 await 后验证 owner/generation，不能继续发送 |
| LIFE07 | UI 重试、主端重试、SDK 自带重试同时触发 | 只有主端应用重试 owner；保留尝试计数，unknown 不自动再执行 |
| LIFE08 | 队列取消、显式再次发送、同 thread 与跨 thread 并发 | 同 thread 有序且一个 root；跨 thread 可并行，无饿死 |

### 4.4 能力与降级

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| CAP01 | capability unknown/握手前/版本变更 | UI 保守展示，主端拒绝不确定操作；新 generation 重新探测 |
| CAP02 | 无 resume/native fork | 用户明确选择文本迁移，标注范围/遗漏；不冒充原生续接 |
| CAP03 | 无原生 steer/interrupt | 队列或明确破坏性降级；不会无提示杀进程 |
| CAP04 | 无图片、结构化问题或工具审批能力 | 草稿/附件保留并解释原因，不丢附件或自动允许 |
| CAP05 | 文件回滚可用而原生上下文回滚不可用、共享 worktree 仍有运行 | 结果分开显示；divergence 明确；冲突时不覆盖用户或其它会话修改 |

### 4.5 协议回放

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| REP01 | 三引擎原始帧到完整会话 | 真实 adapter/reducer/store 链路，出站请求与持久结果一致 |
| REP02 | NDJSON/UTF-8 分块、多帧同块、畸形帧 | parser 行为与错误边界可复现；不串会话，不执行错误帧 |
| REP03 | 重复/乱序/迟到消息和终态 | 控制不变量成立；无法关联时明确诊断，不错误结束 root |
| REP04 | 固定时钟/随机数重复回放 | 除明确非确定字段外结果一致；不靠任意 sleep 等事件 |
| REP05 | fixture 版本、脱敏与工具正文 | 关联保持；不含凭据/真实用户内容；synthetic 与真实录制有标识 |

### 4.6 性能与数据处理

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| PERF01 | S/M/L 基线与分段埋点 | 有原始样本、编码字节、构建/硬件、分段耗时，不含模型延迟 |
| PERF02 | 保存中后台嵌套 tool 更新与持续尾文本 | dirty 版本不漏；与完整基准快照逐 ID/正文一致 |
| PERF03 | 无变更 checkpoint、变更 1 条/多条、重排/full fallback | 快路随 dirty 规模；fallback 可追踪，保留安全检查 |
| PERF04 | 大历史热页和失效索引冷构建 | 热页无全文读取；冷扫描 worker 有界内存、进度和取消 |
| PERF05 | 100/500 delta/s 与控制事件并发 | 完整终态、审批及时；记录极限负载退化，不静默丢控制 |
| PERF06 | 50 次切换/10 分钟并发后空闲 | cache、订阅、进程按预期释放；无持续增长或错误回收 |
| PERF07 | 1/4/10 会话、分屏、展开/折叠大工具输出 | 读取随订阅变化；折叠不终止工具；UI 符合预算 |
| PERF08 | 结构缓存、历史行、滚动锚点、bundle/主线程 | 旧消息不随 token 全量重渲染；非目标路径无显著回归 |

### 4.7 分页与输出

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| PAGE01 | 同消息多次 JSONL 更新、旧无 ID 记录 | 最终内容和原顺序正确；旧记录生成稳定只读定位，不改源 |
| PAGE02 | 翻页同时追加/更新、snapshot 与 live 接缝 | 无缺失/重复；cursor 水位一致，重复事件幂等 |
| PAGE03 | 压缩/替换/删除/profile 变化后复用旧 cursor | 显式失效/重取快照，不能读取其他线程或已删除来源 |
| PAGE04 | 超大消息、2 MiB 输出、UTF-8 chunk 边界 | 限额有效且内容可完整恢复；partial 有标识，复制/导出完整 |
| PAGE05 | 打开一页后自动保存/续聊 | 页对象不可全量覆盖；legacy hydrate 或 managed patch 明确选择 |
| PAGE06 | prepend、搜索定位、历史未载入时统计 | 滚动锚点稳定；使用权威摘要，不把窗口统计当全量 |
| PAGE07 | 断线仅保留 cursor、旧异步页晚返回 | 缺投影必须 resnapshot；旧 epoch 不覆盖新状态 |

### 4.8 迁移与回退

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| MIG01 | 旧 JSON、JSONL、meta 过期、损坏尾、多个 alias | 可读内容保留且损坏显式，不误认证完整；原源备份可验证 |
| MIG02 | 每个迁移阶段中断/退出/磁盘满 | manifest 可恢复，无双 writer；冻结失败保持旧模式 |
| MIG03 | 新 writer 生效后旧客户端/缺 generation 写入 | save/append/meta/send/resume/retry/approval 全部 fencing |
| MIG04 | 准备/已提交删除与 journal replay 并发 | 墓碑胜出，不复活；部分清理可按原身份重试 |
| MIG05 | 正常回退、不兼容格式、回退时仍有执行 | 先收束/导出/校验；不兼容只读，不借旧备份重放外部副作用 |
| MIG06 | 单 profile 双进程、profile 切换、缓存复用 | 互斥和命名空间有效，无凭据/历史跨 profile 混用 |
| MIG07 | 用户元数据、项目工作目录、兼容标识 | 标题/归档/workspace 保留，用户仓库不被迁移删除，legacy 名称不变 |

### 4.9 现有业务和实际平台

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| INT01 | 已有单测/typecheck/build | 基线失败与新失败区分；打包不能冒充类型通过 |
| INT02 | 三引擎真实发送/续接/停止/审批或问答 | 按当前实际支持能力验证；E4 版本、费用授权与限制记录 |
| INT03 | Task/验收、MCP、记忆、项目应用与 usage | 每项副作用发生一次；计量不重复，Run 完成不自动验收任务 |
| INT04 | 历史/语义搜索、worktree、导出、前后台/分屏、退出 | 定位/源数据/权限正确；flush 失败不静默退出 |
| INT05 | Windows/macOS/Linux 声明支持平台的安装/升级/降级 | 子进程、编码、worker/原生依赖、退出与 profile 路径实际验证 |

### 4.10 可选远程边界

| ID | 场景 | 期望 / 证据 |
| --- | --- | --- |
| REMOTE01 | 第二客户端/断连/重复提交/撤销授权 | 同一 writer 收敛；撤销后禁止读写；网络断线不取消已接收 Run |
| REMOTE02 | 网络默认关闭、scope/路径越权、终端/Git 权限 | 不因本地 IPC 存在而开放权限；另过远程安全与部署门槛 |

## 5. 三引擎覆盖表（执行时逐项填写）

| 验证层 | Claude | Codex | ACP |
| --- | --- | --- | --- |
| 原始 transport replay | 待执行 | 待执行 | 待执行 |
| 主端持久化/崩溃/取消/审批 | 待执行 | 待执行 | 待执行 |
| 无 renderer 的真实进程/SDK | 待授权与执行 | 待授权与执行 | 指定实际 ACP Agent 后执行 |
| UI + 实际版本 E4 | 待执行 | 待执行 | 待执行 |
| 打包 E5 | 按目标平台 | 按目标平台 | 按目标平台 |

ACP 不是一个行为完全一致的供应商：至少一份支持 load/resume 的 fixture 和一份不支持的 fixture，真实集成记录 agentId/binary/协议版本。某能力不支持时，应验证清晰降级并标记 N/A，而不是跳过后宣称原生能力通过。缺失真实三引擎证据时不能开放全部 Provider 的 managed 模式。

## 6. 可执行入口与已有回归基础

以下命令在当前 package.json 中存在或使用现有测试文件；实际执行结果见 implementation-status.md。先确认依赖和隔离路径，不自动安装 Agent 或访问用户历史。

```powershell
pnpm typecheck
pnpm test
pnpm exec vitest run --config vitest.config.electron.ts electron/src/ipc/session-runtime-races.test.ts electron/src/lib/__tests__/session-repository.test.ts electron/src/lib/__tests__/session-replacement.test.ts src/lib/session/persistence.test.ts src/lib/session/persistence-delta.test.ts src/lib/session/checkpoint-scheduler.test.ts src/lib/background/live-session-state.test.ts src/hooks/session/useBackgroundReaper-races.test.ts
pnpm perf:bench
pnpm perf:smoke
pnpm build
```

现有 persistence-history-guard、session-switch-race、permission-queue、retry、renderer-flush、history 与 session-transfer 测试也应按改动范围加入。`perf:smoke` 的 ChatView 生成数据不验证真实主进程读盘；`perf:bench` 不是本计划完整 workload。不要在新脚本未落地时编造 `pnpm test:runtime` 等已存在命令。当前新增 `pnpm perf:runtime`（编码微基准）和 `pnpm test:runtime-ui`（生成数据 + 生产 worker 的 Electron 只读历史 UI 冒烟，先运行 build）。它们不是完整端到端 benchmark 或三引擎 replay suite；后两者仍待实施。

## 7. 证据报告与发布规则

建议本地证据写到已忽略的 `.cache/runtime-optimization/<run-id>/`；评审结论和脱敏汇总进入本目录，原始 trace 不纳入版本库。报告至少包含：

```json
{
  "schemaVersion": 1,
  "caseId": "CMD01",
  "evidenceLevel": "E3",
  "status": "not-run",
  "commit": "replace-at-execution",
  "platform": "replace-at-execution",
  "buildMode": "production",
  "providerVersions": {},
  "fixtureSeed": "runtime-baseline-v1",
  "rawSamplesPath": null,
  "assertions": [],
  "limitations": ["Example only; not a test result"]
}
```

- 新增业务用例只有运行后才能标 pass；已有历史报告注明日期与基线，不借用通过数。
- 每个存储故障点在确定顺序下至少重复 20 次，全部通过才进入灰度；这不是外部供应商 exactly-once 证明。
- 发现数据丢失、跨会话污染、重复派发、过期审批生效、旧 writer 绕过、删除复活，任何一个均阻断发布。
- 性能收益不能抵消正确性失败；不以截断历史、关闭保存/审批检查、减小测试负载取得“更快”。
- 真实模型、迁移真实 profile、系统安装、打包/发布与远程部署分别需要明确授权；文档交付本身不授予这些操作。
