import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..', '..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (address === null || typeof address === 'string') throw new Error('No loopback port');
  return address.port;
}

test('real modern HTTP and Electron: discovery, filesystem, goal completion, background activity and tool availability', async () => {
  test.setTimeout(180_000);
  const auditRoot = path.join(repo, '.audit');
  await mkdir(auditRoot, { recursive: true });
  const root = await mkdtemp(path.join(auditRoot, 'behavioral-mcp-'));
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'workspace');
  const gate = path.join(project, 'release-child');
  const marker = randomUUID();
  const original = 'alpha ' + marker + '\nbeta\n';
  const env = { ...process.env };
  delete env.LNWJING_E2E_FIXTURE;
  delete env.LNWJING_UNRESTRICTED;
  delete env.LNWJING_E2E_NODE_PATH;
  await Promise.all([profile, project, path.join(root, 'roaming'), path.join(root, 'local'), path.join(root, 'temp')]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(path.join(project, 'canary.txt'), original);
  await writeFile(path.join(root, 'outside.txt'), 'OUTSIDE_' + marker);
  // The child is released by the test only after UI and MCP agree it is running.
  // It also has its own deadline so a failed assertion cannot leave a long job.
  await writeFile(path.join(project, 'wait.mjs'), [
    "import { existsSync } from 'node:fs';",
    "const until = Date.now() + 30_000;",
    "const timer = setInterval(() => {",
    " if (existsSync('release-child')) { clearInterval(timer); console.log('REAL_CHILD_DONE'); }",
    " else if (Date.now() > until) { clearInterval(timer); process.exitCode = 9; }",
    "}, 100);",
  ].join('\n'));
  let app: ElectronApplication | undefined;
  let client: Client | undefined;
  let taskId: string | undefined;
  let workspaceId: string | undefined;
  const errors: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Awaited<ReturnType<Client['callTool']>>> => {
    if (client === undefined) throw new Error('Client not connected');
    return client.callTool({ name, arguments: args });
  };
  const good = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const result = await call(name, args);
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent as Record<string, unknown>;
  };
  try {
    const executable = process.env.LNWJING_PACKAGED_EXECUTABLE?.trim();
    app = await _electron.launch({
      executablePath: executable || electronExecutablePath(desktop),
      args: ['--user-data-dir=' + profile, '--disable-background-networking', ...(executable ? [] : [path.join(desktop, 'dist', 'main', 'main.js')])],
      cwd: desktop,
      env: { ...env, LNWJING_DATA_PATH: profile, LNWJING_WORKSPACE: project,
        APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
        TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), LNWJING_MCP_PORT: String(await freePort()) },
      timeout: 45_000,
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(String(error)));
    await settleFirstRunAndOpenHome(page);
    const dashboard = await page.evaluate(() => window.lnwjing.getDashboard());
    expect(dashboard.selectedWorkspace?.realRootPath.toLowerCase()).toBe(project.toLowerCase());
    expect(dashboard.permissionProfile).toBe('balanced');
    expect(dashboard.mcp.running).toBe(true);
    const endpoint = new URL(dashboard.mcp.url!);
    expect(endpoint.hostname).toBe('127.0.0.1');
    workspaceId = dashboard.selectedWorkspace!.id;
    const id = workspaceId;
    client = new Client({ name: 'behavioral-e2e', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const list = (await client.listTools()).tools;
    for (const name of ['read_file', 'write_file', 'shell', 'run_goal', 'finish_goal', 'permission_check']) {
      const described = await good('tool_describe', { name });
      expect(described.inputSchema).toEqual(list.find((tool) => tool.name === name)?.inputSchema);
      const found = await good('tool_search', { query: name, limit: 1 });
      expect(found.matches).toMatchObject([{ name }]);
    }
    expect((await good('tool_search', { query: 'zzqxxnonexistenttoolzzqxx' })).totalMatches).toBe(0);
    for (const [query, target] of [
      ['write a file with exact replacement', 'edit_file'],
      ['check permissions before an exact tool invocation', 'permission_check'],
      ['inspect a workspace index status', 'workspace_index_status'],
      ['อ่านไฟล์ในโปรเจกต์', 'read_file'],
    ] as const) {
      const result = await good('tool_search', { query, limit: 5 });
      const names = (result.matches as { name: string }[]).map((entry) => entry.name);
      console.info('DISCOVERY ' + JSON.stringify({ query, total: result.totalMatches, names }));
      expect(names, query).toContain(target);
      expect(result.totalMatches, query).toBeLessThan(list.length / 2);
    }
    const categories = (await good('tool_categories')).categories as { category: string; tools: number }[];
    for (const category of ['workspace', 'file', 'read', 'shell', 'goal']) {
      const count = await good('tool_search', { category, limit: 100 });
      expect(categories.find((entry) => entry.category === category)?.tools, category).toBe(count.totalMatches);
    }

    expect((await good('read_file', { workspaceId: id, path: 'canary.txt' })).content).toBe(original);
    expect((await good('search_text', { workspaceId: id, query: marker })).matches).toHaveLength(1);
    const outside = await call('read_file', { workspaceId: id, path: '../outside.txt' });
    expect(outside).toMatchObject({ isError: true, structuredContent: { error: { code: 'PATH_OUTSIDE_WORKSPACE' } } });
    expect(JSON.stringify(outside)).not.toContain('OUTSIDE_' + marker);
    const first = await good('read_file_page', { workspaceId: id, path: 'canary.txt', pageSize: 1 });
    expect(first.content).toBe('alpha ' + marker);
    const next = await good('read_file_page_continue', { continuationToken: first.continuationToken });
    expect(next.content).toBe('beta');
    expect(await call('read_file_page_continue', { continuationToken: first.continuationToken })).toMatchObject({ isError: true });

    const created = 'created-' + marker;
    await good('write_file', { workspaceId: id, path: 'created.txt', content: created });
    expect(await readFile(path.join(project, 'created.txt'), 'utf8')).toBe(created);
    await page.evaluate(() => window.lnwjing.setPermissionProfile({ profile: 'safe' }));
    const denied = await call('delete_file', { workspaceId: id, path: 'created.txt' });
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(await readFile(path.join(project, 'created.txt'), 'utf8')).toBe(created);
    await page.evaluate(() => window.lnwjing.setPermissionProfile({ profile: 'balanced' }));

    const goal = await good('run_goal', { workspaceId: id, goalKey: 'behavior-' + marker,
      objective: 'Read a canary in an isolated fixture', scheduledContinuation: 'off', ponytailMode: 'off',
      plan: { steps: [{ id: 'read', title: 'Read the canary' }] } });
    expect(goal.acquired).toBe(true);
    const finish = { goalId: goal.goalId, leaseToken: goal.leaseToken, expectedRevision: goal.revision,
      status: 'completed', summary: 'Canary verified', evidence: [{ kind: 'note', value: 'Independent file assertion' }] };
    expect((await call('finish_goal', finish)).isError).toBe(true);
    expect((await good('get_goal', { goalId: goal.goalId })).status).toBe('active');
    const checkpoint = await good('checkpoint_goal', { goalId: goal.goalId, leaseToken: goal.leaseToken,
      expectedRevision: goal.revision, currentPhase: 'verified', summary: 'Canary verified',
      stepUpdates: [{ stepId: 'read', status: 'completed' }], nextAction: 'finish', blockers: [], evidence: [], trackedTasks: [] });
    expect(checkpoint.pendingSteps).toEqual([]);
    // A stale revision cannot be converted to a successful completion.
    expect((await call('finish_goal', finish)).isError).toBe(true);
    finish.expectedRevision = checkpoint.revision;
    expect(await good('permission_check', { tool: 'finish_goal', input: finish })).toMatchObject({ decision: 'allow', sideEffectsStarted: false });
    expect(await good('finish_goal', finish)).toMatchObject({ status: 'completed', completionState: 'completed' });
    expect((await good('get_goal', { goalId: goal.goalId })).status).toBe('completed');

    const launched = await good('shell', { workspaceId: id, operation: 'run', executable: 'node', arguments: ['wait.mjs'], timeout_seconds: 40 });
    taskId = launched.task_id as string;
    expect(taskId).toEqual(expect.any(String));
    await page.locator('.sidebar-nav button').filter({ hasText: 'Running Projects' }).click();
    const status = page.locator('.active-projects-state').first();
    await expect(status).toHaveClass(/active-projects-state running/, { timeout: 15_000 });
    expect((await good('shell', { workspaceId: id, operation: 'status', task_id: taskId })).state).toBe('running');
    await writeFile(gate, 'release');
    await expect.poll(async () => (await good('shell', { workspaceId: id, operation: 'status', task_id: taskId })).state,
      { timeout: 20_000 }).toBe('completed');
    const result = await good('shell', { workspaceId: id, operation: 'result', task_id: taskId });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('REAL_CHILD_DONE');
    await expect(status).not.toHaveClass(/active-projects-state running/, { timeout: 15_000 });

    await page.locator('.sidebar-nav button').filter({ hasText: /^(เครื่องมือ|Tools)$/ }).click();
    const card = page.locator('.tool-card').filter({ has: page.locator('code', { hasText: /^search_text$/ }) });
    const toggle = card.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await client!.listTools()).tools.some((tool) => tool.name === 'search_text')).toBe(false);
    let rejection: unknown;
    try { rejection = await call('search_text', { workspaceId: id, query: marker }); }
    catch (error) { rejection = String(error); }
    expect(JSON.stringify(rejection)).toMatch(/disabled|INVALID_INPUT/i);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await client!.listTools()).tools.some((tool) => tool.name === 'search_text')).toBe(true);
    // The original marker remains in exactly one file.
    expect((await good('search_text', { workspaceId: id, query: 'alpha ' + marker })).matches).toHaveLength(1);
    // Resolving a process executable is not proof that it speaks LSP.
    await page.evaluate(async () => {
      const dashboard = await window.lnwjing.getDashboard();
      await window.lnwjing.setUserSettings({
        settings: { ...dashboard.settings, lspCommands: { typescript: JSON.stringify(['node', '--version']) } },
      });
    });
    const lsp = await call('lsp_diagnostics', { workspaceId: id, file: 'wait.mjs', language: 'typescript' });
    expect(lsp.isError).toBe(true);
    expect(JSON.stringify(lsp.structuredContent)).toMatch(/Language server initialization failed/i);
    expect(errors).toEqual([]);
  } finally {
    // Release any fixture child even if an assertion failed; do not kill the
    // production desktop or any process selected by executable name.
    if (taskId !== undefined && workspaceId !== undefined) {
      await writeFile(gate, 'release').catch(() => undefined);
      if (client !== undefined) await expect.poll(async () => {
        const result = await call('shell', { workspaceId, operation: 'status', task_id: taskId }).catch(() => undefined);
        return result?.structuredContent?.state;
      }, { timeout: 40_000 }).not.toBe('running').catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  }
});
