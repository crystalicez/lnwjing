# Git-aware checkpoints and SQLite storage budgets

## What Git-aware actually guarantees

Git-aware is the default, with **Standard** selectable under Settings → Storage Management. It skips an encrypted checkpoint only when the working-file **raw bytes** match a locally available Git HEAD blob and the app successfully pins the exact commit at:

`refs/lnwjing/recovery/<full-commit-object-id>`

These refs protect the corresponding Git commit and its objects from normal Git garbage collection even after branch rewrites. The app will **not** automatically delete these refs. To limit history retention, at most 64 distinct commits are pinned per repository; if the limit is reached (or any Git validation/pinning fails), the ordinary encrypted checkpoint is created instead.

A Git-covered edit does **not** create a one-click Undo entry. Deleting the repository, removing its refs manually, removing objects with external tools, or corrupting its Git object store can still prevent recovery. This is not an off-repository backup. Symlink paths, untracked files, dirty tracked files, files above 16 MiB, multi-file probes above 32 MiB, and Windows CRLF/mixed-ending files whose raw bytes differ from the Git blob fall back to encrypted checkpoints.

### Manual recovery without changing the index

Inside the repository, inspect the existing pins:

```bash
git for-each-ref --format="%(refname) %(objectname)" refs/lnwjing/recovery
```

Find the pinned commit corresponding to the desired pre-edit revision. Preview the old content first, using a literal repository-relative path:

```bash
git show refs/lnwjing/recovery/<full-commit-object-id>:src/example.ts
```

To restore **only that file's worktree content**, save any current uncommitted changes elsewhere, then explicitly run:

```bash
git restore --source=refs/lnwjing/recovery/<full-commit-object-id> --worktree -- src/example.ts
```

The restore overwrites worktree content for the selected file. Never run this against unsaved changes unless you want to discard them.

## SQLite and backup budgets

The Settings **SQLite Hard Limit** is a native SQLite **main database page limit** (default 4 GiB), not a global filesystem quota. It does not itself limit WAL, other databases, external logs, Git history, or explicitly requested manual and pre-migration backups.

The app separately budgets automatic **daily SQLite backups** to three times the selected main-database limit, counting main SQLite bytes, WAL bytes, active and archived SQLite backups, and the projected size of one additional backup. It reads metadata only. When this would exceed the budget, it refuses to create a new daily backup; **it never silently deletes existing recovery copies**. Settings displays this state. Manual/pre-migration backups still require free disk space and are deliberate recovery operations.

Before MCP mutations, the host checks used **main-database** pages after subtracting reusable freelist pages. WAL is monitored separately: it cannot consume SQLite `max_page_count` pages and must not falsely block mutations under the main-database limit. Starting at 85% used, the enabled emergency policy trims the oldest safe routine-read audit in bounded off-main SQLite batches, targeting 80%. When mutation admission is genuinely threatened (at roughly 95% used), it can also recycle completed routine-read audit newer than 24 hours, first older than five minutes and then older than one second as a last resort. In-flight reads, Goal evidence, mutation receipts and failures remain protected. When audit cleanup is insufficient, the same emergency policy can expire old **file Undo checkpoints** (older than seven days at normal pressure; older than 24 hours at critical 95% pressure after older candidates are exhausted). It always retains the newest three file checkpoints per workspace. Normal scheduled recovery protects snapshots from the last 24 hours; only an actually blocked MCP mutation may progressively expire snapshots older than one hour and, as a final resort, older than five minutes. The current in-flight window is therefore protected. It does not delete Goal checkpoints or mutation audit rows, but one-click Undo of an expired file checkpoint will no longer be available. Checkpoint pruning runs in separate bounded worker transactions (at most 64 rows and about 16 MiB of payload per batch, except one individually oversized row). Metadata-complete profiles use the fast metadata index; older profiles with missing checkpoint metadata fall back to checking the canonical checkpoint table without reading full payloads into JavaScript. Every DELETE independently verifies canonical age and the actual newest three per project; if a count-complete but stale metadata index has no deletable candidates, the worker retries selection directly against canonical checkpoints instead of getting stuck at zero. A temporarily busy SQLite writer gets at most two additional backoff retries. During an actually blocked MCP mutation, disposable old Undo is attempted before slow routine-read audit scans; an audit worker failure does not prevent independently safe checkpoint cleanup, or vice versa. It does not create full-file backups or VACUUM during recovery. MCP waits for bounded recovery before deciding to reject a mutation; standalone STDIO applies the same policy without Desktop.

An empty audit tier does not count toward the urgent deletion budget. The sweep can check the two newer tiers within the same recovery deadline while preserving in-flight calls.

This is a safety admission check, not an atomic global quota across every external writer or a WAL/backups disk quota. If no safely disposable records remain, writes still fail closed rather than lose durable evidence. SQLite DELETE reclaims reusable pages but does **not** necessarily shrink the physical `.sqlite` file. An already oversized main file therefore may need separate **offline compaction after a verified backup** to meet a physical-file-size target; no automatic VACUUM or multi-GiB backup is performed during emergency recovery. A pinned WAL can independently consume disk until readers release it. An independent idle-only WAL maintenance watcher samples metadata every two minutes and only attempts an isolated, SQLite-managed TRUNCATE checkpoint if WAL has exceeded 128–512 MiB (depending on cap) and remained unchanged for at least one minute. Failed or busy attempts have a 30-minute cooldown; it never deletes WAL/SHM files, retries aggressively, or runs synchronous checkpoints on Electron Main. During continuous writes or pinned readers, WAL can still grow and requires investigation of the holding connection. As a separate low-disk safeguard, when WAL is unusually large (at least 128–512 MiB depending on the main cap) and free physical volume space falls below the reserved 512 MiB–2 GiB, new MCP mutations pause with an actionable WAL/low-disk warning; reads and unrelated SQLite clients are not forcibly terminated. This check runs only when WAL is large, not on every tool call. It is **not** a WAL file-size hard cap and cannot guarantee safe writes from external SQLite writers or uncontrolled native processes. Every cooperating lnwjing SQLite connection reapplies the native page limit, but file mutations and audit receipts cannot be one SQLite transaction across separate processes. MCP mutation admission now initiates an urgent, single-flight cleanup before the durable audit STARTED event and waits up to fifteen seconds before a fresh fail-closed headroom check; unlike background recovery it bypasses the ordinary exhausted-history cooldown. Concurrent writer races can still exceed this bounded wait. Additionally, every new encrypted file checkpoint uses its actual encoded payload size for proactive space reclamation, and retries an atomic SQLITE_FULL checkpoint INSERT up to three times after further safe pruning. It never replays the user file edit, deletes Goal/mutation-audit evidence or bypasses the final storage guard. Do not raise the configured cap merely to work around a missing recovery attempt.

Do not test migration or cleanup against a live AppData profile: use a separate test profile and verify backups first.
