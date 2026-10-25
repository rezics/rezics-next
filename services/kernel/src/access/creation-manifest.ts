import type { Resource } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ResourceCreationPort } from './parent-creation.ts';

export const MAX_CREATION_RESOURCES = 16;
export type ResourceCreationEntry = Readonly<{
  resource: Readonly<Resource>;
  type: string;
  creator: string;
  creation: ResourceCreationPort;
}>;

declare const resourceCreationManifest: unique symbol;
/** Opaque server declaration; JSON and structural copies carry no authority. */
export type ResourceCreationManifest = { readonly [resourceCreationManifest]: true };

const manifests = new WeakMap<ResourceCreationManifest, readonly ResourceCreationEntry[]>();
const catalogueType = /^[a-z][a-z0-9_.-]*$/;

/** Snapshot at most sixteen same-partition declarations without invoking their
 * validators or granting permission. Only declared metadata is retained; callers
 * cannot enumerate or serialize the private entries through the frozen token.
 * Catalogue resolution and actual new-INSERT proof belong to initialization.
 */
export function createResourceCreationManifest(entries: readonly ResourceCreationEntry[]): ResourceCreationManifest {
  const count = Array.isArray(entries) ? entries.length : 0;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CREATION_RESOURCES)
    throw new TypeError('A creation manifest requires one to sixteen resources');

  const snapshots: ResourceCreationEntry[] = [];
  const identities = new Set<string>();
  let partition: number | undefined;
  for (let index = 0; index < count; index++) {
    const entry = entries[index];
    const resource = entry?.resource;
    const route = resource?.route;
    const id = resource?.id;
    const type = entry?.type;
    const creator = entry?.creator;
    const validate = entry?.creation?.validate;
    if (
      typeof route !== 'number' ||
      typeof id !== 'string' ||
      routeOf(id) === null ||
      routeOf(id) !== route ||
      typeof type !== 'string' ||
      !catalogueType.test(type) ||
      typeof creator !== 'string' ||
      routeOf(creator) === null ||
      typeof validate !== 'function'
    )
      throw new TypeError('Invalid creation manifest entry');
    const targetPartition = partitionOf(route);
    if ((partition !== undefined && partition !== targetPartition) || identities.has(id))
      throw new TypeError('Creation resources must be distinct and share a partition');
    partition = targetPartition;
    identities.add(id);
    const eligibility = resource!.eligibility;
    snapshots.push(
      Object.freeze({
        resource: Object.freeze({ route, id, ...(eligibility === undefined ? {} : { eligibility }) }),
        type,
        creator,
        creation: Object.freeze({ validate }),
      }),
    );
  }
  const manifest = Object.freeze({}) as ResourceCreationManifest;
  manifests.set(manifest, Object.freeze(snapshots));
  return manifest;
}

export class CreationManifestUnavailableError extends Error {
  constructor() {
    super('Creation manifest initialization is unavailable');
    this.name = 'CreationManifestUnavailableError';
  }
}

/** Internal Access lookup: a structural copy or inherited token has no entries. */
export function creationManifestEntries(manifest: ResourceCreationManifest): readonly ResourceCreationEntry[] {
  const entries = manifests.get(manifest);
  if (!entries) throw new TypeError('Invalid creation manifest');
  return entries;
}
