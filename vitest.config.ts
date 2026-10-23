import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Private local artifacts are not repository regression tests. Scanning
    // their scratch fixtures can invoke stale experiments, leak local paths in
    // test logs, and cause unnecessary disk I/O on large workspaces.
    exclude: [
      ...configDefaults.exclude,
      '**/.audit/**',
      '**/.local-artifacts/**',
      '**/.worktrees/**',
      '**/.superpowers/**',
      '**/.kilo/**',
    ],
  },
});
