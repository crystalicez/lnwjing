import { get } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LNWJING_MCP_IDENTITY_PATH, MAX_MCP_HTTP_BODY_BYTES, startMcpHttp, type McpHttpServerHandle } from './http.js';

function getStatus(url: URL, hostHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get(url, hostHeader === undefined ? {} : { headers: { Host: hostHeader } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
  });
}

describe('MCP localhost HTTP security boundary', () => {
  let handle: McpHttpServerHandle;

  beforeEach(async () => {
    handle = await startMcpHttp({
      port: 0,
      maxBodyBytes: 128,
      services: {},
      actor: { clientId: 'http-security-test', clientName: 'http-security-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('serves the same MCP port on IPv6 loopback when the host supports IPv6', async () => {
    if (process.platform === 'win32') expect(handle.ipv6Endpoint).not.toBeNull();
    if (handle.ipv6Endpoint === null || handle.ipv6Endpoint === undefined) return;

    expect(handle.ipv6Endpoint.port).toBe(String(handle.address.port));
    expect(await getStatus(new URL(LNWJING_MCP_IDENTITY_PATH, handle.ipv6Endpoint))).toBe(200);
  });

  it('denies public Host headers by default and permits an explicitly allowed tunnel hostname', async () => {
    const hostname = 'issue104.ngrok-free.dev';
    const identity = new URL(LNWJING_MCP_IDENTITY_PATH, handle.endpoint);
    expect(await getStatus(identity, hostname)).toBe(403);

    await handle.close();
    handle = await startMcpHttp({
      port: 0,
      maxBodyBytes: 128,
      allowedHostnames: [hostname],
      services: {},
      actor: { clientId: 'http-security-test', clientName: 'http-security-test' },
    });
    expect(await getStatus(new URL(LNWJING_MCP_IDENTITY_PATH, handle.endpoint), hostname)).toBe(200);
  });

  it('allows local origins and denies an untrusted origin', async () => {
    const allowed = await fetch(handle.endpoint, { headers: { Origin: `http://localhost:${handle.address.port}` } });
    const denied = await fetch(handle.endpoint, { headers: { Origin: 'http://evil.example' } });

    expect(allowed.status).not.toBe(403);
    expect(denied.status).toBe(403);
  });

  it('rejects bodies over the configured limit', async () => {
    const response = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ payload: 'x'.repeat(MAX_MCP_HTTP_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
  });

  it('lets the SDK reject malformed and header/body-mismatched modern requests', async () => {
    const malformed = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        Origin: 'http://localhost',
      },
      body: '{not-json',
    });
    const mismatch = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'security-test', version: '0.1.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });

    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(mismatch.status).toBeGreaterThanOrEqual(400);
  });
});
