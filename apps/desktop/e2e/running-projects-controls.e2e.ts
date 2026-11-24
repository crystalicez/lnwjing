import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjing/storage';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Running Projects scrolls 19 enabled projects and keeps Sort after navigation', async () => {
  test.setTimeout(110_000);
  const data = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-running-projects-e2e-'));
  const root = await realpath(data);
  const names = Array.from({ length: 19 }, (_, index) => `project-${String(index).padStart(2, '0')}`);
  const database = new SqliteDatabase(path.join(data, 'lnwjing.sqlite'));
  try {
    const repository = new SqliteWorkspaceRepository(database);
    for (const name of names) {
      const workspaceRoot = path.join(root, name);
      await mkdir(workspaceRoot);
      await repository.insert({
        id: name, displayName: name, rootPath: workspaceRoot, realRootPath: workspaceRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const settings = new SqliteSettingsRepository(database);
    settings.set('active_workspace_ids', JSON.stringify(names));
    settings.set('selected_workspace_id', names[0]!);
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
        ...process.env, LNWJING_DATA_PATH: data, LNWJING_WORKSPACE: path.join(root, names[0]!),
        APPDATA: data, LOCALAPPDATA: data, TEMP: data, TMP: data,
        LNWJING_E2E_FIXTURE: '1', LNWJING_E2E_NODE_PATH: process.execPath,
      },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await settleFirstRunAndOpenHome(page);
    await page.getByRole('button', { name: 'Running Projects' }).click();
    const list = page.locator('.active-projects-scroll');
    await expect(list).toBeVisible();
    await expect(list.locator('.active-projects-item')).toHaveCount(19);
    await expect(page.getByTestId('running-activity-freshness')).toContainText('Activity last updated:');
    const gridGeometry = async (): Promise<{
      readonly firstTop: number;
      readonly secondTop: number;
      readonly firstWidth: number;
      readonly secondWidth: number;
      readonly scrollWidth: number;
      readonly clientWidth: number;
    }> => list.locator('.active-projects-list').evaluate((element) => {
      const cards = [...element.querySelectorAll<HTMLElement>('.active-projects-item')];
      const first = cards[0]!.getBoundingClientRect();
      const second = cards[1]!.getBoundingClientRect();
      const scroll = element.parentElement!;
      return {
        firstTop: first.top, secondTop: second.top,
        firstWidth: first.width, secondWidth: second.width,
        scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
      };
    });
    // Grid depends on the available content width, not the number of projects.
    await page.setViewportSize({ width: 1560, height: 900 });
    const wide = await gridGeometry();
    expect(Math.abs(wide.firstTop - wide.secondTop)).toBeLessThan(2);
    expect(wide.firstWidth).toBeGreaterThanOrEqual(340);
    expect(wide.secondWidth).toBeGreaterThanOrEqual(340);
    expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth + 2);

    await page.setViewportSize({ width: 700, height: 700 });
    const narrow = await gridGeometry();
    expect(narrow.secondTop).toBeGreaterThan(narrow.firstTop + 100);
    expect(narrow.firstWidth).toBeGreaterThan(200);
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth + 2);
    await page.setViewportSize({ width: 1280, height: 800 });

    const scrollState = await list.evaluate((element) => {
      const before = element.scrollTop;
      const total = element.scrollHeight;
      const viewport = element.clientHeight;
      element.scrollTop = total;
      return { before, after: element.scrollTop, total, viewport,
        overflowY: getComputedStyle(element).overflowY };
    });
    expect(scrollState.total).toBeGreaterThan(scrollState.viewport);
    expect(scrollState.after).toBeGreaterThan(scrollState.before);
    expect(scrollState.overflowY).toBe('auto');
    await list.evaluate((element) => { element.scrollTop = 0; });
    await list.hover();
    await page.mouse.wheel(0, 700);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await list.focus();
    await page.keyboard.press('End');
    await expect.poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollState.viewport);

    const sort = page.getByRole('combobox', { name: 'Sort by' });
    await sort.selectOption('name-desc');
    await expect(list.locator('.active-projects-item').first()).toContainText('project-18');
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('PROJECT-07');
    await expect(list.locator('.active-projects-item')).toHaveCount(1);
    await expect(list.locator('.active-projects-item').first()).toContainText('project-07');
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('');
    await page.getByRole('combobox', { name: 'Status' }).selectOption('ready');
    await expect(list.locator('.active-projects-item')).toHaveCount(19);
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Running Projects' }).click();
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('name-desc');
    await expect(page.locator('.active-projects-scroll .active-projects-item').first()).toContainText('project-18');
  } finally {
    if (app !== undefined) {
      if (process.platform === 'win32') await terminateProcessTree(app.process());
      await app.close().catch(() => undefined);
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
