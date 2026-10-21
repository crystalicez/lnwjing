import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const execFileAsync = promisify(execFile);

export interface SchedulerRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SchedulerBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly runImpl?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<SchedulerRunResult>;
}

export class SchedulerCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  private readonly runImpl: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<SchedulerRunResult>;

  public constructor(options: SchedulerBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? 'schtasks.exe';
    this.runImpl = options.runImpl ?? (async (executable, args, signal): Promise<SchedulerRunResult> => {
      const result = await execFileAsync(executable, [...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) });
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' };
    });
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return err(appError('INTERNAL_ERROR', 'Scheduled tasks are unavailable on this platform', true));
    const parsed = parseRequest(input);
    if (!parsed.ok) return parsed;
    if (isSignalAborted(signal)) return cancelledOperation();
    const request = parsed.value;

    try {
      if (request.dryRun) {
        return ok({
          dry_run: true,
          action: request.action,
          ...(request.taskName.length === 0 ? {} : { task_name: request.taskName }),
          ...(request.action === 'create' ? {
            command: request.command,
            arguments: request.arguments,
            schedule: request.schedule,
            start_time: request.startTime,
          } : {}),
        });
      }
      if (request.action !== 'list' && !isApplicationAuthorized(authorization, request.userConfirmed)) {
        return err(appError(
          'PERMISSION_REQUIRED',
          'Creating, running, or deleting a scheduled task requires explicit user confirmation',
        ));
      }
      switch (request.action) {
        case 'list': return ok({ tasks: await this.list(signal) });
        case 'create': return ok(await this.create(request.taskName, request.command, request.arguments ?? [], request.schedule ?? 'DAILY', request.startTime ?? '09:00', signal));
        case 'delete': return ok(await this.delete(request.taskName, signal));
        case 'run': return ok(await this.run(request.taskName, signal));
      }
    } catch (error: unknown) {
      const detail = extractDetail(error);
      if (request.action !== 'list') {
        const reason = isSignalAborted(signal) || (error instanceof Error && error.name === 'AbortError')
          ? 'Scheduled task operation was cancelled or timed out after dispatch'
          : (detail.length > 0 ? detail : 'Scheduled task operation failed after dispatch');
        return uncertainMutationFailure(reason);
      }
      if (isSignalAborted(signal) || (error instanceof Error && error.name === 'AbortError')) return cancelledOperation();
      return err(appError('INTERNAL_ERROR', detail.length > 0 ? detail : 'Scheduled task operation failed', true));
    }
  }

  private async list(signal?: AbortSignal): Promise<readonly ScheduledTask[]> {
    const result = await this.runCommand(['/Query', '/FO', 'CSV', '/NH'], signal);
    const tasks: ScheduledTask[] = [];
    for (const line of result.stdout.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const fields = parseCsvRow(line);
      const [name, nextRunTime, status] = fields ?? [];
      if (fields?.length !== 3 || name === undefined || name.length === 0 || nextRunTime === undefined || status === undefined) {
        throw new Error('Scheduled task listing was not valid three-column CSV');
      }
      tasks.push({ name, next_run_time: nextRunTime, status });
    }
    return tasks;
  }

  private async create(taskName: string, command: string, args: readonly string[], schedule: string, startTime: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const taskRun = buildTaskRun(command, args);
    await this.runCommand([
      '/Create', '/TN', taskName, '/TR', taskRun,
      '/SC', schedule.toUpperCase(), '/ST', startTime,
    ], signal);
    return { created: true, task_name: taskName, schedule, start_time: startTime };
  }

  private async delete(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.runCommand(['/Delete', '/TN', taskName, '/F'], signal);
    return { deleted: true, task_name: taskName };
  }

  private async run(taskName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.runCommand(['/Run', '/TN', taskName], signal);
    return { started: true, task_name: taskName };
  }

  private runCommand(args: readonly string[], signal?: AbortSignal): Promise<SchedulerRunResult> {
    return signal === undefined
      ? this.runImpl(this.executable, args)
      : this.runImpl(this.executable, args, signal);
  }
}

function cancelledOperation(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Scheduled task operation was cancelled', true));
}

function uncertainMutationFailure(reason: string): Result<never> {
  return err(appError(
    'PROCESS_TIMEOUT',
    `${reason}. Scheduler mutation outcome may be unknown after dispatch; inspect the current task state before any manual retry. Do not retry automatically.`,
    true,
  ));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface SchedulerRequest {
  readonly action: 'list' | 'create' | 'delete' | 'run';
  readonly taskName: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly schedule: string;
  readonly startTime: string;
  readonly userConfirmed: boolean;
  readonly dryRun: boolean;
}

interface ScheduledTask {
  readonly name: string;
  readonly next_run_time: string;
  readonly status: string;
}

function parseRequest(value: unknown): Result<SchedulerRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'scheduler input must be an object'));
  const action: unknown = value.action === undefined ? 'list' : value.action;
  if (action !== 'list' && action !== 'create' && action !== 'delete' && action !== 'run') {
    return err(appError('INVALID_INPUT', 'scheduler action is invalid'));
  }
  const taskName: unknown = value.task_name === undefined ? '' : value.task_name;
  if (action !== 'list' && (typeof taskName !== 'string' || !isTaskPath(taskName))) {
    return err(appError('INVALID_INPUT', 'task_name must be a Windows task path of 1-238 characters with non-empty folder and task names; names cannot have leading/trailing spaces, reserved filename characters, or . and .. path segments'));
  }
  const command: unknown = value.command === undefined ? '' : value.command;
  if (action === 'create' && (typeof command !== 'string' || command.trim().length === 0 || command.length > 2_048)) {
    return err(appError('INVALID_INPUT', 'command is required (at most 2048 characters)'));
  }
  const argumentsValue: unknown = value.arguments === undefined ? [] : value.arguments;
  if (action === 'create' && (!Array.isArray(argumentsValue) || argumentsValue.length > 64 || !argumentsValue.every((entry) => typeof entry === 'string' && entry.length <= 2_048))) {
    return err(appError('INVALID_INPUT', 'arguments must be at most 64 strings'));
  }
  const schedule: unknown = value.schedule === undefined ? 'DAILY' : value.schedule;
  if (action === 'create' && (typeof schedule !== 'string' || !/^[A-Z]{1,16}$/.test(schedule.toUpperCase()))) {
    return err(appError('INVALID_INPUT', 'schedule must be a short uppercase schedule name (e.g. DAILY)'));
  }
  const startTime: unknown = value.start_time === undefined ? '09:00' : value.start_time;
  if (action === 'create' && (typeof startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))) {
    return err(appError('INVALID_INPUT', 'start_time must be HH:MM'));
  }
  const userConfirmed = value.userConfirmed === true;
  const dryRun = value.dry_run === true;
  return ok({
    action,
    taskName: typeof taskName === 'string' ? taskName : '',
    command: typeof command === 'string' ? command.trim() : '',
    arguments: action === 'create' && Array.isArray(argumentsValue) ? argumentsValue.filter((entry): entry is string => typeof entry === 'string') : [],
    schedule: typeof schedule === 'string' ? schedule.toUpperCase() : 'DAILY',
    startTime: typeof startTime === 'string' ? startTime : '09:00',
    userConfirmed,
    dryRun,
  });
}

function buildTaskRun(command: string, args: readonly string[]): string {
  return [command, ...args].map((entry) => {
    if (entry.length > 0 && !/[\s"]/.test(entry)) return entry;
    const escaped = entry.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
    return `"${escaped}"`;
  }).join(' ');
}

function isTaskPath(value: string): boolean {
  if (value.length === 0 || value.length > 238 || /[/:*?"<>|]/.test(value)) return false;
  if ([...value].some((character): boolean => character.charCodeAt(0) < 32)) return false;
  const path = value.startsWith('\\') ? value.slice(1) : value;
  return path.split('\\').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith(' ') && !part.endsWith(' '));
}

function parseCsvRow(line: string): readonly string[] | null {
  const fields: string[] = [];
  let field = '';
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (state === 'quoted') {
      if (character !== '"') field += character;
      else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else state = 'closed';
    } else if (character === ',') {
      fields.push(field);
      field = '';
      state = 'start';
    } else if (state === 'start' && character === '"') state = 'quoted';
    else if (state === 'closed' || character === '"') return null;
    else {
      field += character;
      state = 'unquoted';
    }
  }
  if (state === 'quoted') return null;
  fields.push(field);
  return fields;
}

function extractDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stderr.length > 0) return stderr.slice(0, 500);
  return typeof record.message === 'string' ? record.message.slice(0, 500) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
