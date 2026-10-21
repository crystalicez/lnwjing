/* eslint-disable @typescript-eslint/explicit-function-return-type -- scenario callbacks are constrained by the Scenario tuple type; repeating 100 return annotations would add noise without strengthening the contract. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlatformProfile, type PlatformProfileInput } from '../../packages/shared/src/platform-profile.js';
import { resolveLnwjingDataPath } from '../../packages/shared/src/data-path.js';
import {
  classifyFilesystemRoot,
  isAbsoluteHostPath,
  isForeignAbsolutePath,
  isHostPathWithin,
  normalizeHostWorkspaceRoot,
} from '../../packages/workspace/src/filesystem-root.js';
import { defaultApplicationDataDirectory, exclusionReason, normalizeLaunchConfig } from '../../packages/extensions/src/mcp-config-loader.js';
import {
  MAX_SECRET_ENVELOPE_BYTES,
  createExplicitKeySecretProtector,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
} from '../../packages/shared/src/secret-protection.js';
import { PathCodexExecutableResolver } from '../../packages/codex/src/codex-discovery.js';
import { PathExecutableResolver as ProcessPathExecutableResolver } from '../../packages/process/src/executable-resolver.js';
import { toSpawnInvocation } from '../../packages/process/src/spawn-invocation.js';
import { PathExecutableResolver as SearchPathExecutableResolver } from '../../packages/search/src/executable-resolver.js';
import { benchmarkPackageCommand } from '../../packages/mcp-server/src/upgrade-runtime.js';
import { bundledRuntimeToolDirectories } from '../../apps/desktop/src/main/runtime-tools.js';
import { defaultTunnelProfileDirectory, legacyTunnelSecretPath, oauthTunnelSessionPath } from '../../apps/desktop/src/main/tunnel-auth.js';
import { resolveTunnelProfileDirectory } from '../../apps/desktop/src/main/tunnel-controller.js';
import { RemediationRegistry } from '../../apps/desktop/src/main/tool-catalog/remediation-registry.js';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from '../../packages/storage/src/backup-service.js';
import { SqliteDatabase } from '../../packages/storage/src/database.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

type Scenario = readonly [string, () => void | Promise<void>];

const platformScenarios: readonly Scenario[] = [
  ['001 Windows 10 original x64 boundary is supported', () => expectProfile({ platform: 'win32', arch: 'x64', release: '10.0.10240' }, 'windows', 'supported')],
  ['002 Windows 10 22H2 x64 is supported', () => expectProfile({ platform: 'win32', arch: 'x64', release: '10.0.19045' }, 'windows', 'supported')],
  ['003 Windows 11 original x64 boundary is supported', () => expectProfile({ platform: 'win32', arch: 'x64', release: '10.0.22000' }, 'windows', 'supported')],
  ['004 Windows 11 current-style x64 build is supported', () => expectProfile({ platform: 'win32', arch: 'x64', release: '10.0.26100' }, 'windows', 'supported')],
  ['005 Windows build below the declared boundary fails closed', () => expectProfile({ platform: 'win32', arch: 'x64', release: '10.0.10239' }, 'windows', 'unsupported')],
  ['006 malformed Windows release fails closed', () => expectProfile({ platform: 'win32', arch: 'x64', release: 'invalid' }, 'windows', 'unsupported')],
  ['007 Windows ARM64 is not silently treated as x64', () => expectProfile({ platform: 'win32', arch: 'arm64', release: '10.0.26100' }, 'windows', 'unsupported')],
  ['008 Windows ia32 is unsupported', () => expectProfile({ platform: 'win32', arch: 'ia32', release: '10.0.19045' }, 'windows', 'unsupported')],
  ['009 macOS 13 arm64 is supported', () => expectProfile({ platform: 'darwin', arch: 'arm64', release: '22.6.0' }, 'macos', 'supported')],
  ['010 macOS 13 x64 is supported', () => expectProfile({ platform: 'darwin', arch: 'x64', release: '22.6.0' }, 'macos', 'supported')],
  ['011 newer Darwin arm64 remains supported', () => expectProfile({ platform: 'darwin', arch: 'arm64', release: '23.6.0' }, 'macos', 'supported')],
  ['012 newer Darwin x64 remains supported', () => expectProfile({ platform: 'darwin', arch: 'x64', release: '24.6.0' }, 'macos', 'supported')],
  ['013 macOS 12 is below the support floor', () => expectProfile({ platform: 'darwin', arch: 'arm64', release: '21.6.0' }, 'unsupported', 'unsupported')],
  ['014 malformed Darwin release fails closed', () => expectProfile({ platform: 'darwin', arch: 'arm64', release: 'invalid' }, 'unsupported', 'unsupported')],
  ['015 unsupported Darwin architecture fails closed', () => expectProfile({ platform: 'darwin', arch: 'ia32', release: '24.6.0' }, 'unsupported', 'unsupported')],
  ['016 Linux x64 is supported', () => expectProfile({ platform: 'linux', arch: 'x64', release: '6.8.0' }, 'linux', 'supported')],
  ['017 Linux arm64 is explicitly preview', () => expectProfile({ platform: 'linux', arch: 'arm64', release: '6.8.0' }, 'linux', 'preview')],
  ['018 Linux ia32 fails closed', () => expectProfile({ platform: 'linux', arch: 'ia32', release: '6.8.0' }, 'unsupported', 'unsupported')],
  ['019 FreeBSD is unsupported rather than mapped to Windows', () => expectProfile({ platform: 'freebsd', arch: 'x64', release: '14.0.0' }, 'unsupported', 'unsupported')],
  ['020 AIX is unsupported rather than mapped to POSIX support', () => expectProfile({ platform: 'aix', arch: 'x64', release: '7.3.0' }, 'unsupported', 'unsupported')],
];

const pathScenarios: readonly Scenario[] = [
  ['021 Windows C drive root is classified correctly', () => expect(classifyFilesystemRoot('C:\\', 'win32')).toEqual({ kind: 'windows_drive', rootPath: 'C:\\' })],
  ['022 Windows UNC root is classified correctly', () => expect(classifyFilesystemRoot('\\\\server\\share', 'win32')).toEqual({ kind: 'windows_unc', rootPath: '\\\\server\\share\\' })],
  ['023 Linux filesystem root is classified correctly', () => expect(classifyFilesystemRoot('/', 'linux')).toEqual({ kind: 'posix_mount', rootPath: '/' })],
  ['024 Linux mount root is classified correctly', () => expect(classifyFilesystemRoot('/mnt/data', 'linux')).toEqual({ kind: 'posix_mount', rootPath: '/mnt/data' })],
  ['025 macOS volume root is classified correctly', () => expect(classifyFilesystemRoot('/Volumes/Data', 'darwin')).toEqual({ kind: 'posix_mount', rootPath: '/Volumes/Data' })],
  ['026 Windows absolute syntax is foreign on Linux', () => expect(isForeignAbsolutePath('C:\\project', 'linux')).toBe(true)],
  ['027 Windows UNC syntax is foreign on macOS', () => expect(isForeignAbsolutePath('\\\\server\\share', 'darwin')).toBe(true)],
  ['028 POSIX absolute syntax is foreign on Windows', () => expect(isForeignAbsolutePath('/home/alice/project', 'win32')).toBe(true)],
  ['029 Windows containment is case-insensitive', () => expect(isHostPathWithin('C:\\Project', 'c:\\project\\src', 'win32')).toBe(true)],
  ['030 Windows sibling prefix does not bypass containment', () => expect(isHostPathWithin('C:\\Project', 'C:\\Project-other', 'win32')).toBe(false)],
  ['031 Linux containment is case-sensitive', () => expect(isHostPathWithin('/home/a/Project', '/home/a/project/src', 'linux')).toBe(false)],
  ['032 POSIX sibling prefix does not bypass containment', () => expect(isHostPathWithin('/home/a/project', '/home/a/project-other', 'linux')).toBe(false)],
  ['033 Windows workspace root gains one host separator', () => expect(normalizeHostWorkspaceRoot('C:\\Project', 'win32')).toBe('C:\\Project\\')],
  ['034 Linux root stays a single slash', () => expect(normalizeHostWorkspaceRoot('/', 'linux')).toBe('/')],
  ['035 host absolute detection never accepts foreign syntax', () => {
    expect(isAbsoluteHostPath('C:\\project', 'linux')).toBe(false);
    expect(isAbsoluteHostPath('/tmp/project', 'darwin')).toBe(true);
  }],
];

const mcpConfigScenarios: readonly Scenario[] = [
  ['036 minimal MCP launch config is normalized', () => expect(normalizeLaunchConfig({ command: 'node' }, undefined, {})).toEqual({ command: 'node' })],
  ['037 non-string MCP args are discarded', () => expect(normalizeLaunchConfig({ command: 'node', args: ['server.js', 7, null] }, undefined, {})?.args).toEqual(['server.js'])],
  ['038 workspaceFolder substitutes inside MCP command', () => expect(normalizeLaunchConfig({ command: '${workspaceFolder}/server' }, '/work/app', {})?.command).toBe('/work/app/server')],
  ['039 workspaceFolder substitutes inside MCP args', () => expect(normalizeLaunchConfig({ command: 'node', args: ['${workspaceFolder}', 'x'] }, '/work/app', {})?.args).toEqual(['/work/app', 'x'])],
  ['040 environment variables substitute inside MCP args', () => expect(normalizeLaunchConfig({ command: 'node', args: ['${env:MCP_TOKEN}'] }, undefined, { MCP_TOKEN: 'token-value' })?.args).toEqual(['token-value'])],
  ['041 missing MCP environment substitution becomes empty instead of literal secret syntax', () => expect(normalizeLaunchConfig({ command: 'node', args: ['${env:MISSING}'] }, undefined, {})?.args).toEqual([''])],
  ['042 MCP env values receive substitutions', () => expect(normalizeLaunchConfig({ command: 'node', env: { ROOT: '${workspaceFolder}', TOKEN: '${env:TOKEN}' } }, '/work/app', { TOKEN: 'abc' })?.env).toEqual({ ROOT: '/work/app', TOKEN: 'abc' })],
  ['043 MCP cwd receives workspace substitution', () => expect(normalizeLaunchConfig({ command: 'node', cwd: '${workspaceFolder}/tools' }, '/work/app', {})?.cwd).toBe('/work/app/tools')],
  ['044 MCP transport type is preserved', () => expect(normalizeLaunchConfig({ command: 'node', type: 'stdio' }, undefined, {})?.type).toBe('stdio')],
  ['045 malformed MCP config object is ignored', () => expect(normalizeLaunchConfig([], undefined, {})).toBeUndefined()],
  ['046 empty MCP command is ignored', () => expect(normalizeLaunchConfig({ command: '   ' }, undefined, {})).toBeUndefined()],
  ['047 stable external MCP server name is accepted', () => expect(exclusionReason('serena-1', { command: 'serena' })).toBeUndefined()],
  ['048 MCP server name containing slash is rejected', () => expect(exclusionReason('bad/server', { command: 'node' })).toMatch(/namespace/i)],
  ['049 lnwjing recursion by server name is rejected', () => expect(exclusionReason('lnwjing', { command: 'node' })).toMatch(/Refusing/i)],
  ['050 lnwjing recursion by executable is rejected', () => expect(exclusionReason('helper', { command: 'C:\\Tools\\lnwjing.exe' })).toMatch(/Refusing/i)],
];

const secretScenarios: readonly Scenario[] = [
  ['051 checkpoint secret envelope round-trips its provider payload', () => {
    const envelope = encodeSecretEnvelope('checkpoint_master_key', Buffer.from('payload'));
    expect(decodeSecretEnvelope('checkpoint_master_key', envelope).toString()).toBe('payload');
  }],
  ['052 tunnel secret envelope round-trips its provider payload', () => {
    const envelope = encodeSecretEnvelope('tunnel_api_key', Buffer.from('payload'));
    expect(decodeSecretEnvelope('tunnel_api_key', envelope).toString()).toBe('payload');
  }],
  ['053 secret purpose mismatch is rejected', () => {
    const envelope = encodeSecretEnvelope('checkpoint_master_key', Buffer.from('payload'));
    expect(() => decodeSecretEnvelope('tunnel_api_key', envelope)).toThrow(/purpose/i);
  }],
  ['054 unsupported secret envelope version is rejected', () => expect(() => decodeSecretEnvelope('tunnel_api_key', 'safe:v2:AAAA')).toThrow(/version/i)],
  ['055 malformed base64 secret envelope is rejected', () => expect(() => decodeSecretEnvelope('tunnel_api_key', 'safe:v1:not-base64')).toThrow()],
  ['056 empty provider ciphertext cannot be wrapped', () => expect(() => encodeSecretEnvelope('tunnel_api_key', Buffer.alloc(0))).toThrow(/size/i)],
  ['057 oversized provider ciphertext cannot be wrapped', () => expect(() => encodeSecretEnvelope('tunnel_api_key', Buffer.alloc(MAX_SECRET_ENVELOPE_BYTES + 1))).toThrow(/size/i)],
  ['058 explicit checkpoint protector encrypts and decrypts', async () => {
    const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 1));
    const envelope = await protector.encrypt('checkpoint_master_key', 'checkpoint-secret');
    await expect(protector.decrypt('checkpoint_master_key', envelope)).resolves.toMatchObject({ plainText: 'checkpoint-secret', shouldReEncrypt: false });
  }],
  ['059 explicit tunnel protector encrypts and decrypts', async () => {
    const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 2));
    const envelope = await protector.encrypt('tunnel_api_key', 'tunnel-secret');
    await expect(protector.decrypt('tunnel_api_key', envelope)).resolves.toMatchObject({ plainText: 'tunnel-secret' });
  }],
  ['060 a different machine key cannot decrypt an explicit-key envelope', async () => {
    const first = createExplicitKeySecretProtector(Buffer.alloc(32, 3));
    const second = createExplicitKeySecretProtector(Buffer.alloc(32, 4));
    const envelope = await first.encrypt('checkpoint_master_key', 'machine-bound');
    await expect(second.decrypt('checkpoint_master_key', envelope)).rejects.toThrow(/decrypt/i);
  }],
];

const processAndRuntimeScenarios: readonly Scenario[] = [
  ['061 Windows npm.cmd is wrapped by cmd.exe without shell=true', () => expect(toSpawnInvocation('npm.cmd', ['test'], {}, 'win32')).toMatchObject({ ok: true, value: { windowsVerbatimArguments: true } })],
  ['062 Windows batch files are wrapped by cmd.exe', () => expect(toSpawnInvocation('build.bat', ['release'], {}, 'win32')).toMatchObject({ ok: true, value: { windowsVerbatimArguments: true } })],
  ['063 Windows native exe remains direct argv', () => expect(toSpawnInvocation('node.exe', ['--version'], {}, 'win32')).toEqual({ ok: true, value: { executable: 'node.exe', args: ['--version'] } })],
  ['064 Windows command shim rejects shell metacharacters by default', () => expect(toSpawnInvocation('npm.cmd', ['run', 'x&whoami'], {}, 'win32')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })],
  ['065 macOS preserves literal executable and argv', () => expect(toSpawnInvocation('/usr/bin/node', ['a b', '$HOME'], {}, 'darwin')).toEqual({ ok: true, value: { executable: '/usr/bin/node', args: ['a b', '$HOME'] } })],
  ['066 Linux preserves literal executable and argv', () => expect(toSpawnInvocation('/usr/bin/node', ['a b', '$HOME'], {}, 'linux')).toEqual({ ok: true, value: { executable: '/usr/bin/node', args: ['a b', '$HOME'] } })],
  ['067 POSIX empty executable is rejected', () => expect(toSpawnInvocation('   ', [], {}, 'linux')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })],
  ['068 benchmark npm command uses npm.cmd only on Windows', () => expect(benchmarkPackageCommand('npm@11.6.0', 'bench', 'win32').executable).toBe('npm.cmd')],
  ['069 benchmark npm command uses npm on macOS', () => expect(benchmarkPackageCommand('npm@11.6.0', 'bench', 'darwin').executable).toBe('npm')],
  ['070 bundled Linux runtime tool paths use POSIX separators', () => expect(bundledRuntimeToolDirectories('/opt/lnwjing/resources', 'linux')).toEqual(['/opt/lnwjing/resources/runtime-tools/ripgrep', '/opt/lnwjing/resources/tunnel-client'])],
];

const remediationScenarios: readonly Scenario[] = [
  ['071 Windows Sandbox remediation exists on Windows', () => expect(new RemediationRegistry().resolve('en', ['configure_windows_sandbox'], 'win32')).toHaveLength(1)],
  ['072 Windows Sandbox remediation is absent on macOS', () => expect(new RemediationRegistry().resolve('en', ['configure_windows_sandbox'], 'darwin')).toHaveLength(0)],
  ['073 Windows Sandbox remediation is absent on Linux', () => expect(new RemediationRegistry().resolve('en', ['configure_windows_sandbox'], 'linux')).toHaveLength(0)],
  ['074 WSL remediation exists on Windows', () => expect(new RemediationRegistry().resolve('en', ['configure_wsl'], 'win32')).toHaveLength(1)],
  ['075 WSL remediation is absent on macOS', () => expect(new RemediationRegistry().resolve('en', ['configure_wsl'], 'darwin')).toHaveLength(0)],
  ['076 PDF auto-installer action exists on Windows x64', () => expect(new RemediationRegistry().resolve('en', ['configure_pdf_provider'], 'win32', 'x64')[0]?.actions).toContainEqual({ kind: 'install_pdf_provider' })],
  ['077 PDF auto-installer action is absent on Windows ARM64', () => expect(new RemediationRegistry().resolve('en', ['configure_pdf_provider'], 'win32', 'arm64')[0]?.actions).not.toContainEqual({ kind: 'install_pdf_provider' })],
  ['078 PDF auto-installer action is absent on macOS', () => expect(new RemediationRegistry().resolve('en', ['configure_pdf_provider'], 'darwin', 'arm64')[0]?.actions).not.toContainEqual({ kind: 'install_pdf_provider' })],
  ['079 PDF auto-installer action is absent on Linux', () => expect(new RemediationRegistry().resolve('en', ['configure_pdf_provider'], 'linux', 'x64')[0]?.actions).not.toContainEqual({ kind: 'install_pdf_provider' })],
  ['080 browser CDP remediation keeps the managed-browser launch action cross-platform', () => expect(new RemediationRegistry().resolve('en', ['configure_browser_cdp'], 'darwin')[0]?.actions).toContainEqual({ kind: 'launch_managed_browser' })],
];

const recoveryScenarios: readonly Scenario[] = [
  ['081 Windows x64 backup restores as same-host on Windows x64', () => expectRestoreCompatibility('win32', 'x64', 'win32', 'x64', 'same_host')],
  ['082 macOS arm64 backup restores as same-host on macOS arm64', () => expectRestoreCompatibility('darwin', 'arm64', 'darwin', 'arm64', 'same_host')],
  ['083 Linux x64 backup restores as same-host on Linux x64', () => expectRestoreCompatibility('linux', 'x64', 'linux', 'x64', 'same_host')],
  ['084 Windows backup is marked cross-host on macOS', () => expectRestoreCompatibility('win32', 'x64', 'darwin', 'arm64', 'cross_host')],
  ['085 Windows backup is marked cross-host on Linux', () => expectRestoreCompatibility('win32', 'x64', 'linux', 'x64', 'cross_host')],
  ['086 macOS backup is marked cross-host on Windows', () => expectRestoreCompatibility('darwin', 'arm64', 'win32', 'x64', 'cross_host')],
  ['087 macOS backup is marked cross-host on Linux', () => expectRestoreCompatibility('darwin', 'arm64', 'linux', 'x64', 'cross_host')],
  ['088 Linux backup is marked cross-host on Windows', () => expectRestoreCompatibility('linux', 'x64', 'win32', 'x64', 'cross_host')],
  ['089 Linux backup is marked cross-host on macOS', () => expectRestoreCompatibility('linux', 'x64', 'darwin', 'arm64', 'cross_host')],
  ['090 architecture change is treated as cross-host even on the same OS', () => expectRestoreCompatibility('linux', 'x64', 'linux', 'arm64', 'cross_host')],
];

const nativeCiScenarios: readonly Scenario[] = [
  ['091 native CI includes Windows runner', () => expectWorkflowContains('os: windows-latest')],
  ['092 native CI includes macOS arm64 runner', () => expectWorkflowContains('os: macos-15')],
  ['093 native package CI includes macOS Intel runner', () => expectWorkflowContains('os: macos-15-intel')],
  ['094 native CI includes Linux x64 runner', () => expectWorkflowContains('os: ubuntu-24.04')],
  ['095 native package CI includes Linux arm64 runner', () => expectWorkflowContains('os: ubuntu-24.04-arm')],
  ['096 native platform contract runs the release-scenario suite', () => expectWorkflowContains('tests/integration/cross-platform-release-scenarios.test.ts')],
  ['097 native contract keeps non-desktop packages and shards the desktop suite', async () => {
    const workflow = await workflowSource();
    expect(workflow).toContain("run: pnpm -r --workspace-concurrency=2 --filter '!@lnwjing/desktop' --if-present test");
    expect(workflow).toContain('desktop-test-shards:');
    expect(workflow).toContain('--shard=${{ matrix.shard_index }}/${{ matrix.shard_total }}');
    expect(workflow).toContain("--filter '@lnwjing/cli...' build");
    // OS-specific dependency setup is allowed, but the native acceptance suite itself must run on every OS.
    const nativeSuiteStep = workflow.split('      - name: Run complete native unit and service acceptance suites')[1]?.split('\n      - name:')[0];
    expect(nativeSuiteStep).toBeDefined();
    expect(nativeSuiteStep ?? '').not.toMatch(/(?:^|\n)\s+if:/);
  }],
  ['098 packaged Electron E2E exercises a real MCP client', () => expectWorkflowContains('desktop-mcp-client.e2e.ts')],
  ['099 native macOS host protocol runs Swift tests', () => expectWorkflowContains('swift test --package-path native/macos-host')],
  ['100 native Linux host protocol runs Cargo tests', () => expectWorkflowContains('cargo test --manifest-path native/linux-host/Cargo.toml --locked')],
  ['101 macOS 26 arm64 reuses the macOS 15 artifact', () => expectWorkflowContains('os: macos-26')],
  ['102 macOS 26 x64 reuses the macOS 15 Intel artifact', () => expectWorkflowContains('os: macos-26-intel')],
  ['103 macOS 26 compatibility downloads the exact SHA-scoped Darwin artifact', () => expectWorkflowContains('native-darwin-${{ matrix.arch }}-${{ github.sha }}')],
  ['104 macOS 26 provenance discovery remains compatible with the hosted macOS Bash baseline', async () => {
    const workflow = await workflowSource();
    const compatibilityJob = workflow.slice(workflow.indexOf('macos-26-package-compatibility:'), workflow.indexOf('\n  verify:', workflow.indexOf('macos-26-package-compatibility:')));
    expect(compatibilityJob).toContain('provenance_list=');
    expect(compatibilityJob).not.toContain('mapfile');
  }],
  ['105 macOS 26 records the exact public v4.62.1 arm64 signing regression before accepting the fix', async () => {
    const workflow = await workflowSource();
    expect(workflow).toContain('lnwjing-4.62.1-arm64.dmg');
    expect(workflow).toContain('lnwjing-4.62.1-arm64.zip');
    expect(workflow).toContain('d9cf74be1711a123fde49fc070c6fe055bf2c65bf6345395d4c8fa3816bed12c');
    expect(workflow).toContain('cf982b59a42c0ee6f91186212a03a683634e6c14675a718ddbdbf6fe1ba00db8');
    expect(workflow).toContain('v4.62.1 unexpectedly satisfies the fixed macOS signing policy');
    expect(workflow).toContain('lacks disable-library-validation');
    expect(workflow).toContain('baseline launch observation');
  }],
  ['106 macOS 26 completes the packaged UI smoke before transient LaunchServices termination', async () => {
    const workflow = await workflowSource();
    const compatibilityStart = workflow.indexOf('macos-26-package-compatibility:');
    const compatibilityJob = workflow.slice(compatibilityStart, workflow.indexOf('\n  verify:', compatibilityStart));
    const stageIndex = compatibilityJob.indexOf('Stage exact DMG and ZIP apps without launching');
    const uiSmokeIndex = compatibilityJob.indexOf('Run packaged Electron smoke on macOS 26');
    const launchServicesIndex = compatibilityJob.indexOf('Launch exact DMG and ZIP apps through LaunchServices');
    expect(stageIndex).toBeGreaterThanOrEqual(0);
    expect(stageIndex).toBeLessThan(uiSmokeIndex);
    expect(uiSmokeIndex).toBeLessThan(launchServicesIndex);
  }],
  ['107 macOS 26 gives packaged safeStorage an unlocked disposable Keychain', async () => {
    const workflow = await workflowSource();
    const compatibilityStart = workflow.indexOf('macos-26-package-compatibility:');
    const compatibilityJob = workflow.slice(compatibilityStart, workflow.indexOf('\n  verify:', compatibilityStart));
    const keychainIndex = compatibilityJob.indexOf('security create-keychain');
    const uiSmokeIndex = compatibilityJob.indexOf('Run packaged Electron smoke on macOS 26');
    const playwrightIndex = compatibilityJob.indexOf('node node_modules/@playwright/test/cli.js');
    expect(keychainIndex).toBeGreaterThanOrEqual(0);
    expect(compatibilityJob).toContain('security unlock-keychain');
    expect(compatibilityJob).toContain('security default-keychain -d user -s "$ci_keychain"');
    expect(compatibilityJob).toContain('trap cleanup_ci_keychain EXIT');
    expect(compatibilityJob).toContain('security delete-keychain "$ci_keychain"');
    expect(keychainIndex).toBeGreaterThan(uiSmokeIndex);
    expect(keychainIndex).toBeLessThan(playwrightIndex);
  }],
];

const extendedPlatformScenarios: readonly Scenario[] = [
  ...[10_240, 10_586, 14_393, 15_063, 16_299, 17_134, 17_763, 18_363, 19_044, 22_631].map((build): Scenario => [
    `platform-extra Windows x64 build ${build} stays supported`,
    () => expectProfile({ platform: 'win32', arch: 'x64', release: `10.0.${build}` }, 'windows', 'supported'),
  ]),
  ...[22, 23, 24, 25].flatMap((major) => (['x64', 'arm64'] as const).map((arch): Scenario => [
    `platform-extra Darwin ${major} ${arch} stays supported`,
    () => expectProfile({ platform: 'darwin', arch, release: `${major}.6.0` }, 'macos', 'supported'),
  ])),
  ...['4.19.0', '5.4.0', '6.1.0', '6.8.0'].flatMap((release) => (['x64', 'arm64'] as const).map((arch): Scenario => [
    `platform-extra Linux ${release} ${arch} is classified explicitly`,
    () => expectProfile({ platform: 'linux', arch, release }, 'linux', arch === 'x64' ? 'supported' : 'preview'),
  ])),
  ...(['sunos', 'openbsd', 'android', 'haiku'] as const).map((platform): Scenario => [
    `platform-extra ${platform} fails closed`,
    () => expectProfile({ platform, arch: 'x64', release: '1.0.0' }, 'unsupported', 'unsupported'),
  ]),
];

const pathVariantNames = ['Alpha', 'Project Space', 'โปรเจกต์', 'dot.name', 'under_score', 'hyphen-name', '123', 'Ωmega', 'éclair', 'nested root'] as const;
const extendedPathScenarios: readonly Scenario[] = [
  ...pathVariantNames.map((name, index): Scenario => [
    `path-extra Windows contained variant ${index + 1} (${name})`,
    () => expect(isHostPathWithin(`C:\\Work\\${name}`, `c:\\work\\${name}\\src\\file.ts`, 'win32')).toBe(true),
  ]),
  ...pathVariantNames.map((name, index): Scenario => [
    `path-extra Windows sibling-prefix escape ${index + 1} (${name})`,
    () => expect(isHostPathWithin(`C:\\Work\\${name}`, `C:\\Work\\${name}-outside\\file.ts`, 'win32')).toBe(false),
  ]),
  ...pathVariantNames.map((name, index): Scenario => [
    `path-extra POSIX contained variant ${index + 1} (${name})`,
    () => expect(isHostPathWithin(`/srv/work/${name}`, `/srv/work/${name}/src/file.ts`, 'linux')).toBe(true),
  ]),
  ...Array.from({ length: 10 }, (_, index): Scenario => [
    `path-extra POSIX case-sensitive boundary ${index + 1}`,
    () => expect(isHostPathWithin(`/srv/work/Project${index}`, `/srv/work/project${index}/src`, 'darwin')).toBe(false),
  ]),
];

const applicationDataCases = [
  ['win32-relative', 'win32', 'C:\\Users\\alice', { APPDATA: 'relative' }, 'C:\\Users\\alice\\AppData\\Roaming'],
  ['win32-absolute', 'win32', 'C:\\Users\\alice', { APPDATA: 'D:\\Roaming' }, 'D:\\Roaming'],
  ['darwin-fixed', 'darwin', '/Users/alice', { XDG_CONFIG_HOME: '/ignored' }, '/Users/alice/Library/Application Support'],
  ['linux-relative', 'linux', '/home/alice', { XDG_CONFIG_HOME: 'relative' }, '/home/alice/.config'],
  ['linux-absolute', 'linux', '/home/alice', { XDG_CONFIG_HOME: '/srv/config' }, '/srv/config'],
  ['linux-empty', 'linux', '/home/alice', { XDG_CONFIG_HOME: '   ' }, '/home/alice/.config'],
] as const;

const tunnelProfileCases = [
  ['win32-absolute', 'win32', 'C:\\Users\\alice', { APPDATA: 'D:\\Roaming' }],
  ['win32-relative', 'win32', 'C:\\Users\\alice', { APPDATA: 'relative' }],
  ['win32-empty', 'win32', 'C:\\Users\\alice', {}],
  ['darwin-default', 'darwin', '/Users/alice', {}],
  ['darwin-xdg-ignored', 'darwin', '/Users/alice', { XDG_DATA_HOME: '/ignored' }],
  ['darwin-appdata-ignored', 'darwin', '/Users/alice', { APPDATA: 'D:\\ignored' }],
  ['linux-absolute', 'linux', '/home/alice', { XDG_DATA_HOME: '/srv/data' }],
  ['linux-relative', 'linux', '/home/alice', { XDG_DATA_HOME: 'relative' }],
  ['linux-empty', 'linux', '/home/alice', {}],
] as const;

const dataPathCases = [
  ['win-appdata', { APPDATA: 'D:\\Roaming' }, undefined, 'win32', 'D:\\Roaming\\lnwjing'],
  ['win-appdata-trimmed', { APPDATA: '  D:\\Roaming  ' }, undefined, 'win32', 'D:\\Roaming\\lnwjing'],
  ['win-relative-appdata-userprofile-fallback', { APPDATA: 'relative', USERPROFILE: 'C:\\Users\\alice' }, undefined, 'win32', 'C:\\Users\\alice\\AppData\\Roaming\\lnwjing'],
  ['win-relative-appdata-electron-fallback', { APPDATA: 'relative' }, 'E:\\ElectronData', 'win32', 'E:\\ElectronData\\lnwjing'],
  ['win-explicit', { LNWJING_DATA_PATH: 'D:\\AgentData' }, undefined, 'win32', 'D:\\AgentData'],
  ['win-explicit-trimmed', { LNWJING_DATA_PATH: '  D:\\AgentData  ' }, undefined, 'win32', 'D:\\AgentData'],
  ['win-relative-explicit-falls-back', { LNWJING_DATA_PATH: 'relative-data', APPDATA: 'D:\\Roaming' }, undefined, 'win32', 'D:\\Roaming\\lnwjing'],
  ['win-empty-explicit-falls-back', { LNWJING_DATA_PATH: '   ', APPDATA: 'D:\\Roaming' }, undefined, 'win32', 'D:\\Roaming\\lnwjing'],
  ['win-userprofile', { USERPROFILE: 'C:\\Users\\alice' }, undefined, 'win32', 'C:\\Users\\alice\\AppData\\Roaming\\lnwjing'],
  ['win-electron', {}, 'E:\\ElectronData', 'win32', 'E:\\ElectronData\\lnwjing'],
  ['win-relative-electron-falls-back', { APPDATA: 'D:\\Roaming' }, 'relative-electron', 'win32', 'D:\\Roaming\\lnwjing'],
  ['win-unc-appdata', { APPDATA: '\\\\server\\share\\Roaming' }, undefined, 'win32', '\\\\server\\share\\Roaming\\lnwjing'],
  ['win-unc-explicit', { LNWJING_DATA_PATH: '\\\\server\\share\\lnwjing-data' }, undefined, 'win32', '\\\\server\\share\\lnwjing-data'],
  ['win-root-appdata', { APPDATA: 'C:\\' }, undefined, 'win32', 'C:\\lnwjing'],
  ['mac-home', { HOME: '/Users/alice' }, undefined, 'darwin', '/Users/alice/Library/Application Support/lnwjing'],
  ['mac-electron', { HOME: '/Users/alice' }, '/Users/alice/Custom AppData', 'darwin', '/Users/alice/Custom AppData/lnwjing'],
  ['mac-explicit', { LNWJING_DATA_PATH: '/Volumes/Data/lnwjing-data' }, undefined, 'darwin', '/Volumes/Data/lnwjing-data'],
  ['mac-explicit-trimmed', { LNWJING_DATA_PATH: '  /Volumes/Data/lnwjing-data  ' }, undefined, 'darwin', '/Volumes/Data/lnwjing-data'],
  ['mac-relative-explicit-falls-back', { LNWJING_DATA_PATH: 'relative-data', HOME: '/Users/alice' }, undefined, 'darwin', '/Users/alice/Library/Application Support/lnwjing'],
  ['mac-relative-electron-falls-back', { HOME: '/Users/alice' }, 'relative-electron', 'darwin', '/Users/alice/Library/Application Support/lnwjing'],
  ['linux-xdg', { HOME: '/home/alice', XDG_DATA_HOME: '/srv/data' }, undefined, 'linux', '/srv/data/lnwjing'],
  ['linux-xdg-trimmed', { HOME: '/home/alice', XDG_DATA_HOME: '  /srv/data  ' }, undefined, 'linux', '/srv/data/lnwjing'],
  ['linux-relative-xdg', { HOME: '/home/alice', XDG_DATA_HOME: 'relative' }, undefined, 'linux', '/home/alice/.local/share/lnwjing'],
  ['linux-empty-xdg', { HOME: '/home/alice', XDG_DATA_HOME: '   ' }, undefined, 'linux', '/home/alice/.local/share/lnwjing'],
  ['linux-electron', { HOME: '/home/alice' }, '/var/lib/alice', 'linux', '/var/lib/alice/lnwjing'],
  ['linux-relative-electron-falls-back', { HOME: '/home/alice', XDG_DATA_HOME: '/srv/data' }, 'relative-electron', 'linux', '/srv/data/lnwjing'],
  ['linux-explicit', { LNWJING_DATA_PATH: '/srv/lnwjing-data' }, undefined, 'linux', '/srv/lnwjing-data'],
  ['linux-relative-explicit-falls-back', { LNWJING_DATA_PATH: 'relative-data', HOME: '/home/alice', XDG_DATA_HOME: '/srv/data' }, undefined, 'linux', '/srv/data/lnwjing'],
  ['linux-root-xdg', { HOME: '/home/alice', XDG_DATA_HOME: '/' }, undefined, 'linux', '/lnwjing'],
] as const;

const profileAndEnvironmentScenarios: readonly Scenario[] = [
  ...applicationDataCases.map(([label, platform, home, environment, expected]): Scenario => [
    `profile-extra application data ${label}`,
    () => expect(defaultApplicationDataDirectory(platform, home, environment)).toBe(expected),
  ]),
  ...tunnelProfileCases.map(([label, platform, home, environment]): Scenario => [
    `profile-extra tunnel auth/runtime symmetry ${label}`,
    () => expect(defaultTunnelProfileDirectory(environment, home, platform)).toBe(resolveTunnelProfileDirectory(environment, home, platform)),
  ]),
  ...(['win32', 'darwin', 'linux'] as const).flatMap((platform): readonly Scenario[] => {
    const home = platform === 'win32' ? 'C:\\Users\\alice' : platform === 'darwin' ? '/Users/alice' : '/home/alice';
    const environment = platform === 'win32' ? { APPDATA: 'D:\\Roaming' } : platform === 'linux' ? { XDG_DATA_HOME: '/srv/data' } : {};
    const separator = platform === 'win32' ? '\\' : '/';
    return [
      [`profile-extra legacy secret suffix ${platform}`, () => expect(legacyTunnelSecretPath(environment, home, platform).endsWith(`${separator}lnwjing.runtime.secret`)).toBe(true)],
      [`profile-extra OAuth secret suffix ${platform}`, () => expect(oauthTunnelSessionPath(environment, home, platform).endsWith(`${separator}lnwjing.oauth.session.secret`)).toBe(true)],
    ];
  }),
  ...dataPathCases.map(([label, environment, electronAppData, platform, expected]): Scenario => [
    `profile-extra data path ${label}`,
    () => expect(resolveLnwjingDataPath(environment, electronAppData, platform)).toBe(expected),
  ]),
];

const validMcpNames = ['serena', 'playwright-mcp', 'context7_1', 'github.mcp', 'A1', 'a-b_c.d', 'MCP123', 'server-01', 'tool.bridge', 'x'] as const;
const invalidMcpNames = ['', 'bad server', 'bad/server', 'bad\\server', '.leading', '-leading', '_leading', 'name#hash', 'lnwjing-helper'] as const;
const mcpEnvironmentCases = [
  ['TOKEN', 'abc123'], ['HOME_DIR', '/home/alice'], ['WIN_PATH', 'C:\\Tools'], ['SPACE_VALUE', 'two words'], ['UNICODE', 'ทดสอบ'],
  ['EMPTY_OK', ''], ['DASH_VALUE', 'a-b-c'], ['DOT_VALUE', 'a.b.c'], ['SLASH_VALUE', '/srv/a/b'], ['JSONISH', '{value}'],
] as const;
const extendedMcpScenarios: readonly Scenario[] = [
  ...validMcpNames.map((name): Scenario => [`mcp-extra valid namespace ${name}`, () => expect(exclusionReason(name, { command: 'node' })).toBeUndefined()]),
  ['mcp-extra surrounding namespace whitespace is normalized before validation', () => expect(exclusionReason('  serena  ', { command: 'node' })).toBeUndefined()],
  ...invalidMcpNames.map((name): Scenario => [`mcp-extra rejected namespace ${JSON.stringify(name)}`, () => expect(exclusionReason(name, { command: 'node' })).toBeDefined()]),
  ...mcpEnvironmentCases.map(([key, value]): Scenario => [
    `mcp-extra environment substitution ${key}`,
    () => expect(normalizeLaunchConfig({ command: 'node', args: [`before-${'${env:' + key + '}'}-after`] }, undefined, { [key]: value })?.args)
      .toEqual([`before-${value}-after`]),
  ]),
];

const posixLiteralArgs = ['two words', '$HOME', '$(not-a-shell)', 'semi;colon', 'unicode-ทดสอบ'] as const;
const windowsUnsafeMetacharacters = ['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n'] as const;
const extendedProcessScenarios: readonly Scenario[] = [
  ...(['darwin', 'linux'] as const).flatMap((platform) => posixLiteralArgs.map((argument): Scenario => [
    `process-extra ${platform} preserves literal argv ${JSON.stringify(argument)}`,
    () => expect(toSpawnInvocation('/usr/bin/tool', [argument], {}, platform)).toEqual({ ok: true, value: { executable: '/usr/bin/tool', args: [argument] } }),
  ])),
  ...windowsUnsafeMetacharacters.map((marker): Scenario => [
    `process-extra Windows command shim rejects ${JSON.stringify(marker)}`,
    () => expect(toSpawnInvocation('npm.cmd', [`safe${marker}unsafe`], {}, 'win32')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }),
  ]),
];

const posixPathResolverScenarios: readonly Scenario[] = (['darwin', 'linux'] as const).flatMap((platform): readonly Scenario[] => [
  [`process-extra ${platform} executable PATH uses colon separators`, () => expectPosixPathResolver('process', platform)],
  [`search-extra ${platform} executable PATH uses colon separators`, () => expectPosixPathResolver('search', platform)],
  [`codex-extra ${platform} executable PATH uses colon separators`, () => expectPosixPathResolver('codex', platform)],
]);

const releaseHostTargets = [
  { platform: 'win32' as const, arch: 'x64' as const },
  { platform: 'darwin' as const, arch: 'x64' as const },
  { platform: 'darwin' as const, arch: 'arm64' as const },
  { platform: 'linux' as const, arch: 'x64' as const },
  { platform: 'linux' as const, arch: 'arm64' as const },
] as const;
const recoveryMatrixScenarios: readonly Scenario[] = releaseHostTargets.flatMap((source) => releaseHostTargets.map((target): Scenario => [
  `recovery-matrix ${source.platform}/${source.arch} -> ${target.platform}/${target.arch}`,
  () => expectRestoreCompatibility(source.platform, source.arch, target.platform, target.arch,
    source.platform === target.platform && source.arch === target.arch ? 'same_host' : 'cross_host'),
]));

interface RuntimeDependencyManifest {
  readonly schemaVersion: number;
  readonly tunnelClient: { readonly targets: Readonly<Record<string, { readonly releaseTarget: string; readonly releaseArch: string; readonly executable: string; readonly archiveSha256: string }>> };
  readonly ripgrep: { readonly targets: Readonly<Record<string, { readonly archive: string; readonly sha256: string; readonly executable: string; readonly kind: string; readonly targetTriple: string }>> };
  readonly pdfProvider: { readonly platform: string; readonly arch: string; readonly sourceUrl: string; readonly archiveSha256: string; readonly version: string; readonly popplerVersion: string };
}

const runtimeTargetCases = [
  { key: 'win32-x64', releaseTarget: 'windows', releaseArch: 'amd64', tunnelExecutable: 'tunnel-client.exe', ripgrepExecutable: 'rg.exe', triple: 'x86_64-pc-windows-msvc' },
  { key: 'win32-arm64', releaseTarget: 'windows', releaseArch: 'arm64', tunnelExecutable: 'tunnel-client.exe', ripgrepExecutable: 'rg.exe', triple: 'aarch64-pc-windows-msvc' },
  { key: 'darwin-x64', releaseTarget: 'darwin', releaseArch: 'amd64', tunnelExecutable: 'tunnel-client', ripgrepExecutable: 'rg', triple: 'x86_64-apple-darwin' },
  { key: 'darwin-arm64', releaseTarget: 'darwin', releaseArch: 'arm64', tunnelExecutable: 'tunnel-client', ripgrepExecutable: 'rg', triple: 'aarch64-apple-darwin' },
  { key: 'linux-x64', releaseTarget: 'linux', releaseArch: 'amd64', tunnelExecutable: 'tunnel-client', ripgrepExecutable: 'rg', triple: 'x86_64-unknown-linux-musl' },
  { key: 'linux-arm64', releaseTarget: 'linux', releaseArch: 'arm64', tunnelExecutable: 'tunnel-client', ripgrepExecutable: 'rg', triple: 'aarch64-unknown-linux-musl' },
] as const;

const runtimeDependencyScenarios: readonly Scenario[] = [
  ...runtimeTargetCases.map(({ key, tunnelExecutable }): Scenario => [`runtime-extra tunnel executable ${key}`, async () => {
    const target = (await runtimeDependencyManifest()).tunnelClient.targets[key];
    expect(target).toMatchObject({ executable: tunnelExecutable });
    expect(target?.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
  }]),
  ...runtimeTargetCases.map(({ key, ripgrepExecutable }): Scenario => [`runtime-extra ripgrep archive ${key}`, async () => {
    const target = (await runtimeDependencyManifest()).ripgrep.targets[key];
    expect(target).toMatchObject({ executable: ripgrepExecutable });
    expect(target?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(['zip', 'tar.gz']).toContain(target?.kind);
  }]),
  ...runtimeTargetCases.map(({ key, releaseTarget, releaseArch }): Scenario => [`runtime-extra tunnel target mapping ${key}`, async () => {
    expect((await runtimeDependencyManifest()).tunnelClient.targets[key]).toMatchObject({ releaseTarget, releaseArch });
  }]),
  ...runtimeTargetCases.map(({ key, triple }): Scenario => [`runtime-extra ripgrep target triple ${key}`, async () => {
    expect((await runtimeDependencyManifest()).ripgrep.targets[key]?.targetTriple).toBe(triple);
  }]),
  ['runtime-extra manifest schema stays version 1', async () => expect((await runtimeDependencyManifest()).schemaVersion).toBe(1)],
  ['runtime-extra PDF provider stays Windows-only', async () => expect((await runtimeDependencyManifest()).pdfProvider.platform).toBe('win32')],
  ['runtime-extra PDF provider stays x64-only', async () => expect((await runtimeDependencyManifest()).pdfProvider.arch).toBe('x64')],
  ['runtime-extra PDF provider archive is SHA-256 pinned', async () => expect((await runtimeDependencyManifest()).pdfProvider.archiveSha256).toMatch(/^[0-9a-f]{64}$/u)],
  ['runtime-extra PDF provider source is HTTPS GitHub release', async () => expect((await runtimeDependencyManifest()).pdfProvider.sourceUrl).toMatch(/^https:\/\/github\.com\//u)],
  ['runtime-extra PDF provider version matches Poppler version prefix', async () => {
    const pdf = (await runtimeDependencyManifest()).pdfProvider;
    expect(pdf.version.startsWith(pdf.popplerVersion)).toBe(true);
  }],
];

const extendedCiScenarios: readonly Scenario[] = [
  ['ci-extra native contract references release scenarios', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'cross-platform-release-scenarios.test.ts')],
  ['ci-extra native contract runs full workspace suite', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'Run complete native unit and service acceptance suites')],
  ['ci-extra native contract has Windows runner', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'os: windows-latest')],
  ['ci-extra package matrix has macOS arm64', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'name: macOS arm64')],
  ['ci-extra package matrix has macOS Intel', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'os: macos-15-intel')],
  ['ci-extra package matrix has Linux x64', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'name: Linux x64')],
  ['ci-extra package matrix has Linux arm64', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'os: ubuntu-24.04-arm')],
  ['ci-extra package E2E exercises MCP client', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'desktop-mcp-client.e2e.ts')],
  ['ci-extra package E2E exercises Electron security', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'electron-security.e2e.ts')],
  ['ci-extra macOS smoke stages the real DMG', () => expectRepositoryFileContains('.github/workflows/ci.yml', 'stage-macos-smoke-app.sh')],
  ['ci-extra platform verifier runs release scenarios', () => expectRepositoryFileContains('scripts/verify-platform-release.mjs', "'release-scenarios'")],
  ['ci-extra platform verifier runs full workspace suite', () => expectRepositoryFileContains('scripts/verify-platform-release.mjs', "'full-workspace-suite'")],
  ['ci-extra platform verifier runs packaging contracts', () => expectRepositoryFileContains('scripts/verify-platform-release.mjs', "'packaging-contract'")],
  ['ci-extra platform verifier runs Swift tests on macOS', () => expectRepositoryFileContains('scripts/verify-platform-release.mjs', 'macos-native-host-tests')],
  ['ci-extra platform verifier runs Cargo tests on Linux', () => expectRepositoryFileContains('scripts/verify-platform-release.mjs', 'linux-native-host-tests')],
  ['ci-extra dev installer is manual-only and never runs on ordinary dev pushes', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'dev-installer.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('\n  push:');
    expect(workflow).not.toContain('[build-installer]');
    expect(workflow).toContain('uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4');
    expect(workflow).toContain('version: 10.15.0');
    expect(workflow).not.toContain('corepack prepare pnpm@10.15.0 --activate');
  }],
  ['ci-extra dev workflow builds Windows Setup and Portable when manually dispatched', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'Build Windows Setup and Portable')],
  ['ci-extra dev workflow installs cosign before provenance-bound packaging', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'Install cosign for tunnel provenance verification')],
  ['ci-extra dev workflow pins the required cosign release', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', "cosign-release: 'v3.1.3'")],
  ['ci-extra dev workflow exposes cosign to the Windows package contract', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'LNWJING_COSIGN_PATH: cosign')],
  ['ci-extra dev workflow runs packaged Windows MCP smoke', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'Run packaged Windows Electron MCP and security smoke')],
  ['ci-extra dev Windows smoke exercises MCP client', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'desktop-mcp-client.e2e.ts')],
  ['ci-extra dev Windows smoke exercises security', () => expectRepositoryFileContains('.github/workflows/dev-installer.yml', 'electron-security.e2e.ts')],
  ['ci-extra release collector requires all five product targets', () => expectRepositoryFileContains('scripts/collect-release-assets.mjs', "{ key: 'linux-arm64', platform: 'linux', arch: 'arm64' }")],
];

const allScenarioGroups = [
  platformScenarios,
  pathScenarios,
  mcpConfigScenarios,
  secretScenarios,
  processAndRuntimeScenarios,
  remediationScenarios,
  recoveryScenarios,
  nativeCiScenarios,
  extendedPlatformScenarios,
  extendedPathScenarios,
  profileAndEnvironmentScenarios,
  extendedMcpScenarios,
  extendedProcessScenarios,
  posixPathResolverScenarios,
  recoveryMatrixScenarios,
  runtimeDependencyScenarios,
  extendedCiScenarios,
] as const;

const scenarioCount = allScenarioGroups.reduce((total, group) => total + group.length, 0);
const MINIMUM_RELEASE_SCENARIOS = 350;
if (scenarioCount < MINIMUM_RELEASE_SCENARIOS) throw new Error(`Cross-platform release scenario inventory must never fall below ${MINIMUM_RELEASE_SCENARIOS}; found ${scenarioCount}`);

describe(`cross-platform release audit: ${scenarioCount} deterministic scenarios`, () => {
  for (const group of allScenarioGroups) {
    it.each(group)('%s', async (_name, run) => run(), 30_000);
  }
});

async function expectPosixPathResolver(kind: 'process' | 'search' | 'codex', platform: 'darwin' | 'linux'): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), '.lnwjing-posix-path-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const executable = kind === 'codex' ? 'codex' : kind === 'search' ? 'rg-scenario' : 'process-scenario';
    const expected = path.join(second, executable);
    await writeFile(expected, 'fixture', 'utf8');
    const relativeFirst = path.relative(process.cwd(), first).replaceAll('\\', '/');
    const relativeSecond = path.relative(process.cwd(), second).replaceAll('\\', '/');
    const environment = { PATH: `${relativeFirst}:${relativeSecond}` };
    const result = kind === 'process'
      ? await new ProcessPathExecutableResolver(environment, platform).resolve(executable)
      : kind === 'search'
        ? await new SearchPathExecutableResolver(environment, platform).resolve(executable)
        : await new PathCodexExecutableResolver(environment, platform).resolve();
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(path.resolve(result.value)).toBe(path.resolve(expected));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectProfile(
  input: PlatformProfileInput,
  family: 'windows' | 'macos' | 'linux' | 'unsupported',
  supportTier: 'supported' | 'preview' | 'unsupported',
): void {
  const profile = createPlatformProfile(input);
  expect(profile).toMatchObject({ family, supportTier });
  if (supportTier === 'unsupported') {
    expect(new Set(Object.values(profile.capabilities))).toEqual(new Set(['unsupported']));
  }
}

async function expectRestoreCompatibility(
  sourcePlatform: NodeJS.Platform,
  sourceArch: string,
  targetPlatform: NodeJS.Platform,
  targetArch: string,
  expectedCompatibility: 'same_host' | 'cross_host',
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-xplat-release-'));
  const databaseFilename = path.join(root, 'lnwjing.sqlite');
  const backupDirectory = path.join(root, 'backups');
  let database: SqliteDatabase | null = new SqliteDatabase(databaseFilename, { backupDirectory });
  try {
    database.connection.exec('CREATE TABLE scenario_value (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO scenario_value (value) VALUES (?)').run('portable-data');
    const service = new SqliteBackupService(database, {
      databaseFilename,
      backupDirectory,
      platform: sourcePlatform,
      arch: sourceArch,
    });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();
    database = null;

    const result = applyPendingSqliteRestoreSync(databaseFilename, backupDirectory, {
      platform: targetPlatform,
      arch: targetArch,
    });
    expect(result).toMatchObject({
      applied: true,
      backupId: snapshot.id,
      crossHost: expectedCompatibility === 'cross_host',
      hostCompatibility: expectedCompatibility,
    });

    const restored = new SqliteDatabase(databaseFilename);
    try {
      expect(restored.connection.prepare('SELECT value FROM scenario_value').get()).toEqual({ value: 'portable-data' });
    } finally {
      restored.close();
    }
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

let workflowCache: string | null = null;
async function workflowSource(): Promise<string> {
  workflowCache ??= await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  return workflowCache;
}

async function expectWorkflowContains(value: string): Promise<void> {
  expect(await workflowSource()).toContain(value);
}

let runtimeDependencyCache: RuntimeDependencyManifest | null = null;
async function runtimeDependencyManifest(): Promise<RuntimeDependencyManifest> {
  if (runtimeDependencyCache !== null) return runtimeDependencyCache;
  const source = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'runtime-dependencies.json'), 'utf8');
  runtimeDependencyCache = JSON.parse(source) as RuntimeDependencyManifest;
  return runtimeDependencyCache;
}

const repositoryFileCache = new Map<string, string>();
async function repositoryFileSource(relativePath: string): Promise<string> {
  const cached = repositoryFileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const source = await readFile(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
  repositoryFileCache.set(relativePath, source);
  return source;
}

async function expectRepositoryFileContains(relativePath: string, value: string): Promise<void> {
  expect(await repositoryFileSource(relativePath)).toContain(value);
}
