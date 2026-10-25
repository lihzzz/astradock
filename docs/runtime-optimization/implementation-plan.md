# 多引擎运行时与性能优化：完整实施方案

## 0. 范围、依据与决策摘要

- 日期：2026-10-25，Asia/Taipei。
- 基线：`hy_dev`，提交 `42e2e641292ba3af607dc8452eb6b1be39fceead`，包版本 `0.3.8`。工作区不是清洁副本：开始时已有未跟踪的 `artifacts/`，本次不操作它。
- 证据：当前源码的静态核对与已有项目文档。文件哈希见[代码基线](code-baseline.json)；已有测试的存在不等于本次运行通过。编写期间出现其它并发改动，基线记录工作区读取值而非纯 HEAD，实施前必须复核。
- 目标：把六项借鉴转化为适合 AstraDock 的增量工作，不预设 T3 Code 更快、更稳定或其设计必须照搬。
- 状态：本文是完整目标规格，部分模块已在独立分支实施；实际接通范围与尚未实现项以 implementation-status.md / implementation-evidence.md 为准，不能由接口出现在方案中推断已经交付。

### 0.1 三条工作线

| 工作线 | 成功标准 | 不属于成功标准 |
| --- | --- | --- |
| 性能 | 相同生成数据、硬件和构建模式下，打开/切换/流式渲染与资源开销改善 | 仅换库、拆文件、引入数据库 |
| 可靠性 | 命令、运行、审批在重试/崩溃/删除中保持可验证状态 | UI 显示了“成功”、只有内存去重 |
| 扩展性 | 引擎差异有明确能力契约，客户端不拥有执行状态 | 先建设手机端或自研 Agent |

**固定约束：**不换 UI 框架、不强制采用 Effect、不批量替换三引擎、不更改已有兼容名称、不默认开启网络服务、不安装 Agent 运行时。先测量和冻结语义，再决定存储实现及迁移范围。

## 1. 当前代码已经做了什么

下表的“事实”来自静态阅读；“增量方向”是设计，不是已确认的线上故障。

| 证据 | 已有事实与入口 | 增量方向 / 待验证问题 |
| --- | --- | --- |
| E01 | [session-identity](../../shared/lib/session-identity.ts) 的 `conversationKey` 已用 project、engine、原生/逻辑身份组成键 | 已有逻辑身份，不重新发明；它仍包含 engine，不能直接当作跨引擎不变 ID |
| E02 | [会话类型](../../src/types/session.ts) 已分 `conversationId`、`id`、`agentSessionId`、`codexThreadId`，消息可带 `turnId` | 增加显式 AppRun、attempt 与 generation；不能把 TaskRun 或 provider turn 直接改名当同一概念 |
| E03 | [SessionRepository](../../electron/src/lib/session-repository.ts) 已有逻辑写锁、revision、删除/替换记录、运行时登记及迟到写入拒绝 | runtime lease 是删除/退休有效性检查，不等价于每个逻辑会话唯一启动锁 |
| E04 | [JSONL](../../electron/src/lib/session-jsonl.ts) 按消息 ID 折叠更新；repository 有 append、压缩及 meta sidecar | `readRaw` 仍全文读取/解析；热分页不能用全文 load 后 slice 冒充 |
| E05 | [saveSessionSmart](../../src/lib/session/persistence.ts) 已做增量 append、revision、防历史截断，游标有数量/字节预算 | 每次入口仍对全部消息 `JSON.stringify`，这是可测量的 CPU 候选，不等于已证明瓶颈 |
| E06 | [CheckpointScheduler](../../src/lib/session/checkpoint-scheduler.ts) 为 2 秒 debounce、5 秒最大等待，保存失败保留 dirty | 不降低已有完成/审批/退出 flush 语义；探查快照构建和重复扫描占比 |
| E07 | [useEngineBase](../../src/hooks/useEngineBase.ts)、[后台 store](../../src/lib/background/session-store.ts) 已有 rAF、buffer、live reader 和切换提交时重读 | 逐步把权威会话投影移到主端，不破坏前台/后台/分屏接管 |
| E08 | [ChatView](../../src/components/ChatView.tsx) 已使用虚拟列表、memo 和结构追踪 | 不再把“加虚拟化”列为新功能；测量数据准备、订阅扩散及结构缓存失效 |
| E09 | [useSessionCache](../../src/hooks/session/useSessionCache.ts) 已限制 6 份 payload / 约 32 MiB 估算体积；[reaper](../../src/hooks/session/useBackgroundReaper.ts) 保存后再复核活跃状态 | 不宣称缓存无上限；需要统一统计其他 store、游标和活跃会话占用，估算体积不等于 heap |
| E10 | [ACP IPC](../../electron/src/ipc/acp-sessions.ts) 已读取 capabilities，检查图片、历史与 fork 等能力 | 在现有探测之上提供跨引擎能力结果，不用静态总表替代真实握手 |
| E11 | [三引擎 IPC](../../electron/src/ipc/claude-sessions.ts) 等持有进程/SDK，事件交给 renderer；[持久化 hook](../../src/hooks/session/useSessionPersistence.ts)承担会话保存 | 主端“有进程”不等于“无 renderer 仍有完整持久化/审批/队列”，需要独立验证 |
| E12 | [自动重试](../../src/hooks/useAutoRetry.ts)、[策略](../../src/lib/session/auto-retry.ts)在 renderer，已限制次数和错误时效 | 如迁入主端，必须退役原计时器；不能让两层同时自动重试 |
| E13 | [会话服务](../../electron/src/lib/session-service.ts)集中访问仓库；[TaskRuntimeEvents](../../electron/src/lib/tasks/runtime-events.ts)已有任务运行通知 | 复用现有边界；进程内 task 通知不是耐久 AppRun 账本 |
| E14 | [运行时竞态测试](../../electron/src/ipc/session-runtime-races.test.ts)已有真实 Node 子进程/stdio fixture，Claude 用 SDK query fixture | 这是回放框架的基础，不是零测试；继续覆盖真实 normalizer/repository，不只断言 mock 次数 |
| E15 | [perf:bench](../../scripts/performance-bench.mjs)覆盖文件树、终端历史和可选 bundle 体积；[perf:smoke](../../scripts/performance-smoke/entry.tsx)用生成数据运行 ChatView | 这些不是生产会话读盘/多引擎完整性能基准，需要补全端到端埋点 |
| E16 | [历史索引](../../electron/src/lib/history/service.ts)已有 worker；[会话转交](../../src/lib/session/session-transfer.ts)已有 Markdown 导出/转交 | 不把搜索派生库提升为事实源，不把文本转交宣称为原生上下文无损迁移 |

### 1.1 先验证，不直接立项的假设

H01：长会话保存的全量序列化是主要 CPU 开销。H02：全文读取影响长会话首屏。H03：不可见会话仍向 UI 推送了过多细节。H04：缺少统一命令回执导致跨窗口/崩溃后存在不可判定执行窗口。

OPT-00 分别记录调用路径、次数、字节、耗时和可复现步骤。若 H01～H03 不成立，缩减对应优化；H04 需以故障注入验证，不能只凭架构判断“已经重复执行”。

## 2. 目标架构与唯一所有者

### 2.1 三种状态，禁止混用

1. **legacy 模式（现状）**：renderer 归并消息并 checkpoint，repository 管理 JSONL；保留所有现有保护。
2. **shadow 模式（验证）**：新 reducer/只读索引消费复制的数据，与现有结果比对；不得发送真实命令、应答审批、重复保存或触发 MCP/记忆/通知副作用。
3. **managed 模式（拟新增）**：主端 SessionService 是该 profile 的唯一业务 writer，UI 只发意图并订阅结果；旧 save/append、发送/恢复、自动重试入口受 generation fencing 拒绝。

一个 profile 不能同时处于 legacy 与 managed 写模式。可按不同隔离 profile 灰度，禁止两个进程并发打开同一 profile；锁文件/独占机制与异常退出恢复在 G1 验证。首版不做按单条会话混合双 writer。

### 2.2 主端先模块化，不先拆进程

拟定边界：

- `shared/types/runtime.ts`：ID、意图、回执、事件、能力、游标；不依赖 React/Electron。
- `shared/lib/runtime/`：纯状态转换、验证、事件归并规则。
- `electron/src/lib/runtime/`：SessionService 扩展、CommandService、运行登记、adapter、存储端口、恢复。
- `src/lib/runtime-client/`：IPC transport、订阅、缓存、重连；UI hooks 只读投影和派发意图。
- `electron/src/ipc/runtime.ts` 与 preload：校验可信调用者、类型与项目/profile 范围，再调用服务；不能把原始 IPC 暴露为网络 API。

以上为拟新增目录；复用 `session-service.ts`/`SessionRepository`，不是再造平行入口。纯 reducer 可共享，业务 writer 只能一个。主端服务可不依赖 BrowserWindow；磁盘/索引重任务用 worker，worker 不是权限沙箱。只有实测主进程阻塞或已有远程路线需要独立进程时，再评估 utility process/daemon。

### 2.3 所有权表

| 状态/行为 | legacy 所有者 | managed 唯一所有者 |
| --- | --- | --- |
| 原始 Provider 连接、原生请求回调 | 三引擎 IPC | 主端 adapter/session manager |
| AppRun、命令、重试、审批状态 | 分散于 hooks/IPC/task 通知 | 主端 CommandService + RuntimeCoordinator |
| 会话正文事实 | JSONL，由 renderer checkpoint 写入 | JSONL 由主端 repository 写；账本只补尚未应用的已提交变更 |
| 标题、归档、workspace 绑定、删除 | repository / 对应服务 | 同一服务，禁止 UI 快照覆盖元数据 |
| 查询索引、近期历史投影 | sidecar / history worker | 可重建 read model，不可据此反向覆盖事实源 |
| 选中会话、滚动、面板、未发送草稿 | renderer | 每个客户端本地；切换不抢占另一个客户端焦点 |
| 自动任务完成/验收 | task workbench | 保留其业务规则；订阅 AppRun，不把 run.completed 当用户已验收 |
| MCP、记忆、usage、项目应用桥接 | 现有引擎相关服务 | 保持一次性调用路径，由主端 adapter 接入；shadow 不重复运行 |

## 3. 主题一：会话、执行与运行时分层

### 3.1 最小领域模型

| 拟新增概念 | 身份与生命周期 | 与现有字段的关系 |
| --- | --- | --- |
| AppThread | profile 内稳定 UUID；包含 project/workspace 绑定 | 显式 alias 映射已有 `conversationKey`；不直接更改旧键算法 |
| AppRun | 一次被服务端接受的用户执行意图；`runId` + 单调 ordinal | 关联用户 `messageId`，不等于 Codex `turnId` 或工作台 TaskRun |
| RunAttempt | 同一意图的执行尝试；`attemptId` + attemptNo | 安全重试/恢复时保留 runId；显式“再次发送”产生新 run |
| ProviderBinding | Agent 配置、实例及原生 thread/session 引用 | 保留 `engine/agentId/agentSessionId/codexThreadId`，作用域含 profile/project |
| RuntimeInstance | 当前 SDK/进程句柄，`runtimeId/runtimeGeneration` | 原 `id` 是兼容 runtime alias，不作为新 AppThread ID |
| RuntimeRequest | 审批/问答；绑定 run、runtime generation、版本及内容摘要 | 原 requestId 必须带原生作用域；同名 ID 跨进程不可复用 |
| ContextTransfer | 显式切换引擎/分叉的来源、目标、截断与附件引用 | 复用现有导出机制，不修改旧会话历史来伪造原生连续性 |

迁移仅把已有已确认等价的逻辑会话映射到同一 AppThread。不同 engine、不同 native thread、显式 fork 不因标题/文本相似自动合并。旧历史中无法可靠判断的 Run 边界标为 `legacy-unclassified`，不编造成功状态或费用。首版保持“一条已有会话使用原引擎”的行为，跨引擎转交仍可创建关联会话；不把真正的同线程换引擎绑定到本优化首版。

### 3.2 状态机与不变量

AppRun：`queued → starting → running ↔ waiting_permission / waiting_user → completed | failed | interrupted | cancelled | unknown`。中断为 `interrupt_requested` 控制状态，不等于已停止。恢复 `unknown` 必须有原生查询/恢复证据或用户明确决策，不能靠超时推断未执行。

- 同一 AppThread 首版最多一个活动 root Run；后续输入排队。不同 AppThread 可并发。
- 子 Agent/工具结束只更新自己的执行节点，不能完成 root Run。
- 无原生 turnId 时分配 app-owned ID，并记录关联质量；不能拿进程 eventCounter 充当持久全局序号。
- 启动占用在第一个异步准备步骤前原子建立；并发 resume 复用同一个启动结果。既有 repository lease 继续负责删除/退休检查，独占启动另有短临界区。
- 停止失败不得释放启动占用并启动替代实例；迟到事件、清理或审批必须匹配 runtimeGeneration，不能影响新实例。
- workspaceBinding 在运行期间冻结；切换 worktree 是新绑定/显式操作，不能随当前 UI cwd 漂移。
- checkpoint 分清“会话内容落盘”与“工作区文件回滚点”；恢复文件不承诺恢复 Provider 原生上下文。文件回滚先验证 workspace 归属、其它活动 Run 和未提交用户修改；共享目录存在冲突时拒绝或要求明确处理，不能覆盖另一会话的成果。

## 4. 主题二：命令 ID、持久回执与恢复

### 4.1 身份与回执

拟定命令封套包含 `schemaVersion`、`commandId`、`clientMessageId`（消息提交时）、`profileId`、`threadId`、`writerGeneration`、`expectedRevision`、operation 与规范化 payload。`principalId` 必须由可信 IPC/未来认证层确定，不相信调用者自报。

- commandId 为随机 ID；传输超时后重试沿用原 ID 与 payload。内容 hash 用于冲突检查，不作为 ID。
- 去重作用域为 profile + principal + commandId；若远程计划已有 desktopId，则作为外围命名空间。
- 同 ID / 同 payload 返回原回执；同 ID / 不同 payload 返回 `COMMAND_ID_REUSED`。消息另按 clientMessageId 防止客户端重建封套制造第二条乐观消息。
- 回执分 `accepted`（按声明耐久级别提交）、`dispatched`（已尝试交给 Provider）、终态；`completed` 只表示该操作定义的完成，不表示模型答复正确或任务验收成功。
- 用户可区分“未发送草稿、待接收、已接收排队、执行中、结果未知、失败可重试”；未确认不能显示已送达。

### 4.2 存储方案与事务边界

**默认不迁移整个会话主库。** 在现有 repository 边界新增私有 operation journal 保存 Command、AppRun、审批决定及待应用变更；JSONL 保留历史事实，search/read model 可重建。journal 是这些新操作状态的唯一权威，不是第二份可独立编辑的聊天库。

G1 必须比较两种实现并冻结 ADR：

- 单会话追加 journal：一次接受的 command/run/message 及待办写入同一带版本/校验的提交记录，单 writer、尾记录恢复、快照压缩。
- 独立 SQLite 操作库：上述实体与 outbox 在同一事务；复用现有 SQLite worker 经验，但不复用搜索索引的可删除生命周期或未经核验的耐久设置。

不能只留下“未来再选”：OPT-05 开始前须附两种方案的故障注入、Electron/目标平台加载和维护成本证据，选择一个。两者均需满足：

1. 校验范围、删除屏障、能力、generation、revision；在会话串行控制段去重。
2. 将完整输入内容（或已耐久附件引用）、AppRun、回执及待派发意图在一个 journal 原子单元/数据库事务提交。
3. 存储 worker 返回已提交确认后才能返回 accepted；磁盘满/flush 失败不能派发。
4. 按 `appliedOperationSeq` 幂等应用到 JSONL；同一 messageId 的重复应用不可产生第二条消息。不得假装“journal + JSONL + meta”是跨文件原子事务。
5. JSONL 已提交而 watermark 未写时允许安全重放；watermark 不得领先正文。读取在追平前等待有界 barrier，或从同一 committed journal 补齐，不返回丢失已接收消息的旧快照。
6. 审批/删除/替换/标题通过同一入口执行；既有删除墓碑和退休记录不能被 journal replay 绕过。
7. journal 检查点只有在所有兼容写入已确认后才能清理。回执超过保留期时返回“已过期/不可确认”，不能当作从未见过而再执行。

输入附件先验证所属 profile/project、大小、路径和实际内容，再落盘；路径字符串本身不构成持久输入。删除会话要清理 journal/附件/缓存及索引，失败保留可重试屏障，不通过重建恢复已删除会话。

### 4.3 崩溃窗口与 exactly-once 边界

| 崩溃窗口 | 恢复行为 |
| --- | --- |
| accepted 前、无提交记录 | 查询后以原 commandId 重发；不能仅凭客户端超时判断 |
| 已提交、明确尚未开始外部派发 | 根据 durable pending 记录继续，重复客户端请求只返回回执 |
| 已记录派发意图，但无法证明 Provider 是否接收 | 标记 unknown；查询原生 handle；禁止自动重发有副作用操作 |
| Provider 已执行，终态尚未写盘 | 原生状态核对；无法核对则 unknown，等待用户明确继续 |
| durable 终态已写、UI 未收到 | 重读回执/投影，不再调用 Provider |

本方案只承诺应用层去重和明确未知状态，**不承诺跨外部 Agent 的严格 exactly-once**。SDK 内部重试、客户端传输重发、应用执行重试必须分开记录。

### 4.4 重试、审批与取消

- 自动执行重试只在 adapter 有可验证“尚未接收/执行”证据时，由主端建立关联 attempt。错误字符串、未见输出、HTTP 超时均不是充分证据。
- 原 `useAutoRetry` 倒计时/次数迁为主端订阅；writer 切换前停用旧计时器，旧 generation 即使产生新 commandId 也拒绝。
- 待审批记录保存原始允许选项、参数摘要、revision、runtimeGeneration、过期条件；按 CAS 只接受一个决定。
- 回调只在内存存活的引擎，重启后旧请求为 expired/not-resumable；展示历史不代表可以应答。
- 不把“不支持审批”降级成自动允许，也不把停止进程冒充无损中断；破坏性降级必须由策略和用户授权。
- 取消排队操作与中断活动 Run 分开；用户取消后延迟启动、记忆注入返回和旧回调不得重新派发。

## 5. 主题三：能力声明与可解释降级

新增能力结果：`supported | unsupported | degraded | unknown`，包含原因、探测依据、Provider/协议版本和 runtimeGeneration；必要时按实例/模型/session 声明，而不是只按 engine。

建议能力集合：resume、interrupt、native steering、interrupt-and-restart、structured approval、structured question、image input、native fork、filesystem rollback、native conversation rollback、subagent lifecycle、history query、MCP、context transfer。

| 操作 | 缺失能力时的策略 |
| --- | --- |
| resume | 不能静默新建并宣称已恢复；经用户选择，以标明范围/遗漏的文本转交创建新会话 |
| active steering | 可选择排队；只有安全证据和明确策略才中断重启，不默认改变原请求 |
| fork | 区分原生 fork 与文本上下文分叉；新 ID、关系和能力说明 |
| rollback | 分开报告文件/会话两种结果；不支持原生回滚时保留 divergence 标记 |
| approval/question | 不可应答时明确失效；不自动批准，不把自由文本伪装成结构化答案 |
| image | 提交前失败并保留附件草稿；不能静默丢掉图片 |

UI 用能力结果决定 affordance，主端执行时再次校验，防止探测后引擎/版本变化。先统一行为契约，再逐步减少现有 UI 条件判断；允许正常的产品展示分支，不以“消灭所有 engine 判断”为目标。引擎基础矩阵需在 OPT-01 从当前安装版本核验，不把本表当三引擎已支持的清单。

## 6. 主题四：原始协议回放与集成测试

复用已有 session-runtime-races fixture，并补充：Codex JSON-RPC、ACP NDJSON peer、Claude SDK async iterable 边界的 replay transport。测试经过真实 adapter、状态机、repository/journal、reducer 与审批策略；只替换进程/网络、时间、随机数和临时文件系统等外部边界。

- fixture 记录方向、方法、ID、顺序、相对时间、协议版本和捕获来源；Synthetic 与经授权录制的真实协议样本分开标注。
- ID 脱敏采用一致映射，不破坏父子关系与乱序；不得包含 token、用户路径、真实提示词/工具输出等隐私。
- 覆盖重入、重复终态、迟到事件、部分 UTF-8、分块 JSON、审批重复应答、root/child 完成顺序，以及崩溃重启。
- 只验证预先归一化事件不足以证明 adapter 正确；只验证 mock 调用次数不足以证明存储恢复正确。
- 回放通过是 E2/E3 证据，不是实际供应商端到端通过。真实引擎/费用需另获授权，测试目录与用户 profile 严格隔离。

完整用例和 fixture 规格见[测试计划](test-plan.md)。

## 7. 主题五：性能优化设计

### 7.1 先补可解释基准

链路标记：用户选择/输入 → IPC 发起 → repository 读盘/索引 → 序列化字节 → renderer 接收/归并 → 首个有效 paint。流式链路从 adapter 收到数据计时，**不把模型首 token 延迟算作 UI 优化收益**。

分别记录主进程、renderer、worker、Provider 子进程的 CPU/RSS；heap、JSON 编码体积、估算 cache bytes 分开。统计 warm/cold、单会话/并发、可见/后台、正常/大工具输出。遥测默认规则不变，原始正文和路径只在受控本地证据中使用，不能新增自由文本上报。

### 7.2 增量保存：不仅减少写盘，还减少准备成本

在 legacy 模式可独立试验：由更新路径维护每条 message revision 与 dirty ID，保存捕获不可变 dirty 快照，只序列化变化项。ack 后仅清理对应版本；保存中继续发生的新变更仍 dirty。后台嵌套 tool/subagent 更新必须纳入 dirty tracking，不能依赖对象引用不变推断未变。

- 完整快照/显式回退/replacement 保持现有历史保留检查，不用性能优化绕过它。
- 首次保存、未知变更来源、重排或缺失 revision 时走受控完整路径；标记 fallback 次数并比较内容。
- 对没有变化的 checkpoint 避免重新遍历全文；checkpoint 频率和失败重试语义不变。
- JSONL 定期压缩迁到有界后台工作；压缩基于已确认 revision，以 CAS/写锁安装结果。压缩失败保留旧源，不阻塞新会话，更不能删除唯一历史。

### 7.3 摘要、历史与活动输出分流

已有 meta sidecar 是基础。拟定三种读取：

- `listThreadSummaries`：标题、工作区、状态、更新时间、未读/审批摘要、revision；无消息正文/图片。
- `readThreadPage`：有界历史及 `snapshotSeq/historyEpoch`，返回 `nextCursor/hasMore` 和完整性状态。
- `subscribeThread` / `subscribeToolOutput`：活动详情/展开输出独立订阅；控制状态不依赖用户展开工具卡片。

**禁止全文 load 后 slice。** JSONL 对同一 ID 的更新跨行出现，简单按文件尾倒读不能保证最终消息状态。优先验证可重建的 message-read-index（消息顺序、最后版本位置/物化正文、source generation）；冷构建在 worker 流式扫描并显示进度，热页按索引读取。来源被压缩/替换后 cursor 失效，不能把旧文件 offset 用在新文件。

现有 history/search 索引是非权威派生物。可复用 worker/事件通知基础，但只有验证语义一致后才复用表，不让搜索故障导致会话不可恢复。索引损坏可重建；冷路径成本单独记账，不能借全量构建掩盖“常数首屏”。

### 7.4 分页一致性与部分视图安全

- cursor 至少绑定 threadId、historyEpoch、排序边界、投影水位；通过客户端不透明编码，由服务端验证范围/限额。
- 第一页和后续 live 订阅使用同一 snapshotSeq；同步缺口返回 resnapshot，不静默跳过。
- 分页按稳定消息 ID/首次顺序，更新按 revision 去重；prepend 保持滚动锚点，正在输出的尾项不丢失。
- 超大消息/工具正文单独作为有界 chunk/ref 按需读取，显示“部分载入”；导出/复制完整结果另走分段读取，不能复制成截断内容却声称完整。
- 搜索跳转通过 messageId 定位附近页；找不到时明确 SOURCE_GONE，不全量读历史只为定位。
- **部分页严禁传给 saveSessionSmart 作为全量快照。** legacy 只读历史可先分页；发送/编辑前暂时完整 hydrate 并显示状态，直到 managed 的 patch/意图入口就绪。不宣称这一过渡阶段已实现有界续聊。
- 未读历史的 token、工具列表、上下文统计不能从已加载页面推断全量；使用主端摘要，或明确“未完整载入”。

### 7.5 流式批处理、订阅与资源预算

- 保留已有 rAF、memo、虚拟化、结构追踪；文本 delta 只影响对应 message/当前 thread 的必要摘要，不能让整个列表跟随 token 更新。
- 持久控制事件（接受、审批、终态、删除、替换）有独立队列，不被高频输出饿死。文本可合并，但必须保留最终完整内容和消息版本。
- 大工具 stdout 不逐 token 写入领域控制日志；落有界/可分段读取的输出存储，记录截断/丢失状态；卸载 UI 只取消读取，不终止 Provider 或丢掉必须保留的执行结果。
- 同一 thread 的多个 pane 共享一份投影及引用计数订阅；最后 view 退出释放细节订阅，后台控制与持久化继续工作。
- 缓存同时设条目数、估算字节与空闲 TTL。保留当前限制作为起点，再测量；活跃/待审批未落盘状态不可因 LRU 驱逐。预算不足先背压/安全溢写，不静默丢控制事件。
- 活跃流、checkpoint 与磁盘写入不依赖 `requestAnimationFrame`；最小化/隐藏窗口也能完成记录。

## 8. 主题六：共享客户端与独立服务边界

桌面先使用一个 `RuntimeClient` 接口，其 IPC transport 可替换；连接、订阅与缓存由独立于组件的客户端 runtime 管理。每个环境只能有一个重连负责人；业务快照/数据新鲜度与 transport 健康分开。

游标与投影必须作为一对保存。只缓存 lastSeq、却丢了该游标之前的数据，刷新后必须重取快照。恢复订阅不能自动重放 mutation；先查询 command 回执。关闭一个 view 或客户端连接不等于取消 Run。

第一阶段所有调用仍是本地 IPC。不默认新增 HTTP 监听、VPS、认证服务或 daemon。未来网络接入需要独立的身份/配对/范围授权、凭据存储、撤销、速率限制及内容安全审查；桌面可访问的 Git/终端/文件能力不自动远程开放。

本地已有远程计划时由其选定传输方案；本方案只交付可复用的主端所有权、应用协议和客户端端口，不建立第二套 Relay/审批/账本。

## 9. 数据兼容、迁移和回退

### 9.1 不可改变的兼容边界

保留 `com.harnss.app`、Harnss userData、`openacpui-data`、`harnss-*`、`.harnss/worktree.json`、记忆 bank/profile、`harnss_apps/harnss_cua` 标识。保留 app-profile 首导入要求。新增格式具备 schemaVersion/read capability，旧 JSON/JSONL 读取适配不借迁移删除原文。

### 9.2 profile 级迁移顺序

`prepared → frozen → baselined → fenced → switched → verified`，失败时记录具体阶段，不用一个 Boolean 代替恢复状态。

1. prepared：检查磁盘容量、备份与恢复可读性、独占 profile、schema 和版本；不改当前 writer。
2. frozen：拒绝新发送/恢复/重试；等待或显式中断现有 Run，处置活审批；安全 stop/control 通道仍可用。
3. baselined：等待旧 runtime 终止、flush 全部 checkpoint/未绘制 buffer，保存源文件清单、revision、别名、删除/替换记录及哈希。任何失败禁止继续。
4. fenced：持久提交 writerGeneration；旧客户端包括缺失 generation 的 managed 写入一律拒绝。不能替旧请求自动补当前 generation。
5. switched：由新服务导入/映射 baseline，切换本地 RuntimeClient；未发送草稿保持本地，只有用户确认的 durable queue 才导入。
6. verified：逐会话比对消息 ID/顺序/正文、元数据、workspace、归档、审批失效语义和删除屏障，确认新 writer 正常，再恢复接收。

迁移断电/进程崩溃后按 manifest 继续或回退到明确阶段；不是看到新目录就当完成。不理解新 writer 模式的旧应用必须禁止直接打开该 profile 写入；最低兼容版本在 G1 冻结，当前未指定。

### 9.3 功能降级与版本回退不是同一件事

| 变化 | 安全回退 |
| --- | --- |
| dirty serialization 优化 | 切回现有完整准备路径，保留 revision/删除保护；不得重新引入截断写入 |
| 只读分页/索引 | 禁用派生索引并重建/退回已标识的慢读；不删除 JSONL |
| capability UI | 保守 unknown/禁用不确定动作，主端仍做校验 |
| managed writer | 不能简单关闭开关并恢复旧 renderer 写入；先冻结/停止/flush、导出兼容快照和墓碑，校验后再次 fencing |
| 关闭远程连接 | 只撤销网络访问，不改变 writerGeneration 或已接受执行 |

已确认命令与 native 副作用不能通过恢复旧备份“撤销”。无法验证全量兼容导出的 profile 保持新格式只读/恢复模式，不能静默降级。

## 10. 与现有计划协调，避免重复建设

| 本方案能力 | 既有本地计划对应 | 交付规则 |
| --- | --- | --- |
| 身份、generation、消息/命令契约 | 远程 RW-02 | 一个共享契约；对齐 remoteSessionId / runtimeGeneration / commandId 含义，不建重复 identity registry |
| 真实三引擎无 renderer | 远程 RW-03a / M0-R | 同一测试可复用证据，fake 不替代真实准入 |
| 启动单飞、重试仲裁 | 远程 RW-04a / RW-04b | 一个 RuntimeCoordinator；客户端只读重试状态 |
| 耐久、迁移、存储分页 | 远程 RW-05a / RW-05b / RW-05c | 一套仓库/账本端口，选择上游复用时重评 owner，不保留双套事实库 |
| 审批 | 远程 RW-06 | 一个请求身份/CAS/过期模型 |
| 未来 native Provider | 原生 Agent PR-02～PR-06 | 可以实现同一 adapter 契约，不反向要求先做 native 或安装 Pi |
| 历史搜索/任务/记忆/项目应用 | 已实现功能及其文档 | 保留功能和删除传播，不以运行时优化重新写一套业务 |

上表只是协调映射，不宣称上述本地计划已实现或被本次授权启动。若并行开发，应在首个共享契约 PR 明确唯一 owner 与合并顺序；无明确归属的重复实现不能进入主分支。

## 11. 门槛、风险与实施顺序

### 11.1 门槛

- **G0 基线**：已有测试结果/失败分类、性能 workload、当前权威 owner 图、指标采集方法已记录；不看结果后再降低阈值。
- **G1 语义/存储**：ID/状态/能力、耐久承诺、profile 独占、最低兼容版本、journal 后端 ADR 冻结；两种存储 spike 的失败窗口有证据。
- **G2 接管可行性**：隔离 profile 的三引擎 replay 全链路通过；经明确授权的真实三引擎无 renderer 的发送、审批/问答（支持时）、停止、保存、恢复验证通过，才扩大接管。未验证的 Provider 保持旧路径或新模式不可用。
- **G3 桌面单写者**：迁移/fencing/重试/删除/审批用例通过；性能与完整性预算满足；已有功能回归通过。
- **G4 灰度/发布**：指定平台真实 UI、生产构建、安装包、升级/降级、证据与用户授权齐备。每次打包前遵守根 CLAUDE.md 版本递增规则。
- **G5 可选远程**：另行走远程方案安全/部署门槛；G4 不代表可以直接开放公网。

OPT-03 的 legacy 性能改进可在 G0 + 针对性回放/回归后独立交付，无需等 G2/G3。只读分页亦可隔离试验；不能借这些低风险路径提前开启 managed 写入。

### 11.2 主要风险与停止条件

| 风险 | 处置 / 停止条件 |
| --- | --- |
| 保存更快但丢嵌套工具/后台更新 | 内容差异即停止优化；扩 dirty tracking，不删一致性断言 |
| paged UI 覆盖全量历史 | 强类型区分完整快照/页；repository 拒绝不完整写入 |
| managed 与旧 writer/自动重试并存 | generation 全入口 fencing；任何双派发即停止灰度 |
| Provider 外部副作用无法确认 | unknown + 人工处理；不无限重试 |
| journal 与 JSONL 不一致 | watermark + 幂等恢复；缺失已接受输入即阻止发布 |
| 主线程新增 fsync/解析卡顿 | worker 隔离、批处理与有界队列；不以取消耐久换速度 |
| 身份迁移误合并/删除复活 | 显式 alias、墓碑继承、逐会话核对；失败维持冻结 |
| Provider 协议升级 | 固定版本 fixture；能力重新探测；真实版本冒烟 |
| 数据库原生/worker 打包不兼容 | G1 平台 spike，G4 产物验证；无证据不切库 |
| 计划互相覆盖 | 依 §10 共享 owner；先更新 ADR，再实施 |

### 11.3 第一批可交付内容

先做 OPT-00、OPT-02 和 OPT-03：补指标/回放基础，验证是否值得优化全量快照准备。同步设计 OPT-01 的身份/能力契约，不改现有持久化身份。完整批次、角色和依赖见 [Backlog](backlog.md)。本方案不承诺固定工期或百分比性能提升，估算应在 G0/G1 和真实集成结果后形成。
