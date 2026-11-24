import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SharedManagedWriterAdmission, SqliteWorkspaceWriterLease } from '@lnwjing/capabilities';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..', '..');

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  if (address === null || typeof address === 'string') throw new Error('No loopback port');
  return address.port;
}

async function withRuntime(action: (context: {
  app: ElectronApplication; page: Page; client: Client; connect: () => Promise<Client>; root: string; first: string; second: string;
  good: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) => Promise<void>, prepare?: (first: string, second: string) => Promise<void>): Promise<void> {
  const base = path.join(repo, '.audit');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'independent-acceptance-'));
  const [profile, first, second, roaming, local, temp] = ['profile', 'first-project', 'second-project', 'roaming', 'local', 'temp'].map(n => path.join(root, n)) as [string,string,string,string,string,string];
  const clients: Client[] = [];
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    await Promise.all([profile, first, second, roaming, local, temp].map(dir => mkdir(dir)));
    await writeFile(path.join(first, 'alpha.txt'), 'first-sentinel\n');
    await writeFile(path.join(second, 'beta.txt'), 'second-sentinel\n');
    await prepare?.(first, second);
    const env = { ...process.env };
    delete env.LNWJING_E2E_FIXTURE;
    delete env.LNWJING_UNRESTRICTED;
    delete env.LNWJING_E2E_NODE_PATH;
    const exe = process.env.LNWJING_PACKAGED_EXECUTABLE?.trim();
    app = await _electron.launch({
      executablePath: exe || electronExecutablePath(desktop),
      args: ['--user-data-dir=' + profile, '--disable-background-networking', ...(exe ? [] : [path.join(desktop, 'dist', 'main', 'main.js')])],
      cwd: desktop,
      env: { ...env, LNWJING_DATA_PATH: profile, LNWJING_WORKSPACE: first, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
        LNWJING_MCP_PORT: String(await freePort()) },
      timeout: 45_000,
    });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(String(error)));
    await settleFirstRunAndOpenHome(page);
    const dashboard = await page.evaluate(() => window.lnwjing.getDashboard());
    expect(dashboard.permissionProfile).toBe('balanced');
    expect(dashboard.selectedWorkspace?.realRootPath.toLowerCase()).toBe(first.toLowerCase());
    const endpoint = new URL(dashboard.mcp.url!);
    expect(endpoint.hostname).toBe('127.0.0.1');
    const connect = async (): Promise<Client> => {
      const client = new Client({ name: 'independent-' + randomUUID(), version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      return client;
    };
    const client = await connect();
    const good = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name + ': ' + JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(result.structuredContent, name).toBeDefined();
      return result.structuredContent as Record<string, unknown>;
    };
    await action({ app, page, client, connect, root, first, second, good });
    expect(errors).toEqual([]);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  }
}

async function nav(page: Page, label: RegExp): Promise<void> {
  await page.locator('.sidebar-nav').getByRole('button', { name: label }).click();
}

test('real user journey: add and remove project, exact-edit conflict, scoped concurrent reads, work log', async () => {
  test.setTimeout(150_000);
  await withRuntime(async ({ app, page, client, connect, first, second, good }) => {
    const firstId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const secondName = path.basename(second);
    await nav(page, /^(Projects|โปรเจกต์)$/);
    await page.locator('#workspace-root').fill(second);
    await page.getByRole('button', { name: /^(Add project|เพิ่มโปรเจกต์)$/ }).click();
    const secondRow = page.locator('.project-list li').filter({ hasText: secondName });
    await expect(secondRow).toBeVisible();
    const registered = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.realRootPath.toLowerCase() === second.toLowerCase());
    expect(registered).toBeDefined();
    const secondId = registered!.id;
    const peer = await connect();
    const marker = 'audit-' + randomUUID();
    const a = 'alpha ' + marker + '\n';
    const b = 'beta ' + marker + '\n';
    await test.step('both actual clients operate on explicit workspace scopes', async () => {
      const results = await Promise.all([
        client.callTool({ name: 'read_file', arguments: { workspaceId: firstId, path: 'alpha.txt' } }),
        peer.callTool({ name: 'read_file', arguments: { workspaceId: secondId, path: 'beta.txt' } }),
      ]);
      expect(results[0]?.structuredContent).toMatchObject({ content: 'first-sentinel\n' });
      expect(results[1]?.structuredContent).toMatchObject({ content: 'second-sentinel\n' });
      await good('write_file', { workspaceId: firstId, path: marker + '.txt', content: a });
      await good('write_file', { workspaceId: secondId, path: marker + '.txt', content: b });
      expect(await readFile(path.join(first, marker + '.txt'), 'utf8')).toBe(a);
      expect(await readFile(path.join(second, marker + '.txt'), 'utf8')).toBe(b);
    });
    await test.step('stale exact edit must fail without overwriting either project', async () => {
      await good('edit_file', { workspaceId: firstId, path: marker + '.txt', oldText: 'alpha', newText: 'changed', expectedOccurrences: 1 });
      const stale = await client.callTool({ name: 'edit_file', arguments: { workspaceId: firstId, path: marker + '.txt', oldText: 'alpha', newText: 'wrong', expectedOccurrences: 1 } });
      expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      expect(await readFile(path.join(first, marker + '.txt'), 'utf8')).toBe(a.replace('alpha', 'changed'));
      expect(await readFile(path.join(second, marker + '.txt'), 'utf8')).toBe(b);
    });
    await test.step('Work Log contains events from real MCP calls, not seeded rows', async () => {
      await nav(page, /^(Work Log|บันทึกการทำงาน)$/);
      const input = page.locator('.worklog-search');
      await expect(input).toBeVisible();
      const start = Date.now();
      await input.fill(marker);
      await expect(input).toHaveValue(marker);
      expect(Date.now() - start).toBeLessThan(2000);
      await expect(page.getByTestId('work-log')).toContainText(marker, { timeout: 15_000 });
      await expect(page.getByTestId('work-log')).toContainText('edit_file');
    });
    await test.step('removing a registration never removes project files', async () => {
      await nav(page, /^(Projects|โปรเจกต์)$/);
      await secondRow.locator('.project-delete-button').click();
      await expect(secondRow.locator('.project-delete-hint')).toBeVisible();
      await secondRow.locator('.project-cancel-button').click();
      await expect(secondRow).toBeVisible();
      await secondRow.locator('.project-delete-button').click();
      const opened = app.waitForEvent('window');
      await secondRow.locator('.project-delete-button.confirm').click();
      const approval = await opened;
      await expect(approval.getByRole('alertdialog')).toContainText(secondName);
      await expect(approval.getByRole('alertdialog')).toContainText(second);
      // Confirm closes this dedicated window synchronously. Only the expected
      // target-closed race may be ignored; the registration and file assertions
      // below are the independent proof that the click actually succeeded.
      await approval.locator('.mutation-approval-confirm').click().catch((error: unknown) => {
        if (!approval.isClosed() || !String(error).includes('Target page, context or browser has been closed')) throw error;
      });
      await expect(secondRow).toHaveCount(0, { timeout: 15_000 });
      expect(await readFile(path.join(second, 'beta.txt'), 'utf8')).toBe('second-sentinel\n');
      expect(await readFile(path.join(second, marker + '.txt'), 'utf8')).toBe(b);
      const removed = await client.callTool({ name: 'read_file', arguments: { workspaceId: secondId, path: 'beta.txt' } });
      expect(removed.isError).toBe(true);
      expect(JSON.stringify(removed)).not.toContain('second-sentinel');
      expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
    });
  });
});

test('real concurrent background jobs stay scoped and Running Projects tracks independent terminal outcomes', async () => {
  test.setTimeout(120_000);
  await withRuntime(async ({ page, client, connect, first, second, good }) => {
    const firstId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await nav(page, /^(Projects|โปรเจกต์)$/);
    await page.locator('#workspace-root').fill(second);
    await page.getByRole('button', { name: /^(Add project|เพิ่มโปรเจกต์)$/ }).click();
    await expect(page.locator('.project-list li').filter({ hasText: 'second-project' })).toBeVisible();
    const secondId = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.realRootPath.toLowerCase() === second.toLowerCase())!.id;
    const peer = await connect();
    const script = [
      "import { existsSync } from 'node:fs';",
      "const until = Date.now() + 40000;",
      "const timer = setInterval(() => {",
      " if (existsSync('release')) { clearInterval(timer); console.log('CHILD_DONE:' + process.argv[2]); process.exitCode = Number(process.argv[2]); }",
      " else if (Date.now() > until) { clearInterval(timer); process.exitCode = 99; }",
      "}, 100);",
    ].join('\n');
    await Promise.all([first, second].map(dir => writeFile(path.join(dir, 'child.mjs'), script)));
    const ids: { workspaceId: string; task_id: string; client: Client }[] = [];
    const status = async (entry: typeof ids[number]): Promise<Record<string, unknown> | undefined> =>
      (await entry.client.callTool({ name: 'shell', arguments: { workspaceId: entry.workspaceId, operation: 'status', task_id: entry.task_id } })).structuredContent;
    try {
      const startA = await good('shell', { workspaceId: firstId, executable: 'node', arguments: ['child.mjs', '0'], timeout_seconds: 50 });
      ids.push({ workspaceId: firstId, task_id: String(startA.task_id), client });
      const startB = await peer.callTool({ name: 'shell', arguments: { workspaceId: secondId, executable: 'node', arguments: ['child.mjs', '7'], timeout_seconds: 50 } });
      expect(startB.isError).not.toBe(true);
      ids.push({ workspaceId: secondId, task_id: String(startB.structuredContent?.task_id), client: peer });
      expect(ids[0]!.task_id).not.toBe(ids[1]!.task_id);
      await nav(page, /^Running Projects$/);
      const firstCard = page.locator('.active-projects-item').filter({ hasText: 'first-project' }).locator('.active-projects-state');
      const secondCard = page.locator('.active-projects-item').filter({ hasText: 'second-project' }).locator('.active-projects-state');
      await expect(firstCard).toHaveClass(/active-projects-state running/, { timeout: 15_000 });
      await expect(secondCard).toHaveClass(/active-projects-state running/, { timeout: 15_000 });
      const wrong = await client.callTool({ name: 'shell', arguments: { workspaceId: secondId, operation: 'status', task_id: ids[0]!.task_id } });
      expect(wrong.isError).toBe(true);
      await writeFile(path.join(first, 'release'), 'go');
      await expect.poll(async () => (await status(ids[0]!))?.state, { timeout: 20_000 }).toBe('completed');
      expect(await status(ids[1]!)).toMatchObject({ state: 'running' });
      await expect(firstCard).not.toHaveClass(/active-projects-state running/, { timeout: 15_000 });
      await expect(secondCard).toHaveClass(/active-projects-state running/);
      await writeFile(path.join(second, 'release'), 'go');
      await expect.poll(async () => (await status(ids[1]!))?.state, { timeout: 20_000 }).toBe('failed');
      const resultA = await good('shell', { workspaceId: firstId, operation: 'result', task_id: ids[0]!.task_id });
      const resultB = (await peer.callTool({ name: 'shell', arguments: { workspaceId: secondId, operation: 'result', task_id: ids[1]!.task_id } })).structuredContent;
      expect(resultA).toMatchObject({ exit_code: 0, stdout: expect.stringContaining('CHILD_DONE:0') });
      expect(resultB).toMatchObject({ exit_code: 7, stdout: expect.stringContaining('CHILD_DONE:7') });
      await expect(secondCard).not.toHaveClass(/active-projects-state running/, { timeout: 15_000 });
    } finally {
      await Promise.all([first, second].map(dir => writeFile(path.join(dir, 'release'), 'go').catch(() => undefined)));
      for (const entry of ids) await expect.poll(async () => (await status(entry).catch(() => undefined))?.state,
        { timeout: 45_000 }).not.toBe('running').catch(() => undefined);
    }
  });
});

test('real Live Logs: a filter follows new events and Pause/Follow has truthful semantics', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await nav(page, /^Live Logs$/);
    await page.getByRole('tab', { name: 'MCP activity' }).click();
    const input = page.locator('.log-panel .log-filter');
    const stream = page.getByTestId('log-stream');
    const marker = 'live-' + randomUUID();
    await input.fill(marker);
    await good('write_file', { workspaceId, path: marker + '-one.txt', content: 'first' });
    await expect(stream).toContainText(marker + '-one.txt', { timeout: 15_000 });
    await page.getByRole('button', { name: /^(Pause|หยุดชั่วคราว)$/ }).click();
    await good('write_file', { workspaceId, path: marker + '-two.txt', content: 'second' });
    // Observe the actual main-process snapshot before asserting that the
    // paused renderer has intentionally not followed the second event.
    await expect.poll(async () => (await page.evaluate(() => window.lnwjing.getLogSnapshot())).lines
      .some(line => line.source === 'mcp' && line.text.includes(marker + '-two.txt')), { timeout: 15_000 }).toBe(true);
    await expect(stream).not.toContainText(marker + '-two.txt');
    await page.getByRole('button', { name: /^(Follow|ตามต่อ \(follow\))$/ }).click();
    await expect(stream).toContainText(marker + '-two.txt', { timeout: 15_000 });
    await expect(input).toHaveValue(marker);
  });
});

test('real AI read/search contracts preserve line boundaries, literal matching, and workspace scope', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, client, first, second, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const lines = Array.from({ length: 23 }, (_, i) => 'line-' + (i + 1) + (i === 7 ? ' literal.*needle' : ''));
    await writeFile(path.join(first, 'paged.txt'), lines.join('\n'));
    await writeFile(path.join(first, 'decoy.txt'), 'literalXYZneedle');
    const search = await good('search_text', { workspaceId, query: 'literal.*needle', maxResults: 10 });
    const nodePathNormalize = (value: string): string => path.normalize(value);
    const normalizedMatches = (value: Record<string, unknown>): { path: string; line: number; text: string }[] => (value.matches as { path: string; line: number; text: string }[]).map(match => ({ ...match, path: nodePathNormalize(match.path) }));
    expect(normalizedMatches(search)).toEqual([expect.objectContaining({ path: 'paged.txt', line: 8, text: lines[7] })]);
    const regex = await good('search_text', { workspaceId, query: 'literal.*needle', regex: true, maxResults: 10 });
    expect(normalizedMatches(regex)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'decoy.txt', line: 1 })]));
    const files = await good('search_files', { workspaceId, glob: '*.txt', maxResults: 10 });
    expect((files.paths as string[]).map(nodePathNormalize)).toEqual(expect.arrayContaining(['alpha.txt', 'paged.txt', 'decoy.txt']));
    let result = await good('read_file_page', { workspaceId, path: 'paged.txt', startLine: 1, pageSize: 5 });
    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      expect(result.startLine).toBe(received.length + 1);
      expect(result.endLine).toBe(Math.min((i + 1) * 5, lines.length));
      received.push(...String(result.content).split('\n'));
      if (i < 4) {
        expect(result.hasMore).toBe(true);
        expect(typeof result.continuationToken).toBe('string');
        result = await good('read_file_page_continue', { continuationToken: result.continuationToken, pageSize: 5 });
      }
    }
    expect(result.hasMore).toBe(false);
    expect(received).toEqual(lines);
    for (const unsafe of ['../second-project/beta.txt', path.join(second, 'beta.txt')]) {
      const denied = await client.callTool({ name: 'read_file', arguments: { workspaceId, path: unsafe } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain('second-sentinel');
    }
    const missing = await client.callTool({ name: 'read_file', arguments: { workspaceId, path: 'absent.txt' } });
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'FILE_NOT_FOUND' } } });
  });
});

test('real Git staged and unstaged content agrees with git CLI and rendered diff; all ten routes remain reachable', async () => {
  test.setTimeout(120_000);
  await withRuntime(async ({ page, first, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const staged = execFileSync('git', ['diff', '--cached', '--', 'alpha.txt'], { cwd: first, encoding: 'utf8' });
    const working = execFileSync('git', ['diff', '--', 'alpha.txt'], { cwd: first, encoding: 'utf8' });
    expect(staged).toContain('+staged-sentinel');
    expect(working).toContain('+working-sentinel');
    expect((await good('git_diff', { workspaceId, path: 'alpha.txt', staged: true })).patch).toBe(staged);
    expect((await good('git_diff', { workspaceId, path: 'alpha.txt', staged: false })).patch).toBe(working);
    await nav(page, /^Git$/);
    await page.getByRole('treeitem', { name: 'alpha.txt' }).click();
    const diff = page.locator('.git-diff-container-section');
    await expect(diff).toContainText('working-sentinel');
    await expect(diff).toContainText('staged-sentinel');
    await diff.getByRole('button', { name: 'HEAD → Index (Staged)' }).click();
    await expect(diff).toContainText('first-sentinel');
    await expect(diff).toContainText('staged-sentinel');
    await expect(diff).not.toContainText('working-sentinel');
    const screens = ['home', 'projects', 'active-projects', 'workflows', 'tools', 'git', 'worklog', 'live', 'settings', 'doctor'];
    for (const size of [{ width: 1280, height: 800 }, { width: 560, height: 700 }]) {
      await page.setViewportSize(size);
      for (const [index, screen] of screens.entries()) {
        await page.locator('.sidebar-nav > button').nth(index).click();
        const pane = page.locator('.main-pane');
        await expect(pane).toHaveAttribute('data-screen', screen);
        await expect(pane.locator('.main-content > *')).toBeVisible();
        const fits = await pane.evaluate(element => {
          const content = element.querySelector('.main-content')!.firstElementChild!.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return content.width > 200 && content.left >= -1 && content.right <= bounds.right + 1;
        });
        expect(fits, screen + ' at ' + size.width).toBe(true);
      }
    }
  }, async (first) => {
    const git = (args: string[]): string => execFileSync('git', args, { cwd: first, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '--', 'alpha.txt']);
    git(['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=fixture@invalid.example', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    await writeFile(path.join(first, 'alpha.txt'), 'staged-sentinel\n');
    git(['add', '--', 'alpha.txt']);
    await writeFile(path.join(first, 'alpha.txt'), 'working-sentinel\n');
  });
});

test('real Git responses arriving out of order cannot overwrite the selected file', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ app, page, first }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const expected = execFileSync('git', ['diff', '--', 'alpha.txt'], { cwd: first, encoding: 'utf8' });
    const channel = 'lnwjing:get-git-diff';
    // Fault injection delays delivery of a genuine completed IPC result,
    // rather than mocking Git, the preload bridge, or the renderer response.
    await app.evaluate(({ ipcMain }, name) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => Promise<{ patch: string }>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const original = handlers.get(name);
      if (!original) throw new Error('Real Git IPC handler not found');
      const state = { original, held: null as null | string, release: null as null | (() => void), returned: false };
      Reflect.set(globalThis, '__acceptanceGitDelivery', state);
      ipcMain.removeHandler(name);
      ipcMain.handle(name, async (event, payload: { path: string }) => {
        const result = await original(event, payload);
        if (payload.path === 'alpha.txt' && state.held === null) {
          await new Promise<void>(resolve => { state.release = resolve; state.held = result.patch; });
          state.returned = true;
        }
        return result;
      });
    }, channel);
    try {
      await nav(page, /^Git$/);
      await page.getByRole('treeitem', { name: 'alpha.txt' }).click();
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, '__acceptanceGitDelivery').held)).toBe(expected);
      await page.getByRole('treeitem', { name: 'beta.txt' }).click();
      const diff = page.locator('.git-diff-container-section');
      await expect(diff).toContainText('beta-current-sentinel');
      await expect(diff).not.toContainText('alpha-current-sentinel');
      await app.evaluate(() => { Reflect.get(globalThis, '__acceptanceGitDelivery').release(); });
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, '__acceptanceGitDelivery').returned)).toBe(true);
      // Round-trip through the same IPC channel and let the renderer settle
      // the previous delivery before checking the selected file again.
      const readback = await page.evaluate(request => window.lnwjing.getGitDiff(request), { workspaceId, path: 'beta.txt', staged: false });
      expect(readback.patch).toContain('+beta-current-sentinel');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(diff).toContainText('beta-current-sentinel');
      await expect(diff).not.toContainText('alpha-current-sentinel');
    } finally {
      await app.evaluate(({ ipcMain }, name) => {
        const state = Reflect.get(globalThis, '__acceptanceGitDelivery');
        state.release?.();
        ipcMain.removeHandler(name);
        ipcMain.handle(name, state.original);
        Reflect.deleteProperty(globalThis, '__acceptanceGitDelivery');
      }, channel);
    }
  }, async first => {
    const git = (args: string[]): string => execFileSync('git', args, { cwd: first, encoding: 'utf8' });
    await writeFile(path.join(first, 'beta.txt'), 'beta-original\n');
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '--', 'alpha.txt', 'beta.txt']);
    git(['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=fixture@invalid.example', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    await writeFile(path.join(first, 'alpha.txt'), 'alpha-current-sentinel\n');
    await writeFile(path.join(first, 'beta.txt'), 'beta-current-sentinel\n');
  });
});

test('real Git preview never invents additions for clean, unstaged-only or ignored files', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, first }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const diff = async (name: string, staged: boolean): Promise<string> =>
      (await page.evaluate(request => window.lnwjing.getGitDiff(request), { workspaceId, path: name, staged })).patch;
    const git = (args: string[]): string => execFileSync('git', args, { cwd: first, encoding: 'utf8' });
    expect(git(['diff', '--', 'alpha.txt'])).toBe('');
    expect(git(['diff', '--cached', '--', 'alpha.txt'])).toBe('');
    expect.soft(await diff('alpha.txt', false)).toBe('');
    expect.soft(await diff('alpha.txt', true)).toBe('');
    await writeFile(path.join(first, 'alpha.txt'), 'working-only\n');
    expect.soft(await diff('alpha.txt', true)).toBe(git(['diff', '--cached', '--', 'alpha.txt']));
    expect.soft(await diff('alpha.txt', false)).toBe(git(['diff', '--', 'alpha.txt']));
    await writeFile(path.join(first, 'untracked.txt'), 'new-sentinel\n');
    expect.soft(await diff('untracked.txt', true)).toBe('');
    expect.soft(await diff('untracked.txt', false)).toContain('+new-sentinel');
    await writeFile(path.join(first, 'ignored.txt'), 'ignored-sentinel\n');
    expect.soft(await diff('ignored.txt', false)).toBe('');
  }, async first => {
    const git = (args: string[]): string => execFileSync('git', args, { cwd: first, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(first, '.gitignore'), 'ignored.txt\n');
    git(['add', '--', 'alpha.txt', '.gitignore']);
    git(['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=fixture@invalid.example', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  });
});

test('real project lifecycle refuses archive while a durable shell job is still running', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, client, first, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await writeFile(path.join(first, 'wait.mjs'), "import { existsSync } from 'node:fs';\nconst end = Date.now() + 30000;\nconst t = setInterval(() => { if (existsSync('release') || Date.now() > end) clearInterval(t); }, 100);\n");
    const job = await good('shell', { workspaceId, executable: 'node', arguments: ['wait.mjs'], timeout_seconds: 40 });
    const taskId = String(job.task_id);
    const taskStatus = async (): Promise<unknown> => (await client.callTool({ name: 'shell', arguments: { workspaceId, operation: 'status', task_id: taskId } })).structuredContent?.state;
    try {
      await expect.poll(taskStatus).toBe('running');
      await nav(page, /^(Projects|โปรเจกต์)$/);
      const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
      await row.locator('.project-archive-button').click();
      await expect.poll(async () => {
        const current = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.id === workspaceId);
        return current?.archivedAt ? 'archived' : (await page.locator('.error-banner').count()) > 0 ? 'rejected' : 'pending';
      }).toBe('rejected');
      await expect(page.locator('.error-banner')).toContainText('background job running');
      expect((await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.id === workspaceId)?.archivedAt ?? null).toBeNull();
      await expect(row).not.toHaveClass('archived');
      expect.soft(await taskStatus()).toBe('running');
    } finally {
      await writeFile(path.join(first, 'release'), 'go');
      // Restore only our disposable registration if the baseline incorrectly archived it.
      const current = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.id === workspaceId);
      if (current?.archivedAt) await page.evaluate(id => window.lnwjing.setWorkspaceArchived({ workspaceId: id, archived: false }), workspaceId);
      await expect.poll(taskStatus, { timeout: 40_000 }).toBe('completed');
    }
    const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
    await row.locator('.project-archive-button').click();
    await expect(row).toHaveClass('archived');
    expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
    const denied = await client.callTool({ name: 'read_file', arguments: { workspaceId, path: 'alpha.txt' } });
    expect(denied.isError).toBe(true);
    await row.getByRole('button', { name: /^(Restore|นำกลับมาใช้งาน)$/ }).click();
    await expect(row).not.toHaveClass('archived');
    expect(await good('read_file', { workspaceId, path: 'alpha.txt' })).toMatchObject({ content: 'first-sentinel\n' });
  });
});

test('real deletion rechecks a managed process that starts during native approval', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ app, page, first, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await writeFile(path.join(first, 'wait.mjs'), "import { existsSync } from 'node:fs';\nconst end = Date.now() + 30000;\nconst t = setInterval(() => { if (existsSync('release') || Date.now() > end) clearInterval(t); }, 100);\n");
    await nav(page, /^(Projects|โปรเจกต์)$/);
    const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
    await row.locator('.project-delete-button').click();
    const opened = app.waitForEvent('window');
    await row.locator('.project-delete-button.confirm').click();
    const approval = await opened;
    await expect(approval.getByRole('alertdialog')).toContainText(first);
    const process = await good('process_start', { workspaceId, executable: 'node', args: ['wait.mjs'], timeoutMs: 40000 });
    const processId = String(process.processId);
    const status = async (): Promise<Record<string, unknown>> => good('process_status', { workspaceId, processId });
    try {
      await expect.poll(status).toMatchObject({ state: 'running' });
      await approval.locator('.mutation-approval-confirm').click().catch((error: unknown) => {
        if (!approval.isClosed() || !String(error).includes('Target page, context or browser has been closed')) throw error;
      });
      await expect(page.locator('.error-banner')).toContainText('background job running');
      await expect(row).toBeVisible();
      expect((await page.evaluate(() => window.lnwjing.listWorkspaces())).some(w => w.id === workspaceId)).toBe(true);
      expect(await status()).toMatchObject({ state: 'running' });
      expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
    } finally {
      await writeFile(path.join(first, 'release'), 'go');
      await expect.poll(status, { timeout: 40_000 }).toMatchObject({ state: 'exited', exitCode: 0 });
    }
  });
});

test('real workflow preview cannot attach a stale draft to a different selected template', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, first, second, client, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const args = { workspaceId, templateId: 'project-check', inputs: { projectPath: first, focus: 'general' } };
    const draft = await good('workflow_prepare', args);
    expect(draft).toMatchObject({ workspaceId, templateId: 'project-check', readiness: 'ready' });
    expect((await good('workflow_prepare', args)).digest).toBe(draft.digest);
    const outside = await client.callTool({ name: 'workflow_prepare', arguments: { ...args, inputs: { ...args.inputs, projectPath: second } } });
    expect(outside.isError).toBe(true);
    const tampered = await client.callTool({ name: 'workflow_start', arguments: { draft: { ...draft, objective: 'not the prepared objective' }, idempotencyKey: randomUUID() } });
    expect(tampered).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    await nav(page, /^(Workflows|เวิร์กโฟลว์)$/);
    const project = page.locator('.workflow-card').filter({ hasText: /Project Check|ตรวจสอบโปรเจกต์/ });
    const review = page.locator('.workflow-card').filter({ hasText: /Code Review|รีวิวโค้ด/ });
    await project.click();
    const prepare = page.locator('.workflow-config .workflow-primary-action');
    await prepare.click();
    await expect(page.locator('.workflow-preview')).toContainText('Project Check');
    await project.click();
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    // Both events run in the same renderer turn. The first sends a real IPC
    // prepare request; the second changes the selected template before its
    // asynchronous result can be delivered.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.workflow-config .workflow-primary-action')!.click();
      Array.from(document.querySelectorAll<HTMLButtonElement>('.workflow-card')).find(card => /Code Review|รีวิวโค้ด/.test(card.innerText))!.click();
    });
    await expect(review).toHaveClass(/selected/);
    await expect(prepare).toBeEnabled();
    expect(await page.locator('.workflow-preview').count()).toBe(0);
    await prepare.click();
    await expect(page.locator('.workflow-preview')).toContainText('Code Review');
    await expect(page.locator('.workflow-preview')).not.toContainText('Project Check');
  });
});

test('real index watcher handles external create, rename, delete and project deactivation', async () => {
  test.setTimeout(120_000);
  await withRuntime(async ({ page, first, second, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await nav(page, /^(Projects|โปรเจกต์)$/);
    await page.locator('#workspace-root').fill(second);
    await page.getByRole('button', { name: /^(Add project|เพิ่มโปรเจกต์)$/ }).click();
    await expect(page.locator('.project-list li').filter({ hasText: 'second-project' })).toBeVisible();
    const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
    const controls = row.locator('.project-watcher-controls');
    await controls.getByRole('button', { name: /^(Refresh status|ดูสถานะ)$/ }).click();
    const start = controls.getByRole('button', { name: /^(Start watcher|เปิด Watcher)$/ });
    await expect(start).toBeEnabled();
    await start.click();
    const compact = async (): Promise<Record<string, unknown>> => good('workspace_index_status', { workspaceId, summaryOnly: true });
    await expect.poll(compact).toMatchObject({ snapshotEntryCount: 1, snapshotEntriesOmitted: true, watcher: expect.any(Object) });
    expect((await compact()).snapshot).toMatchObject({ entries: [] });
    const paths = async (): Promise<string[]> => {
      const status = await good('workspace_index_status', { workspaceId, summaryOnly: false });
      const snapshot = status.snapshot as { entries: { relativePath: string }[] };
      return snapshot.entries.map(entry => entry.relativePath).sort();
    };
    await writeFile(path.join(first, 'watch-one.txt'), 'new content');
    await expect.poll(paths, { timeout: 15_000 }).toEqual(['alpha.txt', 'watch-one.txt']);
    await rename(path.join(first, 'watch-one.txt'), path.join(first, 'watch-two.txt'));
    await expect.poll(paths, { timeout: 15_000 }).toEqual(['alpha.txt', 'watch-two.txt']);
    await rm(path.join(first, 'watch-two.txt'));
    await expect.poll(paths, { timeout: 15_000 }).toEqual(['alpha.txt']);
    await row.getByRole('button', { name: /^(Deactivate|ปิดใช้งาน)$/ }).click();
    await expect(row).not.toHaveClass('active');
    await expect.poll(async () => page.evaluate(id => window.lnwjing.getWorkspaceIndexStatus({ workspaceId: id }), workspaceId)).toMatchObject({ watching: false, entryCount: 1 });
    await expect(controls.getByRole('button', { name: /^(Start watcher|เปิด Watcher)$/ })).toBeDisabled();
    expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
  });
});

test('real workflow start preserves idempotency and rejects changed input under the same key', async () => {
  test.setTimeout(90_000);
  await withRuntime(async ({ page, client, first, second, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    const idempotencyKey = randomUUID();
    const args = { workspaceId, templateId: 'project-check', inputs: { projectPath: first, focus: 'tests' } };
    const draft = await good('workflow_prepare', args);
    const started = await good('workflow_start', { draft, idempotencyKey });
    expect(started).toMatchObject({ goalId: expect.any(String), reused: false, workerState: 'attached', scheduledContinuation: 'off' });
    const repeat = await good('workflow_start', { draft, idempotencyKey });
    expect(repeat).toMatchObject({ goalId: started.goalId, reused: true, scheduledContinuation: 'off' });
    const changed = await good('workflow_prepare', { ...args, inputs: { ...args.inputs, focus: 'build' } });
    const conflict = await client.callTool({ name: 'workflow_start', arguments: { draft: changed, idempotencyKey } });
    expect(conflict).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    const state = await good('get_goal', { goalId: started.goalId });
    expect(state).toMatchObject({ goalId: started.goalId, workflow: { inputDigest: draft.digest } });
    await nav(page, /^(Projects|โปรเจกต์)$/);
    await page.locator('#workspace-root').fill(second);
    await page.getByRole('button', { name: /^(Add project|เพิ่มโปรเจกต์)$/ }).click();
    const row = page.locator('.project-list li').filter({ hasText: 'second-project' });
    await expect(row).toHaveClass('active');
    const secondId = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.realRootPath.toLowerCase() === second.toLowerCase())!.id;
    const otherDraft = await good('workflow_prepare', { ...args, workspaceId: secondId, inputs: { ...args.inputs, projectPath: second } });
    await row.getByRole('button', { name: /^(Deactivate|ปิดใช้งาน)$/ }).click();
    await expect(row).not.toHaveClass('active');
    const denied = await client.callTool({ name: 'workflow_start', arguments: { draft: otherDraft, idempotencyKey: randomUUID() } });
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(await readFile(path.join(second, 'beta.txt'), 'utf8')).toBe('second-sentinel\n');
    expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
  });
});

test('real cross-process lifecycle gates block same-workspace mutations but preserve other project work', async () => {
  test.setTimeout(120_000);
  await withRuntime(async ({ page, client, connect, root, first, second, good }) => {
    const workspaceId = (await page.evaluate(() => window.lnwjing.getDashboard())).selectedWorkspace!.id;
    await nav(page, /^(Projects|โปรเจกต์)$/);
    await page.locator('#workspace-root').fill(second);
    await page.getByRole('button', { name: /^(Add project|เพิ่มโปรเจกต์)$/ }).click();
    await expect(page.locator('.project-list li').filter({ hasText: 'second-project' })).toHaveClass('active');
    const secondId = (await page.evaluate(() => window.lnwjing.listWorkspaces())).find(w => w.realRootPath.toLowerCase() === second.toLowerCase())!.id;
    const peer = await connect();
    // The test runner and Electron main are separate OS processes, using the
    // same actual on-disk admission journals in this disposable profile.
    const profile = path.join(root, 'profile');
    const managed = new SharedManagedWriterAdmission(path.join(profile, 'background-tasks'));
    const journal = new SqliteWorkspaceWriterLease(path.join(profile, 'workspace-writer-leases.sqlite'));
    const gate = await managed.holdWorkspaceLifecycle(workspaceId);
    if (!gate.ok) throw new Error(gate.error.message);
    try {
      const blocked = await client.callTool({ name: 'shell', arguments: { workspaceId, executable: 'node', arguments: ['--version'], timeout_seconds: 15 } });
      expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      const other = await peer.callTool({ name: 'write_file', arguments: { workspaceId: secondId, path: 'other.txt', content: 'other-project' } });
      expect(other.isError).not.toBe(true);
      expect(await readFile(path.join(second, 'other.txt'), 'utf8')).toBe('other-project');
      const reservation = await journal.holdWorkspaceLifecycle(workspaceId);
      if (!reservation.ok) throw new Error(reservation.error.message);
      try {
        const denied = await client.callTool({ name: 'write_file', arguments: { workspaceId, path: 'blocked.txt', content: 'not allowed' } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
        await expect(readFile(path.join(first, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
        await row.locator('.project-archive-button').click();
        await expect(page.locator('.error-banner')).toBeVisible();
        await expect(row).not.toHaveClass('archived');
      } finally { await reservation.value.release(); }
    } finally { await gate.value.releaseAfterVerifiedTermination(); }
    await good('write_file', { workspaceId, path: 'allowed.txt', content: 'after release' });
    expect(await readFile(path.join(first, 'allowed.txt'), 'utf8')).toBe('after release');
    expect(await journal.inspect(workspaceId)).toMatchObject({ ok: true, value: { activeCalls: 0 } });
    const row = page.locator('.project-list li').filter({ hasText: 'first-project' });
    await row.locator('.project-archive-button').click();
    await expect(row).toHaveClass('archived');
    expect(await readFile(path.join(first, 'alpha.txt'), 'utf8')).toBe('first-sentinel\n');
  });
});

test('real packaged MCP catalog: every advertised input schema matches discovery, with no hidden stale names', async () => {
  test.setTimeout(240_000);
  await withRuntime(async ({ client, good, page }) => {
    const list = (await client.listTools()).tools;
    expect(list.length).toBeGreaterThan(200);
    const names = list.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    // Bounded batches keep the GUI responsive while covering every advertised
    // schema, rather than a sample or a comparison of two in-memory registries.
    const defects: string[] = [];
    for (let index = 0; index < list.length; index += 4) {
      await Promise.all(list.slice(index, index + 4).map(async tool => {
        try {
          const described = await good('tool_describe', { name: tool.name });
          expect(described.inputSchema).toEqual(tool.inputSchema);
          expect(tool.description?.trim().length, tool.name).toBeGreaterThan(0);
        } catch (error) { defects.push(tool.name + ': ' + String(error).slice(0, 500)); }
      }));
    }
    console.info('CATALOG_CHECK ' + JSON.stringify({ count: names.length, defects }));
    expect.soft(defects).toEqual([]);
    const missing = await good('tool_search', { query: 'zzqxxnonexistentcatalogzzqxx', limit: 5 });
    expect(missing.totalMatches).toBe(0);
    await nav(page, /^(Tools|เครื่องมือ)$/);
    await expect.poll(() => page.locator('.tool-card').count(), { timeout: 15_000 }).toBeGreaterThan(200);
    const visibleNames = await page.locator('.tool-card code').allTextContents();
    expect(new Set(visibleNames).size).toBe(visibleNames.length);
    const absent = names.filter(name => !visibleNames.includes(name));
    console.info('CATALOG_UI_CHECK ' + JSON.stringify({ advertised: names.length, ui: visibleNames.length, absent }));
    expect(absent).toEqual([]);
  });
});
