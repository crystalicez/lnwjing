import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applySettingsPreservingResetSync } from './settings-preserving-reset.js';

type FactoryResetMarker = { readonly version: 1 } | {
  readonly version: 2;
  readonly mode: 'preserve-settings';
  readonly nonce: string;
};

export const FACTORY_RESET_APPLY_ARG = '--lnwjing-apply-factory-reset';
const FACTORY_RESET_MARKER: FactoryResetMarker = { version: 1 };

export function factoryResetMarkerPath(dataPath: string): string {
  const safeDataPath = safeAbsoluteDirectory(dataPath, 'lnwjing data path');
  return path.join(path.dirname(safeDataPath), `.${path.basename(safeDataPath)}.factory-reset.pending`);
}

export function factoryResetBootstrapUserDataPath(dataPath: string): string {
  const safeDataPath = safeAbsoluteDirectory(dataPath, 'lnwjing data path');
  return path.join(path.dirname(safeDataPath), `.${path.basename(safeDataPath)}.factory-reset-bootstrap`);
}

export function clearFactoryResetBootstrapSync(dataPath: string): void {
  rmSync(factoryResetBootstrapUserDataPath(dataPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export function stageFactoryResetSync(dataPath: string, mode: 'all' | 'preserve-settings' = 'all'): string {
  const markerPath = factoryResetMarkerPath(dataPath);
  try {
    const metadata = lstatSync(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Factory reset marker is not a trusted regular file');
    const existing = parseFactoryResetMarker(readFileSync(markerPath, 'utf8'));
    if ((existing.version === 1 ? 'all' : existing.mode) !== mode) {
      throw new Error('A different reset mode is already pending');
    }
    return markerPath;
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }
  const marker: FactoryResetMarker = mode === 'preserve-settings'
    ? { version: 2, mode, nonce: randomUUID() } : FACTORY_RESET_MARKER;
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return markerPath;
}

export function clearFactoryResetStageSync(dataPath: string): void {
  rmSync(factoryResetMarkerPath(dataPath), { force: true });
}

export function applyPendingFactoryResetSync(dataPath: string, tunnelProfileDirectory: string): boolean {
  const markerPath = factoryResetMarkerPath(dataPath);
  let raw: string;
  try {
    const metadata = lstatSync(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Factory reset marker is not a trusted regular file');
    raw = readFileSync(markerPath, 'utf8');
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }

  const marker = parseFactoryResetMarker(raw);
  if (marker.version !== 1 && marker.version !== 2) throw new Error('Unsupported factory reset marker version');

  const safeDataPath = safeAbsoluteDirectory(dataPath, 'lnwjing data path');
  const safeTunnelProfileDirectory = safeAbsoluteDirectory(tunnelProfileDirectory, 'Tunnel profile directory');

  if (marker.version === 2) {
    applySettingsPreservingResetSync(safeDataPath, marker.nonce);
  } else {
    rmSync(safeDataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (!isSamePath(safeTunnelProfileDirectory, safeDataPath)) {
      clearLnwjingTunnelArtifactsSync(safeTunnelProfileDirectory);
    }
    mkdirSync(safeDataPath, { recursive: true });
  }
  rmSync(markerPath, { force: true });
  return true;
}

const LNWJING_TUNNEL_ROOT_ARTIFACTS = new Set([
  'lnwjing.yaml',
  'lnwjing.runtime.secret',
  'lnwjing.oauth.session.secret',
  'lnwjing-tunnel.log',
  'lnwjing.tunnel.lock',
  'lnwjing.tunnel.mutex',
  'lnwjing.tunnel.stop',
]);

function clearLnwjingTunnelArtifactsSync(profileDirectory: string): void {
  const healthUrlPath = resolveProfileHealthUrlPath(profileDirectory);
  let entries: string[];
  try {
    entries = readdirSync(profileDirectory, { encoding: 'utf8' });
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!isLnwjingTunnelRootArtifactName(entry)) continue;
    rmSync(path.join(profileDirectory, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (healthUrlPath !== null) rmSync(healthUrlPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function isLnwjingTunnelRootArtifactName(name: string): boolean {
  const normalized = process.platform === 'win32' ? name.toLowerCase() : name;
  return LNWJING_TUNNEL_ROOT_ARTIFACTS.has(normalized) || normalized.startsWith('lnwjing.tunnel.lock.');
}

function resolveProfileHealthUrlPath(profileDirectory: string): string | null {
  const profilePath = path.join(profileDirectory, 'lnwjing.yaml');
  let raw: string;
  try {
    raw = readFileSync(profilePath, 'utf8');
  } catch (error: unknown) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const configured = extractHealthUrlFile(raw);
  if (configured === null) return null;
  const candidate = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(profileDirectory, configured);
  return isPathInsideDirectory(profileDirectory, candidate) ? candidate : null;
}

function extractHealthUrlFile(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const health = (parsed as Record<string, unknown>).health;
      if (typeof health === 'object' && health !== null && !Array.isArray(health)) {
        const value = (health as Record<string, unknown>).url_file;
        if (typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')) return value.trim();
      }
    }
  } catch {
    // Fall through to the small YAML scalar parser used by tunnel-client profiles.
  }
  const match = /^\s*url_file\s*:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(raw);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 || value.includes('\0') ? null : value;
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseFactoryResetMarker(raw: string): FactoryResetMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Factory reset marker is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Factory reset marker is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.version === 1 && Object.keys(record).length === 1) return FACTORY_RESET_MARKER;
  if (record.version === 2 && record.mode === 'preserve-settings'
    && typeof record.nonce === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.nonce)
    && Object.keys(record).length === 3) {
    return { version: 2, mode: 'preserve-settings', nonce: record.nonce };
  }
  throw new Error('Factory reset marker is invalid');
}

function safeAbsoluteDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`Refusing to factory-reset filesystem root: ${resolved}`);
  return resolved;
}

function isSamePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
