import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LocalTunnelRuntimeProcess {
  readonly pid: number;
  readonly startedAt: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly ports: readonly number[];
}

export interface LocalTunnelRuntimeGuardRequest {
  readonly clientPath: string;
  readonly profileDirectory: string;
  readonly alias: string;
  readonly tunnelId: string;
  /** The PID reported by the official alias. Null means all matching runtimes must stop. */
  readonly keepPid: number | null;
}

export interface LocalTunnelRuntimeGuardDependencies {
  readonly listProcesses: () => Promise<readonly LocalTunnelRuntimeProcess[]>;
  readonly listListeningPorts?: (pid: number) => Promise<readonly number[]>;
  readonly probeTunnelId: (port: number) => Promise<string | null>;
  readonly terminate: (process: LocalTunnelRuntimeProcess) => Promise<void>;
}

/**
 * The official runtime alias can lose track of an older live process during an
 * upgrade. Both processes then poll the same Tunnel ID, so requests are routed
 * to whichever one happens to receive them. Retire only processes whose exact
 * profile and live admin endpoint prove that they belong to this Tunnel ID.
 */
export async function reconcileLocalTunnelRuntimeProcesses(
  request: LocalTunnelRuntimeGuardRequest,
  dependencies: LocalTunnelRuntimeGuardDependencies = windowsDependencies,
): Promise<void> {
  const processes = await dependencies.listProcesses();
  const candidates = processes.filter((process) =>
    process.pid !== request.keepPid && matchesProfile(process.commandLine, request.alias, request.profileDirectory));
  const verified: LocalTunnelRuntimeProcess[] = [];
  for (const candidate of candidates) {
    // The managed CLI starts its detached child with an empty --log.file;
    // lnwjing's legacy/profile child and user-started clients write their own
    // log file and must not be silently taken over.
    if (commandFlag(candidate.commandLine, '--log.file') !== '') {
      throw new Error(`Another tunnel-client PID ${candidate.pid} uses the lnwjing profile outside the managed runtime; stop it before starting this runtime`);
    }
    if (!sameWindowsPath(candidate.executablePath, request.clientPath)) {
      throw new Error(`Another tunnel-client PID ${candidate.pid} uses the lnwjing profile from a different executable; stop it before starting this runtime`);
    }
    const ports = dependencies.listListeningPorts === undefined
      ? candidate.ports
      : await dependencies.listListeningPorts(candidate.pid);
    if (ports.length === 0 || ports.length > 16) {
      throw new Error(`Could not verify tunnel-client PID ${candidate.pid} through its local admin UI; refusing to start a duplicate`);
    }
    let observedTunnelId: string | null = null;
    for (const port of ports) {
      observedTunnelId = await dependencies.probeTunnelId(port);
      if (observedTunnelId !== null) break;
    }
    if (observedTunnelId !== request.tunnelId) {
      throw new Error(`Could not verify tunnel-client PID ${candidate.pid} belongs to the configured Tunnel ID; refusing to stop or duplicate it`);
    }
    verified.push(candidate);
  }
  for (const candidate of verified) await dependencies.terminate(candidate);
}

function matchesProfile(commandLine: string, alias: string, profileDirectory: string): boolean {
  const profile = commandFlag(commandLine, '--profile');
  const directory = commandFlag(commandLine, '--profile-dir');
  return profile === alias && directory !== null && sameWindowsPath(directory, profileDirectory);
}

function commandFlag(commandLine: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|(\\S+))(?=\\s|$)`, 'i').exec(commandLine);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

const windowsDependencies: LocalTunnelRuntimeGuardDependencies = {
  listProcesses: async (): Promise<readonly LocalTunnelRuntimeProcess[]> => {
    if (process.platform !== 'win32') return [];
    const script = [
      "$ErrorActionPreference='Stop'",
      '$processes=@(Get-CimInstance Win32_Process -Filter "Name = \'tunnel-client.exe\'" -ErrorAction Stop)',
      "$items=@($processes | ForEach-Object { $p=$_; [pscustomobject]@{ pid=[int]$p.ProcessId; startedAt=$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture); executablePath=[string]$p.ExecutablePath; commandLine=[string]$p.CommandLine; ports=@() } })",
      'ConvertTo-Json -InputObject $items -Compress -Depth 4',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 512 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('Tunnel process inventory was not an array');
    return parsed.map(parseProcess);
  },
  listListeningPorts: async (pid: number): Promise<readonly number[]> => {
    if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return [];
    const script = [
      "$ErrorActionPreference='Stop'",
      '$pidValue=[int]$env:LNWJING_TUNNEL_GUARD_PID',
      "$ports=@(Get-NetTCPConnection -OwningProcess $pidValue -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } | Select-Object -ExpandProperty LocalPort)",
      'ConvertTo-Json -InputObject $ports -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024,
      env: { ...process.env, LNWJING_TUNNEL_GUARD_PID: String(pid) },
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || !parsed.every((port) => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535)) {
      throw new Error(`Invalid tunnel process listener inventory for PID ${pid}`);
    }
    return parsed;
  },
  probeTunnelId: async (port: number): Promise<string | null> => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return new Promise((resolve) => {
      let body = '';
      const request = httpRequest(`http://127.0.0.1:${port}/api/status`, { method: 'GET', headers: { accept: 'application/json' } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > 64 * 1024) request.destroy();
        });
        response.once('end', () => {
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { resolve(null); return; }
            const record = parsed as Record<string, unknown>;
            const tunnelId = record.control_plane_tunnel_id ?? record.tunnel_id;
            resolve(typeof tunnelId === 'string' && /^tunnel_[A-Za-z0-9_-]{8,128}$/.test(tunnelId) ? tunnelId : null);
          } catch { resolve(null); }
        });
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once('error', () => resolve(null));
      request.end();
    });
  },
  terminate: async (candidate: LocalTunnelRuntimeProcess): Promise<void> => {
    const script = [
      "$ErrorActionPreference='Stop'",
      '$target=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:LNWJING_TUNNEL_GUARD_PID) -ErrorAction Stop',
      "if($null -eq $target){exit 0}",
      "$started=$target.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)",
      "if($started -cne $env:LNWJING_TUNNEL_GUARD_STARTED -or $target.ExecutablePath -ine $env:LNWJING_TUNNEL_GUARD_PATH -or $target.CommandLine -cne $env:LNWJING_TUNNEL_GUARD_COMMAND){throw 'Tunnel process identity changed; refusing to stop it'}",
      'Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop',
      'for($i=0;$i -lt 20;$i++){ $still=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:LNWJING_TUNNEL_GUARD_PID) -ErrorAction Stop; if($null -eq $still -or $still.CreationDate.ToUniversalTime().ToString(\'yyyy-MM-ddTHH:mm:ss.fffZ\',[Globalization.CultureInfo]::InvariantCulture) -cne $env:LNWJING_TUNNEL_GUARD_STARTED){exit 0}; Start-Sleep -Milliseconds 100 }',
      "throw 'Tunnel process did not stop'",
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 4_096,
      env: {
        ...process.env,
        LNWJING_TUNNEL_GUARD_PID: String(candidate.pid),
        LNWJING_TUNNEL_GUARD_STARTED: candidate.startedAt,
        LNWJING_TUNNEL_GUARD_PATH: candidate.executablePath,
        LNWJING_TUNNEL_GUARD_COMMAND: candidate.commandLine,
      },
    });
  },
};

function parseProcess(value: unknown): LocalTunnelRuntimeProcess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid tunnel process inventory');
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const startedAt = record.startedAt;
  const executablePath = record.executablePath;
  const commandLine = record.commandLine;
  const ports = record.ports;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647
    || typeof startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(startedAt)
    || typeof executablePath !== 'string' || typeof commandLine !== 'string' || !Array.isArray(ports)) {
    throw new Error('Invalid tunnel process inventory');
  }
  if (!ports.every((port: unknown) => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535)) {
    throw new Error('Invalid tunnel process ports');
  }
  return { pid, startedAt, executablePath, commandLine, ports };
}
