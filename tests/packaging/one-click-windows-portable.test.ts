import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('one-click Windows x64 portable build', () => {
  it('provides a root-level double-click launcher that invokes the portable-only builder', async () => {
    const cmd = await readFile(path.join(root, 'BUILD-LNWJING-PORTABLE-X64.cmd'), 'utf8');
    const script = await readFile(path.join(root, 'scripts', 'build-portable-windows-x64.ps1'), 'utf8');
    expect(cmd).toContain('build-portable-windows-x64.ps1');
    expect(cmd).toContain('if not "%EXIT_CODE%"=="0"');
    expect(cmd).toContain('explorer "%~dp0portable"');
    expect(script).toContain("$portableDirectory = Join-Path $repositoryRoot 'portable'");
    expect(script).toContain('Promote verified Portable with retained rollback');
    expect(script).toContain('scripts/promote-portable-build.ps1');
    expect(script).not.toContain('Move-Item -LiteralPath $stagedArtifact -Destination $artifact -Force');
    expect(script).not.toContain('Copy-Item -LiteralPath $stagedArtifact');
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toMatch(/^portable\/$/m);
    expect(script).toContain('lnwjing-Portable-$($package.version).exe');
    expect(script).toContain("'--win', 'portable', '--x64', '--publish', 'never'");
    expect(script).toContain("$env:CI = 'true'");
    expect(script).toContain('$env:CI = $previousCI');
    expect(script).toContain('$manifestOutput = Invoke-Step');
    expect(script).toContain('[switch]$KeepIntermediates');
    expect(script).toContain('Cleaned temporary win-unpacked staging tree.');
    expect(script).toContain('Refusing builder cleanup with nested symlink/junctions.');
    expect(script).toContain('$artifactSha256 = $Matches[1].ToUpperInvariant()');
    expect(script).not.toContain('Get-FileHash -LiteralPath $artifact');
    expect(script).toContain("'8.0'");
    expect(script).toContain('dotnet-install.ps1');
    expect(script.match(/Invoke-WebRequest -Uri 'https:\/\/dot\.net\/v1\/dotnet-install\.ps1'/g)).toHaveLength(1);
    expect(script).not.toContain('.local-artifacts\\dotnet-sdk-8');
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toContain('apps/desktop/build/dotnet-sdk/');
    expect(script).not.toContain("'--win', 'nsis'");
    const desktopPkg = await readFile(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8');
    expect(desktopPkg).not.toContain('prepare-tunnel-client.mjs && node scripts/prepare-runtime-tools.mjs');
    const manifestScript = await readFile(path.join(root, 'apps', 'desktop', 'scripts', 'write-portable-update-manifest.mjs'), 'utf8');
    expect(manifestScript).toContain('for await (const chunk of createReadStream(artifactPath))');
    expect(manifestScript).toContain('sha256Digest.update(chunk)');
    expect(manifestScript).not.toContain('const content = await readFile(artifactPath)');
    // Runtime tools already stages the tunnel client; avoid redundant downloads
    // and extraction in a one-click build on disk-constrained Windows hosts.
    expect(script).not.toContain("Invoke-Step 'Stage tunnel client'");
    const runtimeTools = await readFile(path.join(root, 'apps', 'desktop', 'scripts', 'prepare-runtime-tools.mjs'), 'utf8');
    expect(runtimeTools).toContain('await runTunnelStager(platform, rawArch)');
    // Looking up Cosign must not recursively enumerate unrelated WinGet packages.
    expect(script).toContain("-Directory -Filter 'Sigstore.Cosign_*'");
    expect(script).not.toContain("$installedRoot -Recurse -File");
    expect(script).toContain('$env:LNWJING_COSIGN_PATH = $installedCosign.FullName');
    expect(script).toContain('$env:LNWJING_COSIGN_PATH = $previousCosignPath');
    expect(script).not.toContain('ItemType HardLink');
    const tunnelStager = await readFile(path.join(root, 'apps', 'desktop', 'scripts', 'prepare-tunnel-client.mjs'), 'utf8');
    expect(tunnelStager).toContain('process.env.LNWJING_COSIGN_PATH?.trim()');
  });

  it('refuses a known existing rollback before expensive packaging I/O', async () => {
    const script = await readFile(path.join(root, 'scripts', 'build-portable-windows-x64.ps1'), 'utf8');
    const preflight = script.indexOf('A previous build rollback already exists; inspect it before starting an expensive build.');
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(script.indexOf("Invoke-Step 'Install Electron runtime'"));
    expect(preflight).toBeLessThan(script.indexOf("Invoke-Step 'Package Portable x64 only"));
  });

  it('fails closed on incomplete NSIS inventory before manifest generation and promotion', async () => {
    const build = await readFile(path.join(root, 'scripts', 'build-portable-windows-x64.ps1'), 'utf8');
    const promote = await readFile(path.join(root, 'scripts', 'promote-portable-build.ps1'), 'utf8');
    const verify = await readFile(path.join(root, 'scripts', 'verify-portable-payload.ps1'), 'utf8');
    expect(build).toContain('scripts/verify-portable-payload.ps1');
    const desktopPackage = JSON.parse(await readFile(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const windowsPackage = desktopPackage.scripts['package:windows'];
    expect(windowsPackage).toContain('scripts/verify-portable-payload.ps1');
    expect(windowsPackage.indexOf('verify-portable-payload.ps1')).toBeLessThan(windowsPackage.indexOf('write-portable-update-manifest.mjs'));
    expect(build.indexOf('Verify complete Portable NSIS payload')).toBeLessThan(build.indexOf('Create portable update manifest'));
    expect(promote).toContain("Join-Path $PSScriptRoot 'verify-portable-payload.ps1'");
    expect(promote.indexOf('verify-portable-payload.ps1')).toBeLessThan(promote.indexOf('Move-Item -LiteralPath $destinationExe'));
    expect(verify).toContain("Get-Command '7z'");
    expect(verify).toContain('Path = $R6\\');
    expect(verify).toContain('Get-ChildItem -LiteralPath $unpacked -Recurse -File');
    expect(verify).toContain('$actual.Remove($relativePath)');
    expect(verify).toContain('PORTABLE_PAYLOAD_VERIFIED:');
    expect(verify).toContain('refusing unverified release');
  });

  it('authenticates the Microsoft .NET installer script before executing downloaded code', async () => {
    const script = await readFile(path.join(root, 'scripts', 'build-portable-windows-x64.ps1'), 'utf8');
    const verification = script.indexOf('Get-AuthenticodeSignature -LiteralPath $bootstrap');
    expect(verification).toBeGreaterThan(script.indexOf("Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1'"));
    expect(verification).toBeLessThan(script.indexOf('& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bootstrap'));
    expect(script).toContain("SignerCertificate.Subject");
    expect(script).toContain("'Valid'");
    expect(script).toContain('O=Microsoft Corporation');
  });

  it('provides a verified, rollback-safe promotion helper for local Portable builds', async () => {
    const script = await readFile(path.join(root, 'scripts', 'promote-portable-build.ps1'), 'utf8');
    expect(script).toContain('PORTABLE_VERIFIED:');
    expect(script).toContain("A previous build rollback already exists");
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('[Security.Cryptography.SHA512]::Create()');
    expect(script).toContain('Portable update manifest SHA-512 mismatch.');
    expect(script).toContain('ROLLBACK_EXE:');
    expect(script).toContain('ROLLBACK_MANIFEST:');
    expect(script).not.toContain('Remove-Item -LiteralPath $backupExe, $backupManifest');
    expect(script).toContain('Existing Portable executable and manifest must be a matching pair');
    expect(script).toContain('Move-Item -LiteralPath $backupExe -Destination $destinationExe');
    expect(script).toContain('ReparsePoint');
    expect(script).not.toContain('Copy-Item -LiteralPath $stagedExe');
  });

  it('offers dry-run-first cleanup only for old, unreferenced portable runtime folders', async () => {
    const maintenance = await readFile(path.join(root, 'scripts', 'portable-runtime-maintenance.ps1'), 'utf8');
    expect(maintenance).toContain('[switch]$Apply');
    expect(maintenance).toContain('[int]$MinimumAgeDays = 7');
    expect(maintenance).toContain("[switch]$IncludePartial");
    expect(maintenance).toContain('if (-not $Apply)');
    expect(maintenance).toContain('lnwjing-mcp-stdio.cmd');
    expect(maintenance).toContain('Get-CimInstance Win32_Process');
    expect(maintenance).toContain('ReparsePoint');
    expect(maintenance).toContain('lnwjing-ready');
    expect(maintenance).not.toContain('Remove-Item -LiteralPath $root.FullName -Recurse');
  });

  it.skipIf(process.platform !== 'win32')('deletes only verified old Portable runtimes, never forged or incomplete ready markers', async () => {
    const portable = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-cleanup-fixture-'));
    const current = 'lnwjing-runtime-v5.8.9-current';
    const old = 'lnwjing-runtime-v5.8.7-old';
    const malformed = 'lnwjing-runtime-v5.8.6-forged';
    const missingExe = 'lnwjing-runtime-v5.8.5-incomplete';
    const script = path.join(root, 'scripts', 'clean-portable-runtime-cache.ps1');
    try {
      await writeFile(path.join(portable, 'lnwjing-mcp-stdio.cmd'),
        `@echo off\r\nREM lnwjing-managed-portable-stdio-v1\r\nset "APP=%~dp0${current}\\lnwjing.exe"\r\n`);
      for (const name of [current, old, malformed, missingExe]) {
        const folder = path.join(portable, name);
        await mkdir(folder);
        const match = /^lnwjing-runtime-v(.+)$/.exec(name);
        if (match === null) throw new Error('Invalid test fixture');
        await writeFile(path.join(folder, '.lnwjing-ready'), `lnwjing-v${match[1]}`);
        if (name !== missingExe) await writeFile(path.join(folder, 'lnwjing.exe'), 'test-only');
      }
      await writeFile(path.join(portable, malformed, '.lnwjing-ready'), 'forged');
      const aged = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000);
      for (const name of [old, malformed, missingExe]) await utimes(path.join(portable, name), aged, aged);
      const run = (apply: boolean): string => execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-PortableDirectory', portable, '-RetainReadyCount', '1',
        ...(apply ? ['-Apply'] : []),
      ], { encoding: 'utf8', timeout: 25_000 });
      const preview = run(false);
      expect(preview).toContain('CANDIDATES=1');
      expect(preview).toContain('WOULD_DELETE=' + old);
      expect(preview).not.toContain('WOULD_DELETE=' + malformed);
      expect(preview).not.toContain('WOULD_DELETE=' + missingExe);
      const applied = run(true);
      expect(applied).toContain('DELETED=' + old);
      await expect(stat(path.join(portable, old))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const name of [current, malformed, missingExe]) {
        expect((await stat(path.join(portable, name))).isDirectory()).toBe(true);
      }
    } finally {
      await rm(portable, { recursive: true, force: true });
    }
  });

  it('ships a persistent side-by-side runtime instead of unpacking to TEMP', async () => {
    const config = await readFile(path.join(root, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const patch = await readFile(path.join(root, 'patches', 'app-builder-lib@26.17.0.patch'), 'utf8');

    expect(config).toMatch(/portable:\s+artifactName:[^\r\n]+\s+#.*\s+#.*\s+useZip: true/);
    expect(workspace).toContain('app-builder-lib@26.17.0: patches/app-builder-lib@26.17.0.patch');
    expect(patch).toContain('StrCpy $INSTDIR "$EXEDIR\\lnwjing-runtime-v${VERSION}-${UNPACK_DIR_NAME}"');
    expect(patch).toContain('CreateMutexW');
    expect(patch).toContain('WaitForSingleObject');
    expect(patch).toContain('IfFileExists "$INSTDIR\\.lnwjing-ready"');
    expect(patch).toContain('FileOpen $R7 "$R6\\.lnwjing-ready" w');
    expect(patch).toContain('Rename "$R6" "$INSTDIR"');
    expect(patch).toContain('GetFileAttributesW');
    expect(patch).toContain('Global\\lnwjing-portable-');
    expect(patch).toContain('StdUtils.HashFile');
    expect(patch).toContain('LNWJING_HASH_EXECUTABLE');
    expect(patch).toContain('LNWJING_HASH_APP_ASAR');
    expect(patch).toContain('LNWJING_HASH_RIPGREP');
    expect(patch).toContain('LNWJING_HASH_TUNNEL');
    expect(patch).toContain('!include "${BUILD_RESOURCES_DIR}\\portable-integrity.nsh"');
    const evidenceScript = await readFile(path.join(root, 'apps', 'desktop', 'scripts', 'capture-packaged-runtime-evidence.mjs'), 'utf8');
    expect(evidenceScript).toContain('writePortableRuntimeIntegrityInclude');
    expect(evidenceScript).toContain('sha256File(filePath)');
    expect(patch).toContain('PORTABLE_EXECUTABLE_FILE');
    expect(patch).toContain('ExecWait');
    expect(patch).not.toContain('+  RMDir /r $INSTDIR');
    expect(patch).not.toContain('+  StrCpy $INSTDIR "$TEMP');
  });
});
