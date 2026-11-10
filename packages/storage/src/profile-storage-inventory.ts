import { Worker } from 'node:worker_threads';
import { inspectWindowsProfileAllocatedBytes } from './windows-profile-allocation.js';

/** Read-only profile scan. This is NOT an enforced disk quota or a snapshot of
 * files concurrently written by another process. It never scans user repos. */
export type ProfileStorageRetention = 'protected' | 'managed' | 'rebuildable' | 'unknown';
export interface ProfileStorageCategory {
  readonly id: string;
  readonly retention: ProfileStorageRetention;
  readonly logicalBytes: number;
  readonly files: number;
  readonly directories: number;
}
export interface ProfileStorageInventory {
  readonly scope: 'profile';
  readonly scannedAt: string;
  readonly logicalBytes: number;
  /** null unless an independent, bounded native scan verifies a conservative regular-file allocation estimate. */
  readonly allocatedBytes: number | null;
  readonly files: number;
  readonly directories: number;
  readonly visitedEntries: number;
  readonly skippedLinks: number;
  readonly unreadableEntries: number;
  readonly incomplete: boolean;
  readonly reason: 'complete' | 'entry-limit' | 'time-limit' | 'unreadable' | 'links-or-mounts';
  readonly categories: readonly ProfileStorageCategory[];
  /** Potentially manageable content; not eligible-for-deletion or saved bytes. */
  readonly potentiallyReclaimableLogicalBytes: number;
  readonly rebuildableLogicalBytes: number;
}
const DEFAULT_ENTRY_LIMIT = 50_000;
const MAX_ENTRY_LIMIT = 200_000;
const DEFAULT_SCAN_TIME_MS = 8_000;
const MAX_SCAN_TIME_MS = 15_000;

// Inline worker is safe for packaged Electron ASAR and Node test runners.
const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const config = new Map([
  ['database','protected'],['coordination','protected'],['secrets','protected'],
  ['runtime-state','protected'],['backups','managed'],['recovery-trash','managed'],
  ['activity-logs','managed'],['background-tasks','managed'],
  ['native-managed-git','managed'],['native-managed-processes','managed'],
  ['diagnostics','managed'],['crash-dumps','managed'],
  ['workspace-index','rebuildable'],['cache','rebuildable'],['other','unknown']
]);
function classify(top) {
  const base = top.toLowerCase();
  if (base === 'lnwjing.sqlite' || /^lnwjing\.sqlite[-.]/.test(base)) return 'database';
  if (base.startsWith('workspace-writer-leases.sqlite') || base.startsWith('global-quota-reservations-v2.sqlite')) return 'coordination';
  if (base === 'checkpoint-master.key' || base.includes('secret') || base.includes('credential')) return 'secrets';
  if (base === 'mcp-activity.log' || base.startsWith('mcp-activity.log.')) return 'activity-logs';
  if (base === 'backups' || base === 'recovery-trash' || base === 'workspace-index'
      || base === 'background-tasks' || base === 'native-managed-git'
      || base === 'native-managed-processes' || base === 'crash-dumps') return base;
  if (base === 'diagnostics' || base === 'logs') return 'diagnostics';
  if (['cache','code cache','gpucache','dawncache','shadercache'].includes(base)) return 'cache';
  if (base.startsWith('upgrade-') || base.endsWith('.lock') || base.startsWith('restore-')) return 'runtime-state';
  return 'other';
}
function run() {
  const root = path.resolve(workerData.root);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Profile root must be a real directory');
  const rootDev = rootStat.dev;
  const categories = new Map();
  const getCategory = id => {
    let item = categories.get(id);
    if (!item) {
      item = {id,retention:config.get(id) || 'unknown',logicalBytes:0,files:0,directories:0};
      categories.set(id,item);
    }
    return item;
  };
  let files=0, directories=0, visitedEntries=0, skippedLinks=0, unreadableEntries=0;
  let logicalBytes=0, allocatedBytes=0, allocatedSupported=process.platform!=='win32', stoppedFor=null;
  const deadline=Date.now() + workerData.maxDurationMs;
  const pending=[{directory:root,top:null}];
  while (pending.length && stoppedFor === null) {
    if (Date.now() >= deadline) { stoppedFor='time-limit'; break; }
    const dir = pending.pop();
    let handle;
    try { handle=fs.opendirSync(dir.directory); }
    catch(error) {
      if (error && ['EACCES','EPERM','ENOENT'].includes(error.code)) { unreadableEntries++; continue; }
      throw error;
    }
    try {
      while (true) {
        if (visitedEntries >= workerData.maxEntries) { stoppedFor='entry-limit'; break; }
        if ((visitedEntries & 127) === 0 && Date.now() >= deadline) { stoppedFor='time-limit'; break; }
        let entry;
        try { entry=handle.readSync(); }
        catch(error) {
          if (error && ['EACCES','EPERM','ENOENT'].includes(error.code)) { unreadableEntries++; break; }
          throw error;
        }
        if (entry === null) break;
        visitedEntries++;
        const top = dir.top === null ? entry.name : dir.top;
        const group = getCategory(classify(top));
        let s;
        const name=path.join(dir.directory,entry.name);
        try { s=fs.lstatSync(name,{bigint:true}); }
        catch(error) {
          if (error && ['EACCES','EPERM','ENOENT'].includes(error.code)) { unreadableEntries++; continue; }
          throw error;
        }
        if (s.isSymbolicLink() || (s.isDirectory() && s.dev !== rootDev)) {
          skippedLinks++; continue;
        }
        if (s.isDirectory()) {
          directories++; group.directories++;
          pending.push({directory:name,top});
        } else if (s.isFile()) {
          const bytes=Number(s.size);
          if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(logicalBytes+bytes))
            throw new Error('Profile size is outside safe integer range');
          files++; group.files++; group.logicalBytes+=bytes; logicalBytes+=bytes;
          if (typeof s.blocks === 'bigint' && s.blocks >= 0n) {
            const allocated=Number(s.blocks*512n);
            if (!Number.isSafeInteger(allocated) || !Number.isSafeInteger(allocatedBytes+allocated))
              allocatedSupported=false;
            else allocatedBytes+=allocated;
          } else allocatedSupported=false;
        } else unreadableEntries++;
      }
    } finally {handle.closeSync();}
  }
  const values=[...categories.values()].sort((a,b)=>b.logicalBytes-a.logicalBytes||a.id.localeCompare(b.id));
  const reclaimable=values.filter(x=>x.retention==='managed'||x.retention==='rebuildable')
    .reduce((n,x)=>n+x.logicalBytes,0);
  const rebuildable=values.filter(x=>x.retention==='rebuildable')
    .reduce((n,x)=>n+x.logicalBytes,0);
  const reason=stoppedFor||(unreadableEntries?'unreadable':skippedLinks?'links-or-mounts':'complete');
  return {
    scope:'profile',scannedAt:new Date().toISOString(),logicalBytes,
    allocatedBytes:allocatedSupported?allocatedBytes:null,
    files,directories,visitedEntries,skippedLinks,unreadableEntries,
    incomplete:reason!=='complete',reason,categories:values,
    potentiallyReclaimableLogicalBytes:reclaimable,rebuildableLogicalBytes:rebuildable
  };
}
try {parentPort.postMessage({ok:true,inventory:run()});}
catch(error) {parentPort.postMessage({ok:false,error:String(error && error.message||error)});}
`;

/**
 * Explicit UI-only diagnostic. Never use this path for hot reservations:
 * it performs a second, independently validated native Windows metadata scan.
 * The normal worker inventory remains available and responsive by default.
 */
export async function inspectProfileStorageWithPhysicalOffMain(
  profileRoot: string,
  options: { readonly maxEntries?: number; readonly maxDurationMs?: number } = {},
): Promise<ProfileStorageInventory> {
  const inventory = await inspectProfileStorageOffMain(profileRoot, options);
  if (inventory.incomplete || process.platform !== 'win32') return inventory;
  const allocatedBytes = await inspectWindowsProfileAllocatedBytes(profileRoot, {
    files: inventory.files,
    logicalBytes: inventory.logicalBytes,
    visitedEntries: inventory.visitedEntries,
  });
  return allocatedBytes === null ? inventory : { ...inventory, allocatedBytes };
}

export function inspectProfileStorageOffMain(
  profileRoot: string,
  options: { readonly maxEntries?: number; readonly maxDurationMs?: number } = {},
): Promise<ProfileStorageInventory> {
  const maxEntries = options.maxEntries ?? DEFAULT_ENTRY_LIMIT;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_SCAN_TIME_MS;
  if (!profileRoot || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRY_LIMIT
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > MAX_SCAN_TIME_MS) {
    return Promise.reject(new Error('Invalid profile storage inventory request'));
  }
  return new Promise<ProfileStorageInventory>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true, workerData: { root: profileRoot, maxEntries, maxDurationMs },
    });
    let settled = false;
    const finish = (error: Error | null, value?: ProfileStorageInventory): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().catch(() => undefined);
      if (error !== null || value === undefined) reject(error ?? new Error('Profile inventory missing result'));
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('Profile inventory worker exceeded its time limit')),
      maxDurationMs + 5_000);
    timeout.unref?.();
    worker.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('ok' in message)) {
        finish(new Error('Profile inventory worker returned invalid data'));
        return;
      }
      const result = message as { ok: boolean; inventory?: ProfileStorageInventory; error?: string };
      if (result.ok !== true || result.inventory === undefined) {
        finish(new Error(result.error ?? 'Profile inventory worker failed'));
        return;
      }
      finish(null, result.inventory);
    });
    worker.on('error', (error: Error) => finish(error));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error('Profile inventory worker exited early: ' + code));
    });
  });
}
