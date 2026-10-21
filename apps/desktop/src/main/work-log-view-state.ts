import type { AuditEvent } from '@lnwjing/audit';

const LOG_VIEW_STATE_KEY = 'internal.log_view.work_log_clear_state.v1';
const LEGACY_GLOBAL_CLEAR_KEY = 'work_log_cleared_at';
const STARTUP_CLEAR_MIGRATION_KEY = 'internal.log_view.work_log_startup_clear_migrated.v1';
const AUTOMATIC_STARTUP_CLEAR_WINDOW_MS = 2 * 60 * 1000;

export interface WorkLogClearScope {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

interface StringStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

interface WorkLogClearState {
  readonly version: 1;
  readonly all: string | null;
  readonly workspaces: Readonly<Record<string, string>>;
  readonly sessions: Readonly<Record<string, string>>;
}

const EMPTY_STATE: WorkLogClearState = { version: 1, all: null, workspaces: {}, sessions: {} };

export class WorkLogViewState {
  public constructor(private readonly store: StringStateStore) {}

  public clear(scope: WorkLogClearScope, timestamp = new Date().toISOString()): void {
    const current = this.read();
    const next: WorkLogClearState = scope.sessionId !== undefined
      ? { ...current, sessions: { ...current.sessions, [scope.sessionId]: timestamp } }
      : scope.workspaceId !== undefined
        ? { ...current, workspaces: { ...current.workspaces, [scope.workspaceId]: timestamp } }
        : { ...current, all: timestamp };
    this.store.set(LOG_VIEW_STATE_KEY, JSON.stringify(next));
  }

  public migrateAutomaticStartupClear(previousSessionStartedAt: string): boolean {
    if (this.store.get(STARTUP_CLEAR_MIGRATION_KEY) === '1') return false;
    const state = parseState(this.store.get(LOG_VIEW_STATE_KEY));
    const previousStartedAt = validTimestamp(previousSessionStartedAt);
    const clearTimestamp = validTimestamp(state.all);
    let migrated = false;
    if (previousStartedAt !== null && clearTimestamp !== null) {
      const deltaMs = Date.parse(clearTimestamp) - Date.parse(previousStartedAt);
      if (deltaMs >= 0 && deltaMs <= AUTOMATIC_STARTUP_CLEAR_WINDOW_MS) {
        this.store.set(LOG_VIEW_STATE_KEY, JSON.stringify({ ...state, all: null } satisfies WorkLogClearState));
        migrated = true;
      }
    }
    this.store.set(STARTUP_CLEAR_MIGRATION_KEY, '1');
    return migrated;
  }

  public isVisible(event: Pick<AuditEvent, 'timestamp' | 'workspaceId' | 'sessionId'>): boolean {
    const state = this.read();
    let clearedAt = state.all;
    if (event.workspaceId !== undefined) clearedAt = latestTimestamp(clearedAt, state.workspaces[event.workspaceId] ?? null);
    if (event.sessionId !== undefined) clearedAt = latestTimestamp(clearedAt, state.sessions[event.sessionId] ?? null);
    return clearedAt === null || event.timestamp > clearedAt;
  }

  public read(): WorkLogClearState {
    const persisted = parseState(this.store.get(LOG_VIEW_STATE_KEY));
    const legacy = validTimestamp(this.store.get(LEGACY_GLOBAL_CLEAR_KEY));
    if (legacy === null) return persisted;
    return { ...persisted, all: latestTimestamp(persisted.all, legacy) };
  }
}

function parseState(raw: string | null): WorkLogClearState {
  if (raw === null) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1) return EMPTY_STATE;
    return {
      version: 1,
      all: validTimestamp(value.all),
      workspaces: readTimestampMap(value.workspaces),
      sessions: readTimestampMap(value.sessions),
    };
  } catch {
    return EMPTY_STATE;
  }
}

function readTimestampMap(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const timestamp = validTimestamp(candidate);
    if (key.length > 0 && timestamp !== null) result[key] = timestamp;
  }
  return result;
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
