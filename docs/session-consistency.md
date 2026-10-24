# Session consistency and checkpoint ownership

## Invariants

- Title/settings mutations use sessions:update-meta and never load then rewrite a message snapshot.
- Message writes are serialized per runtime in the renderer. Persisted snapshots carry a message revision; the repository rejects explicitly stale revisions under its existing logical/runtime locks. Legacy callers without revisions remain supported.
- Metadata patches do not advance the message revision. User metadata remains authoritative over subsequent message checkpoints.
- Mounted panes register live snapshot readers in the shared background registry. Handoffs read live state, and the final pane release retains its latest state. Engine reset reads again at commit rather than trusting an earlier asynchronous bootstrap.
- Snapshot readers include buffered text not yet painted by requestAnimationFrame. ACP raw permission choices travel with the permission prompt.
- All pane/background changes use one checkpoint scheduler: 2-second debounce, 5-second maximum wait, immediate completion/permission checkpoints and explicit flush on quit. Failed saves stay dirty for retry.
- Before window destruction, the main process stops engines and requests a nonce-bound renderer flush. Failure/timeout asks the user to retry, cancel or force quit. Forced quit deliberately skips pending cleanup.
- A reaper rechecks activity after awaiting persistence, does not overlap passes and retains state on stop failure.

## Selection/commit handoff safety

Selecting a background session takes a cloned bootstrap; it does **not** remove
its accumulator. A React transition can be delayed or cancelled. Events between
selection and pane commit must update that same full history, which the base
engine reads again at commit. The pane publishes its post-reset buffered reader
immediately, not the earlier bootstrap. Ordinary full saves reject missing
historical message IDs under the repository lock, even without a revision or
with a matching revision. Explicit revert/recovery uses the existing previousId
replacement path; ordinary checkpoints cannot implicitly truncate history.

## Storage recovery

JSONL is authoritative. Appends repair a torn trailing record and preserve complete records missing only a newline. Metadata reads detect a newer JSONL source after a lost sidecar write. JSONL parsing rejects malformed record shapes. Secret stores replace encrypted/plaintext files through a restrictive temporary file and rename.

## Related bounds and performance

Attachment reads share one UTF-8 byte budget across files and directory trees, deduplicate canonical paths, reject scope escapes and bound reads even if files grow. Git branch/log details are shared by repository and invalidated by HEAD/branch/upstream changes, explicit actions or a 30-second TTL. Task upserts use an exact-runtime metadata read instead of listing the project. Structural chat derivations no longer rerun for every text delta.

## Regression coverage

See checkpoint-scheduler, live-session-state, acp-handoff, useBackgroundReaper-races, persistence-integrity, persistence-bridge, files-budget, file-read-budget, renderer-flush, json-file-store-atomic and repo-details-cache tests. Standard Vitest includes now cover shared tests too.

These automated checks do not substitute for native Windows/macOS/Linux UI acceptance tests, especially OS shutdown, process crashes and production macOS Glass behavior.
