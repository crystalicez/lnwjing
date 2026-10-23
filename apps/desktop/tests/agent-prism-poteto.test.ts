import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

describe('poteto-mode idle compositing policy', () => {
  it('does not animate the idle prism and only animates a busy agent', () => {
    expect(css).not.toMatch(/(?:^|\n)\.agent-prism-art\s*\{[^}]*animation:/);
    expect(css).not.toMatch(/(?:^|\n)\.agent-prism-orbits\s*\{[^}]*animation:/);
    expect(css).toMatch(/\.agent-prism\.busy \.agent-prism-art\s*\{\s*animation:/);
    expect(css).toMatch(/\.agent-prism\.busy \.agent-prism-orbits\s*\{\s*animation:/);
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  });
});
