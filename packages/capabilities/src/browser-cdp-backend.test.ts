import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appError, err, type Result } from '@lnwjing/domain';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from './task-ownership.js';
import { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';

const tab = (id: string, title: string, url: string): BrowserCdpTab => ({
  id,
  title,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
});

function protocolStub(options: {
  readonly tabs: readonly BrowserCdpTab[];
  readonly onRequest?: (tabId: string, method: string, params: Record<string, unknown>) => void;
  readonly responseForRequest?: (tabId: string, method: string, params: Record<string, unknown>) => unknown;
  readonly onClose?: (tabId: string) => void;
}): BrowserCdpProtocol {
  return {
    async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: true, port: 9222 }; },
    async listTabs(): Promise<readonly BrowserCdpTab[]> { return options.tabs; },
    async newTab(url): Promise<BrowserCdpTab> { return tab('new-tab', '', url); },
    async closeTab(tabId): Promise<unknown> { options.onClose?.(tabId); return { closed: true }; },
    async request(tabId, method, params): Promise<unknown> {
      options.onRequest?.(tabId, method, params);
      if (options.responseForRequest !== undefined) return options.responseForRequest(tabId, method, params);
      if (method === 'Page.captureScreenshot') return { result: { data: 'aGVsbG8=' } };
      if (method === 'Page.navigate') return { result: { frameId: 'fixture-frame', loaderId: 'fixture-loader' } };
      return { result: { result: { value: method === 'Runtime.evaluate' ? { ok: true, text: 'hello', tag: 'DIV' } : { ok: true } } } };
    },
  };
}

function reorderingProtocolStub(options: {
  readonly first: readonly BrowserCdpTab[];
  readonly later: readonly BrowserCdpTab[];
  readonly onRequest: (tabId: string) => void;
}): BrowserCdpProtocol {
  let listCount = 0;
  const base = protocolStub({ tabs: options.first, onRequest: (tabId) => options.onRequest(tabId) });
  return {
    ...base,
    async listTabs(): Promise<readonly BrowserCdpTab[]> {
      listCount += 1;
      return listCount === 1 ? options.first : options.later;
    },
  };
}

function protectedActionInput(action: 'navigate' | 'close_tab' | 'evaluate' | 'click' | 'type' | 'set_files'): Record<string, unknown> {
  const parameters = action === 'navigate'
    ? { url: 'https://example.com/' }
    : action === 'evaluate'
      ? { expression: 'document.title' }
      : action === 'click'
        ? { selector: '#continue' }
        : action === 'type'
          ? { selector: '#prompt', text: 'test' }
          : action === 'set_files'
            ? { selector: 'input[type=file]', files: ['C:\\fixture.txt'] }
            : {};
  return { action, tab_id: 'chatgpt-tab', parameters, userConfirmed: true };
}

describe('BrowserCdpBackend', () => {
  it('runs a DOM query through the Chrome DevTools protocol', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#app' } });

    expect(result).toMatchObject({ ok: true, value: { ok: true, text: 'hello', tag: 'DIV' } });
    expect(requests[0]?.method).toBe('Runtime.evaluate');
    expect(requests[0]?.params.expression).toContain('document.querySelector');
  });

  it('returns a structured acknowledgement for Page.navigate without claiming page-load completion', async () => {
    const protocol = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/next' },
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        navigation_requested: true,
        navigation_complete: false,
        frame_id: 'fixture-frame',
        loader_id: 'fixture-loader',
      },
    });
  });

  it.each([
    ['protocol error', { error: { code: -32000, message: 'secret raw protocol detail' } }],
    ['navigation error', { result: { frameId: 'fixture-frame', errorText: 'net::ERR_NAME_NOT_RESOLVED' } }],
    ['malformed response', { result: {} }],
  ] as const)('rejects a %s from Page.navigate without returning raw protocol details', async (_label, response) => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: () => response,
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/next' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    if (!result.ok) {
      expect(result.error.message).not.toContain('secret raw protocol detail');
      expect(result.error.message).not.toContain('ERR_NAME_NOT_RESOLVED');
    }
  });

  it('marks Page.navigate download responses without claiming completion', async () => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: () => ({ result: { frameId: 'fixture-frame', isDownload: true } }),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/download' },
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        navigation_requested: true,
        navigation_complete: false,
        frame_id: 'fixture-frame',
        is_download: true,
      },
    });
  });

  it('does not navigate any tab when tab_id is absent', async () => {
    const requested: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard/project'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      parameters: { url: 'https://supabase.com/dashboard/project/sql' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('tab_id') },
    });
    expect(requested).toEqual([]);
  });

  it('keeps every step on the explicit tab when list ordering changes', async () => {
    const requested: string[] = [];
    const protocol = reorderingProtocolStub({
      first: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      later: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: '#sql-editor' } },
        { action: 'click', parameters: { selector: '#run' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requested).toEqual(['supabase-tab', 'supabase-tab']);
  });

  it('does not dispatch later DOM side effects after the caller aborts', async () => {
    const actions: string[] = [];
    const controller = new AbortController();
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method) => {
        actions.push(method);
        controller.abort();
      },
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      steps: [
        { action: 'query', parameters: { selector: '#one' } },
        { action: 'click', parameters: { selector: '#one' } },
      ],
      tab_id: 'tab-1',
    }, controller.signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(actions).toEqual(['Runtime.evaluate']);
  });

  it.each(['navigate', 'close_tab', 'evaluate', 'click', 'type', 'set_files'] as const)(
    'blocks %s on a ChatGPT tab without an explicit protected-tab confirmation',
    async (action) => {
      const requests: string[] = [];
      const closes: string[] = [];
      const protocol = protocolStub({
        tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
        onRequest: (tabId) => requests.push(tabId),
        onClose: (tabId) => closes.push(tabId),
      });

      const result = await new BrowserCdpBackend({ protocol }).execute(protectedActionInput(action));

      expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(requests).toEqual([]);
      expect(closes).toEqual([]);
    },
  );

  it('does not let Full Bypass imply protected-tab confirmation', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });
    const authorization = {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    } as const;

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      parameters: { url: 'https://example.com/' },
    }, undefined, authorization);

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(requests).toEqual([]);
  });

  it('allows an explicitly confirmed protected-tab action', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      allow_protected_tab_action: true,
      parameters: { url: 'https://example.com/' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['chatgpt-tab']);
  });

  it('rejects an unknown explicit tab without dispatch', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'missing-tab',
      parameters: { selector: 'body' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('rejects step-level tab switching', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: 'body' } },
        { action: 'click', parameters: { selector: '#run', tab_id: 'chatgpt-tab' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('normalizes a legacy direct parameters.tab_id once', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Legacy', 'https://example.com/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      parameters: { selector: 'body', tab_id: 'tab-1' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['tab-1']);
  });

  it('rejects conflicting top-level and legacy direct tab IDs', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'One', 'https://example.com/'), tab('tab-2', 'Two', 'https://example.org/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'tab-1',
      parameters: { selector: 'body', tab_id: 'tab-2' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('starts managed Chrome on demand once and reuses the ready runtime', async () => {
    let ready = false;
    let launches = 0;
    const base = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: async (): Promise<Result<unknown>> => {
        launches += 1;
        await Promise.resolve();
        ready = true;
        return { ok: true, value: { ready: true, port: 9222, launched: true } };
      },
    });

    await Promise.all([
      expect(backend.execute({ action: 'list_tabs' })).resolves.toMatchObject({ ok: true }),
      expect(backend.execute({ action: 'list_tabs' })).resolves.toMatchObject({ ok: true }),
    ]);
    await expect(backend.execute({ action: 'list_tabs' })).resolves.toMatchObject({ ok: true });
    expect(launches).toBe(1);
  });

  it('keeps a shared browser start alive when one concurrent waiter aborts', async () => {
    let launches = 0;
    let resolveLaunch!: (result: Result<unknown>) => void;
    const base = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: (_url, signal): Promise<Result<unknown>> => {
        launches += 1;
        return new Promise((resolve) => {
          resolveLaunch = resolve;
          signal?.addEventListener('abort', () => resolve(err(appError('PROCESS_TIMEOUT', 'launcher cancelled', true))), { once: true });
        });
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = backend.ensureStarted(undefined, firstController.signal);
    await Promise.resolve();
    const second = backend.ensureStarted(undefined, secondController.signal);
    await Promise.resolve();
    firstController.abort();

    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    resolveLaunch({ ok: true, value: { ready: true, port: 9222, launched: true } });
    await expect(second).resolves.toMatchObject({ ok: true, value: { ready: true, port: 9222, launched: true } });
    expect(launches).toBe(1);
  });

  it('does not start or dispatch a mutating DOM action without confirmation', async () => {
    let dispatched = false;
    let launches = 0;
    const base = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: async (): Promise<Result<unknown>> => {
        launches += 1;
        return { ok: true, value: { ready: true, port: 9222, launched: true } };
      },
    });

    await expect(backend.execute({ action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(launches).toBe(0);
    expect(dispatched).toBe(false);
  });

  it('accepts trusted Full Bypass authorization for a mutating non-protected DOM action', async () => {
    let dispatched = false;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(new BrowserCdpBackend({ protocol }).execute(
      { action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } },
      undefined,
      authorization,
    )).resolves.toMatchObject({ ok: true });
    expect(dispatched).toBe(true);
  });

  it('types into a standard input element using property setter and synthetic events', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          return { result: { result: { value: { ok: true, isContentEditable: false, value: 'typed-text', tag: 'INPUT' } } } };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'input#title', text: 'typed-text' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        typed: true,
        isContentEditable: false,
        value: 'typed-text',
        text: 'typed-text',
      },
    });
    expect(requests.some((req) => req.method === 'Runtime.evaluate')).toBe(true);
    expect(requests.some((req) => req.method === 'Input.insertText')).toBe(false);
  });

  it('types into a ProseMirror or contenteditable element by dispatching CDP Input.insertText', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    let evalCount = 0;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          evalCount += 1;
          if (evalCount === 1) {
            return { result: { result: { value: { ok: true, isContentEditable: true, tag: 'DIV' } } } };
          }
          return { result: { result: { value: { ok: true, text: 'Hello ProseMirror' } } } };
        }
        if (method === 'Input.insertText') {
          return { result: {} };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'div.ProseMirror', text: 'Hello ProseMirror' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        typed: true,
        isContentEditable: true,
        tag: 'DIV',
        text: 'Hello ProseMirror',
        value: 'Hello ProseMirror',
      },
    });
    const insertTextCall = requests.find((req) => req.method === 'Input.insertText');
    expect(insertTextCall).toBeDefined();
    expect(insertTextCall?.params).toEqual({ text: 'Hello ProseMirror' });
  });

  it('does not report success when CDP insertText leaves a contenteditable unchanged', async () => {
    let evalCount = 0;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          evalCount += 1;
          if (evalCount === 1) {
            return { result: { result: { value: { ok: true, isContentEditable: true, tag: 'DIV', text: '' } } } };
          }
          return { result: { result: { value: { ok: true, text: '' } } } };
        }
        if (method === 'Input.insertText') return { result: {} };
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'div.ProseMirror', text: 'Hello ProseMirror' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('returns structured not-found error when typing into a missing element', async () => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          return { result: { result: { value: { ok: false, error: 'Element not found' } } } };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: '#does-not-exist', text: 'test' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: 'Element not found',
        selector: '#does-not-exist',
      },
    });
  });

  it('activates only the explicitly pinned tab before native fallback', async () => {
    const requests: { readonly tabId: string; readonly method: string }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-a', 'A', 'https://example.com/a'), tab('tab-b', 'B', 'https://example.com/b')],
      onRequest: (tabId, method) => requests.push({ tabId, method }),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'activate_tab',
      tab_id: 'tab-b',
      userConfirmed: true,
    });

    expect(result).toEqual({ ok: true, value: { activated: true, tab_id: 'tab-b' } });
    expect(requests).toEqual([{ tabId: 'tab-b', method: 'Page.bringToFront' }]);
  });

  it('sets browser file inputs only from files inside the Active Project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-browser-upload-'));
    const nested = path.join(root, '0-fixture');
    const file = path.join(nested, 'fixture.txt');
    await mkdir(nested);
    await writeFile(file, 'fixture');
    const canonicalFile = await realpath(file);
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Upload', 'https://example.com/upload')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'DOM.getDocument') return { result: { root: { nodeId: 1 } } };
        if (method === 'DOM.querySelector') return { result: { nodeId: 7 } };
        return { result: {} };
      },
    });

    try {
      const result = await new BrowserCdpBackend({ protocol }).execute({
        action: 'set_files',
        tab_id: 'tab-1',
        parameters: { selector: 'input[type=file]', files: [file] },
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root },
        userConfirmed: true,
      });

      expect(result).toEqual({ ok: true, value: { files_set: true, tab_id: 'tab-1', file_count: 1 } });
      expect(requests.map((request) => request.method)).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
      expect(requests[2]?.params).toMatchObject({ nodeId: 7, files: [canonicalFile] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects browser file uploads outside the Active Project before any CDP mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-browser-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-browser-outside-'));
    const file = path.join(outside, 'fixture.txt');
    await writeFile(file, 'fixture');
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Upload', 'https://example.com/upload')],
      onRequest: (_tabId, method) => requests.push(method),
    });

    try {
      const result = await new BrowserCdpBackend({ protocol }).execute({
        action: 'set_files',
        tab_id: 'tab-1',
        parameters: { selector: 'input[type=file]', files: [file] },
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root },
        userConfirmed: true,
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      expect(requests).toEqual([]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
