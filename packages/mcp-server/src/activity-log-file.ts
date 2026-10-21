import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { decodeActivityTargetReference, Redactor } from '@lnwjud/audit';
import type { ActivitySink, ActivitySinkEvent } from './activity-tracker.js';

const MAX_ACTIVITY_LOG_FIELD_CHARS = 4_096;

export function mcpActivityLogPath(dataPath: string): string {
  return path.join(dataPath, 'mcp-activity.log');
}

export function formatActivityLogLine(event: ActivitySinkEvent): string {
  const redactor = new Redactor();
  return `${JSON.stringify({
    callId: event.callId,
    toolName: event.toolName,
    phase: event.phase,
    resultCode: event.resultCode,
    durationMs: event.durationMs,
    timestamp: event.timestamp,
    ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.targetSummary === undefined ? {} : { targetSummary: redactor.redactText(event.targetSummary).slice(0, MAX_ACTIVITY_LOG_FIELD_CHARS) }),
    targetDetail: decodeActivityTargetReference(event.targetDetail, event.targetSummary),
    ...(event.resultMessage === undefined ? {} : { resultMessage: redactor.redactText(event.resultMessage).slice(0, MAX_ACTIVITY_LOG_FIELD_CHARS) }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
  })}\n`;
}

const MAX_ACTIVITY_LOG_BYTES = 16 * 1024 * 1024;
const ROTATED_ACTIVITY_LOGS = 3;
const ACTIVITY_LOCK_TIMEOUT_MS = 10_000;

/** SQLite's OS locks release on process exit; every writer must hold one across rotation and append. */
const MAX_ACTIVITY_BATCH_EVENTS = 128;

export function createFileActivitySink(filePath: string, options: { readonly maxBytes?: number } = {}): ActivitySink {
  const maxBytes = options.maxBytes !== undefined && Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 256
    ? options.maxBytes : MAX_ACTIVITY_LOG_BYTES;
  const pending: Array<{ readonly line: string; readonly resolve: () => void; readonly reject: (reason: unknown) => void }> = [];
  let scheduled = false;
  let draining = false;

  const schedule = (): void => {
    if (scheduled || draining) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; void drain(); });
  };
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const batch = pending.splice(0, MAX_ACTIVITY_BATCH_EVENTS);
        try {
          await appendActivityBatch(filePath, maxBytes, batch.map((item) => item.line));
          for (const item of batch) item.resolve();
        } catch (error: unknown) {
          for (const item of batch) item.reject(error);
        }
        if (pending.length > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      draining = false;
      if (pending.length > 0) schedule();
    }
  };
  return {
    record(event: ActivitySinkEvent): Promise<void> {
      let line: string;
      try { line = formatActivityLogLine(event); } catch (error: unknown) { return Promise.reject(error); }
      return new Promise<void>((resolve, reject) => {
        pending.push({ line, resolve, reject });
        schedule();
      });
    },
  };
}

async function appendActivityBatch(filePath: string, maxBytes: number, lines: readonly string[]): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const mutex = new DatabaseSync(`${filePath}.lock.sqlite`, { timeout: 0 });
  let locked = false;
  try {
    const deadline = Date.now() + ACTIVITY_LOCK_TIMEOUT_MS;
    while (!locked) {
      try {
        mutex.exec('BEGIN IMMEDIATE');
        locked = true;
      } catch (error: unknown) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await delay(20);
      }
    }
    // One lock and as few synchronous writes as possible per batch.
    let size = 0;
    try { size = statSync(filePath).size; } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
    }
    let chunk: string[] = [];
    const flush = (): void => {
      if (chunk.length === 0) return;
      appendFileSync(filePath, chunk.join(''), 'utf8');
      chunk = [];
    };
    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        flush();
        // Trim oversized legacy logs to complete NDJSON records before archiving.
        const temporaryTail = size > maxBytes ? `${filePath}.${randomUUID()}.tail.tmp` : null;
        try {
          if (temporaryTail !== null) writeFileSync(temporaryTail, readArchiveTail(filePath, size, maxBytes), { flag: 'wx' });
          rmSync(`${filePath}.${ROTATED_ACTIVITY_LOGS}`, { force: true });
          for (let index = ROTATED_ACTIVITY_LOGS - 1; index >= 1; index -= 1) {
            try {
              renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
            } catch (error: unknown) {
              if (!isMissingFile(error)) throw error;
            }
          }
          renameSync(filePath, `${filePath}.1`);
          if (temporaryTail !== null) renameSync(temporaryTail, `${filePath}.1`);
        } finally {
          if (temporaryTail !== null) rmSync(temporaryTail, { force: true });
        }
        size = 0;
      }
      chunk.push(line);
      size += bytes;
    }
    flush();
  } finally {
    try {
      if (locked) mutex.exec('ROLLBACK');
    } finally {
      mutex.close();
    }
  }
}

function readArchiveTail(filePath: string, size: number, maxBytes: number): Buffer {
  const bytes = Buffer.allocUnsafe(maxBytes);
  const fd = openSync(filePath, 'r');
  let total = 0;
  try {
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, size - maxBytes + total);
      if (count === 0) break;
      total += count;
    }
  } finally {
    closeSync(fd);
  }
  const tail = bytes.subarray(0, total);
  const firstNewline = tail.indexOf(10);
  const lastNewline = tail.lastIndexOf(10);
  return firstNewline < 0 || lastNewline <= firstNewline
    ? Buffer.alloc(0) : tail.subarray(firstNewline + 1, lastNewline + 1);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error
    && typeof error.errcode === 'number' && (error.errcode & 0xff) === 5;
}

export function composeActivitySinks(sinks: readonly ActivitySink[]): ActivitySink {
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      const errors: unknown[] = [];
      for (const sink of sinks) {
        try {
          await sink.record(event);
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
