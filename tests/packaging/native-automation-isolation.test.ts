import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('native automation package isolation', () => {
  it('keeps domain, application, and storage automation independent from Electron, renderer, and MCP layers', async () => {
    const packageNames = ['domain', 'application', 'storage'] as const;
    for (const packageName of packageNames) {
      const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'packages', packageName, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(Object.keys(dependencies), packageName).not.toEqual(expect.arrayContaining([
        'electron', '@lnwjing/mcp-server', '@modelcontextprotocol/server', '@modelcontextprotocol/client',
      ]));
    }

    const foundationalFiles = [
      'packages/domain/src/automation.ts',
      'packages/application/src/automation-service.ts',
      'packages/application/src/automation-verifier.ts',
      'packages/storage/src/automation-repository.ts',
      'packages/storage/src/migrations/native-automation-migration.ts',
    ];
    for (const relativePath of foundationalFiles) {
      const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
      const imports = importedModules(source);
      expect(imports, relativePath).not.toEqual(expect.arrayContaining([
        'electron', '@lnwjing/mcp-server', '@modelcontextprotocol/server', '@modelcontextprotocol/client',
      ]));
      expect(imports.some((value) => /(?:^|\/)apps\/desktop|renderer|electron/i.test(value)), relativePath).toBe(false);
    }
  });

  it('exposes only six Goal-owned operations and creates no automation-specific scheduler or UI worker', async () => {
    const toolSource = await readFile(path.join(repositoryRoot, 'packages/mcp-server/src/tools/automation-tools.ts'), 'utf8');
    const serviceSource = await readFile(path.join(repositoryRoot, 'packages/application/src/automation-service.ts'), 'utf8');
    const adapterSource = await readFile(path.join(repositoryRoot, 'packages/mcp-server/src/automation-runtime-adapter.ts'), 'utf8');
    const publicNames = [...toolSource.matchAll(/name:\s*'(automation_[a-z_]+)'/g)].map((match) => match[1]);
    expect(publicNames).toEqual([
      'automation_create',
      'automation_status',
      'automation_events',
      'automation_run',
      'automation_control',
      'automation_finalize',
    ]);
    expect(publicNames).not.toEqual(expect.arrayContaining([
      'automation_observe', 'automation_verify', 'automation_recover', 'automation_schedule',
    ]));

    const runtimeImports = [
      ...importedModules(toolSource),
      ...importedModules(serviceSource),
      ...importedModules(adapterSource),
    ];
    expect(runtimeImports.some((value) => /electron|renderer|scheduler/i.test(value))).toBe(false);
    expect(serviceSource).not.toMatch(/prepareScheduledContinuation|createScheduledContinuation|new\s+Scheduler/i);
    expect(adapterSource).not.toMatch(/prepareScheduledContinuation|createScheduledContinuation|new\s+Scheduler/i);

    const cliComposition = await readFile(path.join(repositoryRoot, 'apps/cli/src/runtime/stdio-mcp-runtime.ts'), 'utf8');
    const desktopComposition = await readFile(path.join(repositoryRoot, 'apps/desktop/src/main/desktop-services.ts'), 'utf8');
    for (const [name, source] of [['cli', cliComposition], ['desktop', desktopComposition]] as const) {
      expect(source, name).toContain('automationFactory:');
      expect(source, name).toContain('automationResumes: automationRepository');
      expect(source, name).not.toMatch(/AutomationScheduler|automationScheduler|automation_schedule/);
    }
  });

  it('keeps the isolation gate in the canonical packaging suite and adds no packaged automation sidecar', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.['test:packaging']).toContain('tests/packaging/native-automation-isolation.test.ts');

    const builder = await readFile(path.join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8');
    expect(builder).not.toMatch(/automation[-_](?:worker|scheduler|sidecar)/i);
    const desktopPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(desktopPackage.dependencies ?? {})).not.toContain('node-schedule');
    expect(Object.keys(desktopPackage.devDependencies ?? {})).not.toContain('node-schedule');
  });
});

function importedModules(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]!);
}
