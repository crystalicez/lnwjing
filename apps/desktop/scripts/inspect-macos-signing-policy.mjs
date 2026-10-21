import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(modulePath), '..');
export const macosSigningPolicyEvidencePath = path.join(desktopRoot, 'build', 'macos-signing-policy.json');

export async function invalidateMacosSigningPolicyEvidence() {
  await mkdir(path.dirname(macosSigningPolicyEvidencePath), { recursive: true });
  await writeFile(macosSigningPolicyEvidencePath, `${JSON.stringify({ schemaVersion: 0, signing: 'incomplete' })}\n`, 'utf8');
}

export async function writeMacosSigningPolicyEvidence(policy) {
  validateMacosSigningPolicyEvidence(policy);
  await mkdir(path.dirname(macosSigningPolicyEvidencePath), { recursive: true });
  await writeFile(macosSigningPolicyEvidencePath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
}

export async function readMacosSigningPolicyEvidence() {
  let text;
  try {
    text = await readFile(macosSigningPolicyEvidencePath, 'utf8');
  } catch {
    throw new Error('Observed macOS signing-policy evidence is missing');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Observed macOS signing-policy evidence is not valid JSON');
  }
}

export async function inspectMacosSigningPolicy(appPath, options) {
  const arch = normalizeArch(options?.arch);
  const run = options?.run ?? defaultCodesignRun;
  const certificateSha1 = options?.certificateSha1;
  if (certificateSha1 !== undefined && !/^[0-9a-f]{40}$/i.test(certificateSha1)) {
    throw new Error('macOS certificate fingerprint is invalid');
  }
  const discover = options?.discover ?? discoverMacosSignableCode;
  const candidates = await discover(appPath, { arch });
  validateDiscoveredCandidates(appPath, candidates);

  const inspected = [];
  for (const candidate of candidates) {
    await assertCanonicalCandidate(appPath, candidate);
    const verification = ['--verify', '--strict', '--all-architectures'];
    if (certificateSha1) {
      verification.push('--test-requirement', `=anchor apple generic and certificate leaf = H"${certificateSha1.toLowerCase()}"`);
    }
    verification.push(candidate.absolutePath);
    await run(verification);
    const display = await run(['--display', '--verbose=4', '--arch', codesignArch(arch), candidate.absolutePath]);
    const details = parseCodesignDetails(joinOutput(display), candidate.relativePath);
    let libraryValidationDisabled = null;
    if (candidate.electronProcess) {
      const entitlements = await run(['--display', '--entitlements', ':-', '--arch', codesignArch(arch), candidate.absolutePath]);
      libraryValidationDisabled = entitlementIsTrue(joinOutput(entitlements), 'com.apple.security.cs.disable-library-validation');
    }
    inspected.push({ ...candidate, ...details, libraryValidationDisabled });
  }

  const root = inspected.find((candidate) => candidate.relativePath === '.');
  if (!root) throw new Error('macOS signing inspection did not include the root app');
  const mode = root.mode;
  if (options?.expectedMode !== undefined && options.expectedMode !== mode) {
    throw new Error(`macOS signature mode mismatch: expected=${options.expectedMode} actual=${mode}`);
  }
  if (mode === 'certificate' && !certificateSha1 && options?.requireCertificateFingerprint === true) {
    throw new Error('Certificate-signed macOS inspection requires the certificate fingerprint');
  }
  for (const candidate of inspected) {
    if (candidate.mode !== mode) {
      throw new Error(`macOS nested signature mode mismatch: app=${mode} nested=${candidate.mode} target=${candidate.relativePath}`);
    }
    if (mode === 'ad-hoc' && candidate.teamId !== null) {
      throw new Error(`macOS ad-hoc nested code unexpectedly exposes a TeamIdentifier: ${candidate.relativePath}`);
    }
    if (mode === 'certificate' && candidate.teamId !== root.teamId) {
      throw new Error(`macOS TeamIdentifier mismatch: app=${root.teamId ?? '<missing>'} nested=${candidate.teamId ?? '<missing>'} target=${candidate.relativePath}`);
    }
    if (!candidate.electronProcess) continue;
    if (!candidate.hardenedRuntime) throw new Error(`macOS Electron process lacks hardened runtime: ${candidate.relativePath}`);
    if (mode === 'ad-hoc' && !candidate.libraryValidationDisabled) {
      throw new Error(`macOS ad-hoc Electron process lacks disable-library-validation: ${candidate.relativePath}`);
    }
    if (mode === 'certificate' && candidate.libraryValidationDisabled) {
      throw new Error(`macOS certificate Electron process must keep library validation enabled: ${candidate.relativePath}`);
    }
    if (mode === 'certificate' && !candidate.secureTimestamp) {
      throw new Error(`macOS certificate Electron process lacks secure timestamp: ${candidate.relativePath}`);
    }
  }
  if (mode === 'certificate' && root.teamId === null) {
    throw new Error('Certificate-signed macOS app does not expose a TeamIdentifier');
  }

  const mainExecutable = inspected.find((candidate) => candidate.relativePath === 'Contents/MacOS/lnwjing');
  if (!mainExecutable?.electronProcess) throw new Error('macOS signing inspection did not include the root executable');
  const policy = {
    schemaVersion: 1,
    mode,
    arch,
    rootIdentifier: root.identifier,
    teamId: root.teamId,
    rootCdHash: root.cdHash,
    rootExecutableSha256: await sha256File(mainExecutable.absolutePath),
    inspectedNestedCodeCount: inspected.length - 1,
    code: inspected.map((candidate) => ({
      relativePath: candidate.relativePath,
      kind: candidate.kind,
      mode: candidate.mode,
      teamId: candidate.teamId,
      identifier: candidate.identifier,
      cdHash: candidate.cdHash,
    })),
    electronProcesses: inspected.filter((candidate) => candidate.electronProcess).map((candidate) => ({
      relativePath: candidate.relativePath,
      hardenedRuntime: candidate.hardenedRuntime,
      libraryValidationDisabled: candidate.libraryValidationDisabled,
      secureTimestamp: candidate.secureTimestamp,
      cdHash: candidate.cdHash,
    })),
  };
  validateMacosSigningPolicyEvidence(policy, {
    mode, arch, rootExecutableSha256: policy.rootExecutableSha256,
  });
  return policy;
}

export async function discoverMacosSignableCode(appPath, { arch }) {
  const root = path.resolve(appPath);
  const candidates = [];
  const seen = new Set();
  const add = (absolutePath, relativePath, kind, electronProcess = false) => {
    const normalized = relativePath === '.' ? '.' : relativePath.split(path.sep).join('/');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ absolutePath, relativePath: normalized, kind, electronProcess });
  };
  add(root, '.', 'app');
  add(path.join(root, 'Contents', 'MacOS', 'lnwjing'), 'Contents/MacOS/lnwjing', 'executable', true);

  const frameworks = path.join(root, 'Contents', 'Frameworks');
  await walkFrameworks(frameworks, root, add);
  const runtimePaths = [
    'Contents/Resources/runtime-tools/ripgrep/rg',
    'Contents/Resources/tunnel-client/tunnel-client',
    `Contents/Resources/native-host/macos/${arch}/lnwjing-macos-host`,
  ];
  for (const relativePath of runtimePaths) add(path.join(root, relativePath), relativePath, 'executable');

  const [rootCandidate, ...nested] = candidates;
  nested.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return [rootCandidate, ...nested];
}

export function validateMacosSigningPolicyEvidence(policy, expected = {}) {
  if (!policy || typeof policy !== 'object' || policy.schemaVersion !== 1) {
    throw new Error('macOS signing-policy evidence schema is invalid');
  }
  if (policy.mode !== 'ad-hoc' && policy.mode !== 'certificate') throw new Error('macOS signing-policy evidence mode is invalid');
  if (expected.mode !== undefined && policy.mode !== expected.mode) throw new Error('macOS signing-policy evidence mode mismatch');
  if (policy.arch !== 'arm64' && policy.arch !== 'x64') throw new Error('macOS signing-policy evidence architecture is invalid');
  if (expected.arch !== undefined && policy.arch !== expected.arch) throw new Error('macOS signing-policy evidence architecture mismatch');
  if (typeof policy.rootIdentifier !== 'string' || policy.rootIdentifier.length === 0) throw new Error('macOS signing-policy root identifier is invalid');
  if (!isHexDigest(policy.rootCdHash, 40, 64)) throw new Error('macOS signing-policy root CDHash is invalid');
  if (!isHexDigest(policy.rootExecutableSha256, 64, 64)) throw new Error('macOS signing-policy root executable hash is invalid');
  if (expected.rootExecutableSha256 !== undefined
    && policy.rootExecutableSha256.toLowerCase() !== expected.rootExecutableSha256.toLowerCase()) {
    throw new Error('macOS signing-policy root executable hash mismatch');
  }
  if (policy.mode === 'ad-hoc' ? policy.teamId !== null : typeof policy.teamId !== 'string' || policy.teamId.length === 0) {
    throw new Error('macOS signing-policy TeamIdentifier is invalid');
  }
  if (!Array.isArray(policy.code) || policy.code.length < 2
    || policy.inspectedNestedCodeCount !== policy.code.length - 1) {
    throw new Error('macOS signing-policy nested-code count is invalid');
  }
  const paths = new Set();
  const codeByPath = new Map();
  for (const [index, entry] of policy.code.entries()) {
    if (!isSafeBundleRelativePath(entry?.relativePath) || paths.has(entry.relativePath)) {
      throw new Error('macOS signing-policy code path is invalid or duplicated');
    }
    paths.add(entry.relativePath);
    codeByPath.set(entry.relativePath, entry);
    if (index === 0 && entry.relativePath !== '.') throw new Error('macOS signing-policy root entry is missing');
    if (!['app', 'framework', 'dylib', 'executable'].includes(entry.kind)
      || entry.mode !== policy.mode || entry.teamId !== policy.teamId
      || typeof entry.identifier !== 'string' || entry.identifier.length === 0
      || !isHexDigest(entry.cdHash, 40, 64)) throw new Error(`macOS signing-policy code entry is invalid: ${String(entry.relativePath)}`);
  }
  const rootEntry = codeByPath.get('.');
  if (rootEntry.identifier !== policy.rootIdentifier || rootEntry.cdHash !== policy.rootCdHash) {
    throw new Error('macOS signing-policy root identity is inconsistent');
  }
  if (!Array.isArray(policy.electronProcesses) || policy.electronProcesses.length < 1) {
    throw new Error('macOS signing-policy Electron process evidence is missing');
  }
  const processPaths = new Set();
  for (const entry of policy.electronProcesses) {
    const codeEntry = codeByPath.get(entry?.relativePath);
    if (!isSafeBundleRelativePath(entry?.relativePath) || !paths.has(entry.relativePath) || processPaths.has(entry.relativePath)
      || entry.hardenedRuntime !== true || typeof entry.libraryValidationDisabled !== 'boolean'
      || typeof entry.secureTimestamp !== 'boolean' || !isHexDigest(entry.cdHash, 40, 64)
      || codeEntry?.kind !== 'executable' || codeEntry.cdHash !== entry.cdHash) {
      throw new Error(`macOS signing-policy Electron process entry is invalid: ${String(entry?.relativePath)}`);
    }
    processPaths.add(entry.relativePath);
    if (policy.mode === 'ad-hoc' && (!entry.libraryValidationDisabled || entry.secureTimestamp)) {
      throw new Error(`macOS ad-hoc Electron process policy is invalid: ${entry.relativePath}`);
    }
    if (policy.mode === 'certificate' && (entry.libraryValidationDisabled || !entry.secureTimestamp)) {
      throw new Error(`macOS certificate Electron process policy is invalid: ${entry.relativePath}`);
    }
  }
  if (!processPaths.has('Contents/MacOS/lnwjing')) throw new Error('macOS signing-policy root executable evidence is missing');
  const expectedProcessPaths = policy.code
    .filter((entry) => entry.kind === 'executable'
      && (entry.relativePath === 'Contents/MacOS/lnwjing' || /[.]app\/Contents\/MacOS\/[^/]+$/.test(entry.relativePath)))
    .map((entry) => entry.relativePath);
  if (expectedProcessPaths.length !== processPaths.size || expectedProcessPaths.some((entry) => !processPaths.has(entry))) {
    throw new Error('macOS signing-policy Electron process evidence is incomplete');
  }
  return policy;
}

export function assertMacosSigningPolicyMatches(expected, observed) {
  validateMacosSigningPolicyEvidence(expected);
  validateMacosSigningPolicyEvidence(observed);
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error('Observed macOS signing policy does not match release provenance');
  }
}

function parseCodesignDetails(text, relativePath) {
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
  const cdHash = /^CDHash=([0-9a-f]+)$/im.exec(text)?.[1]?.toLowerCase();
  const teamValue = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const adHoc = /^Signature=adhoc\s*$/m.test(text);
  const teamId = !teamValue || teamValue === 'not set' ? null : teamValue;
  const mode = adHoc ? 'ad-hoc' : teamId ? 'certificate' : null;
  if (!mode) throw new Error(`macOS distributable must be signed: ${relativePath}`);
  if (!identifier || !isHexDigest(cdHash, 40, 64)) throw new Error(`macOS code-signing details are incomplete: ${relativePath}`);
  return {
    identifier,
    cdHash,
    teamId,
    mode,
    hardenedRuntime: /^CodeDirectory .*flags=.*\bruntime\b/m.test(text),
    secureTimestamp: /^Timestamp=(?!none\s*$).+$/mi.test(text),
  };
}

function entitlementIsTrue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/?>`, 'i').test(text);
}

async function walkFrameworks(directory, appRoot, add) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error('macOS Frameworks directory is unavailable');
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(appRoot, absolutePath).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      if (entry.name.endsWith('.app') || entry.name.endsWith('.framework') || entry.name.endsWith('.dylib')
        || /[.]app\/Contents\/MacOS\//.test(relativePath)) throw new Error(`macOS signable path must not be a symlink: ${relativePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) add(absolutePath, relativePath, 'app');
      if (entry.name.endsWith('.framework')) add(absolutePath, relativePath, 'framework');
      await walkFrameworks(absolutePath, appRoot, add);
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await lstat(absolutePath);
    const electronProcess = /[.]app\/Contents\/MacOS\/[^/]+$/.test(relativePath);
    if (entry.name.endsWith('.dylib')) add(absolutePath, relativePath, 'dylib');
    else if ((metadata.mode & 0o111) !== 0) add(absolutePath, relativePath, 'executable', electronProcess);
  }
}

function validateDiscoveredCandidates(appPath, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) throw new Error('macOS signing inspection found no nested code');
  if (candidates[0]?.relativePath !== '.' || path.resolve(candidates[0]?.absolutePath ?? '') !== path.resolve(appPath)) {
    throw new Error('macOS signing inspection root candidate is invalid');
  }
}

async function assertCanonicalCandidate(appPath, candidate) {
  if (!candidate || typeof candidate.absolutePath !== 'string' || !isSafeBundleRelativePath(candidate.relativePath)
    || !['app', 'framework', 'dylib', 'executable'].includes(candidate.kind)
    || typeof candidate.electronProcess !== 'boolean') throw new Error('macOS signing candidate is invalid');
  const expected = candidate.relativePath === '.' ? path.resolve(appPath) : path.resolve(appPath, candidate.relativePath);
  if (path.resolve(candidate.absolutePath) !== expected) throw new Error(`macOS signing candidate escapes the app bundle: ${candidate.relativePath}`);
  let metadata;
  try {
    metadata = await lstat(expected);
  } catch {
    throw new Error(`macOS signing candidate is unavailable: ${candidate.relativePath}`);
  }
  const expectsDirectory = candidate.kind === 'app' || candidate.kind === 'framework';
  if (metadata.isSymbolicLink() || (expectsDirectory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new Error(`macOS signing candidate is not a canonical regular target: ${candidate.relativePath}`);
  }
  if (await realpath(expected) !== expected) throw new Error(`macOS signing candidate is non-canonical: ${candidate.relativePath}`);
}

function isSafeBundleRelativePath(value) {
  if (value === '.') return true;
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\')
    && !value.split('/').some((part) => part.length === 0 || part === '.' || part === '..');
}

function isHexDigest(value, minimum, maximum) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${minimum},${maximum}}$`, 'i').test(value);
}

function normalizeArch(value) {
  if (value === 'arm64' || value === 'x64') return value;
  throw new Error(`Unsupported macOS signing-policy architecture: ${String(value)}`);
}

function codesignArch(arch) {
  return arch === 'x64' ? 'x86_64' : 'arm64';
}

function joinOutput(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function defaultCodesignRun(args) {
  return execFileAsync('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

async function runCli() {
  if (process.platform !== 'darwin') throw new Error('macOS signing-policy inspection must run on macOS');
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Usage: inspect-macos-signing-policy.mjs --app <path> --arch <arm64|x64> [--provenance <path>]');
    values.set(key, value);
  }
  const app = values.get('--app');
  const provenancePath = values.get('--provenance');
  let arch = values.get('--arch');
  let expectedPolicy;
  let expectedMode;
  let certificateSha1;
  if (provenancePath) {
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    arch ??= provenance.arch;
    expectedMode = provenance.build?.macSigning?.mode;
    certificateSha1 = provenance.build?.macSigning?.certificateSha1;
    expectedPolicy = provenance.build?.macSigning?.policy;
    validateMacosSigningPolicyEvidence(expectedPolicy, { mode: expectedMode, arch });
  }
  if (!app || !arch) throw new Error('Usage: inspect-macos-signing-policy.mjs --app <path> --arch <arm64|x64> [--provenance <path>]');
  const observed = await inspectMacosSigningPolicy(app, {
    arch, expectedMode, certificateSha1, requireCertificateFingerprint: expectedMode === 'certificate',
  });
  if (expectedPolicy) assertMacosSigningPolicyMatches(expectedPolicy, observed);
  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  await runCli();
}
