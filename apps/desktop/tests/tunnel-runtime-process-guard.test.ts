import { describe, expect, it, vi } from 'vitest';
import {
  reconcileLocalTunnelRuntimeProcesses,
  type LocalTunnelRuntimeGuardDependencies,
  type LocalTunnelRuntimeGuardRequest,
  type LocalTunnelRuntimeProcess,
} from '../src/main/tunnel-runtime-process-guard.js';

const tunnelId = 'tunnel_fixture012345';
const clientPath = 'C:\\Program Files\\lnwjing\\resources\\tunnel-client\\tunnel-client.exe';
const profileDirectory = 'C:\\Users\\Ada\\AppData\\Roaming\\tunnel-client';

function runtime(pid: number, overrides: Partial<LocalTunnelRuntimeProcess> = {}): LocalTunnelRuntimeProcess {
  return {
    pid,
    startedAt: '2026-09-27T07:30:00.000Z',
    executablePath: clientPath,
    commandLine: `"${clientPath}" run --profile-dir "${profileDirectory}" --profile lnwjing --log.file ""`,
    ports: [40_000 + pid],
    ...overrides,
  };
}

function dependencies(processes: readonly LocalTunnelRuntimeProcess[], ids: Readonly<Record<number, string | null>>): LocalTunnelRuntimeGuardDependencies {
  return {
    listProcesses: vi.fn(async () => processes),
    probeTunnelId: vi.fn(async (port: number) => ids[port] ?? null),
    terminate: vi.fn(async (candidate: LocalTunnelRuntimeProcess) => { void candidate; }),
  } satisfies LocalTunnelRuntimeGuardDependencies;
}

function request(keepPid: number | null): LocalTunnelRuntimeGuardRequest {
  return { clientPath, profileDirectory, alias: 'lnwjing', tunnelId, keepPid };
}

describe('local tunnel runtime process guard', () => {
  it('retires the verified older process while keeping the official alias PID', async () => {
    const old = runtime(100);
    const current = runtime(200);
    const deps = dependencies([old, current], { 40100: tunnelId });

    await reconcileLocalTunnelRuntimeProcesses(request(current.pid), deps);

    expect(deps.probeTunnelId).toHaveBeenCalledExactlyOnceWith(40100);
    expect(deps.terminate).toHaveBeenCalledExactlyOnceWith(old);
  });

  it('retires every verified matching process after an explicit Stop', async () => {
    const old = runtime(100);
    const current = runtime(200);
    const deps = dependencies([old, current], { 40100: tunnelId, 40200: tunnelId });

    await reconcileLocalTunnelRuntimeProcesses(request(null), deps);

    expect(deps.terminate).toHaveBeenCalledTimes(2);
  });

  it('does not touch other profiles or the current PID', async () => {
    const current = runtime(200);
    const other = runtime(300, { commandLine: `"${clientPath}" run --profile-dir "${profileDirectory}" --profile someone-else` });
    const deps = dependencies([current, other], {});

    await reconcileLocalTunnelRuntimeProcesses(request(current.pid), deps);

    expect(deps.probeTunnelId).not.toHaveBeenCalled();
    expect(deps.terminate).not.toHaveBeenCalled();
  });

  it('loads listening ports lazily only after a duplicate runtime candidate is identified', async () => {
    const candidate = runtime(100, { ports: [] });
    const listListeningPorts = vi.fn(async (pid: number) => pid === candidate.pid ? [40_100] : []);
    const deps = {
      ...dependencies([candidate], { 40100: tunnelId }),
      listListeningPorts,
    } as LocalTunnelRuntimeGuardDependencies & { readonly listListeningPorts: (pid: number) => Promise<readonly number[]> };

    await reconcileLocalTunnelRuntimeProcesses(request(null), deps);

    expect(listListeningPorts).toHaveBeenCalledExactlyOnceWith(candidate.pid);
    expect(deps.probeTunnelId).toHaveBeenCalledExactlyOnceWith(40_100);
    expect(deps.terminate).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it('fails closed when a candidate cannot be verified, before stopping any process', async () => {
    const verified = runtime(100);
    const unknown = runtime(200);
    const deps = dependencies([verified, unknown], { 40100: tunnelId });

    await expect(reconcileLocalTunnelRuntimeProcesses(request(300), deps)).rejects.toThrow('Could not verify tunnel-client PID 200');

    expect(deps.terminate).not.toHaveBeenCalled();
  });

  it('refuses to stop a process bound to another Tunnel ID or executable', async () => {
    const otherId = dependencies([runtime(100)], { 40100: 'tunnel_another012345' });
    await expect(reconcileLocalTunnelRuntimeProcesses(request(null), otherId)).rejects.toThrow('configured Tunnel ID');
    expect(otherId.terminate).not.toHaveBeenCalled();

    const otherExecutable = dependencies([runtime(100, { executablePath: 'C:\\other\\tunnel-client.exe' })], { 40100: tunnelId });
    await expect(reconcileLocalTunnelRuntimeProcesses(request(null), otherExecutable)).rejects.toThrow('different executable');
    expect(otherExecutable.terminate).not.toHaveBeenCalled();
  });

  it('does not take over a manually started profile runtime', async () => {
    const manual = runtime(100, { commandLine: `"${clientPath}" run --profile-dir "${profileDirectory}" --profile lnwjing --log.file "C:\\logs\\manual.log"` });
    const deps = dependencies([manual], { 40100: tunnelId });

    await expect(reconcileLocalTunnelRuntimeProcesses(request(null), deps)).rejects.toThrow('outside the managed runtime');
    expect(deps.terminate).not.toHaveBeenCalled();
  });
});
