import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { appError, err, ok, type AppError, type Result } from '@lnwjing/domain';
import { BoundedEventBuffer, type EventPage } from './bounded-event-buffer.js';
import { DapFrameDecoder, encodeDapMessage } from './dap-framing.js';

export interface DebugOwner {
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export const DEBUG_COMMANDS = ['next', 'stepIn', 'stepOut', 'continue', 'pause', 'threads', 'stackTrace', 'scopes', 'variables', 'evaluate'] as const;
export type DebugCommand = typeof DEBUG_COMMANDS[number];

export interface DebugSessionReceipt {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly state: 'initializing' | 'ready' | 'disconnected';
  readonly endpoint: string;
  readonly connectionGap: boolean;
  readonly debuggeeState: 'unknown';
}

export interface DebugAttachRequest {
  readonly endpoint: string;
  readonly adapterId?: string;
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

interface DebugEvent {
  readonly event: string;
  readonly body?: unknown;
  readonly observedAt: string;
}

interface PendingResponse {
  readonly command: string;
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: DapFailure) => void;
}

class DapFailure extends Error {
  public constructor(public readonly detail: AppError) { super(detail.message); }
}

class DapChannel {
  public readonly id = randomUUID();
  public readonly socket = new Socket();
  public readonly events = new BoundedEventBuffer<DebugEvent>();
  public state: DebugSessionReceipt['state'] = 'initializing';
  public connectionGap = false;
  public lastUsedAt = Date.now();
  private readonly decoder = new DapFrameDecoder();
  private readonly pending = new Map<number, PendingResponse>();
  private resolveInitialized: (() => void) | undefined;
  private rejectInitialized: ((error: DapFailure) => void) | undefined;
  private readonly initialized = new Promise<void>((resolve, reject) => {
    this.resolveInitialized = resolve;
    this.rejectInitialized = reject;
  });
  private sequence = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(public readonly owner: DebugOwner, public readonly endpoint: string, private readonly idleTtlMs: number) {
    void this.initialized.catch(() => undefined);
    this.socket.on('data', (chunk) => {
      try {
        for (const message of this.decoder.feed(chunk)) {
          if (this.state === 'disconnected') break;
          this.receive(message);
        }
      } catch {
        this.close(appError('CONFLICT', 'DAP adapter sent a malformed or uncorrelated frame', true));
      }
    });
    this.socket.on('error', () => this.close(appError('CONFLICT', 'DAP connection failed; reconnect explicitly before retrying', true)));
    this.socket.on('end', () => this.close(appError('CONFLICT', 'DAP adapter disconnected', true)));
    this.socket.on('close', () => this.close(appError('CONFLICT', 'DAP connection closed', true)));
    this.touch();
  }

  public touch(): void {
    this.lastUsedAt = Date.now();
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.state === 'disconnected') return;
    this.idleTimer = setTimeout(() => this.close(appError('CONFLICT', 'DAP session expired after client inactivity', true)), this.idleTtlMs);
    this.idleTimer.unref();
  }

  public async connect(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const endpoint = new URL(this.endpoint);
    await boundedWait(new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', () => reject(new DapFailure(appError('CONFLICT', 'DAP adapter connection failed', true))));
      this.socket.once('close', () => reject(new DapFailure(appError('CONFLICT', 'DAP adapter connection closed', true))));
      this.socket.connect(Number(endpoint.port), endpoint.hostname.replace(/^\[|\]$/g, ''));
    }), timeoutMs, signal, () => this.close(appError('PROCESS_TIMEOUT', 'DAP connection was cancelled or timed out', true)));
  }

  public waitUntilInitialized(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return boundedWait(this.initialized, timeoutMs, signal, () => this.close(appError('PROCESS_TIMEOUT', 'DAP initialization was cancelled or timed out', true)));
  }

  public request(command: string, argumentsValue: Readonly<Record<string, unknown>>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new DapFailure(appError('PROCESS_TIMEOUT', 'DAP request was cancelled before dispatch', true)));
    if (this.state === 'disconnected') return Promise.reject(new DapFailure(appError('CONFLICT', 'DAP session is disconnected', true)));
    if (this.pending.size >= 32) return Promise.reject(new DapFailure(appError('CONFLICT', 'DAP pending request limit reached', true)));
    this.touch();
    const sequence = this.nextSequence();
    const encoded = encodeDapMessage({ seq: sequence, type: 'request', command, arguments: argumentsValue });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
            const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(sequence);
      };
      const abort = (): void => this.close(appError('PROCESS_TIMEOUT', 'DAP request was cancelled after dispatch; adapter outcome is unknown', true));
      const timer = setTimeout(() => this.close(appError('PROCESS_TIMEOUT', 'DAP request timed out; adapter outcome is unknown', true)), timeoutMs);
      this.pending.set(sequence, {
        command,
        resolve: (response) => { cleanup(); resolve(response); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.socket.write(encoded, (error) => { if (error !== null && error !== undefined) this.close(appError('CONFLICT', 'DAP request could not be delivered', true)); });
    });
  }

  public close(error: AppError, gap = true): void {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.connectionGap = gap;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.rejectInitialized?.(new DapFailure(error));
    for (const pending of [...this.pending.values()]) pending.reject(new DapFailure({ ...error, details: { sessionId: this.id, command: pending.command } }));
    this.socket.destroy();
  }

  public receipt(): DebugSessionReceipt {
    return { sessionId: this.id, workspaceId: this.owner.workspaceId, state: this.state, endpoint: this.endpoint, connectionGap: this.connectionGap, debuggeeState: 'unknown' };
  }

  private nextSequence(): number {
    if (this.sequence === 2_147_483_647) throw new DapFailure(appError('CONFLICT', 'DAP sequence capacity reached; reconnect explicitly', true));
    this.sequence += 1;
    return this.sequence;
  }

  private receive(message: Record<string, unknown>): void {
    if (!Number.isInteger(message.seq) || typeof message.seq !== 'number' || message.seq < 0) throw new Error('DAP message sequence is invalid');
    if (message.type === 'event') {
      if (typeof message.event !== 'string' || message.event.length === 0) throw new Error('DAP event is invalid');
      this.events.push({ event: message.event, ...(message.body === undefined ? {} : { body: message.body }), observedAt: new Date().toISOString() });
      if (message.event === 'initialized') this.resolveInitialized?.();
      if (message.event === 'terminated') this.close(appError('CONFLICT', 'DAP debug session terminated', true));
      return;
    }
    if (message.type === 'response') {
      if (typeof message.request_seq !== 'number' || !Number.isInteger(message.request_seq) || typeof message.success !== 'boolean' || typeof message.command !== 'string') throw new Error('DAP response is invalid');
      const pending = this.pending.get(message.request_seq);
      if (pending === undefined || pending.command !== message.command) throw new Error('DAP response correlation is invalid');
      if (message.success) pending.resolve(message);
      else pending.reject(new DapFailure({ ...appError('CONFLICT', `DAP adapter rejected ${message.command}; inspect adapterResponse for its exact error`, true), details: { sessionId: this.id, requestSeq: message.request_seq, command: message.command, adapterResponse: JSON.stringify(message) } }));
      return;
    }
    if (message.type === 'request' && typeof message.command === 'string') {
      this.socket.write(encodeDapMessage({ seq: this.nextSequence(), type: 'response', request_seq: message.seq, command: message.command, success: false, message: 'Client reverse requests are unsupported; no process or child debugger was launched' }));
      return;
    }
    throw new Error('DAP message type is invalid');
  }
}

export class DapSessionService {
  private readonly sessions = new Map<string, DapChannel>();
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;

  public constructor(options: { readonly requestTimeoutMs?: number; readonly idleTtlMs?: number } = {}) {
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 10_000, 1, 30_000);
    this.idleTtlMs = boundedInteger(options.idleTtlMs, 300_000, 1, 300_000);
  }

  public async attach(owner: DebugOwner, request: DebugAttachRequest, signal?: AbortSignal): Promise<Result<DebugSessionReceipt>> {
    let session: DapChannel | undefined;
    try {
      validateOwner(owner);
      if (this.closed) return err(appError('CONFLICT', 'DAP session service is closed'));
      const endpoint = validateEndpoint(request.endpoint);
      this.prune();
      const activeOwned = [...this.sessions.values()].filter((entry) => entry.state !== 'disconnected' && sameOwner(entry.owner, owner)).length;
      if (activeOwned >= 4) return err(appError('CONFLICT', 'DAP owned session limit reached', true));
      if (this.sessions.size >= 16) {
        const oldestClosed = [...this.sessions.values()].filter((entry) => entry.state === 'disconnected').sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (oldestClosed === undefined) return err(appError('CONFLICT', 'DAP session capacity reached', true));
        this.sessions.delete(oldestClosed.id);
      }
      const timeout = boundedInteger(request.timeoutMs, this.requestTimeoutMs, 1, 30_000);
      if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'DAP attach was cancelled before connection', true));
      session = new DapChannel({ ...owner }, endpoint, this.idleTtlMs);
      this.sessions.set(session.id, session);
      const deadline = Date.now() + timeout;
      const remaining = (): number => {
        const value = deadline - Date.now();
        if (value <= 0) throw new DapFailure(appError('PROCESS_TIMEOUT', 'DAP attach deadline expired', true));
        return value;
      };
      await session.connect(remaining(), signal);
      const initialized = await session.request('initialize', { clientID: 'lnwjing', clientName: 'lnwjing', adapterID: request.adapterId ?? 'configured', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: false }, remaining(), signal);
      const attaching = session.request('attach', request.configuration ?? {}, remaining(), signal);
      void attaching.catch(() => undefined);
      if (isRecord(initialized.body) && initialized.body.supportsConfigurationDoneRequest === true) {
        await session.waitUntilInitialized(remaining(), signal);
        await session.request('configurationDone', {}, remaining(), signal);
      }
      await attaching;
      if (signal?.aborted || session.state === 'disconnected') throw new DapFailure(appError('PROCESS_TIMEOUT', 'DAP attach did not complete', true));
      session.state = 'ready';
      return ok(session.receipt());
    } catch (error: unknown) {
      session?.close(appError('CONFLICT', 'DAP attach did not complete', true));
      if (session !== undefined) this.sessions.delete(session.id);
      return failure(error);
    }
  }

  public async request(owner: DebugOwner, sessionId: string, command: DebugCommand, argumentsValue: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<Result<{ readonly session: DebugSessionReceipt; readonly response: Readonly<Record<string, unknown>> }>> {
    try {
      const session = this.owned(owner, sessionId);
      if (!DEBUG_COMMANDS.includes(command)) return err(appError('INVALID_INPUT', 'DAP command is unsupported'));
      if (session.state !== 'ready') return err(appError('CONFLICT', 'DAP session is not ready', true));
      const response = await session.request(command, argumentsValue, this.requestTimeoutMs, signal);
      return ok({ session: session.receipt(), response });
    } catch (error: unknown) { return failure(error); }
  }

  public status(owner: DebugOwner, sessionId: string, cursor = '0', limit = 100, maxBytes = 65_536): Result<{ readonly session: DebugSessionReceipt; readonly events: EventPage<DebugEvent> }> {
    try {
      const session = this.owned(owner, sessionId);
      return ok({ session: session.receipt(), events: session.events.read(cursor, limit, maxBytes) });
    } catch (error: unknown) { return failure(error); }
  }

  public async disconnect(owner: DebugOwner, sessionId: string, signal?: AbortSignal): Promise<Result<DebugSessionReceipt>> {
    let session: DapChannel | undefined;
    try {
      session = this.owned(owner, sessionId);
      if (session.state !== 'disconnected') await session.request('disconnect', { restart: false, terminateDebuggee: false, suspendDebuggee: false }, this.requestTimeoutMs, signal);
      session.close(appError('CONFLICT', 'DAP client disconnected explicitly'), false);
      return ok(session.receipt());
    } catch (error: unknown) {
      session?.close(appError('CONFLICT', 'DAP disconnect outcome is unknown', true));
      return failure(error);
    }
  }

  public close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) session.close(appError('CONFLICT', 'DAP host runtime closed', true));
    this.sessions.clear();
  }

  private owned(owner: DebugOwner, sessionId: string): DapChannel {
    validateOwner(owner);
    this.prune();
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new DapFailure(appError('INVALID_INPUT', 'DAP session was not found or expired'));
    if (!sameOwner(session.owner, owner)) throw new DapFailure(appError('PERMISSION_DENIED', 'DAP session belongs to another client, session or workspace'));
    session.touch();
    return session;
  }

  private prune(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastUsedAt <= cutoff) {
        session.close(appError('CONFLICT', 'DAP session expired after client inactivity', true));
        this.sessions.delete(id);
      }
    }
  }
}

function validateEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'tcp:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '' || !['', '/'].includes(endpoint.pathname) || !Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65_535) throw new Error('Invalid endpoint');
    return endpoint.toString();
  } catch { throw new DapFailure(appError('INVALID_INPUT', 'DAP endpoint must be an explicit numeric loopback TCP address and port')); }
}

function validateOwner(owner: DebugOwner): void {
  if (![owner.clientId, owner.sessionId, owner.workspaceId].every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512)) throw new DapFailure(appError('INVALID_INPUT', 'DAP owner requires client, session and registered workspace identities'));
}

function sameOwner(left: DebugOwner, right: DebugOwner): boolean {
  return left.clientId === right.clientId && left.sessionId === right.sessionId && left.workspaceId === right.workspaceId;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DapFailure(appError('INVALID_INPUT', 'DAP request bounds are invalid'));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(error: unknown): Result<never> {
  return err(error instanceof DapFailure ? error.detail : appError('INVALID_INPUT', 'DAP request or frame could not be encoded or validated'));
}

function boundedWait<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, cancel: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = (): void => { cancel(); cleanup(); reject(new DapFailure(appError('PROCESS_TIMEOUT', 'DAP operation was cancelled or timed out', true))); };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}
