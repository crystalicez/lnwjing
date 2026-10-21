import { createHash } from 'node:crypto';
import type { ProjectProfile } from '@lnwjing/project';
import {
  projectEngineeringSettings,
  type EngineeringHarnessSettings,
  type EngineeringProfile,
  type ProjectEngineeringSettings,
} from '@lnwjing/shared';

export type EngineeringWorkspaceMode = 'inherit' | 'on' | 'off';
export type EngineeringTaskScope = 'coding' | 'non_code' | 'unknown';
export type EffectiveEngineeringPolicySource = 'global' | 'workspace' | 'project' | 'task_scope' | 'project_signal';

export interface EngineeringWorkspaceOverride {
  readonly mode: EngineeringWorkspaceMode;
  readonly profile?: EngineeringProfile;
}

export interface EffectiveEngineeringPolicy {
  readonly enabled: boolean;
  readonly source: EffectiveEngineeringPolicySource;
  readonly profile: EngineeringProfile;
  readonly custom?: NonNullable<EngineeringHarnessSettings['custom']>;
  readonly workspaceId: string;
  readonly taskScope: EngineeringTaskScope;
  readonly project: ProjectEngineeringSettings;
  readonly policyDigest: string;
  readonly reasons: readonly string[];
}

export interface ResolveEngineeringPolicyInput {
  readonly workspaceId: string;
  readonly globalSettings: EngineeringHarnessSettings;
  readonly workspaceOverride?: EngineeringWorkspaceOverride;
  readonly projectProfile?: unknown;
  readonly projectAssessment: ProjectProfile;
  readonly projectAssessmentFingerprint?: string;
  readonly taskScope: EngineeringTaskScope;
}

const PROFILE_STRENGTH: Readonly<Record<Exclude<EngineeringProfile, 'custom'>, number>> = {
  standard: 1,
  senior: 2,
  strict: 3,
};

export function resolveEngineeringPolicy(input: ResolveEngineeringPolicyInput): EffectiveEngineeringPolicy {
  const workspace = input.workspaceOverride ?? { mode: 'inherit' as const };
  const project = projectEngineeringSettings(input.projectProfile);
  const userEnabled = workspace.mode === 'on' ? true : workspace.mode === 'off' ? false : input.globalSettings.enabled;
  const userSource: EffectiveEngineeringPolicySource = workspace.mode === 'inherit' ? 'global' : 'workspace';
  const baseProfile = workspace.profile ?? input.globalSettings.profile;
  const profile = strengthenProfile(baseProfile, project.profile);
  const custom = profile === 'custom'
    ? input.globalSettings.custom ?? { analysis: 'cross_file', review: 'risk_based', validation: 'risk_based', docsImpactCheck: true }
    : undefined;
  const reasons: string[] = [];

  let enabled = userEnabled;
  let source: EffectiveEngineeringPolicySource = userSource;
  reasons.push(workspace.mode === 'on'
    ? 'Workspace user setting explicitly enabled Engineering Harness.'
    : workspace.mode === 'off'
      ? 'Workspace user setting explicitly disabled Engineering Harness.'
      : input.globalSettings.enabled
        ? 'Global user setting enabled Engineering Harness.'
        : 'Global user setting disabled Engineering Harness.');

  if (enabled && project.mode === 'off') {
    enabled = false;
    source = 'project';
    reasons.push('Project profile engineering.mode=off disables new task preparation in this repository.');
  }

  if (enabled && input.taskScope !== 'coding') {
    enabled = false;
    source = 'task_scope';
    reasons.push(input.taskScope === 'non_code'
      ? 'The current request is not a coding task.'
      : 'The current request is ambiguous; Engineering Harness will not activate without a coding-task signal.');
  }

  if (enabled && input.globalSettings.applyTo === 'coding_projects'
    && input.projectAssessment.confidence !== 'strong'
    && input.projectAssessment.confidence !== 'medium') {
    enabled = false;
    source = 'project_signal';
    reasons.push('Coding-project scope requires a manifest-backed project signal; the current signal is weak or absent.');
  }

  if (project.profile !== undefined) {
    reasons.push(profile === project.profile
      ? `Project profile strengthens the Engineering preset to ${project.profile}.`
      : `Project profile ${project.profile} does not lower the user-selected ${baseProfile} preset.`);
  }
  reasons.push('Host permissions, Active Project scope, recovery, and rolling goalLease fences remain authoritative.');

  const policyDigest = digestPolicy({
    workspaceId: input.workspaceId,
    globalSettings: input.globalSettings,
    workspaceOverride: workspace,
    project,
    projectAssessment: {
      kind: input.projectAssessment.kind,
      confidence: input.projectAssessment.confidence,
      detectedFiles: input.projectAssessment.detectedFiles,
      platforms: input.projectAssessment.platforms,
      fingerprint: input.projectAssessmentFingerprint ?? null,
    },
    taskScope: input.taskScope,
    enabled,
    profile,
    ...(custom === undefined ? {} : { custom }),
  });

  return { enabled, source, profile, ...(custom === undefined ? {} : { custom }), workspaceId: input.workspaceId, taskScope: input.taskScope, project, policyDigest, reasons };
}

export function classifyEngineeringTaskScope(objective: string): EngineeringTaskScope {
  const normalized = objective.trim().toLowerCase();
  if (normalized.length === 0) return 'unknown';
  if (/(\b(code|coding|bug|fix|implement|refactor|api|sdk|database|schema|auth|test|lint|typecheck|compile|build|deploy|release|package|dependency|function|class|module|repository|repo|css|frontend|backend|migration|commits?|diff|pull request)\b|โค้ด|โปรแกรม|บั๊ก|แก้บั๊ก|ฐานข้อมูล|ทดสอบ|รีแฟคเตอร์|ดีพลอย|คอมมิต|รีวิวโค้ด|ตรวจโค้ด)/i.test(normalized)) return 'coding';
  if (/(\b(email|invoice|restaurant|weather|flight|translate|translation|image|photo|recipe)\b|อีเมล|ใบเสนอราคา|ร้านอาหาร|อากาศ|เที่ยวบิน|แปล|รูปภาพ|อาหาร)/i.test(normalized)) return 'non_code';
  return 'unknown';
}

function strengthenProfile(userProfile: EngineeringProfile, projectProfile: ProjectEngineeringSettings['profile']): EngineeringProfile {
  if (projectProfile === undefined) return userProfile;
  if (userProfile === 'custom') return projectProfile === 'strict' ? 'strict' : 'custom';
  return PROFILE_STRENGTH[projectProfile] > PROFILE_STRENGTH[userProfile] ? projectProfile : userProfile;
}

function digestPolicy(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
