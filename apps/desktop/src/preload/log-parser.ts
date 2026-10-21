import type { LogLine, TunnelLifecycleCategory } from '@lnwjing/ipc-contracts';

const tunnelLifecycles = new Set<TunnelLifecycleCategory>([
  'ttl_expired',
  'stdio_stopped',
  'transport_stopped',
  'transport_live',
  'other',
]);

export function parseLogCorrelation(value: unknown): LogLine['correlation'] | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'mcp' && (value.phase === 'started' || value.phase === 'completed') && typeof value.callId === 'string' && typeof value.toolName === 'string' && (value.resultCode === null || value.resultCode === 'SUCCESS' || value.resultCode === 'FAILED' || value.resultCode === 'FATAL' || value.resultCode === 'UNKNOWN')) {
    return { kind: 'mcp', phase: value.phase, callId: value.callId, toolName: value.toolName, resultCode: value.resultCode };
  }
  if (value.kind !== 'tunnel'
    || (value.instanceId !== undefined && typeof value.instanceId !== 'string')
    || (value.requestId !== undefined && typeof value.requestId !== 'string')
    || (value.pid !== undefined && (typeof value.pid !== 'number' || !Number.isInteger(value.pid)))) return undefined;
  const lifecycle = typeof value.lifecycle === 'string' && tunnelLifecycles.has(value.lifecycle as TunnelLifecycleCategory)
    ? value.lifecycle as TunnelLifecycleCategory
    : undefined;
  return {
    kind: 'tunnel',
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
