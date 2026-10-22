import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
    expect(script).toContain('Move-Item -LiteralPath $stagedArtifact -Destination $artifact -Force');
    expect(script).toContain("Move-Item -LiteralPath $stagedManifest -Destination (Join-Path $portableDirectory 'portable.yml') -Force");
    expect(script).not.toContain('Copy-Item -LiteralPath $stagedArtifact');
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toMatch(/^portable\/$/m);
    expect(script).toContain('lnwjing-Portable-$($package.version).exe');
    expect(script).toContain("'--win', 'portable', '--x64', '--publish', 'never'");
    expect(script).toContain("$env:CI = 'true'");
    expect(script).toContain('$env:CI = $previousCI');
    expect(script).toContain('Get-FileHash');
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
