import { opendir, realpath, type Dirent } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nextFileInventoryPage } from './workspace-file-inventory.js';

vi.mock('node:fs/promises', { spy: true });
vi.mock('@lnwjing/search', async (original) => ({
  ...await original<typeof import('@lnwjing/search')>(),
  acquireDiskScanLease: async (): Promise<{ readonly status: 'granted'; readonly release: () => Promise<void> }> => ({
    status: 'granted', release: async (): Promise<void> => undefined,
  }),
}));

function dirent(name: string, type: 'file' | 'directory' | 'symlink'): Dirent {
  return {
    name,
    isFile: (): boolean => type === 'file',
    isDirectory: (): boolean => type === 'directory',
    isSymbolicLink: (): boolean => type === 'symlink',
  } as Dirent;
}

describe('resumable filesystem inventory', () => {
  it('lists more than 100,000 filenames without revisiting directories or reading contents', async () => {
    const root = process.cwd();
    const entries = Array.from({ length: 100_501 }, (_, index) =>
      dirent(`file-${String(index).padStart(6, '0')}.ts`, 'file'));
    const readDirs = vi.mocked(opendir).mockImplementation(async (): Promise<never> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Dirent> { yield* entries; },
    } as never));
    vi.mocked(realpath).mockImplementation(async (input): Promise<never> => String(input) as never);
    try {
      let cursor;
      const found: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const result = await nextFileInventoryPage(root, cursor, 500, 'automatic', () => true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        found.push(...result.value.paths);
        cursor = result.value.cursor;
      }
      expect(found).toHaveLength(1500);
      expect(found[0]).toBe('file-000000.ts');
      expect(found.at(-1)).toBe('file-001499.ts');
      expect(cursor).toBeDefined();
      expect(readDirs).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(opendir).mockReset();
      vi.mocked(realpath).mockReset();
    }
  });

  it('does not enter excluded directories, protected paths, or symlink directories', async () => {
    const root = process.cwd();
    const children = new Map([
      [root, [
        dirent('.env', 'file'), dirent('.git', 'directory'), dirent('.gitignore', 'file'),
        dirent('ignored.ts', 'file'), dirent('node_modules', 'directory'),
        dirent('src', 'directory'), dirent('linked', 'symlink'),
      ]],
      [path.join(root, 'src'), [dirent('main.ts', 'file')]],
    ]);
    const readDirs = vi.mocked(opendir).mockImplementation(async (directory): Promise<never> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Dirent> {
        yield* children.get(String(directory)) ?? [];
      },
    } as never));
    vi.mocked(realpath).mockImplementation(async (directory): Promise<never> => String(directory) as never);
    try {
      let cursor;
      const paths: string[] = [];
      do {
        const page = await nextFileInventoryPage(root, cursor, 2, 'automatic',
          (relative) => relative !== '.env');
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        paths.push(...page.value.paths);
        cursor = page.value.cursor;
      } while (cursor !== undefined);
      expect(paths).toEqual(expect.arrayContaining(['.gitignore', 'ignored.ts', path.join('src', 'main.ts')]));
      expect(paths).not.toContain('.env');
      expect(paths).toContain('linked');
      // A symlink is listed but never traversed, even in explicit mode.
      expect(readDirs).toHaveBeenCalledTimes(2);
    } finally {
      vi.mocked(opendir).mockReset();
      vi.mocked(realpath).mockReset();
    }
  });
});
