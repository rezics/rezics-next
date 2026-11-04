import { CollectionCuratorSchema, CollectionPreviewSchema } from '../../collection-context-http.ts';
import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { CoverSummarySchema } from '../../../semantic/http/summaries.ts';
import { MatchEvidenceSchema } from '../../http/match-evidence-schema.ts';
import { closed, id, nullableText, key, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
const collectionKey = t.Object(
  { owner: t.Literal('library'), kind: t.Literal('collection'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
  closed,
);
const collectionSummary = t.Object({ id, title: t.String({ minLength: 1 }), description: nullableText }, closed);
const collectionCard = t.Union([
  t.Object(
    {
      kind: t.Literal('collection'),
      id,
      destination: t.String({ minLength: 1 }),
      title: t.String({ minLength: 1 }),
      description: nullableText,
      visibility: t.Literal('public'),
      revision: t.Integer({ minimum: 0 }),
      sourceGeneration: t.String({ pattern: '^[0-9]{1,20}$' }),
      presentationKind: t.Union([t.String(), t.Null()]),
      presentationKindSource: t.Union([t.Literal('mixed'), t.Literal('owner')]),
      cover: t.Union([CoverSummarySchema, t.Null()]),
      coverSource: t.Union([t.Literal('owner'), t.Literal('member'), t.Literal('none'), t.Literal('pending')]),
      curator: CollectionCuratorSchema,
      preview: CollectionPreviewSchema,
      membershipKind: t.Literal('curated'),
      memberCount: t.Integer({ minimum: 0 }),
      orderEpoch: t.Integer({ minimum: 0 }),
      createdAt: t.String({ format: 'date-time' }),
      updatedAt: t.String({ format: 'date-time' }),
    },
    closed,
  ),
  t.Object(
    {
      kind: t.Literal('collection'),
      id,
      destination: t.String({ minLength: 1 }),
      title: t.String({ minLength: 1 }),
      description: nullableText,
      visibility: t.Literal('public'),
      revision: t.Integer({ minimum: 0 }),
      sourceGeneration: t.String({ pattern: '^[0-9]{1,20}$' }),
      presentationKind: t.Union([t.String(), t.Null()]),
      presentationKindSource: t.Union([t.Literal('mixed'), t.Literal('owner')]),
      cover: t.Union([CoverSummarySchema, t.Null()]),
      coverSource: t.Union([t.Literal('owner'), t.Literal('member'), t.Literal('none'), t.Literal('pending')]),
      curator: CollectionCuratorSchema,
      preview: CollectionPreviewSchema,
      membershipKind: t.Literal('dynamic'),
      outputGeneration: t.String({ minLength: 1 }),
    },
    closed,
  ),
]);
const collectionDiscoverySummary = t.Object({ ...collectionSummary.properties, card: collectionCard }, closed);
export const CollectionHitSchema = t.Object(
  {
    key: collectionKey,
    summary: t.Object({ kind: t.Literal('collection'), value: collectionDiscoverySummary }, closed),
    matchEvidence: MatchEvidenceSchema,
  },
  closed,
);

export type CollectionHttpHit = Static<typeof CollectionHitSchema>;
type CollectionHit = Extract<DiscoveryUnionHit, { summary: { kind: 'collection' } }>;
const check = Compile(CollectionHitSchema);

export function admitCollectionHit(value: unknown): asserts value is CollectionHit {
  const admitted = evidenceOrDefault(value);
  if (!check.Check(admitted)) unavailable();
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
