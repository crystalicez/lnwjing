import { describe, expect, it, vi } from 'vitest';
import type { EngineeringHarnessSettings } from '@lnwjing/shared';
import type { WorkspaceRepository } from '@lnwjing/workspace';
import { EngineeringPreparationService } from './engineering-preparation-service.js';
import type { EngineeringProjectAssessment } from './engineering-project-assessment.js';

const workspace = {
  id: 'workspace-1',
  displayName: 'Fixture',
  rootPath: 'E:\\fixture',
  realRootPath: 'E:\\fixture',
  createdAt: '2026-09-28T00:00:00.000Z',
};

function repository(): WorkspaceRepository {
  return { get: vi.fn(async (): Promise<typeof workspace> => workspace) } as never;
}

describe('EngineeringPreparationService fast inactive path', () => {
  it('does not scan the project when the user setting is Off', async () => {
    const assess = vi.fn(async (): Promise<never> => { throw new Error('assessment must not run'); });
    const service = new EngineeringPreparationService(repository(), {
      globalSettingsProvider: (): EngineeringHarnessSettings => ({ schemaVersion: 1, enabled: false, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true }),
      assessmentService: { assess } as never,
    });

    const result = await service.prepare(workspace.id, 'Fix the auth persistence bug');
    expect(result).toMatchObject({ ok: true, value: { policy: { enabled: false, source: 'global' } } });
    expect(assess).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('preparation failed');
    expect(result.value.assessment.fingerprint).toBe('engineering-inactive-no-project-scan');
  });

  it('does not scan a non-coding request even when Harness is globally enabled', async () => {
    const assess = vi.fn(async (): Promise<never> => { throw new Error('assessment must not run'); });
    const service = new EngineeringPreparationService(repository(), {
      globalSettingsProvider: (): EngineeringHarnessSettings => ({ schemaVersion: 1, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true }),
      assessmentService: { assess } as never,
    });

    const result = await service.prepare(workspace.id, 'Translate this email to Thai');
    expect(result).toMatchObject({ ok: true, value: { policy: { enabled: false, source: 'task_scope' } } });
    expect(assess).not.toHaveBeenCalled();
  });

  it('performs bounded project assessment when an enabled coding task needs policy resolution', async () => {
    const assess = vi.fn(async (): Promise<EngineeringProjectAssessment> => ({
      project: {
        rootPath: workspace.realRootPath,
        kind: 'node',
        packageManager: 'pnpm',
        frameworks: ['typescript'],
        scripts: {},
        configFiles: [],
        confidence: 'strong',
        detectedFiles: ['package.json'],
        platforms: ['node'],
        suggestedCommands: {},
      },
      instructions: [],
      projectProfile: {},
      projectProfileStatus: 'missing',
      fingerprint: 'assessed',
      warnings: [],
    }));
    const service = new EngineeringPreparationService(repository(), {
      globalSettingsProvider: (): EngineeringHarnessSettings => ({ schemaVersion: 1, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true }),
      assessmentService: { assess } as never,
    });

    const result = await service.prepare(workspace.id, 'Fix the auth persistence bug');
    expect(result).toMatchObject({ ok: true, value: { policy: { enabled: true }, assessment: { fingerprint: 'assessed' } } });
    expect(assess).toHaveBeenCalledOnce();
  });
});
