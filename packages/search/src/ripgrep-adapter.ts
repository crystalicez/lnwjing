import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SEARCH_RESULTS, err, MAX_PROCESS_LOG_BYTES, MAX_SEARCH_RESULTS, ok, type AppError, type Result } from '@lnwjing/domain';
import { createProcessTreeTerminator, createSpawnInvocationFactory, PathExecutableResolver, type ExecutableResolver, type ProcessTreeTerminator, type SpawnInvocationFactory } from '@lnwjing/process';
import {
  classifyContextPath,
  DEFAULT_CONTEXT_IGNORE_GLOBS,
  type ContextDiscoveryMode,
} from './context-economy.js';
import { acquireRipgrep, recordRipgrepExecution } from './ripgrep-admission.js';
import { acquireDiskScanLease } from './ripgrep-disk-lease.js';

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  /** True when the caller intentionally stopped a streaming child after collecting enough evidence. */
  readonly stoppedEarly?: boolean;
  /** True when stdout could not be fully retained or one record exceeded the streaming bound. */
  readonly stdoutTruncated?: boolean;
  /** Output callback failed; no partial result may be reported as successful. */
  readonly observerFailed?: boolean;
}

export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Do not retain raw stdout when the observer already owns bounded result collection. */
  readonly captureStdout?: boolean;
  /** rg --files --null emits NUL-delimited paths, including names containing newlines. */
  readonly stdoutDelimiter?: '\n' | '\0';
  /**
   * Observe complete stdout lines while the child is running. Returning true
   * requests an orderly process-tree stop without classifying the result as a timeout.
   * This keeps high-volume tools such as ripgrep from flooding Electron's main loop.
   */
  readonly stopAfterStdoutLine?: (line: string) => boolean;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string, options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

export class DirectProcessRunner implements ProcessRunner {
  public constructor(
    private readonly terminator: ProcessTreeTerminator = createProcessTreeTerminator(),
    private readonly invocationFactory: SpawnInvocationFactory = createSpawnInvocationFactory(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public run(command: string, args: readonly string[], cwd: string, options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      const invocation = this.invocationFactory.create(command, args);
      if (!invocation.ok) {
        resolve({ exitCode: -1, stdout: '', stderr: invocation.error.message });
        return;
      }
      const child = spawn(invocation.value.executable, [...invocation.value.args], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: this.platform !== 'win32',
        ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutLinePending = '';
      const stdoutDecoder = new TextDecoder('utf-8');
      let stdoutTruncated = false;
      let observerFailed = false;
      let timedOut = false;
      let stoppedEarly = false;
      let settled = false;
      let terminationPending = false;
      let pendingExitCode: number | null = null;

      const appendBounded = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
        if (currentBytes >= MAX_PROCESS_LOG_BYTES) return currentBytes;
        const remaining = MAX_PROCESS_LOG_BYTES - currentBytes;
        const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        if (kept.length > 0) chunks.push(Buffer.from(kept));
        return currentBytes + kept.length;
      };
      const stdoutText = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderrText = (): string => Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      const complete = (exitCode: number): void => {
        if (terminationPending) {
          pendingExitCode = exitCode;
          return;
        }
        finish(exitCode);
      };
      const requestStop = (reason: 'timeout' | 'early'): void => {
        if (terminationPending || settled) return;
        if (reason === 'timeout') timedOut = true;
        else stoppedEarly = true;
        const pid = child.pid;
        if (pid === undefined) {
          finish(-1);
          return;
        }
        terminationPending = true;
        void this.terminator.stop(child, pid).then(() => {
          terminationPending = false;
          finish(pendingExitCode ?? -1);
        }).catch((error: unknown) => {
          terminationPending = false;
          const message = Buffer.from(error instanceof Error ? error.message : 'process termination could not be verified', 'utf8');
          stderrBytes = appendBounded(stderrChunks, stderrBytes, message);
          finish(-1);
        });
      };
      const abort = (): void => requestStop('timeout');
      const captureStdout = (chunk: Buffer): void => {
        const observer = options.stopAfterStdoutLine;
        if (observer === undefined) {
          if (stdoutBytes + chunk.byteLength > MAX_PROCESS_LOG_BYTES) stdoutTruncated = true;
          stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, chunk);
          return;
        }
        if (stoppedEarly || timedOut) return;
        stdoutLinePending += stdoutDecoder.decode(chunk, { stream: true });
        const delimiter = options.stdoutDelimiter ?? '\n';
        let separator: number;
        while ((separator = stdoutLinePending.indexOf(delimiter)) !== -1) {
          const record = stdoutLinePending.slice(0, separator);
          stdoutLinePending = stdoutLinePending.slice(separator + delimiter.length);
          const line = delimiter === '\n' && record.endsWith('\r') ? record.slice(0, -1) : record;
          if (options.captureStdout !== false) {
            const encoded = Buffer.from(`${record}${delimiter}`, 'utf8');
            if (stdoutBytes + encoded.byteLength > MAX_PROCESS_LOG_BYTES) {
              stdoutTruncated = true;
              requestStop('early');
              return;
            }
            stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, encoded);
          }
          try {
            if (observer(line)) {
              stdoutLinePending = '';
              requestStop('early');
              return;
            }
          } catch {
            observerFailed = true;
            requestStop('early');
            return;
          }
        }
        if (Buffer.byteLength(stdoutLinePending, 'utf8') > MAX_PROCESS_LOG_BYTES) {
          stdoutTruncated = true;
          requestStop('early');
        }
      };
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolve({
          exitCode,
          stdout: stdoutText(),
          stderr: stderrText(),
          ...(timedOut ? { timedOut: true } : {}),
          ...(stoppedEarly ? { stoppedEarly: true } : {}),
          ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(observerFailed ? { observerFailed: true } : {}),
        });
      };
      const timeoutMs = options.timeoutMs;
      const timer = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          requestStop('timeout');
        }, timeoutMs)
        : undefined;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        captureStdout(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, chunk);
      });
      child.on('error', (error: Error) => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, Buffer.from(error.message, 'utf8'));
        complete(-1);
      });
      child.on('close', (exitCode) => complete(exitCode ?? -1));
    });
  }
}

export interface SearchTextRequest {
  readonly rootPath: string;
  readonly targetPath?: string;
  readonly query: string;
  /** Literal/fixed-string search is the safe default. Set true only for intentional ripgrep regex syntax. */
  readonly regex?: boolean;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  /** Enforced before counting a result against maxResults. */
  readonly allowPath?: (path: string) => boolean;
  /** Globs applied by the host's access policy before rg reads file contents. */
  readonly excludeGlobs?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchTextResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

export interface SearchFilesRequest {
  readonly rootPath: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  /** Enforced before counting a result against maxResults. */
  readonly allowPath?: (path: string) => boolean;
  /** Globs applied by the host's access policy before rg reads file contents. */
  readonly excludeGlobs?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SearchFilesResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

const SEARCH_PROCESS_TIMEOUT_MS = 45_000;
/** Internal full-inventory ceiling. Pagination remains bounded by the MCP ContextEngine. */
const MAX_INVENTORY_RESULTS = 100_000;
const MAX_INVENTORY_PATH_BYTES = 16 * 1024 * 1024;

export class RipgrepAdapter {
  public constructor(
    private readonly resolver: ExecutableResolver = new PathExecutableResolver(),
    private readonly runner: ProcessRunner = new DirectProcessRunner(),
  ) {}

  public async searchText(request: SearchTextRequest): Promise<Result<SearchTextResult>> {
    const maxResults = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (request.query.length === 0 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search query or result limit is invalid', recoverable: false });
    }
    const admission = await acquireRipgrep(request.rootPath, request.signal);
    if (admission.status !== 'granted') return searchAdmissionError(admission.status);
    const diskLease = await acquireDiskScanLease(request.rootPath, request.signal);
    if (diskLease.status !== 'granted') {
      admission.release();
      return searchAdmissionError(diskLease.status);
    }
    const startedAt = performance.now();
    try {
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) return executable;
    const discovery = request.discovery ?? 'automatic';
    const args = ['--json', '--no-heading', '--color', 'never', '--hidden', '--threads', '2'];
    // Git ignore rules are not an authorization boundary. The context policy
    // still defers expensive generated/cache paths for automatic discovery.
    args.push('--no-ignore');
    // A directly requested file must not disappear because it exceeds 8 MiB.
    if (discovery === 'automatic' && request.targetPath === undefined) args.push('--max-filesize', '8M');
    if (request.regex !== true) args.push('--fixed-strings');
    // A later positive exception glob (such as .env.example) must not turn
    // the request into a whitelist of only that exception.
    if ((request.excludeGlobs?.length ?? 0) > 0) args.push('--glob', '**/*');
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    for (const glob of request.excludeGlobs ?? []) args.push('--glob', glob);
    // Keep the caller's glob last: an .env.example allow rule must not
    // turn a '*.ts' search into a search for only the exception.
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--', request.query, request.targetPath ?? '.');
    let observedMatches = 0;
    const streamedMatches: SearchMatch[] = [];
    const processResult = await this.runner.run(executable.value, args, request.rootPath, {
      timeoutMs: SEARCH_PROCESS_TIMEOUT_MS,
      captureStdout: false,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      stopAfterStdoutLine: (line) => {
        const match = this.parseMatch(line);
        if (match === null) return false;
        if (discovery === 'automatic' && !classifyContextPath(match.path, discovery).discoverable) return false;
        if (request.allowPath?.(match.path) === false) return false;
        observedMatches += 1;
        if (observedMatches <= maxResults) streamedMatches.push(match);
        return observedMatches > maxResults;
      },
    });
    if (processResult.observerFailed === true) return err({ code: 'INTERNAL_ERROR', message: 'Search output processing failed', recoverable: true });
    if (!processResult.timedOut && !processResult.stoppedEarly && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      return err(classifySearchError(processResult.exitCode, processResult.stderr));
    }
    const matches: SearchMatch[] = [...streamedMatches];
    let hasAdditionalMatch = observedMatches > maxResults;
    // Test adapters and legacy ProcessRunner implementations may return stdout
    // instead of invoking the streaming observer.
    for (const line of observedMatches > 0 ? [] : processResult.stdout.split(/\r?\n/)) {
      const match = this.parseMatch(line);
      if (match === null) continue;
      if (discovery === 'automatic' && !classifyContextPath(match.path, discovery).discoverable) continue;
      if (request.allowPath?.(match.path) === false) continue;
      if (matches.length >= maxResults) {
        hasAdditionalMatch = true;
        break;
      }
      matches.push(match);
    }
    return ok({ matches, truncated: processResult.timedOut === true || processResult.stoppedEarly === true || processResult.stdoutTruncated === true || hasAdditionalMatch });
    } finally {
      recordRipgrepExecution(performance.now() - startedAt);
      try { await diskLease.release(); } finally { admission.release(); }
    }
  }

  /** Internal bounded inventory used only by paginated workspace_full_scan. */
  public scanFiles(request: Omit<SearchFilesRequest, 'maxResults'>): Promise<Result<SearchFilesResult>> {
    return this.searchFilesBounded({ ...request, maxResults: MAX_INVENTORY_RESULTS }, MAX_INVENTORY_RESULTS);
  }

  public searchFiles(request: SearchFilesRequest): Promise<Result<SearchFilesResult>> {
    return this.searchFilesBounded(request, MAX_SEARCH_RESULTS);
  }

  private async searchFilesBounded(request: SearchFilesRequest, allowedLimit: number): Promise<Result<SearchFilesResult>> {
    const maxResults = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > allowedLimit) {
      return err({ code: 'INVALID_INPUT', message: 'Search result limit is invalid', recoverable: false });
    }
    const admission = await acquireRipgrep(request.rootPath, request.signal);
    if (admission.status !== 'granted') return searchAdmissionError(admission.status);
    const diskLease = await acquireDiskScanLease(request.rootPath, request.signal);
    if (diskLease.status !== 'granted') {
      admission.release();
      return searchAdmissionError(diskLease.status);
    }
    const startedAt = performance.now();
    try {
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) return executable;
    const discovery = request.discovery ?? 'automatic';
    const args = ['--files', '--hidden', '--null'];
    args.push('--no-ignore');
    // A later positive exception glob (such as .env.example) must not turn
    // the request into a whitelist of only that exception.
    if ((request.excludeGlobs?.length ?? 0) > 0) args.push('--glob', '**/*');
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    for (const glob of request.excludeGlobs ?? []) args.push('--glob', glob);
    // Keep the caller's glob last: an .env.example allow rule must not
    // turn a '*.ts' search into a search for only the exception.
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--');
    let observedPaths = 0;
    let retainedPathBytes = 0;
    let memoryLimitReached = false;
    const streamedPaths: string[] = [];
    const processResult = await this.runner.run(executable.value, args, request.rootPath, {
      timeoutMs: SEARCH_PROCESS_TIMEOUT_MS,
      captureStdout: false,
      stdoutDelimiter: '\0',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      stopAfterStdoutLine: (line) => {
        if (line.length === 0) return false;
        if (discovery === 'automatic' && !classifyContextPath(line, discovery).discoverable) return false;
        if (request.allowPath?.(line) === false) return false;
        observedPaths += 1;
        if (observedPaths > maxResults) return true;
        if (allowedLimit > MAX_SEARCH_RESULTS) {
          const pathBytes = Buffer.byteLength(line, 'utf8');
          if (retainedPathBytes + pathBytes > MAX_INVENTORY_PATH_BYTES) {
            memoryLimitReached = true;
            return true;
          }
          retainedPathBytes += pathBytes;
        }
        streamedPaths.push(line);
        return false;
      },
    });
    if (processResult.observerFailed === true) return err({ code: 'INTERNAL_ERROR', message: 'Search output processing failed', recoverable: true });
    if (!processResult.timedOut && !processResult.stoppedEarly && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      return err(classifySearchError(processResult.exitCode, processResult.stderr));
    }
    const discoveredPaths = observedPaths > 0 ? streamedPaths : processResult.stdout
      .split(/\0|\r?\n/)
      .filter((entry) => entry.length > 0)
      .filter((entry) => discovery === 'explicit' || classifyContextPath(entry, discovery).discoverable)
      .filter((entry) => request.allowPath?.(entry) !== false);
    const paths = discoveredPaths.slice(0, maxResults);
    return ok({ paths, truncated: processResult.timedOut === true || processResult.stoppedEarly === true || processResult.stdoutTruncated === true || observedPaths > maxResults || memoryLimitReached || discoveredPaths.length > maxResults });
    } finally {
      recordRipgrepExecution(performance.now() - startedAt);
      try { await diskLease.release(); } finally { admission.release(); }
    }
  }

  private parseMatch(line: string): SearchMatch | null {
    try {
      const value: unknown = JSON.parse(line);
      if (!this.isMatchRecord(value)) return null;
      return { path: value.data.path.text, line: value.data.line_number, text: value.data.lines.text.replace(/\r?\n$/, '') };
    } catch {
      return null;
    }
  }

  private appendDefaultGlobs(args: string[]): void {
    for (const glob of DEFAULT_CONTEXT_IGNORE_GLOBS) args.push('--glob', glob);
  }

  private isMatchRecord(value: unknown): value is MatchRecord {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'match' || !('data' in value)) return false;
    const data = value.data;
    if (typeof data !== 'object' || data === null || !('path' in data) || !('line_number' in data) || !('lines' in data)) return false;
    if (typeof data.path !== 'object' || data.path === null || !('text' in data.path) || typeof data.path.text !== 'string') return false;
    if (typeof data.line_number !== 'number' || typeof data.lines !== 'object' || data.lines === null || !('text' in data.lines) || typeof data.lines.text !== 'string') return false;
    return true;
  }
}

function searchAdmissionError(status: 'aborted' | 'busy'): Result<never> {
  return err({
    code: status === 'aborted' ? 'PROCESS_TIMEOUT' : 'CONFLICT',
    message: status === 'aborted' ? 'Search cancelled while awaiting capacity' : 'Search capacity is busy; retry shortly',
    recoverable: true,
  });
}

function classifySearchError(exitCode: number, stderr: string): AppError {
  if (isSearchPermissionError(stderr)) {
    const detail = boundedSearchError(stderr);
    return {
      code: 'PERMISSION_DENIED',
      message: detail.length === 0 ? 'Search permission denied' : `Search permission denied: ${detail}`,
      recoverable: true,
    };
  }
  if (exitCode === 2 && isSearchArgumentError(stderr)) {
    const argumentKind = searchArgumentKind(stderr);
    return {
      code: 'INVALID_INPUT',
      message: searchArgumentError(stderr),
      recoverable: true,
      details: {
        argumentKind,
        suggestedAction: argumentKind === 'regex' ? 'retry_as_literal_or_fix_regex' : 'fix_glob_and_retry',
      },
    };
  }
  return { code: 'INTERNAL_ERROR', message: searchProcessError(stderr), recoverable: true };
}

function isSearchPermissionError(stderr: string): boolean {
  return /(?:access (?:is )?denied|permission denied|\bEACCES\b|\bEPERM\b|\bos error (?:5|13)\b)/i.test(stderr);
}

function isSearchArgumentError(stderr: string): boolean {
  return /(?:regex|glob) parse error|error parsing (?:regex|glob)|invalid (?:regex|glob)|(?:regex|glob) syntax error/i.test(stderr);
}

function searchArgumentKind(stderr: string): 'regex' | 'glob' {
  return /glob/i.test(stderr) ? 'glob' : 'regex';
}

function searchArgumentError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search pattern or glob is invalid' : `Search pattern or glob is invalid: ${detail}`;
}

function searchProcessError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search process failed' : `Search process failed: ${detail}`;
}

function boundedSearchError(stderr: string): string {
  return stderr.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
}

interface MatchRecord {
  readonly type: 'match';
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}
