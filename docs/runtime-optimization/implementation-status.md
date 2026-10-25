# 实施状态与交接

更新：2026-10-25（Asia/Taipei）。分支：`codex/runtime-optimization`。

## 1. 当前结论

**已在独立 worktree 开始实现，并交付一批可验证的功能；完整优化方案尚未全部完成。当前不应按“11 个工作包全部完成”合并。**

- 原目录 `E:/code/git/harnss` 保持 `hy_dev`，另一个 agent 的未提交业务改动没有复制、修改或回退。
- 本分支从 `42e2e641292ba3af607dc8452eb6b1be39fceead` 创建，仅带入优化文档，并独立修改 README/ignore 导航。
- 保存编码复用、只读分页历史、受验证的 worker/IPC 与大内容读取已经接入桌面。
- 身份/状态机/能力、命令账本与无窗口协调内核已有隔离单测，但**没有接管三引擎实际发送/审批/保存链路**。
- 没有迁移真实 profile、运行付费模型、开放网络服务、修改发布版本、执行打包发布或自动合并。

详细代码范围、限制和下一步见[当前实现与边界](implementation-evidence.md)及[ADR-001](ADR-001-implementation-boundaries.md)。

## 2. 逐工作包状态

| 工作包 | 当前状态 | 尚缺部分 |
| --- | --- | --- |
| OPT-00 基线与观测 | 部分完成：类型/全量测试基线、编码微基准、生成 UI 冒烟 | 完整会话读盘→IPC→paint 的分段 p95、并发/后台长期压力 |
| OPT-01 契约与 ADR | 部分完成：运行身份/状态/命令 schema、能力四态及边界 ADR | 三引擎实际能力矩阵、日志/SQLite 操作库 spike 对比、最低兼容版本与 G1 |
| OPT-02 原始协议回放 | 未完成：既有 stdio/SDK 竞态测试已回归 | 通用回放框架、三引擎真实 normalizer 与新权威链路联测 |
| OPT-03 保存准备优化 | 已接入编码复用并通过针对性/全量回归 | 显式 dirty revision 的全链路改造、端到端保存/资源验收 |
| OPT-04 有界历史 | 已接入 worker 索引、IPC、只读 UI、分段读取与缓存清理 | 主聊天路径的有界加载/续聊、完整冷构建取消/进度体验与所有极端旧数据支持 |
| OPT-05 命令账本 | 隔离原型：接收/去重/CAS/重开/尾损坏/未知状态测试 | 实际 journal→JSONL 应用、水位、压缩/保留、真实 kill/故障耐久与生产后端决定 |
| OPT-06 主端接管 | 隔离内核：单 runtime、排队、审批与终态语义测试 | 实际三引擎 adapter、正文/投影、无 renderer 工作流和 G2 |
| OPT-07 共享客户端 | 部分完成：只读分页 controller、迟到结果拒绝、有界窗口 | 主聊天共享 RuntimeClient、细粒度活动/输出订阅、重试 owner 切换 |
| OPT-08 迁移与回退 | 未实现 | profile 迁移 manifest、全部旧入口 fencing、兼容导出/回退、stale lock 恢复 |
| OPT-09 验收与灰度 | 部分完成：当前代码类型/单测/构建/Windows UI | 完整 58 项矩阵、真实引擎、平台安装包、升级/降级与灰度 |
| OPT-10 可选远程 | 未启动 | 独立授权、远程项目选择与安全/部署门槛 |

所有 G0～G5 的完整退出条件尚未全部满足。没有 managed writer 设置或网络 IPC 暴露给用户，旧三引擎仍按原逻辑运行。

## 3. 当前验证结果

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| `pnpm typecheck` | renderer / electron 均通过 | 当前 worktree |
| `pnpm test` | 199 个文件通过、4 个跳过；1,451 项通过、19 项跳过 | 比基线新增 42 项通过用例；不是 58 项目标全覆盖 |
| `pnpm check:native` | Windows x64 的 15 个原生运行文件检查通过 | 安装目录静态检查，不是安装包 E5 |
| `pnpm test:native` | 38 项通过 | 原生依赖/构建与打包配置测试 |
| `pnpm build` | 通过 | 包含新增 history worker / 懒加载 UI；仍有大 chunk 提示，未执行 electron-builder |
| `pnpm perf:runtime` | S/M/L 60 样本交错 A/B 完成，内容比对通过 | 仅编码微基准；非端到端保存/首屏 SLA |
| `pnpm test:runtime-ui` | 通过 | Windows / Electron 40.4.0；250 条生成消息，3 次分页、1 次分段读取，6 行可见 DOM，源文件未变化 |

实现代码没有调用真实 Provider 或用户会话。控制存储/协调内核测试使用临时目录和注入端口；没有完成真实进程 kill、断电、三引擎主端接管、迁移或跨平台安装包验收。

上述单测数是实际运行结果，不等于测试计划中的 58 个验收编号全部通过。现有测试的 skip 保持单独列出；没有把构建通过当作安装包通过。

## 4. 可复现入口

```powershell
pnpm typecheck
pnpm test
pnpm perf:runtime
pnpm build
pnpm test:runtime-ui
```

`perf:runtime` 是编码算法微基准，`test:runtime-ui` 用临时 profile、生成历史和生产 history worker 验证只读界面；不是三引擎真实模型测试。详细原始日志和截图在 `.cache/runtime-optimization/`，摘要见实现证据文档。

## 5. 后续关键路径

1. 继续在本分支工作，不切回原工作区修改另一个 agent 的内容；合并前重新核对原分支变更。
2. 建设完整原始协议回放，冻结 G1 的实际存储/恢复/兼容决定；当前控制日志不能直接用作用户 profile 的唯一 writer。
3. 完成一个真实 adapter 的主端垂直切片，再做三引擎；真实模型调用前明确 provider、测试 profile 和额度授权。
4. 接通 journal→JSONL 幂等桥接、正文投影与持久审批，然后实现旧 save/send/retry 全入口 fencing 和迁移恢复。
5. 接入主聊天 RuntimeClient 和实际三引擎控制，补齐功能回归、端到端性能与生产产物证据，全部目标达成后再评审合并。

## 6. 规划期历史记录

原工作区在文档阶段做过 5 份 Markdown、35 个链接、58 个用例 ID、11 个工作包依赖及 33 个源文件哈希的静态核对；当时没有运行实现验证。`code-baseline.json` 保留该历史现场（含另一个 agent 当时的并发改动观察），不是本实现 worktree 的当前哈希清单。不要继续引用规划期的“业务尚未开始”描述作为当前状态，也不要将本次部分实现宣称为完整目标已完成。
