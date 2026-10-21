import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@lnwjing/audit';
import { WorkLogViewState } from '../src/main/work-log-view-state.js';

class MemoryStore {
  public readonly values = new Map<string, string>();
  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public set(key: string, value: string): void { this.values.set(key, value); }
}

function event(timestamp: string, workspaceId?: string, sessionId?: string): AuditEvent {
  return {
    timestamp,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

describe('WorkLogViewState', () => {
  it('clears one workspace without hiding another workspace', () => {
    const state = new WorkLogViewState(new MemoryStore());
    state.clear({ workspaceId: 'workspace-a' }, '2026-08-24T00:00:10.000Z');
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-a', 'session-a'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-b', 'session-b'))).toBe(true);
    expect(state.isVisible(event('2026-08-24T00:00:11.000Z', 'workspace-a', 'session-a'))).toBe(true);
  });

  it('clears one session across workspaces without hiding other sessions', () => {
    const state = new WorkLogViewState(new MemoryStore());
    state.clear({ sessionId: 'session-a' }, '2026-08-24T00:00:10.000Z');
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-a', 'session-a'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-b', 'session-a'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-a', 'session-b'))).toBe(true);
  });

  it('combines all workspace and session cursors using the newest matching timestamp', () => {
    const state = new WorkLogViewState(new MemoryStore());
    state.clear({}, '2026-08-24T00:00:05.000Z');
    state.clear({ workspaceId: 'workspace-a' }, '2026-08-24T00:00:10.000Z');
    state.clear({ sessionId: 'session-a' }, '2026-08-24T00:00:15.000Z');
    expect(state.isVisible(event('2026-08-24T00:00:06.000Z', 'workspace-b', 'session-b'))).toBe(true);
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-a', 'session-b'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:14.000Z', 'workspace-b', 'session-a'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:16.000Z', 'workspace-a', 'session-a'))).toBe(true);
  });

  it('migrates only the legacy automatic startup clear while preserving scoped clears', () => {
    const store = new MemoryStore();
    const state = new WorkLogViewState(store);
    state.clear({}, '2026-09-18T23:00:08.000Z');
    state.clear({ workspaceId: 'workspace-a' }, '2026-09-18T23:15:00.000Z');
    expect(state.isVisible(event('2026-09-18T22:30:00.000Z', 'workspace-b', 'session-old'))).toBe(false);

    expect(state.migrateAutomaticStartupClear('2026-09-18T23:00:00.000Z')).toBe(true);
    expect(state.isVisible(event('2026-09-18T22:30:00.000Z', 'workspace-b', 'session-old'))).toBe(true);
    expect(state.isVisible(event('2026-09-18T23:10:00.000Z', 'workspace-a', 'session-a'))).toBe(false);
    expect(state.migrateAutomaticStartupClear('2026-09-18T23:00:00.000Z')).toBe(false);
  });

  it('does not migrate a deliberate global clear that happened well after startup', () => {
    const store = new MemoryStore();
    const state = new WorkLogViewState(store);
    state.clear({}, '2026-09-18T23:15:00.000Z');
    expect(state.migrateAutomaticStartupClear('2026-09-18T23:00:00.000Z')).toBe(false);
    expect(state.isVisible(event('2026-09-18T23:10:00.000Z', 'workspace-a', 'session-a'))).toBe(false);
  });

  it('honors the legacy global cursor and writes new scope state to the internal key', () => {
    const store = new MemoryStore();
    store.set('work_log_cleared_at', '2026-08-24T00:00:10.000Z');
    const state = new WorkLogViewState(store);
    expect(state.isVisible(event('2026-08-24T00:00:09.000Z', 'workspace-a', 'session-a'))).toBe(false);
    expect(state.isVisible(event('2026-08-24T00:00:11.000Z', 'workspace-a', 'session-a'))).toBe(true);
    state.clear({ workspaceId: 'workspace-a' }, '2026-08-24T00:00:12.000Z');
    expect([...store.values.keys()]).toContain('internal.log_view.work_log_clear_state.v1');
  });
});
