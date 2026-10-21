import type { LogLine } from '@lnwjing/ipc-contracts';

const DEFAULT_MAX_RETAINED_BYTES = 24 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const SERIALIZED_BYTES = new WeakMap<LogLine, number>();

export function applyLogSnapshot(
  previous: readonly LogLine[],
  previousIds: ReadonlySet<number>,
  snapshotLines: readonly LogLine[],
  maxLines = 30_000,
  maxBytes = DEFAULT_MAX_RETAINED_BYTES,
): { readonly lines: LogLine[]; readonly ids: Set<number> } {
  const byId = new Map<number, LogLine>();
  for (const line of previous) byId.set(line.id, line);
  for (const line of snapshotLines) {
    if (!byId.has(line.id)) byId.set(line.id, line);
  }
  const lines = retainNewest([...byId.values()].sort((left, right) => left.id - right.id), maxLines, maxBytes);
  const ids = new Set(previousIds);
  for (const line of lines) ids.add(line.id);
  pruneLogIds(ids, maxLines * 2);
  return { lines, ids };
}

/**
 * Append an already de-duplicated live batch with one array copy per flush,
 * instead of copying the entire retained log buffer once per incoming IPC line.
 */
export function appendLogBatch(
  previous: readonly LogLine[],
  batch: readonly LogLine[],
  maxLines = 30_000,
  maxBytes = DEFAULT_MAX_RETAINED_BYTES,
): LogLine[] {
  if (batch.length === 0) return [...previous];
  const existingIds = new Set(previous.map((line) => line.id));
  const additions = batch.filter((line) => !existingIds.has(line.id));
  if (additions.length === 0) return [...previous];
  return retainNewest([...previous, ...additions], maxLines, maxBytes);
}

/**
 * Track recent pushed log ids without allowing a long desktop session to grow
 * the de-duplication Set forever. Set insertion order gives us a cheap FIFO.
 */
export function rememberLogId(ids: Set<number>, id: number, maxIds = 60_000): boolean {
  if (ids.has(id)) return false;
  ids.add(id);
  pruneLogIds(ids, maxIds);
  return true;
}

function pruneLogIds(ids: Set<number>, maxIds: number): void {
  while (ids.size > maxIds) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

function retainNewest(lines: readonly LogLine[], maxLines: number, maxBytes: number): LogLine[] {
  const lineLimit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 0;
  const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const retained: LogLine[] = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0 && retained.length < lineLimit; index -= 1) {
    const line = lines[index]!;
    const lineBytes = serializedLogLineBytes(line);
    if (retainedBytes + lineBytes > byteLimit) break;
    retained.push(line);
    retainedBytes += lineBytes;
  }
  retained.reverse();
  return retained;
}

function serializedLogLineBytes(line: LogLine): number {
  const cached = SERIALIZED_BYTES.get(line);
  if (cached !== undefined) return cached;
  const bytes = UTF8_ENCODER.encode(JSON.stringify(line)).byteLength;
  SERIALIZED_BYTES.set(line, bytes);
  return bytes;
}
