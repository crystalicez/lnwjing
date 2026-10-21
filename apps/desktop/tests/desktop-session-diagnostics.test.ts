import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopSessionDiagnostics, previousDesktopSessionEndedUncleanly } from '../src/main/desktop-session-diagnostics.js';

const roots: string[] = [];
const tempRoot = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'lnwjing-session-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('DesktopSessionDiagnostics', () => {
  it('distinguishes an unclean previous session from a clean exit', () => {
    const root = tempRoot();
    const first = new DesktopSessionDiagnostics(root, '5.3.0');
    first.start();
    const second = new DesktopSessionDiagnostics(root, '5.3.0');
    second.start();
    expect(previousDesktopSessionEndedUncleanly(second.snapshot())).toBe(true);
    second.markCleanExit();
    const third = new DesktopSessionDiagnostics(root, '5.3.0');
    third.start();
    expect(previousDesktopSessionEndedUncleanly(third.snapshot())).toBe(false);
    third.markCleanExit();
  });

  it('never terminates the desktop when the diagnostics file cannot be written', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'diagnostics'), 'not-a-directory');
    const errors: unknown[] = [];
    const diagnostics = new DesktopSessionDiagnostics(root, '5.3.0', () => new Date(), (error) => { errors.push(error); });
    expect(() => diagnostics.start()).not.toThrow();
    expect(() => diagnostics.markShutdownRequested('test')).not.toThrow();
    expect(() => diagnostics.markCleanExit()).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});
