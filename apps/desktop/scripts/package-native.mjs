/* global console, process */

import { spawn } from 'node:child_process';
import { runElectronBuilderWithRetry } from './package-native-retry.mjs';

const target = process.argv[2];
if (target !== 'macos' && target !== 'linux') throw new Error('Usage: node scripts/package-native.mjs <macos|linux>');
if ((target === 'macos' && process.platform !== 'darwin') || (target === 'linux' && process.platform !== 'linux')) {
  throw new Error(`The ${target} package must be built on its target operating system`);
}

const architecture = process.env.LNWJING_RUNTIME_ARCH ?? process.arch;
if (architecture !== 'x64' && architecture !== 'arm64') throw new Error(`Unsupported ${target} architecture: ${architecture}`);
const environment = {
  ...process.env,
  LNWJING_RUNTIME_TARGET: target === 'macos' ? 'darwin' : 'linux',
  LNWJING_RUNTIME_ARCH: architecture,
  LNWJING_TUNNEL_TARGET: target === 'macos' ? 'darwin' : 'linux',
  LNWJING_TUNNEL_ARCH: architecture,
};
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const requiresMacCertificate = target === 'macos' && (process.env.LNWJING_REQUIRE_CODESIGN === '1'
  || process.env.LNWJING_REQUIRE_NOTARIZATION === '1'
  || ['CSC_LINK', 'CSC_NAME', 'CSC_KEYCHAIN', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE']
    .some((key) => Boolean(process.env[key]?.trim())));
const electronBuilderArgs = [target === 'macos' ? '--mac' : '--linux', ...(target === 'macos' ? ['dmg', 'zip'] : ['AppImage', 'deb']), `--${architecture}`,
  ...(target === 'macos' && !requiresMacCertificate ? ['--config.mac.identity=-'] : []), '--publish', 'never'];

await run('node', ['scripts/prepare-tunnel-client.mjs'], environment);
await run('node', ['scripts/prepare-runtime-tools.mjs'], environment);
await run('node', ['scripts/prepare-ecc-runtime.mjs'], environment);
await run('node', [target === 'macos' ? 'scripts/build-macos-host.mjs' : 'scripts/build-linux-host.mjs'], environment);
await run(corepack, ['pnpm@10.15.0', '--filter', '@lnwjing/desktop...', 'build'], environment);
await runElectronBuilderWithRetry(
  () => run('electron-builder', electronBuilderArgs, environment, true),
  undefined,
  ({ delayMs, nextAttempt }) => console.warn(`electron-builder download failed transiently; retrying in ${delayMs}ms (attempt ${nextAttempt}/3)`),
);
await run('node', ['scripts/write-release-evidence.mjs'], environment);
await run('node', ['scripts/verify-release-evidence.mjs'], environment);

function run(command, args, env, captureOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let output = '';
    if (captureOutput) {
      const forward = (stream, destination) => stream?.on('data', (chunk) => {
        destination.write(chunk);
        output = (output + chunk.toString()).slice(-65_536);
      });
      forward(child.stdout, process.stdout);
      forward(child.stderr, process.stderr);
    }
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown'}`);
      if (captureOutput) error.output = output;
      reject(error);
    });
  });
}
