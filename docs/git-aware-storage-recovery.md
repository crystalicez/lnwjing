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

Before MCP mutations, the host uses SQLite+WAL pressure checks to reserve room for durable audit receipts. Writes can be paused rather than silently lose evidence. This is a safety admission check, not an atomic global quota across every external writer. With pinned WAL readers or externally modified storage, actual disk consumption may briefly exceed the configured main page limit. Raising the limit or safely reclaiming space is the supported recovery path; automatic in-place VACUUM or irreversible cleanup is intentionally not performed.

Do not test migration or cleanup against a live AppData profile: use a separate test profile and verify backups first.
