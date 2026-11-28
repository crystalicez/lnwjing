import { describe, expect, it } from 'vitest';
import {
  canonicalWorkspaceScopeId, workspaceScopeMatches, normalizeWorkspaceScopeIdentity,
  ipcChannels, pushChannels, isIncidentClassification, INCIDENT_CLASSIFICATIONS,
  type WorkspaceSummary,
} from '../src/index.js';

function project(id: string, rootPath: string, displayName: string, realRootPath = rootPath): WorkspaceSummary {
  return { id, rootPath, realRootPath, displayName, createdAt: '2026-01-01T00:00:00.000Z', kind: 'project' };
}

describe('runtime IPC contracts', () => {
  const a = project('a', 'E:/Coding/A', 'Shared', 'E:/Canonical/A');
  const b = project('b', 'E:/Coding/B', 'Shared');
  const c = project('c', 'E:/Coding/C', 'Unique');
  const machineRoot = { ...project('machine', 'E:/', 'Drive'), kind: 'machine_root' } as const;
  const workspaces = [a, b, c, machineRoot];

  it('canonicalizes legacy path spellings and real roots without prefix matching', () => {
    expect(normalizeWorkspaceScopeIdentity(' E:\\CODING\\A\\ ')).toBe('e:/coding/a');
    expect(canonicalWorkspaceScopeId(workspaces, 'a')).toBe('a');
    expect(canonicalWorkspaceScopeId(workspaces, 'E:/Coding/A/')).toBe('a');
    expect(canonicalWorkspaceScopeId(workspaces, 'e:\\canonical\\a')).toBe('a');
    expect(canonicalWorkspaceScopeId(workspaces, 'E:/Coding/AB')).toBe('E:/Coding/AB');
    expect(workspaceScopeMatches(workspaces, 'E:/Canonical/A', 'a')).toBe(true);
    expect(workspaceScopeMatches(workspaces, 'E:/Coding/AB', 'a')).toBe(false);
    expect(workspaceScopeMatches(workspaces, 'b', 'a')).toBe(false);
  });

  it('rejects ambiguous display names and does not map legacy drive labels to projects', () => {
    expect(canonicalWorkspaceScopeId(workspaces, 'Shared')).toBe('Shared');
    expect(workspaceScopeMatches(workspaces, 'Shared', 'a')).toBe(false);
    expect(workspaceScopeMatches(workspaces, 'Shared', 'b')).toBe(false);
    expect(canonicalWorkspaceScopeId(workspaces, ' unique ')).toBe('c');
    expect(canonicalWorkspaceScopeId(workspaces, 'Drive')).toBe('Drive');
    expect(canonicalWorkspaceScopeId(workspaces, 'E:/')).toBe('E:/');
    expect(workspaceScopeMatches(workspaces, null, 'a')).toBe(false);
  });

  it('keeps IPC request and push channels distinct', () => {
    const channels = [...Object.values(ipcChannels), ...Object.values(pushChannels)];
    expect(channels.length).toBeGreaterThan(0);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every(channel => channel.startsWith('lnwjing:'))).toBe(true);
  });

  it('accepts every defined incident classification and rejects unrecognized values', () => {
    for (const classification of INCIDENT_CLASSIFICATIONS) expect(isIncidentClassification(classification)).toBe(true);
    for (const invalid of [null, undefined, 0, {}, '', 'unknown', 'LOCAL_TOOL_FAILED']) {
      expect(isIncidentClassification(invalid)).toBe(false);
    }
  });
});
