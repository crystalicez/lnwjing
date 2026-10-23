import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PORTABLE_UPDATE_FEED_URL = 'https://github.com/crystalicez/lnwjing/releases/latest/download/';
export const PORTABLE_UPDATE_CHANNEL = 'portable';

export type WindowsDistribution = 'installer' | 'portable';
export type UpdaterDistribution = WindowsDistribution | 'macos' | 'linux-appimage' | 'unsupported';

export interface AutoUpdaterFeedAdapter {
  disableDifferentialDownload: boolean;
  setFeedURL(options: {
    readonly provider: 'generic';
    readonly url: string;
    readonly channel: string;
    readonly useMultipleRangeRequest: boolean;
  }): void;
}

export interface PreparedPortableReplacement {
  readonly scriptPath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly powershellPath: string;
}

export interface PreparePortableReplacementOptions {
  readonly downloadedFile: string;
  readonly currentExecutablePath: string;
  readonly tempDirectory?: string;
  readonly processId?: number;
}

export function detectWindowsDistribution(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WindowsDistribution {
  if (!isPackaged || platform !== 'win32') return 'installer';
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  return portableExecutable === undefined || portableExecutable.length === 0 ? 'installer' : 'portable';
}

/**
 * Select an updater only for installation formats electron-updater can safely
 * own. Linux DEB installs remain package-manager controlled; they must not
 * enter the Windows portable replacement path or consume a `latest.yml`
 * feed. A packaged AppImage is identified by electron-builder's APPIMAGE
 * environment marker.
 */
export function detectUpdaterDistribution(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): UpdaterDistribution {
  if (!isPackaged) return 'unsupported';
  if (platform === 'win32') return detectWindowsDistribution(true, environment, platform);
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux' && environment.APPIMAGE?.trim()) return 'linux-appimage';
  return 'unsupported';
}

/** Use electron-updater's native quit/install path only for formats it owns. */
/** Native macOS and AppImage installers must accept the update while IPC stays live. */
export function waitsForNativeInstallAcceptance(distribution: UpdaterDistribution): boolean {
  return distribution === 'macos' || distribution === 'linux-appimage';
}

export function usesElectronUpdaterInstall(distribution: UpdaterDistribution): boolean {
  return distribution === 'installer' || distribution === 'macos' || distribution === 'linux-appimage';
}

export function currentPortableExecutablePath(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackExecutablePath: string = process.execPath,
): string {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  return portableExecutable === undefined || portableExecutable.length === 0
    ? fallbackExecutablePath
    : portableExecutable;
}

/** Keep MCP STDIO client configuration stable across versioned extraction folders. */
export async function ensurePortableMcpStdioLauncher(
  outerPath: string = currentPortableExecutablePath(),
  innerPath: string = process.execPath,
): Promise<string | null> {
  if (process.platform !== 'win32' || !process.env.PORTABLE_EXECUTABLE_FILE?.trim()) return null;
  const outerDirectory = path.dirname(path.resolve(outerPath));
  const relativeInner = path.relative(outerDirectory, path.resolve(innerPath)).replaceAll('/', '\\');
  if (!/^lnwjing-runtime-v[0-9A-Za-z._-]+\\lnwjing\.exe$/i.test(relativeInner)) return null;
  const launcherPath = path.join(outerDirectory, 'lnwjing-mcp-stdio.cmd');
  const signature = 'REM lnwjing-managed-portable-stdio-v1';
  const contents = [
    '@echo off',
    signature,
    'setlocal',
    `set "APP=%~dp0${relativeInner}"`,
    `set "BRIDGE=%~dp0${path.win32.join(path.win32.dirname(relativeInner), 'lnwjing-mcp-stdio-bridge.exe')}"`,
    'if not exist "%APP%" (',
    '  echo lnwjing portable MCP runtime is missing. Launch the Portable EXE first. 1>&2',
    '  exit /b 1',
    ')',
    'if not exist "%BRIDGE%" (',
    '  echo lnwjing portable MCP console bridge is missing. Launch the Portable EXE first. 1>&2',
    '  exit /b 1',
    ')',
    '"%BRIDGE%" "%APP%" --mcp-stdio %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  try {
    const current = await lstat(launcherPath).catch((error: unknown): null => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (current !== null) {
      if (!current.isFile() || current.isSymbolicLink()) return null;
      const previous = await readFile(launcherPath, 'utf8');
      if (!previous.startsWith(`@echo off\r\n${signature}\r\n`)) return null;
      if (previous === contents) return launcherPath;
      const temporaryPath = `${launcherPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
        await rename(temporaryPath, launcherPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    } else {
      await writeFile(launcherPath, contents, { encoding: 'utf8', flag: 'wx' });
    }
    return launcherPath;
  } catch {
    return null;
  }
}

export function configureUpdaterForDistribution(
  updater: AutoUpdaterFeedAdapter,
  distribution: WindowsDistribution,
): void {
  if (distribution !== 'portable') return;
  updater.disableDifferentialDownload = true;
  updater.setFeedURL({
    provider: 'generic',
    url: PORTABLE_UPDATE_FEED_URL,
    channel: PORTABLE_UPDATE_CHANNEL,
    useMultipleRangeRequest: false,
  });
}

/** Configure only distribution-specific safeguards; native macOS/Linux feeds use electron-builder metadata. */
export function configureUpdaterForPlatform(
  updater: AutoUpdaterFeedAdapter,
  distribution: UpdaterDistribution,
): void {
  if (distribution === 'portable') {
    configureUpdaterForDistribution(updater, distribution);
    return;
  }
  if (distribution === 'linux-appimage') {
    // AppImage updates are full-file replacements. Differential blockmaps
    // are not a supported contract for this portable Linux distribution.
    updater.disableDifferentialDownload = true;
  }
}

/**
 * electron-updater AppImageUpdater.doInstall() unlinks the running AppImage
 * BEFORE moving its downloaded replacement into place. Keep a hard-link to the
 * verified current executable so an unsuccessful move cannot delete the app.
 * Hard-link creation is mandatory (fail closed on unsupported filesystems).
 */
export async function createLinuxAppImageRollback(
  currentPath: string,
  downloadedPath: string,
): Promise<{ currentPath: string; backupPath: string }> {
  if (!path.isAbsolute(currentPath) || !path.isAbsolute(downloadedPath) || currentPath === downloadedPath) {
    throw new Error('Linux AppImage update requires distinct absolute current and downloaded paths');
  }
  const [current, downloaded] = await Promise.all([lstat(currentPath), lstat(downloadedPath)]);
  if (!current.isFile() || !downloaded.isFile()) {
    throw new Error('Linux AppImage update paths must be regular files (not symlinks)');
  }
  const backupPath = `${currentPath}.lnwjing-backup-${randomUUID()}`;
  await link(currentPath, backupPath);
  return { currentPath, backupPath };
}

/** Restore an AppImage deleted by a failing native move, without overwriting a new installation. */
export async function restoreLinuxAppImageIfMissing(currentPath: string, backupPath: string): Promise<boolean> {
  try {
    await lstat(currentPath);
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await rename(backupPath, currentPath);
    return true;
  }
}

export async function preparePortableReplacement(
  options: PreparePortableReplacementOptions,
): Promise<PreparedPortableReplacement> {
  const sourcePath = path.resolve(options.downloadedFile);
  const targetPath = path.resolve(options.currentExecutablePath);
  if (path.extname(sourcePath).toLowerCase() !== '.exe' || path.extname(targetPath).toLowerCase() !== '.exe') {
    throw new Error('Portable update source and target must be Windows executables');
  }
  if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error('Portable update source must be staged separately from the running executable');
  }
  const [sourceMetadata, targetMetadata, sourceRealPath, targetRealPath] = await Promise.all([
    lstat(sourcePath), lstat(targetPath), realpath(sourcePath), realpath(targetPath),
  ]);
  // Do not let a reparse-point/alias target redirect the update outside the
  // downloaded file and existing outer Portable executable we just checked.
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() ||
      !targetMetadata.isFile() || targetMetadata.isSymbolicLink() ||
      sourceRealPath.toLowerCase() !== sourcePath.toLowerCase() ||
      targetRealPath.toLowerCase() !== targetPath.toLowerCase()) {
    throw new Error('Portable update requires canonical regular executable files (no symlinks or junctions)');
  }

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || systemRoot.trim().length === 0) {
    throw new Error('Windows system root is unavailable; cannot prepare the portable updater safely');
  }
  const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await access(powershellPath);

  const tempDirectory = options.tempDirectory ?? path.join(os.tmpdir(), 'lnwjing-portable-update');
  await mkdir(tempDirectory, { recursive: true });
  const processId = options.processId ?? process.pid;
  const scriptPath = path.join(tempDirectory, `replace-${processId}-${Date.now()}.ps1`);
  await writeFile(scriptPath, portableReplacementScript(), { encoding: 'utf8', flag: 'wx' });
  return { scriptPath, sourcePath, targetPath, powershellPath };
}

export function launchPortableReplacement(
  prepared: PreparedPortableReplacement,
  processId: number = process.pid,
): void {
  const child = spawn(prepared.powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    prepared.scriptPath,
    '-CurrentPid',
    String(processId),
    '-Source',
    prepared.sourcePath,
    '-Target',
    prepared.targetPath,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Require the restarted Electron renderer to finish loading before an update
 * discards its rollback. The marker is tightly bound to the outer Portable EXE
 * and to a one-time random token generated by the detached updater helper.
 */
export function portableUpdateConfirmationPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const executable = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  const token = environment.LNWJING_PORTABLE_UPDATE_TOKEN?.trim();
  if (!executable || path.extname(executable).toLowerCase() !== '.exe'
    || !token || !/^[a-f0-9]{32}$/i.test(token) || !path.isAbsolute(executable)) return null;
  return `${path.resolve(executable)}.lnwjing-update-ok-${token}`;
}

export async function confirmPortableUpdateLaunch(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const marker = portableUpdateConfirmationPath(environment);
  if (marker === null) return false;
  await writeFile(marker, 'ready\n', { encoding: 'utf8', flag: 'wx' });
  return true;
}

export function portableReplacementScript(): string {
  return `param(
  [Parameter(Mandatory = $true)][int]$CurrentPid,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$backup = "$Target.lnwjing-update-backup"
$errorLog = "$Target.lnwjing-update-failures.log"
# A unique one-shot acknowledgement avoids mistaking a running NSIS wrapper for a healthy app.
$token = [guid]::NewGuid().ToString('N')
$confirmation = "$Target.lnwjing-update-ok-$token"
$launched = $null
try {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue)) {
    throw 'Timed out waiting for lnwjing portable process to exit.'
  }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw 'Downloaded portable update is missing.' }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'Current portable executable is missing.' }
  # Never discard a surviving rollback from a previous interrupted update.
  if (Test-Path -LiteralPath $backup) { throw 'Portable update backup already exists; refusing to overwrite it.' }
  # The outer NSIS wrapper may still be releasing its handle after Electron exits.
  # Retry transient sharing violations without deleting the old executable.
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      Move-Item -LiteralPath $Target -Destination $backup -Force
      break
    } catch {
      if ($attempt -eq 39) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
  try {
    Move-Item -LiteralPath $Source -Destination $Target -Force
    # Inherited by the new Electron main process; it writes confirmation only
    # after its native runtime, IPC and renderer have initialized successfully.
    $env:LNWJING_PORTABLE_UPDATE_TOKEN = $token
    try {
      $launched = Start-Process -FilePath $Target -PassThru
    } finally {
      Remove-Item Env:LNWJING_PORTABLE_UPDATE_TOKEN -ErrorAction SilentlyContinue
    }
    $ready = $false
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $healthDeadline) {
      if (Test-Path -LiteralPath $confirmation -PathType Leaf) {
        if ((Get-Content -LiteralPath $confirmation -Raw).Trim() -eq 'ready') {
          $ready = $true
          break
        }
      }
      $launched.Refresh()
      if ($launched.HasExited) { throw 'Updated Portable launcher exited immediately after restart.' }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Updated Portable did not confirm healthy renderer startup; retaining rollback.' }
    # Acknowledgement is necessary but not sufficient: allow early process
    # crashes to manifest before the original executable is discarded.
    Start-Sleep -Seconds 3
    $launched.Refresh()
    if ($launched.HasExited) { throw 'Updated Portable exited during the post-startup stability check.' }
    Remove-Item -LiteralPath $confirmation -Force -ErrorAction SilentlyContinue
    # Only discard rollback after the restarted Electron application acknowledged.
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
  catch {
    if (Test-Path -LiteralPath $backup -PathType Leaf) {
      # Terminate only the updater-owned new outer process tree before attempting
      # replacement. Do not kill other unrelated Desktop/MCP instances.
      if ($null -ne $launched) {
        $launched.Refresh()
        if (-not $launched.HasExited) {
          & "$env:SystemRoot\\System32\\taskkill.exe" /PID $launched.Id /T /F 2>$null | Out-Null
          Start-Sleep -Milliseconds 500
        }
      }
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
          if (Test-Path -LiteralPath $Target -PathType Leaf) {
            Remove-Item -LiteralPath $Target -Force -ErrorAction Stop
          }
          Move-Item -LiteralPath $backup -Destination $Target -ErrorAction Stop
          break
        } catch {
          if ($attempt -eq 39) { throw 'Portable rollback failed; the old executable is still preserved in .lnwjing-update-backup.' }
          Start-Sleep -Milliseconds 250
        }
      }
      Start-Process -FilePath $Target | Out-Null
    }
    throw
  }
}
catch {
  # Hidden detached helpers otherwise discard all error details. Keep only a
  # short local failure message; diagnostic text may contain paths and stays local.
  try { Add-Content -LiteralPath $errorLog -Value ("$(Get-Date -Format o) Portable update failed: " + $_.Exception.Message) -ErrorAction Stop } catch {}
  throw
}
finally {
  Remove-Item -LiteralPath $confirmation -Force -ErrorAction SilentlyContinue
  Remove-Item Env:LNWJING_PORTABLE_UPDATE_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}
