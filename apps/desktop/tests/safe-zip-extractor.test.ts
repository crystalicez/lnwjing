import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractZipSafely } from '../src/main/safe-zip-extractor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('safe ZIP extraction', () => {
  it('extracts ordinary files inside the destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-safe-zip-'));
    roots.push(root);
    const archivePath = path.join(root, 'valid.zip');
    const destination = path.join(root, 'dest');
    await mkdir(destination, { recursive: true });
    await writeFile(archivePath, createStoredZip([
      { name: 'folder/file.txt', data: Buffer.from('ok'), mode: 0o100644 },
    ]));

    await extractZipSafely(archivePath, destination);
    expect(await readFile(path.join(destination, 'folder', 'file.txt'), 'utf8')).toBe('ok');
  });

  it('rejects parent traversal without writing outside the destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-safe-zip-traversal-'));
    roots.push(root);
    const archivePath = path.join(root, 'traversal.zip');
    const destination = path.join(root, 'dest');
    const outside = path.join(root, 'escape.txt');
    await mkdir(destination, { recursive: true });
    await writeFile(archivePath, createStoredZip([
      { name: '../escape.txt', data: Buffer.from('owned'), mode: 0o100644 },
    ]));

    await expect(extractZipSafely(archivePath, destination)).rejects.toThrow();
    await expect(access(outside)).rejects.toThrow();
  });

  it('rejects symlink and duplicate-name overwrite archives without escaping the destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-safe-zip-symlink-'));
    roots.push(root);
    const archivePath = path.join(root, 'symlink.zip');
    const destination = path.join(root, 'dest');
    const outside = path.join(root, 'escape.txt');
    await mkdir(destination, { recursive: true });
    await writeFile(archivePath, createStoredZip([
      { name: 'link', data: Buffer.from('../escape.txt'), mode: 0o120777 },
      { name: 'link', data: Buffer.from('owned'), mode: 0o100644 },
    ]));

    await expect(extractZipSafely(archivePath, destination)).rejects.toThrow();
    await expect(access(outside)).rejects.toThrow();
  });

  it('rejects names that collide after the UTF-8 decoding used by unzipper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-safe-zip-decoding-'));
    roots.push(root);
    const archivePath = path.join(root, 'decoding-collision.zip');
    const destination = path.join(root, 'dest');
    await mkdir(destination, { recursive: true });
    await writeFile(archivePath, createStoredZip([
      { name: Buffer.from([0x80, 0x2e, 0x74, 0x78, 0x74]), data: Buffer.from('first'), mode: 0o100644 },
      { name: Buffer.from([0x81, 0x2e, 0x74, 0x78, 0x74]), data: Buffer.from('second'), mode: 0o100644 },
    ]));
    let extractionStarted = false;

    await expect(extractZipSafely(archivePath, destination, async () => {
      extractionStarted = true;
    })).rejects.toThrow(/duplicate/);
    expect(extractionStarted).toBe(false);
  });

  it('rejects archives whose declared expanded size exceeds the safety limit before extraction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-safe-zip-expansion-'));
    roots.push(root);
    const archivePath = path.join(root, 'expansion.zip');
    const destination = path.join(root, 'dest');
    await mkdir(destination, { recursive: true });
    const archive = createStoredZip([
      { name: 'payload.bin', data: Buffer.from('small'), mode: 0o100644 },
    ]);
    const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    archive.writeUInt32LE(600 * 1024 * 1024, centralOffset + 24);
    await writeFile(archivePath, archive);
    let extractionStarted = false;

    await expect(extractZipSafely(archivePath, destination, async () => {
      extractionStarted = true;
    })).rejects.toThrow(/expands beyond/);
    expect(extractionStarted).toBe(false);
  });
});

interface StoredZipEntry {
  readonly name: string | Buffer;
  readonly data: Buffer;
  readonly mode: number;
}

function createStoredZip(entries: readonly StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
    const flags = Buffer.isBuffer(entry.name) ? 0 : 0x0800;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
