import { normalizeSearchText, searchText, type SearchMatchMode } from '../search/text.ts';
import { currentDisclosureViewer, namePolicyPrincipal } from '../disclosure/viewer.ts';
import { createHash } from 'node:crypto';
import { DISCLOSURE_COST } from '../disclosure/read.ts';
import { MAX_PHRASE_CANDIDATES, PHRASE_HIT_PROBE, MAX_SEARCH_RESPONSE_BYTES } from './search-limits.ts';

export const MAX_SEARCH_PAGE_SIZE = 64;
export const SEARCH_PAGE_TTL_MS = 5 * 60_000;

/** First and continuation pages rank a bounded complete candidate pool.
 * For one body match per Work, disclosure hydrates name, content and contribution:
 * calls = fixedCalls + ceil(candidates / hydrationBatchSize). Fixed calls and
 * candidate row bytes are calibrated at the smallest restored cut. */
export const PUBLIC_SEARCH_PAGE_COST = {
  class: 'bounded-candidate-pool',
  dimension: 'matchingWorks',
  candidates: MAX_PHRASE_CANDIDATES,
  probeRows: PHRASE_HIT_PROBE,
  responseBytes: MAX_SEARCH_RESPONSE_BYTES,
  disclosureBatchSize: DISCLOSURE_COST.batch,
  hydrationBatchSize: DISCLOSURE_COST.batch / 3,
  rowByteSlack: 1.25,
  growth: {
    mainCalls: { class: 'constant', dimension: 'candidateCount' },
    accountCalls: { class: 'constant', dimension: 'candidateCount' },
    otherFetches: { class: 'constant', dimension: 'candidateCount' },
    unclassifiedFetches: { class: 'constant', dimension: 'candidateCount' },
    fusekiRequests: { class: 'linear', dimension: 'candidateCount',
      reason: `fixedCalls + ceil(3 * candidates / ${DISCLOSURE_COST.batch}), candidates <= ${MAX_PHRASE_CANDIDATES}` },
    postgresStatements: { class: 'linear', dimension: 'candidateCount',
      reason: `fixedStatements + ceil(3 * candidates / ${DISCLOSURE_COST.batch}), candidates <= ${MAX_PHRASE_CANDIDATES}` },
    fusekiSentBytes: { class: 'linear', dimension: 'candidateCount', reason: 'Bounded candidate hydration input' },
    fusekiReceivedBytes: { class: 'linear', dimension: 'candidateCount', reason: 'Bounded candidate rows and hydrated cards' },
  },
} as const;

export class InvalidSearchContinuation extends Error {}
export class SearchContinuationRestart extends Error {}

export interface SearchContinuation {
  queryDigest: string;
  resultDigest: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  indexGeneration: string;
  nextOffset: number;
  expiresAt: number;
}

interface BasePublicPhrasePageRequest {
  language: string | null;
  matchMode?: SearchMatchMode;
  author?: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  pageSize: number;
  continuation?: SearchContinuation;
}
export type PublicPhrasePageRequest = BasePublicPhrasePageRequest & (
  { profile: 'public-main-title-body-page-v1'; titleTerm: string; bodyTerm: string }
  | { profile: 'public-main-phrase-page-v1'; phrase: string }
  | { profile: 'public-realm-phrase-page-v1'; phrase: string;
    context: { kind: 'realm-local'; id: string } }
  | { profile: 'public-main-classified-phrase-page-v1'; phrase: string; sense: string }
  | { profile: 'public-realm-classified-phrase-page-v1'; phrase: string;
    context: { kind: 'realm-local'; id: string }; sense: string }
  | { profile: 'public-realm-classified-rated-phrase-page-v1'; phrase: string;
    context: { kind: 'realm-local'; id: string }; sense: string;
    ratingContext: string; minimumMeanTimes10: number }
);

interface CompletePublicRelation<Row> {
  resultGrain: 'mainVersion';
  context: 'main-version-default' | { kind: 'realm-local'; id: string };
  complete: true;
  population: number;
  total: number;
  results: Row[];
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  indexGeneration: string;
}

const digest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

/** Bind identity and current disclosure preferences, including anonymous readers. */
export function searchReaderKey() {
  const viewer = currentDisclosureViewer(), principal = namePolicyPrincipal(viewer);
  return [principal?.issuer ?? null, principal?.subject ?? null, viewer];
}

function requestDigest(input: PublicPhrasePageRequest): string {
  return digest([input.profile,
    'phrase' in input ? searchText(input.phrase, input.matchMode, InvalidSearchContinuation).text : null,
    input.matchMode ?? 'phrase', searchReaderKey(),
    'titleTerm' in input ? normalizeSearchText(input.titleTerm) : null,
    'bodyTerm' in input ? normalizeSearchText(input.bodyTerm) : null,
    input.language, input.author ?? null, 'context' in input ? input.context.id : null,
    'sense' in input ? input.sense : null,
    'ratingContext' in input ? input.ratingContext : null,
    'minimumMeanTimes10' in input ? input.minimumMeanTimes10 : null,
    input.includeTypes ?? [], input.excludeTypes ?? [],
    input.pageSize]);
}

/** Each page re-runs the complete bounded relation; a changed source, reader or
 * ordered result demands a new query from page one. This is not an HTTP snapshot.
 * Cost after the read is O(k + serialized row bytes) for k <= 512; the caller's
 * 1 MiB phrase response and 1,500 ms request deadline bound the input and time. */
export function pageCompletePublicRelation<Row>(input: PublicPhrasePageRequest,
  relation: CompletePublicRelation<Row>, now = Date.now(), presentationGeneration?: string) {
  const main = input.profile === 'public-main-phrase-page-v1'
    || input.profile === 'public-main-classified-phrase-page-v1'
    || input.profile === 'public-main-title-body-page-v1';
  if (relation.resultGrain !== 'mainVersion' || relation.complete !== true
    || !Number.isSafeInteger(relation.population) || relation.population < relation.total
    || relation.sourcePosition.datasetId !== 'product'
    || !/^(0|[1-9][0-9]*)$/.test(relation.sourcePosition.sequence)
    || typeof relation.sourcePosition.dataEpoch !== 'string'
    || !relation.sourcePosition.dataEpoch
    || typeof relation.indexGeneration !== 'string' || !relation.indexGeneration
    || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1
    || input.pageSize > MAX_SEARCH_PAGE_SIZE || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(relation.total) || relation.total < 0
    || relation.total !== relation.results.length || relation.total >= MAX_PHRASE_CANDIDATES + 1
    || main !== (relation.context === 'main-version-default')
    || (!main && (typeof relation.context === 'string'
      || !('context' in input) || relation.context.id !== input.context.id))) {
    throw new InvalidSearchContinuation('public page request or complete relation is invalid');
  }
  const queryDigest = requestDigest(input);
  const resultDigest = digest(presentationGeneration === undefined ? relation.results
    : [relation.results, presentationGeneration]);
  const prior = input.continuation;
  if (prior && (!/^[0-9a-f]{64}$/.test(prior.queryDigest)
    || !/^[0-9a-f]{64}$/.test(prior.resultDigest)
    || !Number.isSafeInteger(prior.nextOffset) || prior.nextOffset < 1
    || prior.nextOffset > MAX_PHRASE_CANDIDATES
    || !Number.isSafeInteger(prior.expiresAt) || prior.expiresAt < 0
    || prior.sourcePosition.datasetId !== 'product'
    || !/^(0|[1-9][0-9]*)$/.test(prior.sourcePosition.sequence)
    || typeof prior.sourcePosition.dataEpoch !== 'string'
    || !prior.sourcePosition.dataEpoch
    || typeof prior.indexGeneration !== 'string' || !prior.indexGeneration)) {
    throw new InvalidSearchContinuation('public page continuation is malformed');
  }
  if (prior && (prior.expiresAt <= now || prior.queryDigest !== queryDigest
    || prior.resultDigest !== resultDigest
    || prior.sourcePosition.datasetId !== relation.sourcePosition.datasetId
    || prior.sourcePosition.dataEpoch !== relation.sourcePosition.dataEpoch
    || prior.sourcePosition.sequence !== relation.sourcePosition.sequence
    || prior.indexGeneration !== relation.indexGeneration)) {
    throw new SearchContinuationRestart('public search changed; restart at page one');
  }
  if (prior && prior.nextOffset >= relation.total) {
    throw new InvalidSearchContinuation('public page continuation offset is invalid');
  }
  const offset = prior?.nextOffset ?? 0;
  const nextOffset = Math.min(offset + input.pageSize, relation.total);
  const next: SearchContinuation | null = nextOffset < relation.total
    ? { queryDigest, resultDigest, sourcePosition: relation.sourcePosition,
      indexGeneration: relation.indexGeneration, nextOffset,
      expiresAt: prior?.expiresAt ?? now + SEARCH_PAGE_TTL_MS } : null;
  return { profile: input.profile, resultGrain: relation.resultGrain,
    context: relation.context, relationComplete: true as const,
    population: relation.population, total: relation.total,
    sourcePosition: relation.sourcePosition, indexGeneration: relation.indexGeneration,
    results: relation.results.slice(offset, nextOffset), next };
}
