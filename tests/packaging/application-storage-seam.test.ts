import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const applicationRoot = path.join(repositoryRoot, 'packages', 'application');
const storageRoot = path.join(repositoryRoot, 'packages', 'storage');

describe('application-storage seam', () => {
  it('keeps production dependencies pointing inward instead of across the adapter seam', async () => {
    const manifest = JSON.parse(await readFile(path.join(applicationRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect({ ...manifest.dependencies, ...manifest.devDependencies }).not.toHaveProperty('@lnwjing/storage');

    for (const filename of await productionTypescriptFiles(applicationRoot)) {
      const source = await readFile(filename, 'utf8');
      expect(source, path.relative(repositoryRoot, filename)).not.toMatch(
        /(?:from\s+['"]@lnwjing\/storage['"]|from\s+['"][^'"]*\/storage\/src\/)/,
      );
    }

    for (const filename of await productionTypescriptFiles(storageRoot)) {
      const source = await readFile(filename, 'utf8');
      expect(source, path.relative(repositoryRoot, filename)).not.toMatch(
        /(?:from\s+['"]@lnwjing\/application['"]|from\s+['"][^'"]*\/application\/src\/)/,
      );
    }
  });
});

async function productionTypescriptFiles(packageRoot: string): Promise<readonly string[]> {
  const sourceRoot = path.join(packageRoot, 'src');
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
