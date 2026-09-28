import type { FilterDocument } from './filter-document-v1.ts';

/**
 * Query revision that admits a top-rated order, a Mine scope, and the rating
 * Context and reader those pages rank by. filter-document-v1 keeps its fields
 * and meaning. A persisted id changes only by revision: a Saved Filter that
 * uses these fields is this document, marked `profile: 'filter-document-v2'`.
 */
export interface ResourceQuery {
  profile: 'filter-document-v2';
  context: 'global' | { realm: string };
  scope: { kind: 'all' } | { kind: 'realm'; realm: string } | { kind: 'mine' };
  filter?: FilterDocument;
  text?: { phrase: string } | { title: string; body: string };
  sort: 'relevance' | 'newest' | 'updated' | 'top-rated';
  /** The standing rating Context a top-rated or Mine page ranks by. */
  ratingContext?: string;
  /** The reader a Mine page lists. Required with scope mine. */
  actingSubject?: string;
  page: { size: number; continuation?: unknown };
  /** Explicit unsupported selectors are admitted as typed refusals. */
  sourcePolicy?: unknown;
  asOf?: unknown;
}
