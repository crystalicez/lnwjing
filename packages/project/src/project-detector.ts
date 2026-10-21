import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import type { PackageManager, ProjectCommandKind, ProjectFramework, ProjectKind, ProjectProfile } from './project-profile.js';

export interface ProjectFileSystem {
  readFile(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  listEntries?(rootPath: string): Promise<readonly string[]>;
}

class NodeProjectFileSystem implements ProjectFileSystem {
  public readFile(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
  }

  public async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async listEntries(rootPath: string): Promise<readonly string[]> {
    return (await readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }
}

const LOCKFILE_PRECEDENCE: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

const CONFIG_FILE_NAMES = [
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vitest.config.ts',
  'vitest.config.js',
  'eslint.config.js',
  'eslint.config.mjs',
  'webpack.config.js',
  'next.config.js',
  'next.config.mjs',
  'biome.json',
  'pytest.ini',
  'tox.ini',
  'ruff.toml',
];

const PRIMARY_KIND_ORDER: readonly Exclude<ProjectKind, 'unknown'>[] = ['node', 'python', 'rust', 'go', 'php', 'java', 'dotnet'];

export class ProjectDetector {
  public constructor(private readonly fileSystem: ProjectFileSystem = new NodeProjectFileSystem()) {}

  public async detect(rootPath: string): Promise<Result<ProjectProfile>> {
    let entries: readonly string[];
    try {
      entries = this.fileSystem.listEntries === undefined
        ? await this.legacyRootEntries(rootPath)
        : await this.fileSystem.listEntries(rootPath);
    } catch {
      return err(appError('INVALID_INPUT', 'Project root cannot be read'));
    }
    const entrySet = new Set(entries);
    const detectedFiles = this.detectManifestFiles(entries);
    const platforms = this.detectPlatforms(entries);
    const kind = PRIMARY_KIND_ORDER.find((candidate) => platforms.includes(candidate)) ?? 'unknown';
    const configFiles = await this.findConfigFiles(rootPath);

    let packageManager: PackageManager = 'unknown';
    let frameworks: ProjectFramework[] = [];
    let scripts: Record<string, string> = {};
    if (entrySet.has('package.json')) {
      let packageJson: unknown;
      try {
        packageJson = JSON.parse(await this.fileSystem.readFile(path.join(rootPath, 'package.json'))) as unknown;
      } catch {
        return err(appError('INVALID_INPUT', 'package.json is not valid JSON'));
      }
      if (!this.isPackageJson(packageJson)) return err(appError('INVALID_INPUT', 'package.json has an invalid shape'));
      packageManager = await this.detectPackageManager(rootPath);
      frameworks = await this.detectFrameworks(rootPath, packageJson);
      scripts = packageJson.scripts ?? {};
    }

    return ok({
      rootPath,
      kind,
      packageManager,
      frameworks,
      scripts,
      configFiles,
      confidence: platforms.length > 0 ? this.detectionConfidence(detectedFiles) : configFiles.length > 0 ? 'weak' : 'none',
      detectedFiles,
      platforms,
      suggestedCommands: this.suggestCommands(kind, scripts, detectedFiles),
    });
  }

  private async legacyRootEntries(rootPath: string): Promise<readonly string[]> {
    const candidates = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts'];
    const existing = await Promise.all(candidates.map(async (filename) => (
      await this.fileSystem.exists(path.join(rootPath, filename)) ? filename : null
    )));
    return existing.flatMap((filename) => filename === null ? [] : [filename]);
  }

  private detectManifestFiles(entries: readonly string[]): string[] {
    const exact = new Set([
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'setup.py',
      'Cargo.toml',
      'go.mod',
      'composer.json',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
    ]);
    return entries.filter((entry) => exact.has(entry) || entry.endsWith('.sln') || entry.endsWith('.csproj')).sort();
  }

  private detectPlatforms(entries: readonly string[]): Exclude<ProjectKind, 'unknown'>[] {
    const files = new Set(entries);
    const detected = new Set<Exclude<ProjectKind, 'unknown'>>();
    if (files.has('package.json')) detected.add('node');
    if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('setup.py')) detected.add('python');
    if (files.has('Cargo.toml')) detected.add('rust');
    if (files.has('go.mod')) detected.add('go');
    if (files.has('composer.json')) detected.add('php');
    if (files.has('pom.xml') || files.has('build.gradle') || files.has('build.gradle.kts')) detected.add('java');
    if (entries.some((entry) => entry.endsWith('.sln') || entry.endsWith('.csproj'))) detected.add('dotnet');
    return PRIMARY_KIND_ORDER.filter((kind) => detected.has(kind));
  }

  private detectionConfidence(detectedFiles: readonly string[]): 'strong' | 'medium' {
    if (detectedFiles.length === 1 && detectedFiles[0] === 'requirements.txt') return 'medium';
    return 'strong';
  }

  private suggestCommands(
    kind: ProjectKind,
    scripts: Readonly<Record<string, string>>,
    detectedFiles: readonly string[],
  ): Readonly<Partial<Record<ProjectCommandKind, string>>> {
    if (kind === 'node') {
      return Object.fromEntries((['dev', 'test', 'lint', 'typecheck', 'build'] as const)
        .flatMap((command) => scripts[command] === undefined ? [] : [[command, scripts[command]]])) as Partial<Record<ProjectCommandKind, string>>;
    }
    if (kind === 'rust') return { test: 'cargo test', typecheck: 'cargo check', build: 'cargo build' };
    if (kind === 'go') return { test: 'go test ./...', build: 'go build ./...' };
    if (kind === 'java') {
      if (detectedFiles.includes('pom.xml')) return { test: 'mvn test', build: 'mvn package' };
      return { test: 'gradle test', build: 'gradle build' };
    }
    if (kind === 'dotnet') return { test: 'dotnet test', build: 'dotnet build' };
    return {};
  }

  private async detectPackageManager(rootPath: string): Promise<PackageManager> {
    for (const [filename, manager] of LOCKFILE_PRECEDENCE) {
      if (await this.fileSystem.exists(path.join(rootPath, filename))) return manager;
    }
    return 'npm';
  }

  private async detectFrameworks(rootPath: string, packageJson: PackageJson): Promise<ProjectFramework[]> {
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ]);
    const frameworks = new Set<ProjectFramework>();
    if (dependencyNames.has('react') || dependencyNames.has('react-dom')) frameworks.add('react');
    if (dependencyNames.has('typescript') || await this.fileSystem.exists(path.join(rootPath, 'tsconfig.json'))) frameworks.add('typescript');
    if (dependencyNames.has('vite') || await this.fileSystem.exists(path.join(rootPath, 'vite.config.ts'))) frameworks.add('vite');
    return [...frameworks].sort();
  }

  private async findConfigFiles(rootPath: string): Promise<string[]> {
    const existing = await Promise.all(CONFIG_FILE_NAMES.map(async (filename) => (
      await this.fileSystem.exists(path.join(rootPath, filename)) ? filename : null
    )));
    return existing.flatMap((filename) => filename === null ? [] : [filename]).sort();
  }

  private isPackageJson(value: unknown): value is PackageJson {
    if (typeof value !== 'object' || value === null) return false;
    if ('scripts' in value && !this.isStringRecordOrUndefined(value.scripts)) return false;
    return this.isStringRecordOrUndefined('dependencies' in value ? value.dependencies : undefined)
      && this.isStringRecordOrUndefined('devDependencies' in value ? value.devDependencies : undefined)
      && this.isStringRecordOrUndefined('peerDependencies' in value ? value.peerDependencies : undefined);
  }

  private isStringRecordOrUndefined(value: unknown): value is Record<string, string> | undefined {
    if (value === undefined) return true;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.values(value).every((entry) => typeof entry === 'string');
  }
}

interface PackageJson {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}
