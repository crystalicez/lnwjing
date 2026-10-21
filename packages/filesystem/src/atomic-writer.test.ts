import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { AtomicFileWriter } from './atomic-writer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AtomicFileWriter', () => {
  it('publishes exactly one winner across concurrent create_new writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-create-only-race-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'report.md');
    const writer = new AtomicFileWriter();
    const [first, second] = await Promise.all([
      writer.write(target, 'first', { createNew: true }),
      writer.write(target, 'second', { createNew: true }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe(first.ok ? 'first' : 'second');
    expect(await readdir(root)).toEqual(['report.md']);
  });

  it('rejects a destination created after preflight without modifying its bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-create-only-preflight-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'report.md');
    let validations = 0;
    const result = await new AtomicFileWriter().write(target, 'attempted', {
      createNew: true,
      validateDestination: async () => {
        if (++validations === 3) await writeFile(target, 'winner', 'utf8');
        return ok(undefined);
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('winner');
    expect(await readdir(root)).toEqual(['report.md']);
  });
  it('writes through a temporary file in the target directory and replaces the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'file.txt');
    const result = await new AtomicFileWriter().write(target, 'new content\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('new content\n');
  });

  it('creates missing nested parent directories before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'docs', 'superpowers', 'plans', 'plan.md');
    const result = await new AtomicFileWriter().write(target, 'nested\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('nested\n');
  });

  it('revalidates immediately before publication and leaves the live target unchanged on conflict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'file.txt');
    await writeFile(target, 'before\n', 'utf8');
    let validations = 0;
    const validateDestination = async (): Promise<Result<void>> => {
      validations += 1;
      return validations < 3 ? ok(undefined) : err(appError('CONFLICT', 'destination changed', true));
    };

    const result = await new AtomicFileWriter().write(target, 'after\n', { validateDestination });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(validations).toBe(3);
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n');
    expect(await readdir(root)).toEqual(['file.txt']);
  });
});
