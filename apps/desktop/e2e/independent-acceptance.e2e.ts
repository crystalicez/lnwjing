import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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
