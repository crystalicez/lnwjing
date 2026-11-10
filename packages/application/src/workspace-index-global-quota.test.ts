import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JsonWorkspaceIndexStore, type WorkspaceIndexQuotaReservation, type WorkspaceIndexQuota,
  type WorkspaceIndexSnapshot,
} from './workspace-index.js';

const snapshot = (workspaceId: string, label: string): WorkspaceIndexSnapshot => ({
  version: 1, discoveryPolicyRevision: 1, workspaceId, rootPath: 'C:\\Projects\\fixture',
  indexedAt: '2026-11-10T00:00:00.000Z', entries: [{
    relativePath: 'src/main.ts', kind: 'file', size: 12, mtimeMs: 1,
    contentHash: null, gitBlobSha: null, language: 'typescript', isTest: false,
    symbols: [label], imports: [], exports: [], functions: [], classes: [],
    interfaces: [], indexedAt: '2026-11-10T00:00:00.000Z',
  }],
});

describe('JSON workspace index opt-in global quota admission', () => {
  it('reserves complete atomic snapshot plus metadata capacity before writing, then releases', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-quota-ok-'));
    try {
      const events: string[] = [];
      const quota: WorkspaceIndexQuota = {
        reserve: async (bytes): Promise<WorkspaceIndexQuotaReservation> => {
          events.push('reserve');
          expect(bytes).toBeGreaterThan(64 * 1024);
          expect(await readdir(directory)).not.toContain('project.json');
          return { id: '1', token: 'test', bytes };
        },
        release: () => { events.push('release'); },
      };
      const store = new JsonWorkspaceIndexStore(directory, () => quota);
      await store.withMutation('project', (mutate) => mutate.save(snapshot('project', 'fresh')));
      expect(events).toEqual(['reserve', 'release']);
      const loaded = await store.load('project');
      expect(loaded?.entries[0]?.symbols).toEqual(['fresh']);
      const files = await readdir(directory);
      expect(files).toContain('project.json');
      expect(files).toContain('project.json.meta.json');
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps existing index unchanged when quota admission rejects a replacement', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-quota-denied-'));
    try {
      let enabled = false;
      const quota: WorkspaceIndexQuota = {
        reserve: async (): Promise<WorkspaceIndexQuotaReservation> => {
          throw new Error('Global storage quota has insufficient unreserved space');
        },
        release: () => { throw new Error('Unreserved write released'); },
      };
      const store = new JsonWorkspaceIndexStore(directory, () => enabled ? quota : null);
      await store.withMutation('project', (mutate) => mutate.save(snapshot('project', 'original')));
      const original = await readFile(path.join(directory, 'project.json'), 'utf8');
      enabled = true;
      await expect(store.withMutation('project', (mutate) => mutate.save(snapshot('project', 'denied'))))
        .rejects.toThrow(/insufficient unreserved/);
      expect(await readFile(path.join(directory, 'project.json'), 'utf8')).toBe(original);
      expect((await readdir(directory)).some((f) => f.endsWith('.tmp'))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('never attempts a quota-unreserved sidecar regeneration on a read', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-quota-read-'));
    try {
      const plain = new JsonWorkspaceIndexStore(directory);
      await plain.withMutation('project', (mutate) => mutate.save(snapshot('project', 'initial')));
      await rm(path.join(directory, 'project.json.meta.json'));
      const quota: WorkspaceIndexQuota = {
        reserve: async (): Promise<WorkspaceIndexQuotaReservation> => { throw new Error('read path must not reserve'); },
        release: () => { throw new Error('read path must not release'); },
      };
      const protectedStore = new JsonWorkspaceIndexStore(directory, () => quota);
      const metadata = await protectedStore.loadMetadata('project');
      expect(metadata?.workspaceId).toBe('project');
      await expect(stat(path.join(directory, 'project.json.meta.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
