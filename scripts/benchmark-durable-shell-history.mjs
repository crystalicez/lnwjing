import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { DurableShellTaskIndex } from '../packages/capabilities/dist/durable-shell-task-index.js';

const HISTORY_SIZES = [603, 13_355];
const MEASURED_LAUNCHES = 20;
const WARMUP_LAUNCHES = 3;
const results = [];

for (const historySize of HISTORY_SIZES) {
  results.push(await benchmarkHistory(historySize));
}

const [small, large] = results;
const p95Ratio = large.p95Ms / Math.max(small.p95Ms, 0.001);
const report = {
  benchmark: 'durable-shell-warm-active-index',
  platform: process.platform,
  node: process.version,
  measuredLaunches: MEASURED_LAUNCHES,
  histories: results,
  p95Ratio: round(p95Ratio),
  acceptanceRatio: 1.5,
  accepted: p95Ratio <= 1.5 && results.every((entry) => entry.warmMetadataReads === 0),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.accepted) process.exitCode = 1;

async function benchmarkHistory(historySize) {
  const root = await mkdtemp(path.join(os.tmpdir(), `lnwjing-durable-history-${historySize}-`));
  let metadataReads = 0;
  try {
    await createDirectories(root, historySize);
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 16,
      inspectTask: async () => {
        metadataReads += 1;
        return 'terminal';
      },
    });
    const bootstrapStartedAt = performance.now();
    await index.initialize();
    const bootstrapMs = performance.now() - bootstrapStartedAt;
    const bootstrapMetadataReads = metadataReads;
    metadataReads = 0;

    for (let indexValue = 0; indexValue < WARMUP_LAUNCHES; indexValue += 1) {
      await reserveAndRelease(index, historySize, `warmup-${indexValue}`);
    }

    const timings = [];
    for (let indexValue = 0; indexValue < MEASURED_LAUNCHES; indexValue += 1) {
      const startedAt = performance.now();
      await reserveAndRelease(index, historySize, `measured-${indexValue}`);
      timings.push(performance.now() - startedAt);
    }

    return {
      terminalHistories: historySize,
      bootstrapMs: round(bootstrapMs),
      bootstrapMetadataReads,
      warmMetadataReads: metadataReads,
      medianMs: round(percentile(timings, 0.5)),
      p95Ms: round(percentile(timings, 0.95)),
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 100 });
  }
}

async function reserveAndRelease(index, historySize, suffix) {
  const taskId = `benchmark-${historySize}-${suffix}`;
  const requestDigest = createHash('sha256').update(taskId).digest('hex');
  const reservation = await index.reserve({
    taskId,
    requestDigest,
    ownerClientId: 'benchmark',
    ownerWorkspaceId: 'benchmark-workspace',
  });
  if (!reservation.ok) throw new Error(`${reservation.error.code}: ${reservation.error.message}`);
  await index.release(taskId, requestDigest);
}

async function createDirectories(root, count) {
  const concurrency = 128;
  for (let start = 0; start < count; start += concurrency) {
    const end = Math.min(count, start + concurrency);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => (
      mkdir(path.join(root, `terminal-${String(start + offset).padStart(5, '0')}`))
    )));
  }
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[position] ?? 0;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
