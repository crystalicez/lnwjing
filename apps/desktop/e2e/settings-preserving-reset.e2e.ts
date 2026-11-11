import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { applyPendingFactoryResetSync, stageFactoryResetSync, factoryResetMarkerPath } from '../src/main/factory-reset.js';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(desktopRoot, '..', '..');
const packagedCandidate = process.env.LNWJING_PACKAGED_EXECUTABLE
  ?? path.join(projectRoot, '.audit', 'settings-reset-portable-candidate', 'win-unpacked', 'lnwjing.exe');
type GuiBuild = 'source' | 'packaged-candidate';

async function launchTestGui(profile: string, build: GuiBuild): Promise<ElectronApplication> {
  const packaged = build === 'packaged-candidate';
  const executable = packaged ? packagedCandidate : electronExecutablePath(desktopRoot);
  const app = await _electron.launch({
    executablePath: executable,
    args: packaged
      ? ['--user-data-dir=' + profile, '--disable-background-networking']
      : [path.join(desktopRoot, 'dist', 'main', 'main.js'), '--user-data-dir=' + profile, '--disable-background-networking'],
    cwd: desktopRoot,
    env: {
      ...process.env,
      LNWJING_DATA_PATH: profile,
      APPDATA: path.join(path.dirname(profile), 'roaming'),
      LOCALAPPDATA: path.join(path.dirname(profile), 'local'),
      TEMP: path.join(path.dirname(profile), 'temp'),
      TMP: path.join(path.dirname(profile), 'temp'),
      LNWJING_E2E_FIXTURE: '1',
      LNWJING_E2E_NODE_PATH: process.execPath,
      LNWJING_WORKSPACE: '',
    },
    timeout: 45_000,
  });
  try {
    await settleFirstRunAndOpenHome(await app.firstWindow());
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

for (const build of ['source', 'packaged-candidate'] as const) {
test(`${build} real Electron Settings button preserves configuration across offline clear and a clean GUI restart`, async () => {
  test.skip(build === 'packaged-candidate' && !existsSync(packagedCandidate), 'Test-only packaged candidate is missing');
  test.setTimeout(160_000);
  const auditRoot = path.join(projectRoot, '.audit');
  await mkdir(auditRoot, { recursive: true });
  const testRoot = await mkdtemp(path.join(auditRoot, 'settings-reset-gui-'));
  const profile = path.join(testRoot, 'profile');
  const tunnel = path.join(testRoot, 'external-tunnel');
  const project = path.join(testRoot, 'user-code');
  await Promise.all([profile, tunnel, project].map(async p => mkdir(p)));
  await Promise.all(['roaming', 'local', 'temp'].map(async d => mkdir(path.join(testRoot, d))));
  await writeFile(path.join(project, 'my-project.ts'), 'export const shouldNeverBeDeleted = true;');
  await writeFile(path.join(tunnel, 'other.yaml'), 'another-client-profile');
  let app: ElectronApplication | undefined;
  try {
    app = await launchTestGui(profile, build);
    console.info('[SettingsResetE2E] initialized first GUI');
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /^(Settings|ตั้งค่า)$/ }).click();
    await page.locator('.settings-subnav .settings-nav-item').filter({ hasText: /Recovery|กู้คืนข้อมูล/ }).click();
    console.info('[SettingsResetE2E] entered Storage Management');
    const reset = page.getByTestId('preserve-settings-reset');
    await expect(reset).toBeVisible();
    const button = reset.getByRole('button');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();

    await app.evaluate(({ dialog }) => {
      const host = globalThis as typeof globalThis & {
        __settingsResetDialog?: { title: string; message: string; defaultId?: number; cancelId?: number };
      };
      const original = dialog.showMessageBox.bind(dialog);
      (dialog as typeof dialog & { showMessageBox: typeof original }).showMessageBox = async (...args): Promise<Awaited<ReturnType<typeof original>>> => {
        const options = args[args.length - 1] as { title: string; message: string; defaultId?: number; cancelId?: number };
        if (options.title.includes('Clear data') || options.title.includes('ล้างข้อมูล')) {
          host.__settingsResetDialog = {
            title: options.title, message: options.message,
            ...(options.defaultId === undefined ? {} : { defaultId: options.defaultId }),
            ...(options.cancelId === undefined ? {} : { cancelId: options.cancelId }),
          };
          return { response: 1, checkboxChecked: false };
        }
        return original(...args);
      };
    });
    console.info('[SettingsResetE2E] clicking the confirmation-gated button');
    await button.click();
    console.info('[SettingsResetE2E] click settled');
    await expect.poll(() => app!.evaluate(() => (
      (globalThis as typeof globalThis & { __settingsResetDialog?: unknown }).__settingsResetDialog
    ))).not.toBeNull();
    const dialog = await app.evaluate(() => (
      (globalThis as typeof globalThis & { __settingsResetDialog?: { title: string; defaultId: number; cancelId: number } })
        .__settingsResetDialog
    ));
    expect(dialog?.title).toMatch(/Clear data|ล้างข้อมูล/);
    expect(dialog?.defaultId).toBe(1);
    expect(dialog?.cancelId).toBe(1);
    expect(existsSync(factoryResetMarkerPath(profile))).toBe(false);
    console.info('[SettingsResetE2E] cancellation verified');

    console.info('[SettingsResetE2E] closing the first GUI');
    await app.close();
    console.info('[SettingsResetE2E] first GUI fully closed');
    app = undefined;
    const dbFile = path.join(profile, 'lnwjing.sqlite');
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ui_locale', 'en');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('checkpoint_creation_mode_v1', 'always');
      db.prepare('INSERT INTO audit_events (id, timestamp, actor_id, actor_name, action, result_code, duration_ms, metadata_json) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'preserve-reset-gui-audit', '2026-11-01T00:00:00.000Z', 'fixture',
        'Fixture', 'mcp_tool:read_file', 'SUCCESS', 0, '{}',
      );
    } finally { db.close(); }
    await mkdir(path.join(profile, 'cache'), { recursive: true });
    await writeFile(path.join(profile, 'cache', 'stale.bin'), 'old-cache');
    const checkpointKey = path.join(profile, 'checkpoint-master.key');
    const hashBefore = createHash('sha256').update(await readFile(checkpointKey)).digest('hex');

    stageFactoryResetSync(profile, 'preserve-settings');
    console.info('[SettingsResetE2E] applying offline reset');
    expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
    console.info('[SettingsResetE2E] offline reset verified');
    expect(existsSync(path.join(profile, 'cache', 'stale.bin'))).toBe(false);
    const resetDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      expect((resetDb.prepare("SELECT value FROM settings WHERE key='checkpoint_creation_mode_v1'").get() as { value: string }).value).toBe('always');
      expect((resetDb.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE name='audit_events'").get() as { count: number }).count).toBe(0);
    } finally { resetDb.close(); }

    console.info('[SettingsResetE2E] relaunching GUI with preserved real keys');
    app = await launchTestGui(profile, build);
    console.info('[SettingsResetE2E] GUI restart accepted');
    const restarted = await app.firstWindow();
    const restored = await restarted.evaluate(async () => ({
      dashboard: await window.lnwjing.getDashboard(),
      workspaces: await window.lnwjing.listWorkspaces(),
      storage: await window.lnwjing.getStorageOverview(),
    }));
    expect(restored.dashboard.locale).toBe('en');
    expect(restored.workspaces).toEqual([]);
    expect(restored.storage.policy.checkpointCreationMode).toBe('always');
    expect(createHash('sha256').update(await readFile(checkpointKey)).digest('hex')).toBe(hashBefore);
    expect(await readFile(path.join(project, 'my-project.ts'), 'utf8')).toBe('export const shouldNeverBeDeleted = true;');
    expect(await readFile(path.join(tunnel, 'other.yaml'), 'utf8')).toBe('another-client-profile');
    expect((await readdir(profile)).includes('lnwjing.sqlite')).toBe(true);
  } finally {
    await app?.close();
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test(`${build} native confirmation commits a v2 reset request and quiesces the actual Electron runtime`, async () => {
  test.skip(build === 'packaged-candidate' && !existsSync(packagedCandidate), 'Test-only packaged candidate is missing');
  test.setTimeout(130_000);
  const auditRoot = path.join(projectRoot, '.audit');
  await mkdir(auditRoot, { recursive: true });
  const testRoot = await mkdtemp(path.join(auditRoot, 'settings-reset-confirm-'));
  const profile = path.join(testRoot, 'profile');
  const tunnel = path.join(testRoot, 'external-tunnel');
  const project = path.join(testRoot, 'code');
  await Promise.all([profile, tunnel, project, path.join(testRoot, 'roaming'), path.join(testRoot, 'local'),
    path.join(testRoot, 'temp')].map(async folder => mkdir(folder)));
  await writeFile(path.join(project, 'README.md'), 'user-owned code must be kept');
  let app: ElectronApplication | undefined;
  try {
    app = await launchTestGui(profile, build);
    await app.close();
    app = undefined;

    const dbFile = path.join(profile, 'lnwjing.sqlite');
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('checkpoint_creation_mode_v1', 'always');
      db.prepare('INSERT INTO audit_events(id,timestamp,actor_id,actor_name,action,result_code,duration_ms,metadata_json)'
        + 'VALUES(?,?,?,?,?,?,?,?)').run('reset-confirm-audit', '2026-11-01T00:00:00.000Z',
        'fixture', 'Fixture', 'mcp_tool:read_file', 'SUCCESS', 0, '{}');
    } finally { db.close(); }
    const keyFile = path.join(profile, 'checkpoint-master.key');
    const keyHash = createHash('sha256').update(await readFile(keyFile)).digest('hex');

    app = await launchTestGui(profile, build);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /^(Settings|ตั้งค่า)$/ }).click();
    await page.locator('.settings-subnav .settings-nav-item').filter({ hasText: /Recovery|กู้คืนข้อมูล/ }).click();
    const confirmation = page.getByTestId('preserve-settings-reset').getByRole('button');
    await expect(confirmation).toBeEnabled();
    await app.evaluate(({ app: electronApp, dialog }) => {
      const host = globalThis as typeof globalThis & {
        __resetConfirmed?: boolean;
        __resetExitRequested?: boolean;
        __resetRelaunch?: { args?: string[] };
      };
      const original = dialog.showMessageBox.bind(dialog);
      (dialog as typeof dialog & { showMessageBox: typeof original }).showMessageBox =
        async (...args): Promise<Awaited<ReturnType<typeof original>>> => {
          const options = args[args.length - 1] as { title: string };
          if (options.title.includes('Clear data') || options.title.includes('ล้างข้อมูล')) {
            host.__resetConfirmed = true;
            return { response: 0, checkboxChecked: false };
          }
          return original(...args);
        };
      (electronApp as typeof electronApp & { relaunch: typeof electronApp.relaunch }).relaunch = (options): void => {
        host.__resetRelaunch = options;
      };
      (electronApp as typeof electronApp & { exit: (code?: number) => void }).exit = (): void => {
        // Test-owned application stays accessible for the marker and shutdown
        // assertions; a separate fresh process validates the restored state.
        host.__resetExitRequested = true;
      };
    });
    await confirmation.click();
    await expect.poll(() => existsSync(factoryResetMarkerPath(profile)), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => app!.evaluate(() => (
      (globalThis as typeof globalThis & { __resetExitRequested?: boolean }).__resetExitRequested
    )), { timeout: 40_000 }).toBe(true);
    const invoke = await app.evaluate(() => {
      const host = globalThis as typeof globalThis & {
        __resetConfirmed?: boolean;
        __resetRelaunch?: { args?: string[] };
      };
      return { confirmed: host.__resetConfirmed, args: host.__resetRelaunch?.args ?? [] };
    });
    expect(invoke.confirmed).toBe(true);
    expect(invoke.args).toContain('--lnwjing-apply-factory-reset');
    const marker = JSON.parse(await readFile(factoryResetMarkerPath(profile), 'utf8')) as { version: number; mode: string };
    expect(marker).toMatchObject({ version: 2, mode: 'preserve-settings' });
    await app.close();
    app = undefined;

    expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
    expect(existsSync(factoryResetMarkerPath(profile))).toBe(false);
    const checkpoint = new DatabaseSync(dbFile, { readOnly: true });
    try {
      expect(checkpoint.prepare("SELECT value FROM settings WHERE key='checkpoint_creation_mode_v1'").get())
        .toMatchObject({ value: 'always' });
      expect(checkpoint.prepare("SELECT name FROM sqlite_master WHERE name='audit_events'").get()).toBeUndefined();
    } finally { checkpoint.close(); }
    app = await launchTestGui(profile, build);
    const dashboard = await (await app.firstWindow()).evaluate(() => window.lnwjing.getDashboard());
    expect(dashboard.locale).toBe('en');
    expect(createHash('sha256').update(await readFile(keyFile)).digest('hex')).toBe(keyHash);
    expect(await readFile(path.join(project, 'README.md'), 'utf8')).toBe('user-owned code must be kept');
  } finally {
    await app?.close();
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
}
