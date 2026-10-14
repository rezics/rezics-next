import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { MainClient } from '../discover/types.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { ZoneBrowseQuery } from '../realm/types.ts';
import { parseBrowseState, urlValue } from './browse-state.ts';
import type { ZoneMessages } from './messages.ts';

export function catalogueSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const samples = record.personas[persona].filter(sample => sample.label === label);
  if (samples.length !== 1) throw new Error(`Expected one ${record.row}/${persona}/${label} answer`);
  return samples[0]!;
}

/** Replay every Condition and the opaque continuation from the original request. */
export function catalogueRequest(path: string) {
  const url = new URL(path, 'https://recorded.invalid');
  const realm = url.pathname.split('/')[3];
  if (!realm || !url.pathname.endsWith('/modules/browse')) throw new Error('Expected a Realm browse request');
  const params = url.searchParams;
  const sort = params.get('sort');
  if (sort !== null && sort !== 'newest' && sort !== 'updated' && sort !== 'relevance') throw new Error('Unknown browse sort');
  const query: ZoneBrowseQuery = {
    ...(sort ? { sort } : {}),
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    ...(params.has('language') ? { language: params.get('language')! } : {}),
    ...(params.has('q') ? { q: params.get('q')! } : {}),
    ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(params.has('publicationYear') ? { publicationYear: params.get('publicationYear')! } : {}),
    ...(params.has('length') ? { length: params.get('length')! } : {}),
    ...(params.has('type') ? { type: params.getAll('type') } : {}),
    ...(params.has('concept') ? { concept: params.getAll('concept') } : {}),
    ...(params.has('status') ? { status: params.getAll('status') } : {}),
    ...(params.has('excludeConcept') ? { excludeConcept: params.getAll('excludeConcept') } : {}),
  };
  const search = {
    ...Object.fromEntries(params),
    type: params.getAll('type').map(value => urlValue('type', value)),
    concept: params.getAll('concept').map(value => urlValue('concept', value)),
    status: params.getAll('status'),
    exclude: params.getAll('excludeConcept').map(value => urlValue('concept', value)),
    ...(query.publicationYear ? { year: query.publicationYear } : {}),
  };
  return { realm, query, search, state: parseBrowseState(search) };
}

/** Stories and unit proofs use the production reader and page builder, without a parallel adapter. */
export async function readCatalogueStory(main: MainClient, path: string, zone: ZoneContext,
  locale: UiLocale, messages: ZoneMessages, facetsRecorded: boolean, catalogue?: ZonePackage['catalogue']) {
  const request = catalogueRequest(path);
  const [page, facets] = await Promise.all([
    readBrowseAnswer(main, request.realm, request.query),
    facetsRecorded ? readFacetAnswer(main) : Promise.resolve({ ok: false as const, failure: 'unavailable' as const }),
  ]);
  return buildBrowsePage({ page, facets, base: zone.links.browse, zoneName: zone.name.value,
    state: request.state, context: { realm: request.realm, ref: request.realm, locale }, locale, messages, catalogue });
}
