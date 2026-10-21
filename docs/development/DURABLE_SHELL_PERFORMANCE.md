# Durable shell performance and recovery

> **Use a bounded page for task history.** Call `shell` with
> `operation: "list"` and `limit` (1–200). Omitting `limit` keeps the legacy
> compatibility path, which may scan and hydrate all durable history.

This document explains the durable shell index introduced for Native Goal
automation and ordinary background shell tasks. Its main invariant is that a
warm launch and a bounded history page depend on the active set or requested
page, not on the total number of terminal tasks.

## Storage layout

Each task still owns its exact directory and output files:

```text
<durable-task-root>/
  <task-id>/
    task.json
    spec.json             # removed by the worker after it starts
    stdout.log
    stderr.log
    worker.pid
    worker.started
  .index/v1/
    ready.json
    index.lock
    launches.jsonl
    active/
      <sha256(task-id)>.json
```

Exact `status`, `wait`, `logs`, `result`, and `cancel` calls resolve the task
directory directly. They do not enumerate history. The index has two separate
jobs:

- `active/` is the concurrency ledger used when reserving capacity;
- `launches.jsonl` is an append-only, owner-scoped launch journal used by
  bounded history pages.

The marker filename is a SHA-256 digest of the task ID so untrusted IDs never
become index paths. Its record binds the original task ID, owner, request
digest, reservation time, and launcher identity.

## One-time bootstrap and warm behavior

The first process that does not find a valid `.index/v1/ready.json` acquires
`index.lock`, scans legacy task directories once, and inspects their state.
Active or unknown legacy tasks receive a conservative marker with
`requestDigest: null`; terminal tasks do not. The same pass rebuilds
`launches.jsonl` from valid persisted launch metadata and then atomically writes
`ready.json`.

After readiness is established:

- capacity reservation reads only active marker files;
- bounded listing reads the launch journal backwards in 64 KiB chunks;
- at most 16 selected task records are hydrated concurrently;
- new task reservation appends one journal record after its marker is durable;
- if the journal append fails, the new marker is removed and launch does not
  proceed.

A missing or invalid ready marker intentionally repeats bootstrap. That is a
recovery cost, not a warm-path optimization failure.

## Fail-closed recovery rules

Index uncertainty consumes capacity instead of freeing it:

- a corrupt or unreadable active marker counts as active;
- `active` and `unknown` task inspection keep the marker;
- a terminal task removes its marker;
- a missing task removes a non-legacy reservation only after the 30-second
  grace period and only when the recorded launcher PID is proven gone;
- legacy markers, missing launcher identity, and unknown liveness are never
  reclaimed speculatively;
- release requires the exact task ID and request digest; a mismatched digest
  cannot remove another dispatch's reservation.

Native Goal automation adds a stricter rule: a legacy marker with a null digest
cannot prove ownership of a new automation attempt. Automation must observe the
exact task ID and request digest. Unknown observation remains
`dispatched_unresolved`; only exact absence permits another launch.

`index.lock` is created exclusively. A contender may quarantine a lock only
after it is older than 30 seconds and its recorded owner PID is proven gone.

## Page through history

Request the newest owner-visible tasks first:

```json
{
  "operation": "list",
  "limit": 50
}
```

When the response includes `next_cursor`, pass it back unchanged:

```json
{
  "operation": "list",
  "limit": 50,
  "cursor": "<opaque next_cursor>"
}
```

The cursor is a base64url-encoded byte offset with a versioned prefix. It must
land on a JSONL record boundary; malformed, stale-out-of-range, or non-boundary
cursors are rejected. Page limits are 1–200. Journal records are bounded to
16 KiB, parsed newest-first, and filtered by client/session/workspace ownership
before task hydration.

If a journal record is corrupt, the runtime rebuilds the journal under the
index lock and returns a retryable error for the current request. It does not
silently skip the corrupt region or return a partial page as complete.

## Run the Windows benchmark

Build the package used by the benchmark, then run the deterministic history
fixture from the repository root:

```powershell
corepack pnpm@10.15.0 --filter @lnwjing/capabilities build
node scripts/benchmark-durable-shell-history.mjs
```

The script creates disposable histories of 603 and 13,355 terminal task
directories. For each size it records one-time bootstrap elapsed time and
metadata reads separately, warms three reserve/release cycles, then measures 20
warm cycles. Its JSON report includes:

- `bootstrapMs` and `bootstrapMetadataReads` for migration cost;
- `medianMs` and `p95Ms` for warm reserve/release latency;
- `warmMetadataReads`, which must remain zero for terminal history;
- `p95Ratio` (`large / small`), which must be no more than 1.5.

Record the raw JSON with the exact commit, Windows version, Node version,
storage type, and whether antivirus or indexing policy changed. Compare warm
median/p95 and metadata reads separately from bootstrap; combining them hides
the one-time migration cost and produces a misleading regression result.

For a changed index algorithm, run the benchmark at least three times on an
otherwise idle machine and report the median run plus the worst p95 ratio.
Never claim history-size independence from a single cold bootstrap sample.

## Verification map

- `packages/capabilities/src/durable-shell-task-index.test.ts` covers bootstrap,
  concurrent reservation, marker recovery, paging, invalid cursors, and journal
  rebuild.
- `packages/capabilities/src/durable-shell-task-store.test.ts` covers
  owner-scoped paging and bounded task hydration.
- `packages/capabilities/src/shell-backend.test.ts` covers the public
  `limit`/`cursor` contract and transition to in-memory tasks.
- `scripts/benchmark-durable-shell-history.mjs` is the release performance gate
  for terminal-history growth.
