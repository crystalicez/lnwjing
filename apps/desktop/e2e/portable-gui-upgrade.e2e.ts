import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const enabled = process.platform === 'win32' && process.env.LNWJING_RUN_PORTABLE_GUI_UPGRADE_LIVE === '1';

async function existingRuntime(base: string): Promise<string> {
  const entries = (await readdir(base, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory() && /^lnwjing-runtime-v5\.8\.7-[A-Za-z0-9_-]+$/.test(entry.name));
  expect(entries).toHaveLength(1);
  const folder = path.join(base, entries[0]!.name);
  expect((await readFile(path.join(folder, '.lnwjing-ready'), 'utf8')).trim())
    .toBe(entries[0]!.name.replace('lnwjing-runtime-', 'lnwjing-'));
  const exe = path.join(folder, 'lnwjing.exe');
  expect((await stat(exe)).isFile()).toBe(true);
  return exe;
}

async function launchAndSettle(exe: string, dataRoot: string): Promise<ElectronApplication> {
  const app = await _electron.launch({
    executablePath: exe,
    args: ['--user-data-dir=' + dataRoot, '--disable-background-networking'],
    cwd: desktopRoot,
    env: {
      ...process.env,
      LNWJING_DATA_PATH: dataRoot,
      APPDATA: path.join(dataRoot, 'roaming'),
      LOCALAPPDATA: path.join(dataRoot, 'local'),
      TEMP: path.join(dataRoot, 'temp'),
      TMP: path.join(dataRoot, 'temp'),
      LNWJING_E2E_FIXTURE: '1',
      LNWJING_E2E_NODE_PATH: process.execPath,
    },
    timeout: 40_000,
  });
  try {
    await settleFirstRunAndOpenHome(await app.firstWindow());
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

test('real old → new → old packaged GUI retains profile settings, audit and secret envelope', async () => {
  test.skip(!enabled, 'Explicit packaged Windows GUI upgrade verification opt-in required');
  test.setTimeout(180_000);
  const oldRuntime = await existingRuntime(path.join(repoRoot, 'portable'));
  const newRuntime = await existingRuntime(path.join(desktopRoot, 'dist', 'installers'));
  const auditRoot = path.join(repoRoot, '.audit');
  await mkdir(auditRoot, { recursive: true });
  const dataRoot = await mkdtemp(path.join(auditRoot, 'gui-upgrade-'));
  await Promise.all(['roaming', 'local', 'temp'].map((part) =>
    mkdir(path.join(dataRoot, part), { recursive: true })));
  let app: ElectronApplication | undefined;
  try {
    app = await launchAndSettle(oldRuntime, dataRoot);
    await app.close();
    app = undefined;
    const keyPath = path.join(dataRoot, 'checkpoint-master.key');
    const secretBefore = createHash('sha256').update(await readFile(keyPath)).digest('hex');
    const filename = path.join(dataRoot, 'lnwjing.sqlite');
    const db = new DatabaseSync(filename);
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'checkpoint_creation_mode_v1', 'always',
      );
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'release_gui_upgrade_canary', 'original-value',
      );
      db.prepare(
        'INSERT INTO audit_events (id, timestamp, actor_id, actor_name, action, result_code, duration_ms, metadata_json)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('gui-upgrade-audit-canary', '2026-10-30T00:00:00.000Z',
        'release-fixture', 'Release Fixture', 'mcp_tool:read_file', 'SUCCESS', 0, '{}');
    } finally { db.close(); }

    app = await launchAndSettle(newRuntime, dataRoot);
    const newPage = await app.firstWindow();
    await expect.poll(async () => (await newPage.evaluate(() => window.lnwjing.getStorageOverview()))
      .policy.checkpointCreationMode).toBe('always');
    expect(createHash('sha256').update(await readFile(keyPath)).digest('hex')).toBe(secretBefore);
    await app.close();
    app = undefined;

    app = await launchAndSettle(oldRuntime, dataRoot);
    await app.close();
    app = undefined;
    const oldAgain = new DatabaseSync(filename);
    try {
      const get = oldAgain.prepare('SELECT value FROM settings WHERE key = ?');
      expect((get.get('checkpoint_creation_mode_v1') as { value: string } | undefined)?.value).toBe('always');
      expect((get.get('release_gui_upgrade_canary') as { value: string } | undefined)?.value)
        .toBe('original-value');
      expect((oldAgain.prepare('SELECT count(*) AS n FROM audit_events WHERE id = ?').get(
        'gui-upgrade-audit-canary') as { n: number }).n).toBe(1);
      expect((oldAgain.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
        .toBe('ok');
    } finally { oldAgain.close(); }
    expect(createHash('sha256').update(await readFile(keyPath)).digest('hex')).toBe(secretBefore);
  } finally {
    await app?.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
});
