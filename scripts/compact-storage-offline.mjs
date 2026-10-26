#!/usr/bin/env node
/**
 * Explicit offline-only maintenance. Never run on startup, never delete logs,
 * and never fall back to a default AppData profile.
 *
 * Usage: node scripts/compact-storage-offline.mjs --profile <absolute-path> --confirm
 * Requires prebuilt packages/storage/dist and a fully stopped lnwjing host.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--profile');
if (args.length !== 3 || at < 0 || args[at + 1] === undefined || !args.includes('--confirm')) {
  console.error('Usage: node scripts/compact-storage-offline.mjs --profile <absolute-path> --confirm');
  process.exitCode = 2;
} else {
  const supplied = args[at + 1];
  if (!path.isAbsolute(supplied)) throw new Error('Offline compaction requires an absolute profile path');
  if (lstatSync(supplied).isSymbolicLink()) throw new Error('Refusing a redirected profile directory');
  const profile = realpathSync(supplied);
  const databasePath = path.join(profile, 'lnwjing.sqlite');
  if (lstatSync(databasePath).isSymbolicLink() || !statSync(databasePath).isFile()) {
    throw new Error('Refusing a redirected or missing SQLite profile');
  }

  const assertStopped = async () => {
    if (process.platform !== 'win32') {
      // No reliable cross-platform process-identity handshake is installed.
      throw new Error('Offline compaction requires a platform-specific host-stop verifier');
    }
    const inspect = [
      '$ErrorActionPreference = "Stop"',
      // Include development runners and portable extraction children; those
      // can hold SQLite connections even without a process named lnwjing.exe.
      '$targets = @(Get-CimInstance Win32_Process | Where-Object {',
      '  ($_.ProcessId -ne ' + String(process.pid) + ') -and (',
      '  ($_.Name -match "(?i)^lnwjing.*\\.exe$") -or',
      '  (($_.Name -match "(?i)^(node|electron|pnpm|tsx)\\.exe$") -and',
      '    ($_.CommandLine -match "(?i)([\\\\/]lnwjing[\\\\/]|@lnwjing|lnwjing[\\\\/]packages)"))',
      '  )',
      '})',
      'if ($targets.Count -ne 0) { Write-Output "ACTIVE"; exit 3 }',
      'Write-Output "CLEAR"',
    ].join('; ');
    const response = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspect], {
      encoding: 'utf8', timeout: 12_000, windowsHide: true, maxBuffer: 8192,
    });
    return response.trim() === 'CLEAR';
  };

  if (!await assertStopped()) throw new Error('lnwjing is still running');
  const { compactOfflineSqliteProfile } = await import('../packages/storage/dist/index.js');
  const result = await compactOfflineSqliteProfile({
    databasePath,
    backupDirectory: path.join(profile, 'backups'),
    userConfirmed: true,
    assertRuntimeStopped: assertStopped,
  });
  console.log(JSON.stringify({
    performed: result.performed,
    beforeAllocatedBytes: result.before.allocatedBytes,
    afterAllocatedBytes: result.after.allocatedBytes,
    backupId: result.backupId,
  }, null, 2));
}
