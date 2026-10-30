import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const stagedCandidate = process.env.LNWJING_PORTABLE_TEST_STAGED === '1';
const portable = stagedCandidate ? path.join(root, 'apps', 'desktop', 'dist', 'installers') : path.join(root, 'portable');
const executable = path.join(portable, 'lnwjing-Portable-5.8.7.exe');

describe.skipIf(process.platform !== 'win32' || process.env.LNWJING_RUN_PORTABLE_EXE_LIVE !== '1')(
  'real Windows Portable EXE isolated startup',
  () => {
    it('extracts a verified runtime and initializes MCP without using the live profile', async () => {
      const preexisting = new Set((await readdir(portable, { withFileTypes: true }))
        .filter(item => item.isDirectory() && /^lnwjing-runtime-v5\\.8\\.7-[A-Za-z0-9_-]+$/.test(item.name))
        .map(item => item.name));
      const auditRoot = path.join(root, '.audit');
      await mkdir(auditRoot, { recursive: true });
      const fixture = await mkdtemp(path.join(auditRoot, 'portable-exe-'));
      const env = {
        ...process.env,
        LNWJING_DATA_PATH: path.join(fixture, 'data'),
        APPDATA: path.join(fixture, 'roaming'),
        LOCALAPPDATA: path.join(fixture, 'local'),
        TEMP: path.join(fixture, 'temp'),
        TMP: path.join(fixture, 'temp'),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      await Promise.all([env.LNWJING_DATA_PATH, env.APPDATA, env.LOCALAPPDATA, env.TEMP].map(
        directory => mkdir(directory, { recursive: true }),
      ));
      const run = async (): Promise<void> => {
        const child = spawn(executable, [
          '--mcp-stdio', '--mcp-stdio-profile-init', '--disable-gpu',
          '--disable-background-networking',
        ], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-3000); });
        try {
          const exit = await new Promise<number | null>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Portable startup deadline exceeded')), 120_000);
            child.once('error', error => { clearTimeout(deadline); reject(error); });
            child.once('exit', code => { clearTimeout(deadline); resolve(code); });
          });
          expect(exit, stderr).toBe(0);
        } finally {
          if (child.exitCode === null) child.kill();
        }
      };
      try {
        await run();
        const runtimes = (await readdir(portable, { withFileTypes: true }))
          .filter(item => item.isDirectory() && /^lnwjing-runtime-v5\.8\.7-[A-Za-z0-9_-]+$/.test(item.name));
        const ready = [];
        for (const item of runtimes) {
          const directory = path.join(portable, item.name);
          const marker = (await readFile(path.join(directory, '.lnwjing-ready'), 'utf8').catch(() => '')).trim();
          if (marker !== item.name.replace('lnwjing-runtime-', 'lnwjing-')) continue;
          ready.push(directory);
        }
        expect(ready.length).toBeGreaterThan(0);
        const runtime = ready[ready.length - 1]!;
        for (const file of [
          'lnwjing.exe', 'lnwjing-mcp-stdio-bridge.exe',
          path.join('resources', 'app.asar'),
          path.join('resources', 'runtime-tools', 'ripgrep', 'rg.exe'),
          path.join('resources', 'tunnel-client', 'tunnel-client.exe'),
        ]) expect((await stat(path.join(runtime, file))).isFile()).toBe(true);
        const marker = path.join(runtime, '.lnwjing-ready');
        const before = (await stat(marker)).mtimeMs;
        await run();
        expect((await stat(marker)).mtimeMs).toBe(before);
        console.info('PORTABLE_VERIFIED_RUNTIME=' + runtime);
      } finally {
        await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
        if (stagedCandidate) {
          // Only remove newly extracted, verified test-owned runtimes. Never
          // touch an existing release cache or the user's installed profile.
          for (const item of await readdir(portable, { withFileTypes: true })) {
            if (!item.isDirectory() || preexisting.has(item.name) ||
              !/^lnwjing-runtime-v5\\.8\\.7-[A-Za-z0-9_-]+$/.test(item.name)) continue;
            const folder = path.join(portable, item.name);
            const marker = await readFile(path.join(folder, '.lnwjing-ready'), 'utf8').catch(() => '');
            if (marker.trim() !== item.name.replace('lnwjing-runtime-', 'lnwjing-')) continue;
            await rm(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
          }
        }
      }
    }, 180_000);
  },
);
