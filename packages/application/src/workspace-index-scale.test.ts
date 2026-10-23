import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  type WorkspaceIndexEntry, type WorkspaceIndexSnapshot,
} from './workspace-index.js';
import { SqliteWorkspaceIndexStore } from './workspace-index-sqlite.js';

const RUN_SCALE = process.env.LNWJING_RUN_INDEX_SCALE === '1';
const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../../..', '.audit');
const ENTRY_COUNT = 30_001;
const PROJECT_COUNT = 3;
const LOGICAL_BYTES = 21 * 1024 * 1024 * 1024;
const timestamp = '2026-10-23T00:00:00.000Z';

function makeEntry(index: number): WorkspaceIndexEntry {
  return {
    relativePath: `src/file-${String(index).padStart(5, '0')}.ts`,
    kind: 'file', size: index === 0 ? LOGICAL_BYTES : 64,
    mtimeMs: index, ctimeMs: index, birthtimeMs: 1,
    contentHash: null, gitBlobSha: null, language: 'typescript',
    isTest: false, symbols: [], imports: [], exports: [],
    functions: [], classes: [], interfaces: [], indexedAt: timestamp,
  };
}

describe.skipIf(!RUN_SCALE)('opt-in large multi-project SQLite index stress (synthetic metadata)', () => {
  it('stores and isolates three >30k-entry, >20GiB-logical workspaces without materializing source trees', async () => {
    // This measures large *index metadata*, not 20 GiB of physical source files.
    // The generated state is fully disposable and uses a small amount of disk.
    await mkdir(FIXTURE_ROOT, { recursive: true });
    const directory = await mkdtemp(path.join(FIXTURE_ROOT, 'lnwjing-30k-index-'));
    const store = new SqliteWorkspaceIndexStore(path.join(directory, 'index'));
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) => makeEntry(index));
    const measurements: Array<{ project: string; initialMs: number; updateMs: number; sqliteBytes: number }> = [];
    try {
      await mkdir(path.join(directory, 'index'), { recursive: true });
      for (let project = 0; project < PROJECT_COUNT; project += 1) {
        const workspaceId = `scale-${project}`;
        const snapshot: WorkspaceIndexSnapshot = {
          version: 1, discoveryPolicyRevision: 1, workspaceId,
          rootPath: path.join(directory, workspaceId), indexedAt: timestamp,
          entries,
        };
        const initial = performance.now();
        await store.withMutation(workspaceId, (scope) => scope.save(snapshot));
        const initialMs = performance.now() - initial;
        expect((await store.loadMetadata(workspaceId))?.entryCount).toBe(ENTRY_COUNT);
        const updatedEntry = { ...entries[100 + project], symbols: [`changed-${project}`] };
        const changed = [...entries];
        changed[100 + project] = updatedEntry;
        const updatedSnapshot = { ...snapshot, entries: changed };
        const update = performance.now();
        await store.withMutation(workspaceId, (scope) => scope.save(updatedSnapshot));
        const updateMs = performance.now() - update;
        const loaded = await store.load(workspaceId);
        expect(loaded?.entries).toHaveLength(ENTRY_COUNT);
        expect(loaded?.entries[100 + project]?.symbols).toEqual([`changed-${project}`]);
        expect(loaded?.entries[0]?.size).toBe(LOGICAL_BYTES);
        const sqliteBytes = (await stat(path.join(directory, 'index', `${workspaceId}.sqlite`))).size;
        measurements.push({ project: workspaceId, initialMs, updateMs, sqliteBytes });
      }
      for (let project = 0; project < PROJECT_COUNT; project += 1) {
        const stored = await store.load(`scale-${project}`);
        expect(stored?.entries[100 + project]?.symbols).toEqual([`changed-${project}`]);
        expect(stored?.entries[100 + (project + 1) % PROJECT_COUNT]?.symbols).toEqual([]);
      }
      if (process.env.LNWJING_SCALE_REPORT === '1') {
        console.info('INDEX_SCALE_SYNTHETIC_REPORT', JSON.stringify({
          workspaceCount: PROJECT_COUNT, indexedEntriesPerWorkspace: ENTRY_COUNT,
          logicalFileSizeBytes: LOGICAL_BYTES, physicalSourceFiles: 0, measurements,
        }));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
