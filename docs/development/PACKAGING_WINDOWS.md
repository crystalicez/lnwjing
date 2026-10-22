# Windows packaging

The lnwjing desktop package is built with Electron and packaged for **Windows 10/11 x64** as both an NSIS installer and a single-file portable executable. The graphical Electron application carries its own Electron runtime; a separate system Node installation is not required merely to open the dashboard.

The packaged MCP stdio launcher is self-contained: `lnwjing-mcp-stdio.cmd` launches the packaged Electron host with `--mcp-stdio`. No private Node executable or generated CJS bundle is shipped, and installed users do not need a separate system Node.js installation for stdio MCP or OpenAI Secure MCP Tunnel.

Core text/file search is also self-contained. Packaging downloads the pinned official Windows x64 ripgrep archive, verifies its SHA-256, preserves its license notices, and ships `resources/runtime-tools/ripgrep/rg.exe` in both Setup and Portable builds. Desktop and `lnwjing-mcp-stdio.cmd` prepend that private directory to the child runtime PATH, so users do not need to install ripgrep themselves.

OpenAI Secure MCP Tunnel is self-contained as well. Packaging pins official `tunnel-client v0.0.16` for Windows amd64 and verifies the archive SHA-256 before extraction. The target-native payload is preserved under `resources/tunnel-client/` with the executable, license/notice inventory, SPDX metadata, and Sigstore provenance; lnwjing also records the archive/runtime hashes used for provenance. The bundled client is selected only when the override is empty, and a missing or invalid custom override fails closed instead of silently falling back.

On the first launch of each lnwjing version, Desktop runs the core Doctor checks automatically before tunnel onboarding. Only core failures (supported Windows x64, database, bundled ripgrep, workspace initialization, and local MCP readiness) interrupt startup and keep navigation on Doctor. Git and optional capabilities such as Codex, WSL, Python, FFmpeg, and Windows OCR may report warnings or feature-specific unavailable states but do not block first-run.

The current release target is x64 only. Windows 7/8/8.1 and 32-bit Windows are not supported release targets.

Windows 10 and Windows 11 use different renderer compatibility defaults. `platform-compatibility.ts` recognizes NT build 10240+ as Windows 10 and build 22000+ as Windows 11. Windows 10 disables Electron hardware acceleration before `app.whenReady()` so older Intel/AMD/NVIDIA drivers use software rendering; Windows 11 keeps hardware acceleration enabled. This does not weaken `sandbox`, `contextIsolation`, or `webSecurity`.

Product-internal Windows plumbing uses built-in `powershell.exe` rather than requiring PowerShell 7. Runtime child launches use `windowsHide: true`. Durable shell workers have a default global cap of 16 active tasks per runtime process and `ProcessManager` has a default cap of 24 active managed processes, preventing an unbounded child/conhost fan-out when multiple chats/projects submit work concurrently.

## Build

From the repository root in PowerShell:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 package:windows
```

The package script rebuilds the workspace, generates the current MCP stdio bundle/launcher, writes both Windows executables to `apps/desktop/dist/installers/`, writes update metadata for both distribution channels, and finishes by generating and verifying `SHA256SUMS.txt` plus `PROVENANCE.json`. Provenance records the exact Git commit, tracked-tree dirty state, release artifact hashes, and critical packaged runtime hashes without storing signing secrets.

## Current electron-builder contract

`apps/desktop/electron-builder.yml` is the source of truth. The current v5.8.7 packaging contract is:

- `asar: true`.
- Windows x64 targets: NSIS installer + portable executable.
- Installer is per-user (`perMachine: false`).
- User-selectable installer directory (`allowToChangeInstallationDirectory: true`).
- Branded `build/icon.ico` for the application, installer, and uninstaller.
- `signAndEditExecutable: true` for executable metadata/icon editing.
- `deleteAppDataOnUninstall: false`; uninstalling the application does **not** automatically remove lnwjing user data.
- NSIS renames electron-builder's generated uninstaller to the stable user-facing `uninstall.exe` and rewrites `UninstallString` / `QuietUninstallString` for the active per-user or per-machine install mode so Windows Settings and upgrades keep using the correct path.
- Portable mode launches without installation but intentionally uses the same per-user lnwjing data/settings location as the installed build. It is portable as an executable, not a "keep every setting beside the EXE" mode.
- **Persistent side-by-side extraction:** the Portable EXE now unpacks its application payload into a `lnwjing-runtime-v<version>-<build-id>` directory **beside the EXE** and launches its `lnwjing.exe` from there. The extracted runtime is reused after closing the app; it is not removed on exit and no 7z application archive is staged under `%TEMP%`. Moving only the outer EXE to another folder creates a new sibling runtime there; moving both preserves the existing runtime.
- Every Portable build receives a unique runtime folder name. First extraction occurs in a sibling `lnwjing-runtime-v*.partial-<pid>` directory; after checking SHA-256 for `lnwjing.exe`, `app.asar`, `rg.exe`, and `tunnel-client.exe`, the launcher atomically renames that folder to the final runtime name. Subsequent launches re-verify those files against digests embedded in the Portable EXE before executing. The cross-session mutex serializes concurrent launches; existing unknown folders and corrupt runtime files are never overwritten automatically. Re-verification reads the four critical files (around 354 MiB for v5.8.7) at each launch, but does not write the 722 MiB runtime again. Interrupted `.partial-*` folders may be removed manually after verifying no instance uses them; leave other completed runtimes untouched until their processes exit.
- Installer auto-update remains on electron-builder's normal `latest.yml` channel and installs `lnwjing-Setup-<version>.exe`.
- Portable auto-update uses a separate generated `portable.yml` channel and downloads only `lnwjing-Portable-<version>.exe`.
- Portable downloads are verified by electron-updater against the SHA-512/size in `portable.yml`, then replaced in place only after the running process exits. The helper rejects symlink/non-canonical source and target executables, preserves a rollback backup, retries transient Windows file locks, checks that the newly launched outer executable survives its first 2 seconds, and restores the prior version after an immediate launch failure. Failures are appended locally to `<Portable EXE>.lnwjing-update-failures.log`; updater script cleanup is best-effort. A successful 2-second check is not a full boot-health guarantee, so destructive fault-injection tests remain necessary.
- The updater never crosses distribution types: an installed user remains on Setup/NSIS updates and a Portable user remains on Portable EXE updates.
- Installer and Portable intentionally continue to share the same per-user lnwjing settings/data location. The Portable Startup entry targets the **outer** Portable EXE rather than the versioned inner Electron binary. A managed `lnwjing-mcp-stdio.cmd` is created beside the outer EXE (and updated after each new-build launch), so copied MCP STDIO commands remain stable across runtime version changes; a pre-existing unmanaged CMD file is never overwritten. If this managed launcher cannot be written, the UI falls back to the inner packaged launcher.
- The Windows capability bridge is copied as an extra resource.
- The generated `lnwjing-mcp-stdio.cmd` has one canonical packaged copy beside `lnwjing.exe` for local stdio use. POSIX packages use the matching executable shell launcher. The package also includes the hash-bound native Windows secret migrator for one-time legacy data migration; no PowerShell secret runtime is shipped.
- Pinned ripgrep is shipped under `resources/runtime-tools/ripgrep`; both Desktop and the stdio launcher resolve this private `rg.exe` before any system PATH copy. Search admission now combines the existing 2-per-process/1-per-root limit with a **same-user cross-process** disk budget of 2 concurrent scans and 1 per workspace, using atomic short-lived locks in `%LOCALAPPDATA%\\lnwjing-rg-admission-v1`. Coordination happens only when searches occur; waiting scans cancel or return busy after 12 seconds. Locks older than 2 minutes are reclaimed only if their recorded owner PID is confirmed dead. This is not a cross-user/machine-wide Windows quota: other Windows accounts have separate local settings folders. Periodic diagnostics are collected every 60 seconds in memory but persisted once every 5 periodic samples; explicit incident captures and shutdown still flush.
- The repository's `lnwjing-scheduled-continuation` skill plus the six pinned Ponytail skills (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`) are shipped as sibling directories under `resources/agent-skills` in both Setup/NSIS and Portable. Their source-qualified bundled identities remain distinct from same-name machine-global or active-workspace Cursor, Claude, Agents, Codex, Codex-plugin, GitHub workspace, or configured skill roots; Native Ponytail activation accepts only the exact bundled primary/review identities.
- The launcher never falls back to a system Node runtime; a missing packaged Electron executable fails closed.
- Generated stdio runtime files are ignored by Git and must be regenerated from source for each build/release.

`signAndEditExecutable: true` does not by itself mean the release is Authenticode-signed with a publisher certificate. lnwjing does not require a paid signing credential to publish a community release: when production signing secrets are absent, Windows artifacts may remain `NotSigned` after the same SHA-256/provenance checks; when signing is configured, Setup and Portable must verify as Authenticode `Valid`. Production publisher trust is therefore optional release metadata, not something the package config can manufacture.

## Hidden console-process contract

Internal child processes launched by Desktop/process/capability code use `windowsHide: true` and do not intentionally display CMD/PowerShell windows. Windows can still create a hidden `conhost.exe` for a console-subsystem child such as Windows PowerShell; the presence of a short-lived Console Window Host process alone is normal. A visible flashing console window or a `conhost.exe` with sustained high CPU is not expected and should be treated as a regression/diagnostic signal.

The packaging/release tests include a source-level guard against changing the protected launch sites to `windowsHide: false`.

## Windows OCR helper (sparse package)

The WinRT OCR helper (`native/windows-ocr`) needs a signed sparse package for package identity. On the release machine:

1. `powershell -File scripts\build-windows-ocr.ps1` — publishes `lnwjing-windows-ocr.exe` to `native/windows-ocr/bin` (.NET SDK 8+ required; check with `scripts\check-wave-prereqs.ps1`).
2. `powershell -File scripts\register-windows-ocr.ps1` — signs and registers the sparse package with an external location. Dev mode creates and reuses a self-signed certificate (elevate once so it can be trusted in `LocalMachine\TrustedPeople`); release mode passes `-ReleaseCertPfx`/`-ReleaseCertPassword`.
3. `electron-builder.yml` ships `native/windows-ocr/bin` as the `windows-ocr` extra resource, so the helper is discovered at `%RESOURCES%\windows-ocr\lnwjing-windows-ocr.exe` on packaged machines. The host probes the helper (`{"op":"probe"}`) once and caches the identity result; without registration the `vision` OCR action reports a truthful unavailable state rather than failing.

The `makeappx.exe`/`signtool.exe` steps need the Windows SDK. No certificate or private key belongs in this repository.

The root-level `BUILD-LNWJING-PORTABLE-X64.cmd` is a developer convenience: it runs the Portable-only builder, then **moves** the resulting EXE and `portable.yml` to `portable/` under the repository root. The generated `portable/` folder is Git-ignored. Successful one-click builds now reclaim the temporary `win-unpacked` staging tree (approximately 700 MiB); add `-KeepIntermediates` to the PowerShell script for debugging. The cleanup refuses redirected directories or nested symlinks and never removes a running staging executable. The standard `package:windows` release command still keeps Setup, Portable, update manifests and evidence together in `apps/desktop/dist/installers/` as required by release checks.

## Expected Windows outputs

For v5.8.7:

```text
apps/desktop/dist/installers/lnwjing-Setup-5.8.7.exe
apps/desktop/dist/installers/lnwjing-Setup-5.8.7.exe.blockmap
apps/desktop/dist/installers/lnwjing-Portable-5.8.7.exe
apps/desktop/dist/installers/latest.yml
apps/desktop/dist/installers/portable.yml
apps/desktop/dist/installers/SHA256SUMS.txt
apps/desktop/dist/installers/PROVENANCE.json
```

Generic patterns:

```text
lnwjing-Setup-<version>.exe
lnwjing-Portable-<version>.exe
```

**Promoting a manually built Portable:** after a successful `electron-builder --win portable --x64 --publish never` and `node apps/desktop/scripts/write-portable-update-manifest.mjs`, run `powershell -NoProfile -File scripts/promote-portable-build.ps1` from the repository root. This validates the staged manifest/hash and atomically renames artifacts while retaining the prior build until verification succeeds; it refuses to replace a running Portable or an existing rollback backup.

**Portable runtime maintenance:** `powershell -NoProfile -File scripts/portable-runtime-maintenance.ps1` reports eligible old side-by-side runtimes without changing files. Use `-Apply` to clean only verified old, unreferenced runtime directories older than 7 days while no Portable processes run; keep the latest generation by default. Use `-IncludePartial` only when deliberately removing stale interrupted extraction folders. It refuses symlink/junction targets and leaves the stable MCP launcher, outer EXE, manifests and AppData untouched.

**Portable updater health check:** the updater retains the old outer EXE until the restarted Electron main process has initialized its runtime, IPC and renderer, acknowledged a unique local startup marker and survived a short stability check. If it fails, the helper attempts to stop its newly spawned process tree and restore the backup. Unexpected power loss, locked files or native process termination can still leave a `.lnwjing-update-backup` for manual recovery; never delete such a backup blindly. This requires Windows fault-injection validation prior to a production guarantee.

The NSIS installer produces its blockmap plus `latest.yml`. Portable has its own `portable.yml` and is an auto-updater target through the dedicated Portable channel; it is never installed through NSIS during a Portable update.

## Clean-machine smoke

Use a clean Windows 10/11 x64 account or VM with no repository checkout:

1. Install the generated `lnwjing-Setup-*.exe`.
2. Launch lnwjing and confirm the dashboard opens with Electron security settings intact.
3. Confirm the branded executable/tray/installer icon is present.
4. Add a disposable workspace and confirm its canonical path persists after restart.
5. Confirm the loopback MCP endpoint auto-starts and the displayed endpoint is usable by a local MCP client.
6. Run Doctor and confirm SQLite/platform dependency checks are reported truthfully.
7. If stdio/Secure Tunnel is part of the smoke test, verify `lnwjing-mcp-stdio.cmd` works on the clean machine **without** installing system Node.js.
8. Call `skills_list` and confirm it includes bundled `lnwjing-scheduled-continuation` plus all six sibling Ponytail skills, a test machine-global skill, and a test active-workspace skill; call `skills_read` with each source-qualified ID. With Ponytail FULL enabled, also verify code mutation is blocked before exact bundled primary load, succeeds after `bundled:agent-skills/ponytail` loads even when matching returns no result, and rejects a same-name workspace skill as activation evidence. Verify the same contract through Desktop HTTP MCP and the packaged stdio launcher.
9. Close the app, uninstall it from Windows Settings, and confirm the application binaries are removed while user data remains according to `deleteAppDataOnUninstall: false`.
10. Launch `lnwjing-Portable-*.exe` without installing it and repeat dashboard/workspace/Doctor/tunnel/skill smoke checks.
11. Confirm no visible CMD/PowerShell window flashes during normal internal operations. Short-lived hidden `conhost.exe` processes are acceptable; sustained high CPU is not.
12. From an installed build, verify an available update resolves through `latest.yml` to the next Setup executable; from a Portable build, verify it resolves through `portable.yml` to the next Portable executable and never switches distribution type.
13. For Portable replacement, verify the same outer EXE path restarts after update and that a forced replacement failure restores the backup instead of leaving the app missing.

Record artifact path, OS architecture, launch result, database creation, workspace add, Doctor result, stdio/tunnel result when tested, and uninstall/portable result. Do not record credentials, environment-variable values, runtime API keys, or full terminal history.
