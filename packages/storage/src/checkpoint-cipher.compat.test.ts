import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmCheckpointCipher } from './checkpoint-cipher.js';

describe('AesGcmCheckpointCipher rename compatibility', () => {
  it('encrypts all new payloads with the lnwjing envelope and reads them back', () => {
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 1));
    const payload = cipher.encrypt('current-checkpoint');
    expect(payload).toMatch(/^lnwjing:checkpoint:v1:/);
    expect(cipher.decrypt(payload)).toBe('current-checkpoint');
  });

  it('authenticates existing lnwjud checkpoints with their original AAD', () => {
    const key = Buffer.alloc(32, 7);
    const iv = randomBytes(12);
    const encryptor = createCipheriv('aes-256-gcm', key, iv);
    encryptor.setAAD(Buffer.from('lnwjud-checkpoint-v1', 'utf8'));
    const ciphertext = Buffer.concat([encryptor.update('legacy-checkpoint', 'utf8'), encryptor.final()]);
    const envelope = 'lnwjud:checkpoint:v1:' +
      [iv, encryptor.getAuthTag(), ciphertext].map((entry) => entry.toString('base64')).join(':');
    const cipher = new AesGcmCheckpointCipher(key);
    expect(cipher.isEncrypted(envelope)).toBe(true);
    expect(cipher.decrypt(envelope)).toBe('legacy-checkpoint');
    const tampered = envelope.replace('lnwjud:checkpoint:v1:', 'lnwjing:checkpoint:v1:');
    expect(() => cipher.decrypt(tampered)).toThrow();
  });
});
