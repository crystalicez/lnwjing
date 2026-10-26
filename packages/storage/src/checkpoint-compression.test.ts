import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmCheckpointCipher } from './checkpoint-cipher.js';

describe('checkpoint compression (poteto-mode)', () => {
  const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 17));

  it('compresses repeated text before encryption while preserving exact bytes', () => {
    const snapshot = JSON.stringify([{ path: 'src/demo.ts', content: 'export const value = 1;\\n'.repeat(50_000) }]);
    const encrypted = cipher.encrypt(snapshot);
    expect(encrypted).toMatch(/^lnwjing:checkpoint:v2:br:/);
    expect(Buffer.byteLength(encrypted)).toBeLessThan(Buffer.byteLength(snapshot) / 4);
    expect(cipher.decrypt(encrypted)).toBe(snapshot);
  });

  it('retains v1 for small snapshots and round-trips high-entropy data', () => {
    const small = JSON.stringify([{ content: 'hello' }]);
    expect(cipher.encrypt(small)).toMatch(/^lnwjing:checkpoint:v1:/);
    const random = randomBytes(16 * 1024).toString('base64');
    expect(cipher.decrypt(cipher.encrypt(random))).toBe(random);
  });

  it('supports an explicit compression-off backend setting without breaking restore', () => {
    const uncompressed = new AesGcmCheckpointCipher(Buffer.alloc(32, 17), { compressionEnabled: false });
    const value = 'poteto'.repeat(8000);
    const envelope = uncompressed.encrypt(value);
    expect(envelope).toMatch(/^lnwjing:checkpoint:v1:/);
    expect(cipher.decrypt(envelope)).toBe(value);
  });

  it('rejects tampered compressed envelopes without exposing plaintext', () => {
    const encrypted = cipher.encrypt('A'.repeat(65_536));
    expect(encrypted).toMatch(/^lnwjing:checkpoint:v2:br:/);
    expect(() => cipher.decrypt(encrypted.replace('v2:br:', 'v1:'))).toThrow();
    const truncated = encrypted.slice(0, -8);
    expect(() => cipher.decrypt(truncated)).toThrow();
  });
});
