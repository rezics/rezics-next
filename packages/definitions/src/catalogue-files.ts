/** Filesystem adapter. This module is never exported by the browser or portable entry. */
import { open, mkdir, link, unlink, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { RELEASE_LIMITS } from './portable.ts';
import { randomUUID } from 'node:crypto';
import {
  assertCatalogueDigest,
  catalogueBytes,
  catalogueDigest,
  catalogueFail,
  parseCatalogueJson,
  parseCataloguePin,
  CATALOGUE_LIMITS,
  type CatalogueArtifactStore,
  type KindCataloguePin,
} from './catalogue.ts';
import { verifyCatalogue } from './catalogue-artifacts.ts';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Local paths only. No URI resolver, imported executable data or implicit source discovery. */
export function catalogueLocalPath(path: string): string {
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.includes('\0'))
    catalogueFail('invalid', `Expected explicit local path: ${path}`);
  return resolve(path);
}
/** Bounded regular-file reads also refuse changing inputs; a path never implicitly loads executable code. */
export async function readCatalogueLocalBytes(path: string, maximum: number): Promise<Uint8Array> {
  const file = catalogueLocalPath(path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > maximum)
      catalogueFail('invalid', `Expected regular artifact file of at most ${maximum} bytes: ${file}`);
    const bytes = new Uint8Array(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used !== stat.size) catalogueFail('conflict', `Artifact changed while reading: ${file}`);
    return bytes.slice(0, used);
  } finally {
    await handle.close();
  }
}
export function catalogueFileStore(directory: string): CatalogueArtifactStore {
  const objects = join(catalogueLocalPath(directory), 'objects');
  function path(digest: string) {
    assertCatalogueDigest(digest);
    return join(objects, `${digest.slice(7)}.json`);
  }
  async function read(digest: string): Promise<Uint8Array | undefined> {
    try {
      return await readCatalogueLocalBytes(path(digest), RELEASE_LIMITS.bytes);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  return {
    read,
    async put(digest, bytes) {
      assertCatalogueDigest(digest);
      if (catalogueDigest(bytes) !== digest) catalogueFail('corrupt', `Writer digest mismatch ${digest}`);
      await mkdir(objects, { recursive: true });
      const target = path(digest);
      const temporary = join(objects, `.pending-${randomUUID()}`);
      try {
        const handle = await open(temporary, 'wx', 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        }
        // A concurrent builder may have won. Reuse requires exact bytes, never trust a filename alone.
        const stored = await read(digest);
        if (!stored || stored.length !== bytes.length || stored.some((b, i) => b !== bytes[i]))
          catalogueFail('conflict', `Conflicting stored bytes ${digest}`);
        await syncDirectory(objects);
      } finally {
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw error;
        });
      }
    },
  };
}
/** Verify first, fsync complete objects, then atomically replace the sole visible pinned root.
 * Interruption may leave unreferenced objects or .pending files, never a partially published root.
 */
export async function publishCatalogueRoot(directory: string, pin: KindCataloguePin): Promise<void> {
  const destination = catalogueLocalPath(directory);
  const catalogue = parseCataloguePin(pin);
  await verifyCatalogue(catalogue, catalogueFileStore(destination));
  await syncDirectory(join(destination, 'objects'));
  const temporary = join(destination, `.pending-root-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(catalogueBytes(catalogue));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(destination, 'root.json'));
    await syncDirectory(destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
export async function readCatalogueRootFile(
  path: string,
): Promise<{ pin: KindCataloguePin; store: CatalogueArtifactStore }> {
  const file = catalogueLocalPath(path);
  const pin = parseCataloguePin(
    parseCatalogueJson(await readCatalogueLocalBytes(file, CATALOGUE_LIMITS.nodeBytes), CATALOGUE_LIMITS.nodeBytes),
  );
  return { pin, store: catalogueFileStore(dirname(file)) };
}
