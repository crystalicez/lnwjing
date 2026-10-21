import { z } from 'zod';
import type { GoalLeaseProof, Result } from '@lnwjing/domain';
import type { PermissionProfile } from '@lnwjing/permissions';
import type { McpToolResponse } from './result-mapper.js';

export const goalLeaseProofSchema = z.object({
  goalId: z.string().min(1).max(128),
  leaseToken: z.string().min(1).max(256),
  leaseGeneration: z.number().int().nonnegative(),
}).strict();

export const engineeringTaskBindingSchema = z.union([
  z.object({
    goalId: z.string().min(1).max(128),
    policyDigest: z.string().min(1).max(256),
    goalRevision: z.number().int().nonnegative(),
    userIntentRevision: z.number().int().nonnegative(),
    scopedPath: z.string().min(1).max(4096).optional(),
    sessionId: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({
    objective: z.string().trim().min(1).max(32_768),
    scopedPath: z.string().min(1).max(4096).optional(),
    policyDigest: z.string().min(1).max(256),
    primaryTaskKind: z.enum(['feature', 'bugfix', 'refactor', 'review', 'incident', 'release', 'maintenance', 'docs', 'unknown']),
    riskTier: z.enum(['low', 'medium', 'high', 'critical']),
    deliveryScope: z.enum(['local', 'commit', 'push', 'pull_request', 'merge', 'release', 'deploy']),
    sessionId: z.string().min(1).max(256).optional(),
  }).strict(),
]);

export type EngineeringTaskBinding = z.infer<typeof engineeringTaskBindingSchema>;

export interface CheckedInvocationEnvelope {
  readonly goalLease?: GoalLeaseProof;
  readonly engineeringTask?: EngineeringTaskBinding;
}

export interface RegistryPermissionProfile {
  readonly profile: PermissionProfile['name'];
  readonly defaults: PermissionProfile['defaults'];
  readonly authorizationMode: 'standard' | 'full_bypass';
  readonly bypassApplicationAuthorization: boolean;
  readonly invocationGuard: 'ready' | 'blocked';
  readonly operatingSystemAndRemotePolicyRemain: true;
  readonly goalLeaseFenceRemains: true;
}

export interface RegistryPermissionPreview {
  readonly tool: string;
  readonly decision: 'allow' | 'ask' | 'deny' | 'unknown';
  readonly profile: PermissionProfile['name'];
  readonly authorizationMode: 'standard' | 'full_bypass';
  readonly mutationKind?: string;
  readonly reason: string;
  readonly hostApprovalRequired: boolean;
  readonly goalLeaseRequired: boolean;
  readonly sideEffectsStarted: false;
  readonly advisory: true;
}

export interface McpRegistryRuntimePort {
  profile(): RegistryPermissionProfile;
  preview(name: string, input: unknown, envelope?: CheckedInvocationEnvelope): Promise<RegistryPermissionPreview>;
  validate(name: string, input: unknown): Result<unknown>;
  invoke(name: string, input: unknown, signal?: AbortSignal, envelope?: CheckedInvocationEnvelope): Promise<McpToolResponse>;
  describeInputJsonSchema?(name: string): Record<string, unknown> | undefined;
}
