import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { windowsContainedProcessSource } from './windows-contained-process.js';

const run = promisify(execFile);

describe.skipIf(process.platform !== 'win32')('Windows contained process', () => {
  it('retains the job until a detached descendant completes after the root exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing job proof '));
    const marker = path.join(root, 'descendant.txt');
    await writeFile(path.join(root, 'breakaway.cs'), windowsContainedProcessSource.replace('CreateSuspended|CreateNoWindow,', 'CreateSuspended|CreateNoWindow|0x01000000,'));
    await writeFile(path.join(root, 'breakaway.ps1'), [
      'param([string]$Root,[string]$Node)',
      "$ErrorActionPreference='Stop'",
      "Add-Type -Path (Join-Path $Root 'breakaway.cs')",
      '$refused=$false',
      'try {$escaped=[ContainedProcess]::Start($Node,@("-e","process.exit(0)"),$Root);$escaped.Dispose()} catch {$refused=$_.Exception.InnerException.Message -eq "CONTAINMENT_CREATE_FAILED"}',
      'if(-not $refused){throw "Breakaway was accepted"}',
      'Write-Output "BREAKAWAY_REFUSED"',
    ].join('\n'));
    await writeFile(path.join(root, 'job.cs'), windowsContainedProcessSource);
    await writeFile(path.join(root, 'child.cjs'), [
      "const {spawn}=require('node:child_process');",
      "const code=\"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'finished'),500)\";",
      "spawn(process.execPath,['-e',code,process.argv[2]],{detached:true,stdio:'ignore'}).unref();",
    ].join('\n'));
    const script = path.join(root, 'run.ps1');
    await writeFile(script, [
      'param([string]$Root,[string]$Node)',
      "$ErrorActionPreference='Stop'",
      "Add-Type -Path (Join-Path $Root 'job.cs')",
      '$arguments=@((Join-Path $Root "child.cjs"),(Join-Path $Root "descendant.txt"))',
      '$job=[ContainedProcess]::Start($Node,$arguments,$Root)',
      'try {',
      ' $code=$job.WaitForExit(10000)',
      ' if($code -ne 0){throw "Root failed"}',
      ' if($job.ActiveProcesses -ne 0){throw "Descendants still active"}',
      ' if(-not [IO.File]::Exists((Join-Path $Root "descendant.txt"))){throw "Returned before descendant completed"}',
      ' Write-Output "JOB_EMPTY_VERIFIED"',
      ' $cancelled=[ContainedProcess]::Start($Node,@("-e","setInterval(()=>{},1000)"),$Root)',
      ' try {$cancelled.Cancel();if($cancelled.ActiveProcesses -ne 0){throw "Cancellation left active children"}} finally {$cancelled.Dispose()}',
      ' Write-Output "CANCEL_EMPTY_VERIFIED"',
      ' $probe=[ContainedProcess]::Start((Join-Path $PSHOME "powershell.exe"),@("-NoProfile","-NonInteractive","-File",(Join-Path $Root "breakaway.ps1"),$Root,$Node),$Root)',
      ' try {if($probe.WaitForExit(10000) -ne 0){throw "Breakaway refusal probe failed"}} finally {$probe.Dispose()}',
      '} finally {$job.Dispose()}',
    ].join('\n'));
    try {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, root, process.execPath], { windowsHide: true, timeout: 30_000 });
      expect(result.stdout).toContain('JOB_EMPTY_VERIFIED');
      expect(result.stdout).toContain('CANCEL_EMPTY_VERIFIED');
      expect(result.stdout).toContain('BREAKAWAY_REFUSED');
      expect(await readFile(marker, 'utf8')).toBe('finished');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000);

  it('kills contained descendants when its native helper dies abruptly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing job death '));
    await writeFile(path.join(root, 'job.cs'), windowsContainedProcessSource);
    await writeFile(path.join(root, 'hold.cjs'), [
      "const {spawn}=require('node:child_process');",
      "const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
      "process.stdout.write('DESCENDANT:'+descendant.pid+'\\n');",
      "setInterval(()=>{},1000);",
    ].join('\n'));
    const script = path.join(root, 'hold.ps1');
    await writeFile(script, [
      'param([string]$Root,[string]$Node)',
      "$ErrorActionPreference='Stop'",
      "Add-Type -Path (Join-Path $Root 'job.cs')",
      '$job=[ContainedProcess]::Start($Node,@((Join-Path $Root "hold.cjs")),$Root)',
      '$job.WaitForExit(30000) | Out-Null',
    ].join('\n'));
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, root, process.execPath], { windowsHide: true });
    const closed = once(helper, 'close');
    try {
      const descendantPid = await new Promise<number | undefined>((resolve) => {
        let output = '';
        helper.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          const match = /DESCENDANT:(\d+)/.exec(output);
          if (match !== null) resolve(Number(match[1]));
        });
        helper.once('close', () => resolve(undefined));
        helper.once('error', () => resolve(undefined));
      });
      expect(descendantPid).toBeDefined();
      expect(helper.kill('SIGKILL')).toBe(true);
      await closed;
      const verify = [
        '$ErrorActionPreference="Stop"',
        'try {$p=Get-Process -Id ' + descendantPid + ' -ErrorAction Stop} catch {if($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId,*"){exit 0};throw}',
        'if(-not $p.WaitForExit(5000)){throw "Contained descendant survived helper death"}',
      ].join('; ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verify], { windowsHide: true, timeout: 10_000 });
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
