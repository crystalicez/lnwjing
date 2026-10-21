import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { appError, err, ok, type AppErrorCode, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import type { ProcessTreeTerminator } from '@lnwjing/process';
import { CAPABILITY_TASK_OWNER_METADATA_KEY, capabilityTaskOwnerMatches, legacyCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
// Captures are returned as bounded PNG/base64 payloads. Keep the transport
// ceiling above the 8 MiB image limit while still bounding a single response
// and the in-memory unfinished line.
const DEFAULT_MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const APP_ERROR_CODES: readonly AppErrorCode[] = [
  'INVALID_INPUT', 'CONFLICT', 'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED',
  'PERMISSION_DENIED', 'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE',
  'PROCESS_NOT_FOUND', 'PROCESS_TIMEOUT', 'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY', 'CODEX_NOT_AVAILABLE',
  'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
];

export interface NativeHostProtocolOptions {
  readonly platform: 'darwin' | 'linux';
  readonly executablePath: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
  /** Release composition sets this to true; local development may opt out explicitly. */
  readonly requireIntegrity?: boolean;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly ownerIdleTtlMs?: number;
  readonly terminator: ProcessTreeTerminator;
  readonly spawnProcess?: NativeHostSpawner;
}

export type NativeHostSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface PendingRequest {
  readonly resolve: (result: Result<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort: () => void;
  cancelling: boolean;
}

export class NativeHostProcessBridge {
  private readonly partitions = new Map<string, NativeHostPartition>();
  private readonly resources = new Map<string, NativeHostResource>();
  private resourceReservations = 0;
  private closed = false;
  private closing: Promise<Result<void>> | undefined;
  private readonly ownerIdleTtlMs: number;

  public constructor(private readonly options: NativeHostProtocolOptions) {
    this.ownerIdleTtlMs = options.ownerIdleTtlMs ?? 900_000;
    if (!Number.isSafeInteger(this.ownerIdleTtlMs) || this.ownerIdleTtlMs < 1 || this.ownerIdleTtlMs > 900_000) throw new RangeError('Native owner idle TTL is invalid');
  }

  public async execute(operation: string, input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.closed) return err(appError('CONFLICT', 'Native host runtime is closed'));
    if (typeof operation !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(operation)) return err(appError('INVALID_INPUT', 'Native host operation name is invalid'));
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Native host operation was cancelled before dispatch', true));
    const ownerResult = nativeOwner(input);
    if (!ownerResult.ok) return ownerResult;
    const owner = ownerResult.value;
    const normalized = normalizeNativeResourceInput(operation, input);
    if (!normalized.ok) return normalized;
    input = normalized.value;
    const refs = nativeResourceReferences(operation, input);
    let partition: NativeHostPartition | undefined;
    for (const ref of refs) {
      const recorded = this.resources.get(ref);
      if (recorded === undefined || !capabilityTaskOwnerMatches(recorded.partition.owner, owner)) return err(appError('PERMISSION_DENIED', 'Native resource was not found in this owner scope'));
      if (recorded.kind !== nativeResourceKind(operation, ref)) return err(appError('INVALID_INPUT', 'Native resource belongs to another capability'));
      if (partition !== undefined && partition !== recorded.partition) return err(appError('INVALID_INPUT', 'Native resource references belong to different partitions'));
      recorded.lastUsedAt = Date.now();
      partition = recorded.partition;
    }
    const parameters = isRecord(input) && isRecord(input.parameters) ? input.parameters : {};
    const action = isRecord(input) ? input.action ?? input.operation ?? parameters.action ?? parameters.operation ?? 'status' : 'status';
    const canAllocateResource = operation === 'audio' ? action === 'record' || action === 'play' : operation === 'screen_record' ? action === 'start'
      : operation === 'input_event' ? action !== 'status' && action !== 'release_all' : operation === 'vision' && action !== 'status';
    const reserve = refs.length === 0 && canAllocateResource ? 2 : 0;
    if (reserve > 0) this.pruneTerminalResources(reserve);
    if (this.resources.size + this.resourceReservations + reserve > 512) return err(appError('CONFLICT', 'Native resource capacity reached', true));
    const ownerKey = JSON.stringify([owner.clientId, owner.sessionId, owner.workspaceId ?? null]);
    partition ??= this.partitions.get(ownerKey);
    if (partition === undefined) {
      if (this.partitions.size >= 16) return err(appError('CONFLICT', 'Native owner process capacity reached', true));
      const entry: NativeHostPartition = { owner, key: ownerKey, transport: new NativeHostProcessTransport(this.options, () => this.invalidate(entry)), activeCalls: 0 };
      this.partitions.set(ownerKey, entry);
      partition = entry;
    }
    const selected = partition;
    if (selected.idleTimer !== undefined) clearTimeout(selected.idleTimer);
    selected.idleTimer = undefined;
    selected.activeCalls += 1;
    this.resourceReservations += reserve;
    try {
      const result = await selected.transport.execute(operation, input, signal, authorization);
      if (!result.ok) {
        if (result.error.code === 'PROCESS_TIMEOUT' && selected.transport.hasProcess && !selected.transport.quarantined) {
          const stopped = await selected.transport.close();
          if (!stopped.ok) return stopped;
        }
        return result;
      }
      if (this.closed || !selected.transport.hasProcess) return err(appError('PROCESS_NOT_FOUND', 'Native owner process ended before its receipt could be retained', true));
      const responseInput = normalizeNativeResourceInput(operation, result.value);
      if (!responseInput.ok) {
        await selected.transport.close();
        return err(appError('INTERNAL_ERROR', 'Native helper returned an invalid resource identifier', true));
      }
      const released = isRecord(result.value) ? result.value.released_session_ids : undefined;
      if (released !== undefined) {
        if (operation !== 'input_event' || action !== 'release_all' || !isRecord(result.value) || result.value.closed !== true
          || !Array.isArray(released) || released.length > 512 || (refs.length > 0 && (released.length !== 1 || `session_id:${released[0]}` !== refs[0]))
          || released.some((id: unknown) => typeof id !== 'string' || id.trim().length === 0 || id.length > 512 || id.includes('\0')
            || this.resources.get(`session_id:${id}`)?.partition !== selected || this.resources.get(`session_id:${id}`)?.kind !== 'remote_desktop')) {
          await selected.transport.close();
          return err(appError('INTERNAL_ERROR', 'Native portal release receipt could not be verified', true));
        }
        for (const id of released) this.resources.delete(`session_id:${id}`);
      }
      for (const ref of nativeResourceReferences(operation, responseInput.value)) {
        const existing = this.resources.get(ref);
        if (existing !== undefined && existing.partition !== selected) {
          await selected.transport.close();
          return err(appError('INTERNAL_ERROR', 'Native helper returned a conflicting resource identifier', true));
        }
        if (existing === undefined && reserve === 0 && this.resources.size + this.resourceReservations >= 512) {
          await selected.transport.close();
          return err(appError('CONFLICT', 'Native resource receipt exceeded its reserved capacity', true));
        }
        this.resources.set(ref, { partition: selected, kind: existing?.kind ?? nativeResourceKind(operation, ref), terminal: nativeResourceIsTerminal(result.value), lastUsedAt: Date.now() });
      }
      if (isRecord(result.value) && result.value.closed === true) for (const ref of refs) if (ref.startsWith('session_id:')) this.resources.delete(ref);
      if (nativeResourceIsTerminal(result.value)) for (const ref of refs) {
        const recorded = this.resources.get(ref);
        if (recorded !== undefined) recorded.terminal = true;
      }
      return result;
    } finally {
      this.resourceReservations -= reserve;
      selected.activeCalls -= 1;
      if (selected.activeCalls === 0) {
        if (!selected.transport.hasProcess) this.partitions.delete(selected.key);
        else if (!this.closed) this.scheduleIdleClose(selected);
      }
    }
  }

  public async close(): Promise<Result<void>> {
    this.closed = true;
    if (this.closing !== undefined) return this.closing;
    this.closing = (async (): Promise<Result<void>> => {
      const results = await Promise.all([...this.partitions.values()].map((entry) => {
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
        return entry.transport.close();
      }));
      const failure = results.find((result) => !result.ok);
      if (failure !== undefined) return failure;
      this.resources.clear();
      this.partitions.clear();
      return ok(undefined);
    })();
    const result = await this.closing;
    this.closing = undefined;
    return result;
  }

  private invalidate(partition: NativeHostPartition): void {
    for (const [ref, entry] of this.resources) if (entry.partition === partition) this.resources.delete(ref);
  }

  private scheduleIdleClose(partition: NativeHostPartition): void {
    const timer = setTimeout(() => {
      partition.idleTimer = undefined;
      if (partition.activeCalls !== 0 || this.partitions.get(partition.key) !== partition) return;
      void partition.transport.close().then((result) => {
        if (result.ok && partition.activeCalls === 0 && this.partitions.get(partition.key) === partition) this.partitions.delete(partition.key);
      });
    }, this.ownerIdleTtlMs);
    timer.unref();
    partition.idleTimer = timer;
  }

  private pruneTerminalResources(reserve: number): void {
    const terminal = [...this.resources.entries()].filter(([, entry]) => entry.terminal).sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [ref] of terminal) {
      if (this.resources.size + this.resourceReservations + reserve <= 512) break;
      this.resources.delete(ref);
    }
  }
}

interface NativeHostResource {
  readonly partition: NativeHostPartition;
  readonly kind: 'audio' | 'screen_record' | 'remote_desktop' | 'screencast';
  terminal: boolean;
  lastUsedAt: number;
}

interface NativeHostPartition {
  readonly owner: CapabilityTaskOwner;
  readonly key: string;
  readonly transport: NativeHostProcessTransport;
  activeCalls: number;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
}

function nativeOwner(input: unknown): Result<CapabilityTaskOwner> {
  const metadata = isRecord(input) && isRecord(input.metadata) ? input.metadata : undefined;
  if (metadata === undefined || !Object.hasOwn(metadata, CAPABILITY_TASK_OWNER_METADATA_KEY)) return ok(legacyCapabilityTaskOwner());
  const value = metadata[CAPABILITY_TASK_OWNER_METADATA_KEY];
  const valid = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 256 && !entry.includes('\0');
  if (!isRecord(value) || !valid(value.clientId) || !valid(value.sessionId) || (value.workspaceId !== undefined && !valid(value.workspaceId))) return err(appError('INVALID_INPUT', 'Native owner metadata is invalid'));
  return ok({ clientId: value.clientId, sessionId: value.sessionId, ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId }) });
}

function nativeResourceReferences(operation: string, input: unknown): string[] {
  if (!['audio', 'screen_record', 'input_event', 'vision'].includes(operation) || !isRecord(input)) return [];
  return ['handle', 'session_id'].flatMap((field) => typeof input[field] === 'string' && input[field].length > 0 ? [`${field}:${input[field]}`] : []);
}

function normalizeNativeResourceInput(operation: string, input: unknown): Result<unknown> {
  if (!['audio', 'screen_record', 'input_event', 'vision'].includes(operation) || !isRecord(input)) return ok(input);
  const parameters = isRecord(input.parameters) ? input.parameters : undefined;
  const normalized: Record<string, unknown> = { ...input };
  const remainingParameters = parameters === undefined ? undefined : { ...parameters };
  for (const field of ['handle', 'session_id']) {
    const direct = input[field];
    const nested = parameters?.[field];
    const value = direct ?? nested;
    if (value === undefined) continue;
    if ((field === 'handle' && !['audio', 'screen_record'].includes(operation)) || (field === 'session_id' && operation === 'audio')) return err(appError('INVALID_INPUT', `Native ${field} is unsupported for ${operation}`));
    if (direct !== undefined && nested !== undefined && direct !== nested) return err(appError('INVALID_INPUT', `Conflicting native ${field} values`));
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512 || value.includes('\0')) return err(appError('INVALID_INPUT', `Native ${field} is invalid`));
    normalized[field] = value;
    if (remainingParameters !== undefined) delete remainingParameters[field];
  }
  if (remainingParameters !== undefined) normalized.parameters = remainingParameters;
  return ok(normalized);
}

function nativeResourceKind(operation: string, ref: string): NativeHostResource['kind'] {
  return ref.startsWith('session_id:') ? (operation === 'input_event' ? 'remote_desktop' : 'screencast') : (operation === 'audio' ? 'audio' : 'screen_record');
}

function nativeResourceIsTerminal(value: unknown): boolean {
  return isRecord(value) && value.running !== true && value.state !== 'termination_unverified' && value.deliveryState !== 'termination_unverified' && value.termination_verified !== false
    && (value.running === false || value.closed === true || ['completed', 'cancelled', 'failed'].includes(typeof value.state === 'string' ? value.state : ''));
}

class NativeHostProcessTransport {
  private readonly platform: 'darwin' | 'linux';
  private readonly executablePath: string;
  private readonly expectedSha256: string | undefined;
  private readonly expectedSizeBytes: number | undefined;
  private readonly requireIntegrity: boolean;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly terminator: ProcessTreeTerminator;
  private readonly spawnProcess: NativeHostSpawner;
  private child: ChildProcess | undefined;
  private starting: Promise<Result<void>> | undefined;
  private terminationInFlight: Promise<Result<void>> | undefined;
  private terminationUnverified = false;
  private stdoutBuffer = '';
  private stdoutBytes = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  public get quarantined(): boolean { return this.terminationUnverified; }

  public constructor(options: NativeHostProtocolOptions, private readonly onStopped: () => void) {
    this.platform = options.platform;
    this.executablePath = path.resolve(options.executablePath);
    this.expectedSha256 = options.expectedSha256?.trim().toLowerCase();
    this.expectedSizeBytes = options.expectedSizeBytes;
    this.requireIntegrity = options.requireIntegrity === true;
    this.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxPayloadBytes = Math.min(MAX_PAYLOAD_BYTES, Math.max(1024, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES));
    this.terminator = options.terminator;
    this.spawnProcess = options.spawnProcess ?? ((executable: string, args: readonly string[], spawnOptions: SpawnOptions): ChildProcess => spawn(executable, [...args], spawnOptions));
  }

  public async execute(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    if (this.closed) return err(appError('CONFLICT', 'Native owner transport is closed'));
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(operation)) return err(appError('INVALID_INPUT', 'Native host operation name is invalid'));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Native host operation was cancelled', true));
    let serialized: string;
    const id = cryptoRandomId();
    try {
      serialized = JSON.stringify({ id, operation, input, ...(authorization === undefined ? {} : { authorization }) });
    } catch {
      return err(appError('INVALID_INPUT', 'Native host input could not be serialized'));
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) return err(appError('FILE_TOO_LARGE', 'Native host request exceeds the payload limit'));

    const started = await this.ensureStarted();
    if (!started.ok) return started;
    const child = this.child;
    const stdin = child?.stdin;
    if (child === undefined || stdin === null || stdin === undefined || stdin.destroyed) return err(appError('PROCESS_NOT_FOUND', 'Native host is not running', true));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener('abort', pending.onAbort);
          this.pending.delete(id);
        }
        resolve(result);
      };
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (pending !== undefined) pending.cancelling = true;
        void this.terminate('Native host operation was cancelled').then((termination) => {
          if (!termination.ok) {
            // Do not report a clean cancellation while the helper may still be
            // alive. The caller needs the same termination-unverified signal as
            // every other managed-process boundary.
            finish(termination);
            return;
          }
          finish(err(appError('PROCESS_TIMEOUT', 'Native host operation was cancelled', true)));
        });
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending !== undefined) pending.cancelling = true;
        void this.terminate('Native host operation timed out').then((termination) => {
          if (!termination.ok) {
            finish(termination);
            return;
          }
          finish(err(appError('PROCESS_TIMEOUT', 'Native host operation timed out', true)));
        });
      }, this.timeoutMs);
      this.pending.set(id, { resolve: finish, timer, signal, onAbort, cancelling: false });
      signal?.addEventListener('abort', onAbort, { once: true });
      // AbortSignals do not replay an abort event for listeners attached after
      // the signal was aborted. Check again after registration so an abort
      // racing helper startup cannot leave a request pending until timeout.
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      try {
        stdin.write(`${serialized}\n`, 'utf8');
      } catch {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        finish(err(appError('PROCESS_NOT_FOUND', 'Native host input pipe is unavailable', true)));
      }
    });
  }

  public async close(): Promise<Result<void>> {
    this.closed = true;
    await this.starting;
    return this.terminate('Native host was closed');
  }

  public get hasProcess(): boolean { return this.child !== undefined || this.starting !== undefined; }

  private async ensureStarted(): Promise<Result<void>> {
    if (this.terminationInFlight !== undefined) {
      const termination = await this.terminationInFlight;
      if (!termination.ok) return termination;
    }
    if (this.closed) return err(appError('CONFLICT', 'Native owner transport is closed'));
    if (this.terminationUnverified) {
      return err(appError('PROCESS_TIMEOUT', `${this.platform} native host termination is unverified; refusing to reuse the helper`, true));
    }
    // `ChildProcess.killed` means that a signal was requested, not that the
    // OS has reaped the process. Do not start a replacement while the old
    // helper is still live; otherwise two native providers could consume the
    // same ownership scope concurrently. The close handler is the only point
    // that clears the reference after an observed exit.
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) return ok(undefined);
    if (this.starting !== undefined) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<Result<void>> {
    const integrity = await this.verifyIntegrity();
    if (!integrity.ok) return integrity;
    if (this.closed) return err(appError('CONFLICT', 'Native owner transport is closed'));
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executablePath, [], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Native providers only need the host/session environment (PATH,
        // DISPLAY, DBUS, HOME, ...). Do not inherit credentials that happen
        // to be present in the Electron/CLI parent process.
        env: sanitizedNativeHostEnvironment(),
      });
    } catch {
      return err(appError('PROCESS_NOT_FOUND', `${this.platform} native host could not be started`, true));
    }
    this.child = child;
    this.stdoutBuffer = '';
    this.stdoutBytes = 0;
    // Keep incomplete UTF-8 sequences in this child's stream decoder until
    // the next chunk arrives, rather than replacing their individual bytes.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr?.resume();
    child.once('error', () => this.failPending(err(appError('PROCESS_NOT_FOUND', `${this.platform} native host exited unexpectedly`, true))));
    child.once('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.terminationUnverified = false;
        this.onStopped();
      }
      if (this.terminationInFlight === undefined) this.failPending(err(appError('PROCESS_NOT_FOUND', `${this.platform} native owner process stopped`, true)));
    });
    if (child.stdin === undefined || child.stdin === null || child.stdout === undefined || child.stdout === null) {
      const terminated = await this.terminate(`${this.platform} native host did not expose stdio`);
      if (!terminated.ok) return terminated;
      return err(appError('INTERNAL_ERROR', `${this.platform} native host stdio is unavailable`, true));
    }
    return ok(undefined);
  }

  private consumeStdout(text: string): void {
    // Bound the unfinished response currently buffered, not the lifetime
    // total. A long-lived helper is allowed to answer many small requests.
    this.stdoutBuffer += text;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxPayloadBytes) {
        void this.terminate(`${this.platform} native host response exceeded the payload limit`);
        this.failPending(err(appError('FILE_TOO_LARGE', 'Native host response exceeds the payload limit', true)));
        return;
      }
      this.consumeResponse(line);
    }
    this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer, 'utf8');
    if (this.stdoutBytes > this.maxPayloadBytes) {
      void this.terminate(`${this.platform} native host response exceeded the payload limit`);
      this.failPending(err(appError('FILE_TOO_LARGE', 'Native host response exceeds the payload limit', true)));
    }
  }

  private consumeResponse(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch {
      void this.terminate(`${this.platform} native host returned malformed JSON`);
      this.failPending(err(appError('INTERNAL_ERROR', 'Native host returned malformed JSON', true)));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') {
      void this.terminate(`${this.platform} native host returned an invalid response`);
      this.failPending(err(appError('INTERNAL_ERROR', 'Native host returned an invalid response', true)));
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined || pending.cancelling) return;
    if (parsed.ok) {
      pending.resolve(ok(parsed.value));
      return;
    }
    const error = parseNativeHostError(parsed.error);
    pending.resolve(error === undefined ? err(appError('INTERNAL_ERROR', 'Native host returned an invalid error', true)) : err(error));
  }

  private failPending(result: Result<unknown>): void {
    for (const pending of this.pending.values()) pending.resolve(result);
  }

  private async terminate(reason: string): Promise<Result<void>> {
    if (this.terminationInFlight !== undefined) return this.terminationInFlight;
    const attempt = Promise.resolve().then(() => this.terminateOnce(reason));
    this.terminationInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.terminationInFlight === attempt) this.terminationInFlight = undefined;
    }
  }

  private async terminateOnce(reason: string): Promise<Result<void>> {
    const child = this.child;
    if (child === undefined) return ok(undefined);
    try {
      if (child.pid === undefined) {
        this.terminationUnverified = true;
        const result = err(appError('PROCESS_NOT_FOUND', `${reason}; native host PID is unavailable`, true));
        this.failPending(result);
        return result;
      }
      await this.terminator.stop(child, child.pid);
      if (this.child === child) {
        this.child = undefined;
        this.terminationUnverified = false;
        this.onStopped();
      }
      this.failPending(err(appError('PROCESS_TIMEOUT', `${reason}; native owner process was stopped`, true)));
      return ok(undefined);
    } catch {
      // Keep the child reference and quarantine it.  Reusing a helper after a
      // failed termination attempt could create two live native providers and
      // would make request ownership ambiguous.  The close event clears this
      // state only after the OS reports that the child really exited.
      this.terminationUnverified = true;
      const result = err(appError('PROCESS_TIMEOUT', `${reason}; native host termination could not be verified`, true));
      this.failPending(result);
      return result;
    }
  }

  private async verifyIntegrity(): Promise<Result<void>> {
    if (this.expectedSha256 === undefined) {
      return this.requireIntegrity
        ? err(appError('INTERNAL_ERROR', `${this.platform} native host integrity manifest is missing`))
        : ok(undefined);
    }
    if (!/^[0-9a-f]{64}$/.test(this.expectedSha256)
      || (this.expectedSizeBytes !== undefined && (!Number.isSafeInteger(this.expectedSizeBytes) || this.expectedSizeBytes < 1))) {
      return err(appError('INTERNAL_ERROR', `${this.platform} native host integrity manifest is invalid`));
    }
    try {
      const info = await lstat(this.executablePath);
      if (!info.isFile() || info.isSymbolicLink()) return err(appError('INTERNAL_ERROR', `${this.platform} native host is not a trusted regular file`));
      const canonical = await realpath(this.executablePath);
      if (canonical !== this.executablePath) return err(appError('INTERNAL_ERROR', `${this.platform} native host path resolves through a link`));
      const bytes = await readFile(this.executablePath);
      if (this.expectedSizeBytes !== undefined && bytes.byteLength !== this.expectedSizeBytes) return err(appError('INTERNAL_ERROR', `${this.platform} native host size does not match its manifest`));
      const digest = createHash('sha256').update(bytes).digest('hex');
      return digest === this.expectedSha256
        ? ok(undefined)
        : err(appError('INTERNAL_ERROR', `${this.platform} native host hash does not match its manifest`));
    } catch {
      return err(appError('INTERNAL_ERROR', `${this.platform} native host integrity could not be verified`));
    }
  }
}

function parseNativeHostError(value: unknown): { readonly code: AppErrorCode; readonly message: string; readonly recoverable: boolean } | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string' || typeof value.recoverable !== 'boolean') return undefined;
  const code = APP_ERROR_CODES.find((candidate) => candidate === value.code) ?? 'INTERNAL_ERROR';
  return { code, message: value.message.slice(0, 2048), recoverable: value.recoverable };
}

function cryptoRandomId(): string {
  return randomUUID();
}

function sanitizedNativeHostEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:api[_-]?key|token|password|secret)/iu.test(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
