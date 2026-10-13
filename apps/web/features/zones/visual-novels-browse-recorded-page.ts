import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext, ZoneTokens } from '@rezics/zone-sdk';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey } from '../address/path.ts';
import type { MainClient } from '../discover/types.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import type { FacetList, Loaded, ZoneBrowsePage, ZoneBrowseQuery } from '../realm/types.ts';
import type { RecordedSelection, RecordedState } from '../stories/recorded-fetch.ts';
import { parseBrowseState, type BrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import type { ZoneMessages } from './messages.ts';

/** Labels this row actually recorded for the public catalogue browse. */
export const visualNovelsBrowseSamples = {
  newest: 'primary-get-realms-modules-browse-1',
  continuation: 'primary-get-realms-modules-browse-2',
  updated: 'primary-get-realms-modules-browse-3',
  relevance: 'primary-get-realms-modules-browse-5',
  refusal: 'primary-get-realms-modules-browse-0',
  /** Recorded only for the member proof, as an empty relevance search. */
  empty: 'search-no-match',
} as const;

const facetLabel = 'facet-labels';

export function recordedBrowseSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

/** Facet names are a separate read. A persona proof that never called it leaves them unread. */
export function recordedBrowseSelections(record: AnswerRecord, persona: AnswerPersona, label: string,
  state: RecordedState): RecordedSelection[] {
  const facets = record.personas[persona].filter(sample => sample.label === facetLabel);
  if (facets.length > 1) throw new Error(`Ambiguous recorded facet labels for ${persona}`);
  return [{ label, state }, ...facets.length === 1 ? [{ label: facetLabel, state: 'populated' as const }] : []];
}

export interface RecordedBrowseRequest {
  realm: string;
  query: ZoneBrowseQuery;
  state: BrowseState;
}

/** The recorded browse URL, including its wire query, is the request the typed client repeats. */
export function recordedBrowseRequest(sample: AnswerSample): RecordedBrowseRequest {
  const url = new URL(sample.path, 'https://recorded.invalid');
  const sort = url.searchParams.get('sort');
  if (sort !== 'newest' && sort !== 'updated' && sort !== 'relevance') throw new Error('Missing recorded browse sort');
  const limit = Number(url.searchParams.get('limit'));
  if (!Number.isInteger(limit)) throw new Error('Missing recorded browse limit');
  const type = url.searchParams.getAll('type');
  const q = url.searchParams.get('q') ?? undefined;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const query: ZoneBrowseQuery = { sort, limit, ...type.length ? { type } : {}, ...q ? { q } : {}, ...cursor ? { cursor } : {} };
  return { realm: url.pathname.split('/')[3]!, query, state: parseBrowseState({
    sort, ...q ? { q } : {}, ...cursor ? { cursor } : {},
    type: type.map(item => item.replace('https://schema.org/', 'schema:')),
  }) };
}

/** A recorded zone browse opens on the site address family. */
const siteAddressPrefix: Pick<CanonicalAddress, 'prefix'> = { prefix: '/z/' };

interface RecordedPresentation {
  name: { value: string; lang: string; dir: 'ltr' | 'rtl' };
  realm: string;
  official: string | null;
  address: CanonicalAddress;
  tokens: ZoneTokens;
}

function recordedPresentation(record: AnswerRecord, persona: AnswerPersona): RecordedPresentation {
  const answer = recordedBrowseSample(record, persona, 'primary-get-zones-presentation-0').answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded presentation for ${persona} is missing`);
  const presentation = answer as {
    name?: unknown; language?: unknown; direction?: unknown; realm?: unknown; official?: unknown;
    address?: { prefix?: unknown; key?: unknown; suffixSource?: unknown };
    presentation?: { tokens?: ZoneTokens };
  };
  const address = presentation.address;
  const tokens = presentation.presentation?.tokens;
  const direction = presentation.direction === 'ltr' || presentation.direction === 'rtl' ? presentation.direction : null;
  if (typeof presentation.name !== 'string' || !direction || typeof presentation.language !== 'string'
    || typeof presentation.realm !== 'string' || !address || address.prefix !== siteAddressPrefix.prefix
    || typeof address.key !== 'string' || typeof address.suffixSource !== 'string' || !tokens?.accent) {
    throw new Error(`Recorded presentation for ${persona} cannot frame browse`);
  }
  return {
    name: { value: presentation.name, lang: presentation.language, dir: direction },
    realm: presentation.realm,
    official: typeof presentation.official === 'string' ? presentation.official : null,
    address: { prefix: siteAddressPrefix.prefix, key: address.key, suffixSource: address.suffixSource },
    tokens,
  };
}

/**
 * Zone frame for a recorded browse answer.
 * The typed client requests `GET /v1/zones/{id}/presentation` with no query.
 * This row stores the visitor read as `presentation?` and every signed-in read
 * with `actingSubject`, so those samples do not match the client. The realm
 * header is recorded only with `actingSubject`. The frame uses the presentation
 * fields the record does hold: name, realm, address and tokens.
 */
export function recordedBrowseZone(record: AnswerRecord, persona: AnswerPersona, locale: UiLocale): {
  zone: ZoneContext; ref: CanonicalAddress;
} {
  const presentation = recordedPresentation(record, persona);
  const ref = presentation.address;
  const zone: ZoneContext = {
    slug: presentation.official, realm: presentation.realm, name: presentation.name,
    description: null, icon: null, hero: null, tokens: presentation.tokens, locale,
    links: {
      home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']), discussions: realmHref(locale, ref, 'discussions'),
      decisions: realmHref(locale, ref, 'decisions'), about: realmHref(locale, ref, 'about'),
    },
  };
  return { zone, ref };
}

export interface RecordedBrowseLoad {
  sample: AnswerSample;
  page: Loaded<ZoneBrowsePage>;
  /** Null when this persona has no recorded `GET /v1/facets`. */
  facets: Loaded<FacetList> | null;
  result: Loaded<BrowseModel>;
}

/** The production browse mapping for one recorded answer. */
export async function loadRecordedBrowse(main: MainClient, record: AnswerRecord, persona: AnswerPersona,
  label: string, zone: ZoneContext, ref: CanonicalAddress, locale: UiLocale, messages: ZoneMessages): Promise<RecordedBrowseLoad> {
  const sample = recordedBrowseSample(record, persona, label);
  const request = recordedBrowseRequest(sample);
  const recordedFacets = record.personas[persona].some(item => item.label === facetLabel);
  const [page, facets] = await Promise.all([
    readBrowseAnswer(main, request.realm, request.query),
    recordedFacets ? readFacetAnswer(main) : Promise.resolve(null),
  ]);
  const result = buildBrowsePage({ page, facets: facets ?? { ok: false, failure: 'unavailable' },
    base: zone.links.browse, zoneName: zone.name.value, state: request.state,
    context: { realm: request.realm, ref: addressKey(ref), locale }, locale, messages });
  return { sample, page, facets, result };
}
