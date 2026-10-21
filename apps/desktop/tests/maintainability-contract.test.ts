import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

async function sourceFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

async function combinedSource(files: readonly string[]): Promise<string> {
  return (await Promise.all(files.map(async (file) => `// ${path.relative(repoRoot, file)}\n${await readFile(file, 'utf8')}`))).join('\n');
}

describe('maintainability contracts', () => {
  it('keeps renderer localization in the catalog instead of inline locale branches', async () => {
    const rendererRoot = path.join(desktopRoot, 'src', 'renderer');
    const source = await combinedSource(await sourceFiles(rendererRoot));
    expect(source).not.toMatch(/\bisTh\b/);
    expect(source).not.toMatch(/\blocale\s*[!=]==?\s*['"]th['"]/);
    expect(source).not.toMatch(/\bprops\.locale\s*[!=]==?\s*['"]th['"]/);
  });

  it('derives i18n keys from the Thai catalog and compile-checks English completeness', async () => {
    const messages = await readFile(path.join(desktopRoot, 'src', 'renderer', 'i18n', 'messages.ts'), 'utf8');
    expect(messages).toContain('export type MessageKey = keyof typeof th;');
    expect(messages).toContain('export const th = {');
    expect(messages).toContain('} as const;');
    expect(messages).toContain('} satisfies Messages;');
    expect(messages).not.toMatch(/export type MessageKey\s*=\s*\r?\n\s*\|/);
  });

  it('keeps obsolete OAuth PIN pairing out of production contracts and Desktop source', async () => {
    const files = [
      ...(await sourceFiles(path.join(desktopRoot, 'src'))),
      ...(await sourceFiles(path.join(repoRoot, 'packages', 'ipc-contracts', 'src'))),
    ];
    const source = await combinedSource(files);
    for (const obsolete of [
      'pairingCode',
      'pairingCodeExpiresAt',
      'pairingRequired',
      'pairing_code',
      'regenerateRemoteMcpPairingCode',
      'Fallback PIN',
      'fallback PIN',
    ]) {
      expect(source, obsolete).not.toContain(obsolete);
    }
  });

  it('uses shared list parsing and shared empty connection-status contracts', async () => {
    const settings = await readFile(path.join(desktopRoot, 'src', 'renderer', 'features', 'settings', 'SettingsPage.tsx'), 'utf8');
    const userConfig = await readFile(path.join(desktopRoot, 'src', 'renderer', 'features', 'settings', 'UserConfigPanel.tsx'), 'utf8');
    const main = await readFile(path.join(desktopRoot, 'src', 'main', 'main.ts'), 'utf8');
    const home = await readFile(path.join(desktopRoot, 'src', 'renderer', 'features', 'home', 'ControlCenterPage.tsx'), 'utf8');

    expect(settings).toContain("import { parseDelimitedList } from '@lnwjing/shared/text-list';");
    expect(userConfig).toContain("import { parseDelimitedList } from '@lnwjing/shared/text-list';");
    expect(settings).not.toContain('function splitList(');
    expect(userConfig).not.toContain('function splitList(');

    expect(main).toContain('EMPTY_REMOTE_MCP_STATUS');
    expect(main).toContain('EMPTY_TUNNEL_STATUS');
    expect(settings).toContain('EMPTY_REMOTE_MCP_STATUS');
    expect(home).toContain('EMPTY_REMOTE_MCP_STATUS');
  });
});
