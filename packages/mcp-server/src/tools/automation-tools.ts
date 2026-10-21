import type { MutateAutomationRunRequest } from '@lnwjing/application';
import {
  automationControlSchema,
  automationCreateSchema,
  automationEventsSchema,
  automationFinalizeSchema,
  automationRunSchema,
  automationStatusSchema,
} from './schemas.js';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export const AUTOMATION_TOOL_NAMES = [
  'automation_create',
  'automation_status',
  'automation_events',
  'automation_run',
  'automation_control',
  'automation_finalize',
] as const;

export function automationTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'automation_create',
      description: 'Create one owner- and workspace-scoped durable shell automation run beneath an existing leased Goal. The plan must be a bounded acyclic milestone graph with evidence-producing verification for every milestone.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: automationCreateSchema,
      handler: async (input) => context.services.automation?.createRun(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'automation_status',
      description: 'Read one durable automation run owned by the current actor in the requested workspace.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: automationStatusSchema,
      handler: async (input) => context.services.automation?.status(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'automation_events',
      description: 'Read a bounded page of durable automation events owned by the current actor in the requested workspace.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: automationEventsSchema,
      handler: async (input) => context.services.automation?.events(context.actor, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'automation_run',
      description: 'Advance one leased durable automation run to its next deterministic dispatch, observation, or verification boundary. Repeat with the returned current revision; this operation never creates a scheduler.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: automationRunSchema,
      handler: async (input) => {
        const automation = context.services.automation;
        if (automation === undefined) return missingService();
        return automation.advance(context.actor, mutationRequest(input));
      },
    }),
    defineTool({
      name: 'automation_control',
      description: 'Pause, resume, or cancel one leased durable automation run. Cancellation also applies the run cancellation policy to its root Goal.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: automationControlSchema,
      handler: async (input) => {
        const automation = context.services.automation;
        if (automation === undefined) return missingService();
        const request = mutationRequest(input);
        if (input.action === 'pause') return automation.pause(context.actor, request);
        if (input.action === 'resume') return automation.resume(context.actor, request);
        return automation.cancel(context.actor, {
          ...request,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        });
      },
    }),
    defineTool({
      name: 'automation_finalize',
      description: 'Finalize a fully verified durable automation run and confirm its root Goal reached terminal completion. This fails closed while native scheduled-task cleanup is pending.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: automationFinalizeSchema,
      handler: async (input) => {
        const automation = context.services.automation;
        if (automation === undefined) return missingService();
        return automation.finalize(context.actor, mutationRequest(input));
      },
    }),
  ];
}

function mutationRequest(input: {
  readonly workspaceId: string;
  readonly goalId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly userConfirmed?: boolean | undefined;
}): MutateAutomationRunRequest {
  return {
    workspaceId: input.workspaceId,
    goalId: input.goalId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    expectedRevision: input.expectedRevision,
    ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
  };
}
