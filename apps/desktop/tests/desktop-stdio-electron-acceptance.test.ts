import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  type JSONRPCRequest,
  type JSONRPCResponse,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { GlobalStorageQuotaReservations } from '@lnwjing/storage';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const packagedExe = process.env.LNWJING_STDIO_PACKAGED_EXE?.trim();
const installedLauncher = process.env.LNWJING_STDIO_LAUNCHER_CMD?.trim();
const electron = packagedExe === undefined || packagedExe.length === 0
  ? path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve(packagedExe);
const entry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const privateRoot = path.join(repoRoot, '.audit');
const modernVersion = '2026-07-28';

function requestMetadata(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: modernVersion,
    [CLIENT_INFO_META_KEY]: { name: 'lnwjing-windows-stdio-acceptance', version: '0.1.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

async function request(
  transport: StdioClientTransport,
  id: number,
  method: string,
  args: Record<string, unknown>,
): Promise<JSONRPCResponse> {
  return new Promise((resolve, reject) => {
    const previous = transport.onmessage;
    const timer = setTimeout(() => {
      transport.onmessage = previous;
      reject(new Error('MCP response deadline exceeded: ' + method));
    }, 8_000);
    transport.onmessage = (message, extra): void => {
      if (message.id !== id || !('result' in message || 'error' in message)) {
        previous?.(message, extra);
        return;
      }
      clearTimeout(timer);
      transport.onmessage = previous;
      resolve(message as JSONRPCResponse);
    };
    const payload: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...args, _meta: requestMetadata() },
    };
    void transport.send(payload).catch((error: unknown) => {
      clearTimeout(timer);
      transport.onmessage = previous;
      reject(error);
    });
  });
}

function responseData(response: JSONRPCResponse): Record<string, unknown> {
  if ('error' in response) throw new Error('MCP error ' + response.error.code + ': ' + response.error.message);
  if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
    throw new Error('MCP returned an invalid result object');
  }
  return response.result as Record<string, unknown>;
}

describe.skipIf(process.platform !== 'win32' || process.env.LNWJING_RUN_ELECTRON_STDIO !== '1')(
  'Windows Console bridge → Electron MCP STDIO acceptance (isolated)',
  () => {
    for (const launchMode of packagedExe ? ['bridge', 'cmd-launcher'] : ['bridge']) {
    it(`discovers modern MCP, lists tools and searches one source file via ${launchMode}`, async () => {
      const root = await mkdtemp(path.join(privateRoot, 'electron-stdio-'));
      const workspace = path.join(root, 'workspace');
      const data = path.join(root, 'data');
      const roaming = path.join(root, 'roaming');
      const local = path.join(root, 'local');
      const temp = path.join(root, 'temp');
      await Promise.all([workspace, data, roaming, local, temp].map(p => mkdir(p, { recursive: true })));
      await writeFile(path.join(workspace, 'file-00.ts'), 'export const known_needle_12345 = true;\n', { flag: 'wx' });
      await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(
        path.join(workspace, `sample-${String(i).padStart(3, '0')}.ts`),
        `export const sample_${i} = ${i}; ${i % 8 === 0 ? '// daily_workflow_search_fixture' : ''}\n`,
        { flag: 'wx' },
      )));
      const env = {
        ...process.env,
        LNWJING_DATA_PATH: data,
        LNWJING_WORKSPACE: workspace,
        LNWJING_INDEX_SQLITE_PREVIEW: '0',
        APPDATA: roaming,
        LOCALAPPDATA: local,
        TEMP: temp,
        TMP: temp,
        PATH: path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep') + path.delimiter + (process.env.PATH ?? ''),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const runViaCmd = launchMode === 'cmd-launcher';
      const transport = new StdioClientTransport({
        command: runViaCmd ? 'cmd.exe' : packagedExe === undefined || packagedExe.length === 0
          ? path.join(desktopRoot, 'build', 'lnwjing-mcp-stdio-bridge.exe')
          : path.join(path.dirname(electron), 'lnwjing-mcp-stdio-bridge.exe'),
        args: runViaCmd
          ? ['/d', '/c', installedLauncher || path.join(path.dirname(electron), 'lnwjing-mcp-stdio.cmd'), '--workspace', workspace, '--disable-gpu', '--disable-background-networking']
          : [electron, ...(packagedExe === undefined || packagedExe.length === 0 ? [entry] : []), '--mcp-stdio', '--workspace', workspace, '--disable-gpu', '--disable-background-networking'],
        cwd: desktopRoot,
        env,
        stderr: 'pipe',
      });
      let diagnostics = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + String(chunk)).slice(-2500);
      });
      try {
        await transport.start();
        const discovery = responseData(await request(transport, 1, 'server/discover', {}));
        expect(discovery.supportedVersions).toContain(modernVersion);
        const tools = responseData(await request(transport, 2, 'tools/list', {}));
        const names = (tools.tools as Array<{ name: string }>).map(tool => tool.name);
        expect(names).toContain('search_text');
        const match = responseData(await request(transport, 3, 'tools/call', {
          name: 'search_text',
          arguments: { path: workspace, query: 'known_needle_12345', maxResults: 3 },
        }));
        if (match.isError === true) throw new Error('Search returned MCP error: ' + JSON.stringify(match).slice(0, 800));
        expect(JSON.stringify(match)).toContain('file-00.ts');
        const many = responseData(await request(transport, 4, 'tools/call', {
          name: 'search_text', arguments: { path: workspace, query: 'daily_workflow_search_fixture', maxResults: 20 },
        }));
        expect(many.isError).not.toBe(true);
        expect(JSON.stringify(many)).toContain('sample-000.ts');
        expect(JSON.stringify(many)).toContain('sample-056.ts');
        const before = responseData(await request(transport, 5, 'tools/call', {
          name: 'read_file', arguments: { path: path.join(workspace, 'file-00.ts') },
        }));
        expect(JSON.stringify(before)).toContain('known_needle_12345 = true');
        const edited = responseData(await request(transport, 6, 'tools/call', {
          name: 'edit_file',
          arguments: { path: path.join(workspace, 'file-00.ts'), oldText: 'known_needle_12345 = true',
            newText: 'known_needle_12345 = false', userConfirmed: true },
        }));
        expect(edited.isError).not.toBe(true);
        const after = responseData(await request(transport, 7, 'tools/call', {
          name: 'read_file', arguments: { path: path.join(workspace, 'file-00.ts') },
        }));
        expect(JSON.stringify(after)).toContain('known_needle_12345 = false');
      } catch (error) {
        throw new Error('Windows Electron MCP STDIO acceptance failed: ' + String(error) + '; diagnostics: ' + diagnostics, { cause: error });
      } finally {
        await Promise.race([
          transport.close().catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 5_000)),
        ]);
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    }, 30_000);
    }
    // A fresh Windows profile must bootstrap its OSCrypt key before two
    // Electron processes independently initialize safeStorage.
    for (const mode of ['sequential', 'warmed', 'cold'] as const) {
    it.skipIf(mode === 'cold' && process.env.LNWJING_RUN_MULTI_STDIO_SIMULATION !== '1')(
      mode === 'sequential' ? 'preserves safeStorage across real Electron STDIO process restarts'
        : mode === 'warmed' ? 'shares a warmed profile across two live Electron STDIO processes'
          : 'shares a cold profile across two live Electron STDIO processes', async () => {
      const sequential = mode === 'sequential';
      const root = await mkdtemp(path.join(privateRoot, 'electron-stdio-concurrent-'));
      const workspace = path.join(root, 'workspace');
      const data = path.join(root, 'data');
      const roaming = path.join(root, 'roaming');
      const local = path.join(root, 'local');
      const temp = path.join(root, 'temp');
      await Promise.all([workspace, data, roaming, local, temp].map(p => mkdir(p, { recursive: true })));
      const filenames = Array.from({ length: 96 }, (_, i) => path.join(workspace, `file-${String(i).padStart(3, '0')}.ts`));
      await Promise.all(filenames.map((filename, i) => writeFile(filename,
        i === 0 ? 'export const shared_fixture_alpha = 1;\n' :
          `export const fixture_${i} = ${i}; ${i % 12 === 0 ? '// realistic_needle_alpha' : ''}\n`,
        { flag: 'wx' })));
      const env = {
        ...process.env,
        LNWJING_DATA_PATH: data,
        LNWJING_WORKSPACE: workspace,
        LNWJING_INDEX_SQLITE_PREVIEW: '0',
        APPDATA: roaming,
        LOCALAPPDATA: local,
        TEMP: temp,
        TMP: temp,
        PATH: path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep') + path.delimiter + (process.env.PATH ?? ''),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      function launch(): StdioClientTransport {
        return new StdioClientTransport({
          command: packagedExe ? path.join(path.dirname(electron), 'lnwjing-mcp-stdio-bridge.exe')
            : path.join(desktopRoot, 'build', 'lnwjing-mcp-stdio-bridge.exe'),
          args: [electron, ...(packagedExe ? [] : [entry]), '--mcp-stdio', '--workspace', workspace,
            '--disable-gpu', '--disable-background-networking'],
          cwd: desktopRoot,
          env,
          stderr: 'pipe',
        });
      }
      const first = launch();
      const second = launch();
      let localStateKeyBefore: string | null = null;
      const localStateFingerprint = async (): Promise<string | null> => {
        try {
          const state = JSON.parse(await readFile(path.join(data, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } };
          if (!state.os_crypt?.encrypted_key) return null;
          return createHash('sha256').update(state.os_crypt.encrypted_key).digest('hex');
        } catch { return null; }
      };
      let diagnostics = '';
      for (const client of [first, second]) {
        client.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
      }
      try {
        if (mode === 'warmed') {
          const warmup = launch();
          try {
            await warmup.start();
            responseData(await request(warmup, 1, 'tools/list', {}));
          } finally {
            await warmup.close();
          }
        }
        const listed = await (async (): Promise<Record<string, unknown>[]> => {
          if (mode === 'cold') {
            await Promise.all([first.start(), second.start()]);
            return Promise.all([first, second].map(async client =>
              responseData(await request(client, 1, 'tools/list', {}))));
          }
          await first.start();
          const firstCatalog = responseData(await request(first, 1, 'tools/list', {}));
          localStateKeyBefore = await localStateFingerprint();
          if (sequential) await first.close();
          await second.start();
          const secondCatalog = responseData(await request(second, 1, 'tools/list', {}));
          return [firstCatalog, secondCatalog];
        })();
        for (const catalog of listed) {
          const names = (catalog.tools as Array<{ name: string }>).map(tool => tool.name);
          expect(names).toContain('search_text');
          expect(names).toContain('read_file');
        }
        if (sequential) {
          const reopened = responseData(await request(second, 2, 'tools/call', {
            name: 'search_text', arguments: { path: workspace, query: 'realistic_needle_alpha', maxResults: 20 },
          }));
          expect(reopened.isError).not.toBe(true);
          expect(JSON.stringify(reopened)).toContain('file-084.ts');
          return;
        }
        const matches = await Promise.all([first, second].map(async client =>
          responseData(await request(client, 2, 'tools/call', {
            name: 'search_text',
            arguments: { path: workspace, query: 'realistic_needle_alpha', maxResults: 20 },
          }))));
        for (const match of matches) {
          expect(match.isError).not.toBe(true);
          expect(JSON.stringify(match)).toContain('file-012.ts');
          expect(JSON.stringify(match)).toContain('file-084.ts');
        }
        const previous = responseData(await request(second, 3, 'tools/call', {
          name: 'read_file', arguments: { path: filenames[0] },
        }));
        expect(JSON.stringify(previous)).toContain('shared_fixture_alpha = 1');

        // A direct MCP edit exercises writer admission, not just a host-side
        // change that bypasses the actual user's mutation path.
        const edited = responseData(await request(first, 3, 'tools/call', {
          name: 'edit_file',
          arguments: { path: filenames[0], oldText: 'shared_fixture_alpha = 1',
            newText: 'shared_fixture_alpha = 2', userConfirmed: true },
        }));
        expect(edited.isError).not.toBe(true);
        const updated = responseData(await request(second, 4, 'tools/call', {
          name: 'read_file', arguments: { path: filenames[0] },
        }));
        expect(JSON.stringify(updated)).toContain('shared_fixture_alpha = 2');
      } catch (error) {
        const dataEntries = (await readdir(data)).sort().filter(name => !name.endsWith('.secret'));
        let cipherFormat = 'unavailable';
        try {
          const envelope = JSON.parse(Buffer.from((await readFile(path.join(data, 'checkpoint-master.key'), 'utf8'))
            .trim().slice('safe:v1:'.length), 'base64').toString('utf8')) as { payload?: string };
          const cipher = Buffer.from(envelope.payload ?? '', 'base64');
          cipherFormat = cipher.subarray(0, 3).toString('ascii') + '/' + cipher.byteLength;
        } catch { /* only format diagnostics; no keys or ciphertext leave the fixture */ }
        const localStateKeyAfter = await localStateFingerprint();
        throw new Error('Concurrent real Electron STDIO simulation failed: ' + String(error)
          + '; local-state key before/after: ' + (localStateKeyBefore === null ? 'missing' : 'present') + '/'
          + (localStateKeyAfter === null ? 'missing' : localStateKeyAfter === localStateKeyBefore ? 'same' : 'changed')
          + '; ciphertext format: ' + cipherFormat + '; profile files: ' + dataEntries.join(',')
          + '; diagnostics: ' + diagnostics, { cause: error });
      } finally {
        await Promise.all([first, second].map(client => Promise.race([
          client.close().catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 5_000)),
        ])));
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
      }
    }, 45_000);
    }

    it.skipIf(packagedExe === undefined || process.env.LNWJING_RUN_L07_PORTABLE_SIMULATION !== '1')(
      'retries an L.07 markdown + Index/_progress workflow after reclaiming old profile diagnostics in packaged MCP', async () => {
        const root = await mkdtemp(path.join(privateRoot, 'portable-l07-'));
        const workspace = path.join(root, 'workspace');
        const data = path.join(root, 'data');
        const roaming = path.join(root, 'roaming');
        const local = path.join(root, 'local');
        const temp = path.join(root, 'temp');
        await Promise.all([workspace, data, roaming, local, temp].map(p => mkdir(p, { recursive: true })));
        const markdown = path.join(workspace, 'L.07.md');
        const index = path.join(workspace, 'Index.md');
        const progress = path.join(workspace, '_progress.md');
        // This is synthetic material, never the user's real course/workspace.
        await writeFile(path.join(workspace, 'L.07.html'), '<h1>synthetic L.07</h1>\n');
        await writeFile(path.join(workspace, 'L.07.test.ts'), 'export const syntheticL07 = true;\n');
        await writeFile(index, 'L.07: pending\n');
        await writeFile(progress, 'L.07: pending\n');
        const env = {
          ...process.env, LNWJING_DATA_PATH: data, LNWJING_WORKSPACE: workspace,
          APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
          LNWJING_INDEX_SQLITE_PREVIEW: '0',
          PATH: path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep') + path.delimiter + (process.env.PATH ?? ''),
        };
        delete env.ELECTRON_RUN_AS_NODE;
        const transport = new StdioClientTransport({
          command: path.join(path.dirname(electron), 'lnwjing-mcp-stdio-bridge.exe'),
          args: [electron, '--mcp-stdio', '--workspace', workspace, '--disable-gpu', '--disable-background-networking'],
          cwd: desktopRoot, env, stderr: 'pipe',
        });
        let diagnostics = '';
        transport.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
        let requestId = 10;
        const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
          responseData(await request(transport, requestId++, 'tools/call', { name, arguments: args }));
        try {
          await transport.start();
          const catalog = responseData(await request(transport, 1, 'tools/list', {}));
          expect((catalog.tools as Array<{ name: string }>).map(tool => tool.name)).toContain('write_file');
          const quota = new GlobalStorageQuotaReservations(data);
          const mib = 1024 ** 2;
          quota.configure({ limitBytes: 128 * mib, criticalReserveBytes: 512 * 1024 });
          const baseline = (await quota.inspect()).logicalUsedBytes;
          quota.configure({ limitBytes: baseline + mib, criticalReserveBytes: 512 * 1024 });
          const lesson = '# Synthetic L.07\n\n## Key concepts\nProfile quota recovery verified.\n';
          const denied = await call('write_file', { path: markdown, content: lesson, userConfirmed: true });
          expect(denied).toMatchObject({ isError: true });
          await expect(readFile(markdown, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          expect(quota.status()?.activeReservations).toBe(0);

          // Verified-old app diagnostics are the only reclaim candidate;
          // already saved HTML, test script, Index and progress are protected.
          const diagnosticsDir = path.join(data, 'diagnostics');
          await mkdir(diagnosticsDir);
          const old = path.join(diagnosticsDir, 'expired-l07.log');
          await writeFile(old, Buffer.alloc(4 * mib));
          const expiredAt = new Date('2020-01-01T00:00:00.000Z');
          await utimes(old, expiredAt, expiredAt);
          const withOld = (await quota.inspect()).logicalUsedBytes;
          quota.configure({ limitBytes: withOld + 2 * mib, criticalReserveBytes: 512 * 1024 });

          const savedLesson = await call('write_file', { path: markdown, content: lesson, userConfirmed: true });
          expect(savedLesson.isError).not.toBe(true);
          const savedIndex = await call('edit_file', {
            path: index, oldText: 'L.07: pending', newText: 'L.07: complete', userConfirmed: true,
          });
          expect(savedIndex.isError).not.toBe(true);
          const savedProgress = await call('edit_file', {
            path: progress, oldText: 'L.07: pending', newText: 'L.07: complete', userConfirmed: true,
          });
          expect(savedProgress.isError).not.toBe(true);
          expect(await readFile(markdown, 'utf8')).toBe(lesson);
          expect(await readFile(index, 'utf8')).toContain('L.07: complete');
          expect(await readFile(progress, 'utf8')).toContain('L.07: complete');
          expect(await readFile(path.join(workspace, 'L.07.html'), 'utf8')).toContain('synthetic L.07');
          await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(quota.status()?.activeReservations).toBe(0);
        } catch (error) {
          throw new Error('Packaged synthetic L.07 profile quota simulation failed: ' + String(error)
            + '; diagnostics: ' + diagnostics, { cause: error });
        } finally {
          await Promise.race([
            transport.close().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]);
          await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
        }
      }, 60_000);

    it('refuses an unresolved restore before creating a new checkpoint key', async () => {
      const root = await mkdtemp(path.join(privateRoot, 'electron-restore-refusal-'));
      const data = path.join(root, 'data');
      const backups = path.join(data, 'backups');
      const roaming = path.join(root, 'roaming');
      const local = path.join(root, 'local');
      const temp = path.join(root, 'temp');
      await Promise.all([backups, roaming, local, temp].map(p => mkdir(p, { recursive: true })));
      await writeFile(path.join(backups, 'restore-swap.json'), '{ "schemaVersion": 1, "invalid": true }');
      const env = { ...process.env, LNWJING_DATA_PATH: data, APPDATA: roaming,
        LOCALAPPDATA: local, TEMP: temp, TMP: temp };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [...(packagedExe ? [] : [entry]), '--mcp-stdio',
        '--mcp-stdio-profile-init', '--disable-gpu', '--disable-background-networking'], {
        cwd: desktopRoot, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let diagnostics = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + String(chunk)).slice(-2500);
      });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Restore refusal never exited')), 10_000);
          child.once('close', (status) => { clearTimeout(timer); resolve(status); });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
        expect(code).not.toBe(0);
        expect(diagnostics).toMatch(/restore initialization failed/i);
        await expect(readFile(path.join(data, 'checkpoint-master.key')))
          .rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path.join(backups, 'restore-swap.json'), 'utf8')).toContain('invalid');
      } finally {
        if (child.exitCode === null) child.kill();
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
      }
    }, 18_000);

    it.skipIf(process.env.LNWJING_RUN_GUI_STDIO_SIMULATION !== '1')(
      'starts a GUI and MCP STDIO together with one fresh isolated key', async () => {
      const root = await mkdtemp(path.join(privateRoot, 'electron-gui-stdio-'));
      const workspace = path.join(root, 'workspace');
      const data = path.join(root, 'data');
      const roaming = path.join(root, 'roaming');
      const local = path.join(root, 'local');
      const temp = path.join(root, 'temp');
      await Promise.all([workspace, data, roaming, local, temp].map(p => mkdir(p, { recursive: true })));
      await writeFile(path.join(workspace, 'source.ts'), 'export const gui_stdio_fixture = true;\n');
      const env = {
        ...process.env, LNWJING_DATA_PATH: data, LNWJING_WORKSPACE: workspace,
        APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
        PATH: path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep') + path.delimiter + (process.env.PATH ?? ''),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const gui = spawn(electron, [...(packagedExe ? [] : [entry]), '--disable-gpu',
        '--disable-background-networking', '--no-default-browser-check'], {
        cwd: desktopRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const transport = new StdioClientTransport({
        command: packagedExe ? path.join(path.dirname(electron), 'lnwjing-mcp-stdio-bridge.exe')
          : path.join(desktopRoot, 'build', 'lnwjing-mcp-stdio-bridge.exe'),
        args: [electron, ...(packagedExe ? [] : [entry]), '--mcp-stdio', '--workspace', workspace,
          '--disable-gpu', '--disable-background-networking'],
        cwd: desktopRoot, env, stderr: 'pipe',
      });
      let diagnostics = '';
      for (const stream of [gui.stdout, gui.stderr, transport.stderr]) {
        stream?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
      }
      try {
        await transport.start();
        const catalog = responseData(await request(transport, 1, 'tools/list', {}));
        expect((catalog.tools as Array<{ name: string }>).map(tool => tool.name)).toContain('read_file');
        await new Promise(resolve => setTimeout(resolve, 2_500));
        expect(gui.exitCode, diagnostics).toBeNull();
        const secret = await readFile(path.join(data, 'checkpoint-master.key'), 'utf8');
        expect(secret.startsWith('safe:v1:')).toBe(true);
      } catch (error) {
        throw new Error('Fresh GUI+STDIO profile startup failed: ' + String(error)
          + '; diagnostics: ' + diagnostics, { cause: error });
      } finally {
        await transport.close().catch(() => undefined);
        if (gui.exitCode === null) gui.kill();
        await new Promise<void>(resolve => {
          if (gui.exitCode !== null) { resolve(); return; }
          const timer = setTimeout(resolve, 5_000);
          gui.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
      }
    }, 50_000);
  },
);
