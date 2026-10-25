# 实施 Backlog：增量交付与退出标准

日期：2026-10-25。**工作已在独立分支分阶段开始，尚未全部完成。** 当前逐包状态见 implementation-status.md；勾选框仍是完整目标验收，未满足全部条件的项目不因已有部分代码而勾选。角色是职责建议，不代表已经分派给某个人或创建后台任务。

## 1. 正式依赖与风险分级

| 工作包 | 前置工作包 | 主要收益 | 风险 / 建议 owner |
| --- | --- | --- | --- |
| OPT-00 基线与观测 | 无 | 决定优化是否必要 | 低；性能/QA |
| OPT-01 身份、能力及存储 ADR | OPT-00 | 一致性与设计冻结 | 中；runtime/persistence |
| OPT-02 原始协议回放基础 | OPT-00 | 可复现与回归 | 中；adapter/QA |
| OPT-03 保存准备与后台开销 | OPT-02 | 直接性能收益 | 中；renderer/persistence |
| OPT-04 有界历史与摘要读取 | OPT-01、OPT-02 | 直接性能收益 | 中高；persistence/renderer |
| OPT-05 命令账本与恢复 | OPT-01、OPT-02 | 可靠性 | 高；persistence/runtime |
| OPT-06 生命周期与单写者接管 | OPT-05 | 可靠性/解耦 | 高；runtime/adapter |
| OPT-07 客户端投影与按需订阅 | OPT-04、OPT-06 | 性能/复用 | 中高；renderer/runtime |
| OPT-08 迁移与兼容开关 | OPT-03、OPT-07 | 数据安全 | 高；persistence/release |
| OPT-09 全链路、平台与灰度 | OPT-08 | 产品质量 | 高；QA/platform |
| OPT-10 远程共享端口交接 | OPT-09 | 可选扩展 | 条件项；remote/security |

只读审计、fixture 编写、设计可以交错；正式接管按依赖推进。OPT-01 负责 G1 的存储可行性小实验和 ADR，不能把未决存储选择推迟到 OPT-05 的生产写入实现。OPT-06 中先做受控垂直验证，通过 G2 后才展开三引擎全面接管。

候选性能优化无收益时可以关闭/撤销对应实验，并记录理由；这不等于可以省略下游所需的分页安全或迁移兼容契约。后续开始实现时根据 G0 排定实际顺序与工期，不以当前编号承诺交付日期。

## 2. OPT-00：可重复基线与最小观测

- 范围：`scripts/performance-bench.mjs`、`scripts/performance-smoke/`、`SessionRepository`、`saveSessionSmart`、`ChatView`、主进程/renderer 的本地诊断入口。
- [ ] 记录当前提交/dirty diff、系统/硬件、Electron/Node/Provider 版本与构建模式。
- [ ] 执行已有单测/typecheck，分类已有失败；不把历史文档中的通过数当成本轮基线。
- [ ] 增加生成数据、读盘/解析/编码/IPC/paint 分段时间和字节统计；Provider 用本地 replay，不读用户会话。
- [ ] 测量 S/M/L、并发与大工具输出场景，复现 H01～H04；同时记录已经达标的部分。
- [ ] 形成 G0 报告及本地 evidence 路径。新增指标不得改变遥测默认关闭和属性白名单。
- 交付：baseline JSON/报告、workload seed、原始采样和 profile 使用说明。
- 退出：能够在同一环境重现；知道每项性能数据测了什么、没测什么。对应 PERF01、INT01。
- 回退：关闭观测开关，不更改会话源或业务路径。

## 3. OPT-01：领域身份、能力契约和 G1 ADR

- 范围：`shared/types/engine.ts`、`src/types/session.ts`、`shared/lib/session-identity.ts`；拟新增 `shared/types/runtime.ts`、`shared/lib/runtime/`。
- [ ] 冻结 AppThread/Run/Attempt/RuntimeRequest 与旧身份的映射，保留 `conversationKey` 兼容算法。
- [ ] 对齐本地远程计划的 remoteSessionId/runtimeGeneration/writerGeneration，明确哪些只是命名映射。
- [ ] 定义 capability 四态、来源与失效条件，收集三引擎实际握手/SDK 依据；新 API 不凭文档名称猜测。
- [ ] 定义命令回执、内容 hash、消息身份、事件 envelope、历史 cursor 和错误枚举。
- [ ] 在临时 profile 做 journal/SQLite 两方案小实验：原子接受、重放、flush、损坏、主端阻塞、目标平台/worker 加载。
- [ ] 冻结 ADR：存储后端、故障承诺、profile 独占、最低兼容版本、重试唯一 owner、日志保留与旧版本写入防护。
- 交付：schema/纯逻辑与测试、能力矩阵、ADR、spike 证据。不得提前切换业务 writer。
- 退出：G1 条件有明确选择与 No-Go；ID01～ID03、CAP01～CAP05、CMD07 的规格与基础测试明确。
- 回退：保留旧类型和数据；新增 schema 仅在隔离试验使用。

## 4. OPT-02：通用回放与故障注入

- 范围：复用 `electron/src/ipc/session-runtime-races.test.ts`；拟新增 `electron/src/lib/runtime/testing/` 与生成/脱敏 fixture。
- [ ] 抽离 transport fixture，不 mock adapter、repository、reducer、能力策略和命令去重逻辑。
- [ ] 分别覆盖 Codex stdio、ACP stdio、Claude SDK iterable 的真实边界。
- [ ] 支持虚拟时间、固定 ID、出站断言、分块输入、退出/断连、重复和迟到帧。
- [ ] 保存 fixture 来源、版本、脱敏映射和预期不变量；新增 replay harness 不读取用户凭据。
- [ ] 用现有正常会话与崩溃竞态用例证明抽离前后结果一致。
- 交付：可复用测试 transport、三引擎最小 fixture 和故障点 API。
- 退出：REP01～REP05 通过；失败时可定位到原始帧/持久状态，而非仅有 mock 调用差异。
- 回退：测试设施不影响生产；不删除原有保护性用例。

## 5. OPT-03：保存准备与后台资源性能

- 范围：`src/lib/session/persistence.ts`、`checkpoint-scheduler.ts`、`useEngineBase.ts`、后台 handlers、`useSessionCache.ts`、`useBackgroundReaper.ts`。
- [ ] 先用 G0 判断全量序列化是否值得改；无瓶颈则记录 No-Change，不为减少代码行数重构。
- [ ] dirty ID + message revision；捕获不可变待保存版本，ack 只清相同版本；后台嵌套更新全部纳入。
- [ ] 完整快照/重排/replacement/未知更新保留受控 fallback；不删除 revision 和历史完整性检查。
- [ ] 统计游标、payload cache、后台 store 与订阅占用，避免同一历史无意多份缓存。
- [ ] 维持 2s/5s checkpoint、终态/审批即时 checkpoint、退出 flush 和保存失败 dirty 行为。
- 交付：独立可关闭的优化、完整内容比对和 before/after 分段指标。
- 退出：PERF02、PERF03、PERF06 与既有 persistence/live-session/reaper 测试通过；无收益则不默认启用。
- 回退：恢复现有序列化路径；不会影响身份、源格式与命令语义。

## 6. OPT-04：摘要、真实存储分页和大内容读取

- 范围：`session-repository.ts`、`session-jsonl.ts`、`sessions.ts`、preload、会话加载 hook；复用 history worker 基础，不改变搜索事实源定义。
- [ ] 建设可重建 message read model；处理同 ID 多次更新、缺少 ID 的旧记录、压缩/替换和索引水位。
- [ ] 实现 summary/page/read-near-message/output-chunk 端口；校验 cursor、profile/thread 范围与字节限额。
- [ ] 冷构建流式处理并显示状态；热页不调用全文 `readRaw`，记录真实读取字节/对象分配。
- [ ] 大消息分段引用、partial 状态、完整复制/导出能力；不悄悄截断正文。
- [ ] 历史页面类型不能传给全量 save；legacy 续聊明确 full hydrate，managed 才承诺有界续聊。
- [ ] 索引损坏可恢复，删除/替换使旧 cursor 和缓存失效；不能出现“索引无记录即已删除”。
- 交付：读模型、查询契约、只读历史 UI 原型、冷热路径报告。
- 退出：PAGE01～PAGE07、PERF04；只读分页可独立灰度，但 managed 写入仍保持关闭。
- 回退：停用派生索引并使用明确的慢读路径；保留 JSONL、墓碑和替换记录。

## 7. OPT-05：命令账本、回执与可恢复派发

- 范围：`session-service.ts`/repository 的受控扩展，拟新增 CommandService、operation journal/store port 和 outbox worker。
- [ ] 按 G1 所选单一后端实现 command/run/input/dispatch intent 的原子接收；accepted 必须晚于 commit 确认。
- [ ] durable command 去重、payload 冲突、clientMessageId 映射、修订冲突和作用域校验。
- [ ] 建立 journal→JSONL 的幂等应用及 watermark，处理每一个双写中断点，不假设跨文件事务。
- [ ] 定义 pending/dispatching/unknown/terminal 恢复；禁止用超时推断 Provider 未执行。
- [ ] 测试磁盘满、损坏、worker 退出、ack 丢失、重启后的回执和回放；记录日志大小/保留/压缩策略。
- [ ] 新输入附件在 accepted 前具有耐久引用；清理与删除屏障联动。
- 交付：可在隔离环境运行的持久 command vertical slice；仍不接管正式 profile。
- 退出：CMD01～CMD08、MIG04；已接受输入不得在进程崩溃后消失，外部执行未知不得自动重发。
- 回退：停止试验 writer；不向用户历史导入未经验证的 journal。

## 8. OPT-06：单飞启动、审批与三引擎主端接管

- 范围：三引擎 IPC、`acp-runtime.ts`、runtime coordinator、`useMessageQueue.ts`、`useAutoRetry.ts`、task runtime 通知。
- [ ] 从 IPC 提取不依赖 BrowserWindow 的 adapter 服务，保持原进程/SDK 接入方式。
- [ ] 先选可控单引擎隔离垂直切片，再按同一契约完成三引擎；真实验证缺席者不得宣称已通过 G2。
- [ ] 在异步启动前原子占用 AppThread，登记 generation；取消/删除/replacement 与启动锁共享顺序。
- [ ] 主端归并事件、保存、处理队列/重试/审批；原 renderer 只保留兼容模式，不进行第二次处理。
- [ ] 审批 CAS、live-only 回调失效、子 Agent 生命周期、中断确认和停止失败恢复。
- [ ] 检查记忆、MCP、项目应用凭证、usage、TaskRun 通知只调用一次；新 Run 不等于人工验收。
- 交付：三引擎 adapter、唯一 coordinator、无 renderer 演示及真实版本/限制报告。
- 退出：LIFE01～LIFE08、CAP 用例、INT02～INT04；G2 通过后才进入广泛接管。
- 回退：隔离 profile 停用新模式；正式 managed profile 回退必须经 OPT-08 程序，不能重新打开旧 writer。

## 9. OPT-07：共享客户端与细粒度订阅

- 范围：拟新增 `src/lib/runtime-client/`；`useEngineBase`、后台 store、SessionPane/PaneController、ChatView/侧栏/preload。
- [ ] IPC transport 与应用协议分离，UI 不再把完整 UIMessage[] 当作业务写入请求。
- [ ] summary、thread history、活动事件、展开工具输出分别订阅；同线程多 pane 引用计数共享。
- [ ] cursor 与投影同步保存，generation 变化清理旧异步结果；断线恢复先回执查询，不自动重放 mutation。
- [ ] 保留虚拟化、结构缓存与滚动锚点；不可见线程仅保留必要控制数据。
- [ ] 对大工具输出背压/溢写，控制事件不丢；终态 flush 不依赖 rAF。
- [ ] 本地未发送草稿/布局与业务状态分离；关闭一个 pane 不停止 Agent。
- 交付：IPC RuntimeClient、迁入新数据路径的桌面原型、订阅计数和 payload 证据。
- 退出：PERF05～PERF08、PAGE05～PAGE07、LIFE04；单/分屏、后台与失去焦点行为一致。
- 回退：仅在 legacy profile 使用旧 hooks；不能把 managed 的部分页喂给旧全量保存链。

## 10. OPT-08：迁移、fencing 与回退工具

- 范围：repository/replacements/deletions、app-profile 初始化、preload 入口、设置/本地 migration manifest。
- [ ] 实现 prepared/frozen/baselined/fenced/switched/verified，可在每步故障恢复。
- [ ] 处理旧 runtime 别名、TaskRun/session 关联、搜索来源、归档/标题/workspace 和 profile 隔离。
- [ ] fencing 覆盖 save/append/meta/create/resume/send/retry/approval；缺失 generation 的旧端点不能绕过。
- [ ] 提供预检、备份验证、只读诊断与兼容导出；新 writer 不可用时不默默回到双写。
- [ ] 单独验证用户明确回退：收束执行、导出兼容快照、完整性比对、保留墓碑、生成新 writer epoch。
- [ ] 区分关闭功能、恢复数据备份、降级安装包，明确最低兼容版本及禁止动作。
- 交付：迁移/恢复工具、操作说明、隔离 profile 的升级/降级证据。
- 退出：MIG01～MIG07、CMD08、ID03，G3 通过；未授权不迁移用户真实 profile。
- 回退：仅按已验证流程；校验失败保留只读恢复模式。

## 11. OPT-09：完整验收与受控灰度

- 范围：全部运行时测试、已有功能测试、性能工具、目标平台 UI 与安装包。
- [ ] 回放集与受支持三引擎真实集成分别报告，标明 N/A 原因，不把 skip 计为 pass。
- [ ] 同硬件同 workload A/B 测量，保留原始样本；排查正确性与速度的取舍。
- [ ] 回归历史搜索/语义索引、任务验收、记忆、MCP、项目应用、worktree、工具复制/导出和退出。
- [ ] Windows/macOS/Linux 按声明的平台验收：路径/编码/子进程清理、后台窗口、原生库和升级恢复。
- [ ] 本地自测 profile → 用户明确选择的测试 profile → 默认启用，逐级观察，不按随机概率静默迁移用户数据。
- [ ] 打包前按 CLAUDE.md 递增版本；更新发布说明、限制、诊断与回退指南，不把本计划当发布授权。
- 交付：G4 报告、已通过/未通过/N/A 清单、before/after、灰度监测和停止条件。
- 退出：所有已承诺范围的必测项通过，无数据丢失、双执行和审批越权；产品显式接受未覆盖的平台。
- 回退：发现完整性/双 writer/错误审批立即停止新增迁移，收束执行并按 OPT-08 恢复。

## 12. OPT-10：可选远程扩展交接

- 不属于默认桌面优化交付；需要用户另行确认 Web/远程需求与实际部署。
- [ ] 对齐已有远程方案 A/B/C 选型，复用本方案服务/账本/能力与客户端端口，不重复建设。
- [ ] 另过认证、配对、授权、撤销、内容安全、网络暴露和升级兼容门槛；完成 REMOTE01～REMOTE02。
- [ ] 明确电脑离线、多个客户端、断线/重连与凭据边界；不自动开放终端/Git 写入或项目文件。
- 交付：共享边界和 owner 对照、网络适配准入报告；部署细节由远程工作台项目管理。
- 退出：G5，而非“本地 IPC 工作了”。失败时保持本地工作台正常、网络关闭。

## 13. 每个工作包的统一完成定义

1. 改动与设计/ADR 一致，新增文件标注已实施；现有源码入口没有双 owner。
2. 关联用例有执行命令、平台、数据 seed、结果和限制；不是仅打勾。
3. `pnpm typecheck`、针对性测试、适用时完整测试/构建；已有失败单独记录，不掩盖新回归。
4. 涉及 UI 的变化做真实 Electron 验证；涉及新存储/worker 的变化做生产产物验证。
5. 失败与回退路径通过，并更新 [实施状态](implementation-status.md)。
6. 不包含未经授权的真实模型费用、用户数据迁移、系统安装、远程部署、提交或发布。
