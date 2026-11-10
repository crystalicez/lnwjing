# Global Storage Quota V2 — phase 1: trustworthy profile inventory

Status: **implemented as an on-demand, read-only diagnostic; NOT an enforced quota**.

## What ships

- **Settings → Storage Management → Scan entire profile** runs a dedicated worker with no file-content reads and no synchronous directory tree traversal on Electron's main thread.
- Includes **all accessible regular files under the configured lnwjing data root**, including files in previously unknown folders. It is not limited to the earlier twelve sampled categories or directory depth three.
- Reports total **logical** file bytes, file and directory counts, grouped categories, protected/managed/rebuildable/unknown classifications, and candidate logical bytes.
- Default scan cap **50,000 entries / 8 seconds**; returns an explicitly partial inventory on reaching the cap, an inaccessible entry, a symlink/junction or a different filesystem device. A 13-second hard watchdog terminates a stuck worker.
- Symlink and junction targets are **not followed** (no accidental scan of a user's project or another volume).
- Scans only on explicit user request and coalesces concurrent requests from the same Desktop runtime into one worker; no periodic full-profile rescans.
- Windows allocated bytes are shown **only if a second on-demand native metadata pass completes and reconciles** with the normal logical inventory. The opt-in diagnostic invokes a fixed, bounded Windows PowerShell/.NET Win32 API helper after the worker's complete scan: up to 5,000 regular files / 10,000 entries, at most 9 seconds. It does **not** read file contents. It reads `FILE_STANDARD_INFO.AllocationSize` from each File Handle and the stored size from `GetCompressedFileSizeW` (covering sparse/compressed files), using the **larger** value as a conservative file allocation estimate so cluster allocation does not silently undercount small files. It checks reparse-point attributes, identifies hardlinks using file handle identity and refuses attribution if a link exists outside the profile. The result must independently match the first pass's file count and logical bytes. On any mismatch, unsupported volume, timeout or blocked native helper, `allocatedBytes` remains null. Normal automatic Reservation checks still use the fast logical scan; this PowerShell pass runs **only when the user clicks Scan Profile**. This is a point-in-time, potentially overestimating regular-file allocation estimate (not NTFS directory/metadata overhead, alternate streams or bytes outside the scanned root) and not an OS enforced quota.
- No file deletion, backup, migration, compaction or changes to user AppData are performed by this diagnostic.

## Categorization

- **Protected**: main SQLite and its WAL/SHM, workspace-writer leases, encryption secrets, essential upgrade/restore state.
- **Managed**: backups, recovery trash, native managed subprocess artifacts, background tasks, activity logs, diagnostics and crash dumps. *Not all managed bytes are eligible for immediate deletion.*
- **Rebuildable**: workspace-index and known cache folders, once their writers have been stopped/coordinated.
- **Unknown**: everything not yet explicitly classified. It is counted, but MUST NOT be auto-deleted.

The potentially reclaimable figure is a sum of logical bytes in managed/rebuildable categories, **not** an available-to-delete quota and **not** a forecast of physical disk savings.

## Explicit boundaries / next stages

This phase does **not** measure or control: Electron cache roots that live outside dataPath, tunnel profiles on other roots, Portable EXEs and updater staging outside dataPath, OS temp files, or Git recovery pins created inside user-owned repositories. Source files, .git data, and user repositories must never be purged under a quota merely because lnwjing touched them.

A single filesystem walk is not an atomic snapshot during concurrent writers. A production global hard limit requires:
1. Catalog and ownership classification of **every** write root, plus NTFS allocated-size accounting and hardlink/sparse/compression handling;
2. Cross-process reservation and pre-write admission for SQLite main/WAL, backups, temp writes, logs, index, native launch artifacts and any OS-managed caches;
3. Per-category expiration policies, protected floors, safe physical reclamation and post-reclaim measurement, including WAL readers, backup restore fences and safe offline SQLite compaction;
4. Crash-safe reconciliation and explicit behavior if protected data alone exceeds the configured quota; optional OS-enforced containment for hard guarantees.

**No app-level policy can promise both zero overage in every scenario and unlimited successful mutations when protected data alone exceeds the quota.** Do not present phase 1 as a quota or allow the inventory's candidate estimate to trigger deletion.

## Phase 2 foundation — opt-in shared reservations (2026-11-10)

`GlobalStorageQuotaReservations` provides a separate `global-quota-reservations-v2.sqlite`
ledger **within the explicitly selected profile**, not in user-owned repositories. It is
an API building block, not a default policy or a complete Global Hard Limit.

- `configure({limitBytes,criticalReserveBytes})` explicitly opts in; a normal
  lnwjing startup does not create this ledger or change the existing 4 GiB SQLite limit.
- `reserve(bytes)` uses a *complete*, bounded, read-only profile inventory and
  an atomic `BEGIN IMMEDIATE` reservation journal. A changed ledger revision
  during the inventory causes a retry, while an incomplete scan rejects admission.
  Concurrent callers **in the same Node process** which observed the *same*
  ledger revision now share only the running inventory Worker, reducing duplicate
  full-profile stat walks. The result is discarded immediately after completion;
  no future admission reuses a cached scan. A completed reservation, release or
  policy update increments the revision and forces an independent new scan.
  Cross-process callers still scan independently before SQLite serializes
  the final admission, and no non-cooperating writer can be fenced by this rule.
  Disabling Quota retains a zero-limit, disabled ledger row with a monotonically
  increasing revision instead of deleting the row. This prevents an ABA race
  in which disable/re-enable could recycle the old revision while a scan was
  active and let a new write use pre-reconfiguration inventory.
- `release(proof)` requires the owning PID and a private reservation token.
  When the OS probe succeeds, newly created Windows reservations also persist
  the OS process creation timestamp (100-ns .NET ticks), mitigating stale
  ownership from PID reuse. If the probe is unavailable, the new reservation
  retains the conservative legacy PID-only liveness behavior. Before an
  admission, at most eight distinct recorded owner generations are checked
  **outside** the SQLite write lock. Probes now advance through the sorted
  owner generations with a per-process rotating keyset cursor, wrapping at
  the end, so eight indefinitely live owners cannot permanently starve later
  stale leases. A native Windows admission batches the selected foreign PIDs
  into **one bounded PowerShell process**, rather than launching up to eight
  separate processes. Unknown, inaccessible, malformed or timed-out probes
  remain reserved (fail closed), and the batch never increases the eight-owner
  limit. Only a verified gone process or a live PID with a different creation
  timestamp can be removed inside `BEGIN IMMEDIATE`. The previous PID-only
  dead-owner recovery remains
  for legacy records (the ledger is migrated additively). Unverifiable owner
  identities remain reserved; no clock-age-based expiry can delete an active
  lease. This mitigates PID reuse on Windows but does not replace transactional
  owner identity checks for every possible writer or guarantee that a blocked
  cross-user process is recoverable. Cursor progress lives only in the active
  runtime, not on disk; a fresh process starts at the earliest owner again.
  A quota admission can still be refused until a later attempt has inspected
  a stale lease beyond the current eight-owner batch.
- `inspect()` reports **logical used**, active reserved bytes and ordinary
  available bytes separately. A critical reserve remains unavailable to ordinary
  reservations. Inventory treats the ledger and its SQLite sidecars as protected.
- `SqliteBackupService` supports optional injection of this quota into its
  async snapshot path for low-frequency admission. It reserves a conservative
  projected size, validates the completed backup, rejects oversize unpublished
  results, then releases the reservation. This is **not** a hard cap on the
  intermediary SQLite backup file during the copy.

Current Desktop integration (source, not proof of a newly packaged Portable):
**Settings → Storage Management → Global Storage Quota V2** allows an explicit
profile-level budget of 512–65,536 MiB, or 0 to disable it. Setting the value
requires a confirmation that coverage is limited. The UI displays in-flight
reserved bytes and critical reserve, while full logical usage still requires
the on-demand inventory scan. The optional backup provider is resolved at
snapshot start, so an enabled budget applies to ordinary manual and daily
asynchronous snapshots. **Default JSON workspace-index writes** in Desktop
and CLI/STDIO now also reserve the full serialized atomic temporary snapshot
plus 64 KiB for its optional metadata sidecar before writing. If admission
fails, no staging snapshot is written and the previous complete index is
preserved. Any successful/failed atomic write releases the reservation after
staging cleanup. When quota is on, an index metadata *read* does not regenerate
an unreserved sidecar; the next successful index save publishes it. Opt-out
keeps the historical path unchanged. Each sequential index save still needs
its own metadata-only profile inventory **while opted in**; only overlapping
same-process admissions at one ledger revision can share an ongoing scan.
The disk I/O impact of frequent watcher updates still needs large-profile
performance acceptance. The optional
SQLite workspace-index preview remains **uncovered** because its WAL growth
requires separate bounded admission. SQLite's original main-page cap remains
independent.

File Undo checkpoint inserts in Desktop and STDIO also reserve profile space
when quota is enabled. Each attempt estimates main database and WAL growth
from the encoded checkpoint and SQLite page size, then releases the
reservation after the insert settles. Before committing the insert, SQLite
checks that enough main pages remain for audit. If the check or reservation
fails, the original file stays intact. Audit writes and SQLite recovery workers
still use separate admission and cleanup rules.

An opt-in pressure-reclaim stage runs after a *complete* inventory when
projected use reaches 75% of the ordinary budget or the volume is low on space.
The ordinary budget excludes the critical reserve. Quota configuration also
triggers a pressure check. The sweep unlinks verified, single-link files older
than seven days in exact profile-owned `logs`, `diagnostics` and `crash-dumps`
directories.
The same conservative sweep may also remove **only unpublished JSON workspace-index
staging files** directly inside the profile-owned `workspace-index/` folder,
whose basename exactly matches the app's `<workspace>.json.<PID>.<UUID>.tmp`
or `<workspace>.json.meta.json.<PID>.<UUID>.tmp` format. The staging file
must be more than seven days old and its writer PID must be **confirmed gone**
using an existence probe, checked once at discovery and again before unlink.
A PID that has been reused by a live process is conservatively kept. Unknown,
active or recently modified temporary files, authoritative `.json` snapshots,
metadata sidecars, SQLite index/WAL, `.locks`, hardlinks, symlink/junction
paths and files outside the owned profile are never deleted. This does not
remove old *published* indexes, which require a coordinated retention policy.
The sweep is capped at **8 batches of 128 files**, with no more than 2,048
entries inspected per batch, and stops early once estimated logical pressure
and volume headroom have recovered. A writer attempting admission likewise
may reclaim several batches and then **re-inventories** before admitting a
write. It never recursively purges unknown directories, symlink/junction
targets or user repositories. Each candidate's identity, size, parent
directory identity and modification time are rechecked before unlinking.
A refusal or incomplete scan is not bypassed; exhaustion of the bounded
sweep does not relax the quota or override protected data. Deleted bytes are
reported as **logical bytes**, never claimed as proven NTFS physical savings.

Additional physical-volume admission (2026-11-10): every opted-in reservation
also checks real OS free space on the profile's volume, atomically with the
shared ledger's outstanding cooperative reservations. A protected physical
headroom of at least 64 MiB (or the configured critical reserve, whichever
is greater) remains unavailable to ordinary reservations. Incomplete or
invalid volume readings **refuse new reservations**; normal app startup with
Quota disabled does not read or enforce this policy. Old disposable logs may
also be reclaimed under physical-volume pressure. Storage Settings displays
**whole-volume OS free bytes** and the remaining budget after cooperative
reservations. This protects simultaneous *cooperating* backups from
overcommitting the same observed free volume, but external applications can
still consume that free space while a copy is running. This is neither
per-file NTFS allocation accounting nor a guaranteed physical app quota.

Limitations before production enforcement: the inventory is logical-byte based
on Windows (not NTFS allocated-byte accounting), scans only the profile root,
and requires a full walk per reservation. Noncooperating writers, journal/WAL
growth during a write, OS temp/Portable/Tunnel/Electron caches outside the
profile, legacy/unverifiable PID ownership and files changed without
holding a reservation are not fully controlled. Windows process-start proofs
are stored when verified, but only a bounded set of owner generations
is verified per admission; POSIX and legacy reservations still fall back to
definitely-dead PID detection. Outside the opted-in backup writer, Desktop,
MCP STDIO,
native helpers, the opt-in SQLite workspace-index preview, JSON-index file
deletions/metadata maintenance outside a successful save, and SQLite writes
other than file Undo inserts do **not** yet use a unified pre-write quota. Global Quota does not expire Backup, Undo,
Recovery Trash, authoritative Index or user source code is enabled. Never advertise this as
a 100% global quota or enable it by default until incremental accounting,
writer coverage and crash/physical-disk tests pass.

Next production gates: explicit owned-root registry, Windows allocated-byte
accounting, incremental per-writer reconciliation with bounded WAL/temporary
overhead, protected/eligible reclaim tiers, an emergency read-only mode and
cross-process failure-simulation plus full packaged acceptance.
