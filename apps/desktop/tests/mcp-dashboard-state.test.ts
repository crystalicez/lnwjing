import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot, McpConnectionStatus } from '@lnwjing/ipc-contracts';
import { McpDashboardState } from '../src/renderer/mcp-dashboard-state.js';

const readyUrl = 'http://127.0.0.1:43123/mcp';
const readyDashboard = {
  mcp: { running: true, url: readyUrl, workspaceId: null },
  agentState: 'idle',
  inFlight: [],
  connectionModes: { httpUrl: readyUrl, stdioCommand: 'lnwjing-mcp-stdio' },
} as DashboardSnapshot;

describe('McpDashboardState', () => {
  it('keeps an explicit Stop result ahead of a slower pre-Stop dashboard response', () => {
    const state = new McpDashboardState();
    const staleRequest = state.captureRevision();
    const stopped: McpConnectionStatus = { running: false, url: null, workspaceId: null };

    state.recordMutation();
    const shown = state.applyStatus(readyDashboard, stopped);

    expect(shown).toMatchObject({
      mcp: stopped,
      agentState: 'stopped',
      connectionModes: { httpUrl: null },
    });
    expect(state.isCurrent(staleRequest)).toBe(false);
    expect(state.isCurrent(state.captureRevision())).toBe(true);
  });

  it('shows a successful Restart immediately, including its new listener URL', () => {
    const state = new McpDashboardState();
    const newUrl = 'http://127.0.0.1:43124/mcp';
    const restarted: McpConnectionStatus = { running: true, url: newUrl, workspaceId: null };

    state.recordMutation();
    const shown = state.applyStatus({ ...readyDashboard, inFlight: [{ callId: 'active' }] } as DashboardSnapshot, restarted);

    expect(shown).toMatchObject({
      mcp: restarted,
      agentState: 'busy',
      connectionModes: { httpUrl: newUrl },
    });
  });
});
