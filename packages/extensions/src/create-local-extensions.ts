import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtensionsSettings } from './allowlist.js';
import { LocalExtensionsService } from './extensions-service.js';
import type { McpClientFactory } from './mcp-session-manager.js';
import type { ProcessTreeTerminator } from '@lnwjing/process';
import type { ExtensionsService } from './types.js';

export const EXTENSIONS_SETTINGS_KEY = 'extensions';

export interface CreateLocalExtensionsOptions {
  readonly settingsJson?: string | null;
  readonly settingsJsonProvider?: () => string | null | undefined;
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRootProvider?: () => Promise<string | undefined>;
  readonly bundledSkillRoots?: readonly string[];
  readonly clientFactory?: McpClientFactory;
  readonly processTreeTerminator?: ProcessTreeTerminator;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export function createLocalExtensionsService(options: CreateLocalExtensionsOptions = {}): ExtensionsService {
  return new LocalExtensionsService({
    settings: parseExtensionsSettings(options.settingsJson),
    ...(options.settingsJsonProvider === undefined ? {} : {
      settingsProvider: (): ReturnType<typeof parseExtensionsSettings> => parseExtensionsSettings(options.settingsJsonProvider?.()),
    }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.appDataDir === undefined ? {} : { appDataDir: options.appDataDir }),
    ...(options.workspaceRootProvider === undefined ? {} : { workspaceRootProvider: options.workspaceRootProvider }),
    bundledSkillRoots: options.bundledSkillRoots ?? bundledSkillRootCandidates(),
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    ...(options.processTreeTerminator === undefined ? {} : { processTreeTerminator: options.processTreeTerminator }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}

export function bundledSkillRootCandidates(
  resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
  executablePath = process.execPath,
): readonly string[] {
  const candidates = [
    typeof resourcesPath === 'string' && resourcesPath.trim().length > 0
      ? path.join(resourcesPath, 'agent-skills')
      : undefined,
    path.join(path.dirname(executablePath), 'resources', 'agent-skills'),
    ...repositoryBundledSkillRoots(),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

/** Dev runners use the checked-in bundle without treating workspace .agents as trusted. */
function repositoryBundledSkillRoots(): readonly string[] {
  // tsc emits packages/extensions/dist; Desktop esbuild emits apps/desktop/dist/main.
  // Packaged Electron does not have either candidate repository ancestor.
  // esbuild can compile the CLI to CommonJS, where import.meta.url is absent.
  // Never infer a trusted bundle from the mutable process working directory.
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:')) return [];
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return ['../../..', '../../../..'].flatMap((relative) => {
    const root = path.resolve(moduleDir, relative);
    const skillRoot = path.join(root, 'assets', 'bundled-skills');
    return existsSync(path.join(root, 'packages', 'extensions', 'package.json'))
      && existsSync(path.join(skillRoot, 'lnwjing-scheduled-continuation', 'SKILL.md'))
      ? [skillRoot] : [];
  });
}
