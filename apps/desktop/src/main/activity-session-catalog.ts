import type { ActivitySessionSummary, AuditEventRepository } from '@lnwjud/audit';
import type { LogSessionSummary } from '@lnwjud/ipc-contracts';

const MAX_CACHED_SESSIONS = 500;

interface SessionVisibility {
  isVisible(event: { readonly timestamp: string; readonly workspaceId?: string; readonly sessionId?: string }): boolean;
}

export class ActivitySessionCatalog {
  private readonly sessions = new Map<string, ActivitySessionSummary>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  public constructor(
    private readonly repository: Pick<AuditEventRepository, 'listActivitySessions'>,
    private readonly visibility: SessionVisibility,
  ) {}

  public record(event: { readonly timestamp: string; readonly workspaceId?: string; readonly sessionId?: string }): void {
    if (event.sessionId === undefined) return;
    this.merge({
      sessionId: event.sessionId,
      ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      startedAt: event.timestamp,
      lastActivityAt: event.timestamp,
    });
  }

  public async list(): Promise<readonly LogSessionSummary[]> {
    await this.ensureLoaded();
    return [...this.sessions.values()]
      .filter((session) => this.visibility.isVisible({
        timestamp: session.lastActivityAt,
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
        sessionId: session.sessionId,
      }))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt) || left.sessionId.localeCompare(right.sessionId))
      .map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId ?? null,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
      }));
  }

  /** Read older sessions on demand without expanding the resident session map. */
  public async page(offset: number, limit = 100): Promise<{ readonly sessions: readonly LogSessionSummary[]; readonly hasMore: boolean }> {
    const pageSize = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
    const pageOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const rows = await this.repository.listActivitySessions('mcp_tool:', pageSize + 1, pageOffset);
    return {
      sessions: rows.slice(0, pageSize).filter((session) => this.visibility.isVisible({
        timestamp: session.lastActivityAt,
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
        sessionId: session.sessionId,
      })).map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId ?? null,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
      })),
      hasMore: rows.length > pageSize,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== null) return this.loading;
    this.loading = this.repository.listActivitySessions('mcp_tool:', MAX_CACHED_SESSIONS).then((sessions) => {
      for (const session of sessions) this.merge(session);
      this.loaded = true;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private merge(session: ActivitySessionSummary): void {
    const key = `${session.sessionId}\0${session.workspaceId ?? ''}`;
    const existing = this.sessions.get(key);
    if (existing === undefined) {
      this.sessions.set(key, session);
      this.trim();
      return;
    }
    this.sessions.set(key, {
      sessionId: session.sessionId,
      ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
      startedAt: existing.startedAt <= session.startedAt ? existing.startedAt : session.startedAt,
      lastActivityAt: existing.lastActivityAt >= session.lastActivityAt ? existing.lastActivityAt : session.lastActivityAt,
    });
  }

  private trim(): void {
    if (this.sessions.size <= MAX_CACHED_SESSIONS) return;
    let oldestKey: string | null = null;
    let oldestTimestamp = '';
    for (const [key, session] of this.sessions) {
      if (oldestKey === null || session.lastActivityAt < oldestTimestamp) {
        oldestKey = key;
        oldestTimestamp = session.lastActivityAt;
      }
    }
    if (oldestKey !== null) this.sessions.delete(oldestKey);
  }
}
