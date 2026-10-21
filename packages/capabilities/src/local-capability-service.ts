import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import type { CapabilityService, CapabilityToolName } from './index.js';

export interface CapabilityBackend {
  execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>>;
  statusForAutomation?(
    ownerClientId: string,
    workspaceId: string,
    taskId: string,
    requestDigest: string,
  ): Promise<Result<unknown>>;
}

export interface LocalCapabilityBackends {
  readonly shell: CapabilityBackend;
  readonly domCdp: CapabilityBackend;
  readonly accessibility: CapabilityBackend;
  readonly inputEvent: CapabilityBackend;
  readonly vision: CapabilityBackend;
  readonly window: CapabilityBackend;
  readonly health: CapabilityBackend;
  readonly systemInfo?: CapabilityBackend;
  readonly notification?: CapabilityBackend;
  readonly fileDialog?: CapabilityBackend;
  readonly clipboard?: CapabilityBackend;
  readonly webFetch?: CapabilityBackend;
  readonly audio?: CapabilityBackend;
  readonly screenRecord?: CapabilityBackend;
  readonly office?: CapabilityBackend;
  readonly scheduler?: CapabilityBackend;
  readonly wslExec?: CapabilityBackend;
  readonly wslFs?: CapabilityBackend;
}

export class LocalCapabilityService implements CapabilityService {
  private closed = false;
  public constructor(private readonly backends: LocalCapabilityBackends) {}

  public close(): void { this.closed = true; }

  public execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.closed) return Promise.resolve(err(appError('CONFLICT', 'Capability runtime is closed')));
    if (signal?.aborted === true) {
      return Promise.resolve(err(appError('PROCESS_TIMEOUT', 'Capability operation was cancelled before dispatch', true)));
    }
    const backend = this.backendFor(tool);
    if (backend === undefined) return Promise.resolve(err(appError('INVALID_INPUT', 'Capability tool is not supported')));
    const dispatch = async (): Promise<Result<unknown>> => {
      if (this.closed) return err(appError('CONFLICT', 'Capability runtime is closed'));
      const result = await backend.execute(input, signal, authorization);
      return result.ok ? this.withPostcondition(tool, input, result, signal, authorization) : result;
    };
    return isForegroundNativeAction(tool, input) ? withForegroundLease(dispatch, signal) : dispatch();
  }

  public observeAutomationShell(
    ownerClientId: string,
    workspaceId: string,
    taskId: string,
    requestDigest: string,
  ): Promise<Result<unknown>> {
    const observe = this.backends.shell.statusForAutomation;
    return observe === undefined
      ? Promise.resolve(err(appError('INTERNAL_ERROR', 'Automation shell observation is unavailable', true)))
      : observe.call(this.backends.shell, ownerClientId, workspaceId, taskId, requestDigest);
  }

  private async withPostcondition(
    tool: CapabilityToolName,
    input: unknown,
    result: Result<unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    if ((tool !== 'accessibility' && tool !== 'input_event') || !isRecord(input) || !isRecord(input.postcondition)) return result;
    const parameters = isRecord(input.postcondition.parameters) ? input.postcondition.parameters : undefined;
    if (parameters === undefined || !('expected_value' in input.postcondition)) return result;
    const check = await this.backends.accessibility.execute({ action: 'read_value', parameters }, signal, authorization);
    if (!check.ok) return okWithPostcondition(result, false, input.postcondition.expected_value, undefined, 'check_failed');
    const observed = isRecord(check.value) ? check.value.value : undefined;
    return okWithPostcondition(result, Object.is(observed, input.postcondition.expected_value), input.postcondition.expected_value, observed);
  }

  private backendFor(tool: CapabilityToolName): CapabilityBackend | undefined {
    switch (tool) {
      case 'shell': return this.backends.shell;
      case 'dom_cdp': return this.backends.domCdp;
      case 'accessibility': return this.backends.accessibility;
      case 'input_event': return this.backends.inputEvent;
      case 'vision': return this.backends.vision;
      case 'window': return this.backends.window;
      case 'health': return this.backends.health;
      case 'system_info': return this.backends.systemInfo;
      case 'notification': return this.backends.notification;
      case 'file_dialog': return this.backends.fileDialog;
      case 'clipboard': return this.backends.clipboard;
      case 'web_fetch': return this.backends.webFetch;
      case 'audio': return this.backends.audio;
      case 'screen_record': return this.backends.screenRecord;
      case 'office': return this.backends.office;
      case 'scheduler': return this.backends.scheduler;
      case 'wsl_exec': return this.backends.wslExec;
      case 'wsl_fs': return this.backends.wslFs;
    }
  }
}

let foregroundTail: Promise<void> = Promise.resolve();

async function withForegroundLease(
  dispatch: () => Promise<Result<unknown>>,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  const previous = foregroundTail;
  let release!: () => void;
  foregroundTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Native foreground action was cancelled before dispatch', true));
    return await dispatch();
  } finally {
    release();
  }
}

function isForegroundNativeAction(tool: CapabilityToolName, input: unknown): boolean {
  if (tool === 'input_event' || tool === 'file_dialog') return true;
  if (!isRecord(input)) return false;
  const action = typeof input.action === 'string' ? input.action : typeof input.operation === 'string' ? input.operation : '';
  if (tool === 'accessibility') return !['status', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'read_value'].includes(action);
  if (tool === 'window') return !['list', 'get_active', 'get_bounds', 'get_display'].includes(action);
  return false;
}

function okWithPostcondition(
  result: Result<unknown>,
  verified: boolean,
  expectedValue: unknown,
  observedValue: unknown,
  reason?: string,
): Result<unknown> {
  if (!result.ok) return result;
  const value = isRecord(result.value) ? result.value : { result: result.value };
  return ok({
    ...value,
    postcondition: {
      verified,
      expected_value: expectedValue,
      ...(observedValue === undefined ? {} : { observed_value: observedValue }),
      ...(reason === undefined ? {} : { reason }),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
