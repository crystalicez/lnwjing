import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { SqliteDatabase, SqliteSettingsRepository } from '@lnwjing/storage';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a previously removed final Project boots into a usable empty Projects page', async () => {
  test.setTimeout(110_000);
  const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-removed-project-e2e-'));
  const data = await realpath(raw);
  const database = new SqliteDatabase(path.join(data, 'lnwjing.sqlite'));
  try {
    const settings = new SqliteSettingsRepository(database);
    // Simulate settings retained by older builds after deleting the final
    // registration. Do not create any workspace or modify a real profile.
    settings.set('selected_workspace_id', 'project-removed-before-restart');
    settings.set('active_workspace_ids', JSON.stringify(['project-removed-before-restart']));
    settings.set('ui_locale', 'en');
  } finally { database.close(); }

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const packaged = process.env.LNWJING_PACKAGED_EXECUTABLE;
    app = await _electron.launch({
      executablePath: packaged ?? electronExecutablePath(desktopRoot),
      args: packaged === undefined
        ? ['--user-data-dir=' + data, path.join(desktopRoot, 'dist', 'main', 'main.js')]
        : ['--user-data-dir=' + data],
      cwd: desktopRoot,
      env: {
        ...process.env,
        LNWJING_DATA_PATH: data,
        APPDATA: data, LOCALAPPDATA: data, TEMP: data, TMP: data,
        LNWJING_E2E_FIXTURE: '1', LNWJING_E2E_NODE_PATH: process.execPath,
        LNWJING_WORKSPACE: '',
      },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await settleFirstRunAndOpenHome(page);
    const snapshot = await page.evaluate(async () => ({
      dashboard: await window.lnwjing.getDashboard(),
      workspaces: await window.lnwjing.listWorkspaces(),
    }));
    expect(snapshot.dashboard.selectedWorkspace).toBeNull();
    expect(snapshot.dashboard.activeWorkspaces).toEqual([]);
    expect(snapshot.workspaces).toEqual([]);

    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true, level: 1 })).toBeVisible();
    await expect(page.locator('label[for="workspace-root"]')).toHaveText('Add project');
    await expect(page.locator('.boot-partial-error')).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(raw, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
