import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPendingFactoryResetSync, factoryResetMarkerPath, stageFactoryResetSync } from '../src/main/factory-reset.js';

describe('factory reset staging', () => {
  it('removes only lnwjing Tunnel artifacts while preserving other profiles in the shared directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-factory-reset-'));
    const dataPath = path.join(parent, 'lnwjing-data');
    const tunnelPath = path.join(parent, 'tunnel-client');
    await mkdir(path.join(dataPath, 'Local Storage', 'leveldb'), { recursive: true });
    await mkdir(path.join(dataPath, 'backups'), { recursive: true });
    await mkdir(path.join(tunnelPath, 'health'), { recursive: true });
    await writeFile(path.join(dataPath, 'lnwjing.sqlite'), 'database');
    await writeFile(path.join(dataPath, 'checkpoint-master.key'), 'secret');
    await writeFile(path.join(dataPath, 'Local Storage', 'leveldb', '000001.log'), 'renderer-state');
    await writeFile(path.join(dataPath, 'backups', 'snapshot.db'), 'backup');
    await writeFile(path.join(tunnelPath, 'lnwjing.runtime.secret'), 'tunnel-secret');
    await writeFile(path.join(tunnelPath, 'lnwjing.oauth.session.secret'), 'oauth-session');
    await writeFile(path.join(tunnelPath, 'lnwjing.tunnel.lock.stale.1'), 'stale-lock');
    await writeFile(path.join(tunnelPath, 'health', 'lnwjing.url'), 'http://127.0.0.1:1234');
    await writeFile(path.join(tunnelPath, 'other.yaml'), 'other-profile');
    await writeFile(path.join(tunnelPath, 'lnwjing-other.yaml'), 'unrelated-similar-profile');
    await writeFile(path.join(tunnelPath, 'health', 'other.url'), 'other-health');
    await writeFile(path.join(tunnelPath, 'lnwjing.yaml'), 'health:\n  url_file: health/lnwjing.url\n');

    const marker = stageFactoryResetSync(dataPath);
    expect(marker).toBe(factoryResetMarkerPath(dataPath));
    await expect(access(marker)).resolves.toBeUndefined();

    expect(applyPendingFactoryResetSync(dataPath, tunnelPath)).toBe(true);
    await expect(readdir(dataPath)).resolves.toEqual([]);
    await expect(access(path.join(tunnelPath, 'lnwjing.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(tunnelPath, 'lnwjing.runtime.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(tunnelPath, 'lnwjing.oauth.session.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(tunnelPath, 'lnwjing.tunnel.lock.stale.1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(tunnelPath, 'health', 'lnwjing.url'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(tunnelPath, 'other.yaml'))).resolves.toBeUndefined();
    await expect(access(path.join(tunnelPath, 'lnwjing-other.yaml'))).resolves.toBeUndefined();
    await expect(access(path.join(tunnelPath, 'health', 'other.url'))).resolves.toBeUndefined();
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(applyPendingFactoryResetSync(dataPath, tunnelPath)).toBe(false);
  });

  it('refuses to stage a reset for the filesystem root', () => {
    expect(() => stageFactoryResetSync(path.parse(process.cwd()).root)).toThrow(/filesystem root/);
  });
});
