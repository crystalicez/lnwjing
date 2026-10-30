import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const oldPortableDirectory = path.join(root, 'portable');
const stagedPortableDirectory = path.join(root, 'apps', 'desktop', 'dist', 'installers');

async function findVerifiedExtractedExecutable(base: string): Promise<string> {
  const folders = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^lnwjing-runtime-v5\.8\.7-[A-Za-z0-9_-]+$/.test(entry.name));
  expect(folders).toHaveLength(1);
  const folder = path.join(base, folders[0]!.name);
  const marker = (await readFile(path.join(folder, '.lnwjing-ready'), 'utf8')).trim();
  expect(marker).toBe(folders[0]!.name.replace('lnwjing-runtime-', 'lnwjing-'));
  const executable = path.join(folder, 'lnwjing.exe');
  expect((await stat(executable)).isFile()).toBe(true);
  return executable;
}

async function initStdioProfile(executable: string, rootPath: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LNWJING_DATA_PATH: rootPath,
    APPDATA: path.join(rootPath, 'roaming'),
    LOCALAPPDATA: path.join(rootPath, 'local'),
    TEMP: path.join(rootPath, 'temp'),
    TMP: path.join(rootPath, 'temp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await Promise.all([env.APPDATA, env.LOCALAPPDATA, env.TEMP].map((p) => mkdir(p!, { recursive: true })));
  const child = spawn(executable, [
    '--mcp-stdio', '--mcp-stdio-profile-init', '--disable-gpu', '--disable-background-networking',
  ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Portable profile initialization timed out')), 45_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(result, stderr).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function exerciseMcpSession(executable: string, rootPath: string): Promise<void> {
  const workspace = path.join(rootPath, 'workspace');
  await mkdir(workspace, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LNWJING_DATA_PATH: rootPath, LNWJING_WORKSPACE: workspace,
    APPDATA: path.join(rootPath, 'roaming'), LOCALAPPDATA: path.join(rootPath, 'local'),
    TEMP: path.join(rootPath, 'temp'), TMP: path.join(rootPath, 'temp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Send JSON-RPC lines directly to the native STDIO bridge. The packaging
  // test has no dependency on the desktop workspace's MCP SDK installation.
  const child = spawn(path.join(path.dirname(executable), 'lnwjing-mcp-stdio-bridge.exe'), [
    executable, '--mcp-stdio', '--workspace', workspace, '--disable-gpu', '--disable-background-networking',
  ], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString('utf8')).slice(-1600);
  });
  try {
    const response = await new Promise<{ result?: { tools?: Array<{ name: string }> }; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP upgrade session deadline: ' + diagnostics)), 25_000);
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || parsed.id !== 1) continue;
            clearTimeout(timer);
            resolve(parsed as { result?: { tools?: Array<{ name: string }> }; error?: unknown });
            return;
          } catch {
            // Ignore unrelated console output; the response must be JSON-RPC.
          }
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('MCP bridge exited before responding: ' + code + '; ' + diagnostics));
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/list',
        params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'lnwjing-portable-upgrade-e2e', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } },
      }) + '\n');
    });
    expect(response.error, diagnostics).toBeUndefined();
    expect(response.result?.tools?.some((tool) => tool.name === 'read_file'), diagnostics).toBe(true);
  } finally {
    // Give the native bridge time to propagate clean stdin EOF to Electron
    // before escalating. Premature SIGKILL can leave SQLite handles open.
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const grace = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 4_000);
      const deadline = setTimeout(resolve, 8_000);
      child.once('exit', () => { clearTimeout(grace); clearTimeout(deadline); resolve(); });
    });
  }
}

describe.skipIf(process.platform !== 'win32' || process.env.LNWJING_RUN_PORTABLE_UPGRADE_LIVE !== '1')(
  'old-to-new Windows Portable upgrade (isolated profile)', () => {
    it('preserves policy and audit evidence across real old-to-new-to-old Portable sessions', async () => {
      const oldExe = await findVerifiedExtractedExecutable(oldPortableDirectory);
      const newExe = await findVerifiedExtractedExecutable(stagedPortableDirectory);
      expect(oldExe).not.toBe(newExe);
      const auditRoot = path.join(root, '.audit');
      await mkdir(auditRoot, { recursive: true });
      const profile = await mkdtemp(path.join(auditRoot, 'portable-upgrade-'));
      const filename = path.join(profile, 'lnwjing.sqlite');
      try {
        await initStdioProfile(oldExe, profile);
        await exerciseMcpSession(oldExe, profile);
        const oldDb = new DatabaseSync(filename);
        let schemaBefore: number;
        let auditBefore: number;
        try {
          oldDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
            'checkpoint_creation_mode_v1', 'always',
          );
          oldDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
            'release_upgrade_canary_v1', 'preserve-this-value',
          );
          oldDb.prepare(
            'INSERT INTO audit_events (id, timestamp, actor_id, actor_name, action, result_code, duration_ms, metadata_json)'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run('release-upgrade-audit-canary', '2026-10-30T00:00:00.000Z', 'release-fixture',
            'Release Fixture', 'mcp_tool:read_file', 'SUCCESS', 0, '{"release":true}');
          schemaBefore = (oldDb.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count;
          auditBefore = (oldDb.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n;
          expect((oldDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
            .toBe('ok');
        } finally { oldDb.close(); }

        await initStdioProfile(newExe, profile);
        await exerciseMcpSession(newExe, profile);
        const upgradedDb = new DatabaseSync(filename);
        try {
          const getSetting = upgradedDb.prepare('SELECT value FROM settings WHERE key = ?');
          expect((getSetting.get('checkpoint_creation_mode_v1') as { value: string }).value).toBe('always');
          expect((getSetting.get('release_upgrade_canary_v1') as { value: string }).value)
            .toBe('preserve-this-value');
          expect((upgradedDb.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n)
            .toBeGreaterThanOrEqual(auditBefore);
          expect((upgradedDb.prepare('SELECT count(*) AS n FROM audit_events WHERE id = ?').get(
            'release-upgrade-audit-canary') as { n: number }).n).toBe(1);
          expect((upgradedDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
            .toBe('ok');
          expect((upgradedDb.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
          const schemaAfter = (upgradedDb.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count;
          expect(schemaAfter).toBeGreaterThanOrEqual(schemaBefore);
          console.info('PORTABLE_UPGRADE_VERIFIED=' + JSON.stringify({
            schemaBefore, schemaAfter, auditBefore, explicitCheckpointMode: 'always',
          }));
        } finally { upgradedDb.close(); }

        // The old Portable must remain a usable rollback after the new
        // runtime has opened the same profile, not merely exist on disk.
        await initStdioProfile(oldExe, profile);
        await exerciseMcpSession(oldExe, profile);
        const restoredOld = new DatabaseSync(filename);
        try {
          const setting = restoredOld.prepare('SELECT value FROM settings WHERE key = ?').get(
            'checkpoint_creation_mode_v1',
          ) as { value: string } | undefined;
          expect(setting?.value).toBe('always');
          const canary = restoredOld.prepare('SELECT value FROM settings WHERE key = ?').get(
            'release_upgrade_canary_v1',
          ) as { value: string } | undefined;
          expect(canary?.value).toBe('preserve-this-value');
          expect((restoredOld.prepare('SELECT count(*) AS n FROM audit_events WHERE id = ?').get(
            'release-upgrade-audit-canary') as { n: number }).n).toBe(1);
          expect((restoredOld.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
            .toBe('ok');
          console.info('PORTABLE_ROLLBACK_VERIFIED=old runtime reopened and read the upgraded profile');
        } finally { restoredOld.close(); }
      } finally {
        // Windows releases SQLite/OSCrypt file handles asynchronously after
        // the bridge exits; allow bounded unlock time without touching live data.
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      }
    }, 130_000);
  },
);
