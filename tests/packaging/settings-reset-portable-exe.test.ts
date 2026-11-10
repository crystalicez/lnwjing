import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const candidate = path.join(root, '.audit', 'settings-reset-portable-candidate');
const executable = path.join(candidate, 'lnwjing-Portable-5.8.7.exe');
const runtimePattern = /^lnwjing-runtime-v5\.8\.7-[A-Za-z0-9_-]+$/;

async function runtimes(): Promise<string[]> {
  return (await readdir(candidate, { withFileTypes: true }))
    .filter(item => item.isDirectory() && runtimePattern.test(item.name))
    .map(item => item.name);
}

async function execTestOwnedPortable(
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const child = spawn(executable, [
    '--mcp-stdio', '--mcp-stdio-profile-init', '--disable-gpu', '--disable-background-networking',
  ], { env: environment, cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-3500); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Isolated Portable startup timed out')), 100_000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', exitCode => { clearTimeout(deadline); resolve(exitCode); });
    });
    return { code, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

describe('actual test-owned Windows Portable outer EXE', () => {
  it.skipIf(process.platform !== 'win32')(
    'extracts a verified packaged runtime and refuses to bypass a pending reset across two cold starts',
    async () => {
      expect(existsSync(executable)).toBe(true);
      const binary = await stat(executable);
      expect(binary.isFile()).toBe(true);
      expect(binary.size).toBeGreaterThan(4 * 1024 * 1024);
      const before = new Set(await runtimes());
      const audit = path.join(root, '.audit');
      await mkdir(audit, { recursive: true });
      const fixture = await mkdtemp(path.join(audit, 'settings-reset-outer-exe-'));
      const profile = path.join(fixture, 'profile');
      const roam = path.join(fixture, 'roaming');
      const local = path.join(fixture, 'local');
      const temp = path.join(fixture, 'temp');
      await Promise.all([profile, roam, local, temp].map(async directory => mkdir(directory)));
      const env = {
        ...process.env,
        LNWJING_DATA_PATH: profile,
        APPDATA: roam,
        LOCALAPPDATA: local,
        TEMP: temp,
        TMP: temp,
        LNWJING_E2E_FIXTURE: '1',
        LNWJING_E2E_NODE_PATH: process.execPath,
        LNWJING_WORKSPACE: '',
      };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        const first = await execTestOwnedPortable(env);
        expect(first.code, first.stderr).toBe(0);
        const keyFile = path.join(profile, 'checkpoint-master.key');
        const digest = createHash('sha256').update(await readFile(keyFile)).digest('hex');
        const extracted = (await runtimes()).filter(name => !before.has(name));
        expect(extracted).toHaveLength(1);
        const folder = path.join(candidate, extracted[0]!);
        const marker = (await readFile(path.join(folder, '.lnwjing-ready'), 'utf8')).trim();
        expect(marker).toBe(extracted[0]!.replace('lnwjing-runtime-', 'lnwjing-'));
        for (const filename of ['lnwjing.exe', 'lnwjing-mcp-stdio-bridge.exe', path.join('resources', 'app.asar')]) {
          expect((await stat(path.join(folder, filename))).isFile()).toBe(true);
        }
        const readyMtime = (await stat(path.join(folder, '.lnwjing-ready'))).mtimeMs;

        const pending = path.join(fixture, '.profile.factory-reset.pending');
        await writeFile(pending, JSON.stringify({
          version: 2, mode: 'preserve-settings', nonce: '00000000-0000-4000-8000-000000000001',
        }));
        const blocked = await execTestOwnedPortable(env);
        expect(blocked.code, blocked.stderr).not.toBe(0);
        expect(existsSync(pending)).toBe(true);
        expect(createHash('sha256').update(await readFile(keyFile)).digest('hex')).toBe(digest);

        await rm(pending, { force: true });
        const after = await execTestOwnedPortable(env);
        expect(after.code, after.stderr).toBe(0);
        expect(createHash('sha256').update(await readFile(keyFile)).digest('hex')).toBe(digest);
        expect((await stat(path.join(folder, '.lnwjing-ready'))).mtimeMs).toBe(readyMtime);
      } finally {
        await rm(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
        // Only test-created extracted folders in the isolated .audit candidate
        // are eligible for cleanup. Never touch the user's active Portable.
        for (const name of await runtimes()) {
          if (before.has(name)) continue;
          const folder = path.join(candidate, name);
          const expected = name.replace('lnwjing-runtime-', 'lnwjing-');
          const marker = (await readFile(path.join(folder, '.lnwjing-ready'), 'utf8').catch(() => '')).trim();
          if (marker !== expected) continue;
          await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
        }
      }
    },
    300_000,
  );
});
