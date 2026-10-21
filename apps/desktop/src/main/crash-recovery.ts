import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticText } from '@lnwjing/application';
import { DEFAULT_DISPLAY_TIME_ZONE, formatOffsetIsoTimestamp } from '@lnwjing/shared/date-time-display';

const MAX_CRASH_LOG_BYTES = 512 * 1024;
const RETAINED_CRASH_EVENTS = 128;
const MAX_EVENT_TEXT = 1_000;
const RECOVERY_WINDOW_MS = 5 * 60_000;
const MAX_RECOVERIES_PER_WINDOW = 3;

export type CrashEventType = 'main-uncaught-exception' | 'main-unhandled-rejection' | 'renderer-gone' | 'child-process-gone' | 'desktop-lifecycle' | 'desktop-startup';

export interface CrashEventInput {
  readonly type: CrashEventType;
  readonly processType?: string;
  readonly reason?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly error?: unknown;
}

export interface CrashEventRecord {
  readonly schemaVersion: 2;
  readonly timestamp: string;
  readonly timeZone: string;
  readonly appVersion: string;
  readonly type: CrashEventType;
  readonly pid: number;
  readonly memory: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
  };
  readonly processType?: string;
  readonly reason?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface CrashEventHistoryRecord {
  readonly schemaVersion: 1 | 2;
  readonly timestamp: string;
  readonly appVersion: string;
  readonly type: string;
  readonly timeZone?: string;
  readonly pid?: number;
  readonly memory?: CrashEventRecord['memory'];
  readonly processType?: string;
  readonly reason?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export class CrashDiagnosticsRecorder {
  public readonly filePath: string;

  public constructor(dataPath: string, private readonly appVersion: string) {
    this.filePath = path.join(path.resolve(dataPath), 'crashes', 'crash-events.ndjson');
  }

  public record(input: CrashEventInput): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const record = createCrashEventRecord(this.appVersion, input);
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this.compactIfNeeded();
    } catch (error: unknown) {
      console.error(`Crash diagnostics write failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private compactIfNeeded(): void {
    if (statSync(this.filePath).size <= MAX_CRASH_LOG_BYTES) return;
    const lines = readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const retained = lines.slice(-RETAINED_CRASH_EVENTS);
    writeFileSync(this.filePath, retained.length === 0 ? '' : `${retained.join('\n')}\n`, 'utf8');
  }
}

export function readCrashEventHistory(dataPath: string, maxEvents = 64): readonly CrashEventHistoryRecord[] {
  const limit = Math.max(0, Math.min(RETAINED_CRASH_EVENTS, Math.trunc(maxEvents)));
  if (limit === 0) return [];
  const filePath = path.join(path.resolve(dataPath), 'crashes', 'crash-events.ndjson');
  try {
    const size = statSync(filePath).size;
    const byteCount = Math.min(size, MAX_CRASH_LOG_BYTES);
    const buffer = Buffer.alloc(byteCount);
    const handle = openSync(filePath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(handle, buffer, 0, byteCount, Math.max(0, size - byteCount));
    } finally {
      closeSync(handle);
    }
    const records: CrashEventHistoryRecord[] = [];
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const record = normalizeCrashEventHistoryRecord(JSON.parse(line) as unknown);
        if (record !== null) records.push(record);
      } catch {
        // Ignore a partial/corrupt line and keep the remaining persisted evidence.
      }
    }
    return records.slice(-limit);
  } catch {
    return [];
  }
}

export class RendererRecoveryPolicy {
  private readonly attempts: number[] = [];

  public shouldRecover(reason: string, now: number = Date.now()): boolean {
    if (reason === 'clean-exit') return false;
    while (this.attempts.length > 0 && now - (this.attempts[0] ?? now) > RECOVERY_WINDOW_MS) this.attempts.shift();
    if (this.attempts.length >= MAX_RECOVERIES_PER_WINDOW) return false;
    this.attempts.push(now);
    return true;
  }
}

/** Prevents window-all-closed from terminating the desktop while a crashed renderer is being replaced. */
export class RendererRecoveryBarrier {
  private pending = 0;

  public begin(): () => void {
    this.pending += 1;
    let completed = false;
    return (): void => {
      if (completed) return;
      completed = true;
      this.pending = Math.max(0, this.pending - 1);
    };
  }

  public isPending(): boolean {
    return this.pending > 0;
  }

  public shouldQuitWhenWindowsClosed(platform: NodeJS.Platform): boolean {
    return platform !== 'darwin' && !this.isPending();
  }
}

export function createCrashEventRecord(appVersion: string, input: CrashEventInput, timestamp: string = formatOffsetIsoTimestamp(new Date(), DEFAULT_DISPLAY_TIME_ZONE)): CrashEventRecord {
  const memory = process.memoryUsage();
  const error = input.error instanceof Error
    ? { errorName: sanitizeCrashText(input.error.name), errorMessage: sanitizeCrashText(input.error.message) }
    : input.error === undefined
      ? {}
      : { errorName: 'UnknownError', errorMessage: sanitizeCrashText(String(input.error)) };
  return {
    schemaVersion: 2,
    timestamp,
    timeZone: DEFAULT_DISPLAY_TIME_ZONE,
    appVersion,
    type: input.type,
    pid: process.pid,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    ...(input.processType === undefined ? {} : { processType: sanitizeCrashText(input.processType) }),
    ...(input.reason === undefined ? {} : { reason: sanitizeCrashText(input.reason) }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: sanitizeCrashText(input.signal) }),
    ...error,
  };
}

function normalizeCrashEventHistoryRecord(value: unknown): CrashEventHistoryRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2)
    || typeof record.timestamp !== 'string'
    || typeof record.appVersion !== 'string'
    || typeof record.type !== 'string') return null;
  const memoryRecord = typeof record.memory === 'object' && record.memory !== null && !Array.isArray(record.memory)
    ? record.memory as Record<string, unknown>
    : null;
  const memory = memoryRecord !== null
    && typeof memoryRecord.rssBytes === 'number' && Number.isFinite(memoryRecord.rssBytes)
    && typeof memoryRecord.heapUsedBytes === 'number' && Number.isFinite(memoryRecord.heapUsedBytes)
    && typeof memoryRecord.externalBytes === 'number' && Number.isFinite(memoryRecord.externalBytes)
    && typeof memoryRecord.arrayBuffersBytes === 'number' && Number.isFinite(memoryRecord.arrayBuffersBytes)
    ? { rssBytes: memoryRecord.rssBytes, heapUsedBytes: memoryRecord.heapUsedBytes, externalBytes: memoryRecord.externalBytes, arrayBuffersBytes: memoryRecord.arrayBuffersBytes }
    : undefined;
  return {
    schemaVersion: record.schemaVersion,
    timestamp: record.timestamp,
    appVersion: record.appVersion,
    type: record.type,
    ...(typeof record.timeZone === 'string' ? { timeZone: record.timeZone } : {}),
    ...(typeof record.pid === 'number' && Number.isFinite(record.pid) ? { pid: record.pid } : {}),
    ...(memory === undefined ? {} : { memory }),
    ...(typeof record.processType === 'string' ? { processType: record.processType } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? { exitCode: record.exitCode } : {}),
    ...(typeof record.signal === 'string' ? { signal: record.signal } : {}),
    ...(typeof record.errorName === 'string' ? { errorName: record.errorName } : {}),
    ...(typeof record.errorMessage === 'string' ? { errorMessage: record.errorMessage } : {}),
  };
}

function sanitizeCrashText(value: string): string {
  let sanitized = redactDiagnosticText(value);
  const home = os.homedir();
  if (home.length > 2) sanitized = sanitized.replaceAll(home, '<USERPROFILE>');
  return sanitized.slice(0, MAX_EVENT_TEXT);
}
