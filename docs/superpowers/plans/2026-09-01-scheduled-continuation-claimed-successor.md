# Scheduled Continuation Claimed-Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every successful scheduled wake claim atomically reserve and return exactly one fresh cloud successor so an active goal cannot lose its durable continuation merely because the model forgot a separate prepare call.

**Architecture:** Extend the repository claim transaction to acquire the goal lease, terminalize the firing one-time continuation, and insert generation N+1 as `prepared` in one commit. The application returns the acquired lease plus the prepared successor and its host-owned `scheduleRequest`; interrupted repeats return `successor_required` for the same deterministic row. Native task creation remains host-owned and is not considered confirmed until its receipt is recorded.

**Tech Stack:** TypeScript, Node.js 22, SQLite `DatabaseSync`, Zod MCP schemas, Vitest 3, pnpm 10.15.0, Electron Builder/PowerShell Windows packaging.

## Global Constraints

- Target release remains exactly `4.45.0` on branch `dev`.
- Preserve the fresh one-time successor model for an acquired wake; never count the firing task as future coverage.
- Keep exactly one live continuation per goal and one native cloud task pending after host confirmation.
- Preserve current same-task collision deferral, orphan recovery, tracked-task liveness, lease fencing, cancellation, and terminal-noop behavior.
- Native task creation/update/deletion remains host-owned; `prepared`, `create_failed`, and `create_uncertain` are never handoff-ready. A replay with a missing/uncertain receipt or recorded native ID must reconcile exact host metadata before any create; only a truthfully failed create without a native ID may refresh to a new +2 retry.
- Do not expose lease tokens, native task IDs, or arbitrary objective/checkpoint text in generated native prompts.
- Include every current authorized v4.45 working-tree change in one final commit; do not reset, discard, merge, tag, or publish a GitHub Release.
- Build Setup and Portable installers only after the final commit is pushed to `origin/dev`, then verify packaged runtime bytes, checksums, and provenance locally.

---

### Task 1: Storage-level atomic claimed successor

**Files:**
- Modify: `packages/domain/src/scheduled-continuation.ts`
- Modify: `packages/storage/src/goal-repository.ts`
- Test: `packages/storage/src/scheduled-continuation.integration.test.ts`

**Interfaces:**
- Consumes: `ClaimScheduledContinuationRecordRequest`, `ScheduledContinuationRecord`, the existing partial unique live-continuation index, and repository transaction/CAS helpers.
- Produces: deterministic request fields `claimSuccessorId`, `claimSuccessorDueAt`, `claimSuccessorRequestFingerprint`; `ClaimScheduledContinuationRecordResult` variants whose `acquired` and recovery `successor_required` cases include `successor: ScheduledContinuationRecord`.

- [ ] **Step 1: Add the failing storage regression**

Extend the released-predecessor claim test so the first successful claim must create generation N+1 in the same repository call:

```ts
const winner = await repository.claimScheduledContinuation({
  continuationId: 'continuation-claim',
  ownerClientId: 'chatgpt-web-client',
  ownerSessionId: 'session-b',
  leaseTokenHash: 'lease-hash-b',
  leaseSeconds: 600,
  claimSuccessorId: 'continuation-claim-successor',
  claimSuccessorDueAt: '2026-08-27T00:24:00.000Z',
  claimSuccessorRequestFingerprint: 'claim-successor-fingerprint',
  now: '2026-08-27T00:22:00.000Z',
});

expect(winner).toMatchObject({
  outcome: 'acquired',
  continuation: { continuationId: 'continuation-claim', status: 'claimed' },
  successor: {
    continuationId: 'continuation-claim-successor',
    generation: 2,
    status: 'prepared',
    dueAt: '2026-08-27T00:24:00.000Z',
  },
});
expect(await repository.getLiveScheduledContinuation('goal-1')).toMatchObject({
  continuationId: 'continuation-claim-successor',
  status: 'prepared',
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
corepack pnpm@10.15.0 exec vitest run packages/storage/src/scheduled-continuation.integration.test.ts -t "lets a released predecessor or natural due-time expiry hand the lease to exactly one claimer" --exclude=.superpowers/** --exclude=.local-artifacts/** --reporter=verbose
```

Expected: FAIL because the current acquired result has no `successor` and no live continuation remains after the firing row becomes `claimed`.

- [ ] **Step 3: Extend the domain record contract**

Add the deterministic successor inputs and results:

```ts
export interface ClaimScheduledContinuationRecordRequest {
  // existing fields
  readonly claimSuccessorId: string;
  readonly claimSuccessorDueAt: string;
  readonly claimSuccessorRequestFingerprint: string;
}

export type ClaimScheduledContinuationRecordResult =
  | {
      readonly outcome: 'acquired';
      readonly acquisition: ScheduledContinuationAcquisition;
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
      readonly successor: ScheduledContinuationRecord;
      readonly successorDisposition: 'freshly_reserved';
    }
  | {
      readonly outcome: 'successor_required';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
      readonly successor: ScheduledContinuationRecord;
      readonly successorDisposition: 'freshly_reserved' | 'existing_unconfirmed' | 'retryable_failed_create' | 'refreshed_failed_create';
      readonly retryAfterSeconds: 120;
    }
  // existing variants
```

- [ ] **Step 4: Implement the atomic repository transition**

Generate or recover the deterministic fresh row inside the same transaction as lease acquisition and current-row claim. The successful path must perform this order:

```ts
UPDATE goals SET lease_owner_client_id = ?, ...;
UPDATE goal_scheduled_continuations
SET status = 'claimed', claimed_at = ?, terminal_at = ?, ...
WHERE id = ? AND version = ?;
INSERT INTO goal_scheduled_continuations (...)
VALUES (..., 'prepared', 'once', 'current_chat', 'cloud', NULL, ?, NULL, ...);
```

Use one helper that validates deterministic identity, due time, generation, source revision, and request fingerprint. For an already-`claimed` active goal, return the same successor as `successor_required`; expose a create request only for a fresh reservation or a truthfully failed create with no native ID. Require host reconciliation for `prepared` without a receipt, `create_uncertain`, or any recorded native ID; repair a legacy claimed row with no successor by inserting that same deterministic row even after the prior lease was released. Do not alter collision or orphan paths.

- [ ] **Step 5: Verify storage GREEN and idempotency**

Run the focused test from Step 2, then the complete storage continuation file:

```powershell
corepack pnpm@10.15.0 exec vitest run packages/storage/src/scheduled-continuation.integration.test.ts --exclude=.superpowers/** --exclude=.local-artifacts/** --reporter=dot
```

Expected: all current-tree tests pass; repeated claims return one deterministic successor and no duplicate live generation.

### Task 2: Application claim contract and host handoff

**Files:**
- Modify: `packages/application/src/scheduled-continuation-service.ts`
- Test: `packages/application/src/scheduled-continuation-service.test.ts`

**Interfaces:**
- Consumes: the Task 1 record result and existing `buildScheduleRequest` privacy-safe prompt builder.
- Produces: `ClaimScheduledContinuationResult['acquired']` with `successor`, `scheduleRequest`, `handoffReady: false`, `currentWakeMayReturn: false`, and `nextRequiredAction`.

- [ ] **Step 1: Add the failing application regression**

Augment the confirmed due-wake acquisition test:

```ts
expect(result).toMatchObject({
  ok: true,
  value: {
    outcome: 'acquired',
    acquisition: 'expired_lease',
    continuation: { status: 'claimed' },
    successor: { generation: 2, status: 'prepared' },
    handoffReady: false,
    currentWakeMayReturn: false,
    nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
    scheduleRequest: { provider: 'chatgpt_scheduled_task', occurrence: 'once', destination: 'current_chat' },
  },
});
```

Assert that the schedule prompt contains `claim_scheduled_continuation`, requires the returned acquired successor receipt, and contains no objective, summary, next action, evidence, or lease token.

- [ ] **Step 2: Run the application regression and verify RED**

```powershell
corepack pnpm@10.15.0 exec vitest run packages/application/src/scheduled-continuation-service.test.ts -t "accepts an observed 74-second early|claimed successor" --exclude=.superpowers/** --exclude=.local-artifacts/** --reporter=verbose
```

Expected: FAIL because current `acquired` returns only the lease and firing continuation.

- [ ] **Step 3: Generate deterministic successor identity before repository claim**

Use the existing `createHash` import and the sampled post-liveness clock:

```ts
const claimSuccessorFingerprint = createHash('sha256')
  .update(`claimed-successor-v1\0${continuationId}`)
  .digest('hex');
const claimSuccessorId = `wake-${claimSuccessorFingerprint.slice(0, 48)}`;
const claimSuccessorDueAt = new Date(nowDate.getTime() + 2 * 60_000).toISOString();
```

Pass all three values into `goals.claimScheduledContinuation`.

- [ ] **Step 4: Return a mandatory host handoff with acquired lease**

Map the acquired record result to:

```ts
return ok({
  outcome: 'acquired',
  continuation,
  successor,
  goal: { ...toRunSnapshot(goal), acquired: true },
  leaseToken,
  leaseGeneration: claimed.goal.leaseGeneration,
  acquisition: claimed.acquisition,
  scheduleRequest: buildScheduleRequest(successor, claimed.goal.workspaceId, this.hostTimeZone),
  handoffReady: false,
  currentWakeMayReturn: false,
  nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
});
```

Map repository `successor_required` to the same successor without exposing a new lease token. Emit a native-task `scheduleRequest` only when `successorDisposition` is `freshly_reserved`, `retryable_failed_create`, or `refreshed_failed_create`; for `existing_unconfirmed`, reconcile the exact host task/receipt first and never create blindly.

- [ ] **Step 5: Verify application GREEN**

Run the focused command from Step 2, then the complete application continuation suite. Expected: all current-tree tests pass with no secret marker in serialized schedule requests.

### Task 3: MCP, skill, and recovery contract

**Files:**
- Modify: `packages/mcp-server/src/tools/scheduled-continuation-tools.ts`
- Modify: `packages/mcp-server/src/tools/scheduled-continuation-tools.test.ts`
- Modify: `packages/mcp-server/src/scheduled-continuation-skill-contract.test.ts`
- Modify: `.agents/skills/lnwjing-scheduled-continuation/SKILL.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Task 2 claim result.
- Produces: one consistent agent-visible contract: acquired already contains a prepared successor; create and record that exact successor before useful long work or turn return.

- [ ] **Step 1: Add failing contract assertions**

Require the claim tool description and bundled skill to contain all of:

```ts
expect(description).toContain('acquired');
expect(description).toContain('atomically reserves');
expect(description).toContain('returned scheduleRequest');
expect(skill).toContain('do not call prepare_scheduled_continuation again');
expect(skill).toContain('currentWakeMayReturn: false');
```

- [ ] **Step 2: Run contract tests and verify RED**

```powershell
corepack pnpm@10.15.0 exec vitest run packages/mcp-server/src/tools/scheduled-continuation-tools.test.ts packages/mcp-server/src/scheduled-continuation-skill-contract.test.ts --exclude=.superpowers/** --exclude=.local-artifacts/** --reporter=verbose
```

Expected: FAIL because acquired currently instructs a separate prepare call and the claim description omits the acquired handoff.

- [ ] **Step 3: Update tool and workflow text**

Document these exact rules:

- acquired claim atomically reserves a fresh +2-minute successor;
- create the native task from the returned `scheduleRequest` and record the exact receipt;
- do not call `prepare_scheduled_continuation` again for that acquisition;
- do not return while the goal is active and the successor is merely prepared/failed/uncertain;
- repeated claim recovery returns `successor_required` for the same deterministic row;
- collision behavior remains the current same-native-task +2 deferral.

Update stale `AGENTS.md` collision wording to match the bundled skill, which is the declared source of truth.

- [ ] **Step 4: Verify contract GREEN**

Run the Task 3 test command and require all selected tests to pass.

### Task 4: README and operator documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/USAGE_TH.md`
- Modify: `docs/CHATGPT_LONG_SESSION.md`
- Modify: `docs/development/SCHEDULED_CONTINUATION_CAPABILITY_EVIDENCE.md`
- Modify: `docs/architecture/TOOL_CONTRACT.md` if the generated/current tool contract section references the old acquired flow.

**Interfaces:**
- Consumes: Tasks 1-3 behavior.
- Produces: user/operator documentation that distinguishes durable reservation, confirmed native coverage, host limitation, collision reschedule, and terminal completion.

- [ ] **Step 1: Update README and Thai usage flow**

Add a concise v4.45 behavior section covering:

1. `claim_scheduled_continuation(acquired)` now reserves generation N+1 atomically;
2. the returned row is only `prepared` until host receipt confirmation;
3. the worker creates the returned native one-time task instead of making a second prepare call;
4. host failure remains fail-closed and must never be reported as continuous recovery coverage;
5. repository tests do not substitute for a real two-wake host test.

Preserve and integrate the existing v4.45 tunnel-client v0.0.13/Persistent Tunnel Runtime documentation already present in the working tree.

- [ ] **Step 2: Reconcile stale collision documentation**

Make `CHATGPT_LONG_SESSION.md`, `USAGE_TH.md`, `AGENTS.md`, the bundled skill, tool description, and README agree that current collision recovery updates the same confirmed pending native task by +2 while acquired handoff returns a fresh successor.

- [ ] **Step 3: Regenerate/check the tool catalog**

```powershell
corepack pnpm@10.15.0 run docs:tools
corepack pnpm@10.15.0 run docs:tools:check
```

Expected: README/tool catalog matches the current MCP description and the check exits 0.

### Task 5: Verification and release gates

**Files:**
- Verify all current working-tree files; no new implementation files beyond Tasks 1-4.

**Interfaces:**
- Consumes: complete v4.45 working tree.
- Produces: fresh test/build evidence required before commit and push.

- [ ] **Step 1: Run focused continuation suites**

```powershell
corepack pnpm@10.15.0 exec vitest run packages/application/src/scheduled-continuation-service.test.ts packages/storage/src/scheduled-continuation.integration.test.ts packages/storage/src/goal-continuation.integration.test.ts packages/mcp-server/src/tools/scheduled-continuation-tools.test.ts packages/mcp-server/src/scheduled-continuation-skill-contract.test.ts --exclude=.superpowers/** --exclude=.local-artifacts/** --reporter=dot
```

- [ ] **Step 2: Run compile and complete workspace tests**

```powershell
corepack pnpm@10.15.0 run typecheck
corepack pnpm@10.15.0 test
```

- [ ] **Step 3: Run release gates**

```powershell
corepack pnpm@10.15.0 run test:acceptance
corepack pnpm@10.15.0 run test:packaging
corepack pnpm@10.15.0 run test:release-gate
corepack pnpm@10.15.0 run docs:tools:check
git diff --check
```

- [ ] **Step 4: Audit the complete authorized diff**

Confirm every working-tree file belongs to v4.45 tunnel/runtime, continuation, version synchronization, tests, docs, packaging, or release evidence. Confirm there are no credentials, generated installers, local databases, `.superpowers` review trees, or unrelated files staged.

### Task 6: Commit, push dev, and build installers

**Files:**
- Stage: every authorized tracked v4.45 working-tree change plus the force-added ignored spec/plan documents.
- Produce locally: `apps/desktop/dist/installers/lnwjing-Setup-4.45.0.exe`, `lnwjing-Portable-4.45.0.exe`, update metadata, blockmaps, `SHA256SUMS.txt`, and `PROVENANCE.json`.

**Interfaces:**
- Consumes: verified Task 5 tree.
- Produces: one pushed `dev` commit and locally verified Windows artifacts built from that pushed commit.

- [ ] **Step 1: Stage and inspect exactly the authorized tree**

```powershell
git add -A
git add -f docs/superpowers/specs/2026-09-01-scheduled-continuation-claimed-successor-design.md
git add -f docs/superpowers/plans/2026-09-01-scheduled-continuation-claimed-successor.md
git diff --cached --check
git status --short
```

- [ ] **Step 2: Commit the combined v4.45 change**

```powershell
git commit -m "fix: harden v4.45 tunnel and goal continuation"
```

- [ ] **Step 3: Push only `dev` and verify upstream equality**

```powershell
git push origin dev
git rev-parse HEAD
git rev-parse origin/dev
```

Expected: local HEAD and `origin/dev` are identical.

- [ ] **Step 4: Build Windows artifacts from the pushed commit**

```powershell
corepack pnpm@10.15.0 run package:windows
```

Wait for terminal exit 0; do not treat intermediate Electron Builder output as completion.

- [ ] **Step 5: Verify artifacts and provenance**

Run the release evidence verifier used by `package-windows.ps1`, execute packaged `tunnel-client.exe --version` and `cloudflared.exe --version`, compute SHA-256 for Setup/Portable, and verify every checksum recorded in `SHA256SUMS.txt` and `PROVENANCE.json` against the produced bytes.

- [ ] **Step 6: Report exact residuals**

Report commit SHA, push equality, test counts, installer paths/hashes, packaged runtime versions, provenance result, signing state, and any host-level scheduled-continuation behavior that remains unproven. Do not merge, tag, or publish a release.
