import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { decodeActivityTargetReference, Redactor } from '@lnwjud/audit';
import type { ActivitySink, ActivitySinkEvent } from './activity-tracker.js';

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
    ...(event.targetSummary === undefined ? {} : { targetSummary: redactor.redactText(event.targetSummary) }),
    targetDetail: decodeActivityTargetReference(event.targetDetail, event.targetSummary),
    ...(event.resultMessage === undefined ? {} : { resultMessage: redactor.redactText(event.resultMessage) }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
  })}\n`;
}

const MAX_ACTIVITY_LOG_BYTES = 16 * 1024 * 1024;
const ROTATED_ACTIVITY_LOGS = 3;
const ACTIVITY_LOCK_TIMEOUT_MS = 10_000;

/** SQLite's OS locks release on process exit; every writer must hold one across rotation and append. */
export function createFileActivitySink(filePath: string, options: { readonly maxBytes?: number } = {}): ActivitySink {
  const maxBytes = options.maxBytes !== undefined && Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 256
    ? options.maxBytes : MAX_ACTIVITY_LOG_BYTES;
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      const line = formatActivityLogLine(event);
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
        // No await while holding the lock: all writers serialize against the same log path.
        let size = 0;
        try {
          size = statSync(filePath).size;
        } catch (error: unknown) {
          if (!isMissingFile(error)) throw error;
        }
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          rmSync(`${filePath}.${ROTATED_ACTIVITY_LOGS}`, { force: true });
          for (let index = ROTATED_ACTIVITY_LOGS - 1; index >= 1; index -= 1) {
            try {
              renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
            } catch (error: unknown) {
              if (!isMissingFile(error)) throw error;
            }
          }
          renameSync(filePath, `${filePath}.1`);
        }
        appendFileSync(filePath, line, 'utf8');
      } finally {
        try {
          if (locked) mutex.exec('ROLLBACK');
        } finally {
          mutex.close();
        }
      }
    },
  };
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
