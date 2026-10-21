import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readWindowsContainmentReceipt } from '@lnwjing/process';
import { appError, err, ok, type Result } from '@lnwjing/domain';

export type ActiveTaskInspection = 'active' | 'terminal' | 'missing' | 'unknown';

export type DurableMutationKind = 'opaque' | 'repository_import' | 'opaque_uncontained' | 'opaque_contained_process';

export interface DurableTaskReservation {
  readonly mutationKind?: DurableMutationKind;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly ownerClientId: string;
  readonly ownerWorkspaceId?: string;
  /** Trusted native proof path; never accepted from MCP caller input. */
  readonly nativeReceiptPath?: string;
  readonly launchRecord?: DurableTaskLaunchRecord;
}

export interface DurableTaskReservationResult {
  readonly activeTasks: number;
  readonly created: boolean;
  readonly markerPath: string;
}

export interface DurableTaskLaunchRecord {
  readonly version: 1;
  readonly taskId: string;
  readonly startedAt: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly ownerWorkspaceId?: string;
}

export interface DurableTaskLaunchPage {
  readonly records: readonly DurableTaskLaunchRecord[];
  readonly nextCursor?: string;
}

export interface DurableShellTaskIndexOptions {
  readonly maxConcurrentTasks: number;
  readonly inspectTask: (taskId: string) => Promise<ActiveTaskInspection>;
  readonly loadLaunchRecord?: (taskId: string) => Promise<DurableTaskLaunchRecord | undefined>;
  readonly now?: () => Date;
  readonly removeFile?: typeof rm;
}

export class DurableShellTaskIndex {
  private readonly indexDirectory: string;
  private readonly activeDirectory: string;
  private readonly readyPath: string;
  private readonly lockPath: string;
  private readonly launchesPath: string;
  private readonly maxConcurrentTasks: number;
  private readonly now: () => Date;
  private readonly removeFile: typeof rm;

  public constructor(
    private readonly rootDirectory: string,
    private readonly options: DurableShellTaskIndexOptions,
  ) {
    this.indexDirectory = path.join(rootDirectory, '.index', 'v1');
    this.activeDirectory = path.join(this.indexDirectory, 'active');
    this.readyPath = path.join(this.indexDirectory, 'ready.json');
    this.lockPath = path.join(this.indexDirectory, 'index.lock');
    this.launchesPath = path.join(this.indexDirectory, 'launches.jsonl');
    this.maxConcurrentTasks = normalizeMaximum(options.maxConcurrentTasks);
    this.now = options.now ?? ((): Date => new Date());
    this.removeFile = options.removeFile ?? rm;
  }

  public async initialize(): Promise<void> {
    await this.ensureDirectories();
    await this.withLock(async () => this.initializeUnlocked());
  }

  public async reserve(input: DurableTaskReservation): Promise<Result<DurableTaskReservationResult>> {
    if ((input.mutationKind !== undefined && input.mutationKind !== 'opaque' && input.mutationKind !== 'repository_import' && input.mutationKind !== 'opaque_uncontained' && input.mutationKind !== 'opaque_contained_process')
      || (input.mutationKind === 'opaque_contained_process' && (typeof input.nativeReceiptPath !== 'string' || !path.isAbsolute(input.nativeReceiptPath)))
      || !isSafeTaskId(input.taskId)
      || !/^[a-f0-9]{64}$/i.test(input.requestDigest)
      || (input.launchRecord !== undefined && (!isLaunchRecord(input.launchRecord) || input.launchRecord.taskId !== input.taskId))) {
      return err(appError('INVALID_INPUT', 'Durable task reservation identity is invalid'));
    }
    try {
      await this.ensureDirectories();
      return await this.withLock(async () => {
        await this.initializeUnlocked();
        await this.ensureJournalUnlocked();
        const markers = await this.readMarkers();
        let activeTasks = 0;
        for (const marker of markers) {
          if (marker.record?.taskId === input.taskId) {
            if (marker.record.requestDigest !== input.requestDigest || marker.record.mutationKind !== (input.mutationKind ?? 'opaque')
              || marker.record.ownerClientId !== input.ownerClientId
              || marker.record.ownerWorkspaceId !== input.ownerWorkspaceId) {
              return err(appError('CONFLICT', 'Durable task ID is already reserved for another request', true));
            }
            return ok({ activeTasks: activeTasks + 1, created: false, markerPath: marker.path });
          }
          if (marker.record === undefined) {
            return err(appError('CONFLICT', 'A managed writer reservation is unreadable; resolve its state before launching another writer', true));
          }
          if (marker.record.mutationKind === 'opaque_contained_process') {
            const native = marker.record.nativeReceiptPath === undefined
              ? undefined : await readWindowsContainmentReceipt(marker.record.nativeReceiptPath);
            if (native !== undefined) {
              await rm(marker.path, { force: true }).catch(() => undefined);
              continue;
            }
            if (input.mutationKind === 'repository_import') {
              return err(appError('CONFLICT', 'Unverified native process descendants block repository import', true));
            }
            activeTasks += 1;
            continue;
          }
          const inspection = await this.options.inspectTask(marker.record.taskId).catch(() => 'unknown' as const);
          if (inspection === 'terminal'
            || (inspection === 'missing' && this.isAbandonedReservation(marker.record))) {
            await rm(marker.path, { force: true }).catch(() => undefined);
            continue;
          }
          if (input.mutationKind === 'repository_import' || marker.record.mutationKind === 'repository_import') {
            return err(appError('CONFLICT', 'Repository import requires exclusive managed writer admission; a live or unresolved task holds it', true));
          }
          activeTasks += 1;
        }
        if (activeTasks >= this.maxConcurrentTasks) {
          return err(appError(
            'CONFLICT',
            `Too many durable background tasks are already running (${activeTasks}/${this.maxConcurrentTasks}); inspect or stop existing tasks before starting another.`,
            true,
          ));
        }
        const markerPath = this.markerPath(input.taskId);
        await atomicWriteJson(markerPath, {
          version: 1,
          taskId: input.taskId,
          requestDigest: input.requestDigest,
          mutationKind: input.mutationKind ?? 'opaque',
          ...(input.nativeReceiptPath === undefined ? {} : { nativeReceiptPath: input.nativeReceiptPath }),
          ownerClientId: input.ownerClientId,
          ...(input.ownerWorkspaceId === undefined ? {} : { ownerWorkspaceId: input.ownerWorkspaceId }),
          reservedAt: this.now().toISOString(),
          launcherPid: process.pid,
          launcherStartedAt: currentProcessStartedAt(),
        });
        if (input.launchRecord !== undefined) {
          try {
            await appendFile(this.launchesPath, `${JSON.stringify(input.launchRecord)}\n`, 'utf8');
          } catch (error: unknown) {
            await rm(markerPath, { force: true }).catch(() => undefined);
            throw error;
          }
        }
        return ok({ activeTasks: activeTasks + 1, created: true, markerPath });
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Durable task capacity could not be reserved', true));
    }
  }

  public async release(taskId: string, requestDigest: string | null): Promise<void> {
    if (!isSafeTaskId(taskId) || (requestDigest !== null && !/^[a-f0-9]{64}$/i.test(requestDigest))) return;
    await this.ensureDirectories();
    await this.withLock(async () => {
      const markerPath = this.markerPath(taskId);
      const marker = await readMarker(markerPath);
      if (marker?.taskId !== taskId || marker.requestDigest !== requestDigest) return;
      await rm(markerPath, { force: true });
    }).catch(() => undefined);
  }

  public async hasReservation(taskId: string, requestDigest: string): Promise<boolean> {
    if (!isSafeTaskId(taskId) || !/^[a-f0-9]{64}$/i.test(requestDigest)) return false;
    const marker = await readMarker(this.markerPath(taskId));
    return marker?.taskId === taskId && marker.requestDigest === requestDigest;
  }

  public async listLaunches(options: {
    readonly limit: number;
    readonly cursor?: string;
    readonly accept?: (record: DurableTaskLaunchRecord) => boolean;
  }): Promise<Result<DurableTaskLaunchPage>> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_PAGE_SIZE) {
      return err(appError('INVALID_INPUT', `Durable task list limit must be between 1 and ${MAX_PAGE_SIZE}`));
    }
    try {
      await this.ensureDirectories();
      return await this.withLock(async () => {
        await this.initializeUnlocked();
        await this.ensureJournalUnlocked();
        try {
          return ok(await this.readLaunchPage(options));
        } catch (error: unknown) {
          if (error instanceof CorruptJournalError) await this.rebuildJournalUnlocked();
          throw error;
        }
      });
    } catch (error: unknown) {
      if (error instanceof InvalidCursorError) return err(appError('INVALID_INPUT', error.message));
      if (error instanceof CorruptJournalError) {
        return err(appError('INTERNAL_ERROR', 'Durable task launch journal is corrupt; retry after rebuild', true));
      }
      return err(appError('INTERNAL_ERROR', 'Durable task launch journal could not be read', true));
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await mkdir(this.activeDirectory, { recursive: true });
  }

  private async initializeUnlocked(): Promise<void> {
    if (await isReady(this.readyPath)) return;
    await mkdir(this.activeDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.index') continue;
      const inspection = await this.options.inspectTask(entry.name).catch(() => 'unknown' as const);
      if (inspection !== 'active' && inspection !== 'unknown') continue;
      const markerPath = this.markerPath(entry.name);
      if (await readMarker(markerPath) !== undefined) continue;
      await atomicWriteJson(markerPath, {
        version: 1,
        taskId: entry.name,
        requestDigest: null,
        reservedAt: this.now().toISOString(),
        legacy: true,
      });
    }
    await this.rebuildJournalUnlocked(entries.filter((entry) => entry.isDirectory() && entry.name !== '.index').map((entry) => entry.name));
    await rm(this.readyPath, { force: true }).catch(() => undefined);
    await atomicWriteJson(this.readyPath, {
      version: 1,
      readyAt: this.now().toISOString(),
    });
  }

  private async ensureJournalUnlocked(): Promise<void> {
    try {
      if (!(await stat(this.launchesPath)).isFile()) throw new Error('Launch journal is not a file');
    } catch {
      await this.rebuildJournalUnlocked();
    }
  }

  private async rebuildJournalUnlocked(taskIds?: readonly string[]): Promise<void> {
    const launchRecords: DurableTaskLaunchRecord[] = [];
    if (this.options.loadLaunchRecord !== undefined) {
      const ids = taskIds ?? (await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && entry.name !== '.index')
        .map((entry) => entry.name);
      for (const taskId of ids) {
        const record = await this.options.loadLaunchRecord(taskId).catch(() => undefined);
        if (record !== undefined && isLaunchRecord(record)) launchRecords.push(record);
      }
    }
    launchRecords.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.taskId.localeCompare(right.taskId));
    const contents = launchRecords.map((record) => JSON.stringify(record)).join('\n');
    await atomicWriteText(this.launchesPath, contents.length === 0 ? '' : `${contents}\n`);
  }

  private async readLaunchPage(options: {
    readonly limit: number;
    readonly cursor?: string;
    readonly accept?: (record: DurableTaskLaunchRecord) => boolean;
  }): Promise<DurableTaskLaunchPage> {
    const fileSize = (await stat(this.launchesPath)).size;
    const endOffset = options.cursor === undefined ? fileSize : decodeCursor(options.cursor);
    if (endOffset < 0 || endOffset > fileSize) throw new InvalidCursorError('Durable task list cursor is out of range');
    const handle = await open(this.launchesPath, 'r');
    try {
      if (endOffset > 0) {
        const boundary = Buffer.allocUnsafe(1);
        await handle.read(boundary, 0, 1, endOffset - 1);
        if (boundary[0] !== 0x0a) throw new InvalidCursorError('Durable task list cursor is not on a record boundary');
      }
      const records: DurableTaskLaunchRecord[] = [];
      let position = endOffset;
      let carry = Buffer.alloc(0);
      while (position > 0) {
        const chunkStart = Math.max(0, position - JOURNAL_READ_CHUNK_BYTES);
        const chunk = Buffer.allocUnsafe(position - chunkStart);
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, chunkStart);
        const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
        if (combined.byteLength > MAX_JOURNAL_LINE_BYTES + JOURNAL_READ_CHUNK_BYTES) throw new CorruptJournalError();
        let lineEnd = combined.byteLength;
        if (lineEnd > 0 && combined[lineEnd - 1] === 0x0a) lineEnd -= 1;
        while (lineEnd > 0) {
          const previousNewline = combined.lastIndexOf(0x0a, lineEnd - 1);
          if (previousNewline < 0 && chunkStart > 0) break;
          const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
          const absoluteLineStart = chunkStart + lineStart;
          const line = combined.subarray(lineStart, lineEnd).toString('utf8').trimEnd();
          if (line.length > 0) {
            const record = parseLaunchRecord(line);
            if (record === undefined) throw new CorruptJournalError();
            if (options.accept?.(record) !== false) {
              records.push(record);
              if (records.length === options.limit) {
                return {
                  records,
                  ...(absoluteLineStart > 0 ? { nextCursor: encodeCursor(absoluteLineStart) } : {}),
                };
              }
            }
          }
          lineEnd = previousNewline < 0 ? 0 : previousNewline;
        }
        carry = combined.subarray(0, lineEnd);
        position = chunkStart;
      }
      if (carry.byteLength > 0) throw new CorruptJournalError();
      return { records };
    } finally {
      await handle.close();
    }
  }

  private async readMarkers(): Promise<readonly MarkerRead[]> {
    const entries = await readdir(this.activeDirectory, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const markerPath = path.join(this.activeDirectory, entry.name);
        const record = await readMarker(markerPath);
        return record === undefined
          ? { path: markerPath }
          : { path: markerPath, record };
      }));
  }

  private markerPath(taskId: string): string {
    const filename = `${createHash('sha256').update(taskId).digest('hex')}.json`;
    return path.join(this.activeDirectory, filename);
  }

  private isAbandonedReservation(marker: MarkerRecord): boolean {
    if (marker.mutationKind === 'opaque_uncontained' || marker.mutationKind === 'opaque_contained_process' || marker.mutationKind === 'repository_import'
      || marker.legacy === true
      || marker.launcherPid === undefined
      || marker.launcherStartedAt === undefined
      || marker.reservedAt === undefined) return false;
    const reservedAt = Date.parse(marker.reservedAt);
    if (!Number.isFinite(reservedAt) || this.now().getTime() - reservedAt < RESERVATION_RECLAIM_GRACE_MS) return false;
    return isProcessProvenGone(marker.launcherPid);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({
            version: 1,
            pid: process.pid,
            processStartedAt: currentProcessStartedAt(),
            acquiredAt: this.now().toISOString(),
          }), 'utf8');
          return await operation();
        } finally {
          await handle.close();
          await this.releaseLockFile();
        }
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
        await this.reclaimStaleLock();
        if (Date.now() >= deadline) throw new Error('Durable task index lock is busy');
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async releaseLockFile(): Promise<void> {
    const deadline = Date.now() + LOCK_RELEASE_TIMEOUT_MS;
    for (;;) {
      try {
        await this.removeFile(this.lockPath, { force: true });
        return;
      } catch (error: unknown) {
        if (!isTransientLockReleaseError(error) || Date.now() >= deadline) throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async reclaimStaleLock(): Promise<void> {
    const lock = await readJson(this.lockPath);
    if (!isLockRecord(lock)) return;
    if (this.now().getTime() - Date.parse(lock.acquiredAt) < LOCK_STALE_MS) return;
    if (!isProcessProvenGone(lock.pid)) return;
    const quarantine = `${this.lockPath}.stale-${randomUUID()}`;
    try {
      await rename(this.lockPath, quarantine);
      await rm(quarantine, { force: true });
    } catch {
      // Another contender or the owner changed the lock; retry the fixed path.
    }
  }
}

interface MarkerRecord {
  readonly version: 1;
  readonly taskId: string;
  readonly requestDigest: string | null;
  readonly mutationKind: DurableMutationKind;
  readonly ownerClientId?: string;
  readonly ownerWorkspaceId?: string;
  readonly nativeReceiptPath?: string;
  readonly reservedAt?: string;
  readonly launcherPid?: number;
  readonly launcherStartedAt?: string;
  readonly legacy?: boolean;
}

interface MarkerRead {
  readonly path: string;
  readonly record?: MarkerRecord;
}

const LOCK_RETRY_MS = 15;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RELEASE_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const RESERVATION_RECLAIM_GRACE_MS = 30_000;
const MAX_PAGE_SIZE = 200;
const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JOURNAL_LINE_BYTES = 16 * 1024;
const CURSOR_PREFIX = 'lnwjing-durable-shell-v1:';

class InvalidCursorError extends Error {}
class CorruptJournalError extends Error {}

function normalizeMaximum(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function isSafeTaskId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('\0') && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

async function isReady(filename: string): Promise<boolean> {
  const value = await readJson(filename);
  return isRecord(value) && value.version === 1 && typeof value.readyAt === 'string' && Number.isFinite(Date.parse(value.readyAt));
}

async function readMarker(filename: string): Promise<MarkerRecord | undefined> {
  const value = await readJson(filename);
  if (!isRecord(value) || value.version !== 1 || typeof value.taskId !== 'string') return undefined;
  if (value.mutationKind !== undefined && value.mutationKind !== 'opaque' && value.mutationKind !== 'repository_import' && value.mutationKind !== 'opaque_uncontained' && value.mutationKind !== 'opaque_contained_process') return undefined;
  if (value.requestDigest !== null && (typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(value.requestDigest))) return undefined;
  return {
    version: 1,
    taskId: value.taskId,
    requestDigest: value.requestDigest,
    mutationKind: value.mutationKind === 'repository_import' ? 'repository_import' : value.mutationKind === 'opaque_uncontained' ? 'opaque_uncontained' : value.mutationKind === 'opaque_contained_process' ? 'opaque_contained_process' : 'opaque',
    ...(typeof value.ownerClientId === 'string' ? { ownerClientId: value.ownerClientId } : {}),
    ...(typeof value.ownerWorkspaceId === 'string' ? { ownerWorkspaceId: value.ownerWorkspaceId } : {}),
    ...(typeof value.nativeReceiptPath === 'string' && path.isAbsolute(value.nativeReceiptPath) ? { nativeReceiptPath: value.nativeReceiptPath } : {}),
    ...(typeof value.reservedAt === 'string' ? { reservedAt: value.reservedAt } : {}),
    ...(Number.isInteger(value.launcherPid) ? { launcherPid: Number(value.launcherPid) } : {}),
    ...(typeof value.launcherStartedAt === 'string' ? { launcherStartedAt: value.launcherStartedAt } : {}),
    ...(value.legacy === true ? { legacy: true } : {}),
  };
}

async function readJson(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, filename);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteText(filename: string, value: string): Promise<void> {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
  try {
    await rm(filename, { force: true });
    await rename(temporary, filename);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isLaunchRecord(value: unknown): value is DurableTaskLaunchRecord {
  if (!isRecord(value)) return false;
  return value.version === 1
    && isSafeTaskId(typeof value.taskId === 'string' ? value.taskId : '')
    && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt))
    && typeof value.ownerClientId === 'string'
    && value.ownerClientId.length > 0
    && typeof value.ownerSessionId === 'string'
    && value.ownerSessionId.length > 0
    && (value.ownerWorkspaceId === undefined || typeof value.ownerWorkspaceId === 'string');
}

function parseLaunchRecord(value: string): DurableTaskLaunchRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isLaunchRecord(parsed)) return undefined;
    return {
      version: 1,
      taskId: parsed.taskId,
      startedAt: new Date(parsed.startedAt).toISOString(),
      ownerClientId: parsed.ownerClientId,
      ownerSessionId: parsed.ownerSessionId,
      ...(parsed.ownerWorkspaceId === undefined ? {} : { ownerWorkspaceId: parsed.ownerWorkspaceId }),
    };
  } catch {
    return undefined;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.startsWith(CURSOR_PREFIX)) throw new InvalidCursorError('Durable task list cursor is invalid');
    const rawOffset = decoded.slice(CURSOR_PREFIX.length);
    if (!/^\d+$/.test(rawOffset)) throw new InvalidCursorError('Durable task list cursor is invalid');
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset)) throw new InvalidCursorError('Durable task list cursor is invalid');
    return offset;
  } catch (error: unknown) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError('Durable task list cursor is invalid');
  }
}

function currentProcessStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

function isProcessProvenGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return isRecord(error) && error.code === 'ESRCH';
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isTransientLockReleaseError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES');
}

function isLockRecord(value: unknown): value is { readonly pid: number; readonly acquiredAt: string } {
  return isRecord(value)
    && Number.isInteger(value.pid)
    && typeof value.acquiredAt === 'string'
    && Number.isFinite(Date.parse(value.acquiredAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
