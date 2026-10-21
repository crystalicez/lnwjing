import { describe, expect, it } from 'vitest';
import type { ActivitySessionSummary } from '@lnwjing/audit';
import { ActivitySessionCatalog } from '../src/main/activity-session-catalog.js';

describe('ActivitySessionCatalog', () => {
  it('bounds the resident catalog and pages older sessions from SQLite on demand', async () => {
    const newest = Date.parse('2026-10-21T00:00:00.000Z');
    const history: ActivitySessionSummary[] = Array.from({ length: 620 }, (_, index) => ({
      sessionId: `session-${index}`,
      workspaceId: 'workspace-a',
      startedAt: new Date(newest - index * 60_000).toISOString(),
      lastActivityAt: new Date(newest - index * 60_000).toISOString(),
    }));
    const calls: Array<[number | undefined, number | undefined]> = [];
    const catalog = new ActivitySessionCatalog({
      async listActivitySessions(_prefix?: string, limit = 500, offset = 0): Promise<ActivitySessionSummary[]> {
        calls.push([limit, offset]);
        return history.slice(offset, offset + limit);
      },
    }, { isVisible: (): boolean => true });
    expect(await catalog.list()).toHaveLength(500);
    catalog.record({ sessionId: 'fresh', timestamp: new Date(newest + 1_000).toISOString() });
    expect(await catalog.list()).toHaveLength(500);
    expect((await catalog.list())[0]?.sessionId).toBe('fresh');
    const older = await catalog.page(500, 100);
    expect(older.sessions).toHaveLength(100);
    expect(older.sessions[0]?.sessionId).toBe('session-500');
    expect(older.hasMore).toBe(true);
    const final = await catalog.page(600, 100);
    expect(final.sessions).toHaveLength(20);
    expect(final.hasMore).toBe(false);
    expect(calls).toEqual([[500, 0], [101, 500], [101, 600]]);
  });


  it('loads persisted sessions once and updates new activity without rescanning audit history', async () => {
    let loads = 0;
    const persisted: ActivitySessionSummary[] = [{
      sessionId: 'session-old',
      workspaceId: 'workspace-a',
      startedAt: '2026-09-19T00:00:00.000Z',
      lastActivityAt: '2026-09-19T00:01:00.000Z',
    }];
    const catalog = new ActivitySessionCatalog({
      async listActivitySessions(): Promise<ActivitySessionSummary[]> {
        loads += 1;
        return persisted;
      },
    }, {
      isVisible: (): boolean => true,
    });

    expect(await catalog.list()).toHaveLength(1);
    expect(await catalog.list()).toHaveLength(1);
    expect(loads).toBe(1);

    catalog.record({
      sessionId: 'session-new',
      workspaceId: 'workspace-b',
      timestamp: '2026-09-20T01:00:00.000Z',
    });
    catalog.record({
      sessionId: 'session-new',
      workspaceId: 'workspace-b',
      timestamp: '2026-09-20T01:05:00.000Z',
    });

    expect(await catalog.list()).toEqual([
      {
        sessionId: 'session-new',
        workspaceId: 'workspace-b',
        startedAt: '2026-09-20T01:00:00.000Z',
        lastActivityAt: '2026-09-20T01:05:00.000Z',
      },
      {
        sessionId: 'session-old',
        workspaceId: 'workspace-a',
        startedAt: '2026-09-19T00:00:00.000Z',
        lastActivityAt: '2026-09-19T00:01:00.000Z',
      },
    ]);
    expect(loads).toBe(1);
  });

  it('applies the current work-log visibility state without reloading the catalog', async () => {
    let hiddenSession: string | null = null;
    const catalog = new ActivitySessionCatalog({
      async listActivitySessions(): Promise<ActivitySessionSummary[]> {
        return [{
          sessionId: 'session-a',
          startedAt: '2026-09-20T00:00:00.000Z',
          lastActivityAt: '2026-09-20T00:01:00.000Z',
        }];
      },
    }, {
      isVisible: (event): boolean => event.sessionId !== hiddenSession,
    });

    expect(await catalog.list()).toHaveLength(1);
    hiddenSession = 'session-a';
    expect(await catalog.list()).toEqual([]);
  });
});
