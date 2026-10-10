# 项目应用使用说明

更新：2026-10-09。功能实现与验证范围见 [实施记录](implementation-status.md)。

## 添加与运行

侧栏的“应用”可在没有聊天会话时打开。项目菜单的“添加到应用”会预选该项目。

1. 点击“添加应用”，选择“项目应用”。已有项目直接选择；“添加项目”接入本地目录。
2. 选择项目主目录或已存在的 Git worktree。工作目录填写相对于该根目录的路径，例如 `apps/web`；留空表示根目录。
3. 点击“检测启动命令”。检测只读取项目元数据，不安装依赖、不执行脚本。选择候选后仍可修改配置。
4. 包管理器脚本分别填写包管理器、脚本名和参数；自定义服务填写可执行文件和参数。参数每行一个，含空格的单个参数无需另加引号。复杂命令请放入项目脚本文件，再调用脚本。
5. 配置端口、预览地址、就绪检测并保存。点击卡片“启动并打开”，或进入详情后选择运行工作区并启动。

自动分配端口适用于 Vite、Next.js 适配器。通用命令使用固定端口或不管理端口，不能假定任意程序支持框架参数。预览地址支持 `{port}`，例如 `http://127.0.0.1:{port}`。HTTP 就绪检测根据预览地址、检查路径和允许状态码判断是否就绪；“进程存活”只表示进程启动，预览会标明未经 HTTP 检查。

“网站”类型保存完整的 HTTP/HTTPS 地址，不创建本地服务或 Agent 会话。搜索框输入完整网址可以临时打开，也可以保存为应用。普通搜索仅筛选本地目录。

## 工作区、预览与日志

本地应用的 Space 跟随所属项目；网站快捷方式单独归属 Space。切换 Space、聊天或应用面板不会切换正在运行的工作目录。卡片默认指向保存的工作区，详情可显式选择其他 worktree；每个应用在同一实际根目录与相对子目录中只有一个活跃实例，不同 worktree 可以分别运行。

停止、重启操作以所选运行实例为目标。多个实例运行时，卡片停止入口会转到详情让用户选择；不会同时停止其他 worktree。保存配置不改变正在运行的命令，详情会提示何时需要重启。目录消失时列表显示“工作区不可用”；恢复目录后刷新，或在配置中重新选择有效工作区。应用不会自行改用项目根目录。

预览复用 Harnss 内置浏览器，也可“在默认浏览器打开”。从详情返回应用列表、或查看日志时保留当前预览；切换应用释放旧预览，只保留一个应用预览宿主。跨应用切换不保证网页中未提交的表单保留。关闭浏览器或面板不停止服务。

日志按运行实例区分，可过滤、复制并关闭“跟随输出”。前端虚拟化渲染，最多保留最近 3,000 个日志块；日志块可能包含多行。后端每次运行内存日志上限为 1 MiB，单次超长写入截取至约 64 KiB，落盘 JSON 上限为 2 MiB。输出被裁剪时显示提示。序号缺口会自动按 cursor 有限补读；无法恢复的历史不会无限重试，也可手动刷新。

详情提供“在此目录打开终端”，可手动检查或安装缺失依赖。该终端只在用户点击后创建，使用经校验的工作目录；关闭终端、离开详情或更换工作区会结束该终端，不会停止托管服务，也不会改动聊天/Space 中的终端。

## 继续优化与 Agent 工具

点击“继续优化”会打开带应用上下文的新草稿；可选择是否附上最近日志，并在聊天输入框选择 Claude、Codex 或 ACP Agent 后发送。上下文与会话保存固定的工作区绑定，恢复或重启会话时不能因为全局 worktree 选择变化而进入其他目录。应用“关联会话”记录稳定会话身份，点击后回到相应聊天。已删除或尚未保存的会话会明确显示不可用，不影响应用运行。

应用服务还提供 MCP 工具。列表、状态和日志受会话项目/工作目录范围限制；注册、修改、启动、停止、重启、移除等变更由 Harnss 常驻审批弹窗展示实际配置与命令，以及修改前后的配置和修改字段。批准仅对本次请求有效，配置发生变化须重新请求；审批超时、会话停止或权限撤销都会拒绝执行。各引擎的真实模型工具调用仍须按 [实施记录](implementation-status.md) 的验证范围判断。

## 配置清单与数据

“导出配置”导出筛选结果，卡片菜单可导出单个应用；“导入配置”可读取 JSON 文件或粘贴 JSON。交换格式是 `schemaVersion: 1`。导入项目应用时必须重新选择本地项目，随后可编辑并选择 worktree。导入只保存配置，**不会执行安装或启动命令**。

清单不包含源码、运行日志、PID、聊天正文、运行授权、机器绝对目录或环境变量值。它不是应用安装包，也不承诺兼容 WorldBase 包格式。源码 ZIP 包、拖拽排序、批量操作、多服务编排、LAN 分享与跨设备同步仍是后续范围。当前支持文件夹文字分组和自定义顺序数字。

本机数据在 Electron `userData` 下：

```text
<userData>/openacpui-data/project-apps/
  catalog.json                    # version: 1，应用定义和关联会话
  runs/<runId>/meta.json           # version: 1，有限运行历史
  runs/<runId>/output.json         # 有界日志
```

生产 Windows 通常为 `%APPDATA%/Harnss/openacpui-data/project-apps/`；开发和隔离测试环境可能设置不同的 `userData`，应以当前进程路径为准。目录及单份清单最多 1,000 个注册项（清单还受 2 MiB 大小限制），catalog 上限 8 MiB。每应用保留最近 20 个已结束实例、全局最多 128 个已结束实例；结束、加载及退出时清理，活跃实例不会因历史容量限制被停止。

环境覆盖仅用于非敏感运行配置，如 `PORT`。含 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 等名称的凭据配置以及部分危险进程选项会被拒绝，凭据留在项目自己的环境配置。已知凭据值会在日志处理时脱敏，但不能保证识别项目输出中的所有秘密；分享日志前仍需检查。清单导出移除全部环境值，导入不接受携带环境覆盖。

移除应用不会删除源码。移除确认后会停止此应用全部活跃实例，再删除配置和历史；删除项目或 worktree 经过生命周期屏障，清理失败不能继续删除。正常退出 Harnss 会等待托管进程清理。超过 15 秒仍未确认时，可继续等待、取消退出或明确选择强制退出。仅关闭窗口而启用“后台保持运行”不等于退出，服务可继续运行。系统强杀、崩溃或断电后重启会把未确认结束的历史标为 `interrupted`，不会按存储的旧 PID 接管或终止其他进程。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 包管理器/可执行文件找不到 | 在同一系统环境确认已安装所选运行时，或在配置中选择正确可执行文件；面板不会自动安装依赖。 |
| 端口被占用 | 修改固定端口，或给 Vite/Next 选择自动端口。Harnss 不会为了腾端口杀掉陌生进程。 |
| 启动超时、HTTP 未就绪 | 查看日志，确认监听地址、预览端口、健康路径和允许状态码；按需增加启动超时。日志打印 URL 不等于已就绪。 |
| 进程在运行，但无预览 | 配置预览地址。通用服务可以只运行没有网页；进程就绪模式不会验证网页业务是否正确。 |
| worktree/目录不可用 | 恢复目录或在编辑器重新绑定实际存在的目录；不要在外部手改运行记录。 |
| 配置版本冲突 | 刷新应用列表，重新打开编辑器并重做修改，避免覆盖他处新配置。 |
| 日志截断或部分缺失 | 容量上限会丢弃更早输出；自动补读只能恢复仍保留的数据。刷新日志可重新读取可用区间。 |
| 清理未完成 | 对明确的运行实例再次停止并查看错误；未确认清理完成前不要删除 worktree。 |
| catalog 损坏 | Harnss 保留原文件并报告错误，不会默默覆盖为空。退出应用后备份整个目录，再恢复已知良好备份。 |
| 降级旧版 Harnss | 先停止服务并备份应用目录和相关会话。旧版重写会话可能丢失新 workspace binding 字段，不能假定降级无损。 |

## English quick start

Open **Apps** in the sidebar, add a project app, select an existing project/worktree, detect a package script, and review its command, port, preview URL and readiness check. Discovery and configuration import do not execute commands or install dependencies. Website shortcuts work without a project or chat.

Runs are independent of chats and Space navigation. Select the exact workspace/run in Details before stopping or restarting it. **Continue improving** creates a reviewable draft bound to that workspace; choose the agent in the composer before sending. Agent mutations require one-time host approval showing their concrete configuration.

App data uses `<userData>/openacpui-data/project-apps/catalog.json` (`version: 1`); exported manifests use `schemaVersion: 1`. Exports omit source, machine paths, logs, sessions and environment values. Normal Quit cleans up owned processes; a forced termination is recorded as interrupted on the next launch. Windows Vite and process-tree behavior have local test evidence; macOS/Linux, real Next.js and full model-driven integration still require the acceptance checks in [implementation status](implementation-status.md).
