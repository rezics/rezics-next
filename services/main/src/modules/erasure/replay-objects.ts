import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { evictVerifiedImmutableObject, ObjectNotFound, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { captureObjectRecoveryCoverage, ObjectRecoveryConflict,
  type LiveBoundedObjectProtection, type ObjectRecoveryStore } from '../owner/object-coverage.ts';

const WORK_OBJECT = /^sha256:([0-9a-f]{64})$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEDIA_ASSET_OBJECT = new RegExp(`^media-asset:v1:(${UUID}):sha256:([0-9a-f]{64})$`);
const MEDIA_QUARANTINE_OBJECT = new RegExp(`^media-quarantine:v1:(${UUID}):sha256:([0-9a-f]{64})$`);
const MAX_OBJECT_REF_BYTES = 512;

export class ObjectErasureConflict extends Error {}

interface ObjectAddress {
  reference: string;
  digest: string;
  /** Work copies use the recovery directory's digest-only layout. */
  localKey?: string;
  remote?: ImmutableObjects;
}

function checkedReference(ref: string): ObjectAddress {
  if (Buffer.byteLength(ref, 'utf8') > MAX_OBJECT_REF_BYTES) {
    throw new ObjectErasureConflict('invalid object erasure target');
  }
  const work = WORK_OBJECT.exec(ref);
  if (work) return { reference: ref, digest: work[1]!, localKey: work[1]! };

  const asset = MEDIA_ASSET_OBJECT.exec(ref);
  if (asset) return { reference: ref, digest: asset[2]! };

  const quarantine = MEDIA_QUARANTINE_OBJECT.exec(ref);
  if (quarantine) return { reference: ref, digest: quarantine[2]! };

  throw new ObjectErasureConflict('invalid object erasure target');
}

function addressFor(store: ObjectRecoveryStore, ref: string): ObjectAddress {
  const address = checkedReference(ref);
  const asset = MEDIA_ASSET_OBJECT.exec(ref);
  if (asset) {
    const remote = store.mediaObjects?.asset(asset[1]!);
    if (!remote) throw new ObjectErasureConflict('Media asset object namespace is unavailable');
    return { ...address, remote };
  }
  const quarantine = MEDIA_QUARANTINE_OBJECT.exec(ref);
  if (quarantine) {
    const remote = store.mediaObjects?.quarantine(quarantine[1]!);
    if (!remote) throw new ObjectErasureConflict('Media quarantine object namespace is unavailable');
    return { ...address, remote };
  }
  return { ...address, remote: store.workObjects };
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

/** Only the exact missing-key signal proves remote absence. */
async function remotePresent(objects: ImmutableObjects | undefined, digest: string): Promise<boolean> {
  if (!objects) return false;
  if (!objects.probe) throw new ObjectErasureConflict('exact object probe is unavailable');
  try {
    await objects.probe(digest);
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFound) return false;
    throw error;
  }
}

async function addressAbsent(store: ObjectRecoveryStore, address: ObjectAddress): Promise<boolean> {
  if (address.localKey && await localPresent(store, address.localKey)) return false;
  return !(await remotePresent(address.remote, address.digest));
}

export async function objectErasureAbsent(store: ObjectRecoveryStore, ref: string): Promise<boolean> {
  return addressAbsent(store, addressFor(store, ref));
}

/** Use the recovery closure, including exact model artifacts, only during offline restore. */
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

async function deleteObjectAddress(store: ObjectRecoveryStore,
  address: ObjectAddress): Promise<'erased' | 'replayed' | 'conflict'> {
  const failures: unknown[] = [];
  evictVerifiedImmutableObject(address.digest);
  try {
    if (address.localKey && await localPresent(store, address.localKey)) {
      await unlink(join(store.directory, address.localKey));
      if (await localPresent(store, address.localKey)) {
        throw new ObjectErasureConflict('local object remains after delete');
      }
    }
  } catch (error) { failures.push(error); }

  try {
    if (address.remote) {
      if (!address.remote.deleteAndVerifyAbsent) {
        throw new ObjectErasureConflict('verified object deletion is unavailable');
      }
      await address.remote.deleteAndVerifyAbsent(address.digest);
    }
  } catch (error) { failures.push(error); }
  finally { evictVerifiedImmutableObject(address.digest); }

  if (failures.length) return 'conflict';
  try {
    return await addressAbsent(store, address) ? 'replayed' : 'conflict';
  } catch { return 'conflict'; }
}

/** Restore uses its offline owner scan to protect graph and model roots. */
export async function replayObjectErasure(store: ObjectRecoveryStore, ref: string,
  protectedDigests: ReadonlySet<string>, replay: boolean): Promise<'erased' | 'replayed' | 'conflict'> {
  const address = addressFor(store, ref);
  if (protectedDigests.has(address.digest)) return 'conflict';
  let absent: boolean;
  try { absent = await addressAbsent(store, address); }
  catch { return 'conflict'; }
  if (absent) {
    evictVerifiedImmutableObject(address.digest);
    return 'erased';
  }
  if (!replay) return 'conflict';
  return deleteObjectAddress(store, address);
}

/** Apply a live journal target using only its bounded preflight references.
 * This entry point cannot initiate the offline graph-wide recovery scan. */
export async function applyLiveObjectErasure(store: ObjectRecoveryStore, ref: string,
  protection: LiveBoundedObjectProtection, replay: boolean): Promise<'erased' | 'replayed' | 'conflict'> {
  if (protection.kind !== 'live-bounded') return 'conflict';
  const address = addressFor(store, ref);
  if (protection.references.has(address.reference)) return 'conflict';
  let absent: boolean;
  try { absent = await addressAbsent(store, address); }
  catch { return 'conflict'; }
  if (absent) {
    evictVerifiedImmutableObject(address.digest);
    return 'erased';
  }
  if (!replay) return 'conflict';
  return deleteObjectAddress(store, address);
}
