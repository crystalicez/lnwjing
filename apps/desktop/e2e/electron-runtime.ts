import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export function electronExecutablePath(desktopRoot: string, platform: NodeJS.Platform = process.platform): string {
  const executable = platform === 'win32' ? ['electron.exe']
    : platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
      : ['electron'];
  return path.join(desktopRoot, 'node_modules', 'electron', 'dist', ...executable);
}

// POSIX launchers use detached:true so cleanup owns this process group only.
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
      killer.once('error', reject);
      killer.once('close', () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Windows taskkill can remove a process before Node reports its exit.
  // Check OS liveness rather than timing out on a dead child.
  const childGone = (): boolean => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    if (process.platform !== 'win32') return false;
    try {
      process.kill(child.pid!, 0);
      return false;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
      throw error;
    }
  };
  if (childGone()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onExit = (): void => finish();
    const poll = setInterval(() => {
      try {
        if (childGone()) finish();
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new Error('Cannot verify Electron process termination'));
      }
    }, 150);
    const timer = setTimeout(() => finish(new Error('Timed out terminating E2E Electron process')), 10_000);
    child.once('exit', onExit);
    child.once('close', onExit);
    if (childGone()) finish();
  });
}
