import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bundledSkillRootCandidates, createLocalExtensionsService } from './create-local-extensions.js';

const shippedNames = [
  'lnwjing-scheduled-continuation',
  'ponytail', 'ponytail-review', 'ponytail-audit',
  'ponytail-debt', 'ponytail-gain', 'ponytail-help',
] as const;

it('discovers all seven repository-owned skills as bundled without workspace .agents', async () => {
  const roots = bundledSkillRootCandidates();
  expect(roots.some((root) => root.endsWith(path.join('assets', 'bundled-skills')))).toBe(true);

  const service = createLocalExtensionsService({
    homeDir: path.join(os.tmpdir(), 'lnwjing-bundled-skill-source-no-global-root'),
  });
  const result = await service.listSkills({ source: 'bundled:agent-skills' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.skills.map((skill) => skill.id).sort()).toEqual(
    shippedNames.map((name) => `bundled:agent-skills/${name}`).sort(),
  );
  for (const name of shippedNames) {
    const read = await service.readSkill({ skillId: `bundled:agent-skills/${name}` });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.name).toBe(name);
      expect(read.value.trustTier).toBe('bundled');
      expect(read.value.path).toContain(path.join('assets', 'bundled-skills', name));
    }
  }
});
