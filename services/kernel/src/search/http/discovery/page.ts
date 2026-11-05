import { searchContextBytes } from '../../review-context-schemas.ts';
import { REVIEW_CONTEXT_LIMITS } from '../../review-context.ts';
import { workContextBytes, WORK_CONTEXT_LIMITS } from '../../work-context.ts';
import { FollowDiscoverySchema } from '../../collection-context-http.ts';
import { SearchFreshnessSchema } from '../../search-context.ts';
import { SpaceEntryPageSchema } from '../../../community/space-discovery-entry-contract.ts';
import type { Static } from 'typebox';
import type { DiscoveryPage, DiscoveryUnionHit } from '../../discovery.ts';
import { EmptyRecoverySchema } from '../../http/empty-recovery-schemas.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { closed, continuation, unavailable, evidenceOrDefault } from './primitives.ts';
import {
  viewerFacts,
  admitCollectionFollows,
  admitSubjectViewerFacts,
  snapshotViewerOverlays,
  admitAccountFollows,
} from './viewer-overlays.ts';
import { SubjectHitSchema, admitSubjectHit, serializeSubjectHit } from './subject.ts';
import { AccountHitSchema, admitAccountHit, serializeAccountHit } from './account.ts';
import { CollectionHitSchema, admitCollectionHit, serializeCollectionHit } from './collection.ts';
import { ReviewHitSchema, admitReviewHit, serializeReviewHit } from './review.ts';
import { SpaceHitSchema, admitSpaceHit, serializeSpaceHit, admitSpaceEntries } from './space.ts';
const count = t.Union([
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 0 }), exact: t.Literal(true) }, closed),
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 1 }), exact: t.Literal(false) }, closed),
  t.Object({ kind: t.String(), unavailable: t.Literal(true) }, closed),
]);
const applicability = t.Union([t.Literal('all'), t.Literal('partial'), t.Literal('none'), t.Literal('unknown')]);
/** The owner-tagged key and non-null native summary close together; no Account Subject shell. */
export const DiscoveryPageSchema = t.Object(
  {
    spaceEntries: t.Optional(SpaceEntryPageSchema),
    hits: t.Array(t.Union([SubjectHitSchema, AccountHitSchema, CollectionHitSchema, ReviewHitSchema, SpaceHitSchema]), {
      maxItems: 100,
    }),
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
    applicability: t.Optional(t.Object({ type: applicability, statement: applicability }, closed)),
    next: continuation,
    as_of: t.String({ format: 'date-time' }),
    freshness: t.Optional(SearchFreshnessSchema),
    viewerFacts: t.Optional(viewerFacts),
    collectionFollows: t.Optional(FollowDiscoverySchema),
    accountFollows: t.Optional(FollowDiscoverySchema),
    emptyRecovery: t.Optional(EmptyRecoverySchema),
  },
  closed,
);

export type DiscoveryHttpPage = Static<typeof DiscoveryPageSchema>;

const pageCheck = Compile(DiscoveryPageSchema);

/** Each family closes its schema and native identity before page/cursor admission. */
export function admitDiscoveryHit(value: unknown): asserts value is DiscoveryUnionHit {
  const kind = (value as { summary?: { kind?: unknown } } | null)?.summary?.kind;
  switch (kind) {
    case 'subject':
      return admitSubjectHit(value);
    case 'account':
      return admitAccountHit(value);
    case 'collection':
      return admitCollectionHit(value);
    case 'review':
      return admitReviewHit(value);
    case 'space':
      return admitSpaceHit(value);
    default:
      return unavailable();
  }
}

/** Run before cursor signing as well as at the wire boundary. Empty pages still carry metadata. */
export function admitDiscoveryPage(value: unknown): asserts value is DiscoveryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { hits?: unknown }).hits))
    unavailable();
  const normalized = {
    ...(value as Record<string, unknown>),
    hits: (value as { hits: unknown[] }).hits.map(evidenceOrDefault),
  };
  if (!pageCheck.Check(normalized)) unavailable();
  const page = normalized as DiscoveryHttpPage;
  const identities = new Set<string>();
  let contextBytes = 0;
  let reviewBytes = 0;
  for (const hit of page.hits) {
    admitDiscoveryHit(hit);
    if (hit.summary.kind === 'review' && hit.summary.value.searchContext) {
      reviewBytes += searchContextBytes(hit.summary.value.searchContext);
      if (reviewBytes > REVIEW_CONTEXT_LIMITS.pageBytes) unavailable();
    }
    if ('workContext' in hit && hit.workContext) contextBytes += workContextBytes(hit.workContext);
    if (contextBytes > WORK_CONTEXT_LIMITS.pageBytes) unavailable();
    const identity = JSON.stringify([hit.key.owner, hit.key.kind, hit.key.route, hit.key.id]);
    if (identities.has(identity)) unavailable();
    identities.add(identity);
  }
  admitCollectionFollows(page);
  admitAccountFollows(page);
  admitSpaceEntries(page);
  admitSubjectViewerFacts(page);
  const kinds = new Set<string>();
  for (const kind of page.kinds.values) {
    if (kinds.has(kind.id) || (kind.count && kind.count.kind !== kind.id)) unavailable();
    if (kind.count && 'value' in kind.count && !Number.isSafeInteger(kind.count.value)) unavailable();
    kinds.add(kind.id);
  }
}

/** Close and detach the owner replies after complete page admission. */
export function discoveryHttpPage(page: DiscoveryPage): DiscoveryHttpPage {
  admitDiscoveryPage(page);
  const { hits, viewerFacts, collectionFollows, accountFollows, ...publicPage } = page;
  return {
    ...structuredClone(publicPage),
    hits: page.hits.map((hit): DiscoveryHttpPage['hits'][number] => {
      switch (hit.summary.kind) {
        case 'subject':
          return serializeSubjectHit(hit as Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>);
        case 'account':
          return serializeAccountHit(hit as Extract<DiscoveryUnionHit, { summary: { kind: 'account' } }>);
        case 'collection':
          return serializeCollectionHit(hit as Extract<DiscoveryUnionHit, { summary: { kind: 'collection' } }>);
        case 'review':
          return serializeReviewHit(hit as Extract<DiscoveryUnionHit, { summary: { kind: 'review' } }>);
        case 'space':
          return serializeSpaceHit(hit as Extract<DiscoveryUnionHit, { summary: { kind: 'space' } }>);
      }
    }),
    ...snapshotViewerOverlays(page),
  };
}
