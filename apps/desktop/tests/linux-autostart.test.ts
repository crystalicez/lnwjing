import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureLinuxAutostart } from '../src/main/linux-autostart.js';

describe('Linux XDG autostart', () => {
  it('writes only the lnwjing entry atomically and escapes executable paths', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-autostart-'));
    try {
      const file = await configureLinuxAutostart({ configDirectory: root, executablePath: '/opt/lnwjing path/lnwjing', enabled: true });
      await expect(readFile(file, 'utf8')).resolves.toContain('Exec=/opt/lnwjing\\spath/lnwjing');
      await expect(readFile(file, 'utf8')).resolves.toContain('TryExec=/opt/lnwjing\\spath/lnwjing');
      await configureLinuxAutostart({ configDirectory: root, executablePath: '/opt/lnwjing path/lnwjing', enabled: false });
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
