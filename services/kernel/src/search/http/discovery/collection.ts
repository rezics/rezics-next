import { memoizedValue } from '../../../memoized.ts';
import { CollectionDiscoverySummarySchema } from '../../collection-discovery-schema.ts';
import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { MatchEvidenceSchema } from '../../http/match-evidence-schema.ts';
import { closed, id, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
function collectionKey() {
  return memoizedValue(collectionKey, () =>
    t.Object(
      {
        owner: t.Literal('library'),
        kind: t.Literal('collection'),
        route: t.Integer({ minimum: 0, maximum: 65535 }),
        id,
      },
      closed,
    ),
  );
}
export function CollectionHitSchema() {
  return memoizedValue(CollectionHitSchema, () =>
    t.Object(
      {
        key: collectionKey(),
        summary: t.Object({ kind: t.Literal('collection'), value: CollectionDiscoverySummarySchema() }, closed),
        matchEvidence: MatchEvidenceSchema,
      },
      closed,
    ),
  );
}

export type CollectionHttpHit = Static<ReturnType<typeof CollectionHitSchema>>;
type CollectionHit = Extract<DiscoveryUnionHit, { summary: { kind: 'collection' } }>;
function check() {
  return memoizedValue(check, () => Compile(CollectionHitSchema()));
}

export function admitCollectionHit(value: unknown): asserts value is CollectionHit {
  const admitted = evidenceOrDefault(value);
  if (!check().Check(admitted)) unavailable();
  const hit = admitted as CollectionHttpHit;
  admitIdentity(hit);
  const { key, summary, matchEvidence } = hit;
  if (summary.kind === 'collection') {
    if (key.owner !== 'library' || key.kind !== 'collection') unavailable();
    const { card } = summary.value;
    if (
      card.id !== key.id ||
      card.title !== summary.value.title ||
      card.description !== summary.value.description ||
      card.revision < 0 ||
      Buffer.byteLength(JSON.stringify({ curator: card.curator, preview: card.preview })) > 4096 ||
      (card.curator.state === 'available' &&
        card.curator.destination !== null &&
        !/^\/@[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(card.curator.destination)) ||
      (card.preview.state === 'available' &&
        new Set(card.preview.members.map((member) => member.id)).size !== card.preview.members.length) ||
      card.destination !== `/collections/${key.id}`
    )
      unavailable();
  }
  if (matchEvidence.state !== 'unsupported') unavailable();
}

/** Detach all nested native values; later owner mutation cannot change the admitted response. */
export function serializeCollectionHit(hit: CollectionHit): CollectionHttpHit {
  return structuredClone(evidenceOrDefault(hit)) as CollectionHttpHit;
}
