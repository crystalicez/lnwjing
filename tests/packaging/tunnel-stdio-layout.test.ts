import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');

function section(config: string, start: string, end: string): string {
  const startIndex = config.indexOf(`${start}:`);
  const endIndex = config.indexOf(`\n${end}:`, startIndex + start.length + 1);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return config.slice(startIndex, endIndex);
}

describe('target-native Secure Tunnel packaged stdio layout', () => {
  it('ships only target-native launchers and does not duplicate a Node runtime/CJS entry', async () => {
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const win = section(config, 'win', 'nsis');
    const mac = section(config, 'mac', 'linux');
    const linux = config.slice(config.indexOf('linux:'));
    expect(win).toContain('from: build/lnwjing-mcp-stdio.cmd');
    expect(mac).toContain('from: build/lnwjing-mcp-stdio.sh');
    expect(mac).toContain('to: Resources/lnwjing-mcp-stdio');
    expect(mac).not.toMatch(/to: lnwjing-mcp-stdio\s/);
    expect(mac).toContain('arch:');
    expect(mac).toContain('- x64');
    expect(mac).toContain('- arm64');
    expect(linux).toContain('from: build/lnwjing-mcp-stdio.sh');
    expect(linux).toContain('target: AppImage');
    expect(linux).toContain('target: deb');
    expect(config).not.toContain('lnwjing-mcp-stdio.cjs');
    expect(config).not.toContain('lnwjing-node.exe');
  });

  it('generates a Windows launcher that invokes packaged Electron with --mcp-stdio', async () => {
    const launcher = await readFile(path.join(desktopRoot, 'build', 'lnwjing-mcp-stdio.cmd'), 'utf8');
    expect(launcher).toContain('set "BASE=%~dp0"');
    expect(launcher).toContain('set "APP=%BASE%lnwjing.exe"');
    expect(launcher).toContain('"%APP%" --mcp-stdio %*');
    expect(launcher).not.toContain('NODE_EXE');
    expect(launcher).not.toContain('lnwjing-mcp-stdio.cjs');
    expect(launcher).not.toContain('powershell');
  });

  it('generates a POSIX launcher that execs the packaged Electron host and preserves argv', async () => {
    const launcherPath = path.join(desktopRoot, 'build', 'lnwjing-mcp-stdio.sh');
    const launcher = await readFile(launcherPath, 'utf8');
    expect(launcher).toContain('#!/bin/sh');
    expect(launcher).toContain('exec "$APP" --mcp-stdio "$@"');
    expect(launcher).toContain('lnwjing.app/Contents/MacOS/lnwjing');
    expect(launcher).toContain('$BASE/MacOS/lnwjing');
    expect(launcher).toContain('$BASE/../MacOS/lnwjing');
    expect(launcher).toContain('../lib/lnwjing/lnwjing');
    expect(launcher).not.toContain('node ');
    await access(launcherPath);
  });
});
