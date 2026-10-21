import { appError, err, ok, type Result } from '@lnwjing/domain';

export type CodexInstructionMode = 'exec-argument' | 'prompt-option' | 'positional-argument';

export interface CodexCapabilities {
  readonly instructionMode: CodexInstructionMode | null;
  readonly names: readonly string[];
}

export interface CodexStatus {
  readonly installed: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly capabilities: readonly string[];
}

export interface CodexDiscoveryResult {
  readonly status: CodexStatus;
  readonly capabilities: CodexCapabilities;
}

export interface CodexInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export type CodexSandboxMode = 'read-only' | 'workspace-write';

export class CodexInvocationBuilder {
  public build(executable: string, capabilities: CodexCapabilities, instruction: string, sandboxMode: CodexSandboxMode = 'workspace-write'): Result<CodexInvocation> {
    if (executable.trim().length === 0 || instruction.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Codex executable and instruction are required'));
    }
    if (capabilities.instructionMode === null) {
      return err(appError('CODEX_NOT_AVAILABLE', 'Codex instruction invocation is not supported', true));
    }
    if (!capabilities.names.includes('sandbox') || !capabilities.names.includes(sandboxMode)) {
      return err(appError('CODEX_NOT_AVAILABLE', `Codex ${sandboxMode} sandbox support was not verified`, true));
    }
    const sandboxArgs = ['--sandbox', sandboxMode];
    const args = capabilities.instructionMode === 'exec-argument'
      ? ['exec', ...sandboxArgs, instruction]
      : capabilities.instructionMode === 'prompt-option'
        ? [...sandboxArgs, '--prompt', instruction]
        : [...sandboxArgs, instruction];
    return ok({ executable, args });
  }
}

export function capabilitiesFromHelp(helpText: string): CodexCapabilities {
  const names: string[] = [];
  if (/\bexec\b/i.test(helpText)) names.push('exec');
  if (/--prompt\b|--instruction\b/i.test(helpText)) names.push('prompt-argument');
  if (/\bprompt\b.*<[^>]+>/i.test(helpText) && !names.includes('prompt-argument')) names.push('positional-instruction');
  if (/--sandbox\b/i.test(helpText)) names.push('sandbox');
  if (/\bread-only\b/i.test(helpText)) names.push('read-only');
  if (/\bworkspace-write\b/i.test(helpText)) names.push('workspace-write');
  const instructionMode = names.includes('exec')
    ? 'exec-argument'
    : names.includes('prompt-argument')
      ? 'prompt-option'
      : names.includes('positional-instruction')
        ? 'positional-argument'
        : null;
  return { instructionMode, names };
}
