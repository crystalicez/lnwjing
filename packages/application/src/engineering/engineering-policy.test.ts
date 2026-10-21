import { describe, expect, it } from 'vitest';
import type { ProjectProfile } from '@lnwjing/project';
import { DEFAULT_ENGINEERING_HARNESS_SETTINGS } from '@lnwjing/shared';
import { classifyEngineeringTaskScope, resolveEngineeringPolicy } from './engineering-policy.js';

const project: ProjectProfile = {
  rootPath: 'E:\\fixture',
  kind: 'node',
  packageManager: 'pnpm',
  frameworks: ['typescript'],
  scripts: { test: 'vitest run' },
  configFiles: ['tsconfig.json'],
  confidence: 'strong',
  detectedFiles: ['package.json'],
  platforms: ['node'],
  suggestedCommands: { test: 'vitest run' },
};

const globalOn = { ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, enabled: true };

describe('Engineering Harness effective policy', () => {
  it('keeps explicit user opt-out authoritative and lets a user workspace override opt in', () => {
    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      workspaceOverride: { mode: 'off' },
      projectAssessment: project,
      taskScope: 'coding',
    })).toMatchObject({ enabled: false, source: 'workspace' });

    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: DEFAULT_ENGINEERING_HARNESS_SETTINGS,
      workspaceOverride: { mode: 'on' },
      projectAssessment: project,
      taskScope: 'coding',
    })).toMatchObject({ enabled: true, source: 'workspace', profile: 'senior' });
  });

  it('allows the repository to turn preparation off or strengthen, but never weaken, the user preset', () => {
    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      projectProfile: { engineering: { mode: 'off', profile: 'strict' } },
      projectAssessment: project,
      taskScope: 'coding',
    })).toMatchObject({ enabled: false, source: 'project', profile: 'strict' });

    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: { ...globalOn, profile: 'strict' },
      projectProfile: { engineering: { mode: 'inherit', profile: 'standard' } },
      projectAssessment: project,
      taskScope: 'coding',
    })).toMatchObject({ enabled: true, profile: 'strict' });
  });

  it('does not silently activate for a non-code task or weak project signal', () => {
    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      projectAssessment: project,
      taskScope: 'non_code',
    })).toMatchObject({ enabled: false, source: 'task_scope' });

    expect(resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      projectAssessment: { ...project, kind: 'unknown', confidence: 'weak', detectedFiles: [], platforms: [] },
      taskScope: 'coding',
    })).toMatchObject({ enabled: false, source: 'project_signal' });
  });

  it('produces a stable digest that changes when policy-relevant project rules change', () => {
    const first = resolveEngineeringPolicy({ workspaceId: 'workspace-1', globalSettings: globalOn, projectAssessment: project, projectAssessmentFingerprint: 'fingerprint-a', taskScope: 'coding' });
    const same = resolveEngineeringPolicy({ workspaceId: 'workspace-1', globalSettings: globalOn, projectAssessment: project, projectAssessmentFingerprint: 'fingerprint-a', taskScope: 'coding' });
    const changed = resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      projectProfile: { engineering: { profile: 'strict' } },
      projectAssessment: project,
      taskScope: 'coding',
    });
    const changedInstructions = resolveEngineeringPolicy({
      workspaceId: 'workspace-1',
      globalSettings: globalOn,
      projectAssessment: project,
      projectAssessmentFingerprint: 'fingerprint-b',
      taskScope: 'coding',
    });
    expect(first.policyDigest).toBe(same.policyDigest);
    expect(changed.policyDigest).not.toBe(first.policyDigest);
    expect(changedInstructions.policyDigest).not.toBe(first.policyDigest);
  });

  it('classifies only clear coding/non-code requests and leaves ambiguous requests unknown', () => {
    expect(classifyEngineeringTaskScope('Fix the auth persistence bug')).toBe('coding');
    expect(classifyEngineeringTaskScope('ช่วยแก้บั๊กฐานข้อมูล')).toBe('coding');
    expect(classifyEngineeringTaskScope('translate this email')).toBe('non_code');
    expect(classifyEngineeringTaskScope('Review the last 3 commits on dev')).toBe('coding');
    expect(classifyEngineeringTaskScope('รีวิวโค้ด 3 commit ล่าสุด')).toBe('coding');
    expect(classifyEngineeringTaskScope('ช่วยจัดการเรื่องนี้ให้หน่อย')).toBe('unknown');
  });
});
