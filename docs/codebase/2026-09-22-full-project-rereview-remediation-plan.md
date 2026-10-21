# Full-project re-review remediation plan

Date: 2026-09-22
Repository: `C:\Users\User\Desktop\lnwjing`
Branch: `dev`
Reviewed HEAD: `b526680b3a394eb21b2e13d4c53dd799aeb90864`
Status: implementation in progress for source v5.4.3. All confirmed functional remediation items have been implemented on `dev`; final full validation, dev push, and local Windows installer verification remain before this cycle is terminal.

## v5.4.3 implementation update

- Remote MCP DCR/transient OAuth state is bounded and first-use trust now requires explicit local approval.
- Privileged third-party GitHub Actions are pinned to immutable commit SHAs.
- The vulnerable production `extract-zip@2.0.1` path is removed and archive containment validation is covered by malicious fixtures; the production audit is clean.
- The Desktop main bundle now stages the correct target-specific `@electron-internal/extract-zip` native binding and electron-builder unpacks `.node` files, fixing the Electron startup `Cannot find native binding` failure without relying on reinstalling `node_modules`.
- Multi-file patch/checkpoint restore now use all-or-rollback semantics; guarded writes revalidate the workspace destination around publication, including cancellation that wins during the final successful side effect.
- Broad Desktop dashboard polling moved from 2 seconds to a 30-second reconciliation fallback with focus/visibility and action-triggered refresh.
- Durable Goal checkpoints now support structured `resumeContext` persisted atomically with checkpoint revision: changed files, exact command outcomes, decisions, failed attempts, pending validation, resume prerequisites, state facts, and artifacts. `session_handoff` prioritizes this state before Git diff/legacy tracker fallback and now includes acceptance evidence, checkpoint evidence, tracked-task IDs, state facts, and artifacts in the handoff text.
- New `docs/roadmap/` drafts are ignored so future-plan documents do not enter product commits accidentally.
- The separate v5.5.0 Office Suite / What's New future plan is intentionally out of scope for this v5.4.3 cycle.

## Review evidence

This plan supersedes the open remediation ordering from `docs/roadmap/2026-09-19-senior-codebase-audit-remediation-plan.md` where the older item is now fixed or where this re-review provides more specific evidence.

The 2026-09-22 re-review used `open-code-review-delegate` with OCR for deterministic file selection and rule resolution, and Serena for symbol/reference/implementation tracing.

Verified baseline:

- OCR reviewable files: **525**
- OCR rule coverage: **525 / 525**
- Uncovered OCR-selected files: **0**
- `corepack pnpm@10.15.0 lint`: **pass**
- `corepack pnpm@10.15.0 typecheck`: **pass**
- `corepack pnpm@10.15.0 test`: **pass**
- Desktop suite: **106 files / 733 passed / 1 skipped**
- `pnpm audit --prod --json`: **2 High advisories**, both through `extract-zip@2.0.1`
- Working tree was clean before this plan file was created.

## Severity summary

| Severity | Confirmed active findings |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 5 |

The severity is product-context severity, not merely upstream package severity. Where exploitability depends on an additional condition, that condition is called out explicitly.

---

## High 1 — Remote MCP dynamic client registration has unbounded unauthenticated state

### Evidence

`apps/desktop/src/main/remote-mcp-controller.ts` keeps OAuth state in process-wide maps:

- `clients`
- `authCodes`
- `accessTokens`
- `refreshTokens`

The public `POST /oauth/register` path accepts a bounded request body but creates a new random client and unconditionally stores it with:

`this.clients.set(clientId, ...)`

There is no registration-count cap, TTL eviction, untrusted-client pruning, or global registration rate bound. The only client slicing is when trusted state is persisted/reloaded; it does not bound the live map.

A single registration may retain up to 16 redirect URIs of up to 2,048 characters each, plus client metadata/secret. When Remote MCP is published through ngrok, an unauthenticated network peer can repeatedly register clients until the Desktop process exhausts memory.

This is an availability issue reachable without an OAuth token while Remote MCP is online.

### Fix plan

1. Separate **ephemeral untrusted registrations** from **trusted persisted clients**.
2. Add an explicit maximum for live untrusted clients (for example a small bounded LRU; choose the final number from realistic ChatGPT reconnect/concurrency measurements, not guesswork).
3. Add registration timestamps and an untrusted-client TTL.
4. Prune expired/untrusted clients before admitting a new registration.
5. Return a standards-compatible bounded failure when capacity is reached; do not silently evict a currently active authorization.
6. Add periodic/lazy pruning for expired authorization codes and access tokens as well so all OAuth maps have bounded lifetime, not only the DCR map.
7. Do not trust `X-Forwarded-For` as a security identity unless the gateway explicitly verifies the forwarding boundary. A global/token-bucket limit is safer than a spoofable per-IP limit behind a tunnel.
8. Preserve trusted client persistence and refresh-grant rotation semantics.

### Regression tests

Modify `apps/desktop/tests/remote-mcp-controller.test.ts`:

- register clients up to the configured bound and prove the next registration is rejected without increasing live state;
- advance an injected clock beyond the untrusted-client TTL and prove capacity is recovered;
- prove a trusted client is not evicted by untrusted-client pruning;
- prove refresh/auth-code expiry pruning does not invalidate still-live grants;
- prove malformed/oversized registrations remain bounded as they are today.

### Exit criteria

- unauthenticated registrations cannot cause unbounded process memory growth;
- all OAuth in-memory collections have explicit lifetime/cap semantics;
- existing Remote MCP OAuth and reconnect tests remain green.

---

## High 2 — Privileged GitHub workflows use mutable third-party action tags

### Evidence

Third-party actions are referenced by mutable tags instead of immutable full commit SHAs:

- `.github/workflows/release.yml`: `softprops/action-gh-release@v3`
- `.github/workflows/ci.yml`: `sigstore/cosign-installer@v4.1.2` in native package verification and Windows release verification
- `.github/workflows/dev-installer.yml`: `sigstore/cosign-installer@v4.1.2`

The release workflow has `contents: write` and passes `GITHUB_TOKEN` to the release action. The cosign installer participates in the artifact/provenance verification path.

OCR's workflow rule explicitly requires third-party actions to be pinned to a full commit SHA.

### Fix plan

1. Resolve the exact trusted commit for each currently approved third-party action release.
2. Replace mutable tag refs with full 40-character commit SHAs.
3. Keep the human-readable release/tag in an inline comment beside each SHA.
4. Review action permissions at the same time; do not broaden workflow permissions.
5. Keep the existing checksum-pinned Windows cosign fallback.
6. Prefer one centrally documented update procedure for pinned action SHAs.

### Regression test

Extend the existing release/public-repository hygiene test instead of creating a redundant suite:

- parse `.github/workflows/*.{yml,yaml}`;
- allow first-party `actions/*` according to repository policy;
- require every other remote `uses:` reference to use a full commit SHA;
- fail with the workflow path and offending `uses:` value.

This is a meaningful supply-chain regression test, not a formatting test.

### Exit criteria

- no third-party workflow action executes from a mutable tag;
- release and CI permissions remain least-privilege;
- release-gate and packaging tests remain green.

---

## Medium 1 — Zero-click Remote MCP trust is inferred from redirect-URI shape rather than an authenticated client identity

### Evidence

`isZeroClickChatGptClient()` returns true when all redirect URIs match recognized `https://chatgpt.com` callback path patterns. A dynamically registered client meeting that URI rule is sent through a loopback approval URL, and a successful GET to that random loopback path marks the client `trusted: true` and persists it.

The current trust decision therefore proves that the registered redirect URI *looks like* a supported ChatGPT callback, but it does not independently prove a client identity or software statement.

The re-review downgrades this from the previous High classification to **Medium** because an end-to-end attacker path also requires control of, or receipt through, a usable ChatGPT callback route and authorization navigation. That complete attacker flow was not demonstrated in this review.

### Fix plan

1. Do not treat redirect URI shape alone as first-use client identity.
2. Investigate whether the supported ChatGPT OAuth/DCR flow provides an authenticated software statement, signed registration metadata, or another stable attestation. Use it only if it is an actual supported contract.
3. If no verifiable client attestation exists, require an explicit **first-use native Desktop approval** that shows at least client name and exact redirect URI.
4. Persist the resulting trusted client fingerprint/registration and allow subsequent reconnects to remain zero-click.
5. Reset OAuth trust must continue to invalidate trusted registrations, codes, access tokens and refresh tokens.
6. Keep exact-host/path checks and PKCE S256 requirements.

### Regression tests

- an unknown/new client with a syntactically recognized ChatGPT redirect must not become trusted without the new first-use trust condition;
- a previously trusted client should reconnect without an unnecessary prompt;
- lookalike domains, path variants, query/fragment variants and mismatched redirect URIs must still fail closed;
- OAuth reset must revoke the persisted trust.

### Exit criteria

- first-use trust rests on a verifiable identity or an explicit local user decision;
- redirect syntax remains validation, not identity;
- subsequent supported reconnects retain the intended low-friction behavior.

---

## Medium 2 — Production PDF extraction still uses `extract-zip@2.0.1` with two High upstream advisories

### Evidence

`apps/desktop/package.json` has production dependency:

`"extract-zip": "2.0.1"`

`pnpm audit --prod --json` reports:

- CVE-2026-56876 / GHSA-jmr9-qjv8-65gv — symlink path traversal
- CVE-2026-19693 / GHSA-7pqw-9j4j-h8q3 — arbitrary write through a planted symlink entry

Both are reported High (CVSS 8.1), and the audit currently reports no patched upstream version.

The actual PDF-provider flow verifies archive size and a pinned SHA-256 before extraction. That materially reduces attacker control over the archive in the normal production path, which is why the product-context severity remains Medium rather than copying the upstream severity blindly.

Build scripts also use `@electron-internal/extract-zip`; that package was not the source of the two production audit findings, but it should be reviewed under the same archive-containment contract while this area is changed.

### Fix plan

1. Replace `extract-zip@2.0.1` with a maintained extraction implementation or a hardened internal extraction layer.
2. Reject symlinks, junction-like archive entries, absolute paths, drive-qualified paths, `..` escapes and duplicate-entry overwrite tricks before writing.
3. Resolve and verify every destination remains within the extraction root.
4. Keep existing source URL, byte-size and SHA-256 validation.
5. Stage extraction in a private temporary directory and only publish the verified provider tree after complete validation.
6. Review `prepare-runtime-tools.mjs` and `prepare-tunnel-client.mjs` so build-time ZIP extraction follows the same containment policy where applicable.
7. Remove the vulnerable production dependency once no production call site needs it.

### Regression tests

Extend `apps/desktop/tests/pdf-provider-installer.test.ts` with controlled malicious fixtures:

- `../` path escape;
- absolute path;
- symlink target outside extraction root;
- duplicate-name symlink then regular-file overwrite;
- normal valid archive still installs.

Run `pnpm audit --prod` after dependency changes.

### Exit criteria

- the production dependency path no longer reports these High advisories;
- malicious ZIP fixtures cannot create/write outside the extraction root;
- packaged Windows PDF provider still installs and runs.

---

## Medium 3 — Multi-file patch and checkpoint restore can leave partial state on write failure or cancellation

### Evidence

`FileService.applyPatch()` validates all files and creates a checkpoint, then writes files sequentially. If the Nth write fails, earlier files remain changed and the function returns the writer error.

The loop also checks cancellation before each write. Cancellation after one successful write can therefore return a cancelled result while earlier files remain changed.

`CheckpointService.restore()` has the same sequential multi-file restore shape after it creates a rollback checkpoint.

The checkpoint/rollback data exists, but the failing operation does not automatically restore already-written targets before returning.

### Fix plan

1. Define the contract as **all-or-rollback**, not impossible cross-filesystem atomicity.
2. Validate every target first.
3. Create the pre-mutation checkpoint/rollback checkpoint.
4. Stage all new contents before replacing live targets where practical.
5. Commit replacements in a deterministic order.
6. If any commit or cancellation occurs after the first live replacement, automatically restore every already-replaced target from the pre-mutation checkpoint.
7. Surface a compound structured error if the primary write failed and rollback also failed.
8. Include the relevant checkpoint/rollback identifier in failure details so manual recovery remains possible.
9. Apply the same transaction coordinator/helper to `applyPatch` and checkpoint restore rather than duplicating rollback logic.

### Regression tests

Use the existing FileService/CheckpointService suites and inject a writer that fails on a selected write:

- failure on file 2 of 3 restores file 1;
- cancellation after the first replacement restores the first replacement;
- rollback failure is surfaced distinctly and does not claim clean rollback;
- successful multi-file operations preserve the existing result contract.

### Exit criteria

- a failed/cancelled multi-file operation does not silently leave a mixed old/new tree;
- recovery evidence is always available when rollback cannot complete.

---

## Medium 4 — Workspace containment validation and the later filesystem mutation are separated by a TOCTOU window

### Evidence

`WorkspacePathGuard.resolveForWrite()` resolves the workspace root, checks the existing ancestor with `realpath`, and returns a pathname.

Later, `AtomicFileWriter.write()` creates parents/temp files and performs `rename()` using path strings. There is no identity-bound proof carried from the guard to the final filesystem mutation.

Static pre-existing symlink/junction escapes are already rejected and have a Windows junction regression test. The remaining issue is a path component changing **after validation but before mutation**.

This is a local agent-scope boundary race, not an OS privilege escalation: a same-user process generally already has the user's filesystem privileges. It still matters because lnwjing promises workspace-scoped AI mutations.

### Fix plan

1. Extend guarded write resolution with an identity proof for the workspace root and existing parent/target (device/inode or platform-equivalent where available).
2. Revalidate mutation ancestry immediately before creating a temp file and again before publishing the final rename.
3. Fail closed if a parent becomes a symlink/reparse point or its identity changes.
4. For new parent creation, create one level at a time and revalidate containment after each creation.
5. Keep temp files unpredictable and in the verified target parent.
6. Investigate whether the native platform layer can provide stronger handle-relative/openat-style mutation primitives. Do not claim the race fully eliminated if Node path APIs cannot provide that guarantee.
7. Document the exact guarantee achieved per OS.

### Regression tests

- existing static symlink/junction escape tests remain;
- add a controlled race fixture that swaps a parent to an outside symlink/junction between initial resolution and the guarded mutation hook;
- prove the mutation fails closed and no outside file is written;
- run target-native tests on Windows and POSIX because reparse/symlink semantics differ.

### Exit criteria

- known ancestor swaps are detected before publication;
- no testable reparse/symlink swap can redirect a guarded AI write outside the workspace;
- any residual platform limitation is explicitly documented rather than hidden.

---

## Medium 5 — Desktop still rebuilds a broad dashboard snapshot every two seconds

### Evidence

`apps/desktop/src/renderer/App.tsx` calls both `getDashboard()` and `listWorkspaces()` every 2 seconds while the app is idle.

`getDashboard()` then assembles state across workspace selection, active workspaces, Git, Codex presence, audit summary, tracked processes, capabilities, MCP lifecycle, work log, activity sessions, tunnel, Remote MCP, backups, recovery trash and checkpoints.

Some expensive sections already use TTL caches, and recovery-retention deletion is separately throttled. The remaining design still creates recurring SQLite/I/O/process-state work independent of whether those sections changed.

### Fix plan

1. Measure the current idle cost first using existing diagnostics/benchmark hooks.
2. Split dashboard state into independently versioned sections.
3. Emit invalidation/change events from authoritative owners:
   - workspace/settings repository;
   - process service;
   - activity/log hub;
   - MCP lifecycle;
   - tunnel/Remote MCP controllers;
   - backup/recovery services.
4. Recompute only dirty sections.
5. Keep a slower reconciliation poll as a correctness fallback, not a 2-second full snapshot rebuild.
6. Avoid duplicate `listWorkspaces()` work when the dashboard snapshot already has enough workspace state, or clearly separate the responsibilities if both are required.
7. Preserve explicit user refresh.

### Validation

Use the existing performance contract/benchmark infrastructure:

- compare idle IPC request rate;
- compare SQLite reads and process probes on a representative large workspace;
- prove tunnel/process/workspace updates appear promptly;
- prove the fallback reconciliation repairs a deliberately missed event.

### Exit criteria

- materially lower idle CPU/I/O/IPC activity;
- no observable stale-state regression.

---

## Confirmed false positives / closed concerns

These are intentionally **not** implementation findings in this plan:

### IPC sender validation is present

Every production Desktop IPC handler reviewed calls `assertTrustedSender()`; BrowserWindow navigation/window-open/webview restrictions also remain enabled. The helper validates the sender frame against the packaged renderer URL.

### Local MCP HTTP listener is loopback-only

`packages/mcp-server/src/http.ts` explicitly binds `127.0.0.1` and, when available, `::1`. It does not bind a wildcard/public interface.

### Dynamic SQL fragments reviewed are internally constructed

The storage queries found during the SQL sweep use prepared values or internal constant column/status lists. No user-controlled SQL injection was confirmed.

### CommandPolicy ignoring argv is not a bypass

`ProcessService.startInternal()` runs `prohibitedAgentCommandReason()` and `riskyAgentCommandReason()` over executable + arguments before CommandPolicy/profile evaluation.

### Remote MCP persisted OAuth state is protected

Trusted clients/refresh grants are encrypted through `SecretProtector`; the secret-state file is written with restrictive mode on supporting platforms.

### Previous workspace-index invalidation concern is now fixed

The current tree has `WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION` and persisted snapshots are accepted only when `discoveryPolicyRevision` matches. The 2026-09-19 stale-index remediation item is therefore closed and must not be reimplemented.

### Existing browser hardening remains in place

Electron windows use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, deny new windows/webviews and restrict navigation to the packaged renderer.

---

## Carry-over maintainability work (not counted in the 2 High / 5 Medium defect total)

These remain worthwhile after the correctness/security waves, but they should not block the higher-risk fixes above merely to reduce line count.

### Desktop composition concentration

Large high-churn files still include:

- `apps/desktop/src/main/desktop-services.ts`
- `apps/desktop/src/main/main.ts`
- `packages/mcp-server/src/upgrade-runtime.ts`
- `packages/storage/src/goal-repository.ts`

Use contract-preserving extractions only:

- Desktop startup/composition vs Doctor/readiness vs tunnel/auth;
- IPC registration grouped by domain;
- updater/crash/session diagnostics extracted from `main.ts`;
- MCP runtime facades grouped by capability domain;
- goal repository schema/serialization/migration separated from workflow queries.

Do not create a new package simply to reduce file length.

### Durable-goal duplicate helpers

Only consolidate helpers that are semantically identical (bounded normalization, lease-token hashing). Do not create a generic utility dumping ground and do not centralize unrelated one-line record guards.

### Dependency modernization

Keep ordinary dependency maintenance separate from security/reliability fixes. Major ESLint/TypeScript/Vite/Vitest migrations require dedicated changes. Electron remains evidence-driven, not a generic "upgrade to latest" task.

---

## Implementation order

### Wave 0 — preserve baseline

Already established for this review:

- lint pass;
- typecheck pass;
- full workspace tests pass;
- OCR coverage 525/525.

Before each implementation PR, rerun the smallest affected tests and the repository release gates required by that change.

### Wave 1 — Remote MCP public-boundary hardening

Do High 1 and Medium 1 together only where code ownership overlaps, but keep two explicit acceptance criteria:

1. bound public DCR/OAuth memory;
2. strengthen first-use trust identity/approval.

This wave should not include ngrok-provider feature work.

### Wave 2 — CI/release supply-chain pinning

Implement High 2 in an isolated configuration/security PR. No application behavior changes.

### Wave 3 — archive extraction

Implement Medium 2. Keep dependency/extractor replacement isolated from unrelated runtime dependency upgrades.

### Wave 4 — filesystem mutation safety

Implement Medium 3 first (all-or-rollback semantics), then Medium 4 (containment identity/revalidation). Keeping them adjacent is useful because both touch mutation publication and recovery, but commit them as separable behavioral changes when practical.

### Wave 5 — dashboard refresh architecture

Implement Medium 5 only after measuring the current baseline. Preserve a slower fallback reconciliation path.

### Wave 6 — maintainability extractions

Only after the active High/Medium correctness and security findings are closed.

---

## Required verification by wave

### Remote MCP security

- focused `remote-mcp-controller.test.ts`;
- Desktop typecheck;
- Desktop test suite;
- a manual published-gateway smoke with a real supported ChatGPT connection before release.

### Workflow supply chain

- workflow hygiene contract;
- `test:release-gate`;
- normal GitHub CI on the exact SHA.

### Archive extraction

- malicious archive fixtures;
- `pnpm audit --prod`;
- Windows target-native package/PDF-provider smoke.

### Filesystem mutation

- FileService and CheckpointService regression tests;
- workspace path security tests;
- Windows + POSIX target-native path-boundary tests.

### Dashboard

- Desktop performance contract;
- persistence/state tests;
- representative idle benchmark.

---

## Completion criteria

This remediation plan is complete only when:

1. all High findings are closed with regression evidence;
2. all Medium findings are fixed or explicitly accepted with a documented reason;
3. `pnpm audit --prod` no longer reports the active production extraction vulnerability path;
4. no third-party privileged GitHub Action is referenced by a mutable tag;
5. Remote MCP public registration/state is bounded;
6. first-use Remote MCP trust has a verifiable identity or explicit native user decision;
7. failed/cancelled multi-file writes restore prior state or expose a truthful rollback failure;
8. workspace mutation containment has the strongest tested per-platform guarantee available;
9. dashboard idle work is measurably reduced without stale-state regressions;
10. root lint, typecheck, relevant tests, release gates and target-native verification required by each change are green.
