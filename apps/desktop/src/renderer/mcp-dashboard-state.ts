import type { DashboardSnapshot, McpConnectionStatus } from '@lnwjing/ipc-contracts';

/** Prevent an older dashboard request from undoing an explicit MCP action. */
export class McpDashboardState {
  private revision = 0;

  public captureRevision(): number {
    return this.revision;
  }

  public isCurrent(revision: number): boolean {
    return revision === this.revision;
  }

  public recordMutation(): void {
    this.revision += 1;
  }

  public applyStatus(current: DashboardSnapshot | null, status: McpConnectionStatus): DashboardSnapshot | null {
    if (current === null) return null;
    return {
      ...current,
      mcp: status,
      agentState: !status.running ? 'stopped' : current.inFlight.length > 0 ? 'busy' : 'idle',
      connectionModes: { ...current.connectionModes, httpUrl: status.url },
    };
  }
}
