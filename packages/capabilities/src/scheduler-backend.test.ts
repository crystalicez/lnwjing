import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { SchedulerCapabilityBackend } from './scheduler-backend.js';

describe('SchedulerCapabilityBackend', () => {
  it('lists task paths and localized values without parsing translated headings', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '"\\MyTask","N/A","Ready"\r\n"\\โฟลเดอร์\\งาน, รายวัน","13/10/2026 09:30:00","กำลังทำงาน"\r\n',
      stderr: '',
    }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'list' });

    expect(result).toMatchObject({
      ok: true,
      value: { tasks: [
        { name: '\\MyTask', next_run_time: 'N/A', status: 'Ready' },
        { name: '\\โฟลเดอร์\\งาน, รายวัน', next_run_time: '13/10/2026 09:30:00', status: 'กำลังทำงาน' },
      ] },
    });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH']);
  });

  it.each(['\\MyTask', '\\Folder\\งาน (รายวัน)', 'Folder\\Other Task', 'a'.repeat(238)])(
    'roundtrips a listed native task path through run and delete: %s', async (name) => {
      const runImpl = vi.fn(async (_executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => ({
        stdout: args[0] === '/Query' ? `"${name}","N/A","Ready"\r\n` : 'SUCCESS',
        stderr: '',
      }));
      const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
      const listed = await backend.execute({ action: 'list' });
      expect(listed).toMatchObject({ ok: true, value: { tasks: [{ name }] } });

      await expect(backend.execute({ action: 'run', task_name: name, userConfirmed: true }))
        .resolves.toMatchObject({ ok: true, value: { started: true, task_name: name } });
      await expect(backend.execute({ action: 'delete', task_name: name, userConfirmed: true }))
        .resolves.toMatchObject({ ok: true, value: { deleted: true, task_name: name } });
      expect(runImpl).toHaveBeenNthCalledWith(2, 'schtasks.exe', ['/Run', '/TN', name]);
      expect(runImpl).toHaveBeenNthCalledWith(3, 'schtasks.exe', ['/Delete', '/TN', name, '/F']);
    },
  );

  it('dispatches a rooted nested Unicode task identity without changing it', async () => {
    const runImpl = vi.fn(async () => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const name = '\\โฟลเดอร์\\งาน (รายวัน)';

    await expect(backend.execute({ action: 'run', task_name: name, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { started: true, task_name: name } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', ['/Run', '/TN', name]);
  });

  it('preserves CSV escaping and empty next-run values', async () => {
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl: async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '\uFEFF"\\Task","","สถานะ ""พร้อม"""\r\n\\Other Task,N/A,Ready\r\n', stderr: '',
    }) });
    await expect(backend.execute({ action: 'list' })).resolves.toEqual({ ok: true, value: { tasks: [
      { name: '\\Task', next_run_time: '', status: 'สถานะ "พร้อม"' },
      { name: '\\Other Task', next_run_time: 'N/A', status: 'Ready' },
    ] } });
  });

  it.each(['"\\Task","N/A"', '"\\Task","N/A","Ready', '"\\Task"oops,"N/A","Ready"', '\\Ta"sk,N/A,Ready', 'TaskName: \\Task\nStatus: Ready'])('reports unparseable task listings instead of an empty success: %s', async (stdout) => {
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout, stderr: '' }) });
    await expect(backend.execute({ action: 'list' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', recoverable: true } });
  });

  it('retains the entire command and arguments beyond 250 characters', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const payload = 'ไทย😀'.repeat(100);
    const result = await backend.execute({ action: 'create', task_name: 'LongTask', command: 'node.exe', arguments: ['--payload', payload, '--last'], userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', [
      '/Create', '/TN', 'LongTask', '/TR', `node.exe --payload ${payload} --last`, '/SC', 'DAILY', '/ST', '09:00',
    ]);
  });

  it('creates a task with a quoted command line', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({
      action: 'create',
      task_name: 'LnwjingTest',
      command: 'C:\\Program Files\\app\\tool.exe',
      arguments: ['--flag', 'value with space'],
      schedule: 'DAILY',
      start_time: '09:30',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true, task_name: 'LnwjingTest' } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', [
      '/Create', '/TN', 'LnwjingTest',
      '/TR', '"C:\\Program Files\\app\\tool.exe" --flag "value with space"',
      '/SC', 'DAILY', '/ST', '09:30',
    ]);
  });

  it.skipIf(process.platform !== 'win32')('preserves empty arguments, quotes and trailing backslashes in a real Windows child command line', async () => {
    const originalArguments = ['', 'space value', 'C:\\space path\\', 'a\\"b', 'ไทย 😀'];
    let observedArguments: unknown;
    const runImpl = vi.fn(async (_executable: string, args: readonly string[]) => {
      const commandLine = args[args.indexOf('/TR') + 1];
      if (commandLine === undefined) throw new Error('Expected a create command line');
      const programPrefix = /\s/.test(process.execPath) ? `"${process.execPath}" ` : `${process.execPath} `;
      expect(commandLine.startsWith(programPrefix)).toBe(true);
      const child = spawnSync(process.execPath, [commandLine.slice(programPrefix.length)], {
        argv0: programPrefix.slice(0, -1), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 3_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      observedArguments = JSON.parse(child.stdout);
      return { stdout: 'SUCCESS', stderr: '' };
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const result = await backend.execute({
      action: 'create', task_name: 'ArgumentFixture', command: process.execPath,
      arguments: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...originalArguments],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    expect(observedArguments).toEqual(originalArguments);
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before deleting a scheduled task', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjingTest' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(runImpl).not.toHaveBeenCalled();

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjingTest', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { deleted: true, task_name: 'LnwjingTest' } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', ['/Delete', '/TN', 'LnwjingTest', '/F']);
  });

  it('accepts trusted Full Bypass authorization without caller confirmation', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjingTest' }, undefined, authorization))
      .resolves.toMatchObject({ ok: true, value: { deleted: true } });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('previews a deletion without confirmation or schtasks side effects', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SHOULD NOT RUN', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjingTest', dry_run: true }))
      .resolves.toMatchObject({ ok: true, value: { dry_run: true, action: 'delete', task_name: 'LnwjingTest' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['create', 'run'] as const)('requires confirmation before %s', async (action) => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const input = action === 'create'
      ? { action, task_name: 'LnwjingTest', command: 'tool.exe' }
      : { action, task_name: 'LnwjingTest' };

    await expect(backend.execute(input))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['bad/name', '', '\\', '\\\\Task', '\\Folder\\', 'Folder\\..\\Task', 'Folder\\.\\Task', ' Task', 'Task ', 'Folder\\ Task', 'Folder\\Task ', 'bad:name', 'bad*name', 'bad?name', 'bad"name', 'bad<name', 'bad>name', 'bad|name', 'bad\u0000name', 'bad\nname', 'a'.repeat(239)])('rejects invalid task paths without dispatch: %s', async (taskName) => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'delete', task_name: taskName, userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('rejects non-win32 platforms', async () => {
    const backend = new SchedulerCapabilityBackend({ platform: 'linux', runImpl: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }) });

    const result = await backend.execute({ action: 'list' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('returns recoverable errors with stderr detail', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('schtasks failed: access denied');
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'run', task_name: 'MissingTask', userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { recoverable: true } });
  });

  it('warns that a failed mutation may already have completed and never retries schtasks automatically', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('transport interrupted after dispatch');
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'delete', task_name: 'LnwjingTest', userConfirmed: true });

    expect(result).toMatchObject({
      ok: false,
      error: {
        recoverable: true,
        message: expect.stringMatching(/outcome may be unknown.*do not retry automatically/i),
      },
    });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('does not invoke schtasks when the caller is already cancelled', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.execute({ action: 'run', task_name: 'LnwjingTest' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['create', 'run', 'delete'] as const)('reports an unknown %s outcome after dispatched cancellation without retrying', async (action) => {
    const controller = new AbortController();
    const runImpl = vi.fn(async (_executable: string, _args: readonly string[], signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('Interrupted after dispatch', 'AbortError');
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const result = await backend.execute({ action, task_name: '\\Folder\\Task', command: 'tool.exe', userConfirmed: true }, controller.signal);

    expect(result).toMatchObject({ ok: false, error: {
      code: 'PROCESS_TIMEOUT', recoverable: true, message: expect.stringMatching(/outcome may be unknown.*do not retry automatically/i),
    } });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });
});
