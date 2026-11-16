import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pages = 256;
const bytesPerPage = 4096;
interface WriterResult { readonly successful: number; readonly full: number; readonly busy: number; readonly pageCount: number }

function runWriter(file: string, id: number): Promise<WriterResult> {
  // Four independent Node processes use separate SQLite connections, with a
  // small physical fixture. These are cooperative writers: each sets its cap.
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const file = process.argv[1], id = process.argv[2], cap = Number(process.argv[3]);",
    "const db = new DatabaseSync(file, { timeout: 2000 });",
    "try {",
    " db.exec('PRAGMA max_page_count=' + cap);",
    " const insert = db.prepare('INSERT INTO pressure_fixture(writer, payload) VALUES (?, ?)');",
    " let successful = 0, full = 0, busy = 0;",
    " for (let i = 0; i < 500; i++) {",
    "  try { insert.run(id, 'x'.repeat(1024) + i); successful++; }",
    "  catch (error) {",
    "   if (String(error).includes('SQLITE_FULL') || String(error).includes('database or disk is full')) { full++; break; }",
    "   if (String(error).includes('SQLITE_BUSY') || String(error).includes('database is locked')) { busy++; continue; }",
    "   throw error;",
    "  }",
    " }",
    " const pageCount = db.prepare('PRAGMA page_count').get().page_count;",
    " process.stdout.write(JSON.stringify({ successful, full, busy, pageCount }));",
    "} finally { db.close(); }",
  ].join('\n');
  return new Promise<WriterResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, file, String(id), String(pages)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (data: Buffer): void => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer): void => { stderr += data.toString(); });
    const deadline = setTimeout(() => { child.kill(); reject(new Error('SQLite concurrent writer deadline exceeded')); }, 12_000);
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (code !== 0) { reject(new Error('SQLite child failed: ' + stderr.slice(0, 500))); return; }
      try { resolve(JSON.parse(stdout) as WriterResult); }
      catch { reject(new Error('Invalid concurrent SQLite writer result: ' + stdout)); }
    });
  });
}

describe('cooperative multi-process SQLite main-page quota', () => {
  it('does not exceed the page cap with four concurrent bounded writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-shared-page-cap-'));
    const file = path.join(root, 'fixture.sqlite');
    const database = new DatabaseSync(file);
    try {
      database.exec('PRAGMA journal_mode=WAL');
      database.exec('CREATE TABLE pressure_fixture (id INTEGER PRIMARY KEY, writer TEXT, payload TEXT)');
      database.exec('PRAGMA max_page_count=' + pages);
      const results = await Promise.all([0, 1, 2, 3].map((index) => runWriter(file, index)));
      const pageCount = (database.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
      const count = (database.prepare('SELECT count(*) as count FROM pressure_fixture').get() as { count: number }).count;
      expect(results.reduce((sum, row) => sum + row.successful, 0)).toBe(count);
      expect(results.reduce((sum, row) => sum + row.full, 0)).toBeGreaterThan(0);
      expect(pageCount).toBeLessThanOrEqual(pages);
      expect(results.every((row) => row.pageCount <= pages)).toBe(true);
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(statSync(file).size).toBeLessThanOrEqual(pages * bytesPerPage);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
