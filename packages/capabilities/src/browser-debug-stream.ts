import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { BoundedEventBuffer } from './bounded-event-buffer.js';
import { BrowserCdpChannelCleanupError } from './browser-cdp-event-channel.js';
import { browserDebugObservation, observesProtectedBrowserPage, type BrowserDebugObservation } from './browser-debug-observation.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY, capabilityTaskOwnerMatches, type CapabilityTaskOwner } from './task-ownership.js';
import type { BrowserCdpEventChannel, BrowserCdpProtocol } from './browser-cdp-backend.js';

type StreamState =
  | { readonly kind: 'starting' | 'reconnecting'; readonly controller: AbortController; readonly completion: Promise<void> }
  | { readonly kind: 'active'; readonly channel: BrowserCdpEventChannel }
  | { readonly kind: 'cleanup_failed'; readonly channel: BrowserCdpEventChannel; readonly terminal: 'closed' | 'expired' | null }
  | { readonly kind: 'closing'; readonly channel: BrowserCdpEventChannel; readonly completion: Promise<void> }
  | { readonly kind: 'disconnected' | 'closed' | 'expired' };

interface StreamRecord {
  readonly id: string;
  readonly owner: CapabilityTaskOwner;
  readonly tabId: string;
  readonly expiresAt: number;
  buffer: BoundedEventBuffer<BrowserDebugObservation>;
  state: StreamState;
  gap: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface StreamRequestBase {
  readonly owner: CapabilityTaskOwner;
  readonly dryRun: boolean;
}

export type BrowserStreamRequest = StreamRequestBase & (
  | { readonly operation: 'start'; readonly tabId: string; readonly maxEvents: number; readonly maxBytes: number; readonly ttlSeconds: number }
  | { readonly operation: 'read'; readonly streamId: string; readonly tabId?: string; readonly afterCursor: string; readonly limit: number; readonly maxBytes: number }
  | { readonly operation: 'status' | 'close' | 'reconnect'; readonly streamId: string; readonly tabId?: string }
);

export class BrowserDebugStreamService {
  private readonly streams = new Map<string, StreamRecord>();
  private closed = false;

  public constructor(private readonly protocol: BrowserCdpProtocol, private readonly verifyTab: (tabId: string, input: unknown, signal?: AbortSignal) => Promise<Result<void>>) {}

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const parsed = parseBrowserStreamRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    if (signal?.aborted === true) return cancelled();
    if (this.closed) return err(appError('PROCESS_NOT_FOUND', 'Browser observations are closed', true));
    if (request.operation === 'start') {
      if (request.dryRun) return ok({ dry_run: true, operation: request.operation, tab_id: request.tabId });
      return this.start(request, input, signal);
    }
    const record = this.streams.get(request.streamId);
    if (record === undefined || !capabilityTaskOwnerMatches(record.owner, request.owner)) return err(appError('FILE_NOT_FOUND', 'The owned browser stream was not found', true));
    if (request.tabId !== undefined && record.tabId !== request.tabId) return err(appError('INVALID_INPUT', 'The tab ID conflicts with the owned stream'));
    if (request.dryRun) return ok({ dry_run: true, operation: request.operation, stream_id: record.id });
    if (Date.now() >= record.expiresAt && record.state.kind !== 'expired') {
      const expired = await this.closeRecord(record, 'expired');
      if (!expired.ok) return expired;
    }
    switch (request.operation) {
      case 'status': return ok(this.receipt(record));
      case 'close': return this.closeRecord(record, 'closed');
      case 'read': {
        if (record.state.kind === 'expired') return err(appError('FILE_NOT_FOUND', 'The owned browser stream expired', true));
        try {
          const page = record.buffer.read(request.afterCursor, request.limit, request.maxBytes);
          return ok({
            ...this.receipt(record),
            events: page.events,
            next_cursor: page.nextCursor,
            latest_cursor: page.latestCursor,
            earliest_cursor: page.earliestCursor,
            has_more: page.hasMore,
            gap: record.gap || page.droppedEvents > 0,
            cursor_gap: page.gap,
            dropped_events: page.droppedEvents,
            retained_bytes: page.retainedBytes,
            payload_bytes: page.payloadBytes,
            required_bytes: page.requiredBytes,
            completeness: record.gap || page.droppedEvents > 0 ? 'partial_after_gap' : 'observed_since_subscription',
          });
        } catch { return err(appError('INVALID_INPUT', 'Browser event cursor or page bounds are invalid')); }
      }
      case 'reconnect': {
        if (record.state.kind === 'active') return ok(this.receipt(record));
        if (record.state.kind !== 'disconnected') return err(appError('CONFLICT', 'This browser stream cannot reconnect', true));
        record.gap = true;
        return this.connect(record, input, signal);
      }
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.all([...this.streams.values()].map((record) => this.closeRecord(record, 'closed')));
    if (results.some((result) => !result.ok)) throw new Error('Browser subscription shutdown was not confirmed');
    for (const record of this.streams.values()) if (record.timer !== null) clearTimeout(record.timer);
    this.streams.clear();
  }

  private start(request: Extract<BrowserStreamRequest, { readonly operation: 'start' }>, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.protocol.openEventChannel === undefined) return Promise.resolve(err(appError('EXECUTABLE_NOT_FOUND', 'This browser provider cannot retain observations', true)));
    for (const [id, record] of this.streams) {
      if (this.streams.size < 16) break;
      if (record.state.kind === 'closed' || record.state.kind === 'expired' || record.state.kind === 'disconnected') {
        if (record.timer !== null) clearTimeout(record.timer);
        this.streams.delete(id);
      }
    }
    const ownedLive = [...this.streams.values()].filter((record) => record.owner.clientId === request.owner.clientId && record.owner.sessionId === request.owner.sessionId && !isTerminal(record.state)).length;
    if (this.streams.size >= 16 || ownedLive >= 4) return Promise.resolve(err(appError('CONFLICT', 'Browser observation stream capacity exceeded', true)));
    const controller = new AbortController();
    const record: StreamRecord = {
      id: randomUUID(), owner: request.owner, tabId: request.tabId,
      expiresAt: Date.now() + request.ttlSeconds * 1000,
      buffer: new BoundedEventBuffer(request.maxEvents, request.maxBytes),
      state: { kind: 'starting', controller, completion: Promise.resolve() },
      gap: false, generation: 0, timer: null,
    };
    this.streams.set(record.id, record);
    record.timer = setTimeout(() => { void this.closeRecord(record, 'expired'); }, request.ttlSeconds * 1000);
    record.timer.unref();
    return this.connect(record, input, signal);
  }

  private connect(record: StreamRecord, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const allowProtected = isRecord(input) && input.allow_protected_tab_action === true && input.userConfirmed === true;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) controller.abort();
    const generation = ++record.generation;
    const run = Promise.resolve().then(async (): Promise<Result<unknown>> => {
      let channel: BrowserCdpEventChannel | null = null;
      try {
        const verified = await this.verifyTab(record.tabId, input, controller.signal);
        if (!verified.ok) { record.state = { kind: 'disconnected' }; return verified; }
        if (controller.signal.aborted || this.closed) throw new Error('Browser subscription startup cancelled');
        const open = this.protocol.openEventChannel;
        if (open === undefined) throw new Error('Browser retained channel is unavailable');
        channel = await open.call(this.protocol, record.tabId,
          (method, params) => {
            if (record.generation !== generation || Date.now() >= record.expiresAt || record.state.kind === 'closed' || record.state.kind === 'expired' || record.state.kind === 'closing' || record.state.kind === 'cleanup_failed') return;
            if (!allowProtected && observesProtectedBrowserPage(method, params)) throw new Error('Protected browser observations require explicit confirmation');
            const observation = browserDebugObservation(method, params);
            if (observation !== null) record.buffer.push(observation);
          },
          (closureConfirmed) => {
            if (record.generation !== generation) return;
            if (record.state.kind === 'active' || record.state.kind === 'cleanup_failed') {
              const terminal = record.state.kind === 'cleanup_failed' ? record.state.terminal : null;
              record.gap = true;
              record.state = closureConfirmed ? { kind: terminal ?? 'disconnected' } : { kind: 'cleanup_failed', channel: record.state.channel, terminal };
            }
          }, controller.signal);
        for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) await channel.request(domain, domain === 'Network.enable' ? { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 } : {}, controller.signal);
        if (controller.signal.aborted || this.closed || Date.now() >= record.expiresAt) throw new Error('Browser subscription startup cancelled');
        record.state = { kind: 'active', channel };
        return ok(this.receipt(record));
      } catch (error) {
        record.gap = true;
        if (error instanceof BrowserCdpChannelCleanupError) channel = error.channel;
        if (channel !== null) {
          try { await channel.close(); } catch { record.state = { kind: 'cleanup_failed', channel, terminal: null }; return err(appError('INTERNAL_ERROR', 'Browser subscription cleanup was not confirmed', true)); }
        }
        record.state = { kind: 'disconnected' };
        return controller.signal.aborted ? cancelled() : err(appError('INTERNAL_ERROR', 'Browser observation subscription could not be established', true));
      } finally { signal?.removeEventListener('abort', abort); }
    });
    record.state = { kind: record.generation === 1 ? 'starting' : 'reconnecting', controller, completion: run.then(() => undefined) };
    return run;
  }

  private async closeRecord(record: StreamRecord, terminal: 'closed' | 'expired'): Promise<Result<unknown>> {
    if (record.state.kind === 'expired') return ok(this.receipt(record));
    if (terminal === 'expired') {
      if (record.timer !== null) { clearTimeout(record.timer); record.timer = null; }
      record.buffer = new BoundedEventBuffer(1, 1);
    }
    const state = record.state;
    if (state.kind === 'starting' || state.kind === 'reconnecting') {
      state.controller.abort();
      await state.completion;
      return this.closeRecord(record, terminal);
    }
    if (state.kind === 'closing') {
      try { await state.completion; } catch { return err(appError('INTERNAL_ERROR', 'Browser subscription cleanup was not confirmed', true)); }
      return this.closeRecord(record, terminal);
    }
    if (state.kind === 'active' || state.kind === 'cleanup_failed') {
      const completion = Promise.resolve().then(() => state.channel.close());
      record.state = { kind: 'closing', channel: state.channel, completion };
      try { await completion; } catch {
        record.gap = true;
        record.state = { kind: 'cleanup_failed', channel: state.channel, terminal };
        return err(appError('INTERNAL_ERROR', 'Browser subscription cleanup was not confirmed', true));
      }
    }
    record.state = { kind: terminal };
    return ok(this.receipt(record));
  }

  private receipt(record: StreamRecord): Readonly<Record<string, unknown>> {
    const page = record.buffer.read('0', 1, 1);
    return {
      stream_id: record.id, tab_id: record.tabId, state: record.state.kind,
      source: 'chrome_devtools_protocol', subscribed_domains: ['Runtime', 'Log', 'Network'],
      expires_at: new Date(record.expiresAt).toISOString(),
      latest_cursor: page.latestCursor, retained_bytes: page.retainedBytes, dropped_events: page.droppedEvents,
      gap: record.gap || page.gap,
      completeness: isTerminal(record.state) && record.state.kind !== 'closed' ? 'unavailable' : record.gap || page.gap ? 'partial_after_gap' : 'observed_since_subscription',
      history_before_subscription: 'unavailable', headers_retained: false, bodies_retained: false,
    };
  }
}

export function parseBrowserStreamRequest(input: unknown): Result<BrowserStreamRequest> {
  if (!isRecord(input) || !isRecord(input.parameters)) return err(appError('INVALID_INPUT', 'Browser stream input is invalid'));
  const owner = parseOwner(input);
  if (!owner.ok) return owner;
  const params = input.parameters;
  const operation = params.operation;
  if (!['start', 'read', 'status', 'close', 'reconnect'].includes(typeof operation === 'string' ? operation : '')) return err(appError('INVALID_INPUT', 'Browser stream operation is invalid'));
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') return err(appError('INVALID_INPUT', 'Browser stream dry-run flag is invalid'));
  const dryRun = input.dry_run === true;
  const tabId = input.tab_id;
  if (tabId !== undefined && !validIdentity(tabId)) return err(appError('INVALID_INPUT', 'Browser stream tab ID is invalid'));
  if (operation === 'start') {
    if (typeof tabId !== 'string') return err(appError('INVALID_INPUT', 'Starting browser observations requires an explicit tab_id'));
    if (!onlyKeys(params, ['operation', 'max_events', 'max_bytes', 'ttl_seconds'])) return err(appError('INVALID_INPUT', 'Browser stream start fields are invalid'));
    const maxEvents = boundedInteger(params.max_events, 1000, 1, 1000);
    const maxBytes = boundedInteger(params.max_bytes, 1_048_576, 1, 2_097_152);
    const ttlSeconds = boundedNumber(params.ttl_seconds, 300, 0.1, 900);
    if (maxEvents === null || maxBytes === null || ttlSeconds === null) return err(appError('INVALID_INPUT', 'Browser stream retention limits are invalid'));
    return ok({ operation, owner: owner.value, tabId, maxEvents, maxBytes, ttlSeconds, dryRun });
  }
  if (typeof params.stream_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(params.stream_id)) return err(appError('INVALID_INPUT', 'Browser stream ID is invalid'));
  const base = { owner: owner.value, streamId: params.stream_id, ...(typeof tabId === 'string' ? { tabId } : {}), dryRun };
  if (operation === 'read') {
    if (!onlyKeys(params, ['operation', 'stream_id', 'after_cursor', 'limit', 'max_bytes'])) return err(appError('INVALID_INPUT', 'Browser event page fields are invalid'));
    const afterCursor = params.after_cursor ?? '0';
    const limit = boundedInteger(params.limit, 100, 1, 1000);
    const maxBytes = boundedInteger(params.max_bytes, 65_536, 1, 2_097_152);
    if (typeof afterCursor !== 'string' || !/^(?:0|[1-9]\d*)$/.test(afterCursor) || afterCursor.length > 16 || limit === null || maxBytes === null) return err(appError('INVALID_INPUT', 'Browser event page bounds are invalid'));
    return ok({ operation, ...base, afterCursor, limit, maxBytes });
  }
  if (operation !== 'status' && operation !== 'close' && operation !== 'reconnect') return err(appError('INVALID_INPUT', 'Browser stream operation is invalid'));
  if (!onlyKeys(params, ['operation', 'stream_id'])) return err(appError('INVALID_INPUT', 'Browser stream fields are invalid'));
  return ok({ operation, ...base });
}

function parseOwner(input: Record<string, unknown>): Result<CapabilityTaskOwner> {
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const owner = metadata?.[CAPABILITY_TASK_OWNER_METADATA_KEY];
  if (!isRecord(owner) || !validIdentity(owner.clientId) || !validIdentity(owner.sessionId) || owner.workspaceId !== undefined && !validIdentity(owner.workspaceId)) return err(appError('INVALID_INPUT', 'Trusted browser stream owner metadata is required'));
  return ok({ clientId: owner.clientId, sessionId: owner.sessionId, ...(typeof owner.workspaceId === 'string' ? { workspaceId: owner.workspaceId } : {}) });
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !value.includes('\0');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  const candidate = value ?? fallback;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= min && candidate <= max ? candidate : null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number | null {
  const candidate = value ?? fallback;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= min && candidate <= max ? candidate : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isTerminal(state: StreamState): boolean { return state.kind === 'closed' || state.kind === 'expired' || state.kind === 'disconnected'; }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Browser observation operation was cancelled', true)); }
