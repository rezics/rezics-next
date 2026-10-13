import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { ZoneBrowseQuery } from '../realm/types.ts';
import { parseBrowseState, type BrowseState } from './browse-state.ts';

const conceptPrefix = 'https://rezics.com/id/';

/** One sample of a persona. The record is the only source of the request. */
export function recordedSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

export function recordedActingSubject(path: string): string | undefined {
  return new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
}

/**
 * The browse call a recorded path already made. The page query keeps the Facets
 * `parseBrowseState` understands; `publicationYear` stays on the API query because
 * the page state has no parameter for it.
 */
export function recordedBrowseCall(path: string): { realm: string; query: ZoneBrowseQuery; state: BrowseState } {
  const url = new URL(path, 'https://recorded.invalid');
  const realm = url.pathname.split('/')[3];
  if (!realm) throw new Error(`Recorded browse path has no realm: ${path}`);
  const sort = url.searchParams.get('sort');
  const admittedSort = sort === 'newest' || sort === 'updated' || sort === 'relevance' ? sort : undefined;
  const types = url.searchParams.getAll('type');
  const concepts = url.searchParams.getAll('concept');
  const statuses = url.searchParams.getAll('status');
  const length = url.searchParams.get('length');
  const text = url.searchParams.get('q');
  const cursor = url.searchParams.get('cursor');
  const year = url.searchParams.get('publicationYear');
  const limit = url.searchParams.get('limit');
  const query: ZoneBrowseQuery = {
    ...(admittedSort ? { sort: admittedSort } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(text ? { q: text } : {}),
    ...(cursor ? { cursor } : {}),
    ...(year ? { publicationYear: year } : {}),
    ...(types.length ? { type: types } : {}),
    ...(concepts.length ? { concept: concepts } : {}),
    ...(statuses.length ? { status: statuses } : {}),
    ...(length ? { length } : {}),
  };
  const state = parseBrowseState({
    ...(admittedSort ? { sort: admittedSort } : {}),
    ...(text ? { q: text } : {}),
    ...(cursor ? { cursor } : {}),
    ...(types.length ? { type: types.map(type => type.replace('https://schema.org/', 'schema:').replace('https://rezics.com/vocab/', 'rv:')) } : {}),
    ...(concepts.length ? { concept: concepts.map(value => value.startsWith(conceptPrefix) ? value.slice(conceptPrefix.length) : value) } : {}),
    ...(statuses.length ? { status: statuses } : {}),
    ...(length ? { length } : {}),
  });
  return { realm, query, state };
}
