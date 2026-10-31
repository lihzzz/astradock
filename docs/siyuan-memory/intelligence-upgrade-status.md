# 思源记忆智能层：实施与验收记录

日期：2026-10-25（Asia/Taipei）。对应[实施计划](intelligence-upgrade-plan.md)。

## 结论与发布状态

**六项主功能已接入代码，并完成本地自动化与隔离 Electron 交互验收；不宣称计划 M8 的真实模型质量、真实思源新格式写入和跨平台发布门槛全部完成。** 智能增强默认关闭，位于“设置 → 长期记忆 → 记忆智能增强（试验性）”，由用户显式启用。结构化交接仅在用户发起并确认快照后执行。

本次没有迁移存储、引入模型/向量服务、安装依赖或删除用户笔记，没有调用真实模型，没有打包发布或提交 Git。保留了其它工作中的 README、运行优化文档和 artifacts 改动，不把这些算作本功能实现。

## 已实现内容

| 功能 | 实际入口 | 行为与限制 |
|---|---|---|
| F1 结构化提炼 | `shared/lib/memory-entry.ts`、`memory/service.ts`、`memory/runtime.ts` | 当前 Agent 提交结论/条件/细节/来源；查询旧知识、精确去重；补充/矛盾关系与明确修正受控追加；没有隐藏总结模型 |
| 显式经验整理 | `authorizeMemoryReview`、记忆面板“整理历史经验” | 用户选择最多 3 个本项目会话；只为下一次可见回合授权，每个来源最多取末段中一个用户消息及一个具有明确成功状态的工具记录；不是全量会话归档 |
| F2 检索增强 | `searchEnhanced`、`planQueries`、`reciprocalRankFusion` | 至多 3 query、6 次全文请求、40 个原始候选；去重、类型过滤、RRF、受控关联；部分结果/预算耗尽不冒充确定无结果 |
| F3 使用追踪 | `memory/runtime.ts`、`memory/trace.ts`、`MemoryTrace.tsx` | 查询、正文读取、交付阶段、提炼与写入结果；每轮有界，UI 展示最近 30 阶段；可选 7 天/10,000 条纯元数据落盘 |
| F4 分层上下文 | `renderEntry`、`memory/operation.ts`、`beforeMemorySend` | index/summary/full；800 UTF-8 字节自动简报；2000 UTF-8 字节回合正文预算；请求总额、并发与取消；不回退到离线正文 |
| F5 有效性与纠错 | `feedbackMemory`、`correctMemory`、关系解析 | 用户反馈绑定当前正文 hash；过时/矛盾/来源会话缺失/结构化正文被编辑提示复核；不删除或改写原条目 |
| F6 跨引擎交接 | `session-handoff.ts`、交接 IPC、`HandoffPreviewDialog.tsx` | packet + 不可变可见历史；目标/目录/权限快照预览；operationId 幂等；目标创建与发送状态分离；保留 task 验收语义 |

### 接口与存储边界

- MCP 保留四个原工具，新增 `memory_evidence`；`memory_search`、`memory_read`、`memory_remember` 为兼容式扩展。工具免确认仍按精确服务器限定名称匹配。
- 增强字段有独立版本与默认值；损坏的增强字段不会重置已有连接/授权。旧条目与旧 journal 不自动迁移或重写。
- 知识正文及反馈仍通过思源追加/核对。新增 `siyuan-memory-catalog.json` 仅存 ID/范围/类型/时间等定位信息，不存正文、标题、实体词或查询。
- `siyuan-trace.json` 是可选诊断元数据，不是知识副本。当前回合的未刷盘事件可能在崩溃时丢失；写入可靠性仍由原 journal 负责。
- 来源标识保存宿主会话/事件或显式历史消息的 ID 与 hash。`session_available` 仅说明可定位来源会话，不代表每句结论已通过语义核验；跨项目个人偏好的来源不会自动扩大为读取另一个项目历史的权限。
- 原始完整可见会话导出属于既有会话数据域，不是思源离线回退。交接文件不导出 `thinking` 字段；已交付的独立历史导出不会因源会话删除就自动删除。
- 模型不能通过 `memory_evidence` 参数选择任意历史会话；历史来源仅能通过可信 renderer 的显式选择授权。

## 本地验收证据

工作区基线为 `42e2e641292ba3af607dc8452eb6b1be39fceead`，验收针对未提交工作区。基线全量测试为 **191 个文件通过、4 个跳过；1409 项通过、19 项跳过**。

最终计数见本节“最终回归摘要”；以下日志位于忽略目录 `.cache/`，不应提交包含机器细节的完整原始日志。

| 检查 | 结果/证据 |
|---|---|
| TypeScript renderer + Electron | `pnpm typecheck`；`.cache/intelligence-typecheck-final.log` |
| 全量 Vitest | `pnpm test`；`.cache/intelligence-tests-full.log` |
| 生产构建（不是安装包） | `pnpm build`；`.cache/intelligence-build.log`；保留已有大 chunk 警告 |
| 编译产物 stdio MCP | `node scripts/test-memory-bridge.cjs`；五工具发现与带凭据的本机转发；`.cache/intelligence-bridge.log` |
| 旧清理边界回归 | `node --test scripts/test-legacy-memory-cleanup.cjs`；仅隔离 fixture，不对真实数据执行清理 |
| 隔离 Electron UI | `pnpm exec electron scripts/test-memory-panel-ui.cjs`；加载构建 CSS，900px/360px 窗口分别执行 7 项真实 React/DOM 流程；`.cache/intelligence-ui-smoke.log` |
| 真实思源只读探测 | 显式设置 `SIYUAN_READONLY_PROBE=1` 后单独运行，1/1 通过；版本 **3.8.8**；仅版本、MCP 工具发现、工作空间身份形状，不读写笔记 |
| 离线评测契约 | `node scripts/evaluate-memory-intelligence.cjs`；40 个冻结知识样本、120 种查询表达、15 个负例；只检验纯规则/集成契约，不等同真实语义检索质量 |

### 最终回归摘要

- TypeScript：renderer 与 Electron 均通过。
- 全量测试：**197 个文件通过、4 个跳过；1502 项通过、19 项跳过，0 失败**。相对本轮基线增加 93 项测试。
- 生产构建、编译产物 MCP smoke、离线评测契约均返回退出码 0。
- 真实思源只读探测：1/1 通过；不是新格式真实写入验收。
- 隔离 Electron：900px、360px 两种窗口各 7 项流程通过，使用构建后的 CSS。
- 所有跳过项与未执行的真实模型/真实写入场景不计为通过。全量通过不构成真实 Recall、提炼准确率或跨平台性能保证。

### 自动测试实际覆盖

- 原记录编码、源引用严格解析、伪来源/过期来源拒绝、隐藏推理与敏感片段排除。
- Claude/Codex/ACP 的有界原生事件观察，未配对完成事件和跨原生 turn 事件拒绝；不从工具成功推断模型采用。
- 多 query 去重/RRF、当前项目与 personal 范围、读前/读后授权、当前正文与原版本反馈。
- 反馈和明确修正追加而不覆盖原文；反复反馈复用操作；结构化矛盾关联同时保留两种结论。
- 来源会话不可用、正文外部编辑、schema 兼容、回合读取额度、API 预算和取消信号。
- 显式历史授权范围及一次性消耗；工具不能扩大来源；历史隐藏思考不进入来源集合。
- 交接文件完整性、operationId 幂等、重启后元数据恢复、重复目标拒绝、任意路径拒绝、源删除后的复查。
- 交接窗口显示未知状态、工作区/权限和复验要求；不把普通 Agent 宣称当用户验收完成。
- UI 保存失败保留输入、成功后清空、unknown 只核对、版本反馈保留原文、切会话清理、数据文本不作为 HTML 执行。
- 中英文追踪阶段与最长 30 项可见窗口；窗口宽度检查防止新增面板和交接对话框横向溢出。

UI 日志中 `Fixture write failed` 是故意注入的失败场景，后续断言验证输入保留和恢复，并非最终测试失败。Windows Chromium 的临时 profile 删除可能因退出时句柄未释放暂时保留；测试 runner 仅尝试清理自己创建的目录，不扫描删除用户 profile。本轮有临时目录因 Windows 句柄占用保留，后续递归清理命令被执行环境拒绝，未绕过该限制。

## 尚未通过的真实/质量门槛

以下不能用本地测试代替，也不计入“通过”：

1. **真实思源新格式写入/反馈/修正/删除回归**：本轮只做只读探测，未创建或改写真实笔记。需要明确获批的临时笔记本/文档树与清理范围。
2. **三引擎真实模型提炼与工具使用**：本轮未执行真实模型回合，不能宣称自动提炼正确率 ≥95%、覆盖率 ≥85%、免确认实际体验已验收。
3. **真实检索与端到端任务质量**：40 个样本与 120 种表达已冻结，但离线测试不是思源搜索和模型任务实测，不能宣称真实 Recall@5 ≥90%。
4. **六个有向跨引擎组合的真实续接**：存储/IPC/交互 fixture 通过，不等于真实模型已经正确恢复任务。
5. **规模与平台**：未完成 100/1,000/5,000 条真实知识规模的延迟门槛，也未执行 macOS/Linux 安装包及整应用视觉验收。

因此增强仍默认关闭；不能依据构建或 mock 全绿自动宣布全部 M0–M8 验收完成。

## 评测入口使用

```powershell
# 不调用模型、不连接思源：运行离线契约与冻结样本回归。
node scripts/evaluate-memory-intelligence.cjs

# 对外部真实运行记录进行 ID 检索统计，不触发新模型请求。
node scripts/evaluate-memory-intelligence.cjs --results <recorded-results.json>
```

真实记录格式：`engine`、`model`、`commit`、`fixtureVersion: 1`、`runs`。每项 run 含 `caseId`（K01–K40 或 N01–N15）、`variant`（正例 0–2，负例只允许 0）、`iteration`（1–3）、`retrieved`（去重后映射到样本 ID 的结果）。实际思源 blockId 到样本 ID 的映射必须来自该次获批 fixture 创建记录，不允许事后猜测。记录不完整时退出码非零，不报告通过；该统计不能替代提炼语义、证据对应或任务质量的人工作标与复核。

## 开启与回滚

- 先运行新构建，再到设置显式开启“结构化提炼、多查询检索与反馈”；分层简报、持久追踪分别可选。没有自动替用户启用或重启当前应用。
- 智能增强关闭后恢复旧工具行为，但新格式内容、显式修正与原写入状态仍保留。总开关关闭后停止新的记忆操作并清理运行中引用/正文。
- 需要完全消除已注入上下文的影响，应开始新会话；软件不能撤回模型已接收的历史。
- 旧应用可能不认识新反馈/结构标记，降级前应先关闭记忆；不要以删除思源笔记或 journal 作为回滚手段。
