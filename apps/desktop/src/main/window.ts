import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';
import { comparableHostPath } from '@lnwjing/workspace';
import { mutationApprovalWindowSize } from './mutation-approval-layout.js';
import { windowChromeOptions } from './window-chrome.js';

const mainDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getPreloadPath(): string {
  return path.resolve(mainDirectory, '..', 'preload', 'index.cjs');
}

export function getRendererEntryPath(): string {
  return path.resolve(mainDirectory, '..', 'renderer', 'index.html');
}

export function getWindowIconPath(): string | undefined {
  const candidates = [
    path.resolve(mainDirectory, '..', 'renderer', 'favicon.ico'),
    path.resolve(mainDirectory, '..', 'renderer', 'logo.png'),
    path.resolve(mainDirectory, '..', 'renderer', 'logo-512.png'),
    path.resolve(mainDirectory, '..', '..', 'build', 'icon.ico'),
    path.resolve(mainDirectory, '..', '..', 'build', 'icon.png'),
    path.resolve(mainDirectory, '..', '..', 'assets', 'logo', 'logo.ico'),
    path.resolve(mainDirectory, '..', '..', 'assets', 'logo', 'logo-256x256.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function isAllowedRendererUrl(navigationUrl: string, rendererEntryPath: string): boolean {
  try {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.protocol !== 'file:') return false;
    const requestedPath = comparableHostPath(path.normalize(fileURLToPath(parsedUrl)), process.platform);
    const allowedPath = comparableHostPath(path.normalize(rendererEntryPath), process.platform);
    return requestedPath === allowedPath;
  } catch {
    return false;
  }
}

export function createMainWindow(showOnReady = true): BrowserWindow {
  const rendererEntryPath = getRendererEntryPath();
  const iconPath = getWindowIconPath();
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: showOnReady,
    autoHideMenuBar: true,
    ...windowChromeOptions(),
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, rendererEntryPath)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  const reveal = (): void => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  if (showOnReady) {
    mainWindow.once('ready-to-show', reveal);
    // Fallback if ready-to-show never fires (blank/hung loads).
    setTimeout(reveal, 1_500);
  }
  void mainWindow.loadFile(rendererEntryPath);
  return mainWindow;
}

export function createLogViewerWindow(): BrowserWindow {
  const rendererEntryPath = getRendererEntryPath();
  const iconPath = getWindowIconPath();
  const viewerWindow = new BrowserWindow({
    width: 960,
    height: 680,
    show: true,
    autoHideMenuBar: true,
    title: 'lnwjing — Live Logs',
    ...windowChromeOptions(),
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  viewerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewerWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, rendererEntryPath)) event.preventDefault();
  });
  viewerWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  void viewerWindow.loadFile(rendererEntryPath, { hash: 'log-viewer' });
  return viewerWindow;
}

/** A bounded, app-rendered host window for high-risk approval details. */
export function createMutationApprovalWindow(parent: BrowserWindow | null, title: string): BrowserWindow {
  const rendererEntryPath = getRendererEntryPath();
  const iconPath = getWindowIconPath();
  const activeParent = parent !== null && !parent.isDestroyed() ? parent : null;
  const display = activeParent === null
    ? screen.getPrimaryDisplay()
    : screen.getDisplayMatching(activeParent.getBounds());
  const { width, height } = mutationApprovalWindowSize(display.workAreaSize);
  const approvalWindow = new BrowserWindow({
    ...(activeParent === null ? {} : { parent: activeParent, modal: true }),
    width,
    height,
    minWidth: Math.min(420, width),
    minHeight: Math.min(360, height),
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title,
    autoHideMenuBar: true,
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  approvalWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  approvalWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, rendererEntryPath)) event.preventDefault();
  });
  approvalWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  approvalWindow.once('ready-to-show', () => {
    if (approvalWindow.isDestroyed()) return;
    approvalWindow.show();
    approvalWindow.focus();
  });
  return approvalWindow;
}
