import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpSessionManager, defaultMcpClientFactory } from './mcp-session-manager.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/external-mcp-server.mjs', import.meta.url));

async function connectFixture(era: 'legacy' | 'modern' | 'schema-error'): ReturnType<typeof defaultMcpClientFactory.connect> {
  return defaultMcpClientFactory.connect({
    command: process.execPath,
    args: [fixturePath],
    env: { LNWJING_EXTERNAL_MCP_FIXTURE_ERA: era },
  });
}

describe('default External MCP client protocol negotiation', () => {
  it('connects to a legacy 2025-era stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('legacy');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'legacy_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('connects to a modern 2026-07-28 stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('modern');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'modern_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('bypasses SDK callTool output validation so isError results reach the lnwjing guard', async () => {
    const sdkCallTool = vi.spyOn(Client.prototype, 'callTool').mockRejectedValue(
      new Error('SDK callTool output-schema validation ran before lnwjing guard'),
    );
    const session = await connectFixture('schema-error');
    try {
      await session.listTools();
      await expect(session.callTool('schema_error_demo', { mode: 'error-no-structured' })).resolves.toMatchObject({
        isError: true,
        content: [{ text: 'Demo validation failed: invalid input' }],
      });
      expect(sdkCallTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
      sdkCallTool.mockRestore();
    }
  }, 20_000);

  it('preserves child tool errors while lnwjing validates successful structured output', async () => {
    const manager = new McpSessionManager({ callTimeoutMs: 20_000 });
    const config = {
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJING_EXTERNAL_MCP_FIXTURE_ERA: 'schema-error' },
    } as const;
    try {
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'error-no-structured' })).resolves.toMatchObject({
        ok: true,
        value: {
          isError: true,
          content: [{ text: 'Demo validation failed: invalid input' }],
        },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'error-invalid-structured' })).resolves.toMatchObject({
        ok: true,
        value: { isError: true, structuredContent: { value: 42 } },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-valid' })).resolves.toMatchObject({
        ok: true,
        value: { structuredContent: { value: 'ok' } },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-invalid' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', message: expect.stringContaining('output schema mismatch') },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-missing' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', message: expect.stringContaining('declared outputSchema requires structuredContent') },
      });
    } finally {
      await manager.close();
    }
  }, 30_000);

  it('survives a ten-cycle connect/use/close soak without retaining child sessions', async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const session = await connectFixture('modern');
      try {
        await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: 'modern_ping' })]);
      } finally {
        await session.close();
      }
    }
  }, 60_000);
});
