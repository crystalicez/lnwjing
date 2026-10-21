# lnwjing testing and release verification

Audit date: 2026-09-19

## Test layers

### Package unit/service tests
Most packages use Vitest. Tests are generally colocated with source as `*.test.ts`.

Storage and several native/process-heavy suites deliberately disable file parallelism to avoid SQLite/process cleanup races.

### Desktop service/acceptance tests
`apps/desktop/tests` contains main-process, IPC, persistence, tunnel, Doctor, settings and resilience tests.

Desktop Vitest configuration:
- Node test environment.
- `maxWorkers: 4`.
- file parallelism disabled.
- bounded test/hook timeouts, with higher CI values.

### Packaged Electron E2E
Playwright runs packaged or development Electron journeys. The Playwright config currently uses one worker with a 30-second per-test timeout.

### Native hosts
- macOS native protocol/provider tests run with Swift Package Manager.
- Linux native host tests run with Cargo `--locked`.

### Cross-package release/packaging tests
Root `tests/` contains integration, packaging, platform-contract and release-gate tests.

## CI topology

`.github/workflows/ci.yml` runs:
1. Native platform contract on Windows, macOS and Linux.
2. Portable typecheck and cross-platform contract tests.
3. Non-desktop workspace tests.
4. Two Desktop Vitest shards per OS.
5. Process-tree and external-MCP lifecycle tests.
6. On protected main/manual release CI: target-native macOS arm64/x64 and Linux x64/arm64 package builds.
7. Packaged Electron E2E on the exact package.
8. macOS 26 compatibility verification against the already-built artifact.
9. SHA-scoped evidence artifacts for the release workflow.

The release workflow consumes exact-SHA successful CI artifacts and does not rebuild the product during tag publication.

## Verification performed for the 2026-09-19 Serena/skill changes

Focused regression checks passed:
- `packages/mcp-server/src/skill-routing.test.ts`: 2 tests.
- natural-language `skill_match` regression.
- `run_goal` automatic skill-preflight regression.
- external MCP stale-tool guidance regression.
- external MCP close-failure/replacement-session lifecycle regression.

Focused typechecks passed:
- `@lnwjing/mcp-server`
- `@lnwjing/extensions`

These are the minimum behavioral checks for the infrastructure fix. Root lint/typecheck/tests must still be run before any eventual commit/release of the combined working tree because unrelated pre-existing changes are also present.

## Engineering Harness v5.7.0 validation

Engineering Harness changes are validated at the authority boundaries they affect rather than by adding broad coverage-only tests:

- `packages/application/src/engineering/*.test.ts` — project/policy/task-risk/workflow classification and proportional gate selection.
- `packages/storage/src/goal-continuation.integration.test.ts` — schema migration/backward compatibility, restart/resume, intent revision, selective stale gates, evidence/review persistence, and completion DoD.
- `packages/mcp-server/src/tools/engineering-tools.test.ts` — prepare/start/status contracts and no implicit scheduled-continuation side effect.
- `packages/mcp-server/src/tool-registry.test.ts` — Harness-Off compatibility, explicit task binding, stale policy/revision/session rejection, Full Bypass coexistence, first-party opaque execution, and workspace isolation.
- `packages/mcp-server/src/server-instructions.test.ts` — enabled-path guidance routes substantive coding work through Engineering preparation/start while preserving explicit scheduler opt-out.
- `apps/desktop/tests/engineering-harness-settings.test.ts` — Default Off, coding-project activation, and read-only durable-task status projection.
- `apps/desktop/tests/engineering-harness-ui.test.ts` — Thai/English Settings rendering and truthful non-green pending/running gate states.
- Existing Direct STDIO, Desktop persistence, durable-goal, permission, Full Bypass and release tests remain regression coverage; Engineering Harness must not bypass those authorities.

Before a 5.7.0 delivery commit, run the focused suites above, affected package typechecks/builds, `git diff --check`, then the repository release verifier. A version bump must use `corepack pnpm@10.15.0 run set-version 5.7.0` followed immediately by `corepack pnpm@10.15.0 test:version`.

## Coverage

No repo-wide numeric line/branch coverage threshold was found in the audited root/desktop test configuration. Quality is primarily gated through contract-specific unit, integration, acceptance, packaged E2E and release-evidence checks.

If a coverage threshold is introduced later, it should not replace behavior-oriented regression tests at lifecycle/security boundaries.

## Test design guidance

- Prefer the smallest feedback loop that can fail for the reported behavior.
- For lifecycle bugs, test state transitions, not implementation counters alone.
- For cross-platform/native behavior, test on the target OS rather than simulating a foreign host as release evidence.
- For security fixes, include rejection/fail-closed behavior.
- Do not weaken release gates or merely increase timeouts to make nondeterministic failures disappear.
