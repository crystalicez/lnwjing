import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const requiredCompilerChecks = {
  strict: true,
  noImplicitAny: true,
  noImplicitThis: true,
  strictNullChecks: true,
  strictFunctionTypes: true,
  strictBindCallApply: true,
  strictPropertyInitialization: true,
  strictBuiltinIteratorReturn: true,
  useUnknownInCatchVariables: true,
  alwaysStrict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noFallthroughCasesInSwitch: true,
  noUncheckedSideEffectImports: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  noEmitOnError: true,
  forceConsistentCasingInFileNames: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
} as const;

describe('monorepo TypeScript strictness contract', () => {
  it('retains strict TypeScript 6 production compiler guarantees at the shared root', () => {
    const config = JSON.parse(readFileSync(path.join(repositoryRoot, 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(config.compilerOptions).toMatchObject(requiredCompilerChecks);
  });

  it('applies the same base strictness to all referenced application and package build configs', () => {
    const root = JSON.parse(readFileSync(path.join(repositoryRoot, 'tsconfig.json'), 'utf8')) as {
      references: Array<{ path: string }>;
    };
    const projects = root.references.map(({ path: project }) => path.resolve(repositoryRoot, project));
    expect(projects.length).toBeGreaterThan(15);
    for (const project of projects) {
      if (project.endsWith(path.join('apps', 'desktop'))) {
        for (const name of ['tsconfig.main.json', 'tsconfig.renderer.json']) {
          const config = JSON.parse(readFileSync(path.join(project, name), 'utf8')) as {
            extends?: string; compilerOptions?: Record<string, unknown>;
          };
          expect(config.extends, name).toBe('../../tsconfig.base.json');
          for (const key of Object.keys(requiredCompilerChecks)) {
            expect(config.compilerOptions?.[key], `${name} must not relax ${key}`).toBeUndefined();
          }
        }
        continue;
      }
      const config = JSON.parse(readFileSync(path.join(project, 'tsconfig.json'), 'utf8')) as {
        extends?: string; compilerOptions?: Record<string, unknown>;
      };
      expect(config.extends, project).toBe('../../tsconfig.base.json');
      for (const key of Object.keys(requiredCompilerChecks)) {
        expect(config.compilerOptions?.[key], `${project} must not relax ${key}`).toBeUndefined();
      }
    }
  });
});
