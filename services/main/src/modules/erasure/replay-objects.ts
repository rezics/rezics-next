import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { captureObjectRecoveryCoverage, ObjectRecoveryConflict, type ObjectRecoveryStore } from '../owner/object-coverage.ts';

const OBJECT = /^sha256:([0-9a-f]{64})$/;

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

/** Use the recovery closure, including exact model artifacts, once per offline restore. */
export async function protectedObjectDigests(fuseki: FusekiClient,
  store: ObjectRecoveryStore): Promise<Set<string>> {
  const protectedDigests = new Set<string>();
  try { await captureObjectRecoveryCoverage(fuseki, store, protectedDigests); }
  catch (error) {
    if (error instanceof ObjectRecoveryConflict) throw new ObjectErasureConflict(error.message);
    throw error;
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
