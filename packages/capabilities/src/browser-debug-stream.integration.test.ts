import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessTreeTerminator } from '@lnwjing/process';
import { BrowserCdpBackend, type BrowserCdpEventChannel } from './browser-cdp-backend.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';

const executable = process.env.LNWJING_REAL_BROWSER_TEST_EXECUTABLE;

describe('installed browser retained observations', () => {
  it.skipIf(executable === undefined)('observes two real tabs and preserves browser ownership through cancellation and shutdown', async () => {
    if (executable === undefined) throw new Error('An installed browser executable is required');
    const profile = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-browser-proof-'));
    const http = createServer((request, response) => {
      if (request.url?.startsWith('/api')) { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); return; }
      const name = request.url === '/b' ? 'tab-b' : 'tab-a';
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(`<!doctype html><html><head><title>${name}</title></head><body><h1>Retained browser observations</h1><p>${name} ไทย 😀</p><script>console.log(${JSON.stringify(`  ${name} ไทย 😀\r\n`)});console.warn('token=fixture-secret');fetch('/api?token=fixture-secret',{headers:{Authorization:'Bearer fixture-header'},method:'POST',body:'fixture-body'}).then(()=>{console.log(${JSON.stringify(`${name} request complete`)});window.fixtureDone=true});</script></body></html>`);
    });
    const httpPort = await listen(http);
    const portProbe = createServer();
    const cdpPort = await listen(portProbe);
    await closeServer(portProbe);
    const browser = spawn(executable, ['--headless=new', '--enable-automation', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, 'about:blank'], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
    const protocol = new NodeBrowserCdpProtocol({ port: cdpPort, chromeExecutable: executable });
    const channels: BrowserCdpEventChannel[] = [];
    const open = protocol.openEventChannel.bind(protocol);
    protocol.openEventChannel = async (...args): Promise<BrowserCdpEventChannel> => {
      const channel = await open(...args);
      channels.push(channel);
      return channel;
    };
    const backend = new BrowserCdpBackend({ protocol });
    let phase = 'browser startup';
    let primaryFailure: unknown = null;
    const cleanupFailures: unknown[] = [];
    let attestedTabId: string | null = null;
    try {
      await until(async () => (await protocol.status()).ready);
      const first = await protocol.newTab('about:blank');
      const second = await protocol.newTab('about:blank');
      const commandLine = await protocol.request(first.id, 'Browser.getBrowserCommandLine', {});
      if (!isRecord(commandLine) || !isRecord(commandLine.result) || !Array.isArray(commandLine.result.arguments)
        || !commandLine.result.arguments.includes(`--user-data-dir=${profile}`) || !commandLine.result.arguments.includes(`--remote-debugging-port=${cdpPort}`)) throw new Error('The browser fixture process identity was not attested');
      attestedTabId = first.id;
      const firstId = streamId(await backend.execute(start(first.id)));
      const secondId = streamId(await backend.execute(start(second.id)));
      await protocol.request(first.id, 'Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
      await protocol.request(second.id, 'Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
      await until(async () => JSON.stringify(await backend.execute(read(firstId))).includes('tab-a request complete'));
      await until(async () => JSON.stringify(await backend.execute(read(secondId))).includes('tab-b request complete'));
      const firstPage = success(await backend.execute(read(firstId)));
      const secondPage = success(await backend.execute(read(secondId)));
      expect(JSON.stringify(firstPage)).toContain('  tab-a ไทย 😀\\r\\n');
      expect(JSON.stringify(firstPage)).not.toContain('tab-b');
      expect(JSON.stringify(secondPage)).toContain('  tab-b ไทย 😀\\r\\n');
      expect(JSON.stringify(secondPage)).not.toContain('tab-a');
      for (const page of [firstPage, secondPage]) {
        expect(page).toMatchObject({ state: 'active', gap: false, source: 'chrome_devtools_protocol' });
        const encoded = JSON.stringify(page);
        for (const secret of ['fixture-secret', 'fixture-header', 'fixture-body']) expect(encoded).not.toContain(secret);
        expect(encoded).toContain('Network.requestWillBeSent');
        expect(encoded).toContain('Network.responseReceived');
        expect(encoded).toContain('Runtime.consoleAPICalled');
      }
      const foreign = await backend.execute({ ...read(firstId), metadata: metadata('foreign-session') });
      expect(foreign).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
      phase = 'real channel reconnect';
      const firstChannel = channels[0];
      if (firstChannel === undefined) throw new Error('The real retained channel was missing');
      await firstChannel.close();
      expect(await backend.execute(control(firstId, 'status'))).toMatchObject({ ok: true, value: { state: 'disconnected', gap: true } });
      expect(await backend.execute(control(firstId, 'reconnect'))).toMatchObject({ ok: true, value: { state: 'active', gap: true } });
      await protocol.request(first.id, 'Runtime.evaluate', { expression: "console.log('first stream after reconnect')", returnByValue: true });
      await until(async () => JSON.stringify(await backend.execute(read(firstId))).includes('first stream after reconnect'));
      const firstPageAfterReconnect = success(await backend.execute(read(firstId)));
      expect(firstPageAfterReconnect).toMatchObject({ gap: true, completeness: 'partial_after_gap' });
      phase = 'real pending command cancellation';
      const channel = await protocol.openEventChannel(first.id, () => undefined, () => undefined);
      await channel.request('Runtime.enable', {});
      const abort = new AbortController();
      const pending = channel.request('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true, returnByValue: true }, abort.signal);
      const cancelled = pending.then(() => false, (error: unknown) => error instanceof Error && error.message.includes('cancelled'));
      abort.abort();
      expect(await cancelled).toBe(true);
      await channel.close();
      await protocol.request(second.id, 'Runtime.evaluate', { expression: "console.log('second stream after cancellation')", returnByValue: true });
      await until(async () => JSON.stringify(await backend.execute(read(secondId))).includes('second stream after cancellation'));
      const evidenceDir = process.env.LNWJING_BROWSER_PROOF_OUTPUT;
      if (evidenceDir !== undefined) {
        await mkdir(evidenceDir, { recursive: true });
        const screenshot = await protocol.request(first.id, 'Page.captureScreenshot', { format: 'png' });
        if (!isRecord(screenshot) || !isRecord(screenshot.result) || typeof screenshot.result.data !== 'string') throw new Error('Real browser screenshot was missing');
        await writeFile(path.join(evidenceDir, 'lane-01.png'), Buffer.from(screenshot.result.data, 'base64'));
        await writeFile(path.join(evidenceDir, 'real-browser-evidence.json'), JSON.stringify({ firstPage, secondPage, firstPageAfterReconnect, foreign, pendingRequestCancelled: true, selectedTabIdsDiffer: first.id !== second.id, browserStillReadyBeforeShutdown: (await protocol.status()).ready }, null, 2));
      }
      phase = 'subscription shutdown';
      await backend.close();
      expect((await protocol.status()).ready).toBe(true);
      const tabs = await protocol.listTabs();
      expect(tabs.some((tab) => tab.id === first.id)).toBe(true);
      expect(tabs.some((tab) => tab.id === second.id)).toBe(true);
      expect(await backend.execute(start(first.id))).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    } catch (error) {
      primaryFailure = error;
    } finally {
      try { await backend.close(); } catch (error) { cleanupFailures.push(error); }
      try { await stopBrowser(browser, protocol, attestedTabId); } catch (error) { cleanupFailures.push(error); }
      await closeServer(http);
      if (cleanupFailures.length === 0) await rm(profile, { recursive: true, force: true });
    }
    if (cleanupFailures.length > 0) throw new AggregateError(primaryFailure === null ? cleanupFailures : [primaryFailure, ...cleanupFailures], `Real browser fixture cleanup failed after ${phase}`);
    if (primaryFailure !== null) throw primaryFailure;
  }, 45_000);
});

function metadata(sessionId = 'real-browser-session'): Record<string, unknown> { return { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'real-browser-fixture', sessionId, workspaceId: 'browser-fixture-workspace' } }; }
function start(tabId: string): Record<string, unknown> { return { action: 'debug_stream', tab_id: tabId, metadata: metadata(), parameters: { operation: 'start' } }; }
function read(streamId: string): Record<string, unknown> { return { action: 'debug_stream', metadata: metadata(), parameters: { operation: 'read', stream_id: streamId, limit: 1000, max_bytes: 1_048_576 } }; }
function control(streamId: string, operation: string): Record<string, unknown> { return { action: 'debug_stream', metadata: metadata(), parameters: { operation, stream_id: streamId } }; }
function success(value: unknown): Record<string, unknown> { if (!isRecord(value) || value.ok !== true || !isRecord(value.value)) throw new Error(`Real browser operation failed ${JSON.stringify(value)}`); return value.value; }
function streamId(value: unknown): string { const result = success(value); if (typeof result.stream_id !== 'string') throw new Error('Real browser stream ID missing'); return result.stream_id; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function listen(server: Server): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address === null || typeof address === 'string') reject(new Error('Fixture address unavailable')); else resolve(address.port); }); }); }
function closeServer(server: Server): Promise<void> { server.closeAllConnections(); return new Promise((resolve) => server.close(() => resolve())); }
async function until(predicate: () => Promise<boolean>): Promise<void> { const deadline = Date.now() + 20_000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('Real browser observation timed out'); await new Promise((resolve) => setTimeout(resolve, 25)); } }
async function stopBrowser(browser: ChildProcess, protocol: NodeBrowserCdpProtocol, attestedTabId: string | null): Promise<void> {
  if (attestedTabId !== null) {
    let gracefulReceipt = false;
    try {
      const response = await protocol.request(attestedTabId, 'Browser.close', {});
      gracefulReceipt = isRecord(response) && isRecord(response.result) && response.error === undefined;
    } catch { gracefulReceipt = false; }
    if (gracefulReceipt) {
      const deadline = Date.now() + 2000;
      while (browser.exitCode === null && browser.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (browser.exitCode !== null || browser.signalCode !== null) return;
    }
  }
  if (browser.pid !== undefined) await createProcessTreeTerminator().stop(browser, browser.pid);
}
