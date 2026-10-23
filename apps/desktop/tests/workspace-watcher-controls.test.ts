import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';
import { WorkspaceWatcherControls } from '../src/renderer/features/projects/WorkspaceWatcherControls.js';

describe('Desktop per-project index watcher controls', () => {
  it('renders explicit controls and starts with no automatic scan or polling', () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceWatcherControls, {
      workspaceId: 'workspace-1', locale: 'th',
    }));
    expect(markup).toContain('Index Watcher');
    expect(markup).toContain('value="1000"');
    expect(markup).toContain('ดูสถานะ');
    expect(markup).toContain('เปิด Watcher');
    expect(markup).toContain('ปิด Watcher');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('MCP STDIO');
  });

  it('returns only compact telemetry and lets Desktop start/stop one project watcher', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ui-watcher-'));
    const dataPath = path.join(root, 'profile');
    const projectRoot = path.join(root, 'project');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataPath);
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, 'source.ts'), 'export const value = 1;');
    const runtime = createDesktopRuntime(await realpath(dataPath), { checkpointEncryptionKey: Buffer.alloc(32, 0x42) });
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(projectRoot) });
      const initial = await runtime.services.getWorkspaceIndexStatus({ workspaceId: workspace.id });
      expect(initial).toMatchObject({ watching: false, entryCount: 0, indexed: false });
      expect(JSON.stringify(initial)).not.toContain('source.ts');

      const started = await runtime.services.startWorkspaceIndexWatch({ workspaceId: workspace.id, debounceMs: 1000 });
      expect(started).toMatchObject({ watching: true, debounceMs: 1000, indexed: true, entryCount: 1 });
      expect(JSON.stringify(started)).not.toContain('source.ts');
      const stopped = await runtime.services.stopWorkspaceIndexWatch({ workspaceId: workspace.id });
      expect(stopped).toMatchObject({ watching: false, indexed: true, entryCount: 1, debounceMs: null });
      await runtime.services.setWorkspaceArchived({ workspaceId: workspace.id, archived: true });
      await expect(runtime.services.startWorkspaceIndexWatch({ workspaceId: workspace.id, debounceMs: 1000 }))
        .rejects.toThrow('Archived project');
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
