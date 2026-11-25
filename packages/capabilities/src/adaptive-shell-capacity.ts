import os from 'node:os';
import { DEFAULT_SHELL_MAX_CONCURRENT_TASKS } from '@lnwjing/shared';

const MiB = 1024 * 1024;
const SAMPLE_MS = 2_000;

export interface ShellCapacitySample {
  readonly now: number;
  readonly availableCpus: number;
  readonly freeBytes: number;
  readonly cpuIdleTicks: number;
  readonly cpuTotalTicks: number;
}

function sampleHost(): ShellCapacitySample {
  let cpuIdleTicks = 0; let cpuTotalTicks = 0;
  for (const cpu of os.cpus()) {
    cpuIdleTicks += cpu.times.idle;
    cpuTotalTicks += cpu.times.idle + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
  }
  return { now: Date.now(), availableCpus: os.availableParallelism(), freeBytes: os.freemem(), cpuIdleTicks, cpuTotalTicks };
}

/** Opt-in heuristic, not a memory guarantee or a process termination policy. */
export function createAdaptiveShellCapacity(
  configured: () => number = () => DEFAULT_SHELL_MAX_CONCURRENT_TASKS,
  enabled: () => boolean = () => false,
  sample: () => ShellCapacitySample = sampleHost,
  now: () => number = Date.now,
): () => number {
  let previous: ShellCapacitySample | undefined;
  let current: ShellCapacitySample | undefined;
  let busy = false;
  return (): number => {
    const limit = configured();
    if (!enabled()) {
      previous = undefined; current = undefined; busy = false;
      return limit;
    }
    // On demand only; no polling timer, and no repeated CPU enumeration on bursts.
    if (current === undefined || now() - current.now >= SAMPLE_MS) {
      previous = current;
      current = sample();
      const elapsed = previous === undefined ? 0 : current.cpuTotalTicks - previous.cpuTotalTicks;
      const idle = previous === undefined ? 0 : current.cpuIdleTicks - previous.cpuIdleTicks;
      busy = elapsed > 0 && idle >= 0 && idle <= elapsed && 1 - idle / elapsed >= 0.9;
    }
    const cpuCap = Math.max(1, Math.floor(current.availableCpus * 2));
    const memoryCap = Math.max(1, Math.floor((current.freeBytes - 512 * MiB) / (256 * MiB)));
    const cap = Math.min(limit, cpuCap, memoryCap);
    // Keep one recovery slot; pressure never cancels an admitted task.
    return busy ? Math.max(1, Math.floor(cap / 2)) : cap;
  };
}
