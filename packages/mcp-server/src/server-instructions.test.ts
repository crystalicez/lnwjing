import { describe, expect, it } from 'vitest';
import { BUNDLED_PONYTAIL_SKILL_ID } from './ponytail-runtime.js';
import { MCP_OUTCOME_DRIVEN_INSTRUCTIONS, buildMcpInstructions } from './server.js';

describe('MCP Ponytail instructions', () => {
  it('keeps the OFF instruction contract identical to the existing baseline', () => {
    expect(buildMcpInstructions('off')).toBe(MCP_OUTCOME_DRIVEN_INSTRUCTIONS);
    expect(buildMcpInstructions('off')).not.toContain(BUNDLED_PONYTAIL_SKILL_ID);
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('use checkpoint_goal and session_handoff only');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('call session_handoff before any new mutation');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('do not rerun completed work');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('Never invoke generic handoff skills');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('use those tools directly in the current conversation');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('Do not ask or suggest switching to ChatGPT Work, Codex');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('the required capability is not available through the exposed lnwjing tools');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).not.toContain('engineering_prepare_task');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).not.toContain('engineering_start_task');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('unless the user explicitly disabled scheduling');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).not.toContain('lnwjing_o');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('USER_INSTRUCTIONS');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('Goal freshness is user-visible state');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('at least every 10 minutes');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('reconcile or finalize superseded/completed Goals promptly');
  });

  it('adds Engineering guidance only after an explicit Harness opt-in', () => {
    const instructions = buildMcpInstructions('off', true);
    expect(instructions).toContain(MCP_OUTCOME_DRIVEN_INSTRUCTIONS);
    expect(instructions).toContain('call engineering_prepare_task');
    expect(instructions).toContain('call engineering_start_task');
    expect(instructions).toContain('Engineering Harness never creates a Scheduled Task by itself');
  });

  it.each(['lite', 'full', 'ultra'] as const)('adds a bounded exact-load directive for %s', (mode) => {
    const instructions = buildMcpInstructions(mode);
    expect(instructions).toContain(MCP_OUTCOME_DRIVEN_INSTRUCTIONS);
    expect(instructions).toContain(`Ponytail policy is ${mode.toUpperCase()}`);
    expect(instructions).toContain('call skill_load');
    expect(instructions).toContain(BUNDLED_PONYTAIL_SKILL_ID);
    expect(instructions).toContain('Do not substitute workspace/user copies');
    expect(instructions).toContain('required tests');
    expect(instructions.length).toBeLessThan(MCP_OUTCOME_DRIVEN_INSTRUCTIONS.length + 1_000);
  });
});
