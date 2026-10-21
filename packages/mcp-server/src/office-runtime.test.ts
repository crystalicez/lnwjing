import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjing/domain';
import { OfficeRuntimeService } from './office-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'office-runtime-test', clientName: 'office-runtime-test' };

function servicesWithOffice(calls: Array<{ tool: string; input: Record<string, unknown> }>): McpApplicationServices {
  return {
    platform: 'win32',
    capabilities: {
      async execute(tool: string, input: Record<string, unknown>) {
        calls.push({ tool, input });
        if (input.action === 'status') {
          return ok({
            app: input.app,
            action: 'status',
            available: true,
            ready: true,
            provider: 'windows-office-com',
            version: 'test',
          });
        }
        return ok({ app: input.app, action: input.action });
      },
    },
  } as unknown as McpApplicationServices;
}

describe('OfficeRuntimeService provider truthfulness', () => {
  it.each([
    ['office_word', { action: 'print', file_path: 'a.docx' }],
    ['office_excel', { action: 'run_macro', file_path: 'a.xlsm', macro: 'Module1.Run' }],
    ['office_excel', { action: 'refresh_connections', file_path: 'a.xlsx' }],
    ['office_powerpoint', { action: 'export_video', file_path: 'a.pptx', target_path: 'a.mp4' }],
    ['office_outlook', { action: 'permanent_delete', message_id: 'message' }],
    ['office_outlook', { action: 'reply_all_draft', message_id: 'message' }],
    ['office_calendar', { action: 'send_update', event_id: 'event' }],
    ['office_calendar', { action: 'cancel_event', event_id: 'event' }],
    ['office_calendar', { action: 'respond', event_id: 'event', parameters: { response: 'accept' } }],
    ['office_contacts', { action: 'create_group', name: 'group', members: ['a@example.test'] }],
  ] as const)('requires approval and preserves dry-run/cancel boundaries for %s', async (tool, input) => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);
    await expect(runtime.execute(tool, { ...input, dryRun: false })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(runtime.execute(tool, input)).resolves.toMatchObject({ ok: true, value: { dryRun: true, executed: false } });
    const controller = new AbortController(); controller.abort();
    await expect(runtime.execute(tool, { ...input, dryRun: false, userConfirmed: true }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toEqual([]);
  });

  it('rejects missing selectors or buried files before even a dry-run plan', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);
    await expect(runtime.execute('office_word', { action: 'delete_range', file_path: 'a.docx' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(runtime.execute('office_excel', { action: 'insert_image', file_path: 'a.xlsx', parameters: { image_path: 'outside.png' } })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toEqual([]);
  });

  it('normalizes every auxiliary file identity in the replacement-recovery request', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    let requestedSources: readonly string[] = [];
    const services = servicesWithOffice(calls);
    const runtime = new OfficeRuntimeService({ ...services, file: {
      async prepareExternalFileMutation(_actor: unknown, _workspace: string, request: { sourcePaths: readonly string[] }) {
        requestedSources = request.sourcePaths;
        return ok({ sourcePaths: request.sourcePaths.map((source) => `C:/workspace/${source}`), targetPath: 'C:/workspace/new.docx', targetRelativePath: 'new.docx' });
      },
    } } as unknown as McpApplicationServices, actor);
    await expect(runtime.execute('office_word', { action: 'mail_merge', workspaceId: 'ws', file_path: 'template.docx', source_path: 'ข้อมูล.csv', target_path: 'new.docx', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { executed: true } });
    expect(requestedSources).toEqual(['template.docx', 'ข้อมูล.csv']);
    expect(calls[0]?.input).toMatchObject({ file_path: 'C:/workspace/template.docx', source_path: 'C:/workspace/ข้อมูล.csv', target_path: 'C:/workspace/new.docx' });
  });
  it.each([
    ['linux', 'office_word', { action: 'read_text', file_path: 'package.json' }, 'Verified LibreOffice UNO or equivalent native provider for word'],
    ['darwin', 'office_outlook', { action: 'list_folders' }, 'Verified native macOS Office automation provider for outlook'],
  ] as const)('reports actionable non-Windows provider requirements on %s', async (platform, tool, input, requirement) => {
    const runtime = new OfficeRuntimeService({ platform } as unknown as McpApplicationServices, actor);

    const result = await runtime.execute(tool, input);

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool,
        status: 'unsupported',
        available: false,
        ready: false,
        executed: false,
        requirements: [requirement],
      },
    });
  });

  it('plans the implemented macro action without opening or executing a workbook', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    const result = await runtime.execute('office_excel', {
      action: 'run_macro',
      file_path: 'C:\\workspace\\book.xlsm',
      macro: 'Module1.SafeProcedure',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool: 'office_excel',
        status: 'ready',
        available: true,
        ready: true,
        executed: false,
        action: 'run_macro',
      },
    });
    expect(calls).toEqual([]);
  });

  it('reports optional COM dependencies without claiming semantic actions are ready', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    const result = await runtime.execute('office_access', { action: 'status' });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool: 'office_access',
        status: 'unsupported',
        available: true,
        dependencyAvailable: true,
        ready: false,
        executed: true,
        supportedActions: [],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.timeout_seconds).toBe(15);
  });

  it('includes per-tool supported actions in office_status and keeps unsupported optional apps not ready', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    const result = await runtime.execute('office_status', { include_optional: true });

    expect(result).toMatchObject({
      ok: true,
      value: {
        providers: {
          local: {
            apps: {
              excel: {
                ready: true,
                semanticTools: expect.arrayContaining([
                  expect.objectContaining({
                    tool: 'office_excel',
                    supportedActions: expect.arrayContaining(['read_range', 'write_values', 'export_pdf']),
                  }),
                ]),
              },
              access: {
                available: true,
                dependencyAvailable: true,
                ready: false,
                semanticTools: [
                  {
                    tool: 'office_access',
                    supportedActions: [],
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.input.timeout_seconds === 15)).toBe(true);
  });

  it('downgrades Outlook semantic readiness when the bounded COM status probe times out', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const services = {
      platform: 'win32',
      capabilities: {
        async execute(tool: string, input: Record<string, unknown>) {
          calls.push({ tool, input });
          return err(appError('PROCESS_TIMEOUT', 'Windows bridge timed out', true));
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new OfficeRuntimeService(services, actor);

    const result = await runtime.execute('office_outlook', { action: 'status' });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool: 'office_outlook',
        status: 'needs_setup',
        available: false,
        ready: false,
        executed: false,
        provider: 'windows-office-com',
        app: 'outlook',
        action: 'status',
        reason: 'Windows bridge timed out',
      },
    });
    expect(calls).toEqual([{ tool: 'office', input: { app: 'outlook', action: 'status', timeout_seconds: 15 } }]);
  });

  it('verifies conversion output at the canonical provider target for relative paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjing-office-convert-'));
    try {
      const canonicalSource = path.join(root, 'source.docx');
      const canonicalTarget = path.join(root, 'out.pdf');
      await writeFile(canonicalSource, 'source', 'utf8');
      const services = {
        platform: 'win32',
        capabilities: {
          async execute(_tool: string, input: Record<string, unknown>) {
            expect(input.target_path).toBe(canonicalTarget);
            await writeFile(canonicalTarget, '%PDF-1.7\npdf-output', 'utf8');
            return ok({ app: 'word', action: 'export_pdf', target: canonicalTarget });
          },
        },
        file: {
          async prepareExternalFileMutation() {
            return ok({ sourcePaths: [canonicalSource], targetPath: canonicalTarget, targetRelativePath: 'out.pdf' });
          },
        },
      } as unknown as McpApplicationServices;
      const runtime = new OfficeRuntimeService(services, actor);

      const result = await runtime.execute('office_convert', {
        workspaceId: 'ws-1',
        source_path: 'source.docx',
        target_path: 'out.pdf',
        dryRun: false,
        userConfirmed: true,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { tool: 'office_convert', executed: true, verified: true, output: canonicalTarget, outputBytes: 19 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an explicit conversion format that disagrees with the target extension', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    const result = await runtime.execute('office_convert', {
      source_path: 'source.docx',
      target_path: 'out.txt',
      format: 'pdf',
      dryRun: false,
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Office conversion format pdf does not match target extension .txt' },
    });
    expect(calls).toEqual([]);
  });

  it('rejects a conversion result whose bytes do not match the requested target type', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjing-office-convert-type-'));
    try {
      const canonicalSource = path.join(root, 'source.docx');
      const canonicalTarget = path.join(root, 'out.pdf');
      await writeFile(canonicalSource, 'source', 'utf8');
      const services = {
        platform: 'win32',
        capabilities: {
          async execute() {
            await writeFile(canonicalTarget, 'not-a-pdf', 'utf8');
            return ok({ app: 'word', action: 'export_pdf', target: canonicalTarget });
          },
        },
        file: {
          async prepareExternalFileMutation() {
            return ok({ sourcePaths: [canonicalSource], targetPath: canonicalTarget, targetRelativePath: 'out.pdf' });
          },
        },
      } as unknown as McpApplicationServices;
      const runtime = new OfficeRuntimeService(services, actor);

      const result = await runtime.execute('office_convert', {
        workspaceId: 'ws-1',
        source_path: 'source.docx',
        target_path: 'out.pdf',
        dryRun: false,
        userConfirmed: true,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Office conversion output failed target type verification for .pdf' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes Outlook attachment saves through Active Project file safety and canonical target recovery', async () => {
    const canonicalTarget = 'C:\\workspace\\downloads\\invoice.pdf';
    const calls: Array<Record<string, unknown>> = [];
    const services = {
      platform: 'win32',
      capabilities: {
        async execute(_tool: string, input: Record<string, unknown>) {
          calls.push(input);
          return ok({ app: 'outlook', action: 'save_attachment', target: input.target_path, saved: true });
        },
      },
      file: {
        async prepareExternalFileMutation(_actor: unknown, workspaceId: string, request: { sourcePaths?: readonly string[]; targetPath: string }) {
          expect(workspaceId).toBe('ws-1');
          expect(request).toMatchObject({ sourcePaths: [], targetPath: 'downloads\\invoice.pdf' });
          return ok({
            sourcePaths: [],
            targetPath: canonicalTarget,
            targetRelativePath: 'downloads\\invoice.pdf',
            replacementBackup: { recoveryId: 'recovery-1', recoveryPath: 'C:\\trash\\recovery-1' },
          });
        },
      },
    } as unknown as McpApplicationServices;
    const runtime = new OfficeRuntimeService(services, actor);

    const result = await runtime.execute('office_outlook', {
      action: 'save_attachment',
      workspaceId: 'ws-1',
      message_id: 'message-1',
      attachment_id: 1,
      target_path: 'downloads\\invoice.pdf',
      dryRun: false,
      userConfirmed: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'save_attachment', target_path: canonicalTarget });
    expect(result).toMatchObject({
      ok: true,
      value: {
        executed: true,
        replacementBackup: { recoveryId: 'recovery-1', recoveryPath: 'C:\\trash\\recovery-1' },
      },
    });
  });

  it('keeps non-dry-run batch execution truthful and fail-fast on semantic provider unavailability', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    const result = await runtime.execute('office_batch', {
      dryRun: false,
      operations: [
        { tool: 'office_onenote', input: { action: 'list_notebooks' } },
        { tool: 'office_word', input: { action: 'read_text', file_path: 'C:\\workspace\\later.docx' } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool: 'office_batch',
        executed: false,
        dryRun: false,
        failFast: true,
        operationCount: 2,
        results: [{ ok: true, value: { status: 'needs_setup', ready: false, executed: false } }],
      },
    });
    expect(calls).toEqual([]);
  });

  it('bounds provider execution timeouts while preserving a smaller explicit timeout', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const runtime = new OfficeRuntimeService(servicesWithOffice(calls), actor);

    await runtime.execute('office_outlook', { action: 'list_messages', max_messages: 250, timeout_seconds: 999 });
    await runtime.execute('office_outlook', { action: 'list_messages', max_messages: 1, timeout_seconds: 7 });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({ action: 'list_messages', max_messages: 100, timeout_seconds: 120 });
    expect(calls[1]?.input).toMatchObject({ action: 'list_messages', max_messages: 1, timeout_seconds: 7 });
  });
});
