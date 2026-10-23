import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createMcpServer, type McpServerOptions } from './server.js';
import { createMcpContinuationState } from './tool-registry.js';
import { ModernTasksProtocol } from './modern-tasks-protocol.js';
import { createModernTasksTransport } from './modern-tasks-transport.js';
import { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard } from './run-budget.js';
import { PonytailActivationLedger } from './ponytail-runtime.js';
import { createStdioRequestScope } from './request-scope.js';

export interface McpStdioOptions extends McpServerOptions {
  readonly onError?: (error: Error) => void;
  /** Optional duplex carrier for GUI-subsystem processes without usable stdin/stdout. */
  readonly stdioInput?: Readable;
  readonly stdioOutput?: Writable;
}

export function isBenignStdioPipeError(error: Error): boolean {
  return /EPIPE|ECONNRESET|broken pipe/i.test(error.message);
}

function writeStdioDiagnostic(error: Error): void {
  if (isBenignStdioPipeError(error)) {
    process.stderr.write(`lnwjing MCP stdio: peer closed (${error.message})\n`);
    return;
  }
  process.stderr.write(`lnwjing MCP stdio error: ${error.message}\n`);
}

export function startMcpStdio(options: McpStdioOptions): StdioServerHandle {
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
  const setOfMarksStore = options.setOfMarksStore ?? new SetOfMarksObservationStore();
  const ponytailActivationLedger = options.ponytailActivationLedger ?? new PonytailActivationLedger();
  const continuationState = options.continuationState ?? createMcpContinuationState();
  const requestScope = options.requestScope ?? createStdioRequestScope();
  const modernTasks = new ModernTasksProtocol(options.services, { actor: options.actor });
  const transport = createModernTasksTransport(new StdioServerTransport(options.stdioInput, options.stdioOutput), modernTasks);
  return serveStdio(
    () => createMcpServer({ ...options, runBudgetGuard, incrementalVerifier, setOfMarksStore, ponytailActivationLedger, continuationState, legacyTasksProtocol: false, requestScope }),
    { legacy: 'reject', onerror: options.onError ?? writeStdioDiagnostic, transport },
  );
}
