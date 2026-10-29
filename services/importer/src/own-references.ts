import { createHash } from 'node:crypto';
import type { SourceProjection } from './run-store.ts';
import type { RecordBindings } from './record-bindings.ts';

export type OwnReferenceResolution = {
  resolvedReferences: Readonly<Record<string, string>>;
  signature: string;
};

/** Resolve only the bounded native Open Library keys in the sanitized projection. */
export function resolveOwnReferences(
  projection: SourceProjection,
  sourceAlias: string,
  bindings: Pick<RecordBindings, 'claim'>,
): OwnReferenceResolution | null {
  if (projection.sourceKind !== 'openlibrary') return null;
  const normalized = projection.normalizedRecord as {
    authors?: { key?: string }[];
    works?: { key?: string }[];
  };
  const keys = [...(normalized.authors ?? []), ...(normalized.works ?? [])]
    .flatMap((relation) => (relation.key ? [relation.key] : []));
  if (keys.length > 64) throw new Error('Open Library relation bound exceeded');
  const resolutions: [string, string | null][] = [];
  const resolvedReferences: Record<string, string> = {};
  for (const key of keys) {
    const claim = bindings.claim({ source: sourceAlias, external_id: key });
    const subject = claim?.state === 'bound' ? claim.subject : null;
    resolutions.push([key, subject]);
    if (subject) resolvedReferences[key] = subject;
  }
  return {
    resolvedReferences,
    signature: createHash('sha256').update(JSON.stringify(resolutions)).digest('hex'),
  };
}
