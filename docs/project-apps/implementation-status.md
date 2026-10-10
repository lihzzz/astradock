# 项目应用实施记录

更新：2026-10-09。原始范围保留于 [集成计划](integration-plan.md)，用户操作见 [使用说明](user-guide.md)。本记录区分代码落地、自动化验证和真实产品验收，不能把单元测试通过等同于跨平台发布验收。

当前：P0–P4 的实现及 P6/P7 的选定能力已落地，Windows x64 构建、打包和主要 GUI 流程已有真实证据。P5 的跨平台及真实模型验收仍未完成，因此不声明原计划全部交付门槛通过。基线为 `40c9d42`，本记录还包含随后工作树中的验收修复。

## 按计划范围映射

| 计划章节/阶段 | 已实现入口与文件 | 已有证据与剩余要求 |
| --- | --- | --- |
| §1/§3/P3 应用目录与导航 | `src/components/apps/ProjectAppsView.tsx`、`ProjectAppCard.tsx`；`AppLayout.tsx`、`AppSidebar.tsx`、`sidebar/ProjectSection.tsx`；`useAppEnvironmentState.ts`、`useAppSpaceWorkflow.ts` | 无会话主视图、当前/全部 Space、项目/状态/收藏/文件夹筛选、搜索、URL 临时打开/保存、卡片菜单已实现。零项目/零会话入口 GUI 已观察；完整交互矩阵待继续验证。 |
| §3/P1/P3 添加与编辑 | `ProjectAppEditor.tsx`、`electron/src/lib/project-apps/discovery.ts`、`command-resolver.ts` | 项目/网站、接入已有目录、worktree、相对 cwd、候选脚本、结构化 command/args、env、端口和健康配置。发现过程不执行命令。Vite 与缺失运行时分支有自动化证据；Next 真实项目待验收。 |
| §4/P0 身份模型 | `shared/types/project-apps.ts`、`workspace.ts`、`shared/lib/project-apps.ts`、`electron/src/lib/project-apps/workspace.ts` | managed/web 判别联合、固定 workspace、冻结 run 配置、expectedRevision、稳定 conversationId。真实 linked worktree/越界拒绝、前端绝不选择另一个工作区实例的测试已通过。 |
| §5/P1 权威持久化 | `electron/src/lib/project-apps/store.ts`、`service.ts`、`index.ts` | 原子写与串行变更、版本校验、损坏保留、有限运行历史；实现采用单一 `catalog.json`，见下方差异说明。并发冲突/损坏保留测试通过；磁盘故障的完整产品提示待验收。 |
| §5/P1 进程间协议 | `electron/src/ipc/project-apps.ts`、`preload.ts`、`src/types/window.d.ts`、`src/stores/project-apps-store.ts`、`src/hooks/useProjectApps.ts` | 主窗口来源限制、先订阅再快照、目录 revision 与单 run revision 分离；日志不进入全局目录 store。包含日志补读与精确工作区选择的 12 项测试通过。 |
| §6/P2 端口与就绪 | `health.ts`、`runtime.ts`、`command-resolver.ts` | 固定/框架自动端口、TCP 预检、HTTP 健康、超时和进程退出。真实临时 HTTP、Vite、预检后的外部抢占及不同 loopback 地址同端口测试通过。就绪同时校验实际 HTTP socket 地址与本 run 的监听归属；唤醒后立即重查。Next 与跨平台待验收。 |
| §7/P0/P2 进程归属 | `process-tree.ts`、`runtime.ts`、`electron/src/lib/project-apps/windows-job.ts` | Windows Job Object/helper、POSIX 进程组；实际包装进程退出后 detached 孙进程仍被正确停止。Windows 成功；macOS/Linux 未实机验证。Windows helper 使用 PowerShell/C# Add-Type 本机编译，整包需验证该系统能力可用。 |
| §7/P2 生命周期 | `service.ts`、`electron/src/main.ts`、`ipc/git.ts`、既有 SessionRepository runtime lease | 启动/停止/重启幂等与竞态、项目删除屏障、worktree 清理、普通退出等待清理、历史 interrupted。启动中移除、无效重启不杀旧服务、worktree 删除测试通过；整包退出行为继续验证。 |
| §5/§7/P2/P3 日志 | `logs.ts`、`ProjectAppLogs.tsx`、`app-utils.ts` | 1 MiB 内存、2 MiB JSON 尾部、75 ms 后端批次、100 ms 前端批次、虚拟化最近 3,000 块；seq 去重、有界重放、truncated 不重试已淘汰历史。块边界 UTF-8/秘密脱敏、容量与序号纯测试有证据；50,000 次日志追加及落盘实测见下方；真实 UI 的 50,000 行压力与聊天渲染隔离还需完整验收。 |
| §8/P3 预览 | `ProjectAppDetail.tsx`、`BrowserPanel.tsx`、`browser/BrowserNavBar.tsx`、`WebviewInstance.tsx` | 独立于 session；HTTP URL 受控请求、稳定标签与持久化 scope；返回网格/切日志保留一个宿主，切应用释放旧宿主。process-readiness 允许手动 URL 预览并明确未 HTTP 验证。打包后的真实 Electron 已验证网站和 Vite 预览、返回列表/日志后的输入状态保留、重启后的新 run、停止/正常退出后的端口释放。 |
| §9/P4 继续优化 | `useAppLaunchActions.ts`、`shared/types/workspace.ts`、`src/hooks/session/workspace-binding.ts`、session CRUD/materialization/cache/revival/restart、`shared/lib/session-persistence.ts` | prepareContext 校验绑定与上限；草稿方式传递，保留引用边界；所有引擎启动/恢复路径传递 cwd 与来源。workspace 4、records 8、revival/restart 44 测试通过；完整真实三引擎产品流程未验收。 |
| §9/P4 关联会话 | `AppSessionLink`、service links/linkSession、`ProjectAppDetail.tsx`、`useAppLaunchActions.ts` | 使用 conversationId，运行不依赖会话；跨 Space 导航与目录校验已接。会话删除/历史身份变化的完整 GUI 验收待补。 |
| §10/P6 Agent 工具 | `agent-bridge.ts`、`agent-bridge.test.ts`、`electron/src/project-apps-mcp.ts`、`project-apps.ts` IPC、`shared/types/project-app-agent.ts` | stdio MCP 转发同一主服务；随机 256-bit token、loopback 私有端点、Origin 拒绝、1h TTL、session/项目/固定 cwd 范围、会话停止/轮换吊销。14 项桥接测试通过；独立构建产物 stdio 烟测与真实模型调用状态见证据部分。 |
| §10/P6 宿主审批 | `ProjectAppAgentPermissions.tsx`、bridge 请求/响应队列、AppLayout 常驻 | 页面未打开也显示请求、项目/cwd/工具/完整参数、原配置/新配置及修改字段；一次批准、2 分钟到期、配置变更/撤销后拒绝。伪造 approved 参数、跨 worktree、过期/停止后的权限测试通过；弹窗真实模型联动待验收。 |
| §15/P7 清单交换 | service `exportConfig/importConfig`、`ProjectAppManifest.tsx`、shared 校验 | `schemaVersion:1`，重新绑定项目，无绝对机器路径/env/日志/PID/授权；导入不执行。JSON 可复制/下载/选文件导入。源码包与 WorldBase 包转换未实现，仍保留为后续需求。 |
| §3/P7 组织与本地化 | `strings.ts` 复用 `src/lib/i18n.tsx`、编辑器 folder/order、卡片 favorite、AppFields | 中英同步、文件夹文字分组、数字顺序、响应式网格与菜单/弹窗。拖拽排序、批量操作后续；完整键盘/读屏与 500 项 <100 ms 目标尚未实测。 |
| §14/P5 数据回退与帮助 | `user-guide.md`、store/catalog version、可选 session workspace 字段 | 新目录加法存储；说明损坏备份/停止后降级/旧版未知字段风险。没有声称旧版重写会话一定无损，升级降级完整演练待验收。 |

## 本次实现相对设计的明确选择

- 配置主存储为 `<userData>/openacpui-data/project-apps/catalog.json`，结构为 `{version:1, apps, links}`；采用单写队列统一跨应用/Space/链接事务。早期计划中的按 project/Space 分片是建议落点，不是已交付格式。
- 运行存储为 `runs/<runId>/meta.json`（`version:1`）与 `output.json`。单 run 日志采用 1 MiB 内存、最多 2 MiB 落盘 JSON；历史每应用 20 次、全局 128 次已结束运行，对应约 256 MiB 的历史日志上限，活跃实例另计。前端保留 3,000 块并虚拟化。
- Windows 使用 Job Object/helper 清理归属进程树；停止是强制树终止。POSIX 先 SIGTERM 后 SIGKILL。不能把正常退出保障扩展成断电/系统强杀零残留承诺。
- 页面移除确认框说明会停止此应用的全部实例；主服务确认停止后删除注册项及历史，保留项目源码。完整卡片菜单中的详细操作集中在详情区；未另造多个同时驻留的应用窗口。
- P6 已提前实现受宿主审批的 MCP 工具层，P7 提前实现配置清单和基础组织。可选 `apps_request` 业务 API 验证、多服务编排、Docker 专用适配、源码 ZIP 包仍未实现；原计划范围与后续方向未删除。

## 已有验证证据

- renderer 与 Electron TypeScript 检查通过。最终完整 Vitest：**121 个文件通过、1 个跳过；823 个测试通过、1 个跳过**（2026-10-09，本机 Windows）。跳过项为既有 `opencode-acp` 环境相关用例。
- 应用后端 **29 项**真实进程/存储测试通过，包括 Vite 7.3.1/pnpm、中文空格路径、Windows `.cmd` 特殊参数、linked Git worktree、junction 越界、包装进程退出后的孙进程清理、端口抢占、不同 loopback 地址同端口归属、启动中删除、重启预检、唤醒健康复查、目录移走/恢复、500 项配置清单往返。
- Windows 真实独占文件锁使 catalog 原子替换失败时，内存与磁盘均保留原配置，没有报告保存成功或遗留临时文件。
- 同一次全量测试中，50,000 次日志追加约 **244ms**，含落盘约 **248ms**；保留 4,946 条、核算内存 payload **1,048,552 字节**、磁盘 JSON **895,227 字节**；单次事件不超过 1,024 条，最新 seq=50000 可恢复。这是后端压力证据，不是聊天 UI 性能结论。
- 应用启动动作 6 项、session CRUD 3 项、workspace binding 4 项、records 8 项、恢复/重启 44 项、引擎运行竞态 25 项测试通过。覆盖异步校验期间新输入/附件不能被覆盖，以及 Codex 重启后使用规范 conversation key 打开关联会话。
- MCP bridge **14 项**测试通过，包含真实 loopback HTTP、令牌范围、伪造 sessionId、一次授权、配置差异、版本改变/会话终止/过期后的拒绝。独立构建 helper 已做无模型 stdio `initialize → tools/list`（12 工具）`→ apps_list` 烟测，exit 0；没有据此声称真实模型流程通过。
- tsup 和 Vite 构建通过；应用页独立延迟加载。Vite 仍有既有大 chunk 提示，没有新增构建错误。
- Windows x64 `electron-builder --dir` 成功，ASAR 完整性与原生依赖检查通过。保持 `dist`/`electron/dist` 冻结后，先前由并发构建造成的 ASAR 偏移错误未再出现；未绕过完整性校验。
- `scripts/smoke-project-apps.cjs` 直接启动打包后的 **Harnss.exe**，使用新建 TEMP profile 和 fixture 项目，真实 preload/IPC/Job helper/浏览器/PTY 均参与。已验证：零项目零会话入口、通过界面保存网站、无特权 preload 的预览、返回列表保留网页输入、中文路径中的 pnpm/Vite 脚本发现/启动/HTTP 就绪、日志与预览切换、独立终端创建/清理、重启生成新实例、停止释放端口、正常退出清理活动服务、重新启动保留配置与已结束历史且不自动运行。
- 退出清理超过 **15 秒**会进入重试/取消/强制退出决策；重试继续观察仍在执行的清理，不发起并行 shutdown。定时器回归测试通过。

复验命令（不修改真实用户 profile）：

```powershell
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p tsconfig.json
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p electron/tsconfig.json
pnpm --config.verify-deps-before-run=false exec tsup --config tsup.electron.config.ts
pnpm --config.verify-deps-before-run=false exec vite build
# 构建结束后再打包，期间保持 dist 和 electron/dist 不变。
pnpm --config.verify-deps-before-run=false exec electron-builder --config electron-builder.config.js --win --x64 --dir
node scripts/smoke-project-apps.cjs
```

本机运行证据写入被 Git 忽略的 `outputs/project-apps-smoke/`：测试/构建/打包日志、`packaged-smoke.json`、页面截图。fixture profile 路径记录在 JSON 中；脚本只清理本次创建的进程，保留测试数据以便审阅。

## 尚需完成的验收

1. Windows NSIS 安装/卸载与 ARM64 真机；目前证据为 x64 unpacked 可执行程序及其真实运行流程。
2. 剩余 Electron GUI 矩阵：系统文件夹选择、跨 Space、多 worktree 同时运行、草稿及关联会话的完整导航、真实模型审批超时/拒绝。已通过的主要流程见上方，不将未运行的交互合并声称通过。
3. 三引擎真实模型流程：新草稿/首次发送/恢复/重启的 cwd，MCP 注入可见性和工具调用、宿主审批、配置版本变化和 session 撤销。
4. macOS/Linux 实机及安装包；真实 Next.js、npm/yarn/bun 多包管理器测试，尤其 POSIX 组清理与 GUI PATH。
5. 500 应用搜索的 GUI 实测、50,000 行日志的 UI 压力和聊天响应隔离；完整键盘/读屏检查。弹窗焦点恢复及减少动效样式已实现，仍需完整产品验收。
6. 配置损坏人工修复、升级降级/会话未知字段的完整演练。文件独占导致写失败的真实测试已通过；错误不能显示成成功；原目录必须保留。

这些待验收项属于原计划的发布要求，不由已有类型检查、单元测试或其他平台成功结果替代。
