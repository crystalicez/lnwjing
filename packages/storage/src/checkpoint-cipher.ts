import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

const PREFIX = 'lnwjing:checkpoint:v1:';
const COMPRESSED_PREFIX = 'lnwjing:checkpoint:v2:br:';
const COMPRESSED_AAD = Buffer.from('lnwjing-checkpoint-v2-br', 'utf8');
const COMPRESS_MIN_BYTES = 4 * 1024;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const LEGACY_PREFIX = 'lnwjud:checkpoint:v1:';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('lnwjing-checkpoint-v1', 'utf8');
const LEGACY_AAD = Buffer.from('lnwjud-checkpoint-v1', 'utf8');

export interface CheckpointPayloadCipher {
  encrypt(plainText: string): string;
  decrypt(payload: string): string;
  isEncrypted(payload: string): boolean;
}

export class AesGcmCheckpointCipher implements CheckpointPayloadCipher {
  private readonly key: Buffer;

  public constructor(key: Buffer, private readonly options: { readonly compressionEnabled?: boolean } = {}) {
    if (key.byteLength !== 32) throw new Error('Checkpoint encryption key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  public encrypt(plainText: string): string {
    const original = Buffer.from(plainText, 'utf8');
    const compressed = this.options.compressionEnabled !== false && original.byteLength >= COMPRESS_MIN_BYTES
      && original.byteLength <= MAX_DECOMPRESSED_BYTES
      ? brotliCompressSync(original, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
      : null;
    // Keep v1 for tiny or incompressible files. New v2 snapshots are still
    // encrypted/authenticated; existing data is never rewritten to compress it.
    const useCompressed = compressed !== null && compressed.byteLength * 8 <= original.byteLength * 7;
    const data = useCompressed && compressed !== null ? compressed : original;
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(useCompressed ? COMPRESSED_AAD : AAD);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (useCompressed ? COMPRESSED_PREFIX : PREFIX)
      + [iv, tag, encrypted].map((value) => value.toString('base64')).join(':');
  }

  public decrypt(payload: string): string {
    if (!this.isEncrypted(payload)) throw new Error('Checkpoint payload is not encrypted');
    const legacy = payload.startsWith(LEGACY_PREFIX);
    const compressed = payload.startsWith(COMPRESSED_PREFIX);
    const encoded = payload.slice((legacy ? LEGACY_PREFIX : compressed ? COMPRESSED_PREFIX : PREFIX).length).split(':');
    if (encoded.length !== 3) throw new Error('Checkpoint payload has an invalid envelope');
    const [ivText, tagText, cipherText] = encoded;
    if (ivText === undefined || tagText === undefined || cipherText === undefined) throw new Error('Checkpoint payload has an invalid envelope');
    const iv = Buffer.from(ivText, 'base64');
    const tag = Buffer.from(tagText, 'base64');
    const encrypted = Buffer.from(cipherText, 'base64');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Checkpoint payload has invalid encryption metadata');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAAD(legacy ? LEGACY_AAD : compressed ? COMPRESSED_AAD : AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return compressed
      ? brotliDecompressSync(plaintext, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8')
      : plaintext.toString('utf8');
  }

  public isEncrypted(payload: string): boolean {
    return payload.startsWith(PREFIX) || payload.startsWith(LEGACY_PREFIX) || payload.startsWith(COMPRESSED_PREFIX);
  }
}
