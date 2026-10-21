import { appError, err, ok, type Result } from '@lnwjing/domain';
import { mapError, type McpToolResponse } from './result-mapper.js';
import type { CheckedInvocationEnvelope, McpRegistryRuntimePort, RegistryPermissionPreview } from './registry-runtime-port.js';

const RECIPE_STEPS = {
  workspace_context: ['workspaceId', 'query'],
  git_context: ['workspaceId', 'query'],
  test_context: ['workspaceId', 'query'],
  live_logs_query: ['workspaceId'],
  review_context: ['workspaceId', 'query'],
  changed_symbols: ['workspaceId', 'query'],
  discover_tests: ['workspaceId', 'query'],
  debug_ui: ['tab_id'],
  console_context: ['tab_id'],
  network_context: ['tab_id'],
  capture_ui_state: ['tab_id'],
  regression_report: ['workspaceId'],
  benchmark_run: ['workspaceId'],
} satisfies Readonly<Record<string, readonly string[]>>;

type RecipeStep = keyof typeof RECIPE_STEPS;

interface Recipe {
  readonly name: string;
  readonly steps: readonly RecipeStep[];
  readonly optional: boolean;
}

const RECIPES: readonly Recipe[] = [
  { name: 'bugfix', steps: ['workspace_context', 'git_context', 'test_context', 'live_logs_query'], optional: false },
  { name: 'code-review', steps: ['review_context', 'changed_symbols', 'discover_tests'], optional: false },
  { name: 'frontend-debug', steps: ['debug_ui', 'console_context', 'network_context', 'capture_ui_state'], optional: true },
  { name: 'release-check', steps: ['git_context', 'regression_report', 'benchmark_run'], optional: false },
];

export function recipeCatalog(): readonly Recipe[] {
  return RECIPES;
}

export function describeRecipe(name: string): Result<Recipe> {
  const recipe = RECIPES.find((candidate) => candidate.name === name);
  return recipe === undefined ? err(appError('INVALID_INPUT', `Unknown recipe: ${name}`)) : ok(recipe);
}

interface PlannedStep {
  readonly tool: RecipeStep;
  readonly arguments: Record<string, unknown>;
}

type StepReceipt =
  | (PlannedStep & { readonly status: 'planned'; readonly permission: RegistryPermissionPreview })
  | (PlannedStep & { readonly status: 'completed' | 'failed' | 'unavailable' | 'cancelled'; readonly response: McpToolResponse })
  | (PlannedStep & { readonly status: 'skipped'; readonly reason: string });

export async function runRecipe(
  input: Record<string, unknown>,
  port: McpRegistryRuntimePort | undefined,
  signal?: AbortSignal,
  envelope?: CheckedInvocationEnvelope,
  cancellation?: { register(snapshot: () => unknown): void },
): Promise<Result<unknown>> {
  const name = typeof input.name === 'string' ? input.name : 'bugfix';
  const described = describeRecipe(name);
  if (!described.ok) return described;
  if (port === undefined) return err(appError('INTERNAL_ERROR', 'Checked recipe invocation is unavailable', true));
  const recipe = described.value;
  const stepArguments = isRecord(input.stepArguments) ? input.stepArguments : {};
  if (Object.keys(stepArguments).some((step) => !recipe.steps.some((allowed) => allowed === step))) {
    return err(appError('INVALID_INPUT', 'stepArguments contains a tool outside the selected canonical recipe'));
  }
  const query = typeof input.prompt === 'string' ? input.prompt : name;
  const plans: PlannedStep[] = [];
  for (const tool of recipe.steps) {
    const overrides = stepArguments[tool];
    if (overrides !== undefined && !isRecord(overrides)) return err(appError('INVALID_INPUT', `Arguments for ${tool} must be an object`));
    const specific = overrides ?? {};
    if (Object.keys(specific).some((key) => ['goalLease', 'engineeringTask', 'userConfirmed', 'authorization', 'metadata'].includes(key))) {
      return err(appError('INVALID_INPUT', `Arguments for ${tool} cannot contain an invocation authorization envelope`));
    }
    if (input.workspaceId !== undefined && specific.workspaceId !== undefined && specific.workspaceId !== input.workspaceId) {
      return err(appError('INVALID_INPUT', `Arguments for ${tool} conflict with the recipe workspace`));
    }
    if (input.tab_id !== undefined && specific.tab_id !== undefined && specific.tab_id !== input.tab_id) {
      return err(appError('INVALID_INPUT', `Arguments for ${tool} conflict with the recipe browser tab`));
    }
    const projected = Object.fromEntries(RECIPE_STEPS[tool].flatMap((field) => {
      const value = field === 'query' ? query : input[field];
      return value === undefined ? [] : [[field, value]];
    }));
    const arguments_ = {
      ...projected,
      ...(tool === 'benchmark_run' ? { dryRun: false } : {}),
      ...specific,
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    };
    const validated = port.validate(tool, arguments_);
    if (!validated.ok) return err(appError('INVALID_INPUT', `Invalid ${tool} recipe arguments: ${validated.error.message}`));
    plans.push({ tool, arguments: arguments_ });
  }
  const dryRun = input.dryRun !== false;
  const receipts: StepReceipt[] = [];
  if (dryRun) {
    for (const step of plans) {
      if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Recipe preview was cancelled', true));
      receipts.push({ ...step, status: 'planned', permission: await port.preview(step.tool, step.arguments, envelope) });
    }
    return ok({ tool: 'recipe_run', name, status: 'planned', dryRun: true, executed: false, sideEffectsStarted: false, steps: receipts });
  }
  let stopped: 'failed' | 'unavailable' | 'cancelled' | undefined;
  let sideEffectsStarted: boolean | 'unknown' = false;
  let activeStep: PlannedStep | undefined;
  cancellation?.register(() => ({
    tool: 'recipe_run', name, status: 'cancelled', dryRun: false,
    executed: activeStep !== undefined || receipts.some((receipt) => 'response' in receipt), sideEffectsStarted,
    steps: [
      ...receipts,
      ...(activeStep === undefined ? [] : [{ ...activeStep, status: 'cancellation_requested', reason: 'The child may still be finishing. Verify its task or process state before retrying.' }]),
      ...plans.slice(receipts.length + (activeStep === undefined ? 0 : 1)).map((step) => ({ ...step, status: 'skipped', reason: 'Recipe cancellation requested before this step started' })),
    ],
  }));
  for (const step of plans) {
    if (stopped !== undefined || signal?.aborted) {
      stopped ??= 'cancelled';
      receipts.push({ ...step, status: 'skipped', reason: `Recipe stopped after ${stopped}` });
      continue;
    }
    activeStep = step;
    if (step.tool === 'benchmark_run') sideEffectsStarted = 'unknown';
    let response: McpToolResponse;
    try {
      response = await port.invoke(step.tool, step.arguments, signal, envelope);
    } catch {
      response = mapError(appError('INTERNAL_ERROR', 'The checked child invocation failed before its outcome could be observed', true));
    }
    if (step.tool === 'benchmark_run' && response.structuredContent?.started === true) sideEffectsStarted = true;
    const status = response.isError === true
      ? signal?.aborted ? 'cancelled' : 'failed'
      : isUnavailable(response) ? 'unavailable' : 'completed';
    receipts.push({ ...step, status, response });
    activeStep = undefined;
    if (status !== 'completed') stopped = status;
  }
  return ok({
    tool: 'recipe_run', name, status: stopped ?? 'completed', dryRun: false,
    executed: receipts.some((receipt) => 'response' in receipt), sideEffectsStarted, steps: receipts,
  });
}

function isUnavailable(response: McpToolResponse): boolean {
  const value = response.structuredContent;
  return value?.available === false || value?.ready === false
    || ['needs_setup', 'disabled', 'unsupported', 'unavailable'].includes(typeof value?.status === 'string' ? value.status : '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
