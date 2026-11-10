import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { expect, it } from 'vitest';
import { stageFactoryResetSync, factoryResetMarkerPath } from '../../apps/desktop/src/main/factory-reset.js';

const repository = path.resolve(import.meta.dirname, '..', '..');
const executable = path.join(repository, '.audit', 'settings-reset-portable-candidate', 'win-unpacked', 'lnwjing.exe');

async function invoke(executablePath: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(executablePath, args, { cwd: repository, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Packaged reset-bootstrap deadline exceeded')), 60_000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', value => { clearTimeout(deadline); resolve(value); });
    });
    return { code, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

it.skipIf(process.platform !== 'win32' || !existsSync(executable))(
  'Windows packaged offline reset bootstrap processes a real v2 marker and preserves settings and keys for relaunch',
  async () => {
    const audit = path.join(repository, '.audit');
    await mkdir(audit, { recursive: true });
    const root = await mkdtemp(path.join(audit, 'settings-reset-native-bootstrap-'));
    const profile = path.join(root, 'profile');
    const tunnel = path.join(root, 'tunnel');
    const project = path.join(root, 'user-project');
    const roaming = path.join(root, 'roaming');
    const local = path.join(root, 'local');
    const temp = path.join(root, 'temp');
    await Promise.all([profile, tunnel, project, roaming, local, temp].map(async dir => mkdir(dir)));
    await writeFile(path.join(project, 'user-source.ts'), 'export const preserveMe = true;');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LNWJING_DATA_PATH: profile,
      APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
      TUNNEL_CLIENT_PROFILE_DIR: tunnel,
      LNWJING_WORKSPACE: '',
      LNWJING_E2E_FIXTURE: '1',
      LNWJING_E2E_NODE_PATH: process.execPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const initial = await invoke(executable, [
        '--mcp-stdio', '--mcp-stdio-profile-init', '--disable-background-networking',
      ], env);
      expect(initial.code, initial.stderr).toBe(0);
      const masterKey = path.join(profile, 'checkpoint-master.key');
      const originalDigest = createHash('sha256').update(await readFile(masterKey)).digest('hex');
      const sqlite = path.join(profile, 'lnwjing.sqlite');
      const db = new DatabaseSync(sqlite);
      try {
        db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);'
          + 'CREATE TABLE workspaces(id TEXT PRIMARY KEY,root_path TEXT NOT NULL,real_root_path TEXT NOT NULL);'
          + 'CREATE TABLE audit_events(id TEXT PRIMARY KEY);');
        db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
        db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('checkpoint_creation_mode_v1', 'always');
        db.prepare('INSERT INTO audit_events(id) VALUES (?)').run('obsolete-call');
        db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
          .run('external-project', project, project);
      } finally { db.close(); }
      const pending = stageFactoryResetSync(profile, 'preserve-settings');
      expect(existsSync(pending)).toBe(true);

      const worker = await invoke(executable, [
        '--lnwjing-apply-factory-reset', '--mcp-stdio', '--mcp-stdio-profile-init',
        '--disable-background-networking',
      ], env);
      expect(worker.code, worker.stderr).toBe(0);
      expect(existsSync(factoryResetMarkerPath(profile))).toBe(false);

      const restored = new DatabaseSync(sqlite, { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM settings WHERE key='ui_locale'").get()).toMatchObject({ value: 'en' });
        expect(restored.prepare("SELECT value FROM settings WHERE key='checkpoint_creation_mode_v1'").get())
          .toMatchObject({ value: 'always' });
        expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='audit_events'").get()).toBeUndefined();
        expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get()).toBeUndefined();
      } finally { restored.close(); }
      expect(createHash('sha256').update(await readFile(masterKey)).digest('hex')).toBe(originalDigest);
      expect(await readFile(path.join(project, 'user-source.ts'), 'utf8')).toBe('export const preserveMe = true;');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 400 });
    }
  },
  120_000,
);
