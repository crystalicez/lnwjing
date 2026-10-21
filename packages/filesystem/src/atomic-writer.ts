import { randomUUID } from 'node:crypto';
import { unlink, rename, link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { ensureParentDirectory } from './ensure-parent.js';
import { mapNodeFsError, nodeErrorCode } from './fs-error.js';

export const MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024;

export interface AtomicWriteOptions {
  /**
   * Revalidate the destination immediately around filesystem side effects.
   * Guarded callers use this to detect symlink/junction/path swaps that occur
   * after their initial workspace containment check.
   */
  readonly validateDestination?: () => Promise<Result<void>>;
  /** Publish using an atomic destination-level no-replace operation. */
  readonly createNew?: boolean;
}

export class AtomicFileWriter {
  public async write(filePath: string, content: string | Buffer, options: AtomicWriteOptions = {}): Promise<Result<void>> {
    const byteLength = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
    if (byteLength > MAX_FILE_WRITE_BYTES) {
      return err(appError('FILE_TOO_LARGE', 'File exceeds the maximum write size'));
    }

    const preflight = await options.validateDestination?.();
    if (preflight !== undefined && !preflight.ok) return preflight;

    const parentResult = await ensureParentDirectory(filePath);
    if (!parentResult.ok) return parentResult;

    const prepared = await options.validateDestination?.();
    if (prepared !== undefined && !prepared.ok) return prepared;

    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
      if (typeof content === 'string') await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
      else await writeFile(temporaryPath, content, { flag: 'wx' });

      const publish = await options.validateDestination?.();
      if (publish !== undefined && !publish.ok) return publish;

      if (options.createNew === true) {
        // Hard-link publication is atomic on the same volume and fails with EEXIST
        // even if another client creates the destination after preflight.
        await link(temporaryPath, filePath);
      } else {
        await rename(temporaryPath, filePath);
      }
      return ok(undefined);
    } catch (error: unknown) {
      if (options.createNew === true && nodeErrorCode(error) === 'EEXIST') {
        return err(appError('CONFLICT', 'Destination already exists'));
      }
      return err(mapNodeFsError(error, 'Atomic file write failed'));
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
