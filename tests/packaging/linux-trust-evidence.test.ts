import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('Linux package evidence contract', () => {
  it('pins the modern static AppImage runtime and does not mask FUSE2 regressions in CI', async (): Promise<void> => {
    const builder = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
    const ci = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(builder).toContain('toolsets:');
    expect(builder).toMatch(/appimage:\s*1\.0\.3/);
    expect(ci).not.toContain('libfuse2t64');
  });

  it('checks AppImage/DEB layout without importing foreign signing secrets', async (): Promise<void> => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-linux-release.sh'), 'utf8');
    expect(script).toContain('--appimage-extract');
    expect(script).toContain('dpkg-deb --info');
    expect(script).toContain('lnwjing-linux-host');
    expect(script).toContain('NATIVE_HOST.json');
    expect(script).toContain('must run on Linux');
    expect(script).toContain('-L');
    expect(script).not.toMatch(/CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/);
    expect(script).not.toMatch(/apt-get install|sudo /i);
  });
});
