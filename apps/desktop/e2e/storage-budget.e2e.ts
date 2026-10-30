import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real Storage Settings persist Git-aware and SQLite backup budget with isolated profile', async () => {
  test.setTimeout(90_000);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-e2e-'));
  const app = await _electron.launch({
    executablePath: electronExecutablePath(desktopRoot),
    args: ['--user-data-dir=' + dataRoot, path.join(desktopRoot, 'dist', 'main', 'main.js')],
    cwd: desktopRoot,
    env: {
      ...process.env,
      LNWJING_DATA_PATH: dataRoot, APPDATA: dataRoot, LOCALAPPDATA: dataRoot,
      TEMP: dataRoot, TMP: dataRoot, LNWJING_E2E_FIXTURE: '1',
      LNWJING_E2E_NODE_PATH: process.execPath,
    },
    timeout: 40_000,
  });
  try {
    const page = await app.firstWindow();
    await settleFirstRunAndOpenHome(page);
    await page.getByRole('button', { name: /^(ตั้งค่า|Settings)$/ }).click();
    await page.locator('.settings-subnav .settings-nav-item').last().click();
    const mode = page.locator('#storage-checkpoint-mode');
    const limit = page.locator('#storage-sqlite-hard-limit');
    await expect(mode).toHaveValue('git-aware', { timeout: 20_000 });
    await expect(limit).toHaveValue('4096');
    await expect(page.locator('section[aria-label="จัดการพื้นที่จัดเก็บ"], section[aria-label="Storage Management"]'))
      .toContainText('12288.0 MiB');
    await limit.selectOption('1024');
    await expect(limit).toHaveValue('1024');
    await expect.poll(async () => (await page.evaluate(() => window.lnwjing.getStorageOverview()))
      .automaticBackupBudget?.budgetBytes).toBe(3 * 1024 ** 3);
    await mode.selectOption('always');
    await expect(mode).toHaveValue('always');
    page.once('dialog', async (dialog) => dialog.accept());
    await mode.selectOption('git-aware');
    await expect(mode).toHaveValue('git-aware');
    await expect.poll(async () => (await page.evaluate(() => window.lnwjing.getStorageOverview()))
      .policy.checkpointCreationMode).toBe('git-aware');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
