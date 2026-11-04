import {
  ReviewContextSourceSchema,
  SearchReviewContextSchema,
  searchContextBytes,
  validReviewContextBinding,
} from './review-context-schemas.ts';
import { REVIEW_CONTEXT_LIMITS } from './review-context.ts';
import {
  WorkContextSchema,
  validWorkContext,
  workContextBytes,
  workContextKind,
  WORK_CONTEXT_LIMITS,
} from './work-context.ts';
import { CollectionCuratorSchema, CollectionPreviewSchema, FollowDiscoverySchema } from './collection-context-http.ts';
import { SearchFreshnessSchema } from './search-context.ts';
import { SpaceEntryPageSchema, SpaceEntryPresentationSchema } from '../community/space-discovery-entry-contract.ts';
import type { Static } from 'typebox';
import type { DiscoveryPage, DiscoveryUnionHit } from './discovery.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { routeOf } from '../route/route.ts';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';
import { CoverSummarySchema, SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { viewerFactsResponseSchema } from '../library/viewer-facts.ts';
import { PublicFigureSchema } from '../rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
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
const collectionKey = t.Object(
  { owner: t.Literal('library'), kind: t.Literal('collection'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
  closed,
);
const reviewKey = t.Object(
  { owner: t.Literal('content'), kind: t.Literal('review'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
  closed,
);
const spaceKey = t.Object(
  { owner: t.Literal('community'), kind: t.Literal('space'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
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
const reviewAuthor = t.Object({ displayName: nullableText, handle: nullableText }, closed);
const reviewSubject = t.Object({ id, title: nullableText }, closed);
const reviewSummary = t.Object(
  {
    id,
    kind: t.Literal('review'),
    title: nullableText,
    author: t.Optional(reviewAuthor),
    excerpt: t.Optional(t.String({ maxLength: 640 })),
    subject: t.Optional(t.Union([reviewSubject, t.Null()])),
    source: t.Optional(ReviewContextSourceSchema),
    searchContext: t.Optional(SearchReviewContextSchema),
  },
  closed,
);
const spaceSummary = t.Object(
  {
    presentation: t.Optional(SpaceEntryPresentationSchema),
    id,
    title: t.String({ minLength: 1 }),
    address: t.String({ minLength: 1, maxLength: 256 }),
    summary: t.Optional(t.String()),
    realm: t.Optional(t.Union([t.Object({ id, title: nullableText }, closed), t.Null()])),
  },
  closed,
);
const count = t.Union([
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 0 }), exact: t.Literal(true) }, closed),
  t.Object({ kind: t.String(), value: t.Integer({ minimum: 1 }), exact: t.Literal(false) }, closed),
  t.Object({ kind: t.String(), unavailable: t.Literal(true) }, closed),
]);
const characterPersonContexts = t.Object(
  {
    credits: t.Object(
      {
        items: t.Array(
          t.Object(
            {
              id,
              labels: t.Record(t.String(), t.String()),
              aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
            },
            closed,
          ),
          { maxItems: 3 },
        ),
        next: t.Boolean(),
      },
      closed,
    ),
    appearances: t.Object(
      {
        items: t.Array(
          t.Object(
            {
              id,
              labels: t.Record(t.String(), t.String()),
              aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
            },
            closed,
          ),
          { maxItems: 3 },
        ),
        next: t.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
const discoveryFact = t.Union([
  t.Object({ kind: t.Literal('item'), id, labels: t.Record(t.String(), t.String()) }, closed),
  t.Object(
    {
      kind: t.Literal('time'),
      year: t.Integer(),
      month: t.Optional(t.Integer()),
      day: t.Optional(t.Integer()),
    },
    closed,
  ),
  t.Object({ kind: t.Literal('quantity'), amount: t.Number(), unit: t.String() }, closed),
  t.Object({ kind: t.Literal('code'), value: t.String() }, closed),
]);
const listPresentation = t.Object(
  {
    imageAspect: t.Union([t.Literal('portrait'), t.Literal('landscape'), t.Literal('square')]),
    keyFacts: t.Array(t.String(), { maxItems: 4 }),
  },
  closed,
);
const viewerFactsUnavailable = t.Object(
  {
    state: t.Literal('unavailable'),
    reason: t.Union([t.Literal('identity'), t.Literal('currentness'), t.Literal('response_limit')]),
    retryable: t.Boolean(),
  },
  closed,
);
const currentViewerFactsSchema = viewerFactsResponseSchema.anyOf[0];
const searchViewerFacts = t.Object(
  {
    ...currentViewerFactsSchema.properties,
    rows: t.Array(
      t.Object(
        {
          ...currentViewerFactsSchema.properties.rows.items.properties,
          resolvedSubjectId: t.Optional(t.String({ format: 'uuid' })),
        },
        closed,
      ),
      { maxItems: 100 },
    ),
  },
  closed,
);
const viewerFacts = t.Union([t.Null(), searchViewerFacts, viewerFactsUnavailable]);
/** The owner-tagged key and non-null native summary close together; no Account Subject shell. */
export const DiscoveryPageSchema = t.Object(
  {
    spaceEntries: t.Optional(SpaceEntryPageSchema),
    hits: t.Array(
      t.Union([
        t.Object(
          {
            key: key('semantic'),
            summary: t.Object({ kind: t.Literal('subject'), value: SubjectSummarySchema }, closed),
            labels: t.Optional(t.Record(t.String(), t.String())),
            aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
            descriptions: t.Optional(t.Record(t.String(), t.String())),
            facts: t.Optional(t.Record(t.String(), t.Array(discoveryFact, { maxItems: 3 }), { maxProperties: 4 })),
            figure: t.Optional(PublicFigureSchema),
            listPresentation: t.Optional(listPresentation),
            contexts: t.Optional(characterPersonContexts),
            workContext: t.Optional(WorkContextSchema),
          },
          closed,
        ),
        t.Object(
          { key: key('accounts'), summary: t.Object({ kind: t.Literal('account'), value: accountSummary }, closed) },
          closed,
        ),
        t.Object(
          {
            key: collectionKey,
            summary: t.Object({ kind: t.Literal('collection'), value: collectionDiscoverySummary }, closed),
          },
          closed,
        ),
        t.Object(
          { key: reviewKey, summary: t.Object({ kind: t.Literal('review'), value: reviewSummary }, closed) },
          closed,
        ),
        t.Object(
          { key: spaceKey, summary: t.Object({ kind: t.Literal('space'), value: spaceSummary }, closed) },
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
    freshness: t.Optional(SearchFreshnessSchema),
    viewerFacts: t.Optional(viewerFacts),
    collectionFollows: t.Optional(FollowDiscoverySchema),
  },
  closed,
);

export type DiscoveryHttpPage = Static<typeof DiscoveryPageSchema>;

const hitSchema = DiscoveryPageSchema.properties.hits.items;
const hitCheck = Compile(hitSchema);
const pageCheck = Compile(DiscoveryPageSchema);
const unavailable = (): never => {
  throw new SearchUnavailableError('Discovery response is incomplete or malformed');
};

/** Validate the native owner reply without coercion or removal of unrecognized fields. */
export function admitDiscoveryHit(value: unknown): asserts value is DiscoveryUnionHit {
  if (!hitCheck.Check(value)) unavailable();
  const { key, summary } = value as Static<typeof hitSchema>;
  if (routeOf(key.id) !== key.route || key.id !== summary.value.id) unavailable();
  if (summary.kind === 'subject') {
    if (key.owner !== 'semantic' || key.kind !== summary.value.type) unavailable();
    const context = (value as Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>).workContext;
    if (
      context &&
      (!validWorkContext(context, summary.value.id) ||
        (context.state === 'current' &&
          (context.type.id !== summary.value.type ||
            !summary.value.creativeWork ||
            context.kind !== workContextKind([summary.value.type, ...summary.value.types]))))
    )
      unavailable();
    const figure = (value as { figure?: { questionId: string; populationId: string } }).figure;
    if (figure && (figure.questionId !== STANDARD_QUESTION_ID || figure.populationId !== GLOBAL_CONTEXT.id))
      unavailable();
    const contexts = (
      value as {
        contexts?: { credits: { items: unknown[]; next: boolean }; appearances: { items: unknown[]; next: boolean } };
      }
    ).contexts;
    if (contexts && [contexts.credits, contexts.appearances].some((list) => list.next && list.items.length !== 3))
      unavailable();
  }
  if (summary.kind === 'account' && (key.owner !== 'accounts' || key.kind !== 'account')) unavailable();
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
  if (
    summary.kind === 'review' &&
    (key.owner !== 'content' || key.kind !== 'review' || !validReviewContextBinding(summary.value))
  )
    unavailable();
  if (summary.kind === 'space' && (key.owner !== 'community' || key.kind !== 'space')) unavailable();
}

/** Run before cursor signing as well as at the wire boundary. Empty pages still carry metadata. */
export function admitDiscoveryPage(value: unknown): asserts value is DiscoveryPage {
  if (!pageCheck.Check(value)) unavailable();
  const page = value as DiscoveryHttpPage;
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
  if (page.collectionFollows?.state === 'current') {
    const collections = page.hits.flatMap((hit) => (hit.summary.kind === 'collection' ? [hit.summary.value.card] : []));
    const home = routeOf(page.collectionFollows.accountId);
    if (
      home === null ||
      home >>> 4 !== page.collectionFollows.partition ||
      page.collectionFollows.rows.length !== collections.length ||
      page.collectionFollows.rows.some((row, index) => {
        const card = collections[index]!;
        return (
          row.targetType !== 'collection' ||
          row.targetId !== card.id ||
          row.source !==
            JSON.stringify([
              card.id,
              card.sourceGeneration,
              card.revision,
              card.membershipKind,
              card.membershipKind === 'curated' ? card.orderEpoch : card.outputGeneration,
            ])
        );
      })
    )
      unavailable();
  }
  const spaces = page.hits.filter((hit) => hit.summary.kind === 'space');
  for (const hit of spaces) {
    if (hit.summary.kind !== 'space') continue;
    const value = hit.summary.value,
      presentation = value.presentation;
    if (
      presentation &&
      (presentation.identity.id !== (value.realm?.id ?? value.id) ||
        presentation.identity.kind !== (value.realm ? 'realm' : 'space') ||
        (presentation.avatar.state === 'available' && presentation.avatar.realmId !== value.realm?.id))
    )
      unavailable();
  }
  if (page.spaceEntries) {
    if (page.spaceEntries.rows.length !== spaces.length || Buffer.byteLength(JSON.stringify(page.spaceEntries)) > 65536)
      unavailable();
    page.spaceEntries.rows.forEach((row, index) => {
      const hit = spaces[index]!;
      if (hit.summary.kind !== 'space') return unavailable();
      const value = hit.summary.value;
      if (
        !value.presentation ||
        row.id !== hit.key.id ||
        (row.destination.kind === 'realm' && row.destination.realmId !== value.realm?.id) ||
        (row.destination.kind === 'space' &&
          (value.realm || row.destination.spaceId !== value.id || row.destination.address !== value.address)) ||
        (row.entry === 'allowed' && row.destination.kind === 'unavailable') ||
        (page.spaceEntries!.reader === null
          ? row.follow.state !== 'sign-in'
          : row.follow.state === 'sign-in' || (row.follow.state === 'current' && row.follow.action === 'sign-in'))
      )
        unavailable();
    });
  }
  if (page.viewerFacts && page.viewerFacts !== null && page.viewerFacts.state === 'current') {
    const subjects = page.hits.filter((hit) => hit.summary.kind === 'subject');
    if (
      page.viewerFacts.rows.length !== subjects.length ||
      page.viewerFacts.rows.some(
        (row, index) =>
          row.subjectId !== subjects[index]!.key.id ||
          row.rowKey !==
            JSON.stringify([
              subjects[index]!.key.owner,
              subjects[index]!.key.kind,
              subjects[index]!.key.route,
              subjects[index]!.key.id,
            ]),
      )
    )
      unavailable();
  }
  const kinds = new Set<string>();
  for (const kind of page.kinds.values) {
    if (kinds.has(kind.id) || (kind.count && kind.count.kind !== kind.id)) unavailable();
    if (kind.count && 'value' in kind.count && !Number.isSafeInteger(kind.count.value)) unavailable();
    kinds.add(kind.id);
  }
}

/** Close the owner/summary union and snapshot nested owner values before serialization. */
export function discoveryHttpPage(page: DiscoveryPage): DiscoveryHttpPage {
  admitDiscoveryPage(page);
  const { viewerFacts: originalViewerFacts, collectionFollows: originalFollows, ...publicPage } = page;
  const collectionFollows: DiscoveryHttpPage['collectionFollows'] =
    originalFollows?.state === 'current'
      ? { ...originalFollows, rows: originalFollows.rows.map((row) => ({ ...row, actions: { ...row.actions } })) }
      : originalFollows
        ? { ...originalFollows }
        : undefined;
  const viewerFacts: DiscoveryHttpPage['viewerFacts'] =
    originalViewerFacts === undefined || originalViewerFacts === null
      ? originalViewerFacts
      : originalViewerFacts.state === 'unavailable'
        ? { ...originalViewerFacts }
        : {
            state: 'current',
            question: originalViewerFacts.question
              ? { ...originalViewerFacts.question, scale: { ...originalViewerFacts.question.scale } }
              : null,
            rows: originalViewerFacts.rows.map((row) => ({
              rowKey: row.rowKey,
              subjectId: row.subjectId,
              ...(row.resolvedSubjectId ? { resolvedSubjectId: row.resolvedSubjectId } : {}),
              entry: structuredClone(row.entry),
              vote: structuredClone(row.vote),
            })),
          };
  return {
    ...publicPage,
    hits: page.hits.map((hit): DiscoveryHttpPage['hits'][number] => {
      if (hit.summary.kind === 'account') {
        if (hit.key.owner !== 'accounts') throw new SearchUnavailableError('Discovery summary owner disagrees');
        const account = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'account' } }>;
        const summary = account.summary.value;
        return {
          key: { owner: 'accounts', kind: 'account', route: account.key.route, id: account.key.id },
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
      if (hit.summary.kind === 'subject') {
        if (hit.key.owner !== 'semantic') throw new SearchUnavailableError('Discovery summary owner disagrees');
        const subject = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>;
        return {
          key: { owner: 'semantic', kind: subject.key.kind, route: subject.key.route, id: subject.key.id },
          summary: { kind: 'subject' as const, value: { ...subject.summary.value } },
          ...(subject.workContext === undefined ? {} : { workContext: structuredClone(subject.workContext) }),
          ...(subject.labels === undefined ? {} : { labels: { ...subject.labels } }),
          ...(subject.aliases === undefined
            ? {}
            : {
                aliases: Object.fromEntries(
                  Object.entries(subject.aliases).map(([language, values]) => [language, [...values]]),
                ),
              }),
          ...(subject.descriptions === undefined ? {} : { descriptions: { ...subject.descriptions } }),
          ...(subject.facts === undefined
            ? {}
            : {
                facts: Object.fromEntries(
                  Object.entries(subject.facts).map(([property, values]) => [
                    property,
                    values.map((fact) => structuredClone(fact)),
                  ]),
                ),
              }),
          ...(subject.figure === undefined
            ? {}
            : { figure: { ...subject.figure, scale: { ...subject.figure.scale } } }),
          ...(subject.listPresentation === undefined
            ? {}
            : {
                listPresentation: {
                  ...subject.listPresentation,
                  keyFacts: [...subject.listPresentation.keyFacts],
                },
              }),
          ...(subject.contexts === undefined
            ? {}
            : {
                contexts: {
                  credits: {
                    items: subject.contexts.credits.items.map((item) => structuredClone(item)),
                    next: subject.contexts.credits.next,
                  },
                  appearances: {
                    items: subject.contexts.appearances.items.map((item) => structuredClone(item)),
                    next: subject.contexts.appearances.next,
                  },
                },
              }),
        };
      }
      if (hit.summary.kind === 'collection') {
        if (hit.key.owner !== 'library') throw new SearchUnavailableError('Discovery summary owner disagrees');
        const collection = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'collection' } }>;
        const value = collection.summary.value;
        return {
          key: { owner: 'library', kind: 'collection', route: collection.key.route, id: collection.key.id },
          summary: {
            kind: 'collection' as const,
            value: {
              ...value,
              card: {
                ...value.card,
                curator: { ...value.card.curator },
                preview:
                  value.card.preview.state === 'available'
                    ? {
                        ...value.card.preview,
                        members: value.card.preview.members.map((member) => ({
                          ...member,
                          subject: {
                            ...member.subject,
                            types: [...member.subject.types],
                            label: member.subject.label ? { ...member.subject.label } : null,
                          },
                        })),
                      }
                    : { ...value.card.preview },
                cover: value.card.cover
                  ? {
                      ...value.card.cover,
                      placeholder: { ...value.card.cover.placeholder },
                      variants: value.card.cover.variants.map((variant) => ({ ...variant })),
                      focalPoint: value.card.cover.focalPoint ? { ...value.card.cover.focalPoint } : null,
                      credit: {
                        ...value.card.cover.credit,
                        via: { ...value.card.cover.credit.via },
                        obligations: [...value.card.cover.credit.obligations],
                      },
                    }
                  : null,
              },
            },
          },
        };
      }
      if (hit.summary.kind === 'review') {
        if (hit.key.owner !== 'content') throw new SearchUnavailableError('Discovery summary owner disagrees');
        const review = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'review' } }>;
        const value = review.summary.value;
        return {
          key: { owner: 'content', kind: 'review', route: review.key.route, id: review.key.id },
          summary: {
            kind: 'review' as const,
            value: {
              ...value,
              ...(value.author ? { author: { ...value.author } } : {}),
              ...(value.subject && value.subject !== null ? { subject: { ...value.subject } } : {}),
            },
          },
        };
      }
      if (hit.key.owner !== 'community') throw new SearchUnavailableError('Discovery summary owner disagrees');
      const space = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'space' } }>;
      const value = space.summary.value;
      return {
        key: { owner: 'community', kind: 'space', route: space.key.route, id: space.key.id },
        summary: {
          kind: 'space' as const,
          value: { ...value, ...(value.realm && value.realm !== null ? { realm: { ...value.realm } } : {}) },
        },
      };
    }),
    ...(viewerFacts === undefined ? {} : { viewerFacts }),
    ...(collectionFollows === undefined ? {} : { collectionFollows }),
    ...(page.spaceEntries === undefined ? {} : { spaceEntries: structuredClone(page.spaceEntries) }),
  };
}
