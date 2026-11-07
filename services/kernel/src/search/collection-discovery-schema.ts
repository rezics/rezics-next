import { memoizedValue } from '../memoized.ts';
/** Shared closed Collection wire schema. Keep this module independent of Search runtime assembly. */
import { t } from 'elysia';
import { CollectionCuratorSchema, CollectionPreviewSchema } from './collection-context-http.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
const collectionSummary = t.Object({ id, title: t.String({ minLength: 1 }), description: nullableText }, closed);
const collectionCoverSummary = t.Union([
  t.Object(
    {
      media: t.String({ format: 'uuid' }),
      width: t.Integer({ minimum: 1 }),
      height: t.Integer({ minimum: 1 }),
      placeholder: t.Object({ thumbhash: t.String(), color: t.String() }, closed),
      variants: t.Array(
        t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer({ minimum: 1 }) }, closed),
      ),
      focalPoint: t.Union([t.Object({ x: t.Number(), y: t.Number() }, closed), t.Null()]),
      credit: t.Object(
        {
          rightsHolder: t.String(),
          via: t.Object({ name: t.String(), url: t.String() }, closed),
          license: t.String(),
          obligations: t.Array(t.String()),
        },
        closed,
      ),
    },
    closed,
  ),
  t.Null(),
]);
function collectionCard() {
  return memoizedValue(collectionCard, () =>
    t.Union([
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
          cover: t.Union([collectionCoverSummary, t.Null()]),
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
          cover: t.Union([collectionCoverSummary, t.Null()]),
          coverSource: t.Union([t.Literal('owner'), t.Literal('member'), t.Literal('none'), t.Literal('pending')]),
          curator: CollectionCuratorSchema,
          preview: CollectionPreviewSchema,
          membershipKind: t.Literal('dynamic'),
          outputGeneration: t.String({ minLength: 1 }),
        },
        closed,
      ),
    ]),
  );
}
export function CollectionDiscoverySummarySchema() {
  return memoizedValue(CollectionDiscoverySummarySchema, () =>
    t.Object({ ...collectionSummary.properties, card: collectionCard() }, closed),
  );
}
