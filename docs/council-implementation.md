# Council implementation and verification

## Entry point

Workflow Center → Model Councils (工作流中心 → 多模型讨论组).
Create a project/workspace-bound Council with 2–4 seats, a separate moderator, model IDs and roles. Start a topic with reviewed materials. Current-conversation import fills an editable material field; it never sends automatically. A group may hold multiple completed topics; finish/cancel its previous topic before starting another.

## Implemented

- Electron main-process scheduler, independent of mounted React hooks.
- Parallel review and bounded consensus (up to three rounds, concurrency <= 2, <= 24 calls, per-call deadline).
- First-round isolation; each subsequent call receives a frozen packet, not another member's streaming output. Independent ephemeral calls deliberately replace persistent model threads; continuity is the explicit packet.
- Typed moderator schema, one format-repair call, explicit per-seat agreement required for consensus. Missing/unstructured/dissenting responses cannot establish unanimity.
- Pause dispatch / resume / immediate cancel; individual retry or skip; uncertain sends require explicit acknowledgement. Old attempts remain inspectable.
- Round-boundary supplements, visible unused materials, context hashes and source statement references, explicit no-silent-truncation limits.
- Schema-validated, atomic main-process persistence with request fingerprints and optimistic revisions. Restart marks unfinished dispatch uncertain and never automatically replays it.
- Streaming text is ephemeral and targeted to individual subscribed rows; terminal text/control state is durable. Renderer reload may temporarily lose an in-flight partial preview, but not committed statements.
- Project runtime leases, project-deletion cleanup, shutdown interruption, damaged-file preservation.
- Readable statement cards, virtualized transcript, bilingual controls, per-round disagreements/movement, conclusion classification and reported usage (unknown is not zero).
- Preview/edit conclusion as a TaskBrief; explicit task creation reuses the existing task system. No automatic agent execution or task acceptance.

## Explicit capability boundary (not a cross-engine completion claim)

The verified adapter is Claude only, with configurable different Claude models and roles. It uses the existing SDK, binary discovery and login, not a new API-key system. Every call uses a temporary cwd, tools=[], empty strict MCP, no plugins, disabled hooks, no settings sources, no session persistence, and a deny-all permission callback. Only an allowlisted set of user-setting authentication/provider environment values is forwarded; credential helpers, project settings and arbitrary settings environment are not imported. Credentials are never stored in Council records.

Codex and ACP are represented in the contract but disabled in the capability list AND rejected in the backend. Codex's read-only sandbox does not establish the selected material-only/no-MCP boundary; arbitrary ACP agents lack a portable no-tools contract. No post-hoc tool-event check is treated as preventive isolation. Their ordinary chat sessions are unchanged. Safe cross-engine adapters remain follow-up work and must come with verified preventive controls and live acceptance before being enabled.

There is no unrestricted repository-reading mode, multi-agent file editing, automatic memory writes, autonomous member addition, or self-expanding permissions. Submitted materials still leave the computer for the configured model provider. Agreement is not independent factual verification.

## Modules

- shared/lib/council.ts: validation, limits, durable schemas and output contracts.
- shared/types/council.ts: shared type/API exports.
- electron/src/lib/councils/service.ts: single-writer transactions, dispatch, round progression and lifecycle.
- context.ts: deterministic packet assembly, hashes, convergence checks.
- repository.ts: atomic storage; runtime.ts / credential-env.ts: isolated adapter and credential-only configuration.
- electron/src/ipc/councils.ts: main-renderer-only IPC; preload / window declarations expose the typed API.
- src/hooks/useCouncil.ts: revision-safe projection and per-attempt streaming subscriptions.
- src/components/council/: creation, topics, transcript, assessments and reviewed task conversion.

### Storage decision

The first bounded implementation uses getDataDir()/councils/catalog.json (schema version 1, at most 32 MiB, 100 groups, 200 topics), not multiple independently committed files. Frozen prompts, statements and control state commit together via writeJsonAtomically. This avoids a dual-write consistency gap; it is not a scalable transcript database. At capacity, mutations fail without replacing the prior valid catalog; users can remove old stopped groups. Migration to per-run stores is a later performance change, not silently implied here.

### State and recovery

A topic has running / pausing / paused / waiting_user / interrupted / completed / cancelled / failed states, with separate participants / assessment phases. Each invocation has its own attempt ID and project lease. Dispatch preparation is durable before execution. A crash before durable completion becomes dispatch_unknown. A returned result whose commit fails is also uncertain. There is no exactly-once claim at an upstream model boundary.

A corrupted catalog is retained, not reset. A cancelled application quit does not permanently disable new discussions. A final assessment at the exact call cap is still committed; exhausted capacity without a valid assessment produces an explicit inconclusive result, never another hidden call.

## Verification commands

Use pnpm with the normal development Git executable on PATH for the full suite (some existing tests create real temporary Git worktrees).

- pnpm test electron/src/lib/councils electron/src/ipc/councils.test.ts shared/lib/council.test.ts src/hooks/useCouncil.test.ts
- pnpm test
- pnpm typecheck
- pnpm build
- pnpm test:council-ui

The UI smoke bundles the production service and repository, starts a hidden offscreen Electron window with a temporary user profile and synthetic model responses, drives creation → discussion → conclusion → renderer reload → reviewed task creation, and asserts no replay or implicit execution. It does not use a real provider or modify user conversations. Its screenshot and report are under .cache/council-smoke/.

Optional real-provider smoke: set ASTRADOCK_COUNCIL_LIVE=1 and run pnpm test:council-live. This explicitly permits one synthetic paid Claude call with the existing login. COUNCIL_SMOKE_MODEL overrides the default haiku alias. No project content is sent. The test fails if authentication, model access, the strict policy or the expected result is unavailable. During implementation, this live check failed with a Claude authentication-class error; it is NOT counted as passed or as an end-to-end provider acceptance.

## Design references

Mechanisms were studied in ai-us-stock-lab/roundtable (independent takes, round boundaries, execution separation) and trekhleb/yesbrainer (mediator, stance revisions, explicit remaining disagreement). No source code or prompt templates were copied from those projects. No new runtime dependency was added.

## Recorded verification — 2026-10-31

- Council-focused suite: 42 tests passed across 7 files.
- Full regression: 212 files passed, 4 opt-in files skipped; 1,586 tests passed, 19 skipped.
- Renderer and Electron TypeScript checks: passed.
- Production Electron/Vite build: passed; bundle-size warnings remain.
- Hidden Electron UI smoke: passed with 6 synthetic model calls across two rounds, no calls on renderer reload, and exactly one explicitly confirmed task creation. Screenshot visually inspected.
- Real Claude smoke: not passed; installed CLI 2.1.309 returned an authentication-class error. Authentication/model access must be resolved and the opt-in smoke rerun before claiming real-provider acceptance.
- Codex/ACP Council execution: intentionally unavailable, not tested as working.
