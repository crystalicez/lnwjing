import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  },
);
