# OpenCode ACP integration

Validated against OpenCode 1.19.3 (2026-10-16 release) and the repository's installed ACP SDK 0.15.x.

## Runtime contract

- OpenCode remains an ACP stdio agent. Native Windows npm shims are unwrapped only when they match the known generated shim exactly; custom batch logic is preserved.
- Preserve all negotiated agent capabilities. Resume an existing local transcript using session/resume; fall back to session/load only when resume is absent or returns JSON-RPC method-not-found. Other errors do not silently create a fresh context.
- Legacy agents without restoration support retain the existing fresh-session fallback. usedLoad means context was restored (including resume), not necessarily that history was replayed.
- Main-session notifications are routed by the ACP session ID. Startup control events are bounded and buffered; unrelated sessions cannot enter chat, config buffers, or memory. Replay does not enter memory observation.
- Permissions are cancelled on interruption, shutdown, or disconnection. Only option IDs actually offered by the agent are accepted. Filesystem callbacks require the active, known session.
- Cancellation has a bounded grace period. An agent that does not finish its prompt is stopped; only its owned process is terminated.
- Stable config APIs take precedence. Only method-not-found permits legacy model/mode fallback. Model changes invalidate legacy effort options. Mutations are serialized per session and stale renderer responses are ignored.

## Usage and MCP

ACP costs are cumulative **remote-session** snapshots (not per-turn deltas). Both foreground and background use the same reducer. The USD display does not silently treat another currency as USD. Context usage already includes cache input; stale token breakdowns are cleared to avoid double counting.

Standard ACP does not provide an MCP health query. The UI therefore shows **Configured — agent connection unverified**, never “connected” merely because session creation succeeded. A client-side probe cannot attest the agent's internal connection.

OpenCode registers MCP connections by directory and does not remove them when a shorter list is passed to load/resume. Changes therefore stop the old process and revive the same backing session in a new process. Agent-side/global OpenCode configuration is still independent of AstraDock's injected MCP list.

## Text-only utility tasks

Title and commit-message generation no longer share the chat connection. OpenCode utilities run in a dedicated process with:

- a new temporary working directory and project configuration disabled;
- external plugins disabled (pure mode);
- a unique primary agent with an explicit deny-all permission policy;
- verification that the server selected that agent **before** sending a prompt;
- no advertised client filesystem access; all permission requests cancelled;
- bounded creation/execution/close plus unconditional owned-process teardown;
- best-effort bounded retry for Windows temporary-file cleanup, without masking the original failure.

Global provider configuration/authentication can still be used. This is an agent-level tool policy, not an OS sandbox for an untrusted executable. Generic ACP has no standard tool-disable contract, so agents without a verified implementation fail closed for utility generation; their normal chat functionality remains available.

## Sessions and history

The chat header (including split panes) exposes a capability-gated session browser with cursor pagination, virtualized rows, explicit import, and fork of the current conversation. Import uses a separate capture path that does not publish replay to the original chat or memory. Histories larger than 10,000 notifications or 32 MiB are rejected rather than silently truncated. Imported conversations retain their remote session ID for later resume. Remote fork records remain persisted upstream even after the transient connection session is closed.

Multi-file ACP diff blocks are preserved as structured patches and reuse the existing multi-file renderer, summary, and file-tracking paths.

## Verification

Run pnpm typecheck, pnpm test, and pnpm build.

For the opt-in installed-binary integration test:

~~~powershell
$env:OPENCODE_E2E = "1"
pnpm test electron/src/lib/__tests__/opencode-acp.test.ts
~~~

The integration test checks initialization, unavailable-MCP acceptance, utility-mode selection, resume, list, fork, close, and both PATH/native launching. It uses isolated test data and **does not call a model**. Real provider billing and inference/tool execution require separate credentialed validation. Git-backed tests require Git on PATH.

## Opt-in real free-model inference

The live suite verifies zero input/output/cache pricing before inference, pins both normal and small-model selection, restricts the provider model list, isolates config/authentication/data, and never falls back to a paid model. It sends only synthetic prompts and temporary fixtures.

~~~powershell
$env:OPENCODE_FREE_LIVE = "1"
$env:OPENCODE_FREE_MODEL = "opencode/deepseek-v4.1-flash-free"
$env:OPENCODE_FREE_REPORT = "$env:TEMP/astradock-opencode-free-live-report.json"
pnpm test electron/src/lib/__tests__/opencode-free-live.test.ts
~~~

Cases: streaming/token usage, context after process restart, approved edit, denied edit, production utility-process isolation, cancelling a running MCP tool, and idempotent real usage updates. Provider access rejection fails the first check and explicitly blocks subsequent checks. Zero tokens/cost without a successful response is not a successful inference test.

### 2026-10-17 execution

The selected model advertised zero input/output/cache prices, but both ACP and the official `opencode run` CLI received the provider's HTTP 403 FreeTierError (free tier restricted to use within OpenCode). No successful generation was obtained. The final run was **1 failed, 6 blocked/skipped**, not an inference pass. No paid-model fallback, identity spoofing, or access-control bypass was attempted. The normal opt-in-free test suite remains disabled unless explicitly enabled.
