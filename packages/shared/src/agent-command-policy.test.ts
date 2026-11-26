import { describe, expect, it } from 'vitest';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';

describe('agent command policy', () => {
  it.each([
    ['format.com', ['C:']],
    ['diskpart.exe', []],
    ['shutdown.exe', ['/s']],
    ['powershell.exe', ['-Command', 'Restart-Computer']],
  ] as const)('hard-blocks machine-level command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['node.exe', ['-e', "const fs=require('fs'); fs.writeFileSync('src/a.ts', 'next')"]],
    ['python.exe', ['-c', "open('src/a.py', 'w', encoding='utf8').write('next')"]],
    ['powershell.exe', ['-NoProfile', '-Command', "Set-Content -LiteralPath 'src/a.txt' -Value 'next'"]],
    ['sed', ['-i.bak', 's/a/b/', 'src/a.txt']],
  ] as const)('routes terminal-style text editing away from command tool %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toContain('Use edit_file');
  });

  it.each([
    ['rm.exe', ['-rf', 'target']],
    ['C:/Windows/System32/DEL.CMD', ['target']],
    ['Remove-Item.bat', ['target']],
    ['powershell.exe', ['-Command', 'Remove-Item target']],
    ['pwsh', ['-EncodedCommand', 'AAAA']],
    ['cmd.exe', ['/C', 'del target']],
    ['bash', ['-lc', 'rm -rf target']],
    ['node.exe', ['--eval', 'require("fs").rmSync("x")']],
    ['python3.exe', ['-c', 'import os; os.remove("x")']],
    ['robocopy.exe', ['source', 'target', '/MIR']],
    ['rsync', ['-a', '--delete', 'source/', 'target/']],
  ] as const)('requires confirmation for risky command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    [['clean', '-fd']],
    [['reset', '--hard']],
    [['restore', '--worktree', '.']],
    [['push', '--force', 'origin', 'main']],
  ] as const)('requires confirmation for destructive git invocation %j', (args) => {
    expect(riskyAgentCommandReason('git.exe', args)).toBeDefined();
  });

  it.each([
    ['pnpm.cmd', ['test']],
    ['cp.com', ['source', 'target']],
    ['MV.EXE', ['source', 'target']],
    ['xcopy.exe', ['source', 'target']],
    ['node.exe', ['script.js']],
    ['python.exe', ['script.py']],
    ['powershell.exe', ['-NoProfile', '-File', 'script.ps1']],
    ['powershell.exe', ['-Command', 'Get-ChildItem']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p='artifact.exe'; $i=Get-Item -LiteralPath $p; $h=Get-FileHash -Algorithm SHA256 -LiteralPath $p; [pscustomobject]@{Path=$i.FullName; Length=$i.Length; SHA256=$h.Hash} | ConvertTo-Json -Compress"]],
    ['cmd.exe', ['/C', 'echo ok']],
    ['git.exe', ['status', '--short']],
  ] as const)('allows normal command without confirmation: %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeUndefined();
  });

  it('allows the Android inspection output projection without misclassifying string concatenation', () => {
    const command = "adb -s test-device shell uiautomator dump /sdcard/test-ui.xml|Out-Null; [xml]$x=adb -s test-device shell cat /sdcard/test-ui.xml; $x.SelectNodes('//node')|Where-Object {$_.text -eq 'test.txt' -or ($_.package -eq 'app.test' -and $_.'content-desc')}|ForEach-Object { $_.text+' '+$_.'content-desc'+' '+$_.bounds }";
    expect(riskyAgentCommandReason('powershell.exe', ['-NoProfile', '-Command', command])).toBeUndefined();
  });

  it.each([
    "& ('Remove'+'-Item') target | ForEach-Object { $_.text+' '+$_.bounds }",
    "Remove-Item target | ForEach-Object { $_.text+' '+$_.bounds }",
    "Get-Item target | ForEach-Object { $_.text+' '+$_.bounds; & ('Remove'+'-Item') target }",
    "Get-Item target | ForEach-Object { $_.text+' '+$_.bounds } ; & ('Remove'+'-Item') target",
    "Get-Item target | ForEach-Object { $_.text+' '+$_.bounds } | Invoke-Expression",
    "$cmd='Remove'+'-Item'; & $cmd target | ForEach-Object { $_.text+' '+$_.bounds }",
    "Unknown-Command | ForEach-Object { $_.'text'+' '+$_.bounds }",
    "adb -s test-device shell uiautomator dump /sdcard/../test.xml|Out-Null; [xml]$x=adb -s test-device shell cat /sdcard/../test.xml; $x.SelectNodes('//node')|Where-Object {$_.text -eq 'test.txt' -or ($_.package -eq 'app.test' -and $_.'content-desc')}|ForEach-Object { $_.text+' '+$_.'content-desc'+' '+$_.bounds }",
  ])('retains confirmation for dynamic or destructive execution: %s', (command) => {
    expect(riskyAgentCommandReason('powershell.exe', ['-Command', command])).toBeDefined();
  });

  it('treats dynamically constructed PowerShell as risky', () => {
    expect(riskyAgentCommandReason('powershell.exe', ['-Command', "& ('Remove'+'-Item') x"])).toBeDefined();
  });
});
