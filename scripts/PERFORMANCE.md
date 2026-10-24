# Performance optimization and verification

Updated: 2026-10-24. These are local measurements, not universal latency or FPS guarantees.

## Implemented

- Chat and explorer use measured virtual rows. Chat structure is rebuilt on structural changes; only mounted message descriptors follow streaming content. Search scrolls to an index before highlighting. Bottom-follow preserves user intent across slow measurements.
- Persistence compares immutable JSON wire snapshots, not cloned object identity. Unchanged messages are omitted; nested in-place tool updates are detected. Serialized snapshots are captured before queued writes. Existing revision, replacement and incomplete-history guards remain. Cursor storage has a 16 MiB estimate budget and 20-session cap.
- File sorting reuses Intl.Collator. File refresh is single-flight with one trailing invalidation per hook, shared in-flight IPC, and unchanged-list suppression. Content-only watcher events are verified at most once per five seconds; structural/unknown changes refresh promptly. Focus and manual refresh remain available.
- Computer Use probes use bounded asynchronous execFile and coalesce concurrent checks. Permission state is still checked afresh, never served from a stale authorization cache.
- Claude history previews stream at most 512 KiB / 100 nonempty lines and have a 512-entry mtime/size cache. Large transcripts with unavailable previews remain visible. Imports run serially in a dedicated Worker, stream JSONL, and use an ID map for tool-result lookup. Worker requests have a timeout and same-file deduplication.
- Git repository discovery uses asynchronous directory reads; discovery and repository-state caches have entry caps.
- Long streaming Markdown is rate-limited (64 ms above 5k characters; 120 ms above 20k), memoized, and fully refreshed immediately on completion. Math rendering and the workflow view are lazy. The permanently disabled renderer PostHog SDK/provider was removed; main-process consent and privacy controls are unchanged.
- Terminal output is coalesced over 16 ms or 64 Ki characters. Snapshot and exit flush the batch before returning sequence information. History uses a single-owner deque rather than copying all chunks on every append; live history remains capped at 250k characters.
- Session payload caching adds a 32 MiB serialized-size estimate budget to its six-entry cap.
- Semantic search keeps exact ranking, filtering, cancellation and worker isolation; top-100 selection no longer sorts/allocates an array for every accepted vector.

## Reproduce

Use the existing dependencies; no new runtime dependency was added.

```text
pnpm typecheck
pnpm test
pnpm build
pnpm perf:bench
pnpm perf:smoke
```

The smoke command starts its own hidden Electron window and loopback Vite server with a separate profile under .cache/performance-smoke. It uses synthetic data only, never the user's sessions, credentials or live engines. It asserts:

1. 10,000 messages mount fewer than 100 message rows.
2. Search reaches an unmounted message.
3. Appending after a user scroll to the bottom preserves bottom-follow within two pixels.
4. Final long-stream content and lazy math render correctly.
5. A 10,000-file explorer mounts fewer than 100 rows.

Results are written to .cache/performance-smoke/result.json. The server and Electron process exit after the run. This is a correctness/DOM-budget smoke test using the development renderer, not a production FPS benchmark.

## Observed results

- Same-process 10k-path tree benchmark: previous comparator roughly 253–257 ms median; reused collator roughly 11.6–12.2 ms. Seven measured runs after warmup; both trees are asserted equal.
- Real Electron synthetic smoke: 10 mounted chat rows initially, 21 around a search hit, 31 explorer rows. Exact counts depend on viewport and measurements.
- Persistence integration: unchanged cloned 1,000-message snapshot sends zero message deltas; modifying the tail sends one. Nested mutation and queued snapshot isolation also have regression coverage.
- Previous audit entry: 2,729,255 bytes / 804,785 gzip. Optimized build observed approximately 2.25 MB / 660 kB gzip. These are artifact sizes, not measured startup times; the workspace also contains unrelated in-progress changes.

## Validation on this workspace

- Renderer and Electron TypeScript checks passed.
- Full suite: 190 test files passed, 4 skipped; 1,384 tests passed, 19 skipped.
- Production build and built JSONL import-worker smoke passed.
- Real isolated Electron DOM-budget/search/bottom-follow/stream/math smoke passed.
- Git diff whitespace check passed with the repository's CRLF normalization.
- No installer packaging, version bump, commit, or release was performed.

## Deliberate limits / follow-up measurement

- JSON snapshot comparison still scans message content at checkpoint time. It trades some CPU for correct detection of both immutable foreground updates and mutable background updates, without a cross-engine mutation-contract rewrite. Cursor eviction can require a full save.
- Markdown is not split at arbitrary blank lines: that would break cross-block references and unfinished constructs. Completed-block incremental parsing needs a syntax-aware implementation; current throttling preserves full Markdown semantics.
- Terminal batching is not an ACK-based end-to-end flow-control protocol. Sustained multi-megabyte output should be profiled before introducing PTY pause/resume and renderer acknowledgements.
- Semantic search remains an exact vector scan. No unvalidated ANN dependency, changed recall behavior, or native packaging requirement was introduced. Benchmark realistic 10k/100k vector datasets before choosing an index.
- Serialized-size cache budgets are estimates, not exact JS heap measurements. Run production CPU traces, heap snapshots, cold-start trials and long-running multi-engine tests before claiming global memory/FPS improvements.
- Vite still warns about large chunks (including lazy syntax highlighting and diagrams). No artificial warning threshold was raised.
