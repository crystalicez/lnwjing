import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'ecc.memory.v1';
const PROJECT_GITIGNORE = 'project/\n';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENTS = 2_000;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export type EccMemoryScope = 'project' | 'team' | 'user';
export type EccMemoryKind = 'context' | 'decision' | 'fact' | 'handoff' | 'lesson' | 'note' | 'preference' | 'runbook';

export interface EccMemoryDocument {
  readonly schema: 'ecc.memory.v1';
  readonly id: string;
  readonly title: string;
  readonly kind: EccMemoryKind;
  readonly scope: EccMemoryScope;
  readonly trust: 'unreviewed';
  readonly status: 'active' | 'superseded' | 'archived';
  readonly source_harness: string;
  readonly target_harnesses: readonly string[];
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly body: string;
  readonly relativePath: string;
}

export interface EccMemoryVaultOptions {
  readonly userRoot?: string;
  readonly now?: () => Date;
}

export class EccMemoryVaultService {
  private readonly userRoot: string;
  private readonly now: () => Date;

  public constructor(options: EccMemoryVaultOptions = {}) {
    this.userRoot = options.userRoot ?? path.join(os.homedir(), '.ecc', 'memory');
    this.now = options.now ?? ((): Date => new Date());
  }

  public async save(input: {
    readonly workspaceRoot?: string;
    readonly scope: EccMemoryScope;
    readonly title: string;
    readonly body: string;
    readonly kind?: EccMemoryKind;
    readonly sourceHarness?: string;
    readonly targetHarnesses?: readonly string[];
    readonly tags?: readonly string[];
    readonly links?: readonly string[];
    readonly userScopeEnabled?: boolean;
  }): Promise<Omit<EccMemoryDocument, 'body'>> {
    const scope = input.scope;
    if (scope === 'user' && input.userScopeEnabled !== true) throw new Error('ECC user memory scope is disabled');
    const workspaceRoot = await this.requireWorkspaceRoot(input.workspaceRoot, scope);
    const title = input.title.trim();
    if (title.length === 0 || title.length > 512) throw new Error('ECC memory title must be 1-512 characters');
    const body = sanitizeBody(input.body);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('ECC memory body exceeds 128 KiB');
    rejectSecrets(`${title}\n${body}`);
    const kind = input.kind ?? 'note';
    const sourceHarness = normalizeSlug(input.sourceHarness ?? 'lnwjing', 'source harness');
    const targetHarnesses = normalizeSlugArray(input.targetHarnesses ?? ['all'], 'target harness');
    const tags = normalizeSlugArray(input.tags ?? [], 'tag');
    const links = normalizeMemoryLinks(input.links ?? []);
    const root = await this.scopeRoot(scope, workspaceRoot, true);
    const kindDirectory = path.join(root, `${kind}s`);
    await ensureSafeDirectory(root, kindDirectory);
    const now = this.now().toISOString();
    const id = `mem_${this.now().getTime().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const document: EccMemoryDocument = {
      schema: SCHEMA,
      id,
      title,
      kind,
      scope,
      trust: 'unreviewed',
      status: 'active',
      source_harness: sourceHarness,
      target_harnesses: targetHarnesses,
      tags,
      links,
      created_at: now,
      updated_at: now,
      body,
      relativePath: `${kind}s/${id}.md`,
    };
    const filePath = path.join(kindDirectory, `${id}.md`);
    const handle = await open(filePath, 'wx');
    try {
      await handle.writeFile(serializeDocument(document), 'utf8');
    } finally {
      await handle.close();
    }
    const { body: omittedBody, ...metadata } = document;
    void omittedBody;
    return metadata;
  }

  public async search(input: {
    readonly workspaceRoot?: string;
    readonly query: string;
    readonly scopes?: readonly EccMemoryScope[];
    readonly targetHarness?: string;
    readonly userScopeEnabled?: boolean;
    readonly limit?: number;
  }): Promise<{ readonly memories: readonly Omit<EccMemoryDocument, 'body'>[]; readonly diagnostics: readonly string[] }> {
    const query = input.query.trim().toLowerCase();
    if (query.length === 0) throw new Error('ECC memory search query is required');
    const scopes = input.scopes ?? ['project', 'team'];
    if (scopes.includes('user') && input.userScopeEnabled !== true) throw new Error('ECC user memory scope is disabled');
    const targetHarness = input.targetHarness === undefined ? undefined : normalizeSlug(input.targetHarness, 'target harness');
    const scan = await this.scanScopes(input.workspaceRoot, scopes, input.userScopeEnabled === true);
    const terms = query.split(/\s+/).filter(Boolean);
    const ranked = scan.documents
      .filter((memory) => memory.status === 'active')
      .filter((memory) => targetHarness === undefined || memory.target_harnesses.includes('all') || memory.target_harnesses.includes(targetHarness))
      .map((memory) => ({ memory, score: lexicalScore(memory, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updated_at.localeCompare(left.memory.updated_at) || left.memory.id.localeCompare(right.memory.id));
    const limit = boundedInteger(input.limit, 20, 1, 100);
    return {
      memories: ranked.slice(0, limit).map(({ memory }) => {
        const { body, ...metadata } = memory;
        void body;
        return metadata;
      }),
      diagnostics: scan.issues,
    };
  }

  public async read(input: {
    readonly workspaceRoot?: string;
    readonly id: string;
    readonly scopes?: readonly EccMemoryScope[];
    readonly userScopeEnabled?: boolean;
  }): Promise<EccMemoryDocument> {
    const id = normalizeSlug(input.id, 'memory id');
    if (!id.startsWith('mem_')) throw new Error('ECC memory id must start with mem_');
    const scopes = input.scopes ?? ['project', 'team'];
    if (scopes.includes('user') && input.userScopeEnabled !== true) throw new Error('ECC user memory scope is disabled');
    const scan = await this.scanScopes(input.workspaceRoot, scopes, input.userScopeEnabled === true);
    if (scan.issues.length > 0) throw new Error(`ECC memory vault is incomplete: ${scan.issues[0]}`);
    const matches = scan.documents.filter((memory) => memory.id === id);
    if (matches.length === 0) throw new Error(`ECC memory not found: ${id}`);
    if (matches.length > 1) throw new Error(`Duplicate ECC memory id: ${id}`);
    return matches[0]!;
  }

  public async doctor(input: {
    readonly workspaceRoot?: string;
    readonly scopes?: readonly EccMemoryScope[];
    readonly userScopeEnabled?: boolean;
  }): Promise<{ readonly healthy: boolean; readonly documents: number; readonly issues: readonly string[] }> {
    const scopes = input.scopes ?? ['project', 'team'];
    if (scopes.includes('user') && input.userScopeEnabled !== true) throw new Error('ECC user memory scope is disabled');
    const scan = await this.scanScopes(input.workspaceRoot, scopes, input.userScopeEnabled === true);
    return { healthy: scan.issues.length === 0, documents: scan.documents.length, issues: scan.issues };
  }

  private async scanScopes(workspaceRoot: string | undefined, scopes: readonly EccMemoryScope[], userScopeEnabled: boolean): Promise<{ documents: EccMemoryDocument[]; issues: string[] }> {
    const documents: EccMemoryDocument[] = [];
    const issues: string[] = [];
    const uniqueScopes = [...new Set(scopes)];
    for (const scope of uniqueScopes) {
      if (scope === 'user' && !userScopeEnabled) throw new Error('ECC user memory scope is disabled');
      const root = await this.scopeRoot(scope, await this.requireWorkspaceRoot(workspaceRoot, scope), false);
      await scanRoot(root, scope, documents, issues);
      if (documents.length > MAX_DOCUMENTS) throw new Error(`ECC memory document limit exceeded (${MAX_DOCUMENTS})`);
    }
    const seen = new Set<string>();
    for (const memory of documents) {
      if (seen.has(memory.id)) issues.push(`duplicate id: ${memory.id}`);
      seen.add(memory.id);
    }
    return { documents, issues };
  }

  private async requireWorkspaceRoot(workspaceRoot: string | undefined, scope: EccMemoryScope): Promise<string | undefined> {
    if (scope === 'user') return undefined;
    if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) throw new Error(`ECC ${scope} memory requires a registered workspace`);
    const canonical = await realpath(workspaceRoot);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('ECC memory workspace root is not a trusted directory');
    return canonical;
  }

  private async scopeRoot(scope: EccMemoryScope, workspaceRoot: string | undefined, create: boolean): Promise<string> {
    if (scope === 'user') {
      const home = await realpath(os.homedir());
      const relative = path.relative(home, this.userRoot);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ECC user memory root must stay inside the user home directory');
      if (create) await ensureSafeDirectory(home, this.userRoot);
      return this.userRoot;
    }
    const root = path.join(workspaceRoot!, '.ecc', 'memory');
    if (create) {
      await ensureSafeDirectory(workspaceRoot!, root);
      await ensureProjectGitignore(root);
      await ensureSafeDirectory(root, path.join(root, scope));
    }
    return path.join(root, scope);
  }
}

async function scanRoot(root: string, scope: EccMemoryScope, documents: EccMemoryDocument[], issues: string[]): Promise<void> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    issues.push(`${scope}: root unreadable`);
    return;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    issues.push(`${scope}: root is not a trusted directory`);
    return;
  }
  const directories = await readdir(root, { withFileTypes: true });
  directories.sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of directories) {
    const directoryPath = path.join(root, directory.name);
    const metadata = await lstat(directoryPath);
    if (metadata.isSymbolicLink()) {
      issues.push(`${scope}: skipped symlink ${directory.name}`);
      continue;
    }
    if (!metadata.isDirectory()) continue;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(directoryPath, entry.name);
      const fileMetadata = await lstat(filePath);
      if (fileMetadata.isSymbolicLink()) {
        issues.push(`${scope}: skipped symlink ${directory.name}/${entry.name}`);
        continue;
      }
      if (!fileMetadata.isFile() || fileMetadata.size > MAX_DOCUMENT_BYTES) {
        issues.push(`${scope}: invalid or oversized ${directory.name}/${entry.name}`);
        continue;
      }
      try {
        const parsed = parseDocument(await readFile(filePath, 'utf8'), scope, `${directory.name}/${entry.name}`);
        documents.push(parsed);
      } catch (error: unknown) {
        issues.push(`${scope}: ${directory.name}/${entry.name}: ${error instanceof Error ? error.message : 'invalid document'}`);
      }
    }
  }
}

function parseDocument(content: string, expectedScope: EccMemoryScope, relativePath: string): EccMemoryDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) throw new Error('missing strict frontmatter');
  const metadata: Record<string, unknown> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('invalid frontmatter field');
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try { metadata[key] = JSON.parse(raw); } catch { throw new Error(`invalid JSON metadata: ${key}`); }
  }
  if (metadata.schema !== SCHEMA) throw new Error('unsupported schema');
  const id = requiredSlug(metadata.id, 'id');
  if (!id.startsWith('mem_')) throw new Error('invalid memory id');
  const title = requiredString(metadata.title, 'title', 512);
  const kind = parseKind(metadata.kind);
  const scope = parseScope(metadata.scope);
  if (scope !== expectedScope) throw new Error('scope does not match vault location');
  if (metadata.trust !== 'unreviewed') throw new Error('memory trust must remain unreviewed');
  if (metadata.status !== 'active' && metadata.status !== 'superseded' && metadata.status !== 'archived') throw new Error('invalid status');
  const sourceHarness = requiredSlug(metadata.source_harness, 'source_harness');
  const targetHarnesses = requiredSlugArray(metadata.target_harnesses, 'target_harnesses');
  const tags = requiredSlugArray(metadata.tags, 'tags');
  const links = requiredMemoryLinks(metadata.links);
  const createdAt = requiredTimestamp(metadata.created_at, 'created_at');
  const updatedAt = requiredTimestamp(metadata.updated_at, 'updated_at');
  const body = sanitizeBody(match[2] ?? '');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('body exceeds 128 KiB');
  return {
    schema: SCHEMA,
    id,
    title,
    kind,
    scope,
    trust: 'unreviewed',
    status: metadata.status,
    source_harness: sourceHarness,
    target_harnesses: targetHarnesses,
    tags,
    links,
    created_at: createdAt,
    updated_at: updatedAt,
    body,
    relativePath,
  };
}

function serializeDocument(document: EccMemoryDocument): string {
  const fields: readonly [string, unknown][] = [
    ['schema', document.schema], ['id', document.id], ['title', document.title], ['kind', document.kind], ['scope', document.scope],
    ['trust', document.trust], ['status', document.status], ['source_harness', document.source_harness], ['target_harnesses', document.target_harnesses],
    ['tags', document.tags], ['links', document.links], ['created_at', document.created_at], ['updated_at', document.updated_at],
  ];
  return `---\n${fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${document.body.replace(/^\n+/, '')}`;
}

async function ensureProjectGitignore(memoryRoot: string): Promise<void> {
  const filePath = path.join(memoryRoot, '.gitignore');
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('ECC memory .gitignore is not a trusted regular file');
    const content = await readFile(filePath, 'utf8');
    if (content !== PROJECT_GITIGNORE) throw new Error('ECC memory .gitignore has unexpected content');
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
    await writeFile(filePath, PROJECT_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
  }
}

async function ensureSafeDirectory(base: string, target: string): Promise<void> {
  const canonicalBase = await realpath(base);
  const relative = path.relative(canonicalBase, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ECC memory path escaped its trusted root');
  let current = canonicalBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('ECC memory path contains an untrusted component');
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await mkdir(current);
    }
  }
}

function lexicalScore(memory: EccMemoryDocument, terms: readonly string[]): number {
  const title = memory.title.toLowerCase();
  const body = memory.body.toLowerCase();
  const tags = memory.tags.join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (tags.includes(term)) score += 5;
    if (body.includes(term)) score += 1;
  }
  return score;
}

function rejectSecrets(value: string): void {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(value))) throw new Error('ECC memory rejected suspected secret material');
}

function sanitizeBody(value: string): string {
  if (typeof value !== 'string') throw new Error('ECC memory body must be text');
  const hasTerminalControlData = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (hasTerminalControlData) throw new Error('ECC memory body contains terminal control data');
  return value;
}

function normalizeSlug(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SLUG.test(normalized)) throw new Error(`Invalid ECC memory ${label}`);
  return normalized;
}

function normalizeSlugArray(values: readonly string[], label: string): readonly string[] {
  if (values.length > 64) throw new Error(`Too many ECC memory ${label} values`);
  return [...new Set(values.map((value) => normalizeSlug(value, label)))];
}

function normalizeMemoryLinks(values: readonly string[]): readonly string[] {
  if (values.length > 64) throw new Error('Too many ECC memory links');
  return [...new Set(values.map((value) => {
    const link = normalizeSlug(value, 'link');
    if (!link.startsWith('mem_')) throw new Error('ECC memory links must reference mem_ ids');
    return link;
  }))];
}

function requiredSlug(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`missing ${label}`);
  return normalizeSlug(value, label);
}
function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`invalid ${label}`);
  return value;
}
function requiredSlugArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`invalid ${label}`);
  return normalizeSlugArray(value as string[], label);
}
function requiredMemoryLinks(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error('invalid links');
  return normalizeMemoryLinks(value as string[]);
}
function requiredTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`);
  return value;
}
function parseScope(value: unknown): EccMemoryScope {
  if (value === 'project' || value === 'team' || value === 'user') return value;
  throw new Error('invalid scope');
}
function parseKind(value: unknown): EccMemoryKind {
  if (value === 'context' || value === 'decision' || value === 'fact' || value === 'handoff' || value === 'lesson' || value === 'note' || value === 'preference' || value === 'runbook') return value;
  throw new Error('invalid kind');
}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
