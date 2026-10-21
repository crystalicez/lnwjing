import { MAX_PROCESS_LOG_BYTES } from '@lnwjing/domain';
import type { LogQuery, ProcessLogEntry, ProcessLogResult, ProcessLogStream } from './process-types.js';

const DEFAULT_MAX_BYTES = MAX_PROCESS_LOG_BYTES;

export class LogRingBuffer {
  private readonly entries: ProcessLogEntry[] = [];
  private sequence = 0;
  private bytes = 0;
  private evicted = false;

  public constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  public append(stream: ProcessLogStream, text: string): void {
    const chunks = text.split(/(?<=\n)/).filter((chunk) => chunk.length > 0);
    for (const chunk of chunks) this.appendChunk(stream, chunk);
  }

  public read(query: LogQuery): ProcessLogResult {
    const sinceSequence = query.sinceSequence ?? 0;
    let entries = this.entries.filter((entry) => entry.sequence > sinceSequence);
    if (query.tailLines !== undefined) entries = entries.slice(-query.tailLines);
    const oldest = this.entries[0]?.sequence;
    const cursorMissedEvicted = oldest !== undefined && query.sinceSequence !== undefined && oldest > sinceSequence + 1;
    return {
      entries,
      truncated: this.evicted || cursorMissedEvicted,
      nextSequence: this.sequence,
    };
  }

  public compact(maxBytes: number): void {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    while (this.entries.length > 0 && this.bytes > limit) {
      const first = this.entries[0]!;
      const firstBytes = Buffer.byteLength(first.text, 'utf8');
      const excess = this.bytes - limit;
      if (firstBytes <= excess) {
        this.entries.shift();
        this.bytes -= firstBytes;
      } else {
        const bytes = Buffer.from(first.text, 'utf8');
        let start = excess;
        while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
        const text = bytes.subarray(start).toString('utf8');
        this.entries[0] = { ...first, text };
        this.bytes += Buffer.byteLength(text, 'utf8') - firstBytes;
      }
      this.evicted = true;
    }
  }

  private appendChunk(stream: ProcessLogStream, input: string): void {
    let text = input;
    let size = Buffer.byteLength(text, 'utf8');
    if (size > this.maxBytes) {
      text = Buffer.from(text, 'utf8').subarray(-this.maxBytes).toString('utf8');
      size = Buffer.byteLength(text, 'utf8');
      this.evicted = true;
    }
    while (this.entries.length > 0 && this.bytes + size > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed.text, 'utf8');
      this.evicted = true;
    }
    this.sequence += 1;
    this.entries.push({ sequence: this.sequence, stream, text });
    this.bytes += size;
  }
}
