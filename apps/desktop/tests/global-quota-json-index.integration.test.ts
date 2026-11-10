import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GlobalStorageQuotaReservations } from '@lnwjing/storage';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

describe('real Desktop global quota for default JSON workspace index', () => {
  it('keeps the previous index when admission is denied and recovers after capacity increases', async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-desktop-index-quota-'));
    const source = path.join(profile, '..', path.basename(profile) + '-source');
    await mkdir(source);
    const runtime = createDesktopRuntime(profile, { checkpointEncryptionKey: Buffer.alloc(32, 83) });
    try {
      const sourceFile = path.join(source, 'index.ts');
      await writeFile(sourceFile, 'export const first = true;');
      const workspaceId = await runtime.ensureDefaultWorkspace(source);
      const index = runtime.mcpServices.workspaceIndex;
      const initial = await index.indexWorkspace(workspaceId);
      expect(initial.ok).toBe(true);
      const filename = path.join(profile, 'workspace-index', encodeURIComponent(workspaceId) + '.json');
      const original = await readFile(filename, 'utf8');
      const quota = new GlobalStorageQuotaReservations(profile);
      // Profile includes protected SQLite, so a tiny cap blocks new staged
      // index writes without requiring a large synthetic file on the SSD.
      quota.configure({ limitBytes: 64 * 1024, criticalReserveBytes: 1024 });
      await writeFile(sourceFile, 'export const second = true;');
      const blocked = await index.indexWorkspace(workspaceId, { rebuild: true });
      expect(blocked.ok).toBe(false);
      expect(await readFile(filename, 'utf8')).toBe(original);
      expect((await readdir(path.dirname(filename))).some((f) => f.endsWith('.tmp'))).toBe(false);
      expect(quota.status()?.activeReservations).toBe(0);
      const projectedUsage = (await quota.inspect()).logicalUsedBytes;
      expect(projectedUsage).toBeGreaterThan(0);
      quota.configure({ limitBytes: projectedUsage + 4 * 1024 * 1024, criticalReserveBytes: 1024 });
      const committed = await index.indexWorkspace(workspaceId, { rebuild: true });
      expect(committed.ok).toBe(true);
      const updated = await readFile(filename, 'utf8');
      expect(updated).toContain('second');
      expect(quota.status()?.activeReservations).toBe(0);
    } finally {
      await runtime.close();
      await rm(profile, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  }, 30_000);
});
