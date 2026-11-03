import { FILTER_LIMITS } from '@rezics/filter';
import type { DiscoveryRequest, DiscoveryState } from './discovery';

export type CharacterPersonMode = 'characters' | 'people';
export type CharacterPersonSort = 'name' | 'relevance';
export type CharacterPersonSearch = {
  mode: CharacterPersonMode;
  name: string;
  works: string[];
  role?: string;
  languages: string[];
  threshold: 0 | 1 | 2;
  sort: CharacterPersonSort;
  cursor?: string;
};
export type CharacterPersonForm = {
  mode: string;
  name: string;
  works: string;
  role: string;
  languages: string;
  threshold: string;
  sort: string;
};
export type ParsedCharacterPersonSearch = {
  search: CharacterPersonSearch;
  form: CharacterPersonForm;
  error?: 'invalid_input' | 'role_requires_work';
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const language = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function values(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function localeLanguages(locale: string): string[] {
  return [...new Set([locale, 'en'])].slice(0, 8);
}

/** Keep malformed URL values in the form so the user can repair the request in place. */
export function parseCharacterPersonSearch(raw: Record<string, unknown>, locale: string): ParsedCharacterPersonSearch {
  const rawMode = stringValue(raw.mode) ?? 'characters';
  const rawName = stringValue(raw.name) ?? '';
  const rawRole = stringValue(raw.role) ?? '';
  const rawThreshold = raw.threshold === undefined ? '0' : String(raw.threshold);
  const rawSort = stringValue(raw.sort) ?? 'name';
  const rawWorks = values(raw.work)
    .flatMap((item) => (typeof item === 'string' ? item.split(/\r?\n/) : [item]))
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
  const rawLanguages = values(raw.language).flatMap((item) =>
    typeof item === 'string'
      ? item
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [item],
  );
  const rawCursor = stringValue(raw.cursor);
  const form: CharacterPersonForm = {
    mode: rawMode,
    name: rawName,
    works: rawWorks.map(String).join('\n'),
    role: rawRole,
    languages: rawLanguages.length ? rawLanguages.map(String).join(', ') : localeLanguages(locale).join(', '),
    threshold: rawThreshold,
    sort: rawSort,
  };

  let error: ParsedCharacterPersonSearch['error'];
  if (
    (raw.mode !== undefined && typeof raw.mode !== 'string') ||
    !['characters', 'people'].includes(rawMode) ||
    (raw.name !== undefined && typeof raw.name !== 'string') ||
    new TextEncoder().encode(rawName).length > 512 ||
    rawWorks.length > FILTER_LIMITS.in ||
    rawWorks.some((item) => typeof item !== 'string' || !uuid.test(item)) ||
    new Set(rawWorks).size !== rawWorks.length ||
    (raw.role !== undefined && typeof raw.role !== 'string') ||
    (rawRole !== '' && !uuid.test(rawRole)) ||
    (raw.language !== undefined &&
      (rawLanguages.length < 1 ||
        rawLanguages.length > 8 ||
        rawLanguages.some((tag) => typeof tag !== 'string' || tag.length > 35 || !language.test(tag)) ||
        new Set(rawLanguages).size !== rawLanguages.length)) ||
    (raw.threshold !== undefined && typeof raw.threshold !== 'string' && typeof raw.threshold !== 'number') ||
    !['0', '1', '2'].includes(rawThreshold) ||
    (raw.sort !== undefined && typeof raw.sort !== 'string') ||
    !['name', 'relevance'].includes(rawSort) ||
    (rawSort === 'relevance' && rawName.trim() === '') ||
    (raw.cursor !== undefined && (rawCursor === undefined || rawCursor.length === 0 || rawCursor.length > 4864))
  )
    error = 'invalid_input';
  else if (rawRole && rawWorks.length === 0) error = 'role_requires_work';

  const mode: CharacterPersonMode = rawMode === 'people' ? 'people' : 'characters';
  const works = rawWorks.filter((item): item is string => typeof item === 'string' && uuid.test(item));
  const languages = rawLanguages.length
    ? rawLanguages.filter((tag): tag is string => typeof tag === 'string' && language.test(tag))
    : localeLanguages(locale);
  const threshold = rawThreshold === '1' ? 1 : rawThreshold === '2' ? 2 : 0;
  const sort: CharacterPersonSort = rawSort === 'relevance' ? 'relevance' : 'name';
  return {
    search: {
      mode,
      name: rawName,
      works,
      ...(uuid.test(rawRole) ? { role: rawRole.toLowerCase() } : {}),
      languages,
      threshold,
      sort,
      ...(rawCursor ? { cursor: rawCursor } : {}),
    },
    form,
    ...(error ? { error } : {}),
  };
}

/** Build one admitted universal Search request; inverse evidence stays on the native statement. */
export function characterPersonRequest(search: CharacterPersonSearch): DiscoveryRequest {
  const conditions: unknown[] = [{ type: { in: [search.mode === 'people' ? 'schema:Person' : 'schema:Character'] } }];
  if (search.works.length) {
    const qualifiers = search.role ? [{ property: 'wdt:P3831', in: [search.role] }] : undefined;
    conditions.push({
      statement: {
        property: search.mode === 'people' ? 'wdt:P725' : 'wdt:P453',
        inverse: true,
        in: search.works,
        ...(qualifiers ? { qualifiers } : {}),
      },
    });
  }
  return {
    representation: 'discovery-v1',
    limit: 20,
    descriptions: true,
    languages: search.languages,
    spoilerThreshold: search.threshold,
    sort: search.sort,
    kindPage: { limit: 8 },
    filter: { and: conditions },
    ...(search.name.trim() ? { text: search.name } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
  };
}

/** Query identity prevents a prior request, principal, or locale from supplying visible rows. */
export function characterPersonQueryKey(locale: string, principal: string, search: CharacterPersonSearch) {
  return ['character-person-search', locale, principal, characterPersonRequest(search)] as const;
}

/** Empty the result region while a replacement is in flight; a server restart is shown as repairable state. */
export function characterPersonVisibleState(
  parsed: ParsedCharacterPersonSearch,
  fetching: boolean,
  data: { discovery: DiscoveryState; restarted: boolean } | undefined,
): DiscoveryState {
  if (parsed.error) return { status: 'invalid' };
  if (fetching || !data) return { status: 'loading' };
  return data.discovery;
}

export function characterPersonHref(locale: string, search: CharacterPersonSearch, cursor?: string): string {
  const params = new URLSearchParams();
  params.set('mode', search.mode);
  if (search.name) params.set('name', search.name);
  for (const work of search.works) params.append('work', work);
  if (search.role) params.set('role', search.role);
  for (const tag of search.languages) params.append('language', tag);
  params.set('threshold', String(search.threshold));
  params.set('sort', search.sort);
  if (cursor) params.set('cursor', cursor);
  return `/${encodeURIComponent(locale)}/search/characters?${params.toString()}`;
}
