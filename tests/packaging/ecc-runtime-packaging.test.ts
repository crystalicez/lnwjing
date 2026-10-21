import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const desktopPackage = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const prepareSource = readFileSync(new URL('../../apps/desktop/scripts/prepare-ecc-runtime.mjs', import.meta.url), 'utf8');
const builderSource = readFileSync(new URL('../../apps/desktop/electron-builder.yml', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../apps/desktop/src/main/main.ts', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
const notices = readFileSync(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');

describe('ECC packaged runtime contract', () => {
  it('pins ECC and AgentShield exact versions and materializes them as packaged resources', () => {
    expect(desktopPackage.devDependencies?.['ecc-universal']).toBe('2.2.1');
    expect(desktopPackage.dependencies?.['ecc-agentshield']).toBe('1.4.0');
    expect(prepareSource).toContain("const EXPECTED_VERSION = '2.2.1'");
    expect(prepareSource).toContain("const EXPECTED_SCANNER_VERSION = '1.4.0'");
    expect(prepareSource).toContain("scannerRuntimeBundlePath = path.join(targetRoot, '.lnwjing-agentshield-runtime.cjs')");
    expect(prepareSource).toContain("require('./.lnwjing-agentshield-runtime.cjs')");
    expect(prepareSource).toContain("[scannerBundlePath, '--version']");
    expect(prepareSource).toContain('Prepared AgentShield wrapper failed passthrough validation');
    expect(prepareSource).toContain('scannerCliVersion');
    expect(prepareSource).toContain('scannerUpstreamCliVersion');
    expect(prepareSource).toContain('scannerRuntimeBundleSha256');
    expect(prepareSource).toContain("format: 'cjs'");
    expect(prepareSource).toContain('scannerBundleSha256');
    expect(builderSource).toContain('from: build/ecc-runtime');
    expect(builderSource).toContain('to: ecc-runtime');
    expect(mainSource).toContain("path.join(process.resourcesPath, 'ecc-runtime', '.lnwjing-agentshield.cjs')");
  });

  it('keeps generated ECC resources out of Git while retaining required attribution', () => {
    expect(gitignore).toContain('apps/desktop/build/ecc-runtime/');
    expect(notices).toContain('ecc-universal` 2.2.1');
    expect(notices).toContain('ecc-agentshield` 1.4.0');
    expect(notices).toContain('normalizes the packaged AgentShield CLI version');
    expect(notices).toContain('Imported rules, hooks, workflows, MCP templates, memories, and instincts do not override lnwjing permissions');
  });
});
