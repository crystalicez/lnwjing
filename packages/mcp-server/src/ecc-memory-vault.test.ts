import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EccMemoryVaultService } from './ecc-memory-vault.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspaceFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-memory-'));
  roots.push(root);
  return root;
}

describe('ECC Memory Vault compatibility', () => {
  it('saves create-only unreviewed project memory and recalls it through bounded lexical search/read', async () => {
    const workspaceRoot = await workspaceFixture();
    const vault = new EccMemoryVaultService({ now: (): Date => new Date('2026-09-14T01:00:00.000Z') });

    const saved = await vault.save({
      workspaceRoot,
      scope: 'project',
      title: 'Authentication migration handoff',
      body: 'Token rotation tests pass. Continue the authentication migration.',
      kind: 'handoff',
      sourceHarness: 'lnwjing',
      targetHarnesses: ['codex'],
      tags: ['auth', 'migration'],
    });

    expect(saved).toMatchObject({ schema: 'ecc.memory.v1', trust: 'unreviewed', status: 'active', scope: 'project', kind: 'handoff' });
    const gitignore = await readFile(path.join(workspaceRoot, '.ecc', 'memory', '.gitignore'), 'utf8');
    expect(gitignore).toBe('project/\n');

    const search = await vault.search({ workspaceRoot, query: 'authentication migration', targetHarness: 'codex' });
    expect(search.diagnostics).toEqual([]);
    expect(search.memories).toHaveLength(1);
    expect(search.memories[0]?.id).toBe(saved.id);
    expect(search.memories[0]).not.toHaveProperty('body');

    const read = await vault.read({ workspaceRoot, id: saved.id });
    expect(read.body).toContain('Token rotation tests pass');
    expect(read.trust).toBe('unreviewed');
  });

  it('rejects suspected secrets and keeps user scope explicitly disabled by default', async () => {
    const workspaceRoot = await workspaceFixture();
    const vault = new EccMemoryVaultService();

    await expect(vault.save({ workspaceRoot, scope: 'project', title: 'credential', body: 'ghp_123456789012345678901234567890' }))
      .rejects.toThrow('suspected secret material');
    await expect(vault.save({ scope: 'user', title: 'user note', body: 'safe' }))
      .rejects.toThrow('user memory scope is disabled');
  });

  it('reports malformed documents and fails direct reads closed when the authorized vault is incomplete', async () => {
    const workspaceRoot = await workspaceFixture();
    const vault = new EccMemoryVaultService({ now: (): Date => new Date('2026-09-14T01:00:00.000Z') });
    const saved = await vault.save({ workspaceRoot, scope: 'project', title: 'Known fact', body: 'Verified local fact.', kind: 'fact' });
    const malformedDirectory = path.join(workspaceRoot, '.ecc', 'memory', 'project', 'notes');
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(path.join(malformedDirectory, 'broken.md'), 'not-frontmatter', 'utf8');

    const doctor = await vault.doctor({ workspaceRoot });
    expect(doctor.healthy).toBe(false);
    expect(doctor.issues.some((issue) => issue.includes('missing strict frontmatter'))).toBe(true);
    await expect(vault.read({ workspaceRoot, id: saved.id })).rejects.toThrow('vault is incomplete');
  });
});
