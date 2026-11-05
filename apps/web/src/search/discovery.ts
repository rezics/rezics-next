import { accountContext } from './account-context/schema';
import { resultFreshness } from './search-context/observation';
import { spaceEntryPage, spaceEntryPresentation } from './space-entry/contract';
import * as v from 'valibot';
import {
  collectionCurator,
  collectionPreview,
  collectionFollows,
  collectionFollowSource,
} from './collection-context/schema';
import { searchContextSource, searchReviewContext, validReviewContextBinding } from './review-context';
import { isCalendarDate } from '@rezics/filter';
import type { KernelClient } from '@rezics/client';
import { GLOBAL, PUBLIC_RATING_SCALE, QUESTION } from '../features/pages/subject-ratings';
import { readSearchPage } from './search-request';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { currentEvidenceMatches, evidencePageWithinLimit, matchEvidenceSchema } from './match-evidence';

type NativePage = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>,
  { subjects: unknown }
>;
type NativeHit = NativePage['subjects'][number];

// Keep the opt-in envelope separate from the generated Subject compatibility response.
// Validate unknown wire data before allowing it to reach the page.
const textMap = v.record(v.string(), v.string());
const cover = v.object({
  media: v.string(),
  width: v.number(),
  height: v.number(),
  placeholder: v.object({ thumbhash: v.string(), color: v.string() }),
  variants: v.array(v.object({ format: v.picklist(['avif', 'webp']), width: v.number() })),
  focalPoint: v.nullable(v.object({ x: v.number(), y: v.number() })),
  credit: v.nullable(
    v.object({
      rightsHolder: v.string(),
      via: v.exactOptional(v.object({ name: v.string(), url: v.string() })),
      license: v.exactOptional(v.string()),
    }),
  ),
});
const subjectSummary: v.GenericSchema<NonNullable<NativeHit['summary']>> = v.object({
  id: v.string(),
  type: v.string(),
  types: v.array(v.string()),
  label: v.nullable(v.object({ value: v.string(), language: v.string() })),
  creativeWork: v.boolean(),
  cover: v.nullable(
    v.object({
      ...cover.entries,
      credit: v.object({
        rightsHolder: v.string(),
        via: v.object({ name: v.string(), url: v.string() }),
        license: v.string(),
        obligations: v.array(v.string()),
      }),
    }),
  ),
});
const accountSummary = v.strictObject({
  context: v.exactOptional(accountContext),
  id: v.string(),
  accountKind: v.picklist(['actor', 'organization']),
  handle: v.nullable(v.string()),
  displayName: v.nullable(v.string()),
  automated: v.boolean(),
  operatorId: v.nullable(v.string()),
  avatar: v.nullable(cover),
  verifiedAgent: v.nullable(v.object({ id: v.string(), label: v.string(), type: v.string() })),
});
const fact: v.GenericSchema<NonNullable<NativeHit['facts']>[string][number]> = v.variant('kind', [
  v.object({ kind: v.literal('item'), id: v.string(), labels: textMap }),
  v.pipe(
    v.object({
      kind: v.literal('time'),
      year: v.pipe(v.number(), v.integer()),
      month: v.exactOptional(v.pipe(v.number(), v.integer())),
      day: v.exactOptional(v.pipe(v.number(), v.integer())),
    }),
    v.check((value) => isCalendarDate(value)),
  ),
  v.object({ kind: v.literal('quantity'), amount: v.pipe(v.number(), v.finite()), unit: v.string() }),
  v.object({ kind: v.literal('code'), value: v.string() }),
]);
const displayRating = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(PUBLIC_RATING_SCALE.min),
  v.maxValue(PUBLIC_RATING_SCALE.max),
);
const figure: v.GenericSchema<NativeHit['figure']> = v.strictObject({
  questionId: v.literal(QUESTION),
  populationId: v.literal(GLOBAL),
  scale: v.strictObject({
    min: v.pipe(v.number(), v.integer()),
    max: v.pipe(v.number(), v.integer()),
    displayStep: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  count: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  state: v.picklist(['ready', 'insufficient_data', 'updating']),
  mean: v.nullable(displayRating),
  score: v.nullable(displayRating),
});
const catalogueFields = {
  matchEvidence: v.exactOptional(matchEvidenceSchema),
  labels: v.exactOptional(textMap),
  aliases: v.exactOptional(v.record(v.string(), v.array(v.string()))),
  descriptions: v.exactOptional(textMap),
  facts: v.exactOptional(v.record(v.string(), v.pipe(v.array(fact), v.maxLength(3)))),
  figure: v.exactOptional(figure),
  listPresentation: v.exactOptional(
    v.object({
      imageAspect: v.picklist(['portrait', 'landscape', 'square']),
      keyFacts: v.pipe(v.array(v.string()), v.maxLength(4)),
    }),
  ),
};
const contextSubject = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  labels: textMap,
  aliases: v.exactOptional(v.record(v.string(), v.array(v.string()))),
});
const contextList = v.strictObject({
  items: v.pipe(v.array(contextSubject), v.maxLength(3)),
  next: v.boolean(),
});
const characterPersonContexts = v.strictObject({ credits: contextList, appearances: contextList });
const legacyHit = v.object({
  id: v.string(),
  type: v.string(),
  summary: v.nullable(subjectSummary),
  ...catalogueFields,
  labels: textMap,
});
const freshness = v.optional(
  v.fallback(
    v.strictObject({
      state: v.picklist(['current', 'catching-up', 'unavailable']),
    }),
    { state: 'unavailable' as const },
  ),
);
const emptyRecoveryAction = v.variant('kind', [
  v.strictObject({ kind: v.literal('edit-query') }),
  v.strictObject({ kind: v.literal('remove-type') }),
  v.strictObject({ kind: v.literal('remove-kind'), value: v.pipe(v.string(), v.maxLength(128)) }),
  v.strictObject({
    kind: v.literal('remove-facet'),
    property: v.pipe(v.string(), v.maxLength(128)),
    value: v.pipe(v.string(), v.maxLength(128)),
  }),
  v.strictObject({ kind: v.literal('remove-range'), property: v.pipe(v.string(), v.maxLength(128)) }),
]);
const emptyRecovery = v.strictObject({
  status: v.picklist(['ready', 'preparing', 'unavailable']),
  alternatives: v.pipe(
    v.array(
      v.strictObject({
        query: v.pipe(v.string(), v.maxLength(128)),
        label: v.pipe(v.string(), v.maxLength(128)),
      }),
    ),
    v.maxLength(3),
  ),
  actions: v.pipe(v.array(emptyRecoveryAction), v.maxLength(8)),
});
const legacyPage = v.object({
  subjects: v.pipe(v.array(legacyHit), v.maxLength(100)),
  next: v.nullable(v.string()),
  as_of: v.string(),
  freshness,
  emptyRecovery: v.exactOptional(emptyRecovery),
});
const route = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535));
const resourceId = v.pipe(v.string(), v.minLength(1));
const publicCollectionCard = v.variant('membershipKind', [
  v.strictObject({
    kind: v.literal('collection'),
    id: resourceId,
    destination: v.pipe(v.string(), v.minLength(1)),
    title: v.pipe(v.string(), v.minLength(1)),
    description: v.nullable(v.string()),
    visibility: v.literal('public'),
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    sourceGeneration: v.pipe(v.string(), v.regex(/^[0-9]{1,20}$/)),
    presentationKind: v.nullable(v.string()),
    presentationKindSource: v.picklist(['mixed', 'owner']),
    cover: v.nullable(cover),
    coverSource: v.picklist(['owner', 'member', 'none', 'pending']),
    curator: collectionCurator,
    preview: collectionPreview,
    membershipKind: v.literal('curated'),
    memberCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    orderEpoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
    createdAt: v.string(),
    updatedAt: v.string(),
  }),
  v.strictObject({
    kind: v.literal('collection'),
    id: resourceId,
    destination: v.pipe(v.string(), v.minLength(1)),
    title: v.pipe(v.string(), v.minLength(1)),
    description: v.nullable(v.string()),
    visibility: v.literal('public'),
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    sourceGeneration: v.pipe(v.string(), v.regex(/^[0-9]{1,20}$/)),
    presentationKind: v.nullable(v.string()),
    presentationKindSource: v.picklist(['mixed', 'owner']),
    cover: v.nullable(cover),
    coverSource: v.picklist(['owner', 'member', 'none', 'pending']),
    curator: collectionCurator,
    preview: collectionPreview,
    membershipKind: v.literal('dynamic'),
    outputGeneration: v.pipe(v.string(), v.minLength(1)),
  }),
]);
const publicCollectionSummary = v.strictObject({
  id: resourceId,
  title: v.pipe(v.string(), v.minLength(1)),
  description: v.nullable(v.string()),
  card: publicCollectionCard,
});
const reviewSubject = v.strictObject({
  id: resourceId,
  title: v.exactOptional(v.nullable(v.string())),
});
const reviewAuthor = v.strictObject({
  displayName: v.nullable(v.string()),
  handle: v.nullable(v.string()),
});
const publicReviewSummary = v.strictObject({
  id: resourceId,
  kind: v.literal('review'),
  title: v.nullable(v.string()),
  author: v.exactOptional(reviewAuthor),
  excerpt: v.exactOptional(v.pipe(v.string(), v.maxLength(640))),
  subject: v.exactOptional(v.nullable(reviewSubject)),
  source: v.exactOptional(searchContextSource),
  searchContext: v.exactOptional(searchReviewContext),
});
const publicSpaceSummary = v.strictObject({
  presentation: v.exactOptional(spaceEntryPresentation),
  id: resourceId,
  title: v.pipe(v.string(), v.minLength(1)),
  address: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  summary: v.exactOptional(v.string()),
  realm: v.exactOptional(
    v.nullable(
      v.strictObject({
        id: resourceId,
        title: v.exactOptional(v.nullable(v.string())),
      }),
    ),
  ),
});
const hit = v.union([
  v.object({
    key: v.strictObject({ owner: v.literal('semantic'), kind: v.string(), route, id: resourceId }),
    summary: v.object({ kind: v.literal('subject'), value: subjectSummary }),
    ...catalogueFields,
    contexts: v.exactOptional(characterPersonContexts),
  }),
  v.object({
    key: v.strictObject({ owner: v.literal('accounts'), kind: v.literal('account'), route, id: resourceId }),
    summary: v.object({ kind: v.literal('account'), value: accountSummary }),
    matchEvidence: v.exactOptional(matchEvidenceSchema),
  }),
  v.strictObject({
    key: v.strictObject({ owner: v.literal('library'), kind: v.literal('collection'), route, id: resourceId }),
    summary: v.strictObject({ kind: v.literal('collection'), value: publicCollectionSummary }),
    matchEvidence: v.exactOptional(matchEvidenceSchema),
  }),
  v.strictObject({
    key: v.strictObject({ owner: v.literal('content'), kind: v.literal('review'), route, id: resourceId }),
    summary: v.strictObject({ kind: v.literal('review'), value: publicReviewSummary }),
    matchEvidence: v.exactOptional(matchEvidenceSchema),
  }),
  v.strictObject({
    key: v.strictObject({ owner: v.literal('community'), kind: v.literal('space'), route, id: resourceId }),
    summary: v.strictObject({ kind: v.literal('space'), value: publicSpaceSummary }),
    matchEvidence: v.exactOptional(matchEvidenceSchema),
  }),
]);
const count = v.union([
  v.object({
    kind: v.string(),
    value: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
    exact: v.literal(true),
  }),
  v.object({
    kind: v.string(),
    value: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
    exact: v.literal(false),
  }),
  v.object({ kind: v.string(), unavailable: v.literal(true) }),
]);
const kind = v.object({ id: v.string(), labels: textMap, icon: v.string(), count: v.exactOptional(count) });
const omittedKind = v.strictObject({
  id: v.string(),
  labels: textMap,
  state: v.picklist(['preparing', 'unavailable']),
});
const kinds = v.object({
  values: v.pipe(v.array(kind), v.maxLength(8)),
  omitted: v.exactOptional(v.pipe(v.array(omittedKind), v.maxLength(3))),
  next: v.nullable(v.string()),
});
const kindPage = v.object({ kinds, as_of: v.string() });
const viewerQuestion = v.strictObject({
  id: resourceId,
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  grain: v.string(),
  scale: v.strictObject({
    min: v.number(),
    max: v.number(),
    displayStep: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  meaning: v.string(),
});
const viewerEntry = v.variant('state', [
  v.strictObject({
    state: v.literal('present'),
    incarnationId: v.nullable(resourceId),
    entryState: v.nullable(v.string()),
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.strictObject({ state: v.literal('absent') }),
  v.strictObject({ state: v.literal('unavailable'), reason: v.literal('scope') }),
]);
const viewerVote = v.variant('state', [
  v.strictObject({
    state: v.literal('present'),
    questionId: resourceId,
    questionRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    units: v.pipe(v.number(), v.integer()),
    revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({
    state: v.literal('absent'),
    questionId: resourceId,
    questionRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({ state: v.literal('unavailable'), reason: v.picklist(['scope', 'question']) }),
]);
const viewerFact = v.strictObject({
  rowKey: v.string(),
  subjectId: resourceId,
  resolvedSubjectId: v.exactOptional(resourceId),
  entry: viewerEntry,
  vote: viewerVote,
});
const viewerFacts = v.union([
  v.null(),
  v.strictObject({
    state: v.literal('current'),
    question: v.nullable(viewerQuestion),
    rows: v.pipe(v.array(viewerFact), v.maxLength(100)),
  }),
  v.strictObject({
    state: v.literal('unavailable'),
    reason: v.picklist(['identity', 'currentness', 'response_limit']),
    retryable: v.boolean(),
  }),
]);
const page = v.object({
  spaceEntries: v.exactOptional(spaceEntryPage),
  hits: v.pipe(v.array(hit), v.maxLength(100)),
  kinds,
  next: v.nullable(v.string()),
  as_of: v.string(),
  freshness,
  viewerFacts: v.exactOptional(viewerFacts),
  collectionFollows: v.exactOptional(collectionFollows),
  accountFollows: v.exactOptional(collectionFollows),
  emptyRecovery: v.exactOptional(emptyRecovery),
});

export type DiscoveryPage = v.InferOutput<typeof page>;
export type EmptyRecovery = NonNullable<DiscoveryPage['emptyRecovery']>;
export type LegacySearchPage = v.InferOutput<typeof legacyPage>;
export type DiscoveryKinds = v.InferOutput<typeof kinds>;
export type DiscoveryHit = DiscoveryPage['hits'][number];
export type AccountDiscoverySummary = v.InferOutput<typeof accountSummary>;
export type PublicCollectionSummary = v.InferOutput<typeof publicCollectionSummary>;
export type PublicReviewSummary = v.InferOutput<typeof publicReviewSummary>;
export type PublicSpaceSummary = v.InferOutput<typeof publicSpaceSummary>;
export type PublicDiscoveryHit = Extract<DiscoveryHit, { summary: { kind: 'collection' | 'review' | 'space' } }>;
export type DiscoveryViewerFact = v.InferOutput<typeof viewerFact>;
export type DiscoveryViewerQuestion = v.InferOutput<typeof viewerQuestion>;
export type DiscoveryRequest = Parameters<KernelClient['subjects']['$search']['post']>[0] & {
  representation: 'discovery-v1';
  languages: string[];
  spoilerThreshold?: 0 | 1 | 2;
  descriptions?: boolean;
  properties?: string[];
  kindPage?: { limit: number; cursor?: string };
  kindCountLeaf?: number;
};
export type DiscoveryState =
  | {
      status:
        | 'loading'
        | 'unavailable'
        | 'not-ready'
        | 'preparing'
        | 'closed'
        | 'restart'
        | 'invalid'
        | 'unsupported'
        | 'denied';
    }
  | { status: 'ready'; page: DiscoveryPage };

export function discoveryKey(hit: DiscoveryHit): string {
  const { owner, kind, route, id } = hit.key;
  return JSON.stringify([owner, kind, route, id]);
}

function normalizeMissingEvidence(value: unknown, legacySubjects = false): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const pageValue = value as Record<string, unknown>;
  const normalizeHit = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const hit = raw as Record<string, unknown>;
    if (hit.matchEvidence !== undefined) return hit;
    const summary = hit.summary as { kind?: unknown } | null | undefined;
    const semantic = legacySubjects || summary?.kind === 'subject';
    return { ...hit, matchEvidence: semantic ? { state: 'unavailable' } : { state: 'unsupported' } };
  };
  if (Array.isArray(pageValue.hits)) return { ...pageValue, hits: pageValue.hits.map(normalizeHit) };
  if (Array.isArray(pageValue.subjects)) return { ...pageValue, subjects: pageValue.subjects.map(normalizeHit) };
  return value;
}

/** Retain native order and full owner-kind-route-id identity. Incomplete owner summaries fail the whole page. */
export function parseDiscoveryPage(value: unknown): DiscoveryPage | undefined {
  const parsed = v.safeParse(page, normalizeMissingEvidence(value));
  if (!parsed.success) return;
  const result = { ...parsed.output, freshness: resultFreshness(parsed.output.freshness, parsed.output.as_of) };
  if (result.emptyRecovery && new TextEncoder().encode(JSON.stringify(result.emptyRecovery)).byteLength > 16_384)
    return;
  if (!evidencePageWithinLimit(result.hits.map((hit) => hit.matchEvidence ?? { state: 'unavailable' }))) return;
  let reviewBytes = 0;
  for (const hit of result.hits) {
    if (hit.key.id !== hit.summary.value.id) return;
    const matchEvidence = hit.matchEvidence ?? {
      state: hit.summary.kind === 'subject' ? 'unavailable' : 'unsupported',
    };
    if (!currentEvidenceMatches(matchEvidence, hit.key.id)) return;
    switch (hit.summary.kind) {
      case 'subject':
        if (hit.key.owner !== 'semantic' || hit.key.kind !== hit.summary.value.type) return;
        const subject = hit as Extract<DiscoveryHit, { summary: { kind: 'subject' } }>;
        if (subject.facts && Object.keys(subject.facts).length > 4) return;
        const contexts = subject.contexts;
        if (contexts && [contexts.credits, contexts.appearances].some((list) => list.next && list.items.length !== 3))
          return;
        break;
      case 'account':
        if (hit.key.owner !== 'accounts' || hit.key.kind !== 'account' || matchEvidence.state !== 'unsupported') return;
        if (hit.summary.value.context) {
          const context = hit.summary.value.context;
          if (
            new TextEncoder().encode(JSON.stringify(context)).byteLength > 8192 ||
            (context.biography.state === 'available' &&
              new TextEncoder().encode(context.biography.text).byteLength > 1024)
          )
            return;
        }
        break;
      case 'collection':
        if (
          hit.key.owner !== 'library' ||
          hit.key.kind !== 'collection' ||
          matchEvidence.state !== 'unsupported' ||
          hit.summary.value.card.id !== hit.key.id ||
          hit.summary.value.card.title !== hit.summary.value.title ||
          hit.summary.value.card.description !== hit.summary.value.description ||
          new TextEncoder().encode(
            JSON.stringify({ curator: hit.summary.value.card.curator, preview: hit.summary.value.card.preview }),
          ).byteLength > 4096 ||
          (hit.summary.value.card.curator.state === 'available' &&
            hit.summary.value.card.curator.destination !== null &&
            !/^\/@[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(hit.summary.value.card.curator.destination)) ||
          (hit.summary.value.card.preview.state === 'available' &&
            new Set(hit.summary.value.card.preview.members.map((member) => member.id)).size !==
              hit.summary.value.card.preview.members.length)
        )
          return;
        break;
      case 'review':
        if (
          hit.key.owner !== 'content' ||
          hit.key.kind !== 'review' ||
          hit.summary.value.kind !== 'review' ||
          !validReviewContextBinding(hit.summary.value) ||
          matchEvidence.state !== 'unsupported'
        )
          return;
        if (hit.summary.value.searchContext) {
          reviewBytes += new TextEncoder().encode(JSON.stringify(hit.summary.value.searchContext)).byteLength;
          if (reviewBytes > 128 * 1024) return;
        }
        break;
      case 'space':
        if (hit.key.owner !== 'community' || hit.key.kind !== 'space' || matchEvidence.state !== 'unsupported') return;
        break;
    }
  }
  if (result.collectionFollows?.state === 'current') {
    const rows = result.collectionFollows.rows;
    const collections = result.hits.flatMap((hit) =>
      hit.summary.kind === 'collection' ? [hit.summary.value.card] : [],
    );
    const accountRoute = Number.parseInt(result.collectionFollows.accountId.slice(24, 28), 16);
    if (
      !Number.isFinite(accountRoute) ||
      accountRoute >>> 4 !== result.collectionFollows.partition ||
      rows.length !== collections.length ||
      rows.some((row, index) => {
        const card = collections[index]!;
        return (
          row.targetType !== 'collection' || row.targetId !== card.id || row.source !== collectionFollowSource(card)
        );
      })
    )
      return;
  }
  if (result.accountFollows?.state === 'current') {
    const follows = result.accountFollows;
    const targets = result.hits.flatMap((hit) =>
      hit.summary.kind === 'account' && hit.summary.value.context?.followTarget.state === 'available'
        ? [hit.summary.value.context.followTarget]
        : [],
    );
    const home = Number.parseInt(follows.accountId.slice(24, 28), 16);
    if (
      home >>> 4 !== follows.partition ||
      follows.rows.length !== targets.length ||
      new Set(targets.map((target) => target.id)).size !== targets.length ||
      follows.rows.some(
        (row, index) =>
          row.targetType !== 'subject' || row.targetId !== targets[index]!.id || row.source !== targets[index]!.source,
      )
    )
      return;
  }
  const spaces = result.hits.filter((hit) => hit.summary.kind === 'space');
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
      return;
  }
  if (result.spaceEntries) {
    if (
      result.spaceEntries.rows.length !== spaces.length ||
      new TextEncoder().encode(JSON.stringify(result.spaceEntries)).byteLength > 65536
    )
      return;
    for (const [index, row] of result.spaceEntries.rows.entries()) {
      const hit = spaces[index]!;
      if (hit.summary.kind !== 'space') return;
      const value = hit.summary.value;
      if (
        !value.presentation ||
        row.id !== hit.key.id ||
        (row.destination.kind === 'realm' && row.destination.realmId !== value.realm?.id) ||
        (row.destination.kind === 'space' &&
          (value.realm || row.destination.spaceId !== value.id || row.destination.address !== value.address)) ||
        (row.entry === 'allowed' && row.destination.kind === 'unavailable') ||
        (result.spaceEntries.reader === null
          ? row.follow.state !== 'sign-in'
          : row.follow.state === 'sign-in' || (row.follow.state === 'current' && row.follow.action === 'sign-in'))
      )
        return;
    }
  }
  if (result.viewerFacts && result.viewerFacts !== null && result.viewerFacts.state === 'current') {
    const subjects = result.hits.filter((hit) => hit.summary.kind === 'subject');
    if (
      result.viewerFacts.rows.length !== subjects.length ||
      result.viewerFacts.rows.some(
        (row, index) => row.subjectId !== subjects[index]!.key.id || row.rowKey !== discoveryKey(subjects[index]!),
      )
    )
      return;
    for (const row of result.viewerFacts.rows) {
      if (row.vote.state === 'unavailable') continue;
      const question = result.viewerFacts.question;
      if (!question || row.vote.questionId !== question.id || row.vote.questionRevision !== question.revision) return;
      if (
        row.vote.state === 'present' &&
        (row.vote.units < question.scale.min ||
          row.vote.units > question.scale.max ||
          (row.vote.units - question.scale.min) % question.scale.displayStep !== 0)
      )
        return;
    }
  }
  if (new Set(result.hits.map(discoveryKey)).size !== result.hits.length || !validKinds(result.kinds)) return;
  return result;
}

function validKinds(value: DiscoveryKinds): boolean {
  const available = new Set(value.values.map((kind) => kind.id));
  const omitted = value.omitted ?? [];
  return (
    available.size === value.values.length &&
    new Set(omitted.map((kind) => kind.id)).size === omitted.length &&
    omitted.every((kind) => !available.has(kind.id)) &&
    value.values.every((kind) => !kind.count || kind.count.kind === kind.id)
  );
}

/**
 * Preserve native order and nullable summaries. Incoherent evidence or repeated rendered keys
 * make the whole legacy page unavailable without synthesizing or fetching replacement rows.
 */
export function parseLegacySearchPage(value: unknown): LegacySearchPage | undefined {
  const parsed = v.safeParse(legacyPage, normalizeMissingEvidence(value, true));
  if (!parsed.success) return;
  if (
    parsed.output.emptyRecovery &&
    new TextEncoder().encode(JSON.stringify(parsed.output.emptyRecovery)).byteLength > 16_384
  )
    return;

  const identities = new Set<string>();
  if (!evidencePageWithinLimit(parsed.output.subjects.map((hit) => hit.matchEvidence ?? { state: 'unavailable' })))
    return;
  for (const { id, type, summary } of parsed.output.subjects) {
    if (summary !== null && (summary.id !== id || summary.type !== type)) {
      return;
    }

    const identity = `${type}:${id}`;
    if (identities.has(identity)) {
      return;
    }
    identities.add(identity);
  }
  if (
    parsed.output.subjects.some((hit) => !currentEvidenceMatches(hit.matchEvidence ?? { state: 'unavailable' }, hit.id))
  )
    return;
  return parsed.output;
}

function problemCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'value' in error ? problemCode(error.value) : undefined;
}

type Failure = Exclude<DiscoveryState, { status: 'ready' }>;
export function discoveryFailure(status: number, error: unknown): Failure {
  const code = problemCode(error);
  if (status === 409) return { status: 'restart' };
  if (code === 'platform_closed') return { status: 'closed' };
  if (code === 'index_not_ready' || code === 'semantic_not_ready') return { status: 'not-ready' };
  if (status === 202 || code === 'preparing') return { status: 'preparing' };
  if (status === 401 || status === 403) return { status: 'denied' };
  if (status === 422) return { status: 'unsupported' };
  if (status === 400) return { status: 'invalid' };
  return { status: 'unavailable' };
}

type Response = { status: number; data?: unknown; error?: unknown };
export type DiscoverySender = (request: DiscoveryRequest) => Promise<Response>;

/** One mixed query. Retain the explicit legacy rating restart without broadening other 409s. */
async function readDiscoveryPage(
  request: DiscoveryRequest,
  send: DiscoverySender,
  restartRating: boolean,
): Promise<{ discovery: DiscoveryState; restarted: boolean }> {
  try {
    const { response, restarted } =
      restartRating && request.sort === 'rating'
        ? await readSearchPage(request, send)
        : { response: await send(request), restarted: false };
    if (response.error || response.status !== 200)
      return { discovery: discoveryFailure(response.status, response.error ?? response.data), restarted };
    const result = parseDiscoveryPage(response.data);
    return { discovery: result ? { status: 'ready', page: result } : { status: 'unavailable' }, restarted };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { discovery: { status: isPlatformClosedError(error) ? 'closed' : 'unavailable' }, restarted: false };
  }
}

export function readDiscovery(request: DiscoveryRequest, send: DiscoverySender) {
  return readDiscoveryPage(request, send, true);
}

/** Mutation reconciliation reads exactly one complete native page. A retired cut requires an explicit restart. */
export async function readDiscoveryMutationPage(
  request: DiscoveryRequest,
  send: (request: DiscoveryRequest, signal: AbortSignal) => ReturnType<DiscoverySender>,
  signal: AbortSignal,
): Promise<DiscoveryState> {
  signal.throwIfAborted();
  const result = await readDiscoveryPage(request, (body) => send(body, signal), false);
  signal.throwIfAborted();
  return result.discovery;
}

export type DiscoveryKindsState = Failure | { status: 'ready'; kinds: DiscoveryKinds };

/** A kind cursor selects metadata only on the same operation, without hit cursor or count requests. */
export async function readDiscoveryKinds(
  request: DiscoveryRequest,
  cursor: string,
  send: DiscoverySender,
): Promise<DiscoveryKindsState> {
  const {
    cursor: _hitCursor,
    kindCountLeaf: _count,
    limit: _limit,
    descriptions: _descriptions,
    properties: _properties,
    ...conditions
  } = request;
  try {
    const response = await send({ ...conditions, kindPage: { limit: 8, cursor } });
    if (response.error || response.status !== 200)
      return discoveryFailure(response.status, response.error ?? response.data);
    const parsed = v.safeParse(kindPage, response.data);
    if (
      !parsed.success ||
      !validKinds(parsed.output.kinds) ||
      parsed.output.kinds.next === cursor ||
      (parsed.success && parsed.output.kinds.next !== null && parsed.output.kinds.values.length === 0)
    )
      return { status: 'unavailable' };
    return {
      status: 'ready',
      kinds: {
        values: parsed.output.kinds.values.map(({ count: _count, ...metadata }) => metadata),
        ...(parsed.output.kinds.omitted ? { omitted: parsed.output.kinds.omitted } : {}),
        next: parsed.output.kinds.next,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { status: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

export function isCatalogueHit(hit: DiscoveryHit): hit is Extract<DiscoveryHit, { summary: { kind: 'subject' } }> {
  return hit.summary.kind === 'subject';
}

export function isAccountHit(hit: DiscoveryHit): hit is Extract<DiscoveryHit, { summary: { kind: 'account' } }> {
  return hit.summary.kind === 'account';
}

export function isPublicDiscoveryHit(hit: DiscoveryHit): hit is PublicDiscoveryHit {
  return hit.summary.kind === 'collection' || hit.summary.kind === 'review' || hit.summary.kind === 'space';
}
