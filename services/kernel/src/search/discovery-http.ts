import type { Static } from 'typebox';
import type { DiscoveryHit, DiscoveryPage } from './discovery.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { routeOf } from '../route/route.ts';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';
import { CoverSummarySchema, SubjectSummarySchema } from '../semantic/http/summaries.ts';
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
const continuation = t.Union([
  t.String({ minLength: 1, maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength }),
  t.Null(),
]);
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
        next: continuation,
      },
      closed,
    ),
    next: continuation,
    as_of: t.String({ format: 'date-time' }),
  },
  closed,
);

export type DiscoveryHttpPage = Static<typeof DiscoveryPageSchema>;

const hitCheck = Compile(DiscoveryPageSchema.properties.hits.items);
const pageCheck = Compile(DiscoveryPageSchema);
const unavailable = (): never => {
  throw new SearchUnavailableError('Discovery response is incomplete or malformed');
};

/** Validate the native owner reply without coercion or removal of unrecognized fields. */
export function admitDiscoveryHit(value: unknown): asserts value is DiscoveryHit {
  if (!hitCheck.Check(value)) unavailable();
  const { key, summary } = value;
  if (routeOf(key.id) !== key.route || key.id !== summary.value.id) unavailable();
  if (summary.kind === 'subject' && (key.owner !== 'semantic' || key.kind !== summary.value.type)) unavailable();
  if (summary.kind === 'account' && (key.owner !== 'accounts' || key.kind !== 'account')) unavailable();
}

/** Run before cursor signing as well as at the wire boundary. Empty pages still carry metadata. */
export function admitDiscoveryPage(value: unknown): asserts value is DiscoveryPage {
  if (!pageCheck.Check(value)) unavailable();
  const identities = new Set<string>();
  for (const hit of value.hits) {
    admitDiscoveryHit(hit);
    const identity = JSON.stringify([hit.key.owner, hit.key.kind, hit.key.route, hit.key.id]);
    if (identities.has(identity)) unavailable();
    identities.add(identity);
  }
  const kinds = new Set<string>();
  for (const kind of value.kinds.values) {
    if (kinds.has(kind.id) || (kind.count && kind.count.kind !== kind.id)) unavailable();
    if (kind.count && 'value' in kind.count && !Number.isSafeInteger(kind.count.value)) unavailable();
    kinds.add(kind.id);
  }
}

/** Close the owner/summary union and materialize readonly native avatar arrays for the wire schema. */
export function discoveryHttpPage(page: DiscoveryPage): DiscoveryHttpPage {
  admitDiscoveryPage(page);
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
