import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createProcessTreeTerminator } from '@lnwjing/process';
import { NativeHostProcessBridge } from './native-host-protocol.js';

export function resolveNativeHostBridge(options: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly executablePaths: readonly string[];
}): NativeHostProcessBridge | undefined {
  if ((options.platform !== 'darwin' && options.platform !== 'linux') || !['x64', 'arm64'].includes(options.arch)) return undefined;
  const executable = options.executablePaths.find((candidate) => existsSync(candidate));
  if (executable === undefined || !path.isAbsolute(executable)) return undefined;
  const manifestPath = path.join(path.dirname(executable), 'NATIVE_HOST.json');
  const expectedName = options.platform === 'darwin' ? 'lnwjing-macos-host' : 'lnwjing-linux-host';
  try {
    const executableStat = lstatSync(executable);
    const manifestStat = lstatSync(manifestPath);
    if (!executableStat.isFile() || executableStat.isSymbolicLink() || realpathSync(executable) !== executable
      || !manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16_384 || realpathSync(manifestPath) !== manifestPath) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return undefined;
    const identity = manifest as Record<string, unknown>;
    if (identity.schemaVersion !== 1 || identity.platform !== options.platform || identity.arch !== options.arch || identity.name !== expectedName || path.basename(executable) !== expectedName
      || identity.verified !== true || typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(identity.sha256)
      || typeof identity.sizeBytes !== 'number' || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes <= 0 || identity.sizeBytes !== executableStat.size) return undefined;
    return new NativeHostProcessBridge({ platform: options.platform, executablePath: executable, expectedSha256: identity.sha256,
      expectedSizeBytes: identity.sizeBytes, requireIntegrity: true, terminator: createProcessTreeTerminator(options.platform) });
  } catch {
    return undefined;
  }
}
