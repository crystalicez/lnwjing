import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeHostProcessBridge } from './native-host-protocol.js';
import type { CapabilityTaskOwner } from './task-ownership.js';
import type { ProcessTreeTerminator } from '@lnwjing/process';

const fixtureSource = `
import readline from 'node:readline';
const handles = new Map();
let nextReference = 0;
for await (const line of readline.createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  const input = request.input ?? {};
  const reply = (value) => process.stdout.write(JSON.stringify({id:request.id,ok:true,value})+'\\n');
  if (input.action === 'block') {
    process.stdout.write(JSON.stringify({id:'fixture-blocked',ok:true,value:{pid:process.pid}})+'\\n');
    continue;
  }
  if (input.action === 'failed_stop') {
    process.stdout.write(JSON.stringify({id:request.id,ok:false,error:{code:'PROCESS_TIMEOUT',message:'Owned helper cleanup failed',recoverable:true}})+'\\n');
    continue;
  }
  if (input.action === 'record') {
    const handle = 'fixture-'+process.pid+'-'+handles.size;
    handles.set(handle,{handle,state:'running',pid:process.pid});
    reply(handles.get(handle));
  } else if (input.action === 'portal') {
    const session_id = 'portal-'+process.pid+'-'+request.operation+'-'+nextReference++;
    handles.set(session_id,{session_id,state:'granted',pid:process.pid});
    reply(handles.get(session_id));
  } else if (input.action === 'release_all') {
    const released_session_ids = [...handles.keys()].filter(id => id.includes('-input_event-') && (!input.session_id || id === input.session_id));
    for (const id of released_session_ids) handles.delete(id);
    reply({released:true,closed:true,released_session_ids:input.release_id ? [input.release_id] : released_session_ids,scope:input.session_id ? 'session' : 'owned_remote_desktop_sessions'});
  } else if (input.handle || input.session_id) {
    const value = handles.get(input.handle ?? input.session_id);
    if (value) {
      if (input.action === 'stop') value.state = 'completed';
      reply(value);
    }
    else process.stdout.write(JSON.stringify({id:request.id,ok:false,error:{code:'PERMISSION_DENIED',message:'Missing owned handle',recoverable:false}})+'\\n');
  } else reply({pid:process.pid,operation:request.operation,text:input.text});
}
`;

const fixtures: { readonly root: string; readonly bridge: NativeHostProcessBridge; readonly children: ChildProcess[] }[] = [];
const stopChild: ProcessTreeTerminator['stop'] = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.bridge.close();
    for (const child of fixture.children) await stopChild(child, child.pid!);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function owned(owner: CapabilityTaskOwner, input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, metadata: { 'lnwjing.taskOwner.v1': owner } };
}

async function fixture(terminator: ProcessTreeTerminator = { stop: stopChild }, ownerIdleTtlMs?: number): Promise<typeof fixtures[number]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-owner-'));
  const helper = path.join(root, 'fixture.mjs');
  await writeFile(helper, fixtureSource, 'utf8');
  const canonicalHelper = await realpath(helper);
  const bytes = await readFile(canonicalHelper);
  const children: ChildProcess[] = [];
  const bridge = new NativeHostProcessBridge({
    platform: 'linux', executablePath: canonicalHelper, expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedSizeBytes: bytes.byteLength, requireIntegrity: true,
    timeoutMs: 5_000, terminator,
    ...(ownerIdleTtlMs === undefined ? {} : { ownerIdleTtlMs }),
    spawnProcess: (executable, _args, options): ReturnType<typeof spawn> => {
      const child = spawn(process.execPath, [executable], options);
      children.push(child);
      return child;
    },
  });
  const result = { root, bridge, children };
  fixtures.push(result);
  return result;
}

const ownerA = { clientId: 'clientA', sessionId: 'sessionA', workspaceId: 'workspaceA' };
const ownerB = { clientId: 'clientB', sessionId: 'sessionB', workspaceId: 'workspaceB' };

describe('native host process ownership', () => {
  it('invalidates only the owned partition after a native timeout cleanup failure', async () => {
    const { bridge, children } = await fixture();
    const first = await bridge.execute('input_event', owned(ownerA, { action: 'portal' }));
    const other = await bridge.execute('input_event', owned(ownerB, { action: 'portal' }));
    if (!first.ok || !other.ok) throw new Error('Fixture portals did not start');
    const firstId = (first.value as { session_id: string }).session_id;
    const otherId = (other.value as { session_id: string }).session_id;
    await expect(bridge.execute('input_event', owned(ownerA, { action: 'failed_stop', session_id: firstId }))).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(bridge.execute('input_event', owned(ownerA, { action: 'status', session_id: firstId }))).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(bridge.execute('input_event', owned(ownerB, { action: 'status', session_id: otherId }))).resolves.toMatchObject({ ok: true });
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
    expect(children[1]!.exitCode === null && children[1]!.signalCode === null).toBe(true);
  });
  it('refuses a foreign released-session receipt without terminating the other owner', async () => {
    const { bridge, children } = await fixture();
    const other = await bridge.execute('input_event', owned(ownerB, { action: 'portal' }));
    if (!other.ok) throw new Error('Fixture portal did not start');
    const sessionId = (other.value as { session_id: string }).session_id;
    await expect(bridge.execute('input_event', owned(ownerA, { action: 'release_all', release_id: sessionId }))).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(bridge.execute('input_event', owned(ownerB, { action: 'status', session_id: sessionId }))).resolves.toMatchObject({ ok: true });
    expect(children[0]!.exitCode === null && children[0]!.signalCode === null).toBe(true);
    expect(children[1]!.exitCode !== null || children[1]!.signalCode !== null).toBe(true);
  });
  it('retires verified released portal IDs without consuming capacity or discarding another owner and capability', async () => {
    const { bridge, children } = await fixture();
    const other = await bridge.execute('input_event', owned(ownerB, { action: 'portal' }));
    const screen = await bridge.execute('vision', owned(ownerA, { action: 'portal' }));
    if (!other.ok || !screen.ok) throw new Error('Fixture portals did not start');
    const otherId = (other.value as { session_id: string }).session_id;
    const screenId = (screen.value as { session_id: string }).session_id;
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      const started = await bridge.execute('input_event', owned(ownerA, { action: 'portal' }));
      if (!started.ok) throw new Error(`Portal admission failed at cycle ${cycle}`);
      const sessionId = (started.value as { session_id: string }).session_id;
      await expect(bridge.execute('input_event', owned(ownerA, { action: 'release_all' }))).resolves.toMatchObject({ ok: true, value: { released_session_ids: [sessionId], closed: true } });
      await expect(bridge.execute('input_event', owned(ownerA, { action: 'status', session_id: sessionId }))).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
    await expect(bridge.execute('input_event', owned(ownerB, { action: 'status', session_id: otherId }))).resolves.toMatchObject({ ok: true });
    await expect(bridge.execute('vision', owned(ownerA, { action: 'status', session_id: screenId }))).resolves.toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
  });
  it('keeps another owner recording alive when an actual native request is cancelled', async () => {
    const { bridge, children } = await fixture();
    const recording = await bridge.execute('audio', owned(ownerB, { action: 'record' }));
    expect(recording).toMatchObject({ ok: true, value: { state: 'running' } });
    if (!recording.ok) throw new Error('Recording did not start');
    const handle = (recording.value as { handle: string }).handle;
    await bridge.execute('audio', owned(ownerA, { action: 'status' }));
    const controller = new AbortController();
    const entered = new Promise<void>((resolve) => children[1]!.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('fixture-blocked')) resolve(); }));
    const blocked = bridge.execute('audio', owned(ownerA, { action: 'block' }), controller.signal);
    await entered;
    controller.abort();
    await expect(blocked).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(bridge.execute('audio', owned(ownerB, { action: 'status', handle }))).resolves.toMatchObject({ ok: true, value: { state: 'running', handle } });
    expect(children).toHaveLength(2);
    expect(children[0]!.exitCode === null && children[0]!.signalCode === null).toBe(true);
    expect(children[1]!.exitCode !== null || children[1]!.signalCode !== null).toBe(true);
  });

  it('uses the existing owner partition for an omitted-workspace handle and cross-capability portal', async () => {
    const { bridge, children } = await fixture();
    const portal = await bridge.execute('vision', owned(ownerA, { action: 'portal' }));
    if (!portal.ok) throw new Error('Portal did not start');
    const sessionId = (portal.value as { session_id: string }).session_id;
    await expect(bridge.execute('screen_record', owned({ clientId: ownerA.clientId, sessionId: ownerA.sessionId }, { action: 'status', session_id: sessionId }))).resolves.toMatchObject({ ok: true, value: { session_id: sessionId, state: 'granted' } });
    await expect(bridge.execute('input_event', owned(ownerA, { action: 'release_all', session_id: sessionId }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const recording = await bridge.execute('audio', owned(ownerA, { action: 'record' }));
    if (!recording.ok) throw new Error('Recording did not start');
    const handle = (recording.value as { handle: string }).handle;
    await expect(bridge.execute('audio', owned({ clientId: ownerA.clientId, sessionId: ownerA.sessionId }, { action: 'status', handle }))).resolves.toMatchObject({ ok: true, value: { handle, state: 'running' } });
    expect(children).toHaveLength(1);
  });

  it.each([
    { ...ownerA, clientId: 'other-client' },
    { ...ownerA, sessionId: 'other-session' },
    { ...ownerA, workspaceId: 'other-workspace' },
  ])('denies a foreign handle without spawning or touching its owner', async (requester) => {
    const { bridge, children } = await fixture();
    const recording = await bridge.execute('audio', owned(ownerA, { action: 'record' }));
    if (!recording.ok) throw new Error('Recording did not start');
    const handle = (recording.value as { handle: string }).handle;
    await expect(bridge.execute('audio', owned(requester, { action: 'stop', handle }))).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', handle }))).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
    expect(children).toHaveLength(1);
  });

  it.each([{}, { clientId: 'only-client' }, { clientId: 'a', sessionId: 'b', workspaceId: 12 }, { clientId: 'a\0', sessionId: 'b' }])('rejects malformed reserved owner metadata before a helper starts', async (owner) => {
    const { bridge, children } = await fixture();
    await expect(bridge.execute('audio', { action: 'record', metadata: { 'lnwjing.taskOwner.v1': owner } })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(children).toHaveLength(0);
  });

  it('quarantines failed owner cleanup while other owners remain usable', async () => {
    let failNext = true;
    const { bridge, children } = await fixture({ stop: async (child, pid) => {
      if (failNext) { failNext = false; throw new Error('Controlled unverified termination'); }
      await stopChild(child, pid);
    } });
    await bridge.execute('audio', owned(ownerA, { action: 'status' }));
    const controller = new AbortController();
    const pending = bridge.execute('audio', owned(ownerA, { action: 'block' }), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('termination could not be verified') } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'record' }))).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('refusing to reuse') } });
    await expect(bridge.execute('audio', owned(ownerB, { action: 'record' }))).resolves.toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
  });

  it('closes every owned process and rejects work after host shutdown', async () => {
    const { bridge, children } = await fixture();
    await Promise.all([bridge.execute('audio', owned(ownerA, { action: 'record' })), bridge.execute('audio', owned(ownerB, { action: 'record' }))]);
    await expect(bridge.close()).resolves.toEqual({ ok: true, value: undefined });
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    await expect(bridge.execute('audio', owned(ownerA, { action: 'record' }))).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(children).toHaveLength(2);
  });

  it('cannot leave a new helper running when shutdown races integrity validation', async () => {
    const { bridge, children } = await fixture();
    const starting = bridge.execute('audio', owned(ownerA, { action: 'record' }));
    await expect(bridge.close()).resolves.toEqual({ ok: true, value: undefined });
    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(children).toHaveLength(0);
  });

  it('reaps an inactive owner partition and invalidates its resource identities', async () => {
    const { bridge, children } = await fixture({ stop: stopChild }, 10);
    const recording = await bridge.execute('audio', owned(ownerA, { action: 'record' }));
    if (!recording.ok) throw new Error('Recording did not start');
    const handle = (recording.value as { handle: string }).handle;
    await once(children[0]!, 'close');
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', handle }))).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'record' }))).resolves.toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
  });

  it('normalizes nested resource identity and rejects conflicting duplicates before dispatch', async () => {
    const { bridge, children } = await fixture();
    const recording = await bridge.execute('audio', owned(ownerA, { action: 'record' }));
    if (!recording.ok) throw new Error('Recording did not start');
    const handle = (recording.value as { handle: string }).handle;
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', parameters: { handle } }))).resolves.toMatchObject({ ok: true, value: { handle } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'stop', handle, parameters: { handle: 'other' } }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(bridge.execute('audio', owned(ownerB, { action: 'stop', parameters: { handle } }))).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(children).toHaveLength(1);
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', handle }))).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
  });

  it('bounds live handles without evicting them and reuses capacity after a verified terminal receipt', async () => {
    const { bridge } = await fixture();
    const handles: string[] = [];
    for (let index = 0; index < 511; index += 1) {
      const result = await bridge.execute('audio', owned(ownerA, { action: 'record' }));
      if (!result.ok) throw new Error(`Recording ${index} did not start`);
      handles.push((result.value as { handle: string }).handle);
    }
    await expect(bridge.execute('audio', owned(ownerA, { action: 'record' }))).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', handle: handles[0] }))).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'stop', handle: handles[0] }))).resolves.toMatchObject({ ok: true, value: { state: 'completed' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'record' }))).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
    await expect(bridge.execute('audio', owned(ownerA, { action: 'status', handle: handles[1] }))).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
  });
});
