import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('macOS trust evidence contract', () => {
  it('keeps signing/notarization verification target-native and fail-closed', async (): Promise<void> => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-macos-release.sh'), 'utf8');
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('hdiutil verify');
    expect(script).toContain('xcrun stapler validate');
    expect(script).toContain('LNWJING_REQUIRE_NOTARIZATION');
    expect(script).toContain('must run on macOS');
    expect(script).toContain('inspect-macos-signing-policy.mjs');
    expect(script).toContain('--provenance');
    expect(script).toContain('PROVENANCE.json');
    expect(script).toContain('macOS effective signing policy verified');
    expect(script).toContain('macOS distributable must be signed');
    expect(script).toContain('-L');
    expect(script).not.toMatch(/CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/);
  });

  it('bounds every recursive macOS smoke cleanup to the configured temporary root', async (): Promise<void> => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'stage-macos-smoke-app.sh'), 'utf8');
    expect(script).toContain('allowed_root_real');
    expect(script).toContain('destination_parent_real');
    expect(script).toContain('refusing destination outside the temporary root');
    expect(script).toContain('safe_remove_directory');
    expect(script).toContain("mode=\"${3:-launch}\"");
    expect(script).toContain('stage-only');
    expect(script).not.toContain('rm -rf "$destination"');
  });

  it('keeps the library-validation bypass scoped to community ad-hoc Electron processes', async (): Promise<void> => {
    const build = path.join(repositoryRoot, 'apps', 'desktop', 'build');
    const standardRoot = await readFile(path.join(build, 'entitlements.mac.plist'), 'utf8');
    const standardInherited = await readFile(path.join(build, 'entitlements.mac.inherit.plist'), 'utf8');
    const adHocRoot = await readFile(path.join(build, 'entitlements.mac.adhoc.plist'), 'utf8');
    const adHocInherited = await readFile(path.join(build, 'entitlements.mac.adhoc.inherit.plist'), 'utf8');

    for (const standard of [standardRoot, standardInherited]) {
      expect(standard).not.toContain('com.apple.security.cs.disable-library-validation');
      expect(standard).toContain('com.apple.security.cs.allow-jit');
      expect(standard).toContain('com.apple.security.network.client');
    }
    for (const community of [adHocRoot, adHocInherited]) {
      expect(community).toContain('com.apple.security.cs.disable-library-validation');
      expect(community).toContain('com.apple.security.cs.allow-jit');
      expect(community).toContain('com.apple.security.network.client');
    }
    expect(standardRoot).toContain('com.apple.security.files.user-selected.read-write');
    expect(adHocRoot).toContain('com.apple.security.files.user-selected.read-write');
    expect(standardInherited).not.toContain('com.apple.security.files.user-selected.read-write');
    expect(adHocInherited).not.toContain('com.apple.security.files.user-selected.read-write');
    const keys = (plist: string): string[] => [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1] ?? '');
    expect(keys(standardRoot)).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.network.client',
      'com.apple.security.files.user-selected.read-write',
    ]);
    expect(keys(standardInherited)).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.network.client',
    ]);
    expect(keys(adHocRoot)).toEqual([...keys(standardRoot), 'com.apple.security.cs.disable-library-validation']);
    expect(keys(adHocInherited)).toEqual([...keys(standardInherited), 'com.apple.security.cs.disable-library-validation']);

    await Promise.all([
      access(path.join(build, 'entitlements.mac.plist')),
      access(path.join(build, 'entitlements.mac.inherit.plist')),
      access(path.join(build, 'entitlements.mac.adhoc.plist')),
      access(path.join(build, 'entitlements.mac.adhoc.inherit.plist')),
    ]);
  });
});
