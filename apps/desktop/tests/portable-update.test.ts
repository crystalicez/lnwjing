import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PORTABLE_UPDATE_CHANNEL,
  PORTABLE_UPDATE_FEED_URL,
  ensurePortableMcpStdioLauncher,
  configureUpdaterForDistribution,
  confirmPortableUpdateLaunch,
  portableUpdateConfirmationPath,
  configureUpdaterForPlatform,
  createLinuxAppImageRollback,
  restoreLinuxAppImageIfMissing,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  portableReplacementScript,
  preparePortableReplacement,
  usesElectronUpdaterInstall,
  waitsForNativeInstallAcceptance,
} from '../src/main/portable-update.js';

describe('Windows distribution-aware auto updater', () => {
  it('selects only updater formats with a platform-owned installation path', () => {
    expect(detectUpdaterDistribution(true, 'darwin', {})).toBe('macos');
    expect(detectUpdaterDistribution(true, 'linux', { APPIMAGE: '/tmp/lnwjing.AppImage' })).toBe('linux-appimage');
    expect(detectUpdaterDistribution(true, 'linux', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'freebsd', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(false, 'darwin', {})).toBe('unsupported');
  });

  it('routes Windows installers, macOS, and Linux AppImage through electron-updater install while keeping portable/unsupported formats out', () => {
    expect(usesElectronUpdaterInstall('installer')).toBe(true);
    expect(usesElectronUpdaterInstall('macos')).toBe(true);
    expect(usesElectronUpdaterInstall('linux-appimage')).toBe(true);
    expect(usesElectronUpdaterInstall('portable')).toBe(false);
    expect(usesElectronUpdaterInstall('unsupported')).toBe(false);
    expect(waitsForNativeInstallAcceptance('macos')).toBe(true);
    expect(waitsForNativeInstallAcceptance('linux-appimage')).toBe(true);
    expect(waitsForNativeInstallAcceptance('installer')).toBe(false);
    expect(waitsForNativeInstallAcceptance('portable')).toBe(false);
  });

  it('distinguishes electron-builder portable launches from installed builds', () => {
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjing-Portable-4.11.0.exe' }, 'win32')).toBe('portable');
    expect(detectWindowsDistribution(true, {}, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(false, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjing.exe' }, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: '/tmp/lnwjing' }, 'linux')).toBe('installer');
  });

  it('keeps the installer on the packaged GitHub feed and gives portable builds their own manifest channel', () => {
    const setFeedURL = vi.fn();
    const installerUpdater = { disableDifferentialDownload: false, setFeedURL };
    configureUpdaterForDistribution(installerUpdater, 'installer');
    expect(setFeedURL).not.toHaveBeenCalled();
    expect(installerUpdater.disableDifferentialDownload).toBe(false);

    const portableSetFeedURL = vi.fn();
    const portableUpdater = { disableDifferentialDownload: false, setFeedURL: portableSetFeedURL };
    configureUpdaterForDistribution(portableUpdater, 'portable');
    expect(portableUpdater.disableDifferentialDownload).toBe(true);
    expect(portableSetFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: PORTABLE_UPDATE_FEED_URL,
      channel: PORTABLE_UPDATE_CHANNEL,
      useMultipleRangeRequest: false,
    });
  });

  it('configures the Portable feed only once through the Desktop platform entrypoint', async () => {
    const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(mainSource.includes('configureUpdaterForDistribution(autoUpdater, windowsDistribution)')).toBe(false);

    const setFeedURL = vi.fn();
    const updater = { disableDifferentialDownload: false, setFeedURL };
    configureUpdaterForPlatform(updater, 'portable');
    expect(setFeedURL).toHaveBeenCalledTimes(1);
    expect(setFeedURL).toHaveBeenCalledWith({
      provider: 'generic', url: PORTABLE_UPDATE_FEED_URL,
      channel: PORTABLE_UPDATE_CHANNEL, useMultipleRangeRequest: false,
    });
  });

  it('disables differential downloads for Linux AppImage without changing the native feed metadata', () => {
    const updater = { disableDifferentialDownload: false, setFeedURL: vi.fn() };
    configureUpdaterForPlatform(updater, 'linux-appimage');
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('retains a working rollback after a Linux AppImage native move deletes the original', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-appimage-'));
    try {
      const current = path.join(root, 'lnwjing-5.8.1-x64.AppImage');
      const downloaded = path.join(root, 'lnwjing-5.8.2-x64.AppImage');
      await writeFile(current, 'old-working-app');
      await writeFile(downloaded, 'new-app');
      const { backupPath } = await createLinuxAppImageRollback(current, downloaded);
      await unlink(current); // AppImageUpdater.doInstall() unlinks before its mv.
      expect(await restoreLinuxAppImageIfMissing(current, backupPath)).toBe(true);
      expect(await readFile(current, 'utf8')).toBe('old-working-app');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing or symlinked Linux AppImage inputs before native installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-appimage-'));
    try {
      const current = path.join(root, 'lnwjing.AppImage');
      const downloaded = path.join(root, 'update.AppImage');
      await writeFile(current, 'old');
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow();
      await symlink(current, downloaded);
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow('regular files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('maintains a stable managed STDIO launcher without overwriting custom files', async () => {
    const tmpRoot = path.resolve(import.meta.dirname, '..', '..', '..', '.local-artifacts');
    await mkdir(tmpRoot, { recursive: true });
    const directory = await mkdtemp(path.join(tmpRoot, 'portable-stdio-'));
    const prior = process.env.PORTABLE_EXECUTABLE_FILE;
    try {
      const outer = path.join(directory, 'lnwjing-Portable.exe');
      process.env.PORTABLE_EXECUTABLE_FILE = outer;
      const firstExe = path.join(directory, 'lnwjing-runtime-v5.8.7-first', 'lnwjing.exe');
      const secondExe = path.join(directory, 'lnwjing-runtime-v5.8.8-second', 'lnwjing.exe');
      const launcher = path.join(directory, 'lnwjing-mcp-stdio.cmd');
      expect(await ensurePortableMcpStdioLauncher(outer, firstExe)).toBe(launcher);
      expect(await readFile(launcher, 'utf8')).toContain('lnwjing-runtime-v5.8.7-first');
      expect(await readFile(launcher, 'utf8')).toContain('lnwjing-mcp-stdio-bridge.exe');
      expect(await readFile(launcher, 'utf8')).toContain('"%BRIDGE%" "%APP%" --mcp-stdio %*');
      const olderTimestamp = new Date('2020-01-01T00:00:00.000Z');
      await utimes(launcher, olderTimestamp, olderTimestamp);
      const unchangedMtime = (await stat(launcher)).mtimeMs;
      expect(await ensurePortableMcpStdioLauncher(outer, firstExe)).toBe(launcher);
      expect((await stat(launcher)).mtimeMs).toBe(unchangedMtime);
      expect(await ensurePortableMcpStdioLauncher(outer, secondExe)).toBe(launcher);
      expect(await readFile(launcher, 'utf8')).toContain('lnwjing-runtime-v5.8.8-second');
      const managed = await readFile(launcher, 'utf8');
      await writeFile(launcher, managed + 'echo user customization\r\n');
      expect(await ensurePortableMcpStdioLauncher(outer, firstExe)).toBeNull();
      expect(await readFile(launcher, 'utf8')).toBe(managed + 'echo user customization\r\n');
      await writeFile(launcher, '@echo off\r\necho custom user script\r\n');
      expect(await ensurePortableMcpStdioLauncher(outer, firstExe)).toBeNull();
      expect(await readFile(launcher, 'utf8')).toContain('custom user script');
    } finally {
      if (prior === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
      else process.env.PORTABLE_EXECUTABLE_FILE = prior;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('replaces the outer portable executable path rather than Electron temporary extraction path', () => {
    expect(currentPortableExecutablePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\lnwjing-portable.exe' }, 'C:\\Temp\\lnwjing.exe')).toBe('D:\\Apps\\lnwjing-portable.exe');
    expect(currentPortableExecutablePath({}, 'C:\\Program Files\\lnwjing\\lnwjing.exe')).toBe('C:\\Program Files\\lnwjing\\lnwjing.exe');
  });

  it.skipIf(process.platform !== 'win32')('rejects redirected and missing portable replacement inputs before launching helper', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-portable-input-'));
    const target = path.join(directory, 'lnwjing-Portable.exe');
    const source = path.join(directory, 'downloaded.exe');
    try {
      await writeFile(target, 'prior-exe');
      await expect(preparePortableReplacement({ downloadedFile: source, currentExecutablePath: target })).rejects.toThrow();
      await writeFile(source, 'next-exe');
      const prepared = await preparePortableReplacement({ downloadedFile: source, currentExecutablePath: target, tempDirectory: directory });
      expect(prepared.targetPath).toBe(target);
      expect(prepared.sourcePath).toBe(source);
      expect(await readFile(prepared.scriptPath, 'utf8')).toContain('Portable update failed');
      await unlink(source);
      await mkdir(source);
      await expect(preparePortableReplacement({ downloadedFile: source, currentExecutablePath: target })).rejects.toThrow('regular executable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('acknowledges updated app readiness only through a one-time marker scoped to the outer EXE', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-portable-confirm-'));
    try {
      const outer = path.join(directory, 'renamed.exe');
      const token = '0123456789abcdef0123456789abcdef';
      const environment = { PORTABLE_EXECUTABLE_FILE: outer, LNWJING_PORTABLE_UPDATE_TOKEN: token };
      const marker = `${outer}.lnwjing-update-ok-${token}`;
      expect(portableUpdateConfirmationPath(environment)).toBe(marker);
      expect(await confirmPortableUpdateLaunch(environment)).toBe(true);
      expect(await readFile(marker, 'utf8')).toBe('ready\n');
      await expect(confirmPortableUpdateLaunch(environment)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(portableUpdateConfirmationPath({ ...environment, LNWJING_PORTABLE_UPDATE_TOKEN: '../../escape' })).toBeNull();
      expect(portableUpdateConfirmationPath({ ...environment, PORTABLE_EXECUTABLE_FILE: 'relative.exe' })).toBeNull();
      expect(await confirmPortableUpdateLaunch({})).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses a wait, rollback backup, in-place replacement, restart, and script self-cleanup for portable installs', () => {
    const script = portableReplacementScript();
    expect(script).toContain('Get-Process -Id $CurrentPid');
    expect(script).toContain('$Target.lnwjing-update-backup');
    expect(script).toContain('Move-Item -LiteralPath $Target -Destination $backup -Force');
    expect(script).toContain('Portable update backup already exists');
    expect(script).toContain('$attempt -lt 40');
    expect(script).toContain('Move-Item -LiteralPath $Source -Destination $Target -Force');
    expect(script).toContain('Move-Item -LiteralPath $backup -Destination $Target -ErrorAction Stop');
    expect(script).toContain('Start-Process -FilePath $Target');
    expect(script).toContain('Updated Portable launcher exited immediately');
    expect(script).toContain('LNWJING_PORTABLE_UPDATE_TOKEN');
    expect(script).toContain('Updated Portable did not confirm healthy renderer startup');
    expect(script).toContain('$healthDeadline');
    expect(script).toContain('Updated Portable exited during the post-startup stability check.');
    expect(script).toContain('taskkill.exe');
    expect(script).toContain('$Target.lnwjing-update-ok-$token');
    expect(script).toContain('lnwjing-update-failures.log');
    expect(script).toContain('Remove-Item -LiteralPath $PSCommandPath');
  });
});
