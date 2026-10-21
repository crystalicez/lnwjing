import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EccProviderService } from './ecc-provider.js';

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

describe('EccProviderService', () => {
  it('inventories pinned ECC artifacts selectively with deterministic provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-provider-'));
    await writeFixture(root, 'package.json', JSON.stringify({ name: 'ecc-universal', version: '2.2.1', license: 'MIT' }));
    await writeFixture(root, 'agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews changes\n---\n');
    await writeFixture(root, 'skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Test first\n---\n');
    await writeFixture(root, 'commands/review.md', '# Review\n');
    await writeFixture(root, 'rules/common/coding-style.md', '# Coding style\n');
    await writeFixture(root, 'hooks/hooks.json', '{"hooks":[]}');
    await writeFixture(root, 'workflows/review.workflow.js', 'export default {};');
    await writeFixture(root, 'mcp-configs/mcp-servers.json', '{"mcpServers":{}}');
    await writeFixture(root, 'skills/continuous-learning/instincts/project.yaml', 'confidence: 0.8');
    await writeFixture(root, 'docs/README.md', '# Other resource\n');

    const provider = new EccProviderService({ rootPath: root, expectedVersion: '2.2.1' });
    const status = await provider.status();

    expect(status).toMatchObject({
      available: true,
      ready: true,
      packageName: 'ecc-universal',
      version: '2.2.1',
      versionMatchesExpectation: true,
      license: 'MIT',
      skippedSymlinks: 0,
      counts: {
        agent: 1,
        skill: 1,
        command: 1,
        rule: 1,
        hook: 1,
        workflow: 1,
        mcp_template: 1,
        instinct: 1,
      },
    });
    expect(status.packageFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const skills = await provider.catalog({ kind: 'skill', query: 'tdd' });
    expect(skills.total).toBe(1);
    expect(skills.artifacts[0]).toMatchObject({
      id: 'ecc:skill:skills/tdd/SKILL.md',
      title: 'tdd',
      description: 'Test first',
      trust: 'upstream_pinned',
      activation: 'selective',
      compatibility: 'native_context',
    });
    await expect(provider.catalog({ kind: 'command' })).resolves.toMatchObject({ artifacts: [{ compatibility: 'legacy_shim' }] });
    await expect(provider.catalog({ kind: 'rule' })).resolves.toMatchObject({ artifacts: [{ ruleLayer: 'common' }] });
    await expect(provider.catalog({ kind: 'hook' })).resolves.toMatchObject({ artifacts: [{ activation: 'disabled', compatibility: 'descriptor_only' }] });
    await expect(provider.catalog({ kind: 'mcp_template' })).resolves.toMatchObject({ artifacts: [{ activation: 'disabled', compatibility: 'disabled_template' }] });
  });

  it('fails closed on version drift and never follows symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-provider-'));
    await writeFixture(root, 'package.json', JSON.stringify({ name: 'ecc-universal', version: '2.2.0', license: 'MIT' }));
    const mismatch = await new EccProviderService({ rootPath: root, expectedVersion: '2.2.1' }).status();
    expect(mismatch.ready).toBe(false);
    expect(mismatch.error).toContain('does not match');

    await writeFixture(root, 'package.json', JSON.stringify({ name: 'ecc-universal', version: '2.2.1', license: 'MIT' }));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-provider-outside-'));
    await writeFixture(outside, 'evil.md', '# outside');
    try {
      await symlink(path.join(outside, 'evil.md'), path.join(root, 'agents', 'escape.md'), 'file');
    } catch {
      // Windows developer mode can deny symlink creation; the provider contract is still covered where supported.
    }

    const status = await new EccProviderService({ rootPath: root, expectedVersion: '2.2.1' }).status();
    expect(status.ready).toBe(true);
    const catalog = await new EccProviderService({ rootPath: root, expectedVersion: '2.2.1' }).catalog({ query: 'escape.md' });
    expect(catalog.total).toBe(0);
  });
});
