import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_PROBE_TIMEOUT_MS = 2_500;
const WINDOWS_FILETIME_TICKS = /^\d{15,19}$/;

/**
 * The process creation timestamp is an OS value, not Date.now() - uptime.
 * Null means the owner's identity cannot be established; fail closed on
 * reconciliation rather than treating an inaccessible process as dead.
 */
export type QuotaProcessIdentity =
  | { readonly state: 'live'; readonly startedAt: string }
  | { readonly state: 'gone' }
  | { readonly state: 'unverifiable' };

export async function probeQuotaProcessIdentity(pid: number): Promise<QuotaProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    return { state: 'unverifiable' };
  }
  if (process.platform !== 'win32') return { state: 'unverifiable' };
  try {
    const command = `$ErrorActionPreference='Stop';try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){'GONE';exit 0};throw};'LIVE|'+$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`;
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, timeout: WINDOWS_PROBE_TIMEOUT_MS,
        maxBuffer: 4096, encoding: 'utf8',
      });
    const response = stdout.trim();
    if (response === 'GONE') return { state: 'gone' };
    const start = /^LIVE\|(\d{15,19})$/.exec(response)?.[1];
    return start !== undefined && WINDOWS_FILETIME_TICKS.test(start)
      ? { state: 'live', startedAt: start }
      : { state: 'unverifiable' };
  } catch {
    return { state: 'unverifiable' };
  }
}

export function validQuotaProcessStart(value: string | null): boolean {
  return value === null || WINDOWS_FILETIME_TICKS.test(value);
}
