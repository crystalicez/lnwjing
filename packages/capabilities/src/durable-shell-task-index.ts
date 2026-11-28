import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readWindowsContainmentReceipt } from '@lnwjing/process';
import { appError, err, ok, type Result } from '@lnwjing/domain';

export type ActiveTaskInspection = 'active' | 'terminal' | 'missing' | 'unknown';

export type DurableMutationKind = 'opaque' | 'repository_import' | 'opaque_uncontained' | 'opaque_contained_process' | 'workspace_lifecycle';

export type ReservationKind = 'durable_shell' | 'managed_writer';

export interface DurableTaskReservation {
  readonly reservationKind?: ReservationKind;
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

export interface ReservationDiagnosticRow {
  readonly taskId: string;
  readonly kind: ReservationKind | 'unknown';
  readonly workspaceId?: string;
  readonly ownerClientId?: string;
  readonly reservedAt?: string;
}

export interface ReservationDiagnostics {
  readonly limit: number;
  readonly total: number;
  readonly unreadable: number;
  readonly shell: number;
  readonly managed: number;
  readonly unknown: number;
  readonly rows: readonly ReservationDiagnosticRow[];
}

export interface DurableTaskLaunchPage {
  readonly records: readonly DurableTaskLaunchRecord[];
  readonly nextCursor?: string;
}

export interface DurableShellTaskIndexOptions {
  readonly maxConcurrentTasks: number;
  readonly capacityScope?: 'all' | 'durable_shell';
  /** Read inside the shared reservation lock so live settings apply to each admission. */
  readonly maxConcurrentTasksProvider?: () => number;
  readonly inspectTask: (taskId: string) => Promise<ActiveTaskInspection>;
  readonly loadLaunchRecord?: (taskId: string) => Promise<DurableTaskLaunchRecord | undefined>;
  readonly inspectBootstrapTask?: (taskId: string) => Promise<{ readonly inspection: ActiveTaskInspection; readonly record?: DurableTaskLaunchRecord }>;
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
    if ((input.mutationKind !== undefined && input.mutationKind !== 'opaque' && input.mutationKind !== 'repository_import' && input.mutationKind !== 'opaque_uncontained' && input.mutationKind !== 'opaque_contained_process' && input.mutationKind !== 'workspace_lifecycle')
      || (input.mutationKind === 'workspace_lifecycle' && !input.ownerWorkspaceId)
      || (input.mutationKind === 'opaque_contained_process' && (typeof input.nativeReceiptPath !== 'string' || !path.isAbsolute(input.nativeReceiptPath)))
      || !isSafeTaskId(input.taskId)
      || !/^[a-f0-9]{64}$/i.test(input.requestDigest)
      || (input.launchRecord !== undefined && (!isLaunchRecord(input.launchRecord) || input.launchRecord.taskId !== input.taskId))) {
      return err(appError('INVALID_INPUT', 'Durable task reservation identity is invalid'));
    }
    try {
      await this.ensureDirectories();
      // The normal path only counts recorded reservations. Process inspection
      // can involve WMI, filesystem recovery and a terminal-receipt grace wait;
      // never hold the shared index lock across those operations.
      const attempt = await this.withLock(() => this.reserveUnlocked(input));
      if ('result' in attempt) return attempt.result;
      const observations = new Map<string, MarkerObservation>();
      for (const probe of attempt.probes) {
        const record = probe.record;
        const inspection = record.mutationKind === 'opaque_contained_process'
          ? (record.nativeReceiptPath !== undefined && await readWindowsContainmentReceipt(record.nativeReceiptPath) !== undefined ? 'terminal' : 'unknown')
          : await this.options.inspectTask(record.taskId).catch(() => 'unknown' as const);
        observations.set(probe.path, {
          identity: probe.identity,
          inspection,
          abandoned: inspection === 'missing' && this.isAbandonedReservation(record),
        });
      }
      // New reservations may have appeared while probes ran. Recount under
      // lock; never discard a replacement marker using stale liveness evidence.
      const checked = await this.withLock(() => this.reserveUnlocked(input, observations));
      if ('result' in checked) return checked.result;
      throw new Error('Unexpected repeated reservation inspection');
    } catch (error: unknown) {
      if (error instanceof DurableIndexBusyError) return err(indexBusyError());
      return err(appError('INTERNAL_ERROR', 'Durable task capacity could not be reserved', true));
    }
  }

  private async reserveUnlocked(
    input: DurableTaskReservation,
    observations?: ReadonlyMap<string, MarkerObservation>,
  ): Promise<ReservationAttempt> {
    await this.initializeUnlocked();
    await this.ensureJournalUnlocked();
    const markers = await this.readMarkers();
    let activeTasks = 0;
    let otherReservations = 0;
    let unresolvedTasks = 0;
    let barrierConflict: string | undefined;
    const blockers: MarkerRead[] = [];
    const counted: MarkerRead[] = [];
    for (const marker of markers) {
      const record = marker.record;
      if (record === undefined) {
        return { result: err(appError('CONFLICT', 'A managed writer reservation is unreadable; resolve its state before launching another writer', true)) };
      }
      if (record.taskId === input.taskId) {
        if (record.requestDigest !== input.requestDigest || record.mutationKind !== (input.mutationKind ?? 'opaque')
          || (record.reservationKind !== undefined && record.reservationKind !== (input.reservationKind ?? 'durable_shell'))
          || record.ownerClientId !== input.ownerClientId || record.ownerWorkspaceId !== input.ownerWorkspaceId) {
          return { result: err(appError('CONFLICT', 'Durable task ID is already reserved for another request', true)) };
        }
        return { result: ok({ activeTasks: activeTasks + 1, created: false, markerPath: marker.path }) };
      }
      const observation = observations?.get(marker.path);
      const verified = observation !== undefined && observation.identity === await markerIdentity(marker) ? observation : undefined;
      if (verified?.inspection === 'terminal' || verified?.abandoned === true) {
        try {
          await rm(marker.path, { force: true });
          continue;
        } catch {
          // A failed cleanup must continue counting against capacity/fences.
        }
      }
      const inspection = verified?.inspection ?? 'unknown';
      const lifecycleConflict = (input.mutationKind === 'workspace_lifecycle' || record.mutationKind === 'workspace_lifecycle')
        && (input.ownerWorkspaceId === undefined || record.ownerWorkspaceId === undefined || input.ownerWorkspaceId === record.ownerWorkspaceId);
      if (lifecycleConflict || input.mutationKind === 'repository_import' || record.mutationKind === 'repository_import') {
        blockers.push(marker);
        barrierConflict ??= lifecycleConflict
          ? 'Workspace lifecycle change conflicts with a live or unresolved managed writer'
          : 'Repository import requires exclusive managed writer admission; a live or unresolved task holds it';
      }
      const managedWriter = record.reservationKind === 'managed_writer'
        || (record.reservationKind === undefined && (record.mutationKind === 'opaque_contained_process'
          || record.mutationKind === 'opaque_uncontained' || record.mutationKind === 'workspace_lifecycle'
          || (inspection === 'missing' && !record.legacy && LEGACY_MANAGED_WRITER_ID.test(record.taskId))));
      if (this.options.capacityScope === 'durable_shell' && managedWriter) otherReservations += 1;
      else {
        counted.push(marker);
        activeTasks += 1;
        if (inspection !== 'active') unresolvedTasks += 1;
      }
    }
    const maximum = this.options.maxConcurrentTasksProvider?.() ?? this.maxConcurrentTasks;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid managed task capacity');
    if (barrierConflict !== undefined || activeTasks >= maximum) {
      if (observations === undefined) {
        // Probe only actual blockers or reservations contributing to a full
        // capacity pool. Unrelated tasks must not delay ordinary admissions.
        const candidates = new Set([...blockers, ...(activeTasks >= maximum ? counted : [])]);
        const probes: MarkerProbe[] = [];
        for (const marker of candidates) {
          const identity = await markerIdentity(marker);
          if (identity !== undefined && marker.record !== undefined) probes.push({ path: marker.path, record: marker.record, identity });
        }
        if (probes.length > 0) return { probes };
      }
      if (barrierConflict !== undefined) return { result: err(appError('CONFLICT', barrierConflict, true)) };
      return { result: err({ ...appError(
        'CONFLICT',
        `Durable task capacity exhausted (${activeTasks}/${maximum}; ${unresolvedTasks} unresolved, ${otherReservations} other managed reservations). Wait for completion or inspect an owned task before requesting cancellation.`,
        true,
      ), ...(this.options.capacityScope === 'durable_shell' ? { details: {
        reason: 'durable_shell_capacity', active: activeTasks, limit: maximum, unresolved: unresolvedTasks, otherReservations,
      } } : {}) }) };
    }
    const markerPath = this.markerPath(input.taskId);
    await atomicWriteJson(markerPath, {
      version: 1,
      reservationId: randomUUID(),
      taskId: input.taskId,
      requestDigest: input.requestDigest,
      reservationKind: input.reservationKind ?? 'durable_shell',
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
    return { result: ok({ activeTasks: activeTasks + 1, created: true, markerPath }) };
  }

  public async release(taskId: string, requestDigest: string | null): Promise<void> {
    if (!isSafeTaskId(taskId) || (requestDigest !== null && !/^[a-f0-9]{64}$/i.test(requestDigest))) return;
    const markerPath = this.markerPath(taskId);
    const observed = await readMarker(markerPath);
    // Terminal reads normally arrive after the worker released its marker.
    // Avoid creating a lock file for an already released reservation.
    if (observed?.taskId !== taskId || observed.requestDigest !== requestDigest) return;
    await this.ensureDirectories();
    await this.withLock(async () => {
      // Recheck under the lock; a stale observation must never remove another reservation.
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

  /** Host-only activity projection: inspect reservation markers, never scan task history. */
  public async listActiveTaskIds(): Promise<readonly string[]> {
    // First use may precede any shell launch. Bootstrap rather than reporting
    // an unreadable index as an empty activity set.
    if (!(await isReady(this.readyPath))) await this.initialize();
    const markers = await this.readMarkers();
    if (markers.some(marker => marker.record === undefined)) throw new Error('Managed writer activity is unavailable: unreadable reservation');
    return markers.flatMap(({ record }) => record === undefined ? [] : [record.taskId]);
  }

  /** Local host diagnostics only: recorded reservations, not proof of process liveness. */
  public async reservationDiagnostics(): Promise<ReservationDiagnostics> {
    const maximum = this.options.maxConcurrentTasksProvider?.() ?? this.maxConcurrentTasks;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid managed task capacity');
    // Do not bootstrap an entire history or repair metadata merely for a UI sample.
    if (!(await isReady(this.readyPath))) {
      // An uninitialized index can still contain legacy active tasks.
      throw new Error('Reservation index has not been initialized');
    }
    const markers = await this.readMarkers();
    let shell = 0; let managed = 0; let unknown = 0; let unreadable = 0;
    const rows: ReservationDiagnosticRow[] = [];
    for (const { record } of markers) {
      if (record === undefined) { unreadable += 1; continue; }
      const kind = record.reservationKind ?? (record.legacy === true ? 'durable_shell'
        : record.mutationKind === 'opaque_contained_process' || record.mutationKind === 'opaque_uncontained'
          || LEGACY_MANAGED_WRITER_ID.test(record.taskId) ? 'managed_writer' : 'unknown');
      if (kind === 'durable_shell') shell += 1;
      else if (kind === 'managed_writer') managed += 1;
      else unknown += 1;
      if (rows.length < 128) rows.push({ taskId: record.taskId, kind,
        ...(record.ownerWorkspaceId === undefined ? {} : { workspaceId: record.ownerWorkspaceId }),
        ...(record.ownerClientId === undefined ? {} : { ownerClientId: record.ownerClientId }),
        ...(record.reservedAt === undefined ? {} : { reservedAt: record.reservedAt }),
      });
    }
    return { limit: maximum, total: markers.length, unreadable, shell, managed, unknown, rows };
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
        await this.ensureJournalUnlocked(true);
        try {
          return ok(await this.readLaunchPage(options));
        } catch (error: unknown) {
          if (error instanceof CorruptJournalError) await this.rebuildJournalUnlocked();
          throw error;
        }
      });
    } catch (error: unknown) {
      if (error instanceof DurableIndexBusyError) return err(indexBusyError());
      if (error instanceof InvalidCursorError) return err(appError('INVALID_INPUT', error.message));
      if (error instanceof CorruptJournalError) {
        return err(appError('INTERNAL_ERROR', 'Durable task launch journal is corrupt; retry after rebuild', true));
      }
      return err(appError('INTERNAL_ERROR', 'Durable task launch journal could not be read', true));
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    // A previously initialized index missing its reservation directory is
    // damaged, not empty. Do not silently recreate it and admit a new writer.
    try {
      if (!(await stat(this.activeDirectory)).isDirectory()) throw new Error('Managed writer reservation directory is invalid');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (await isReady(this.readyPath)) throw new Error('Managed writer reservation directory is missing');
      await mkdir(this.activeDirectory, { recursive: true });
    }
  }

  private async initializeUnlocked(): Promise<void> {
    if (await isReady(this.readyPath)) return;
    await mkdir(this.activeDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const launchRecords: DurableTaskLaunchRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.index') continue;
      const observed = this.options.inspectBootstrapTask === undefined
        ? { inspection: await this.options.inspectTask(entry.name).catch(() => 'unknown' as const),
          record: await this.options.loadLaunchRecord?.(entry.name).catch(() => undefined) }
        : await this.options.inspectBootstrapTask(entry.name).catch(() => ({ inspection: 'unknown' as const, record: undefined }));
      const { inspection, record } = observed;
      if (record !== undefined && isLaunchRecord(record)) launchRecords.push(record);
      if (inspection !== 'active' && inspection !== 'unknown') continue;
      const markerPath = this.markerPath(entry.name);
      if (await readMarker(markerPath) !== undefined) continue;
      await atomicWriteJson(markerPath, {
        version: 1,
        reservationId: randomUUID(),
        taskId: entry.name,
        requestDigest: null,
        reservedAt: this.now().toISOString(),
        legacy: true,
      });
    }
    await this.writeLaunchJournalUnlocked(launchRecords);
    await rm(this.readyPath, { force: true }).catch(() => undefined);
    await atomicWriteJson(this.readyPath, {
      version: 1,
      readyAt: this.now().toISOString(),
      journalComplete: this.options.loadLaunchRecord !== undefined || this.options.inspectBootstrapTask !== undefined,
    });
  }

  private async ensureJournalUnlocked(repairLegacy = false): Promise<void> {
    try {
      if (!(await stat(this.launchesPath)).isFile()) throw new Error('Launch journal is not a file');
    } catch {
      await this.rebuildJournalUnlocked();
      return;
    }
    if (!repairLegacy || this.options.loadLaunchRecord === undefined) return;
    const ready = await readJson(this.readyPath);
    if (isRecord(ready) && ready.journalComplete === true) return;
    // A reservation may already have a launch row but no task.json yet.
    // Defer this optional legacy repair until that launch has settled.
    if ((await this.readMarkers()).length !== 0) return;
    await this.rebuildJournalUnlocked();
  }

  private async rebuildJournalUnlocked(): Promise<void> {
    const launchRecords: DurableTaskLaunchRecord[] = [];
    if (this.options.loadLaunchRecord !== undefined) {
      const ids = (await readdir(this.rootDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== '.index')
        .map((entry) => entry.name);
      for (const taskId of ids) {
        const record = await this.options.loadLaunchRecord(taskId).catch(() => undefined);
        if (record !== undefined && isLaunchRecord(record)) launchRecords.push(record);
      }
    }
    await this.writeLaunchJournalUnlocked(launchRecords);
    if (this.options.loadLaunchRecord !== undefined) {
      const ready = await readJson(this.readyPath);
      if (isRecord(ready) && ready.version === 1) {
        await atomicWriteJson(this.readyPath, { ...ready, journalComplete: true });
      }
    }
  }

  private async writeLaunchJournalUnlocked(launchRecords: DurableTaskLaunchRecord[]): Promise<void> {
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
      let scanned = 0;
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
            scanned++;
            if (options.accept?.(record) !== false) records.push(record);
            if (records.length === options.limit || scanned >= MAX_JOURNAL_RECORDS_PER_PAGE) {
              return {
                records,
                ...(absoluteLineStart > 0 ? { nextCursor: encodeCursor(absoluteLineStart) } : {}),
              };
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
    const entries = await readdir(this.activeDirectory, { withFileTypes: true });
    return Promise.all(entries
      .filter((entry) => entry.name.endsWith('.json'))
      .map(async (entry) => {
        const markerPath = path.join(this.activeDirectory, entry.name);
        const record = entry.isFile() ? await readMarker(markerPath) : undefined;
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
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(this.lockPath, 'wx');
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
        await this.reclaimStaleLock();
        if (Date.now() >= deadline) throw new DurableIndexBusyError();
        await delay(LOCK_RETRY_MS);
        continue;
      }
      // Only an acquisition collision is retryable. EEXIST from the protected
      // operation itself must not replay a partially completed mutation.
      try {
        await handle.writeFile(JSON.stringify({
          version: 1,
          pid: process.pid,
          processStartedAt: currentProcessStartedAt(),
          acquiredAt: this.now().toISOString(),
        }), 'utf8');
        return await operation();
      } finally {
        try { await handle.close(); }
        finally { await this.releaseLockFile(); }
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
  readonly reservationId?: string;
  readonly taskId: string;
  readonly requestDigest: string | null;
  readonly reservationKind?: ReservationKind;
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

interface MarkerProbe { readonly path: string; readonly record: MarkerRecord; readonly identity: string }
interface MarkerObservation { readonly identity: string; readonly inspection: ActiveTaskInspection; readonly abandoned: boolean }
type ReservationAttempt = { readonly result: Result<DurableTaskReservationResult> } | { readonly probes: readonly MarkerProbe[] };

/** New markers have a nonce; legacy markers require matching on-disk identity too. */
async function markerIdentity(marker: MarkerRead): Promise<string | undefined> {
  if (marker.record === undefined) return undefined;
  const contents = JSON.stringify(marker.record);
  if (marker.record.reservationId !== undefined) return contents;
  try {
    const file = await stat(marker.path, { bigint: true });
    return file.isFile() ? `${file.dev}:${file.ino}:${file.mtimeNs}:${file.ctimeNs}:${contents}` : undefined;
  } catch { return undefined; }
}

class DurableIndexBusyError extends Error {}
function indexBusyError(): ReturnType<typeof appError> {
  return { ...appError('CONFLICT', 'Durable task index is busy; no reservation was admitted by this attempt. Inspect the existing task before retrying.', true),
    details: { reason: 'durable_task_index_busy' } };
}

const LOCK_RETRY_MS = 15;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RELEASE_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const RESERVATION_RECLAIM_GRACE_MS = 30_000;
// Only host-generated legacy writer IDs, and only when shell metadata is absent.
const LEGACY_MANAGED_WRITER_ID = /^(?:managed-writer|workspace-writer-probe|workspace-lifecycle)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_PAGE_SIZE = 200;
// Bound the time spent holding the writer lock even for a client with no matching history.
const MAX_JOURNAL_RECORDS_PER_PAGE = 4096;
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
  if (!isRecord(value) || value.version !== 1 || typeof value.taskId !== 'string' || !isSafeTaskId(value.taskId)) return undefined;
  if (value.mutationKind !== undefined && value.mutationKind !== 'opaque' && value.mutationKind !== 'repository_import' && value.mutationKind !== 'opaque_uncontained' && value.mutationKind !== 'opaque_contained_process' && value.mutationKind !== 'workspace_lifecycle') return undefined;
  if (value.requestDigest !== null && (typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(value.requestDigest))) return undefined;
  if (value.reservationKind !== undefined && value.reservationKind !== 'durable_shell' && value.reservationKind !== 'managed_writer') return undefined;
  return {
    version: 1,
    ...(typeof value.reservationId === 'string' ? { reservationId: value.reservationId } : {}),
    taskId: value.taskId,
    requestDigest: value.requestDigest,
    ...(value.reservationKind === undefined ? {} : { reservationKind: value.reservationKind }),
    mutationKind: value.mutationKind === 'workspace_lifecycle' ? 'workspace_lifecycle' : value.mutationKind === 'repository_import' ? 'repository_import' : value.mutationKind === 'opaque_uncontained' ? 'opaque_uncontained' : value.mutationKind === 'opaque_contained_process' ? 'opaque_contained_process' : 'opaque',
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
