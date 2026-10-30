import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWindowsLiveOwnerContention, SQLITE_LIFECYCLE_LOCK_FILENAME, withSqliteLifecycleLockSync } from './sqlite-lifecycle-lock.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('SQLite lifecycle lock ownership', () => {
  it.skipIf(process.platform !== 'win32')('recognizes Windows access denial only for a live owner lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-life-access-denied-'));
    roots.push(root);
    const filename = path.join(root, SQLITE_LIFECYCLE_LOCK_FILENAME);
    const denied = { code: 'EPERM' };
    const accessDenied = { code: 'EACCES' };
    expect(isWindowsLiveOwnerContention(denied, filename)).toBe(false);
    await writeFile(filename, JSON.stringify({ pid: process.pid, ownerId: 'live-owner' }));
    expect(isWindowsLiveOwnerContention(denied, filename)).toBe(true);
    expect(isWindowsLiveOwnerContention(accessDenied, filename)).toBe(true);
    expect(isWindowsLiveOwnerContention({ code: 'ENOSPC' }, filename)).toBe(false);
    await writeFile(filename, 'unreadable owner');
    expect(isWindowsLiveOwnerContention(denied, filename)).toBe(false);
    await writeFile(filename, JSON.stringify({ pid: 2147483647 }));
    expect(isWindowsLiveOwnerContention(denied, filename)).toBe(false);
  });

  it('never steals an aged lock while its owner process is still alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-life-live-'));
    roots.push(root);
    const filename = path.join(root, SQLITE_LIFECYCLE_LOCK_FILENAME);
    await writeFile(filename, JSON.stringify({ pid: process.pid, acquiredAt: '2020-01-01T00:00:00Z' }));
    const aged = new Date(Date.now() - 31 * 60_000);
    await utimes(filename, aged, aged);
    const moduleUrl = new URL('./sqlite-lifecycle-lock.ts', import.meta.url).href;
    const childCode = `import { withSqliteLifecycleLockSync } from ${JSON.stringify(moduleUrl)}; const start = Date.now(); withSqliteLifecycleLockSync(process.argv[1], () => process.stdout.write(String(Date.now() - start)));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve); child.once('error', reject);
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(existsSync(filename)).toBe(true);
      expect(stdout).toBe('');
    } finally {
      await rm(filename, { force: true });
    }
    expect(await finished).toBe(0);
    expect(stderr.replace(/\(node:\d+\) ExperimentalWarning:[^\n]*\n/g, '')).toBe('');
    expect(Number(stdout)).toBeGreaterThanOrEqual(200);
  }, 10_000);

  it('serializes three competing Windows processes without overlapping lock ownership', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-life-three-processes-'));
    roots.push(root);
    const journal = path.join(root, 'ordered.txt');
    const moduleUrl = new URL('./sqlite-lifecycle-lock.ts', import.meta.url).href;
    const childCode = `import { appendFileSync } from 'node:fs';
      import { withSqliteLifecycleLockSync } from ${JSON.stringify(moduleUrl)};
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      withSqliteLifecycleLockSync(process.argv[1], () => {
        appendFileSync(process.argv[2], process.argv[3] + ':enter\\n');
        Atomics.wait(sleep, 0, 0, 35);
        appendFileSync(process.argv[2], process.argv[3] + ':leave\\n');
      });`;
    const children = ['one', 'two', 'three'].map((name) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, root, journal, name], {
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const finished = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Lock contender ${name} exited ${code}: ${stderr}`));
        });
      });
      return { child, finished };
    });
    try {
      await Promise.all(children.map((item) => item.finished));
      const lines = (await readFile(journal, 'utf8')).trim().split(/\r?\n/);
      expect(lines).toHaveLength(6);
      let active: string | null = null;
      for (const line of lines) {
        const [name, phase] = line.split(':');
        if (phase === 'enter') {
          expect(active).toBeNull();
          active = name ?? null;
        } else {
          expect(phase).toBe('leave');
          expect(name).toBe(active);
          active = null;
        }
      }
      expect(active).toBeNull();
      expect(existsSync(path.join(root, SQLITE_LIFECYCLE_LOCK_FILENAME))).toBe(false);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
    }
  }, 12_000);

  it('does not release a successor lock if the original pathname was replaced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-life-owner-'));
    roots.push(root);
    const lock = path.join(root, SQLITE_LIFECYCLE_LOCK_FILENAME);
    withSqliteLifecycleLockSync(root, () => {
      rmSync(lock);
      writeFileSync(lock, JSON.stringify({ pid: process.pid, ownerId: 'successor' }));
    });
    expect(JSON.parse(await readFile(lock, 'utf8'))).toMatchObject({ ownerId: 'successor' });
  });

  it('reclaims a stale lock after proving its owner PID is dead', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-life-dead-'));
    roots.push(root);
    const lock = path.join(root, SQLITE_LIFECYCLE_LOCK_FILENAME);
    await writeFile(lock, JSON.stringify({ pid: 2147483647, acquiredAt: '2020-01-01' }));
    expect(withSqliteLifecycleLockSync(root, () => 'acquired')).toBe('acquired');
  });
});
