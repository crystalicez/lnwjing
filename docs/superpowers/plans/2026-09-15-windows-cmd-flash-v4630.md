# Windows CMD Flash Investigation & Fix Plan

Date: 2026-09-15
Affected report: lnwjing v4.63.0 on Windows 10/11
Working branch: `fix/windows-console-flash`
Clean worktree: `E:\\lnwjing\\.local-artifacts\\console-flash-fix`
Base commit: `dbbf84f6f0a22baf9021a7edd888619318e9e459`
Durable goal: `fix-windows-console-flash`

## 1. User-visible symptom

Some Windows users report a Command Prompt / console window briefly flashing on screen and disappearing again while lnwjing is idle. The observed cadence is approximately every 30–60 seconds.

Captured child processes include:

- `tunnel-client.exe runtimes status lnwjing --json`
- `cmd.exe ...\\hermes\\node\\codex.cmd --version`
- `schtasks.exe /Query /FO LIST`

The process tree reported by the affected user shows these processes under `lnwjing.exe --updated`, and the console commands create `conhost.exe`, which explains the visible flash.

## 2. Important finding: this is not simply a missing windowsHide flag

Tag `v4.63.0` was inspected directly.

All three affected process launch paths already request `windowsHide: true`:

- tunnel runtime adapter
- Codex discovery
- Windows scheduler backend

Therefore the fix must not be limited to adding another `windowsHide: true` flag.

On affected Windows hosts, repeatedly creating console-process children can still result in a transient console/conhost surface, particularly when command shims such as `.cmd` cause `cmd.exe` to be created.

The safest product fix is to stop spawning unnecessary console children during background health/readiness polling.

## 3. Confirmed root causes

### 3.1 Tunnel runtime: 30-second CLI status polling

Source:

- `apps/desktop/src/main/tunnel-runtime-supervisor.ts`
- `apps/desktop/src/main/tunnel-runtime-reconciler.ts`
- `apps/desktop/src/main/tunnel-runtime-adapter.ts`

The persistent tunnel supervisor treats a healthy runtime as something to reconcile again every 30 seconds.

The reconciliation path calls:

```text
tunnel-client.exe runtimes status lnwjing --json
```

This is intentionally frequent for tunnel health, but using a console executable for every healthy cycle is unnecessary because tunnel-client exposes a local admin/health HTTP surface.

### 3.2 Codex dashboard summary: 60-second `codex.cmd --version`

Source:

- `apps/desktop/src/main/desktop-services.ts`
- `packages/codex/src/codex-discovery.ts`

The Dashboard keeps a Codex summary cache with a 60-second TTL.

When refreshed, it invokes Codex discovery, which probes the installed Codex command and may resolve to:

```text
cmd.exe ...\\codex.cmd --version
```

This occurs even when Codex tools are disabled by default.

That makes the 60-second user report reproducible from source behavior.

### 3.3 Scheduler readiness: `schtasks /Query /FO LIST`

Source:

- `packages/capabilities/src/health-backend.ts`
- `packages/capabilities/src/scheduler-backend.ts`
- tool catalog / Doctor readiness probing

The generic health backend currently determines scheduler readiness by executing the scheduler backend's `list` operation.

On Windows, `list` enumerates Task Scheduler entries by executing:

```text
schtasks.exe /Query /FO LIST
```

Enumerating the user's tasks is not required merely to answer whether the built-in Windows scheduler backend is available.

## 4. Fix objectives

1. Eliminate recurring background console-process creation for healthy/disabled features.
2. Keep tunnel self-healing and control-plane health semantics intact.
3. Do not silently weaken Doctor or runtime health checks.
4. Preserve explicit scheduler list behavior when the user actually calls scheduler listing.
5. Preserve Codex discovery when Codex tools are enabled.
6. Preserve CLI fallback for tunnel recovery, reconnect, stop verification, and compatibility failures.
7. Keep behavior cross-platform; Windows-specific optimization must not regress macOS/Linux.
8. Add regression coverage so future background probes cannot reintroduce visible console flashes.
9. Do not mix this fix with unrelated ECC work currently dirty in the primary `dev` worktree.

## 5. Implementation plan

### Phase A — Scheduler background readiness

Files:

- `packages/capabilities/src/health-backend.ts`
- `packages/capabilities/src/health-backend.test.ts`

Change:

- On Windows, scheduler `check_tool` readiness should report the composed scheduler backend as available/ready without calling its destructive/heavy/list operation.
- Normal explicit scheduler tool calls continue to use `SchedulerCapabilityBackend.execute()`.
- macOS/Linux scheduler health continues through their actual portable backend status/list semantics unless separately optimized later.

Regression test:

- Inject a fake Windows scheduler backend.
- Call Health `check_tool scheduler`.
- Assert readiness is returned.
- Assert backend `execute()` was not called.

Expected result:

- No idle/background `schtasks.exe /Query /FO LIST`.

### Phase B — Codex disabled-state probing

Files:

- `apps/desktop/src/main/desktop-services.ts`
- `apps/desktop/tests/desktop-runtime.persistence.test.ts`

Change:

- If `codexToolsEnabled === false`, the `codex_runtime` Doctor requirement does not execute full Codex discovery.
- Dashboard does not execute `codex --version` while Codex tools are disabled.
- Dashboard may perform a cheap executable-resolution/presence check without starting the executable.
- Version remains `null` until Codex tools are enabled and discovery is actually needed.
- When Codex is enabled, existing discovery/version behavior remains unchanged.

Regression test:

- Spy on `CodexDiscovery.prototype.discover`.
- Create default runtime with Codex disabled.
- Refresh Dashboard.
- Assert `discover()` is not called.

Expected result:

- No idle/background `cmd.exe ... codex.cmd --version` every ~60 seconds for default users.

### Phase C — Tunnel healthy-cycle direct HTTP probe

Files:

- `apps/desktop/src/main/tunnel-runtime-adapter.ts`
- `apps/desktop/src/main/tunnel-runtime-state.ts`
- `apps/desktop/tests/tunnel-runtime-adapter.test.ts`

Behavior:

1. First reconcile / recovery still performs:
   `tunnel-client runtimes status lnwjing --json`.

2. Parse and retain:
   - PID
   - health URL
   - health URL file path
   - tunnel ID
   - MCP target
   - current readiness/poll state

3. While the cached runtime is still running:
   - verify cached PID is alive
   - resolve the loopback health URL
   - query local HTTP endpoints directly instead of spawning `tunnel-client.exe`

4. Probe:
   - `/healthz`
   - `/readyz`
   - control-plane poll health from the appropriate admin API

5. If direct health probing fails or the response contract is not understood:
   - immediately fall back to normal CLI `runtimes status`
   - do not assume healthy state

6. Explicit operations still use CLI:
   - connect
   - stop
   - stop verification
   - recovery/reconciliation after health failure

Security/safety constraints:

- Accept only loopback HTTP admin URLs.
- Reject non-loopback and non-HTTP health URLs.
- Bound health URL file size.
- Bound HTTP response bodies.
- Apply request deadlines.
- Do not treat unparseable health state as success.

## 6. tunnel-client compatibility matrix

The v4.63.0 release bundles tunnel-client `0.0.14`.

Verified directly from installed binary:

```text
0.0.14+0f870e50a973fa820d4c409000059e181e8d242b
```

Its `health --help` exposes:

- `--url`
- `--url-file`
- `--pid`
- `--pid-file`
- `--require-control-plane-poll`
- `/healthz`
- `/readyz`

The binary also contains the older admin API route:

- `/api/system`

For contract verification, the exact upstream tag was fetched locally:

```text
openai/tunnel-client v0.0.14
commit 0f870e50a973fa820d4c409000059e181e8d242b
```

The v0.0.14 source confirms that `/api/system` exposes `proxy_health[]`. The native status implementation derives `control_plane_poll_health` by finding the entry whose `route.kind` is `control_plane` and reading its `health_state`. The v0.0.14 proxy-health states are `direct`, `healthy`, and `unhealthy`.

The newer source contract can expose:

- `/health/control-plane`

Therefore direct health compatibility must be version-tolerant:

1. Use `/healthz` + `/readyz` for liveness/readiness.
2. On v0.0.14-compatible admin surfaces, derive control-plane poll health from `/api/system`.
3. If that contract is unavailable/unparseable, try the newer `/health/control-plane` endpoint.
4. If neither can be interpreted safely, fall back to CLI `runtimes status`.

Do not hard-code a successful poll state merely from `readyz=200` unless the upstream contract proves that ready always includes the control-plane poll requirement.

## 7. Windows visibility regression coverage

File:

- `apps/desktop/tests/windows-process-visibility.test.ts`

Extend the source-level contract to include:

- `apps/desktop/src/main/tunnel-runtime-adapter.ts`
- `packages/codex/src/codex-discovery.ts`
- `packages/capabilities/src/scheduler-backend.ts`

Assertions:

- internal process paths must not set `windowsHide: false`
- process-spawning paths must retain `windowsHide: true`

This is defense-in-depth only. The primary fix is reducing unnecessary spawning.

## 8. Current patch footprint

Current clean-worktree diff contains 8 files:

1. `apps/desktop/src/main/desktop-services.ts`
2. `apps/desktop/src/main/tunnel-runtime-adapter.ts`
3. `apps/desktop/src/main/tunnel-runtime-state.ts`
4. `apps/desktop/tests/desktop-runtime.persistence.test.ts`
5. `apps/desktop/tests/tunnel-runtime-adapter.test.ts`
6. `apps/desktop/tests/windows-process-visibility.test.ts`
7. `packages/capabilities/src/health-backend.ts`
8. `packages/capabilities/src/health-backend.test.ts`

At the time of this plan the diff is approximately:

```text
443 insertions, 7 deletions
```

The planning MD itself is intentionally outside the tracked product diff because this repository ignores the local planning-doc path.

## 9. Tests already passing

Final verification completed on the clean fix worktree:

- Desktop affected suites: **52/52 passed** across 6 files:
  - desktop runtime persistence: 18/18
  - tunnel runtime adapter: 12/12
  - tool catalog readiness: 11/11
  - tunnel runtime reconciler: 7/7
  - tunnel runtime supervisor: 3/3
  - Windows process visibility: 2/2
- Capabilities affected suites: **21/21 passed** across 3 files:
  - scheduler backend: 12/12
  - health backend: 4/4
  - platform capability composition: 5/5
- Codex discovery: **9/9 passed**
- Desktop typecheck: passed
- Capabilities typecheck: passed after project references were built
- Tunnel hardening rerun after admin tunnel-identity validation: **22/22 passed** across adapter/reconciler/supervisor
- Root workspace build after final hardening: passed
- `git diff --check`: passed

Final tunnel hardening also validates `/api/status` -> `control_plane_tunnel_id` against the cached tunnel ID before accepting a cached health URL. A mismatched/stale admin endpoint fails closed to authoritative CLI status rather than trusting a reused loopback port.

Note:

The first isolated Capabilities typecheck in the new worktree reported TS6305 because dependency project outputs had not yet been built. Running Desktop `tsc -b` built the project references, after which Capabilities typecheck passed. This was an environment/build-order issue, not a source failure.

## 10. Final verification required before merge/push

### Focused tests

- `packages/capabilities/src/health-backend.test.ts`
- `apps/desktop/tests/tunnel-runtime-adapter.test.ts`
- `apps/desktop/tests/windows-process-visibility.test.ts`
- Codex disabled Dashboard persistence test

### Type checks

- `@lnwjing/capabilities typecheck`
- `@lnwjing/desktop typecheck`

### Broader relevant tests

Run the complete affected suites if focused tests remain green:

- tunnel runtime adapter
- tunnel runtime reconciler
- tunnel runtime supervisor
- desktop runtime persistence
- tool catalog readiness
- platform capability composition
- scheduler backend tests
- Codex discovery tests

### Build

- root build or the same build graph used by Windows installer packaging

### Runtime acceptance on Windows

Prefer a real packaged executable test:

1. Start lnwjing.
2. Enable persistent tunnel and leave it healthy.
3. Keep Codex disabled.
4. Observe for several healthy cycles.
5. Confirm no recurring:
   - `tunnel-client.exe runtimes status ...`
   - `cmd.exe ... codex.cmd --version`
   - `schtasks.exe /Query /FO LIST`
6. Confirm no transient `conhost.exe` from those idle health loops.
7. Intentionally break tunnel health.
8. Confirm CLI fallback/reconnect still occurs and tunnel self-healing remains functional.

## 11. Acceptance criteria

The fix is complete only when all of the following are true:

- [ ] Idle default configuration does not run `codex.cmd --version`.
- [ ] Scheduler Doctor/readiness does not enumerate Task Scheduler entries.
- [ ] Healthy tunnel monitoring does not spawn `tunnel-client runtimes status` every 30 seconds.
- [ ] Tunnel status initially comes from authoritative CLI state.
- [ ] Cached tunnel PID is validated before trusting direct health.
- [ ] Direct tunnel health works with bundled tunnel-client 0.0.14.
- [ ] Newer tunnel-client health API remains supported or safely falls back.
- [ ] Unknown/unparseable tunnel health falls back to CLI instead of returning false success.
- [ ] Tunnel stop verification remains authoritative.
- [ ] Focused tests pass.
- [ ] Affected typechecks pass.
- [ ] `git diff --check` passes.
- [ ] Ponytail review passes.
- [ ] Unrelated ECC dirty changes remain untouched.
- [ ] No merge/tag/release is performed unless explicitly requested.

## 12. Rollout / release note

Suggested release note:

> Fixed a Windows issue where background runtime/readiness checks could briefly flash Command Prompt windows. lnwjing now avoids unnecessary console-process launches for disabled Codex tools and scheduler readiness, and uses the tunnel client's loopback health interface for routine healthy tunnel monitoring while retaining CLI fallback for recovery.

## 13. Risk assessment

### Tunnel stale cache

Risk:
A cached health URL or PID can become stale after runtime replacement.

Mitigation:
PID validation + failed direct probe => authoritative CLI fallback.

### Health API differences across tunnel-client versions

Risk:
Admin JSON fields/routes differ between 0.0.14 and newer clients.

Mitigation:
Compatibility parser for bundled 0.0.14, newer endpoint fallback, then CLI fallback.

### Scheduler false-ready

Risk:
Reporting Windows scheduler backend as ready without enumerating tasks could hide permission problems.

Mitigation:
The built-in backend's availability is a composition/platform property. Actual permission/execution errors are still surfaced when the user performs a scheduler operation. Readiness should not require enumerating all existing tasks.

### Codex installation/version display

Risk:
With Codex disabled, Dashboard version becomes unknown until enabled.

Mitigation:
Presence can be resolved without execution; exact version is only needed when using Codex tools.

## 14. Scope boundaries

Not part of this fix:

- changing ECC behavior
- changing update/release mechanisms
- changing Windows signing policy
- replacing tunnel-client
- disabling tunnel health monitoring
- disabling Task Scheduler functionality
- disabling Codex support
- merging to `main`
- tagging or publishing a release

Those require separate scope or explicit user instruction.
