import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop performance contract', () => {
  it('keeps the main renderer refresh single-flight with event-driven wakeups and a slow reconciliation fallback', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (updateInstallTransitionRef.current) return;');
    expect(source).toContain('if (refreshBusyRef.current) {');
    expect(source).toContain('refreshPendingRef.current = true;');
    expect(source).toContain('window.setTimeout(() => { void refresh(); }, 0);');
    expect(source).toContain("const reconcileInterval = window.setInterval(() => {");
    expect(source).toContain("if (document.visibilityState === 'visible') void refresh();");
    expect(source).toContain('}, 30_000);');
    expect(source).toContain("window.addEventListener('focus', refreshOnFocus)");
    expect(source).toContain("document.addEventListener('visibilitychange', refreshOnVisibility)");
    expect(source).not.toContain('window.setInterval(() => { void refresh(); }, 2_000)');
    expect(source).not.toContain('window.setInterval(() => { void refresh(); }, 1_000)');
  });

  it('moves expensive SQLite audit cleanup off Electron Main after policy edits', () => {
    const desktop = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const policy = desktop.slice(desktop.indexOf('    configurePolicy: (options) => {'),
      desktop.indexOf('    inspect: () => {', desktop.indexOf('    configurePolicy: (options) => {')));
    const sweep = desktop.slice(desktop.indexOf('  function sweepHardLimitPressure('),
      desktop.indexOf('  const hardLimitTimer =', desktop.indexOf('  function sweepHardLimitPressure(')));
    expect(policy).toContain('scheduleHardLimitPressureRecovery();');
    expect(policy).not.toContain('sweepHardLimitPressure(true);');
    expect(sweep).toContain('purgeExpiredRoutineReadsOffMain(databaseFilename, cutoff, limit, completedOnly)');
    expect(sweep).toContain('recoverOldFileCheckpointsUnderHardLimit(');
    expect(sweep).toContain('pruneExpiredFileCheckpointsOffMain(databaseFilename, cutoff, limit)');
    // Admission prioritizes already-expired file Undo over slow legacy audit
    // scans; audit scan failure must never prevent independent Undo cleanup.
    const checkpointStart = sweep.indexOf('const checkpoints = await recoverOldFileCheckpointsUnderHardLimit(');
    expect(sweep.indexOf('if (!urgent) await recoverAudit();')).toBeLessThan(checkpointStart);
    expect(sweep.indexOf('if (urgent && hardLimitRecoveryNeeded(readFootprint())) await recoverAudit();'))
      .toBeGreaterThan(checkpointStart);
    expect(sweep).toContain("console.error('Audit emergency recovery skipped: '");
    expect(sweep).toContain('cleanupFailed = true;');
    expect(sweep).not.toContain('checkpointRepository.deleteAll()');
    expect(sweep).not.toContain('VACUUM');
    expect(sweep).not.toContain('auditRepository.purgeExpiredRoutineReads(');
    expect(desktop).toContain('hasExpiredRoutineReadCandidatesOffMain(databaseFilename, cutoffIso)');
    expect(desktop).toContain('if (pressureSweep !== null) await pressureSweep;');
    expect(desktop).toContain('if (auditRetentionSweep !== null) await auditRetentionSweep;');
    expect(desktop).toContain('if (auditRetentionClosing || storagePolicyUpdating) return Promise.resolve();');
    expect(desktop).toContain('setTimeout(() => {');
    expect(desktop).not.toContain('await auditRepository.purgeExpiredRoutineReads(cutoffIso)');
  });

  it('refreshes Running Projects from activity-only IPC rather than the full dashboard on MCP log events', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const desktop = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const handler = desktop.slice(desktop.indexOf('    getRunningProjectsActivity: async () => {'), desktop.indexOf('    getDashboard: async (): Promise<DashboardSnapshot> => {'));
    expect(app).toContain('window.lnwjing.getRunningProjectsActivity()');
    expect(app).toContain('refreshActiveProjectsRef.current = (): void => { void refreshRunningProjects(); };');
    expect(app).toContain('runningActivityPendingRef.current = true;');
    expect(handler).toContain('activityTracker.listInFlight()');
    expect(handler).toContain('listRecentMcpWorkspaceActivity(');
    expect(handler).not.toContain('buildWorkLog(auditRepository, workLogViewState)');
    for (const expensive of ['buildGitSummary', 'backupService', 'checkpointService', 'tunnelController', 'sweepRecoveryRetention']) {
      expect(handler).not.toContain(expensive);
    }
  });

  it('batches pushed log events instead of copying a 30k-line React state array for every line', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const viewer = readFileSync(new URL('../src/renderer/features/live/StandaloneLogViewer.tsx', import.meta.url), 'utf8');
    for (const source of [app, viewer]) {
      expect(source).toContain('pendingLogLines.current.push(line);');
      expect(source).toContain('window.setTimeout(flushPendingLogLines, 40)');
      expect(source).toContain('appendLogBatch(previous, batch, MAX_CLIENT_LOG_LINES)');
      expect(source).toContain('rememberLogId(logIds.current, line.id, MAX_CLIENT_LOG_LINES * 2)');
      expect(source).not.toContain('setLogLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line])');
      expect(source).not.toContain('setLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line])');
    }
  });

  it('does not wake the full dashboard from the standalone live-log viewer', () => {
    const source = readFileSync(new URL('../src/renderer/features/live/StandaloneLogViewer.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('window.setInterval');
  });

  it('caches expensive dashboard probes and shares the WSL availability probe', () => {
    const desktop = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const capabilities = readFileSync(new URL('../../../packages/capabilities/src/platform-capability-set.ts', import.meta.url), 'utf8');

    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['gitSummary']>(5_000)");
    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['codex']>(60_000)");
    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['capabilities']>(15_000)");
    expect(capabilities).toContain('const wslAvailabilityCache = new AsyncTtlCache<import(\'@lnwjing/domain\').Result<unknown>>(15_000);');
    expect(capabilities).toContain('wslAvailabilityCache.get(async () =>');
  });

  it('does not fan out filesystem reads from unbounded Git, backup, or scheduler lists', () => {
    const desktop = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const gitSummary = desktop.slice(desktop.indexOf('async function buildGitSummary'), desktop.indexOf('async function buildCodexSummary'));
    const backups = readFileSync(new URL('../../../packages/storage/src/backup-service.ts', import.meta.url), 'utf8');
    const schedulers = readFileSync(new URL('../../../packages/capabilities/src/portable-scheduler-backend.ts', import.meta.url), 'utf8');

    expect(gitSummary).not.toContain('Promise.all');
    expect(gitSummary).not.toContain('readBoundedGitTextFile');
    expect(backups).not.toContain('Promise.all(names.filter');
    expect(schedulers).not.toContain('Promise.all(names.map');
  });
});
