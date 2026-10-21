import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
const temporaryDirectories: string[] = [];

async function makeFixture(bytes: Buffer): Promise<{ root: string; sourcePath: string; stageDirectory: string; generatedOutput: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-capability-bridge-'));
  temporaryDirectories.push(root);
  const sourcePath = path.join(root, 'windows-capability-bridge.ps1');
  const stageDirectory = path.join(root, 'stage');
  const generatedOutput = path.join(root, 'windows-capability-integrity.generated.ts');
  await writeFile(sourcePath, bytes);
  return { root, sourcePath, stageDirectory, generatedOutput };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Windows capability bridge packaging', () => {
  it.each([
    ['LF', Buffer.from("param()\nWrite-Output 'ok'\n", 'utf8')],
    ['CRLF', Buffer.from("param()\r\nWrite-Output 'ok'\r\n", 'utf8')],
  ])('stages the exact %s source bytes and derives every integrity artifact from those bytes', async (_label, sourceBytes) => {
    const { sourcePath, stageDirectory, generatedOutput } = await makeFixture(sourceBytes);
    const { writeCapabilityIntegrity } = await import('../../apps/desktop/scripts/write-capability-integrity.mjs');

    const result = await writeCapabilityIntegrity({ sourcePath, stageDirectory, generatedOutput });
    const stagedBridge = await readFile(path.join(stageDirectory, 'windows-capability-bridge.ps1'));
    const digest = sha256(sourceBytes);
    const manifest = await readFile(path.join(stageDirectory, 'windows-capability-bridge.sha256'), 'utf8');
    const descriptor = JSON.parse(await readFile(path.join(stageDirectory, 'windows-capability-bridge.integrity.json'), 'utf8')) as {
      schemaVersion?: unknown;
      fileName?: unknown;
      sizeBytes?: unknown;
      sha256?: unknown;
    };
    const generated = await readFile(generatedOutput, 'utf8');

    expect(stagedBridge).toEqual(sourceBytes);
    expect(result).toEqual({ fileName: 'windows-capability-bridge.ps1', sizeBytes: sourceBytes.byteLength, sha256: digest });
    expect(manifest).toBe(`${digest}  windows-capability-bridge.ps1\n`);
    expect(descriptor).toEqual({ schemaVersion: 1, fileName: 'windows-capability-bridge.ps1', sizeBytes: sourceBytes.byteLength, sha256: digest });
    expect(generated).toContain(`WINDOWS_CAPABILITY_BRIDGE_SHA256 = '${digest}'`);
    expect(generated).toContain(`WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES = ${sourceBytes.byteLength}`);
  });

  it('keeps staged package input immutable when the editable source changes after staging', async () => {
    const originalBytes = Buffer.from("Write-Output 'before'\r\n", 'utf8');
    const mutatedBytes = Buffer.from("Write-Output 'after'\n", 'utf8');
    const { sourcePath, stageDirectory, generatedOutput } = await makeFixture(originalBytes);
    const { writeCapabilityIntegrity } = await import('../../apps/desktop/scripts/write-capability-integrity.mjs');

    await writeCapabilityIntegrity({ sourcePath, stageDirectory, generatedOutput });
    await writeFile(sourcePath, mutatedBytes);

    expect(await readFile(path.join(stageDirectory, 'windows-capability-bridge.ps1'))).toEqual(originalBytes);
    const builderConfig = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    expect(builderConfig).toContain('from: build/capability-bridge/windows-capability-bridge.ps1');
    expect(builderConfig).not.toContain('from: ../../packages/capabilities/src/windows-capability-bridge.ps1');
  });

  it('fails verification for descriptor size, digest, manifest, compiled expectation, or packaged-byte drift', async () => {
    const sourceBytes = Buffer.from("Write-Output 'verified'\r\n", 'utf8');
    const { sourcePath, stageDirectory, generatedOutput, root } = await makeFixture(sourceBytes);
    const { writeCapabilityIntegrity } = await import('../../apps/desktop/scripts/write-capability-integrity.mjs');
    const { verifyCapabilityBridgeArtifacts } = await import('../../apps/desktop/scripts/verify-capability-bridge-artifacts.mjs');
    const identity = await writeCapabilityIntegrity({ sourcePath, stageDirectory, generatedOutput });
    const packagedBridgePath = path.join(root, 'packaged-windows-capability-bridge.ps1');
    await writeFile(packagedBridgePath, sourceBytes);

    await expect(verifyCapabilityBridgeArtifacts({
      sourcePath,
      stageDirectory,
      generatedOutput,
      packagedBridgePath,
      compiledExpectationSha256: identity.sha256,
      compiledExpectationSizeBytes: identity.sizeBytes,
    })).resolves.toEqual(identity);

    const descriptorPath = path.join(stageDirectory, 'windows-capability-bridge.integrity.json');
    const validDescriptor = await readFile(descriptorPath, 'utf8');
    await writeFile(descriptorPath, validDescriptor.replace(`"sizeBytes": ${identity.sizeBytes}`, `"sizeBytes": ${identity.sizeBytes + 1}`));
    await expect(verifyCapabilityBridgeArtifacts({ sourcePath, stageDirectory, generatedOutput, packagedBridgePath })).rejects.toThrow(/size/i);
    await writeFile(descriptorPath, validDescriptor);

    const manifestPath = path.join(stageDirectory, 'windows-capability-bridge.sha256');
    const validManifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, `${'0'.repeat(64)}  windows-capability-bridge.ps1\n`);
    await expect(verifyCapabilityBridgeArtifacts({ sourcePath, stageDirectory, generatedOutput, packagedBridgePath })).rejects.toThrow(/manifest|sha256/i);
    await writeFile(manifestPath, validManifest);

    await expect(verifyCapabilityBridgeArtifacts({
      sourcePath,
      stageDirectory,
      generatedOutput,
      packagedBridgePath,
      compiledExpectationSha256: '0'.repeat(64),
      compiledExpectationSizeBytes: identity.sizeBytes,
    })).rejects.toThrow(/compiled|sha256/i);

    await writeFile(packagedBridgePath, Buffer.from("Write-Output 'tampered'\n", 'utf8'));
    await expect(verifyCapabilityBridgeArtifacts({ sourcePath, stageDirectory, generatedOutput, packagedBridgePath })).rejects.toThrow(/packaged|byte|sha256/i);
  });
});
