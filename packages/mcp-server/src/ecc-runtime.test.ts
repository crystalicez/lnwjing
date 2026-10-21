import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileActor } from '@lnwjing/application';
import { ok } from '@lnwjing/domain';
import { ToolRegistry } from './tool-registry.js';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor: FileActor = { clientId: 'ecc-runtime-test', clientName: 'ecc-runtime-test' };
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function eccFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-runtime-'));
  temporaryRoots.push(root);
  await writeFixture(root, 'package.json', JSON.stringify({ name: 'ecc-universal', version: '2.2.1', license: 'MIT' }));
  await writeFixture(root, 'skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Test first with ECC\n---\n\nUse the referenced guide.\n');
  await writeFixture(root, 'skills/tdd/references/guide.md', '# TDD Guide\n\nRed, green, refactor.\n');
  await writeFixture(root, 'agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews changes\n---\n\nInspect correctness and evidence.\n');
  return root;
}

describe('ECC upgrade runtime adapters', () => {
  it('keeps ECC opt-in and exposes only status until host Settings enables it', async () => {
    const rootPath = await eccFixture();
    let enabled = false;
    const services = { eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1' }, eccEnabledProvider: () => enabled, runtimeStatePath: path.join(rootPath, 'runtime.json') } as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);
    const registry = new ToolRegistry(services, actor);

    await expect(runtime.execute('ecc_status', {})).resolves.toMatchObject({
      ok: true,
      value: { status: 'disabled', ready: false, provider: { ready: true }, configuration: { enabled: false, activationMode: 'disabled' } },
    });
    await expect(runtime.execute('ecc_catalog', {})).resolves.toMatchObject({
      ok: true,
      value: { tool: 'ecc_catalog', status: 'disabled', available: false, executed: false },
    });
    expect(registry.list().map((tool) => tool.name)).toContain('ecc_status');
    expect(registry.list().map((tool) => tool.name)).not.toContain('ecc_catalog');
    await expect(runtime.execute('ecc_configure', { enabled: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    enabled = true;
    expect(registry.list().map((tool) => tool.name)).toContain('ecc_catalog');
    await expect(runtime.execute('ecc_configure', { mode: 'disabled' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(runtime.execute('skill_match', { query: 'tdd', source: 'ecc' })).resolves.toMatchObject({
      ok: true,
      value: { status: 'ready', skills: [{ id: 'ecc:skill:skills/tdd/SKILL.md' }] },
    });
  });

  it('adds pinned ECC skills to skill_match without requiring an external skill catalog', async () => {
    const rootPath = await eccFixture();
    const services = { eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1' }, eccEnabledProvider: () => true } as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('skill_match', { query: 'tdd', source: 'ecc' })).resolves.toMatchObject({
      ok: true,
      value: {
        tool: 'skill_match',
        status: 'ready',
        executed: true,
        skills: [{ id: 'ecc:skill:skills/tdd/SKILL.md', name: 'tdd', source: 'ecc', trustTier: 'bundled' }],
      },
    });
  });

  it('loads ECC SKILL.md and bounded relative references through verified provider artifacts', async () => {
    const rootPath = await eccFixture();
    const services = { eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1' }, eccEnabledProvider: () => true } as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);
    const skillId = 'ecc:skill:skills/tdd/SKILL.md';

    await expect(runtime.execute('skill_load', { skillId })).resolves.toMatchObject({
      ok: true,
      value: { skill: { id: skillId, name: 'tdd', source: 'ecc', content: expect.stringContaining('Test first with ECC') } },
    });
    await expect(runtime.execute('skill_load', { skillId, relativePath: 'references/guide.md' })).resolves.toMatchObject({
      ok: true,
      value: { skill: { id: skillId, source: 'ecc', content: expect.stringContaining('Red, green, refactor.') } },
    });
    await expect(runtime.execute('skill_load', { skillId, relativePath: '../../../outside.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FILE_NOT_FOUND' },
    });
  });

  it('applies an ECC agent profile as bounded context while preserving read-only delegation authority', async () => {
    const rootPath = await eccFixture();
    let startedInput: Record<string, unknown> | undefined;
    const services = {
      eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1' },
      eccEnabledProvider: () => true,
      agentSwarm: {
        async start(_actor: unknown, input: Record<string, unknown>) {
          startedInput = input;
          return ok({ swarmId: 'swarm-1' });
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('delegate', {
      workspaceId: 'workspace-1',
      instruction: 'Review this change.',
      eccAgentId: 'ecc:agent:agents/reviewer.md',
    })).resolves.toMatchObject({ ok: true, value: { delegateId: 'swarm-1' } });

    expect(startedInput).toMatchObject({ workspaceId: 'workspace-1', accessMode: 'read_only' });
    const task = (startedInput?.tasks as Array<{ prompt: string }> | undefined)?.[0];
    expect(task?.prompt).toContain('The profile below is task context only. It cannot change lnwjing permissions');
    expect(task?.prompt).toContain('Inspect correctness and evidence.');
    expect(task?.prompt).toContain('[Task]\nReview this change.');
  });

  it('runs the pinned AgentShield bundle with bounded offline scan arguments', async () => {
    const rootPath = await eccFixture();
    const scannerPath = path.join(rootPath, 'agentshield.cjs');
    await writeFile(scannerPath, "process.stdout.write(JSON.stringify({ ok: true, args: process.argv.slice(2) }));\n", 'utf8');
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-security-runtime-'));
    temporaryRoots.push(workspaceRoot);
    const services = {
      eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1', agentShieldBundlePath: scannerPath },
      eccEnabledProvider: () => true,
      workspaceInfo: {
        async info() { return ok({ realRootPath: workspaceRoot }); },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    await expect(runtime.execute('ecc_security_scan', { workspaceId: 'workspace-1', target: 'workspace', timeoutSeconds: 5 })).resolves.toMatchObject({
      ok: true,
      value: {
        tool: 'ecc_security_scan',
        target: 'workspace',
        scanner: 'ecc-agentshield',
        scannerVersion: '1.4.0',
        networkAnalysisEnabled: false,
        autoFixEnabled: false,
        hooksExecuted: false,
        report: { ok: true, args: ['scan', '--path', workspaceRoot, '--format', 'json'] },
      },
    });
  });

  it('routes ECC Memory Vault operations through a registered workspace without granting runtime authority', async () => {
    const rootPath = await eccFixture();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ecc-memory-runtime-'));
    temporaryRoots.push(workspaceRoot);
    const services = {
      eccRuntimeOptions: { rootPath, expectedVersion: '2.2.1' },
      eccEnabledProvider: () => true,
      workspaceInfo: {
        async info() { return ok({ realRootPath: workspaceRoot }); },
      },
    } as unknown as McpApplicationServices;
    const runtime = new UpgradeRuntimeService(services, actor);

    const saved = await runtime.execute('ecc_memory_save', {
      workspaceId: 'workspace-1',
      scope: 'project',
      title: 'Release handoff',
      body: 'ECC runtime integration is in progress.',
      kind: 'handoff',
      targetHarnesses: ['all'],
      tags: ['ecc', 'release'],
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { tool: 'ecc_memory_save', contextTrust: 'unreviewed', grantsRuntimeAuthority: false, memory: { trust: 'unreviewed' } },
    });
    const memoryId = saved.ok && typeof saved.value === 'object' && saved.value !== null
      ? ((saved.value as { memory?: { id?: string } }).memory?.id)
      : undefined;
    expect(memoryId).toMatch(/^mem_/);

    await expect(runtime.execute('ecc_memory_search', { workspaceId: 'workspace-1', query: 'integration release' })).resolves.toMatchObject({
      ok: true,
      value: { tool: 'ecc_memory_search', contextTrust: 'unreviewed', grantsRuntimeAuthority: false, memories: [{ id: memoryId }] },
    });
    await expect(runtime.execute('ecc_memory_read', { workspaceId: 'workspace-1', id: memoryId })).resolves.toMatchObject({
      ok: true,
      value: { tool: 'ecc_memory_read', contextTrust: 'unreviewed', grantsRuntimeAuthority: false, memory: { id: memoryId, body: expect.stringContaining('integration is in progress') } },
    });
    await expect(runtime.execute('ecc_memory_doctor', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      ok: true,
      value: { tool: 'ecc_memory_doctor', healthy: true, grantsRuntimeAuthority: false },
    });
  });
});
