import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TunnelAliasRetirementJournal, tunnelAliasRecoveryDirectory } from '../src/main/tunnel-runtime-alias-journal.js';

describe('TunnelAliasRetirementJournal', () => {
  it('restores an interrupted local alias retirement on the next launch, without changing unrelated profiles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-alias-recovery-'));
    try {
      const profile = path.join(root, 'profiles');
      const appData = path.join(root, 'app-data');
      await mkdir(profile);
      await mkdir(appData);
      const owned = path.join(profile, 'lnwjing.yaml');
      const unrelated = path.join(profile, 'other.yaml');
      await writeFile(owned, 'new-tunnel-id');
      await writeFile(unrelated, 'unrelated-tunnel');
      const directory = tunnelAliasRecoveryDirectory(appData);
      expect(path.relative(appData, directory).startsWith('..')).toBe(true);
      const journal = new TunnelAliasRetirementJournal(directory, profile);
      await journal.prepare([{ file: owned, data: Buffer.from('new-tunnel-id'), mode: 0o600 }]);
      await rm(owned);
      // Simulate termination after runtimes rm deleted the profile but before recovery.
      await new TunnelAliasRetirementJournal(directory, profile).recover();
      expect(await readFile(owned, 'utf8')).toBe('new-tunnel-id');
      expect(await readFile(unrelated, 'utf8')).toBe('unrelated-tunnel');
      await expect(access(path.join(directory, 'tunnel-alias-retirement-v1'))).rejects.toMatchObject({ code: 'ENOENT' });
      // A new app startup can safely repeat recovery.
      await expect(journal.recover()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers an owned profile after the native CLI removes the entire profile directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-alias-removed-profile-'));
    try {
      const profile = path.join(root, 'profile');
      await mkdir(profile);
      const file = path.join(profile, 'lnwjing.yaml');
      const directory = tunnelAliasRecoveryDirectory(path.join(root, 'appdata'));
      const journal = new TunnelAliasRetirementJournal(directory, profile);
      await journal.prepare([{ file, data: Buffer.from('saved-new-tunnel'), mode: 0o600 }]);
      await rm(profile, { recursive: true });
      await expect(new TunnelAliasRetirementJournal(directory, profile).recover()).resolves.toBeUndefined();
      expect(await readFile(file, 'utf8')).toBe('saved-new-tunnel');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never recursively deletes a foreign artifact in an interrupted journal directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-alias-unowned-'));
    try {
      const profile = path.join(root, 'profile');
      await mkdir(profile);
      const directory = tunnelAliasRecoveryDirectory(path.join(root, 'appdata'));
      const journalRoot = path.join(directory, 'tunnel-alias-retirement-v1');
      await mkdir(journalRoot, { recursive: true });
      await writeFile(path.join(journalRoot, 'other-tunnel.log'), 'preserve');
      const journal = new TunnelAliasRetirementJournal(directory, profile);
      await expect(journal.recover()).rejects.toThrow('unowned files');
      expect(await readFile(path.join(journalRoot, 'other-tunnel.log'), 'utf8')).toBe('preserve');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a newly changed profile and retains recoverable backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-alias-conflict-'));
    try {
      const profile = path.join(root, 'profile');
      await mkdir(profile);
      const owned = path.join(profile, 'lnwjing.yaml');
      const directory = tunnelAliasRecoveryDirectory(path.join(root, 'app-data'));
      const journal = new TunnelAliasRetirementJournal(directory, profile);
      await journal.prepare([{ file: owned, data: Buffer.from('preserved-original'), mode: 0o600 }]);
      await writeFile(owned, 'changed-by-another-actor');
      await expect(journal.recover()).rejects.toThrow('refuses to overwrite');
      expect(await readFile(owned, 'utf8')).toBe('changed-by-another-actor');
      await expect(access(path.join(directory, 'tunnel-alias-retirement-v1', 'manifest.json'))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
