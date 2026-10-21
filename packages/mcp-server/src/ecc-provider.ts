import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 32 * 1024;

export const ECC_PACKAGE_NAME = 'ecc-universal';
export const ECC_PROVIDER_SCHEMA_VERSION = 1;

export type EccArtifactKind =
  | 'agent'
  | 'skill'
  | 'command'
  | 'rule'
  | 'hook'
  | 'workflow'
  | 'mcp_template'
  | 'instinct'
  | 'resource';

export interface EccRuntimeOptions {
  readonly rootPath?: string;
  readonly expectedVersion?: string;
  readonly agentShieldBundlePath?: string;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

export interface EccArtifactDescriptor {
  readonly id: string;
  readonly provider: 'ecc';
  readonly kind: EccArtifactKind;
  readonly relativePath: string;
  readonly title: string;
  readonly description?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly trust: 'upstream_pinned';
  readonly activation: 'selective' | 'disabled';
  readonly compatibility: 'native_context' | 'legacy_shim' | 'descriptor_only' | 'disabled_template' | 'advisory';
  readonly ruleLayer?: string;
}

export interface EccProviderInventory {
  readonly schemaVersion: 1;
  readonly provider: 'ecc';
  readonly available: boolean;
  readonly ready: boolean;
  readonly rootPath: string | null;
  readonly packageName: string | null;
  readonly version: string | null;
  readonly expectedVersion: string | null;
  readonly versionMatchesExpectation: boolean;
  readonly license: string | null;
  readonly packageFingerprint: string | null;
  readonly scannedFiles: number;
  readonly skippedSymlinks: number;
  readonly skippedOversizeFiles: number;
  readonly counts: Readonly<Record<EccArtifactKind, number>>;
  readonly artifacts: readonly EccArtifactDescriptor[];
  readonly agentShieldBundlePath: string | null;
  readonly agentShieldBundled: boolean;
  readonly error?: string;
}

export interface EccCatalogQuery {
  readonly kind?: EccArtifactKind;
  readonly query?: string;
  readonly limit?: number;
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
}

interface ScanCounters {
  scannedFiles: number;
  skippedSymlinks: number;
  skippedOversizeFiles: number;
}

export class EccProviderService {
  private inventoryPromise: Promise<EccProviderInventory> | undefined;

  public constructor(private readonly options: EccRuntimeOptions = {}) {}

  public async status(): Promise<Omit<EccProviderInventory, 'artifacts'>> {
    const inventory = await this.inventory();
    const { artifacts, ...status } = inventory;
    void artifacts;
    return status;
  }

  public async catalog(query: EccCatalogQuery = {}): Promise<{
    readonly provider: 'ecc';
    readonly total: number;
    readonly returned: number;
    readonly truncated: boolean;
    readonly artifacts: readonly EccArtifactDescriptor[];
  }> {
    const inventory = await this.inventory();
    if (!inventory.ready) {
      return { provider: 'ecc', total: 0, returned: 0, truncated: false, artifacts: [] };
    }
    const needle = query.query?.trim().toLowerCase();
    const matches = inventory.artifacts.filter((artifact) => {
      if (query.kind !== undefined && artifact.kind !== query.kind) return false;
      if (needle === undefined || needle.length === 0) return true;
      return artifact.id.toLowerCase().includes(needle)
        || artifact.title.toLowerCase().includes(needle)
        || artifact.relativePath.toLowerCase().includes(needle)
        || artifact.description?.toLowerCase().includes(needle) === true;
    });
    const limit = boundedInteger(query.limit, 100, 1, 500);
    return {
      provider: 'ecc',
      total: matches.length,
      returned: Math.min(limit, matches.length),
      truncated: matches.length > limit,
      artifacts: matches.slice(0, limit),
    };
  }

  public async artifact(id: string): Promise<EccArtifactDescriptor | undefined> {
    const inventory = await this.inventory();
    return inventory.artifacts.find((artifact) => artifact.id === id);
  }

  public async loadTextArtifact(id: string): Promise<{ readonly artifact: EccArtifactDescriptor; readonly content: string } | undefined> {
    const inventory = await this.inventory();
    const artifact = inventory.artifacts.find((candidate) => candidate.id === id);
    return this.loadVerifiedTextArtifact(inventory, artifact);
  }

  public async loadRelativeTextArtifact(
    id: string,
    relativePath: string,
  ): Promise<{ readonly artifact: EccArtifactDescriptor; readonly content: string } | undefined> {
    const inventory = await this.inventory();
    const owner = inventory.artifacts.find((candidate) => candidate.id === id);
    if (owner === undefined || inventory.rootPath === null) return undefined;
    const requested = relativePath.trim();
    if (requested.length === 0 || requested.includes('\0') || path.isAbsolute(requested)) return undefined;
    const ownerDirectory = path.posix.dirname(owner.relativePath);
    const targetRelativePath = path.posix.normalize(path.posix.join(ownerDirectory, requested.replaceAll('\\', '/')));
    if (targetRelativePath.startsWith('../') || targetRelativePath === '..') return undefined;
    const artifact = inventory.artifacts.find((candidate) => candidate.relativePath === targetRelativePath);
    return this.loadVerifiedTextArtifact(inventory, artifact);
  }

  public invalidate(): void {
    this.inventoryPromise = undefined;
  }

  private async loadVerifiedTextArtifact(
    inventory: EccProviderInventory,
    artifact: EccArtifactDescriptor | undefined,
  ): Promise<{ readonly artifact: EccArtifactDescriptor; readonly content: string } | undefined> {
    if (artifact === undefined || inventory.rootPath === null || !isTextArtifact(artifact.relativePath)) return undefined;
    const candidatePath = path.join(inventory.rootPath, ...artifact.relativePath.split('/'));
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(candidatePath);
    } catch {
      return undefined;
    }
    if (resolvedPath !== inventory.rootPath && !resolvedPath.startsWith(`${inventory.rootPath}${path.sep}`)) return undefined;
    const payload = await readFile(resolvedPath);
    if (payload.byteLength !== artifact.bytes || createHash('sha256').update(payload).digest('hex') !== artifact.sha256) return undefined;
    return { artifact, content: payload.toString('utf8') };
  }

  private inventory(): Promise<EccProviderInventory> {
    this.inventoryPromise ??= this.loadInventory();
    return this.inventoryPromise;
  }

  private async loadInventory(): Promise<EccProviderInventory> {
    const configuredRoot = this.options.rootPath?.trim();
    if (configuredRoot === undefined || configuredRoot.length === 0) {
      return unavailableInventory(this.options, 'ECC runtime resource root is not configured');
    }

    let rootPath: string;
    try {
      rootPath = await realpath(configuredRoot);
      const details = await stat(rootPath);
      if (!details.isDirectory()) return unavailableInventory(this.options, 'ECC runtime resource root is not a directory', rootPath);
    } catch {
      return unavailableInventory(this.options, 'ECC runtime resource root is unavailable', configuredRoot);
    }

    let packageMetadata: PackageMetadata;
    try {
      const packagePath = path.join(rootPath, 'package.json');
      const packageDetails = await stat(packagePath);
      if (!packageDetails.isFile() || packageDetails.size > MAX_PACKAGE_JSON_BYTES) {
        return unavailableInventory(this.options, 'ECC package metadata is missing or oversized', rootPath);
      }
      const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
      if (!isRecord(parsed)) return unavailableInventory(this.options, 'ECC package metadata is not a JSON object', rootPath);
      packageMetadata = parsed;
    } catch {
      return unavailableInventory(this.options, 'ECC package metadata could not be read', rootPath);
    }

    const packageName = typeof packageMetadata.name === 'string' ? packageMetadata.name : null;
    const version = typeof packageMetadata.version === 'string' ? packageMetadata.version : null;
    const license = typeof packageMetadata.license === 'string' ? packageMetadata.license : null;
    if (packageName !== ECC_PACKAGE_NAME || version === null) {
      return unavailableInventory(this.options, 'Configured ECC resource root does not contain a valid ecc-universal package', rootPath, packageName, version, license);
    }

    const expectedVersion = this.options.expectedVersion?.trim() || null;
    const versionMatchesExpectation = expectedVersion === null || expectedVersion === version;
    if (!versionMatchesExpectation) {
      return unavailableInventory(this.options, 'Configured ECC package version does not match the pinned lnwjing expectation', rootPath, packageName, version, license);
    }

    const counters: ScanCounters = { scannedFiles: 0, skippedSymlinks: 0, skippedOversizeFiles: 0 };
    const artifacts: EccArtifactDescriptor[] = [];
    const maxFiles = boundedInteger(this.options.maxFiles, DEFAULT_MAX_FILES, 1, 100_000);
    const maxFileBytes = boundedInteger(this.options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 32 * 1024 * 1024);

    try {
      await scanDirectory(rootPath, rootPath, artifacts, counters, maxFiles, maxFileBytes);
    } catch (error: unknown) {
      return unavailableInventory(
        this.options,
        error instanceof Error ? `ECC resource scan failed: ${error.message}` : 'ECC resource scan failed',
        rootPath,
        packageName,
        version,
        license,
      );
    }

    artifacts.sort((left, right) => left.id.localeCompare(right.id));
    const fingerprint = createHash('sha256');
    for (const artifact of artifacts) {
      fingerprint.update(artifact.relativePath);
      fingerprint.update('\0');
      fingerprint.update(String(artifact.bytes));
      fingerprint.update('\0');
      fingerprint.update(artifact.sha256);
      fingerprint.update('\n');
    }

    const counts = emptyCounts();
    for (const artifact of artifacts) counts[artifact.kind] += 1;

    const agentShieldBundlePath = this.options.agentShieldBundlePath?.trim() || null;
    const agentShieldBundled = agentShieldBundlePath === null ? false : await isRegularFile(agentShieldBundlePath);

    return {
      schemaVersion: ECC_PROVIDER_SCHEMA_VERSION,
      provider: 'ecc',
      available: true,
      ready: true,
      rootPath,
      packageName,
      version,
      expectedVersion,
      versionMatchesExpectation,
      license,
      packageFingerprint: fingerprint.digest('hex'),
      scannedFiles: counters.scannedFiles,
      skippedSymlinks: counters.skippedSymlinks,
      skippedOversizeFiles: counters.skippedOversizeFiles,
      counts,
      artifacts,
      agentShieldBundlePath,
      agentShieldBundled,
    };
  }
}

async function scanDirectory(
  rootPath: string,
  directory: string,
  artifacts: EccArtifactDescriptor[],
  counters: ScanCounters,
  maxFiles: number,
  maxFileBytes: number,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const entryDetails = await lstat(absolutePath);
    if (entryDetails.isSymbolicLink()) {
      counters.skippedSymlinks += 1;
      continue;
    }
    if (entryDetails.isDirectory()) {
      await scanDirectory(rootPath, absolutePath, artifacts, counters, maxFiles, maxFileBytes);
      continue;
    }
    if (!entryDetails.isFile()) continue;
    counters.scannedFiles += 1;
    if (counters.scannedFiles > maxFiles) throw new Error(`file limit exceeded (${maxFiles})`);
    if (entryDetails.size > maxFileBytes) {
      counters.skippedOversizeFiles += 1;
      continue;
    }

    const relativePath = path.relative(rootPath, absolutePath).replaceAll(path.sep, '/');
    if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) throw new Error('resource escaped the configured root');

    const payload = await readFile(absolutePath);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const kind = classifyArtifact(relativePath);
    const preview = isTextArtifact(relativePath)
      ? payload.subarray(0, Math.min(payload.byteLength, MAX_TEXT_PREVIEW_BYTES)).toString('utf8')
      : '';
    const metadata = parseTextMetadata(preview, relativePath);
    const ruleLayer = kind === 'rule' ? relativePath.split('/')[1] : undefined;
    artifacts.push({
      id: `ecc:${kind}:${relativePath}`,
      provider: 'ecc',
      kind,
      relativePath,
      title: metadata.title,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      bytes: entryDetails.size,
      sha256,
      trust: 'upstream_pinned',
      activation: kind === 'hook' || kind === 'workflow' || kind === 'mcp_template' ? 'disabled' : 'selective',
      compatibility: compatibilityForKind(kind),
      ...(ruleLayer === undefined ? {} : { ruleLayer }),
    });
  }
}

function classifyArtifact(relativePath: string): EccArtifactKind {
  const normalized = relativePath.toLowerCase();
  if (normalized.startsWith('agents/') && normalized.endsWith('.md')) return 'agent';
  if (normalized.startsWith('skills/') && normalized.endsWith('/skill.md')) return 'skill';
  if (normalized.startsWith('commands/') && normalized.endsWith('.md')) return 'command';
  if (normalized.startsWith('rules/') && normalized.endsWith('.md')) return 'rule';
  if (normalized.startsWith('hooks/')) return 'hook';
  if (normalized.startsWith('workflows/')) return 'workflow';
  if (normalized.startsWith('mcp-configs/') || normalized === '.mcp.json') return 'mcp_template';
  if (normalized.includes('/instinct') || normalized.startsWith('instincts/')) return 'instinct';
  return 'resource';
}

function compatibilityForKind(kind: EccArtifactKind): EccArtifactDescriptor['compatibility'] {
  if (kind === 'command') return 'legacy_shim';
  if (kind === 'hook' || kind === 'workflow') return 'descriptor_only';
  if (kind === 'mcp_template') return 'disabled_template';
  if (kind === 'instinct') return 'advisory';
  return 'native_context';
}

function parseTextMetadata(content: string, relativePath: string): { readonly title: string; readonly description?: string } {
  const fallbackTitle = path.posix.basename(relativePath).replace(/\.(md|json|ya?ml|mjs|cjs|js|ts)$/i, '');
  const normalized = content.replace(/^\uFEFF/, '');
  let frontmatter = '';
  if (normalized.startsWith('---\n') || normalized.startsWith('---\r\n')) {
    const end = normalized.indexOf('\n---', 4);
    if (end > 0) frontmatter = normalized.slice(4, end);
  }
  const name = frontmatter.match(/^name:\s*['"]?([^\r\n'"]+)['"]?\s*$/im)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*['"]?([^\r\n'"]+)['"]?\s*$/im)?.[1]?.trim()
    ?? normalized.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    title: boundedText(name ?? fallbackTitle, 256),
    ...(description === undefined || description.length === 0 ? {} : { description: boundedText(description, 1024) }),
  };
}

function isTextArtifact(relativePath: string): boolean {
  return /\.(?:md|txt|json|ya?ml|mjs|cjs|js|ts|sh|ps1)$/i.test(relativePath);
}

function boundedText(value: string, maxLength: number): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function emptyCounts(): Record<EccArtifactKind, number> {
  return {
    agent: 0,
    skill: 0,
    command: 0,
    rule: 0,
    hook: 0,
    workflow: 0,
    mcp_template: 0,
    instinct: 0,
    resource: 0,
  };
}

function unavailableInventory(
  options: EccRuntimeOptions,
  error: string,
  rootPath: string | null = options.rootPath?.trim() || null,
  packageName: string | null = null,
  version: string | null = null,
  license: string | null = null,
): EccProviderInventory {
  return {
    schemaVersion: ECC_PROVIDER_SCHEMA_VERSION,
    provider: 'ecc',
    available: false,
    ready: false,
    rootPath,
    packageName,
    version,
    expectedVersion: options.expectedVersion?.trim() || null,
    versionMatchesExpectation: false,
    license,
    packageFingerprint: null,
    scannedFiles: 0,
    skippedSymlinks: 0,
    skippedOversizeFiles: 0,
    counts: emptyCounts(),
    artifacts: [],
    agentShieldBundlePath: options.agentShieldBundlePath?.trim() || null,
    agentShieldBundled: false,
    error,
  };
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
