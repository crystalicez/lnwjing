import { readFileSync } from 'node:fs';
import type { UpdateStatus } from '@lnwjing/ipc-contracts';
import { describe, expect, it, vi } from 'vitest';
import { nativeMessages } from '../src/main/native-i18n.js';
import {
  createTrayMenuTemplate,
  createTrayToolTip,
  createTrayUpdateLabel,
  getTrayIconPath,
  shouldHideMainWindowOnClose,
} from '../src/main/tray.js';

describe('desktop tray behavior', () => {
  it('exposes Thai open, update, and quit actions in the context menu', () => {
    const actions = {
      locale: 'th' as const,
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      quit: vi.fn(),
    };
    const menu = createTrayMenuTemplate(actions);

    expect(menu.map((item) => item.type === 'separator' ? 'separator' : item.label)).toEqual([
      'เปิดหน้า',
      'ตรวจอัปเดต',
      'separator',
      'ปิดโปรแกรม',
    ]);

    menu[0]?.click?.();
    menu[1]?.click?.();
    menu[3]?.click?.();
    expect(actions.openMainWindow).toHaveBeenCalledOnce();
    expect(actions.checkForUpdates).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it('localizes the whole tray menu to English', () => {
    const menu = createTrayMenuTemplate({
      locale: 'en',
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      quit: vi.fn(),
    });

    expect(menu.map((item) => item.type === 'separator' ? 'separator' : item.label)).toEqual([
      'Open lnwjing',
      'Check for Updates',
      'separator',
      'Quit',
    ]);
  });

  it('shows a contextual install label when an update is ready', () => {
    const actions = {
      locale: 'th' as const,
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      updateLabel: 'ติดตั้งอัปเดต v4.7.0',
      quit: vi.fn(),
    };
    const menu = createTrayMenuTemplate(actions);

    expect(menu[1]?.label).toBe('ติดตั้งอัปเดต v4.7.0');
    menu[1]?.click?.();
    expect(actions.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('localizes updater state labels and the tray tooltip', () => {
    const ready: UpdateStatus = {
      phase: 'ready',
      currentVersion: '4.6.1',
      availableVersion: '4.6.2',
      progressPercent: 100,
      lastCheckedAt: null,
      message: null,
      canInstall: true,
    };
    const downloading: UpdateStatus = {
      ...ready,
      phase: 'downloading',
      progressPercent: 42.4,
      canInstall: false,
    };

    expect(createTrayUpdateLabel(ready, 'th')).toBe('ติดตั้งอัปเดต v4.6.2');
    expect(createTrayUpdateLabel(ready, 'en')).toBe('Install update v4.6.2');
    expect(createTrayUpdateLabel(downloading, 'th')).toBe('กำลังดาวน์โหลด v4.6.2 42%');
    expect(createTrayUpdateLabel(downloading, 'en')).toBe('Downloading v4.6.2 42%');
    expect(createTrayToolTip('th')).toBe('lnwjing — ทำงานเบื้องหลัง');
    expect(createTrayToolTip('en')).toBe('lnwjing — running in background');
  });

  it('uses a PNG source for the macOS menu-bar icon instead of the Windows ICO', () => {
    const iconPath = getTrayIconPath('darwin');
    expect(iconPath).toBeDefined();
    expect(iconPath?.toLowerCase().endsWith('.png')).toBe(true);
  });

  it('uses a PNG source for Linux status trays instead of the Windows ICO', () => {
    const iconPath = getTrayIconPath('linux');
    expect(iconPath).toBeDefined();
    expect(iconPath?.toLowerCase().endsWith('.png')).toBe(true);
  });

  it('marks the macOS menu-bar image as a template image for native light/dark rendering', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("process.platform === 'darwin'");
    expect(main).toContain('trayImage.setTemplateImage(true);');
  });

  it('respects the configured close behavior while still allowing an intentional quit', () => {
    expect(shouldHideMainWindowOnClose(false)).toBe(true);
    expect(shouldHideMainWindowOnClose(false, 'tray')).toBe(true);
    expect(shouldHideMainWindowOnClose(false, 'quit')).toBe(false);
    expect(shouldHideMainWindowOnClose(true, 'tray')).toBe(false);
    expect(shouldHideMainWindowOnClose(true, 'quit')).toBe(false);
  });

  it('keeps manual update feedback localized in the native catalog', () => {
    expect(nativeMessages('th').updateCurrentDialog('4.6.1')).toBe('lnwjing v4.6.1 เป็นเวอร์ชันล่าสุดแล้ว');
    expect(nativeMessages('en').updateCurrentDialog('4.6.1')).toBe('lnwjing v4.6.1 is up to date');
  });
});
