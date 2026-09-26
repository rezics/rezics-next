import { createHash } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { graphObjectReferences, type ObjectRecoveryStore } from '../owner/object-coverage.ts';

const OBJECT = /^sha256:([0-9a-f]{64})$/;
const MANIFEST = /^urn:rezics:sha256:([0-9a-f]{64})$/;

export class ObjectErasureConflict extends Error {}

function digest(ref: string): string {
  const found = OBJECT.exec(ref);
  if (!found) throw new ObjectErasureConflict('invalid object erasure target');
  return found[1]!;
}

async function localPresent(store: ObjectRecoveryStore, key: string): Promise<boolean> {
  try {
    const stat = await lstat(join(store.directory, key));
    if (!stat.isFile()) throw new ObjectErasureConflict('object copy is not a regular file');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function remotePresent(store: ObjectRecoveryStore, key: string): Promise<boolean> {
  if (!store.workObjects) return false;
  try { await store.workObjects.get(key); return true; }
  catch (error) {
    if (error instanceof ObjectUnavailable) return false;
    throw error;
  }
}

export async function objectErasureAbsent(store: ObjectRecoveryStore, ref: string): Promise<boolean> {
  const key = digest(ref);
  return !(await localPresent(store, key)) && !(await remotePresent(store, key));
}

/** Resolve manifest and payload pins once per offline restore, O(M + manifest bytes). */
export async function protectedObjectDigests(fuseki: FusekiClient,
  store: ObjectRecoveryStore): Promise<Set<string>> {
  const protectedDigests = new Set<string>();
  for (const reference of await graphObjectReferences(fuseki)) {
    const key = MANIFEST.exec(reference.manifest)?.[1];
    if (!key) throw new ObjectErasureConflict('graph manifest reference is invalid');
    protectedDigests.add(key);
    let bytes: Uint8Array;
    try { bytes = store.workObjects ? await store.workObjects.get(key)
      : await readFile(join(store.directory, key)); }
    catch (error) {
      if (!(error instanceof ObjectUnavailable)) {
        throw new ObjectErasureConflict('graph manifest object is unavailable');
      }
      try { bytes = await readFile(join(store.directory, key)); }
      catch { throw new ObjectErasureConflict('graph manifest object is unavailable'); }
    }
    if (createHash('sha256').update(bytes).digest('hex') !== key) {
      throw new ObjectErasureConflict('graph manifest object is corrupt');
    }
    let manifest: { payload?: unknown };
    try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as { payload?: unknown }; }
    catch { throw new ObjectErasureConflict('graph manifest object is invalid'); }
    const payload = typeof manifest.payload === 'string' ? OBJECT.exec(manifest.payload)?.[1] : null;
    if (!payload) throw new ObjectErasureConflict('graph manifest payload is invalid');
    protectedDigests.add(payload);
  }
  return protectedDigests;
}

/**
 * Remove only a journaled, unreferenced digest from the isolated restored copy.
 * One graph manifest scan protects O(M) referenced manifests; each exact target
 * then costs O(1) object probes and at most one delete per backend.
 */
export async function replayObjectErasure(store: ObjectRecoveryStore, ref: string,
  protectedDigests: ReadonlySet<string>, replay: boolean): Promise<'erased' | 'replayed' | 'conflict'> {
  const key = digest(ref);
  if (protectedDigests.has(key)) return 'conflict';
  if (await objectErasureAbsent(store, ref)) return 'erased';
  if (!replay) return 'conflict';
  try {
    if (store.workObjects) {
      if (!store.workObjects.discard) return 'conflict';
      await store.workObjects.discard(key);
    }
    if (await localPresent(store, key)) await unlink(join(store.directory, key));
  } catch { return 'conflict'; }
  return await objectErasureAbsent(store, ref) ? 'replayed' : 'conflict';
}
