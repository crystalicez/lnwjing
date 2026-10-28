import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
}

describe('public repository hygiene', () => {
  it('ignores exported lnwjing diagnostic text logs at the repository root', async () => {
    const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
    expect(ignore).toContain('lnwjing-*-logs.txt');
  });

  it('does not track generated stdio bundles', async () => {
    const tracked = await trackedFiles();
    const generated = [
      'apps/desktop/build/lnwjing-mcp-stdio.cjs',
      'apps/desktop/build/lnwjing-mcp-stdio.cmd',
      'apps/desktop/build/lnwjing-mcp-stdio.mjs',
      'apps/desktop/build/lnwjing-node.exe',
    ];

    for (const file of generated) {
      expect(tracked, `${file} must be generated during build, not committed`).not.toContain(file);
    }
  });

  it('does not publish developer-specific paths or private project names', async () => {
    const tracked = await trackedFiles();
    const textExtensions = new Set([
      '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.py', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
    ]);
    const forbidden = [
      new RegExp(['Zenith', ' sphere'].join(''), 'i'),
      new RegExp(['rsn-ayb-', 'pc-planning'].join(''), 'i'),
      new RegExp(['C:', '\\\\', 'Users', '\\\\', 'developer'].join(''), 'i'),
      new RegExp(['\\.gemini', '\\\\', 'antigravity'].join(''), 'i'),
    ];
    const leaks: string[] = [];

    for (const relativePath of tracked) {
      if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
      const absolutePath = path.join(repositoryRoot, relativePath);
      // `git ls-files` includes paths deleted in the current working tree.
      // Ignore those while the deletion is being reviewed; CI still sees the
      // committed tree and scans every file that exists there.
      if (!existsSync(absolutePath)) continue;
      const content = await readFile(absolutePath, 'utf8');
      if (forbidden.some((pattern) => pattern.test(content))) leaks.push(relativePath);
    }

    expect(leaks, `developer-specific content found in: ${leaks.join(', ')}`).toEqual([]);
  }, 15_000);

  it('[version-contract] documents the current published release', async () => {
    const [readme, expandedReadme, packagingWindows, usageTh] = await Promise.all([
      readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'FULL_README.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'docs', 'development', 'PACKAGING_WINDOWS.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'docs', 'USAGE_TH.md'), 'utf8'),
    ]);
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(typeof rootPackage.version).toBe('string');
    const version = rootPackage.version as string;

    const publishedVersion = readme.match(/^## Current published version: v([0-9.]+)$/m)?.[1]
      ?? readme.match(/^## What's new in v([0-9.]+)$/m)?.[1];
    expect(publishedVersion).toBeTruthy();
    expect(expandedReadme).toContain(`## Current published version: v${publishedVersion}`);
    expect(usageTh).toContain(`public release \`v${publishedVersion}\``);
    expect(packagingWindows).toContain(`lnwjing-Setup-${version}.exe`);
    expect(packagingWindows).toContain(`lnwjing-Portable-${version}.exe`);
    expect(packagingWindows).toContain(`apps/desktop/dist/installers/lnwjing-Setup-${version}.exe`);
    expect(packagingWindows).toContain(`apps/desktop/dist/installers/lnwjing-Portable-${version}.exe`);
    expect(readme).not.toContain('current source/release candidate is');
    expect(readme).not.toContain('pending publication');
  });

  it('[version-contract] rejects an invalid semantic version before writing files', async () => {
    const packagePath = path.join(repositoryRoot, 'package.json');
    const before = await readFile(packagePath, 'utf8');
    await expect(execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'set-version.mjs'), 'not-a-version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Invalid semantic version') });
    expect(await readFile(packagePath, 'utf8')).toBe(before);
  });

  it('documents the live tool catalog instead of a hand-maintained count', async () => {
    const { ToolRegistry } = await import('@lnwjing/mcp-server');
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const actor = { clientId: 'public-repo-hygiene', clientName: 'public-repo-hygiene' };
    const defaultRegistry = new ToolRegistry({}, actor);
    const fullRegistry = new ToolRegistry({ agentSwarm: {} as never }, actor, { codexToolsEnabled: true });
    const totalDefinitions = fullRegistry.listAll().length;
    const defaultAdvertised = defaultRegistry.list().length;
    const fullAdvertised = fullRegistry.list().length;
    expect(readme).toContain(`${totalDefinitions} total tool definitions`);
    expect(readme).toContain(`${defaultAdvertised} are advertised by default`);
    expect(readme).toContain(`all ${fullAdvertised} when Codex delegation plus Agent Swarm is enabled`);
    expect(readme).not.toContain(['Verify the ', '184-tool catalog'].join(''));
    expect(readme).not.toContain(['current v3.0.0 catalog contains ', '184 tools'].join(''));
    expect(readme).not.toContain('packaged v3.0.0 build');
    expect(readme).not.toContain('127.0.0.1:39200/mcp');
  }, 15_000); // Allow bounded cold Windows module imports without relaxing the full suite.

  it('does not link README readers to ignored local documentation', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const tracked = new Set(await trackedFiles());
    const localDocLinks = Array.from(readme.matchAll(/\[[^\]]+\]\((docs\/[^)#]+)(?:#[^)]+)?\)/g), (match) => match[1]);
    const missing = localDocLinks.filter((link): link is string => {
      if (link === undefined) return false;
      // Newly added documentation is intentionally untracked until the phase
      // gate is approved. It is still a valid public link when the file exists
      // and is not an ignored local-only artifact.
      return !tracked.has(link) && !existsSync(path.join(repositoryRoot, link));
    });

    expect(missing, `README links to untracked docs: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the real desktop MCP port and bundled OpenAI tunnel client', async () => {
    const envExample = await readFile(path.join(repositoryRoot, '.env.example'), 'utf8');
    const settings = await readFile(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'messages.ts'),
      'utf8',
    );

    expect(envExample).toContain('LNWJING_MCP_PORT=18765');
    expect(envExample).not.toContain('LNWJING_PORT=3000');
    expect(settings).toContain('OpenAI Secure MCP Tunnel');
    expect(settings).not.toContain('Cloudflare Remote Tunnel');

    const settingsPage = await readFile(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer', 'features', 'settings', 'SettingsPage.tsx'),
      'utf8',
    );
    expect(settings).toContain("'settingsPage.tunnelClientBundledPlaceholder': 'Bundled v0.0.15 is used automatically'");
    expect(settings).toContain("'settingsPage.useBundled': 'Use bundled'");
    expect(settingsPage).toContain("t('settingsPage.tunnelClientBundledPlaceholder')");
    expect(settingsPage).toContain("t('settingsPage.useBundled')");
    expect(settingsPage).not.toContain('placeholder="C:\\tools\\tunnel-client.exe"');
  });

  it('does not retain stale permission examples in the detailed README guide', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'FULL_README.md'), 'utf8');
    expect(readme).not.toMatch(/^\| (?:\d+ \| `)?workspace_list`? \| (?:EXECUTE|DANGEROUS) \|/m);
    expect(readme).toMatch(/^\| 1 \| `workspace_list` \| READ \|/m);
    expect(readme).toContain('| workspace_list | READ |');
  });

  it('keeps release documentation canonical instead of preserving stale candidate instructions', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const legacyChecklist = await readFile(path.join(repositoryRoot, 'docs', 'development', 'RELEASE_CHECKLIST.md'), 'utf8');
    const releaseProcess = await readFile(path.join(repositoryRoot, 'docs', 'development', 'RELEASE_PROCESS.md'), 'utf8');

    expect(readme).toContain('docs/development/RELEASE_PROCESS.md');
    expect(legacyChecklist).toContain('[RELEASE_PROCESS.md](RELEASE_PROCESS.md)');
    expect(legacyChecklist).not.toContain('v4.9.1');
    expect(releaseProcess).toContain('canonical release sequence');
  });

  it('pins third-party GitHub Actions to immutable full commit SHAs', async () => {
    const workflows = (await trackedFiles()).filter((relativePath) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(relativePath));
    const violations: string[] = [];

    for (const workflow of workflows) {
      const content = await readFile(path.join(repositoryRoot, workflow), 'utf8');
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const uses = line.match(/^\s*uses:\s*([^\s#]+)/)?.[1];
        if (uses === undefined || uses.startsWith('./') || uses.startsWith('docker://')) continue;
        const actionName = uses.slice(0, uses.lastIndexOf('@'));
        const revision = uses.slice(uses.lastIndexOf('@') + 1);
        if (actionName.startsWith('actions/')) continue;
        if (!/^[0-9a-f]{40}$/i.test(revision)) violations.push(`${workflow}:${index + 1} ${uses}`);
      }
    }

    expect(violations, `third-party GitHub Actions must use full commit SHAs: ${violations.join(', ')}`).toEqual([]);
  });

  it('keeps recurring scheduled cleanup explicit and host-proven before terminal completion', async () => {
    const skill = await readFile(path.join(repositoryRoot, '.agents', 'skills', 'lnwjing-scheduled-continuation', 'SKILL.md'), 'utf8');
    expect(skill).toContain('`terminal_cleanup_required`');
    expect(skill).toContain('Make the exact recurring native task non-runnable');
    expect(skill).toContain('host-confirmed delete or disable evidence');
    expect(skill).toContain('A recurring run receipt is **not** cleanup proof');
  });

  it('rejects outside pull requests without executing untrusted pull-request code', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'reject-external-prs.yml'), 'utf8');
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('OWNER');
    expect(workflow).toContain('MEMBER');
    expect(workflow).toContain('COLLABORATOR');
    expect(workflow).toContain('gh pr close');
    expect(workflow).toContain('/lock');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('github.event.pull_request.head');
  });
});
