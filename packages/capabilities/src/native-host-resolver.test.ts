import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativeHostBridge } from './native-host-resolver.js';

const directories: string[] = [];
async function packaged(overrides: Record<string, unknown> = {}): Promise<{ root: string; executable: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-manifest-')));
  directories.push(root);
  const executable = path.join(root, 'lnwjing-linux-host');
  const content = Buffer.from('fixture helper identity\n');
  await writeFile(executable, content);
  await writeFile(path.join(root, 'NATIVE_HOST.json'), JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64', name: path.basename(executable),
    sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength, verified: true, ...overrides }));
  return { root, executable };
}
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('packaged native host resolution', () => {
  it('resolves a matching identity without starting a process, then rechecks modified bytes at dispatch', async () => {
    const { executable } = await packaged();
    const bridge = resolveNativeHostBridge({ platform: 'linux', arch: 'x64', executablePaths: [executable] });
    expect(bridge).toBeDefined();
    await writeFile(executable, 'tampered helper\n');
    await expect(bridge!.execute('health', {})).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('size') } });
    await expect(bridge!.close()).resolves.toMatchObject({ ok: true });
  });
  it.each([{ platform: 'darwin' }, { arch: 'arm64' }, { name: 'another-helper' }, { verified: false }, { sha256: 'bad' }, { sizeBytes: 0 }])('refuses a mismatched identity %j', async (overrides) => {
    const { executable } = await packaged(overrides);
    expect(resolveNativeHostBridge({ platform: 'linux', arch: 'x64', executablePaths: [executable] })).toBeUndefined();
  });
  it('does not bypass an invalid first existing candidate with a later valid candidate', async () => {
    const first = await packaged({ verified: false });
    const second = await packaged();
    expect(resolveNativeHostBridge({ platform: 'linux', arch: 'x64', executablePaths: [first.executable, second.executable] })).toBeUndefined();
  });
  it('refuses an oversized manifest and foreign host profiles', async () => {
    const { root, executable } = await packaged();
    await writeFile(path.join(root, 'NATIVE_HOST.json'), ' '.repeat(16_385));
    expect(resolveNativeHostBridge({ platform: 'linux', arch: 'x64', executablePaths: [executable] })).toBeUndefined();
    expect(resolveNativeHostBridge({ platform: 'win32', arch: 'x64', executablePaths: [executable] })).toBeUndefined();
  });
});
