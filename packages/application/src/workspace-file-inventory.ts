import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { acquireDiskScanLease, classifyContextPath, type ContextDiscoveryMode } from '@lnwjing/search';
import { isHostPathWithin } from '@lnwjing/workspace';

interface InventoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
}

interface InventoryFrame {
  readonly relativePath: string;
  entries?: readonly InventoryEntry[];
  offset: number;
}

export interface FileInventoryCursor {
  readonly rootPath: string;
  readonly frames: InventoryFrame[];
  pending?: string;
}

export interface FileInventoryPage {
  readonly paths: readonly string[];
  readonly cursor?: FileInventoryCursor;
}

const MAX_INVENTORY_FRAME_BYTES = 16 * 1024 * 1024;

export function inventoryCursorWeight(cursor: FileInventoryCursor): number {
  let bytes = 256;
  for (const frame of cursor.frames) {
    bytes += 128 + 2 * frame.relativePath.length;
    for (const entry of frame.entries ?? []) bytes += 64 + 2 * entry.name.length;
  }
  return bytes;
}

/**
 * Lazy, one-pass filename discovery. No content reads, open descriptors kept
 * between MCP calls, background traversal, or disk-backed continuation cache.
 */
export async function nextFileInventoryPage(
  rootPath: string,
  cursor: FileInventoryCursor | undefined,
  pageSize: number,
  discovery: ContextDiscoveryMode,
  allowPath: (relativePath: string) => boolean,
  glob?: string,
  signal?: AbortSignal,
): Promise<Result<FileInventoryPage>> {
  if (cursor !== undefined && cursor.rootPath !== rootPath) {
    return err(appError('INVALID_INPUT', 'Inventory cursor does not match the search root'));
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    return err(appError('INVALID_INPUT', 'Inventory page size is invalid'));
  }
  const lease = await acquireDiskScanLease(rootPath, signal);
  if (lease.status !== 'granted') {
    return lease.status === 'aborted'
      ? err(appError('PROCESS_TIMEOUT', 'Inventory scan was cancelled', true))
      : err(appError('CONFLICT', 'Disk scan is busy', true));
  }
  try {
    signal?.throwIfAborted();
    const state: FileInventoryCursor = cursor ?? {
      rootPath, frames: [{ relativePath: '', offset: 0 }],
    };
    const paths: string[] = [];
    // Fetch one extra match so an exact page boundary never creates a
    // misleading empty final continuation page.
    while (paths.length <= pageSize) {
      signal?.throwIfAborted();
      if (state.pending !== undefined) {
        const pending = state.pending;
        delete state.pending;
        if (paths.length === pageSize) {
          state.pending = pending;
          break;
        }
        paths.push(pending);
        continue;
      }
      const frame = state.frames.at(-1);
      if (frame === undefined) break;
      if (frame.entries === undefined) {
        const directory = path.join(rootPath, frame.relativePath);
        // Directory entries may have changed since the prior page. Never
        // follow a replaced junction/symlink outside the approved root.
        if (!isHostPathWithin(rootPath, await realpath(directory))) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Inventory directory resolves outside the search root'));
        }
        const entries: InventoryEntry[] = [];
        let reservedBytes = inventoryCursorWeight(state);
        // Read directory entries incrementally. A pathological single directory
        // cannot allocate an unbounded Dirent[] before the memory check.
        for await (const entry of await opendir(directory)) {
          signal?.throwIfAborted();
          if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
          reservedBytes += 64 + 2 * entry.name.length;
          if (reservedBytes > MAX_INVENTORY_FRAME_BYTES) {
            return err({ code: 'CONFLICT', message: 'A directory inventory exceeds the in-memory budget; narrow the scan path', recoverable: true, details: { reason: 'memory_budget' } });
          }
          entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        frame.entries = entries;
      }
      const entry = frame.entries[frame.offset];
      if (entry === undefined) {
        state.frames.pop();
        continue;
      }
      frame.offset += 1;
      const relative = frame.relativePath.length === 0 ? entry.name : path.join(frame.relativePath, entry.name);
      if (!allowPath(relative) || (discovery === 'automatic' && !classifyContextPath(relative, discovery).discoverable)) continue;
      if (entry.type === 'directory') {
        state.frames.push({ relativePath: relative, offset: 0 });
        continue;
      }
      if (glob !== undefined) {
        const negative = glob.startsWith('!');
        const pattern = negative ? glob.slice(1) : glob;
        const matched = path.matchesGlob(relative, pattern) || path.matchesGlob(entry.name, pattern);
        if (negative ? matched : !matched) continue;
      }
      if (paths.length === pageSize) {
        state.pending = relative;
        break;
      }
      paths.push(relative);
    }
    return ok({ paths, ...(state.pending !== undefined || state.frames.length > 0 ? { cursor: state } : {}) });
  } catch {
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Inventory scan was cancelled', true));
    return err(appError('INTERNAL_ERROR', 'Inventory could not be read', true));
  } finally {
    await lease.release();
  }
}
