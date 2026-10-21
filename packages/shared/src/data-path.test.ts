import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLnwjingDataPath } from './data-path.js';

describe('resolveLnwjingDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    expect(resolveLnwjingDataPath({ LNWJING_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe(path.win32.resolve('D:\\agent-data'));
  });

  it('defaults to the per-user roaming AppData lnwjing directory', () => {
    expect(resolveLnwjingDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe(path.win32.resolve('C:\\Users\\u\\AppData\\Roaming\\lnwjing'));
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    expect(resolveLnwjingDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming', 'win32')).toBe(path.win32.resolve('C:\\Users\\end-user\\AppData\\Roaming\\lnwjing'));
  });

  it.each([
    ['darwin', '/Users/alice/Library/Application Support/lnwjing'],
    ['linux', '/home/alice/.local/share/lnwjing'],
  ] as const)('uses host-native default data paths on %s', (platform, expected) => {
    expect(resolveLnwjingDataPath({ HOME: platform === 'darwin' ? '/Users/alice' : '/home/alice' }, undefined, platform)).toBe(expected);
  });

  it('prefers the Electron appData path in packaged macOS/Linux mode', () => {
    expect(resolveLnwjingDataPath({ HOME: '/Users/alice' }, '/Users/alice/Library/Application Support', 'darwin')).toBe('/Users/alice/Library/Application Support/lnwjing');
    expect(resolveLnwjingDataPath({ HOME: '/home/alice' }, '/home/alice/.config', 'linux')).toBe('/home/alice/.config/lnwjing');
  });

  it('uses an absolute XDG data directory on Linux and ignores a relative one', () => {
    expect(resolveLnwjingDataPath({ HOME: '/home/alice', XDG_DATA_HOME: '/mnt/data' }, undefined, 'linux')).toBe('/mnt/data/lnwjing');
    expect(resolveLnwjingDataPath({ HOME: '/home/alice', XDG_DATA_HOME: 'relative' }, undefined, 'linux')).toBe('/home/alice/.local/share/lnwjing');
  });

  it('ignores relative explicit data-path overrides instead of resolving them against the process cwd', () => {
    expect(resolveLnwjingDataPath({ LNWJING_DATA_PATH: 'relative-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32'))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\lnwjing');
    expect(resolveLnwjingDataPath({ LNWJING_DATA_PATH: 'relative-data', HOME: '/home/alice' }, undefined, 'linux'))
      .toBe('/home/alice/.local/share/lnwjing');
  });

  it('ignores relative Electron appData values on every platform', () => {
    expect(resolveLnwjingDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'relative-appdata', 'win32'))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\lnwjing');
    expect(resolveLnwjingDataPath({ HOME: '/Users/alice' }, 'relative-appdata', 'darwin'))
      .toBe('/Users/alice/Library/Application Support/lnwjing');
    expect(resolveLnwjingDataPath({ HOME: '/home/alice' }, 'relative-appdata', 'linux'))
      .toBe('/home/alice/.local/share/lnwjing');
  });
});
