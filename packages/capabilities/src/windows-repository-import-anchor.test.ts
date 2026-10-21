import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { windowsRepositoryImportAnchorSource } from './windows-repository-import-anchor.js';
import { repositoryImportPublishScript, repositoryImportStageIdentityScript } from './repository-import-scripts.js';

const execFileAsync = promisify(execFile);

async function commitStage(stage: string): Promise<string> {
  await execFileAsync('git', ['init', '-q', stage]);
  await execFileAsync('git', ['-C', stage, 'add', '--', 'proof.txt']);
  await execFileAsync('git', ['-C', stage, '-c', 'user.name=lnwjing-test', '-c', 'user.email=lnwjing-test@example.invalid', 'commit', '-qm', 'stage fixture']);
  return (await execFileAsync('git', ['-C', stage, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
}

describe.skipIf(process.platform !== 'win32')('Windows repository import native anchor', () => {
  it('publishes without replacement and refuses junction ancestry on the real filesystem', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing import anchor '));
    const workspace = path.join(root, 'workspace');
    const stage = path.join(root, 'stage');
    await mkdir(workspace);
    await mkdir(stage);
    await mkdir(path.join(workspace, 'occupied'));
    await writeFile(path.join(stage, 'proof.txt'), 'complete repository');
    const helper = path.join(root, 'anchor.cs');
    const script = path.join(root, 'test.ps1');
    await writeFile(helper, windowsRepositoryImportAnchorSource);
    await writeFile(script, [
      'param([string]$Root)',
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -Path (Join-Path $Root 'anchor.cs')",
      "$workspace = Join-Path $Root 'workspace'",
      "$stage = Join-Path $Root 'stage'",
      "$collision = [RepositoryImportAnchor]::new($workspace,'occupied')",
      'try {',
      ' $refused = $false',
      ' try {$collision.PrepareStage($stage) | Out-Null; $collision.Publish()} catch {$refused=$_.Exception.InnerException.Message -eq "IMPORT_PUBLICATION_REFUSED_C0000035"}',
      ' if(-not $refused){throw "No-replace collision was not refused"}',
      '} finally {$collision.Dispose()}',
      "$anchor = [RepositoryImportAnchor]::new($workspace,'published')",
      'try {',
      ' $moved=$false',
      ' try {[IO.Directory]::Move($workspace,"$workspace-moved");$moved=$true} catch [IO.IOException] {}',
      ' if($moved){throw "Anchored workspace was renamed"}',
      ' $moved=$false',
      ' try {[IO.Directory]::Move($Root,"$Root-moved");$moved=$true} catch [IO.IOException] {}',
      ' if($moved){throw "Ancestor above workspace was renamed"}',
      ' $identity=$anchor.PrepareStage($stage)',
      ' $premature=$false',
      ' try {$anchor.ReadPublishedIdentity() | Out-Null} catch {$premature=$_.Exception.InnerException.Message -eq "IMPORT_NOT_PUBLISHED"}',
      ' if(-not $premature){throw "Prepared stage was reported as published"}',
      ' $anchor.Publish()',
      ' if($anchor.ReadPublishedIdentity() -ne $identity){throw "Published native identity changed"}',
      '} finally {$anchor.Dispose()}',
      "$outside = Join-Path $Root 'outside'",
      '[IO.Directory]::CreateDirectory($outside) | Out-Null',
      "New-Item -ItemType Junction -Path (Join-Path $workspace 'redirect') -Target $outside | Out-Null",
      '$refused=$false',
      'try {$bad=[RepositoryImportAnchor]::new($workspace,"redirect/escape");$bad.Dispose()} catch {$refused=$true}',
      'if(-not $refused){throw "Junction ancestry was accepted"}',
      'if([IO.Directory]::Exists((Join-Path $outside "escape"))){throw "Outside target was mutated"}',
      '$shortStage=Join-Path $Root "short-stage"',
      '[IO.Directory]::CreateDirectory($shortStage) | Out-Null',
      '$short=[RepositoryImportAnchor]::new($workspace,"x")',
      'try {$short.PrepareStage($shortStage) | Out-Null;$short.Publish()} finally {$short.Dispose()}',
      'if(-not [IO.Directory]::Exists((Join-Path $workspace "x"))){throw "One-character publication failed"}',
      '$cancelled=[RepositoryImportAnchor]::new($workspace,"cancelled")',
      '$cancelled.Dispose()',
      'if([IO.Directory]::Exists((Join-Path $workspace "cancelled"))){throw "Dispose published a cancelled destination"}',
      'if(@([IO.Directory]::EnumerateDirectories($workspace,".lnwjing-import-guard-*")).Length -ne 0){throw "Guard cleanup failed"}',
      'Write-Output "NATIVE_ANCHOR_VERIFIED"',
    ].join('\n'));
    try {
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, root], { windowsHide: true, timeout: 30_000 });
      expect(result.stdout).toContain('NATIVE_ANCHOR_VERIFIED');
      expect(await readFile(path.join(workspace, 'published', 'proof.txt'), 'utf8')).toBe('complete repository');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('publishes a native stage with the exact identity pinned before checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-stage-match-'));
    const workspace = path.join(root, 'workspace');
    const stage = path.join(root, 'stage');
    const anchorSource = path.join(root, 'anchor.cs');
    const identityScript = path.join(root, 'identity.ps1');
    const publisherScript = path.join(root, 'publisher.ps1');
    try {
      await mkdir(workspace);
      await mkdir(stage);
      await writeFile(path.join(stage, 'proof.txt'), 'verified stage');
      const commit = await commitStage(stage);
      await writeFile(anchorSource, windowsRepositoryImportAnchorSource);
      await writeFile(identityScript, repositoryImportStageIdentityScript);
      await writeFile(publisherScript, repositoryImportPublishScript);
      const observed = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', identityScript, anchorSource, workspace, 'published', stage,
      ], { windowsHide: true, timeout: 30000 });
      const identity = observed.stdout.trim();
      const statePath = path.join(root, 'publication.json');
      const specPath = path.join(root, 'spec.json');
      await writeFile(specPath, JSON.stringify({
        anchorSourcePath: anchorSource,
        workspaceRoot: workspace,
        stagePath: stage,
        destination: 'published',
        statePath,
        commit,
      }));
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', publisherScript, specPath, identity,
      ], { windowsHide: true, timeout: 30000 });
      expect(result.stdout).toContain('PUBLISHED_NATIVE_IDENTITY_VERIFIED');
      expect(await readFile(path.join(workspace, 'published', 'proof.txt'), 'utf8')).toBe('verified stage');
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
        version: 1, state: 'published', nativeIdentity: identity,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);

  it('refuses modified tracked content and extra untracked content before native publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-stage-content-'));
    const workspace = path.join(root, 'workspace');
    const stage = path.join(root, 'stage');
    const anchorSource = path.join(root, 'anchor.cs');
    const identityScript = path.join(root, 'identity.ps1');
    const publisherScript = path.join(root, 'publisher.ps1');
    try {
      await mkdir(workspace);
      await mkdir(stage);
      const proofPath = path.join(stage, 'proof.txt');
      await writeFile(proofPath, 'original checked-out content');
      const commit = await commitStage(stage);
      await writeFile(anchorSource, windowsRepositoryImportAnchorSource);
      await writeFile(identityScript, repositoryImportStageIdentityScript);
      await writeFile(publisherScript, repositoryImportPublishScript);
      const identity = (await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', identityScript, anchorSource, workspace, 'published', stage,
      ], { windowsHide: true, timeout: 30000 })).stdout.trim();
      const specPath = path.join(root, 'spec.json');
      await writeFile(specPath, JSON.stringify({
        anchorSourcePath: anchorSource, workspaceRoot: workspace,
        stagePath: stage, destination: 'published',
        statePath: path.join(root, 'publication.json'), commit,
      }));
      const publish = (): ReturnType<typeof execFileAsync> => execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', publisherScript, specPath, identity,
      ], { windowsHide: true, timeout: 30000 });
      await writeFile(proofPath, 'modified in place');
      await expect(publish()).rejects.toMatchObject({
        stderr: expect.stringContaining('IMPORT_STAGE_WORKTREE_CHANGED'),
      });
      await writeFile(proofPath, 'original checked-out content');
      await writeFile(path.join(stage, 'unexpected.txt'), 'injected');
      await expect(publish()).rejects.toMatchObject({
        stderr: expect.stringContaining('IMPORT_STAGE_WORKTREE_CHANGED'),
      });
      await rm(path.join(stage, 'unexpected.txt'));
      await execFileAsync('git', ['-C', stage, 'update-index', '--assume-unchanged', 'proof.txt']);
      await writeFile(proofPath, 'concealed by assume-unchanged');
      await expect(publish()).rejects.toMatchObject({
        stderr: expect.stringContaining('IMPORT_STAGE_INDEX_FLAGS_UNSAFE'),
      });
      await execFileAsync('git', ['-C', stage, 'update-index', '--no-assume-unchanged', 'proof.txt']);
      await writeFile(proofPath, 'original checked-out content');
      await execFileAsync('git', ['-C', stage, 'update-index', '--skip-worktree', 'proof.txt']);
      await writeFile(proofPath, 'concealed by skip-worktree');
      await expect(publish()).rejects.toMatchObject({
        stderr: expect.stringContaining('IMPORT_STAGE_INDEX_FLAGS_UNSAFE'),
      });
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses a stage swapped after the pre-clone NTFS identity was captured', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-stage-identity-'));
    const workspace = path.join(root, 'workspace');
    const stage = path.join(root, 'stage');
    const anchorSource = path.join(root, 'anchor.cs');
    const identityScript = path.join(root, 'identity.ps1');
    const publisherScript = path.join(root, 'publisher.ps1');
    try {
      await mkdir(workspace);
      await mkdir(stage);
      await writeFile(anchorSource, windowsRepositoryImportAnchorSource);
      await writeFile(identityScript, repositoryImportStageIdentityScript);
      await writeFile(publisherScript, repositoryImportPublishScript);
      const first = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', identityScript, anchorSource, workspace, 'published', stage,
      ], { windowsHide: true, timeout: 30000 });
      const expectedIdentity = first.stdout.trim();
      expect(expectedIdentity).toMatch(/^[0-9A-F]{16}-[0-9A-F]{32}$/);
      await rename(stage, path.join(root, 'original-stage'));
      await mkdir(stage);
      await writeFile(path.join(stage, 'proof.txt'), 'wrong directory');
      const commit = await commitStage(stage);
      const specPath = path.join(root, 'spec.json');
      await writeFile(specPath, JSON.stringify({
        anchorSourcePath: anchorSource,
        workspaceRoot: workspace,
        stagePath: stage,
        destination: 'published',
        statePath: path.join(root, 'publication.json'),
        commit,
      }));
      await expect(execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', publisherScript, specPath, expectedIdentity,
      ], { windowsHide: true, timeout: 30000 })).rejects.toMatchObject({
        stderr: expect.stringContaining('IMPORT_STAGE_IDENTITY_CHANGED'),
      });
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);

  it('removes its pinned guard after hard helper termination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing import crash '));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(root, 'anchor.cs'), windowsRepositoryImportAnchorSource);
    const script = path.join(root, 'hold.ps1');
    await writeFile(script, [
      'param([string]$Root)',
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -Path (Join-Path $Root 'anchor.cs')",
      '$anchor=[RepositoryImportAnchor]::new((Join-Path $Root "workspace"),"absent")',
      'Write-Output "ANCHORED"',
      'Start-Sleep -Seconds 120',
    ].join('\n'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, root], { windowsHide: true });
    const closed = once(child, 'close');
    try {
      const ready = await new Promise<boolean>((resolve) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('ANCHORED')) resolve(true);
        });
        child.once('close', () => resolve(false));
        child.once('error', () => resolve(false));
      });
      expect(ready).toBe(true);
      const guards = (await readdir(workspace)).filter((name) => name.startsWith('.lnwjing-import-guard-'));
      expect(guards).toHaveLength(1);
      await expect(rm(path.join(workspace, guards[0]!), { recursive: true })).rejects.toThrow();
      expect(child.kill('SIGKILL')).toBe(true);
      await closed;
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
