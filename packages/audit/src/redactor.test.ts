import { describe, expect, it } from 'vitest';
import { codexInstructionSummary, Redactor } from './redactor.js';

describe('Redactor', () => {
  it.each([
    ['https://alice:p%40ss@example.test/repo.git', 'https://[REDACTED]@example.test/repo.git'],
    ['https://opaque-value@example.test/repo.git', 'https://[REDACTED]@example.test/repo.git'],
    ['failed https://alice:a@b@example.test/repo.git', 'failed https://[REDACTED]@example.test/repo.git'],
    ['HTTPS://alice:password@example.test/repo.git', 'HTTPS://[REDACTED]@example.test/repo.git'],
  ])('removes URL userinfo before audit persistence', (input, expected) => {
    expect(new Redactor().redact({ url: input })).toEqual({ url: expected });
  });

  it('preserves credential-free URLs and path email addresses', () => {
    expect(new Redactor().redactText('https://example.test/repo/a@b')).toBe('https://example.test/repo/a@b');
  });

  it('redacts bearer tokens, API key values, and secret-like environment keys recursively', () => {
    const value = {
      headers: { Authorization: 'Bearer super-secret-token' },
      env: { API_KEY: 'api-secret', NORMAL_VALUE: 'safe' },
      note: 'Authorization: Bearer inline-token TOKEN=inline-secret sk-proj-secret',
    };

    const redacted = new Redactor().redact(value);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('inline-token');
    expect(serialized).not.toContain('inline-secret');
    expect(serialized).not.toContain('sk-proj-secret');
    expect(redacted).toMatchObject({ env: { NORMAL_VALUE: 'safe' } });
  });

  it('redacts task recovery secrets in fields and free text', () => {
    const token = 'lnwrt_' + 'a'.repeat(64);
    const redactor = new Redactor();
    expect(JSON.stringify(redactor.redact({ recovery_token: token, note: 'resume ' + token }))).not.toContain(token);
    expect(redactor.redactText('resume ' + token)).toBe('resume [REDACTED]');
  });

  it('removes terminal control sequences from audit text and expandable details', () => {
    const input = '\u001b[33mwarning\u001b[22m\u001b[39m \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007';

    expect(new Redactor().redactText(input)).toBe('warning link');
  });

  it('summarizes Codex instructions by task id, byte length, and SHA-256 only', () => {
    const summary = codexInstructionSummary('task-1', 'review this file');

    expect(summary).toEqual({
      codexTaskId: 'task-1',
      instructionLength: 16,
      instructionSha256: '4b7cf767f78b3e0f3410ebb983d8152d58562eda4f0ee184156f9faf477fe234',
    });
    expect(JSON.stringify(summary)).not.toContain('review this file');
  });
});
