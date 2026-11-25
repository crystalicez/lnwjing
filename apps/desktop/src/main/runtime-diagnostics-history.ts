import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RuntimeDiagnosticsErrorClass {
  readonly code: string;
  readonly count: number;
}

export interface RuntimeDiagnosticsSample {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly sessionId: string | null;
  readonly uptimeSeconds: number;
  readonly memory: {
    readonly rssBytes: number;
    readonly heapTotalBytes: number;
    readonly heapUsedBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
    readonly totalWorkingSetBytes: number;
    readonly desktopProcessCount: number;
    readonly byProcessType: Readonly<Record<string, { readonly count: number; readonly workingSetBytes: number; readonly privateBytes: number; readonly percentCPUUsage: number }>>;
  };
  readonly system: {
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
  };
  readonly cpu: {
    readonly userMicros: number;
    readonly systemMicros: number;
  };
  readonly eventLoop: {
    readonly idleMs: number;
    readonly activeMs: number;
    readonly utilization: number;
  };
  readonly activeResources: Readonly<Record<string, number>>;
  /** Aggregate in-process rg admission metrics. No paths, queries or credentials are retained. */
  readonly search?: {
    readonly active: number;
    readonly queued: number;
    readonly peakActive: number;
    readonly started: number;
    readonly finished: number;
    readonly rejected: number;
    readonly cancelled: number;
    readonly totalExecutionMs: number;
  };
  readonly logs: {
    readonly totalLines: number;
    readonly totalRetainedBytes: number;
    readonly seenMcpDeliveries: number;
    readonly mcpOccurrences: number;
    readonly tailPendingBytes: number;
    readonly sources: Readonly<Record<string, { readonly lines: number; readonly retainedBytes: number; readonly seenKeys: number }>>;
  };
  readonly mcp: {
    readonly toolAvailabilityListeners: number;
    readonly calls: number;
    readonly completed: number;
    readonly successes: number;
    readonly errors: number;
    readonly cancellations: number;
    readonly active: number;
    readonly recentErrorClasses: readonly RuntimeDiagnosticsErrorClass[];
    readonly inFlightByTool: Readonly<Record<string, number>>;
  };
}

export interface RuntimeDiagnosticsHistory {
  readonly schemaVersion: 1;
  readonly intervalMs: number;
  readonly maxSamples: number;
  readonly samples: readonly RuntimeDiagnosticsSample[];
}

export interface RuntimeDiagnosticsRecorderOptions {
  readonly intervalMs?: number;
  readonly maxSamples?: number;
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 60_000;
// Persist 5 minutes of periodic samples per disk write while keeping all
// 1-minute readings in memory. Explicit incident captures persist immediately.
const PERIODIC_PERSIST_EVERY = 5;
const DEFAULT_MAX_SAMPLES = 360;
const LEGACY_HISTORY_FILE = 'runtime-history.json';
const HISTORY_FILE = 'runtime-history.jsonl';
// Amortize rewrites: at most one hour of extra samples on disk.
const MAX_APPEND_SAMPLES = 60;

export class RuntimeDiagnosticsHistoryRecorder {
  public readonly filePath: string;
  private readonly intervalMs: number;
  private readonly maxSamples: number;
  private readonly now: () => Date;
  private samples: RuntimeDiagnosticsSample[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private unflushedSamples = 0;
  private appendedSamples = 0;
  // On every restart, atomically compact the recovered history first.
  // This also repairs a torn trailing append without losing earlier samples.
  private needsRewrite = true;

  public constructor(
    dataPath: string,
    private readonly collect: () => Omit<RuntimeDiagnosticsSample, 'schemaVersion' | 'capturedAt'>,
    options: RuntimeDiagnosticsRecorderOptions = {},
  ) {
    this.filePath = path.join(dataPath, 'diagnostics', HISTORY_FILE);
    this.intervalMs = Math.max(5_000, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS));
    this.maxSamples = Math.min(DEFAULT_MAX_SAMPLES, Math.max(1, Math.trunc(options.maxSamples ?? DEFAULT_MAX_SAMPLES)));
    this.now = options.now ?? ((): Date => new Date());
    this.samples = [...(readRuntimeDiagnosticsHistory(dataPath)?.samples ?? [])].slice(-this.maxSamples);
  }

  public start(): void {
    if (this.timer !== null) return;
    this.captureNow();
    this.timer = setInterval(() => { this.captureNow(false); }, this.intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.unflushedSamples > 0) {
      try { this.persist(); this.unflushedSamples = 0; } catch { /* Diagnostics must not block shutdown. */ }
    }
  }

  public captureNow(persistImmediately: boolean = true): boolean {
    try {
      const sample: RuntimeDiagnosticsSample = {
        schemaVersion: 1,
        capturedAt: this.now().toISOString(),
        ...this.collect(),
      };
      this.samples.push(sample);
      if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
      this.unflushedSamples += 1;
      if (persistImmediately || this.unflushedSamples >= PERIODIC_PERSIST_EVERY) {
        this.persist();
        this.unflushedSamples = 0;
      }
      return true;
    } catch {
      return false;
    }
  }

  public snapshot(): RuntimeDiagnosticsHistory {
    return { schemaVersion: 1, intervalMs: this.intervalMs, maxSamples: this.maxSamples, samples: [...this.samples] };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const compact = this.needsRewrite || this.appendedSamples + this.unflushedSamples >= Math.min(MAX_APPEND_SAMPLES, this.maxSamples);
    if (!compact) {
      try {
        const batch = { schemaVersion: 1, intervalMs: this.intervalMs, maxSamples: this.maxSamples,
          samples: this.samples.slice(-this.unflushedSamples) };
        // Do not silently create a suffix-only journal if maintenance removed
        // the existing one. Without O_CREAT, ENOENT goes to full compaction.
        const fd = openSync(this.filePath, constants.O_WRONLY | constants.O_APPEND);
        try { appendFileSync(fd, JSON.stringify(batch) + '\n', 'utf8'); }
        finally { closeSync(fd); }
        this.appendedSamples += this.unflushedSamples;
        return;
      } catch (error) {
        // An append may have partially succeeded. Never append after that tail.
        this.needsRewrite = true;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const tempPath = this.filePath + '.' + process.pid + '.tmp';
    try {
      writeFileSync(tempPath, JSON.stringify(this.snapshot()) + '\n', 'utf8');
      renameSync(tempPath, this.filePath);
      this.needsRewrite = false;
      this.appendedSamples = 0;
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }
}

export function readRuntimeDiagnosticsHistory(dataPath: string): RuntimeDiagnosticsHistory | null {
  const directory = path.join(dataPath, 'diagnostics');
  // Each complete line is an independent batch. A crash can only tear the
  // final line; ignore it rather than discarding the previously durable trend.
  try {
    const lines = readFileSync(path.join(directory, HISTORY_FILE), 'utf8').split('\n');
    lines.pop(); // only newline-terminated records are committed
    let history: RuntimeDiagnosticsHistory | null = null;
    let samples: RuntimeDiagnosticsSample[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { break; }
      if (!isRuntimeDiagnosticsHistory(parsed)) break;
      const maxSamples = Math.min(DEFAULT_MAX_SAMPLES, Math.max(1, Math.trunc(parsed.maxSamples)));
      samples = [...samples, ...parsed.samples].slice(-maxSamples);
      history = { schemaVersion: 1, intervalMs: parsed.intervalMs, maxSamples, samples };
    }
    if (history !== null) return history;
  } catch { /* Fall back to the legacy snapshot during migration. */ }
  try {
    const parsed = JSON.parse(readFileSync(path.join(directory, LEGACY_HISTORY_FILE), 'utf8')) as unknown;
    if (!isRuntimeDiagnosticsHistory(parsed)) return null;
    const maxSamples = Math.min(DEFAULT_MAX_SAMPLES, Math.max(1, Math.trunc(parsed.maxSamples)));
    return { ...parsed, maxSamples, samples: parsed.samples.slice(-maxSamples) };
  } catch {
    return null;
  }
}

function isRuntimeDiagnosticsHistory(value: unknown): value is RuntimeDiagnosticsHistory {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schemaVersion?: unknown; intervalMs?: unknown; maxSamples?: unknown; samples?: unknown };
  return candidate.schemaVersion === 1
    && typeof candidate.intervalMs === 'number'
    && Number.isFinite(candidate.intervalMs)
    && typeof candidate.maxSamples === 'number'
    && Number.isFinite(candidate.maxSamples)
    && Array.isArray(candidate.samples)
    && candidate.samples.every(isRuntimeDiagnosticsSample);
}

function isRuntimeDiagnosticsSample(value: unknown): value is RuntimeDiagnosticsSample {
  if (!isRecord(value)) return false;
  const memory = value.memory;
  const system = value.system;
  const cpu = value.cpu;
  const eventLoop = value.eventLoop;
  const logs = value.logs;
  const mcp = value.mcp;
  if (!isRecord(memory) || !isRecord(system) || !isRecord(cpu) || !isRecord(eventLoop) || !isRecord(logs) || !isRecord(mcp)) return false;

  return value.schemaVersion === 1
    && typeof value.capturedAt === 'string'
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && isFiniteNumber(value.uptimeSeconds)
    && isFiniteNumber(memory.rssBytes)
    && isFiniteNumber(memory.heapTotalBytes)
    && isFiniteNumber(memory.heapUsedBytes)
    && isFiniteNumber(memory.externalBytes)
    && isFiniteNumber(memory.arrayBuffersBytes)
    && isFiniteNumber(memory.totalWorkingSetBytes)
    && isFiniteNumber(memory.desktopProcessCount)
    && isProcessTypeMetrics(memory.byProcessType)
    && isFiniteNumber(system.totalMemoryBytes)
    && isFiniteNumber(system.freeMemoryBytes)
    && isFiniteNumber(cpu.userMicros)
    && isFiniteNumber(cpu.systemMicros)
    && isFiniteNumber(eventLoop.idleMs)
    && isFiniteNumber(eventLoop.activeMs)
    && isFiniteNumber(eventLoop.utilization)
    && isNumberRecord(value.activeResources)
    && isFiniteNumber(logs.totalLines)
    && isFiniteNumber(logs.totalRetainedBytes)
    && isFiniteNumber(logs.seenMcpDeliveries)
    && isFiniteNumber(logs.mcpOccurrences)
    && isFiniteNumber(logs.tailPendingBytes)
    && isLogSourceMetrics(logs.sources)
    && isFiniteNumber(mcp.toolAvailabilityListeners)
    && isFiniteNumber(mcp.calls)
    && isFiniteNumber(mcp.completed)
    && isFiniteNumber(mcp.successes)
    && isFiniteNumber(mcp.errors)
    && isFiniteNumber(mcp.cancellations)
    && isFiniteNumber(mcp.active)
    && isErrorClasses(mcp.recentErrorClasses)
    && isNumberRecord(mcp.inFlightByTool);
}

function isProcessTypeMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isRecord(entry)
    && isFiniteNumber(entry.count)
    && isFiniteNumber(entry.workingSetBytes)
    && isFiniteNumber(entry.privateBytes)
    && isFiniteNumber(entry.percentCPUUsage));
}

function isLogSourceMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isRecord(entry)
    && isFiniteNumber(entry.lines)
    && isFiniteNumber(entry.retainedBytes)
    && isFiniteNumber(entry.seenKeys));
}

function isErrorClasses(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && typeof entry.code === 'string'
    && isFiniteNumber(entry.count));
}

function isNumberRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
