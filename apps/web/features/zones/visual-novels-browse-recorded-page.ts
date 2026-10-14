import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { RealmReadClient } from '../realm/read.ts';
import type { ZoneBrowseQuery } from '../realm/types.ts';
import type { RecordedSelection, RecordedState } from '../stories/recorded-fetch.ts';

/**
 * Pages the production browse route recorded.
 * `refusal` is the outcome proof's unsupported query (`sort=relevance` with `limit` and `type`, and no text).
 * The page drops relevance without text and never sends `limit` or `type`, so that 400 is not a page the route can open.
 */
export const visualNovelsBrowseSamples = {
  newest: 'page-browse-newest',
  continuation: 'page-browse-newest-continuation',
  updated: 'page-search-updated',
  relevance: 'page-search-relevance',
  empty: 'page-search-no-match',
  refusal: 'primary-get-realms-modules-browse-0',
} as const;

const frameLabels = ['frame-address', 'frame-presentation', 'frame-realm-header', 'frame-facets'] as const;
const signedInLabels = [
  'frame-session-agent', 'frame-person-preferences', 'frame-joining', 'frame-follow',
  'frame-platform-access', 'frame-member-ban',
] as const;

export function recordedBrowseSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

/** Frame reads the browse route reaches, plus the one page. A second presentation sample of the same request stays unselected. */
export function recordedBrowseSelections(record: AnswerRecord, persona: AnswerPersona, label: string,
  state: RecordedState): RecordedSelection[] {
  const labels = persona === 'visitor' ? [...frameLabels, label] : [...frameLabels, ...signedInLabels, label];
  return labels.map(item => ({
    label: item,
    state: item === label ? state : recordedBrowseSample(record, persona, item).status >= 400 ? 'error' : 'populated',
  }));
}

export function recordedSiteKey(record: AnswerRecord): string {
  const key = new URL(recordedBrowseSample(record, 'visitor', 'frame-address').path, 'https://recorded.invalid')
    .searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

/** The page address recorded for this browse. Its parameters are the production page's search. */
export function recordedBrowseSearch(record: AnswerRecord, persona: AnswerPersona, label: string): Record<string, string> {
  return Object.fromEntries(new URL(recordedBrowseSample(record, persona, label).path, 'https://recorded.invalid').searchParams);
}

export function recordedActingSubject(record: AnswerRecord, persona: AnswerPersona): string | undefined {
  if (persona === 'visitor') return undefined;
  const answer = recordedBrowseSample(record, persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  };
  return answer.sessionAgent.actingSubject;
}

export function recordedHeaderName(record: AnswerRecord, persona: AnswerPersona): string {
  return (recordedBrowseSample(record, persona, 'frame-realm-header').answer as { name: { value: string } }).name.value;
}

/** The proof sample's wire query, repeated by the typed browse reader. The page does not build this query. */
export function recordedRefusalQuery(sample: AnswerSample): ZoneBrowseQuery {
  const url = new URL(sample.path, 'https://recorded.invalid');
  const sort = url.searchParams.get('sort');
  const limit = Number(url.searchParams.get('limit'));
  const type = url.searchParams.getAll('type');
  if (sort !== 'relevance' || !Number.isInteger(limit) || type.length === 0 || url.searchParams.has('q')) {
    throw new Error('Recorded refusal is not relevance without text');
  }
  return { sort, limit, type };
}

/** Anonymous reads on `main`; signed-in presentation and membership on `personal`. Same split the page records. */
export function recordedBrowseClient(fetcher: typeof fetch, persona: AnswerPersona, actingSubject?: string): RealmReadClient {
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const personal = actingSubject ? browserMainApi('https://recorded.invalid', { fetcher }) : main;
  return {
    main,
    personal,
    ...(actingSubject ? { actingSubject } : {}),
    signedIn: persona !== 'visitor',
  };
}

export { BFF_PREFIX };
