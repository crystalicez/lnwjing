# Global Storage Quota V2 — phase 1: trustworthy profile inventory

Status: **implemented as an on-demand, read-only diagnostic; NOT an enforced quota**.

## What ships

- **Settings → Storage Management → Scan entire profile** runs a dedicated worker with no file-content reads and no synchronous directory tree traversal on Electron's main thread.
- Includes **all accessible regular files under the configured lnwjing data root**, including files in previously unknown folders. It is not limited to the earlier twelve sampled categories or directory depth three.
- Reports total **logical** file bytes, file and directory counts, grouped categories, protected/managed/rebuildable/unknown classifications, and candidate logical bytes.
- Default scan cap **50,000 entries / 8 seconds**; returns an explicitly partial inventory on reaching the cap, an inaccessible entry, a symlink/junction or a different filesystem device. A 13-second hard watchdog terminates a stuck worker.
- Symlink and junction targets are **not followed** (no accidental scan of a user's project or another volume).
- Scans only on explicit user request and coalesces concurrent requests from the same Desktop runtime into one worker; no periodic full-profile rescans.
- Windows allocated bytes are shown **only if reliable per-file block allocation is available**. Otherwise the field is null. Logical file size is not actual NTFS allocated space.
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
- `release(proof)` requires the owning PID and a private reservation token. A
  reservation abandoned by a dead PID can be reconciled; ambiguous PID liveness
  fails closed. There is no time-only eviction of a live writer.
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
asynchronous snapshots. SQLite's original main-page cap remains independent.

An opt-in pressure-reclaim stage runs only after a *complete* inventory and at
75% projected use or on a quota policy change. It unlinks up to 128 individual,
verified, single-link files older than seven days in exact profile-owned
`logs`, `diagnostics` and `crash-dumps` directories. It never recursively
purges unknown directories, symlink/junction targets or user repositories.
Each candidate's identity, size and modification time are rechecked before
unlinking. A refusal or incomplete scan is not bypassed. Deleted bytes are
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
profile, PID reuse and files changed without holding a reservation are not
fully controlled. Outside the opted-in backup writer, Desktop, MCP STDIO,
native helpers, workspace index and routine SQLite mutations do **not** yet use
a unified pre-write quota. No automatic deletion of Backup, Undo,
Recovery Trash, Index or user source code is enabled. Never advertise this as
a 100% global quota or enable it by default until incremental accounting,
writer coverage and crash/physical-disk tests pass.

Next production gates: explicit owned-root registry, Windows allocated-byte
accounting, incremental per-writer reconciliation with bounded WAL/temporary
overhead, protected/eligible reclaim tiers, an emergency read-only mode and
cross-process failure-simulation plus full packaged acceptance.
