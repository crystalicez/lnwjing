import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execPath, stdout } from 'node:process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const EXPECTED_PACKAGE = 'ecc-universal';
const EXPECTED_VERSION = '2.2.1';
const EXPECTED_SCANNER_PACKAGE = 'ecc-agentshield';
const EXPECTED_SCANNER_VERSION = '1.4.0';
const desktopRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = await realpath(path.join(desktopRoot, 'node_modules', EXPECTED_PACKAGE));
const scannerRoot = await realpath(path.join(desktopRoot, 'node_modules', EXPECTED_SCANNER_PACKAGE));
const targetRoot = path.join(desktopRoot, 'build', 'ecc-runtime');
const scannerBundlePath = path.join(targetRoot, '.lnwjing-agentshield.cjs');
const scannerRuntimeBundlePath = path.join(targetRoot, '.lnwjing-agentshield-runtime.cjs');

const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
if (metadata?.name !== EXPECTED_PACKAGE || metadata?.version !== EXPECTED_VERSION) {
  throw new Error(`Expected ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}, found ${String(metadata?.name)}@${String(metadata?.version)}`);
}
if (metadata?.license !== 'MIT') {
  throw new Error(`Expected ${EXPECTED_PACKAGE} MIT license metadata, found ${String(metadata?.license)}`);
}
const scannerMetadata = JSON.parse(await readFile(path.join(scannerRoot, 'package.json'), 'utf8'));
if (scannerMetadata?.name !== EXPECTED_SCANNER_PACKAGE || scannerMetadata?.version !== EXPECTED_SCANNER_VERSION) {
  throw new Error(`Expected ${EXPECTED_SCANNER_PACKAGE}@${EXPECTED_SCANNER_VERSION}, found ${String(scannerMetadata?.name)}@${String(scannerMetadata?.version)}`);
}
if (scannerMetadata?.license !== 'MIT') {
  throw new Error(`Expected ${EXPECTED_SCANNER_PACKAGE} MIT license metadata, found ${String(scannerMetadata?.license)}`);
}

await rm(targetRoot, { recursive: true, force: true });
await mkdir(path.dirname(targetRoot), { recursive: true });
await cp(sourceRoot, targetRoot, { recursive: true, dereference: true, force: true });
await build({
  entryPoints: [path.join(scannerRoot, 'dist', 'index.js')],
  outfile: scannerRuntimeBundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
});

const upstreamScannerVersionResult = await execFileAsync(
  execPath,
  [scannerRuntimeBundlePath, '--version'],
  { windowsHide: true, maxBuffer: 1024 * 1024 },
);
const scannerUpstreamCliVersion = upstreamScannerVersionResult.stdout.trim();

const scannerWrapper = [
  '#!/usr/bin/env node',
  "'use strict';",
  `const PINNED_AGENTSHIELD_VERSION = ${JSON.stringify(EXPECTED_SCANNER_VERSION)};`,
  'const args = process.argv.slice(2);',
  "if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {",
  "  process.stdout.write(PINNED_AGENTSHIELD_VERSION + '\\n');",
  '} else {',
  "  require('./.lnwjing-agentshield-runtime.cjs');",
  '}',
  '',
].join('\n');
await writeFile(scannerBundlePath, scannerWrapper, 'utf8');

const normalizedScannerVersionResult = await execFileAsync(
  execPath,
  [scannerBundlePath, '--version'],
  { windowsHide: true, maxBuffer: 1024 * 1024 },
);
const scannerCliVersion = normalizedScannerVersionResult.stdout.trim();
if (scannerCliVersion !== EXPECTED_SCANNER_VERSION) {
  throw new Error(
    `Prepared AgentShield wrapper reported ${scannerCliVersion || '<empty>'}; expected ${EXPECTED_SCANNER_VERSION}`,
  );
}

const scannerHelpResult = await execFileAsync(
  execPath,
  [scannerBundlePath, '--help'],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
);
if (!scannerHelpResult.stdout.includes('Security auditor for AI agent configurations')) {
  throw new Error('Prepared AgentShield wrapper failed passthrough validation');
}

const packageJson = await readFile(path.join(targetRoot, 'package.json'));
const license = await readFile(path.join(targetRoot, 'LICENSE'));
const scannerBundle = await readFile(scannerBundlePath);
const scannerRuntimeBundle = await readFile(scannerRuntimeBundlePath);
const scannerLicense = await readFile(path.join(scannerRoot, 'LICENSE'));
const provenance = {
  schemaVersion: 1,
  provider: 'ecc',
  packageName: EXPECTED_PACKAGE,
  version: EXPECTED_VERSION,
  license: 'MIT',
  packageJsonSha256: createHash('sha256').update(packageJson).digest('hex'),
  licenseSha256: createHash('sha256').update(license).digest('hex'),
  scannerPackageName: EXPECTED_SCANNER_PACKAGE,
  scannerVersion: EXPECTED_SCANNER_VERSION,
  scannerCliVersion,
  scannerUpstreamCliVersion,
  scannerLicense: 'MIT',
  scannerBundleSha256: createHash('sha256').update(scannerBundle).digest('hex'),
  scannerRuntimeBundleSha256: createHash('sha256').update(scannerRuntimeBundle).digest('hex'),
  scannerLicenseSha256: createHash('sha256').update(scannerLicense).digest('hex'),
};
await writeFile(path.join(targetRoot, '.lnwjing-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

const upstreamVersionNote = scannerUpstreamCliVersion === EXPECTED_SCANNER_VERSION
  ? ''
  : ` (upstream CLI string ${scannerUpstreamCliVersion || '<empty>'} normalized to pinned ${EXPECTED_SCANNER_VERSION})`;
stdout.write(
  `Prepared ${EXPECTED_PACKAGE}@${EXPECTED_VERSION} + ${EXPECTED_SCANNER_PACKAGE}@${EXPECTED_SCANNER_VERSION}${upstreamVersionNote} at ${targetRoot}\n`,
);
