import { createHash } from 'node:crypto';
import { InvalidSearchContinuation, MAX_SEARCH_PAGE_SIZE, SEARCH_PAGE_TTL_MS,
  SearchContinuationRestart } from '../work/search-continuation.ts';
import { MAX_PHRASE_CANDIDATES } from '../work/search-readiness.ts';
import type { queryPublicContentPhrase } from './search.ts';

type ContentRelation = Awaited<ReturnType<typeof queryPublicContentPhrase>>;

export interface ContentSearchContinuation {
  queryDigest: string;
  resultDigest: string;
  graphPosition: ContentRelation['graphPosition'];
  contentPosition: ContentRelation['contentPosition'];
  indexGeneration: string;
  nextOffset: number;
  expiresAt: number;
}

export interface ContentPhrasePageRequest {
  profile: 'public-content-phrase-page-v1';
  phrase: string;
  language: string | null;
  pageSize: number;
  continuation?: ContentSearchContinuation;
}

const digest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
const decimal = /^(0|[1-9][0-9]*)$/;

/** Re-run the complete relation on every page and restart if either owner moved. */
export function pageCompleteContentRelation(input: ContentPhrasePageRequest,
  relation: ContentRelation, now = Date.now()) {
  if (relation.profile !== 'public-content-phrase-v1' || relation.resultGrain !== 'content-variant'
    || relation.complete !== true || !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1 || input.pageSize > MAX_SEARCH_PAGE_SIZE
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(relation.total) || relation.total < 0
    || relation.total !== relation.results.length || relation.total > MAX_PHRASE_CANDIDATES
    || !Number.isSafeInteger(relation.population) || relation.population < relation.total
    || relation.contentPosition.owner !== 'content'
    || !decimal.test(relation.graphPosition.sequence)
    || !decimal.test(relation.contentPosition.sequence)) {
    throw new InvalidSearchContinuation('Content page request or complete relation is invalid');
  }
  const queryDigest = digest([input.profile,
    input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' '), input.language, input.pageSize]);
  const resultDigest = digest(relation.results);
  const prior = input.continuation;
  if (prior && (!/^[0-9a-f]{64}$/.test(prior.queryDigest)
    || !/^[0-9a-f]{64}$/.test(prior.resultDigest)
    || !Number.isSafeInteger(prior.nextOffset) || prior.nextOffset < 1
    || prior.nextOffset > MAX_PHRASE_CANDIDATES
    || !Number.isSafeInteger(prior.expiresAt) || prior.expiresAt < 0
    || prior.contentPosition.owner !== 'content'
    || !decimal.test(prior.graphPosition.sequence)
    || !decimal.test(prior.contentPosition.sequence))) {
    throw new InvalidSearchContinuation('Content page continuation is malformed');
  }
  if (prior && (prior.expiresAt <= now || prior.queryDigest !== queryDigest
    || prior.resultDigest !== resultDigest
    || prior.graphPosition.dataEpoch !== relation.graphPosition.dataEpoch
    || prior.graphPosition.sequence !== relation.graphPosition.sequence
    || prior.contentPosition.dataEpoch !== relation.contentPosition.dataEpoch
    || prior.contentPosition.sequence !== relation.contentPosition.sequence
    || prior.indexGeneration !== relation.indexGeneration)) {
    throw new SearchContinuationRestart('Content search changed; restart at page one');
  }
  if (prior && prior.nextOffset >= relation.total) {
    throw new InvalidSearchContinuation('Content page continuation offset is invalid');
  }
  const offset = prior?.nextOffset ?? 0;
  const nextOffset = Math.min(offset + input.pageSize, relation.total);
  const next: ContentSearchContinuation | null = nextOffset < relation.total
    ? { queryDigest, resultDigest, graphPosition: relation.graphPosition,
      contentPosition: relation.contentPosition, indexGeneration: relation.indexGeneration,
      nextOffset, expiresAt: prior?.expiresAt ?? now + SEARCH_PAGE_TTL_MS } : null;
  return { profile: input.profile, resultGrain: relation.resultGrain,
    relationComplete: true as const, population: relation.population, total: relation.total,
    graphPosition: relation.graphPosition, contentPosition: relation.contentPosition,
    indexGeneration: relation.indexGeneration,
    results: relation.results.slice(offset, nextOffset), next };
}
