import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export interface NativeCrashReporterApi {
  start(options: {
    readonly productName?: string;
    readonly companyName?: string;
    readonly uploadToServer: boolean;
    readonly compress?: boolean;
    readonly extra?: Record<string, string>;
  }): void;
}

export interface NativeCrashDumpEntry {
  readonly fileName: string;
  readonly byteLength: number;
  readonly modifiedAt: string;
}

export interface NativeCrashDumpMetadata {
  readonly count: number;
  readonly dumps: readonly NativeCrashDumpEntry[];
}

const MAX_RETAINED_DUMPS = 20;
const MAX_DUMP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function configureNativeCrashDiagnostics(
  dataPath: string,
  appVersion: string,
  reporter: NativeCrashReporterApi,
  setCrashDumpsPath: (directory: string) => void,
  now = Date.now(),
): string {
  const directory = crashDumpDirectory(dataPath);
  mkdirSync(directory, { recursive: true });
  setCrashDumpsPath(directory);
  pruneNativeCrashDumps(directory, now);
  reporter.start({
    productName: 'lnwjing',
    companyName: 'lnwjing',
    uploadToServer: false,
    compress: false,
    extra: { appVersion, privacy: 'local-only' },
  });
  return directory;
}

export function readNativeCrashDumpMetadata(dataPath: string, now = Date.now()): NativeCrashDumpMetadata {
  const directory = crashDumpDirectory(dataPath);
  pruneNativeCrashDumps(directory, now);
  const dumps = listDumpFiles(directory)
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .slice(0, MAX_RETAINED_DUMPS)
    .map((entry) => ({ fileName: path.relative(directory, entry.filePath), byteLength: entry.byteLength, modifiedAt: new Date(entry.modifiedMs).toISOString() }));
  return { count: dumps.length, dumps };
}

export function pruneNativeCrashDumpsForDataPath(dataPath: string, now = Date.now()): void {
  pruneNativeCrashDumps(crashDumpDirectory(dataPath), now);
}

export function pruneNativeCrashDumps(directory: string, now = Date.now()): void {
  const dumps = listDumpFiles(directory).sort((left, right) => right.modifiedMs - left.modifiedMs);
  dumps.forEach((entry, index) => {
    if (index >= MAX_RETAINED_DUMPS || now - entry.modifiedMs > MAX_DUMP_AGE_MS) rmSync(entry.filePath, { force: true });
  });
}

function crashDumpDirectory(dataPath: string): string {
  return path.join(dataPath, 'crash-dumps');
}

function listDumpFiles(directory: string): Array<{ filePath: string; byteLength: number; modifiedMs: number }> {
  const result: Array<{ filePath: string; byteLength: number; modifiedMs: number }> = [];
  const visit = (current: string): void => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' }); } catch { return; }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.dmp') continue;
      try {
        const stat = statSync(filePath);
        result.push({ filePath, byteLength: stat.size, modifiedMs: stat.mtimeMs });
      } catch {
        // Crashpad may still be finalizing a dump; skip it until the next pass.
      }
    }
  };
  visit(directory);
  return result;
}
