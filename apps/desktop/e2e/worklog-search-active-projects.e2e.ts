import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { AuditService, redactActivityTargetDetail } from '@lnwjing/audit';
import { SqliteAuditRepository, SqliteDatabase } from '@lnwjing/storage';
import { electronExecutablePath } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Work Log first keystroke remains responsive and Active Projects shows real active scopes', async () => {
  test.setTimeout(90_000);
  const data = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-search-speed-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-search-workspace-'));
  const root = await realpath(workspace);
  const database = new SqliteDatabase(path.join(data, 'lnwjing.sqlite'));
  try {
    // One retained hidden detail and many unrelated historical events.
    // Bounded test data (small disk footprint), never the user's live SQLite.
    const detail = redactActivityTargetDetail({
      kind: 'files',
      items: ['visible-one.ts', 'visible-two.ts', 'visible-three.ts', 'zz-hidden-needle.ts'],
    });
    const audit = new AuditService(new SqliteAuditRepository(database));
    await audit.recordMcpTool({
      actorId: 'e2e', actorName: 'e2e', workspaceId: root, callId: 'search-speed-call',
      toolName: 'read_files', phase: 'started', resultCode: 'STARTED', durationMs: 0,
      timestamp: new Date().toISOString(), targetSummary: 'visible-one.ts, visible-two.ts (+2)',
      targetDetail: { detailRef: 'search-speed-call', itemCount: 4,
        preview: ['visible-one.ts', 'visible-two.ts', 'visible-three.ts'], legacyIncomplete: false },
      activityTargetDetail: detail,
    });
    const connection = database.connection;
    const insert = connection.prepare(
      'INSERT INTO audit_events (id, timestamp, actor_id, actor_name, action, result_code, duration_ms, metadata_json)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    connection.exec('BEGIN');
    try {
      for (let i = 0; i < 3_000; i += 1) {
        insert.run('background-' + i, '2025-01-01T00:00:00.000Z',
          'fixture', 'fixture', 'diagnostic:background', 'SUCCESS', 0, '{}');
      }
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  } finally { database.close(); }
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const exe = process.env.LNWJING_PACKAGED_EXECUTABLE ?? electronExecutablePath(desktopRoot);
    app = await _electron.launch({
      executablePath: exe,
      args: process.env.LNWJING_PACKAGED_EXECUTABLE === undefined
        ? ['--user-data-dir=' + data, path.join(desktopRoot, 'dist', 'main', 'main.js')]
        : ['--user-data-dir=' + data],
      cwd: desktopRoot,
      env: {
        ...process.env, LNWJING_DATA_PATH: data, LNWJING_WORKSPACE: root,
        APPDATA: data, LOCALAPPDATA: data, TEMP: data, TMP: data,
        LNWJING_E2E_FIXTURE: '1', LNWJING_E2E_NODE_PATH: process.execPath,
      },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await settleFirstRunAndOpenHome(page);
    await page.getByRole('button', { name: 'Active Projects' }).click();
    await expect(page.getByRole('heading', { name: 'Active Projects' })).toBeVisible();
    await expect(page.locator('.active-projects-list .active-projects-item')).toHaveCount(1);
    await expect(page.locator('.active-projects-name')).toContainText(/Running|Recent|Ready/);
    await page.locator('.sidebar-nav button').filter({ hasText: /บันทึกการทำงาน|Work Log/ }).click();
    const input = page.locator('.worklog-search');
    await expect(input).toBeVisible();
    await expect(page.getByTestId('work-log').locator('.worklog-line').first()).toBeVisible();
    const start = Date.now();
    await input.fill('z');
    await expect(input).toHaveValue('z');
    const firstKeyMs = Date.now() - start;
    expect(firstKeyMs).toBeLessThan(2_000);
    await input.fill('zz');
    await expect(page.getByTestId('work-log')).toContainText('read_files', { timeout: 10_000 });
    console.info('WORKLOG_FIRST_KEY_MS=' + firstKeyMs);
  } finally {
    await app?.close();
    await Promise.all([data, workspace].map((rootPath) => rm(rootPath, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 250,
    })));
  }
});
