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
    // Runtime tools already stages the tunnel client; avoid redundant downloads
    // and extraction in a one-click build on disk-constrained Windows hosts.
    expect(script).not.toContain("Invoke-Step 'Stage tunnel client'");
    const runtimeTools = await readFile(path.join(root, 'apps', 'desktop', 'scripts', 'prepare-runtime-tools.mjs'), 'utf8');
    expect(runtimeTools).toContain('await runTunnelStager(platform, rawArch)');
    // Looking up Cosign must not recursively enumerate unrelated WinGet packages.
    expect(script).toContain("-Directory -Filter 'Sigstore.Cosign_*'");
    expect(script).not.toContain("$installedRoot -Recurse -File");
  });
});
