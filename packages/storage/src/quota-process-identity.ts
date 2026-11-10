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

/**
 * One native process for at most eight independent Windows PID probes.
 * Every unrecognized/error/inaccessible response is 'unverifiable', NEVER
 * 'gone'. The returned Map contains an entry for every requested PID.
 *
 * This is intentionally NOT invoked while holding the SQLite quota lock.
 */
export async function probeQuotaProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, QuotaProcessIdentity>> {
  const results = new Map<number, QuotaProcessIdentity>();
  for (const pid of pids) results.set(pid, { state: 'unverifiable' });
  const valid = [...new Set(pids)].filter((pid) =>
    Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647).slice(0, 8);
  if (valid.length === 0 || process.platform !== 'win32') return results;

  const command = `$ErrorActionPreference='Stop';foreach($ownerPid in @(${valid.join(',')})){try{$p=Get-Process -Id $ownerPid -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){"$ownerPid|GONE";continue};"$ownerPid|UNVERIFIABLE";continue};try{"$ownerPid|LIVE|"+$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}catch{"$ownerPid|UNVERIFIABLE"}}`;
  try {
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, timeout: WINDOWS_PROBE_TIMEOUT_MS + 1_000,
        maxBuffer: 4096, encoding: 'utf8',
      });
    const parsed = new Map<number, QuotaProcessIdentity>();
    for (const line of stdout.trim().split(/\r?\n/)) {
      const fields = /^(\d+)\|(GONE|UNVERIFIABLE|LIVE\|\d{15,19})$/.exec(line.trim());
      if (fields === null) return results;
      const pid = Number(fields[1]);
      if (!valid.includes(pid) || parsed.has(pid)) return results;
      const status = fields[2];
      const startedAt = status?.startsWith('LIVE|') ? status.slice(5) : null;
      parsed.set(pid, startedAt !== null && WINDOWS_FILETIME_TICKS.test(startedAt)
        ? { state: 'live', startedAt }
        : status === 'GONE' ? { state: 'gone' } : { state: 'unverifiable' });
    }
    // Partial or truncated output cannot be used to declare any owner dead.
    if (parsed.size !== valid.length) return results;
    for (const [pid, state] of parsed) results.set(pid, state);
  } catch {
    // An inaccessible PowerShell process or timeout is not evidence of death.
  }
  return results;
}

export function validQuotaProcessStart(value: string | null): boolean {
  return value === null || WINDOWS_FILETIME_TICKS.test(value);
}
