import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonWorkspaceIndexStore, type WorkspaceIndexEntry, type WorkspaceIndexSnapshot,
} from './workspace-index.js';
import { SqliteWorkspaceIndexStore } from './workspace-index-sqlite.js';

const temporary: string[] = [];
const indexedAt = '2026-10-23T00:00:00.000Z';
function entry(relativePath: string): WorkspaceIndexEntry {
  return {
    relativePath, kind: 'file', size: 100, mtimeMs: 100,
    ctimeMs: 100, birthtimeMs: 100,
    contentHash: 'a'.repeat(64), gitBlobSha: 'b'.repeat(40), language: 'typescript',
    isTest: false, symbols: ['original'], imports: [], exports: [],
    functions: [], classes: [], interfaces: [], indexedAt,
  };
}
function snapshot(entries: readonly WorkspaceIndexEntry[]): WorkspaceIndexSnapshot {
  return {
    version: 1, discoveryPolicyRevision: 1, workspaceId: 'shared',
    rootPath: path.join(os.tmpdir(), 'lnwjing-preview-root'), indexedAt, entries,
  };
}
async function fixture(): Promise<{ directory: string; legacy: JsonWorkspaceIndexStore; sqlite: SqliteWorkspaceIndexStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-sqlite-index-preview-'));
  temporary.push(directory);
  return {
    directory,
    legacy: new JsonWorkspaceIndexStore(directory),
    sqlite: new SqliteWorkspaceIndexStore(directory),
  };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('opt-in SQLite workspace index persistence', () => {
  it('imports existing JSON without rewriting it, then updates only the changed entry', async () => {
    const { directory, legacy, sqlite } = await fixture();
    const original = snapshot([entry('a.ts'), entry('b.ts')]);
    await legacy.withMutation('shared', (store) => store.save(original));
    const jsonFile = path.join(directory, 'shared.json');
    const jsonBefore = await stat(jsonFile);

    expect(await sqlite.load('shared')).toEqual(original);
    expect(await sqlite.loadMetadata('shared')).toMatchObject({
      workspaceId: 'shared', entryCount: 2, automaticCoverage: true,
    });
    const sqliteFile = path.join(directory, 'shared.sqlite');
    const observer = new DatabaseSync(sqliteFile);
    observer.exec(`
      CREATE TABLE mutation_audit (relative_path TEXT NOT NULL);
      CREATE TRIGGER entry_updated AFTER UPDATE ON entries
      BEGIN INSERT INTO mutation_audit (relative_path) VALUES (NEW.relative_path); END;
      CREATE TRIGGER entry_inserted AFTER INSERT ON entries
      BEGIN INSERT INTO mutation_audit (relative_path) VALUES (NEW.relative_path); END;
      CREATE TRIGGER entry_removed AFTER DELETE ON entries
      BEGIN INSERT INTO mutation_audit (relative_path) VALUES (OLD.relative_path); END;
    `);
    observer.close();

    const updated: WorkspaceIndexEntry = {
      ...entry('a.ts'), mtimeMs: 200, contentHash: 'c'.repeat(64),
      indexedAt: '2026-10-23T00:01:00.000Z', symbols: ['updated'],
    };
    await sqlite.withMutation('shared', async (scope) => {
      const previous = await scope.load();
      expect(previous).toEqual(original);
      await scope.save(snapshot([updated, entry('b.ts')]));
    });
    const reader = new DatabaseSync(sqliteFile, { readOnly: true });
    const writes = reader.prepare('SELECT relative_path FROM mutation_audit ORDER BY rowid').all();
    reader.close();
    expect(writes).toEqual([{ relative_path: 'a.ts' }]);
    expect((await sqlite.load('shared'))?.entries.find((item) => item.relativePath === 'a.ts')?.symbols).toEqual(['updated']);
    expect(await legacy.load('shared')).toEqual(original);
    expect((await stat(jsonFile)).mtimeMs).toBe(jsonBefore.mtimeMs);
  });

  it('rolls back invalid updates and forgets SQLite entries without resurrecting a legacy backup', async () => {
    const { legacy, sqlite } = await fixture();
    const original = snapshot([entry('a.ts')]);
    await legacy.withMutation('shared', (store) => store.save(original));
    expect(await sqlite.load('shared')).toEqual(original);
    await expect(sqlite.withMutation('shared', async (scope) => {
      await scope.save(snapshot([entry('a.ts'), entry('a.ts')]));
    })).rejects.toThrow('Duplicate workspace index paths');
    expect(await sqlite.load('shared')).toEqual(original);

    await sqlite.withMutation('shared', (scope) => scope.delete());
    expect(await sqlite.load('shared')).toBeNull();
    expect(await sqlite.loadMetadata('shared')).toBeNull();
    expect(await legacy.load('shared')).toEqual(original);
  });

  it('serializes updates from independent SQLite store instances on one workspace', async () => {
    const { directory, sqlite } = await fixture();
    const other = new SqliteWorkspaceIndexStore(directory);
    await sqlite.withMutation('shared', (scope) => scope.save(snapshot([entry('a.ts')])));
    const modify = async (store: SqliteWorkspaceIndexStore, addition: string): Promise<void> => {
      await store.withMutation('shared', async (scope) => {
        const previous = await scope.load();
        if (previous === null) throw new Error('Missing index');
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        await scope.save(snapshot([...previous.entries, entry(addition)].sort((a, b) => a.relativePath.localeCompare(b.relativePath))));
      });
    };
    await Promise.all([modify(sqlite, 'b.ts'), modify(other, 'c.ts')]);
    expect((await sqlite.load('shared'))?.entries.map((item) => item.relativePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('fails closed if a JSON-mode process changes the legacy index after SQLite import', async () => {
    const { legacy, sqlite } = await fixture();
    await legacy.withMutation('shared', (scope) => scope.save(snapshot([entry('a.ts')])));
    expect((await sqlite.load('shared'))?.entries).toHaveLength(1);
    await legacy.withMutation('shared', (scope) => scope.save(snapshot([entry('b.ts')])));
    await expect(sqlite.load('shared')).rejects.toThrow('Mixed JSON/SQLite workspace index writers');
    await expect(sqlite.loadMetadata('shared')).rejects.toThrow('Mixed JSON/SQLite workspace index writers');
    await expect(sqlite.withMutation('shared', (scope) => scope.save(snapshot([entry('c.ts')]))))
      .rejects.toThrow('Mixed JSON/SQLite workspace index writers');
    expect((await legacy.load('shared'))?.entries[0]?.relativePath).toBe('b.ts');
  });
});
