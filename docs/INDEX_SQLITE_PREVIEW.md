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

Before enabling it by default, test 20GB+/30k+ multi-project fixtures, realistic
watcher storms, power-loss/restart recovery, concurrent clients with identical
configuration, correctness of rebuild and rollback, bounded memory usage, and
physical disk ETW traces. Keep the previous JSON-only release available.
