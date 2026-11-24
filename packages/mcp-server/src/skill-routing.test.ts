import { describe, expect, it } from 'vitest';

import { rankSkillMatches, selectAutoSkillMatches } from './skill-routing.js';

describe('skill routing', () => {
  it('ranks a relevant trusted skill from natural-language intent', () => {
    const ranked = rankSkillMatches([
      { id: 'user/diagnosing-bugs', name: 'diagnosing-bugs', description: 'Diagnose hard bugs and performance regressions', source: 'user', trustTier: 'user' },
      { id: 'user/frontend-design', name: 'frontend-design', description: 'Design visual frontend interfaces', source: 'user', trustTier: 'user' },
    ], 'diagnose the hard lifecycle bug and performance regression', 2);

    expect(ranked[0]?.skill.id).toBe('user/diagnosing-bugs');
    expect(selectAutoSkillMatches(ranked).map((match) => match.skill.id)).toEqual(['user/diagnosing-bugs']);
  });

  it('does not inject an unrelated description-only skill into a coding audit', () => {
    const skills = [
      { id: 'user/create-pet', name: 'create-pet', description: 'Create, repair, validate, preview, upload, or activate a pet. Inspect artifacts and test quality. Use tool workflow, source images and acceptance tests.', trustTier: 'user' },
      { id: 'user/code-audit', name: 'code-audit', description: 'Audit code, architecture, acceptance tests and actual tool behavior.', trustTier: 'user' },
    ];
    const objective = 'Independent real acceptance audit of latest runtime: UI workflows, architecture, MCP discovery/contract and correctness; add reproducible isolated black-box tests, repair confirmed issues, validate without touching active production profile or other repositories.';
    expect(selectAutoSkillMatches(rankSkillMatches(skills.slice(0, 1), objective))).toEqual([]);
    expect(selectAutoSkillMatches(rankSkillMatches(skills, objective)).map(match => match.skill.id)).toEqual(['user/code-audit']);
    expect(selectAutoSkillMatches(rankSkillMatches(skills, 'use skill create-pet for this task')).map(match => match.skill.id)).toEqual(['user/create-pet']);
  });

  it('does not auto-load an external skill unless the user names it explicitly', () => {
    const skills = [
      { id: 'extra:repo/diagnosing-bugs', name: 'diagnosing-bugs', description: 'Diagnose hard bugs and performance regressions', source: 'extra:repo', trustTier: 'external' },
    ];

    expect(selectAutoSkillMatches(rankSkillMatches(skills, 'diagnose the hard bug and performance regression', 2))).toEqual([]);

    const explicit = selectAutoSkillMatches(rankSkillMatches(skills, 'use skill diagnosing-bugs for this task', 2));
    expect(explicit.map((match) => match.skill.id)).toEqual(['extra:repo/diagnosing-bugs']);
    expect(explicit[0]?.explicit).toBe(true);
  });
});
