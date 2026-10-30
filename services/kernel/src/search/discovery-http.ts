import type { Static } from 'typebox';
import type { DiscoveryPage } from './discovery.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { t } from 'elysia';
import { CoverSummarySchema, SubjectSummarySchema } from '../semantic/http/summaries.ts';
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
const accountSummary = t.Object(
  {
    id,
    accountKind: t.Union([t.Literal('actor'), t.Literal('organization')]),
    handle: nullableText,
    displayName: nullableText,
    automated: t.Boolean(),
    operatorId: t.Union([id, t.Null()]),
    avatar: t.Union([t.Object({ ...CoverSummarySchema.anyOf[0].properties, credit: t.Null() }, closed), t.Null()]),
    verifiedAgent: t.Union([t.Object({ id, label: t.String(), type: t.String() }, closed), t.Null()]),
  },
  closed,
);
const key = <Owner extends 'semantic' | 'accounts'>(owner: Owner) =>
  t.Object(
    {
      owner: t.Literal(owner),
      kind: owner === 'accounts' ? t.Literal('account') : t.String(),
      route: t.Integer({ minimum: 0, maximum: 65535 }),
      id,
    },
    closed,
  );
const count = t.Union([
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 0 }), exact: t.Literal(true) }, closed),
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 1 }), exact: t.Literal(false) }, closed),
  t.Object({ kind: t.String(), unavailable: t.Literal(true) }, closed),
]);
/** The owner-tagged key and non-null native summary close together; no Account Subject shell. */
export const DiscoveryPageSchema = t.Object(
  {
    hits: t.Array(
      t.Union([
        t.Object(
          {
            key: key('semantic'),
            summary: t.Object({ kind: t.Literal('subject'), value: SubjectSummarySchema }, closed),
          },
          closed,
        ),
        t.Object(
          { key: key('accounts'), summary: t.Object({ kind: t.Literal('account'), value: accountSummary }, closed) },
          closed,
        ),
      ]),
      { maxItems: 100 },
    ),
    kinds: t.Object(
      {
        values: t.Array(
          t.Object(
            { id: t.String(), labels: t.Record(t.String(), t.String()), icon: t.String(), count: t.Optional(count) },
            closed,
          ),
          { maxItems: 8 },
        ),
        next: nullableText,
      },
      closed,
    ),
    next: nullableText,
    as_of: t.String({ format: 'date-time' }),
  },
  closed,
);

export type DiscoveryHttpPage = Static<typeof DiscoveryPageSchema>;

/** Close the owner/summary union and materialize readonly native avatar arrays for the wire schema. */
export function discoveryHttpPage(page: DiscoveryPage): DiscoveryHttpPage {
  return {
    ...page,
    hits: page.hits.map((hit) => {
      if (hit.summary.kind === 'account') {
        if (hit.key.owner !== 'accounts') throw new SearchUnavailableError('Discovery summary owner disagrees');
        const summary = hit.summary.value;
        return {
          key: hit.key,
          summary: {
            kind: 'account' as const,
            value: {
              ...summary,
              avatar: summary.avatar
                ? { ...summary.avatar, variants: summary.avatar.variants.map((variant) => ({ ...variant })) }
                : null,
            },
          },
        };
      }
      if (hit.key.owner !== 'semantic') throw new SearchUnavailableError('Discovery summary owner disagrees');
      return { key: hit.key, summary: { kind: 'subject' as const, value: hit.summary.value } };
    }),
  };
}
