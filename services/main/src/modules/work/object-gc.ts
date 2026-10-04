import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';

const REVISION_GRAPH = 'urn:rezics:graph:revisions';
const RV = 'https://rezics.com/vocab/';
const DIGEST = /^[0-9a-f]{64}$/;

export interface StagedWorkObjectCandidates {
  /** At most two Work components, each represented by one payload and manifest. */
  objectDigests: Set<string>;
  manifestDigests: Set<string>;
}

export function stagedWorkObjectCandidates(): StagedWorkObjectCandidates {
  return { objectDigests: new Set(), manifestDigests: new Set() };
}

/**
 * Remove only a Work-create candidate whose graph command returned a definite
 * non-commit result. Fresh Work IDs make its payload digests operation-private;
 * the exact manifest check protects against deleting a candidate another
 * successful command somehow activated. Cost is bounded by one Fuseki ASK for
 * S3 and at most four object deletes/unlinks.
 */
export async function discardUnpublishedWorkObjects(input: {
  fuseki: FusekiClient;
  objects?: ImmutableObjects;
  objectDirectory: string;
  candidates: StagedWorkObjectCandidates;
}): Promise<boolean> {
  const digests = [...input.candidates.objectDigests];
  const manifests = [...input.candidates.manifestDigests];
  if (digests.length === 0) return true;
  if (digests.length > 4 || manifests.length > 2
    || digests.some(digest => !DIGEST.test(digest))
    || manifests.some(digest => !digests.includes(digest))) {
    throw new Error('invalid Work object cleanup candidate set');
  }

  const manifestValues = manifests.map(digest => `<urn:rezics:sha256:${digest}>`).join(' ');
  if (manifestValues) {
    const referenced = await input.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH <${REVISION_GRAPH}> {
        ?revision rv:manifest ?manifest .
        VALUES ?manifest { ${manifestValues} }
      }
    }`);
    if (referenced.boolean !== false) return false;
  }

  const ordered = [...digests].sort((left, right) => {
    const leftIsManifest = input.candidates.manifestDigests.has(left);
    const rightIsManifest = input.candidates.manifestDigests.has(right);
    return Number(rightIsManifest) - Number(leftIsManifest);
  });
  for (const digest of ordered) {
    if (input.objects) {
      if (!input.objects.discard) throw new Error('immutable object store cannot discard staged candidates');
      await input.objects.discard(digest);
    } else {
      try { unlinkSync(join(input.objectDirectory, digest)); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
  return true;
}
