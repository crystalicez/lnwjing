# SQLite workspace-index preview (opt-in, Windows/Node)

This is a **development/pilot feature**, not a production storage migration.
The default remains the established JSON workspace-index store.

## Why

A changed source file previously required serializing and atomically replacing
all entries in a workspace's JSON index. The preview stores each indexed path in
a SQLite row, compares compact SHA-256 fingerprints and changes only rows that
differ, in one transaction. A compact
metadata row supports `workspace_index_status` / Desktop summary requests.
It does not limit physical SSD MB/s, make full source scans incremental, or
eliminate the in-memory snapshot assembled by existing APIs.

## Safe use

Run against a **disposable/isolated LNWJING data profile** first. Shut down all
Desktop and MCP STDIO processes using that profile. Enable the preview in the
environment of **every** process using the same data root:

```powershell
$env:LNWJING_INDEX_SQLITE_PREVIEW = '1'
```

Start the development Desktop or MCP runtime with this environment. No setting
is modified and the option is ignored unless its value is exactly `1`.
Do **not** mix JSON-mode and SQLite-mode processes against the same data root:
their mutation locks are shared, but the two index formats are not dual-written. The preview verifies that the
legacy JSON file has not changed since import and fails closed if it detects
a mixed-mode writer.

On first access to an existing JSON index, the preview imports it under the
workspace-index mutation lock. The original `<workspace-id>.json` and its
metadata sidecar are **not deleted or overwritten**. New changes are written
only to `<workspace-id>.sqlite`. SQLite transactions roll back interrupted
writes, but this is **not** a tested machine-power-loss guarantee.

To revert the preview, stop all processes, unset the flag and restart. The old
JSON index is a **stale rollback copy**; explicitly rebuild the index from the
real workspace before relying on search results or re-enabling watchers. Do not
use this procedure to migrate application settings, checkpoints, tunnels, user
credentials or original `lnwjud` profiles.

If the SQLite file is corrupt or has an unknown schema, indexing intentionally
fails closed. Back up the isolated profile, inspect the failure, and rebuild
from source in a new disposable profile rather than deleting real user data.

## Validation and remaining gates

Relevant local tests:

```text
corepack pnpm@10.15.0 --filter @lnwjing/application exec vitest run --fileParallelism=false src/workspace-index-sqlite.test.ts src/workspace-index-admission.test.ts
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 lint
```

## Isolated large-workspace smoke (opt-in, not a release certification)

Two tests are intentionally skipped by ordinary CI and full Vitest runs. They
only create and remove unique fixture directories under the repository's
Git-ignored `.audit` directory. Their output labels distinguish synthetic
logical size from physical disk measurements.

```powershell
$env:LNWJING_RUN_INDEX_SCALE = '1'
$env:LNWJING_SCALE_REPORT = '1'
corepack pnpm@10.15.0 --filter @lnwjing/application exec vitest run --fileParallelism=false src/workspace-index-scale.test.ts
Remove-Item Env:LNWJING_RUN_INDEX_SCALE, Env:LNWJING_SCALE_REPORT

$env:LNWJING_RUN_PHYSICAL_INDEX_SCALE = '1'
corepack pnpm@10.15.0 --filter @lnwjing/application exec vitest run --fileParallelism=false src/workspace-index-physical-scale.test.ts
Remove-Item Env:LNWJING_RUN_PHYSICAL_INDEX_SCALE
```

The synthetic fixture persists 3 x 30,001 index entries, assigning one entry
per project a *logical* size of 21 GiB, but creates no 21 GiB source files.
The Windows filesystem fixture creates 2 x 30,000 small source files, with an
additional 21 GiB **NTFS sparse** asset per project. Binary assets are excluded
from automatic source indexing. It exercises full scans, individual updates,
1,000-ms native watchers and 64-file watcher bursts. The fixture is designed
to avoid physically writing tens of GiB of data.

These are local correctness and elapsed-time checks. They are **not** physical
SSD throughput ETW, a multi-hour endurance run, real 20 GiB of non-sparse data,
or an updater/power-loss test. Running ETW kernel-provider collection may
require an elevated local Windows session. No such collection is attempted
automatically; no system-wide tracing session is created by these tests.

### Local pilot evidence (2026-10-23, illustrative only)

- Synthetic metadata: **3 workspaces x 30,001 entries**, one 21 GiB logical
  entry per workspace. Initial SQLite writes measured 421–549 ms, and a
  one-entry update measured 305–323 ms across those workspaces. No real source
  files were created by that test.
- NTFS fixture: **2 workspaces x 30,000 real small source files** and one
  21 GiB sparse binary per workspace. Automatic indexing produced 30,031
  entries per workspace, with full scans at 7.53 and 10.62 seconds.
  Incremental file updates took 643 and 671 ms. Native 1,000-ms watchers
  received 128 notifications per workspace from a 64-file change burst; the
  test verified indexed changes, then stopped the watchers.
- Each fixture directory was removed by test-owned cleanup. These values are
  specific to one local run, including filesystem cache effects; they do
  **not** establish production throughput or a comparative speedup.
- A separate 15-second read-only process sample observed existing
  `lnwjud.exe` instances, **not** a current `lnwjing.exe`. It used
  Windows logical process-transfer counters, **not** ETW physical disk
  attribution. The shell account lacked Administrator privileges for a
  controlled kernel trace.

Before enabling SQLite by default, complete power-loss/restart recovery,
concurrent mixed-process configuration checks, real 20 GiB+ workload stress,
30–60 minutes idle/checkout/build storms, bounded memory verification and
**physical disk ETW attribution** for both index and rg.exe. Keep the previous
JSON-only release available.
