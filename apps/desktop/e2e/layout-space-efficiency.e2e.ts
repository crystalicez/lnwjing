import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjing/storage';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const screens = [
  ['Home', 'home'],
  ['Projects', 'projects'],
  ['Running Projects', 'active-projects'],
  ['Workflows', 'workflows'],
  ['Tools', 'tools'],
  ['Git', 'git'],
  ['Work Log', 'worklog'],
  ['Live Logs', 'live'],
  ['Settings', 'settings'],
  ['Doctor', 'doctor'],
] as const;

test('all ten screens use the working viewport at desktop and narrow window sizes', async () => {
  test.setTimeout(160_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-layout-e2e-'));
  const root = await realpath(directory);
  const names = Array.from({ length: 19 }, (_, index) => `project-${String(index).padStart(2, '0')}`);
  const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
  try {
    const repo = new SqliteWorkspaceRepository(db);
    for (const name of names) {
      const workspacePath = path.join(root, name);
      await mkdir(workspacePath);
      await repo.insert({
        id: name, displayName: name, rootPath: workspacePath, realRootPath: workspacePath,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const settings = new SqliteSettingsRepository(db);
    settings.set('ui_locale', 'en');
    settings.set('active_workspace_ids', JSON.stringify(names));
    settings.set('selected_workspace_id', names[0]!);
    // Include a real modified Git file so the diff-open scrolling branch is
    // exercised, not only the no-repository/empty explorer state.
    const gitRoot = path.join(root, names[0]!);
    execFileSync('git', ['init', '-q'], { cwd: gitRoot });
    const original = Array.from({ length: 230 }, (_, n) => `unchanged ${n}`).join('\n') + '\n';
    await writeFile(path.join(gitRoot, 'notes.txt'), original);
    execFileSync('git', ['add', '--', 'notes.txt'], { cwd: gitRoot });
    execFileSync('git', ['-c', 'user.name=Layout Fixture', '-c', 'user.email=layout@invalid.example',
      'commit', '-q', '-m', 'fixture'], { cwd: gitRoot });
    await writeFile(path.join(gitRoot, 'notes.txt'), original.split('\n').map((line, index) =>
      index >= 20 && index <= 215 ? line.replace('unchanged', 'updated') : line).join('\n'));
  } finally { db.close(); }

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const packagedExecutable = process.env.LNWJING_PACKAGED_EXECUTABLE?.trim();
    app = await _electron.launch({
      executablePath: packagedExecutable || electronExecutablePath(desktopRoot),
      args: packagedExecutable
        ? ['--user-data-dir=' + root]
        : ['--user-data-dir=' + root, path.join(desktopRoot, 'dist', 'main', 'main.js')],
      cwd: desktopRoot,
      env: {
        ...process.env,
        LNWJING_DATA_PATH: root, LNWJING_WORKSPACE: path.join(root, names[0]!),
        APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
        LNWJING_E2E_FIXTURE: '1', LNWJING_E2E_NODE_PATH: process.execPath,
      },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await settleFirstRunAndOpenHome(page);

    for (const size of [
      { width: 1280, height: 800 },
      { width: 900, height: 700 },
      { width: 700, height: 600 },
      { width: 560, height: 700 },
    ]) {
      await page.setViewportSize(size);
      for (const [navigation, screen] of screens) {
        await page.locator('.sidebar-nav').getByRole('button', { name: navigation, exact: true }).click();
        const pane = page.locator('.main-pane');
        await expect(pane).toHaveAttribute('data-screen', screen);
        await expect(pane.locator('.main-content > *')).toBeVisible();
        const geometry = await pane.evaluate((element) => {
          const main = element.querySelector<HTMLElement>('.main-content')!;
          const content = main.firstElementChild!.getBoundingClientRect();
          const paneBounds = element.getBoundingClientRect();
          const sidebar = document.querySelector<HTMLElement>('.sidebar')!.getBoundingClientRect();
          const nav = document.querySelector<HTMLElement>('.sidebar-nav')!;
          return {
            paneWidth: paneBounds.width, contentWidth: content.width,
            left: content.left, right: content.right, paneRight: paneBounds.right,
            sideWidth: sidebar.width, sideHeight: sidebar.height,
            navScrollWidth: nav.scrollWidth, navClientWidth: nav.clientWidth,
            mainPaddingLeft: parseFloat(getComputedStyle(main).paddingLeft),
          };
        });
        expect(geometry.paneWidth).toBeGreaterThan(250);
        expect(geometry.contentWidth).toBeGreaterThan(200);
        expect(geometry.left).toBeGreaterThanOrEqual(-1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.paneRight + 1);
        expect(geometry.mainPaddingLeft).toBeLessThanOrEqual(27);
        if (screen === 'tools') {
          const cards = pane.locator('.tool-card');
          await expect.poll(() => cards.count()).toBeGreaterThan(0);
          // A populated catalog can still be unusable when grid tracks shrink to 2px.
          expect(await cards.first().evaluate((card) => card.getBoundingClientRect().height))
            .toBeGreaterThan(42);
          const listGeometry = await pane.locator('.tool-card-list').evaluate((list) => ({
            height: list.clientHeight, firstCardTop: list.firstElementChild?.getBoundingClientRect().top ?? 0,
            bottom: list.getBoundingClientRect().bottom,
          }));
          expect(listGeometry.height, `Tools list must remain usable at ${size.width}x${size.height}`)
            .toBeGreaterThan(140);
          expect(listGeometry.firstCardTop).toBeLessThan(listGeometry.bottom);
        }
        if (size.width > 640) expect(geometry.sideWidth).toBeLessThanOrEqual(201);
        else {
          expect(geometry.sideHeight).toBeLessThan(66);
          expect(geometry.navScrollWidth).toBeGreaterThan(geometry.navClientWidth);
        }
      }
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [navigation, selector] of [
      ['Projects', '.project-list-scroll'],
      ['Running Projects', '.active-projects-scroll'],
      ['Work Log', '.worklog-stream'],
      ['Live Logs', '.log-stream'],
    ] as const) {
      await page.locator('.sidebar-nav').getByRole('button', { name: navigation, exact: true }).click();
      const scroller = page.locator(selector);
      await expect(scroller).toBeVisible();
      const bounds = await scroller.evaluate((element) => ({
        height: element.clientHeight, top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        paneTop: document.querySelector('.main-pane')!.getBoundingClientRect().top,
        paneBottom: document.querySelector('.main-pane')!.getBoundingClientRect().bottom,
      }));
      expect(bounds.height, navigation).toBeGreaterThan(150);
      expect(bounds.top, navigation).toBeGreaterThanOrEqual(bounds.paneTop);
      expect(bounds.bottom, navigation).toBeLessThanOrEqual(bounds.paneBottom + 1);
    }
    await page.locator('.sidebar-nav').getByRole('button', { name: 'Projects', exact: true }).click();
    const projectScroll = page.locator('.project-list-scroll');
    await expect(projectScroll.locator('.project-list li')).toHaveCount(19);
    const projectHeights = await projectScroll.evaluate((element) => ({
      client: element.clientHeight, scroll: element.scrollHeight,
    }));
    expect(projectHeights.client).toBeGreaterThan(240);
    expect(projectHeights.scroll).toBeGreaterThan(projectHeights.client);

    await page.locator('.sidebar-nav').getByRole('button', { name: 'Running Projects', exact: true }).click();
    const runningScroll = page.locator('.active-projects-scroll');
    await expect(runningScroll.locator('li')).toHaveCount(19);
    const runningHeight = await runningScroll.evaluate((element) => element.clientHeight);
    expect(runningHeight).toBeGreaterThan(220);

    // A tall window legitimately needs no page scroll. Make the diff viewport
    // short enough to exercise the long-document scrolling branch.
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.locator('.sidebar-nav').getByRole('button', { name: 'Git', exact: true }).click();
    const changedFile = page.getByRole('treeitem', { name: 'notes.txt' });
    await expect(changedFile).toBeVisible({ timeout: 15_000 });
    await changedFile.click();
    await expect(page.locator('.git-page--diff-open')).toBeVisible();
    const diffScroll = await page.locator('.main-pane').evaluate((element) => {
      const originalTop = element.scrollTop;
      element.scrollTop = element.scrollHeight;
      return { overflowY: getComputedStyle(element).overflowY,
        before: originalTop, after: element.scrollTop, available: element.scrollHeight - element.clientHeight };
    });
    expect(diffScroll.overflowY).toBe('auto');
    expect(diffScroll.available).toBeGreaterThan(0);
    expect(diffScroll.after).toBeGreaterThan(diffScroll.before);

    await page.setViewportSize({ width: 560, height: 700 });
    await page.locator('.sidebar-nav').getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsNav = page.locator('.settings-subnav');
    await expect(settingsNav).toBeVisible();
    const navSize = await settingsNav.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(navSize.scroll).toBeGreaterThan(navSize.client);
    await settingsNav.locator('.settings-nav-item').last().click();
    await expect(settingsNav.locator('.settings-nav-item').last()).toHaveAttribute('aria-current', 'page');
    // Thai labels are typically wider than English; validate both locales.
    await page.locator('.locale-switch button').first().click();
    await expect(page.locator('.locale-switch button').first()).toHaveClass(/active/);
    for (const size of [{ width: 900, height: 700 }, { width: 560, height: 700 }]) {
      await page.setViewportSize(size);
      for (const [index, [, screen]] of screens.entries()) {
        await page.locator('.sidebar-nav > button').nth(index).click();
        const pane = page.locator('.main-pane');
        await expect(pane).toHaveAttribute('data-screen', screen);
        const geometry = await pane.evaluate((element) => {
          const paneBounds = element.getBoundingClientRect();
          const content = element.querySelector<HTMLElement>('.main-content')!.firstElementChild!.getBoundingClientRect();
          return { paneRight: paneBounds.right, contentRight: content.right, contentLeft: content.left,
            width: content.width };
        });
        expect(geometry.width).toBeGreaterThan(200);
        expect(geometry.contentLeft).toBeGreaterThanOrEqual(-1);
        expect(geometry.contentRight).toBeLessThanOrEqual(geometry.paneRight + 1);
      }
    }
  } finally {
    // _electron.close() can end the browser parent before its Windows
    // descendants. The native release Job waits for every descendant, so
    // terminate only this test-owned Electron tree while its root still lives.
    if (app !== undefined) {
      if (process.platform === 'win32') await terminateProcessTree(app.process());
      await app.close().catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
