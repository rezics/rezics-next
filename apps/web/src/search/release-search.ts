import {
  admitFilter,
  admittedReleaseSearchControls,
  admittedReleaseSearchTypes,
  buildReleaseSearchFilter,
  calendarRangeBounds,
  parseFilter,
  type FilterDocument,
  type FilterRelease,
  type ReleaseSearchControls,
  type ReleaseSearchCriteria,
} from '@rezics/filter';

export type ReleaseSearchRequest = {
  representation: 'release-groups-v1';
  text?: string;
  filter: FilterDocument;
  sort: 'name' | 'relevance';
  languages: string[];
  spoilerThreshold: 0 | 1 | 2;
  descriptions: true;
  limit: number;
  cursor?: string;
  properties?: string[];
  work?: string;
  childCursor?: string;
};

export type ReleaseSearchForm = {
  subtype: string;
  q: string;
  platform: string;
  releaseLanguage: string;
  gte: string;
  lte: string;
  ageGte: string;
  ageLte: string;
  ageUnit: string;
  developer: string;
  publisher: string;
  language: string;
  sort: string;
  threshold: string;
  condition: string;
};

export type ReleaseSearchSubjectSelection = { id: string; label?: string; type?: string };
export type ReleaseSearchSelections = Partial<
  Record<'platform' | 'developer' | 'publisher', ReleaseSearchSubjectSelection>
>;

export type ReleaseSearchCriteriaControls = Pick<
  ReleaseSearchControls,
  'platform' | 'language' | 'date' | 'ageRating' | 'producers'
>;
export type ReleaseSearchType = {
  id: string;
  label: string;
  controls: ReleaseSearchCriteriaControls;
};

export type ReleaseSearch = {
  subtype: string;
  text: string;
  criteria: ReleaseSearchCriteria;
  languages: string[];
  sort: 'name' | 'relevance';
  threshold: 0 | 1 | 2;
  condition?: FilterDocument;
  cursor?: string;
};

export type ParsedReleaseSearch = {
  form: ReleaseSearchForm;
  search: ReleaseSearch;
  controls: ReleaseSearchCriteriaControls | null;
  /** Invalid input stays in the form and never reaches Search. */
  invalid: (keyof ReleaseSearchForm | 'cursor')[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const language = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const keys = [
  'subtype',
  'q',
  'platform',
  'releaseLanguage',
  'gte',
  'lte',
  'ageGte',
  'ageLte',
  'ageUnit',
  'developer',
  'publisher',
  'language',
  'sort',
  'threshold',
  'condition',
] as const;

function tags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim());
}

function validTags(values: string[]): boolean {
  return (
    values.length > 0 &&
    values.length <= 8 &&
    new Set(values).size === values.length &&
    values.every((tag) => tag.length <= 35 && language.test(tag))
  );
}

/** Parse against the released roster; never substitute another subtype for a withdrawn operand. */
export function parseReleaseSearch(
  raw: Record<string, unknown>,
  release: FilterRelease,
  locale: string,
): ParsedReleaseSearch {
  return parseReleaseSearchInputs(
    raw,
    locale,
    (type) => admittedReleaseSearchControls(release, type),
    admittedReleaseSearchTypes(release)[0] ?? '',
    release,
  );
}

/** Re-evaluate an in-page criteria draft against the controls admitted by the current release read. */
export function parseReleaseSearchDraft(
  raw: Record<string, unknown>,
  types: readonly { id: string; controls: ReleaseSearchCriteriaControls }[],
  locale: string,
): ParsedReleaseSearch {
  const controls = new Map(types.map(({ id, controls: admitted }) => [id, admitted]));
  return parseReleaseSearchInputs(raw, locale, (type) => controls.get(type) ?? null, types[0]?.id ?? '');
}

function parseReleaseSearchInputs(
  raw: Record<string, unknown>,
  locale: string,
  controlsFor: (type: string) => ReleaseSearchCriteriaControls | null,
  firstType: string,
  release?: FilterRelease,
): ParsedReleaseSearch {
  const invalid: ParsedReleaseSearch['invalid'] = [];
  const fail = (key: ParsedReleaseSearch['invalid'][number]) => {
    if (!invalid.includes(key)) invalid.push(key);
  };
  const form = Object.fromEntries(
    keys.map((key) => {
      const value = raw[key];
      if (value === undefined) return [key, ''];
      if ((key === 'language' || key === 'releaseLanguage') && Array.isArray(value)) {
        if (value.some((tag) => typeof tag !== 'string')) fail(key);
        return [key, value.map(String).join(', ')];
      }
      // TanStack decodes JSON search values before validateSearch. Preserve that
      // decoded condition tree instead of treating a reload as a predicate edit.
      if (key === 'condition' && value !== null && typeof value === 'object') return [key, JSON.stringify(value)];
      if (key === 'q' && typeof value === 'boolean') return [key, String(value)];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        ['q', 'gte', 'lte', 'ageGte', 'ageLte', 'ageUnit', 'threshold'].includes(key)
      )
        return [key, String(value)];
      if (typeof value !== 'string') fail(key);
      return [key, typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))];
    }),
  ) as ReleaseSearchForm;
  if (raw.subtype === undefined) form.subtype = firstType;
  if (raw.language === undefined) form.language = [...new Set([locale, 'en'])].join(', ');
  if (raw.sort === undefined) form.sort = 'name';
  if (raw.threshold === undefined) form.threshold = '0';
  const controls = controlsFor(form.subtype);
  if (!controls) fail('subtype');
  if (new TextEncoder().encode(form.q).length > 512) fail('q');
  const languages = tags(form.language);
  if (!validTags(languages)) fail('language');
  const releaseLanguages = tags(form.releaseLanguage);
  if (form.releaseLanguage && !validTags(releaseLanguages)) fail('releaseLanguage');
  if (!['name', 'relevance'].includes(form.sort) || (form.sort === 'relevance' && !form.q.trim())) fail('sort');
  if (!['0', '1', '2'].includes(form.threshold)) fail('threshold');

  const criteria: ReleaseSearchCriteria = {};
  if (form.platform) {
    if (!controls?.platform || !uuid.test(form.platform)) fail('platform');
    else criteria.platform = form.platform.toLowerCase();
  }
  if (form.releaseLanguage) {
    if (form.platform ? !controls?.platform?.languageQualifier : !controls?.language) fail('releaseLanguage');
    else criteria.languages = releaseLanguages;
  }
  if (form.gte || form.lte) {
    const date = {
      type: 'time' as const,
      ...(form.gte ? { gte: form.gte } : {}),
      ...(form.lte ? { lte: form.lte } : {}),
    };
    if (!controls?.date || !calendarRangeBounds(date)) {
      if (form.gte) fail('gte');
      if (form.lte) fail('lte');
    } else criteria.date = date;
  }
  if (form.ageGte || form.ageLte || form.ageUnit) {
    // Empty endpoints never become zero; scientific notation and whitespace are not form numbers.
    const number = (value: string) =>
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && Number.isFinite(Number(value));
    if (form.ageGte && !number(form.ageGte)) fail('ageGte');
    if (form.ageLte && !number(form.ageLte)) fail('ageLte');
    if (!controls?.ageRating?.units.includes(form.ageUnit) || (!form.ageGte && !form.ageLte)) fail('ageUnit');
    if (form.ageGte && form.ageLte && Number(form.ageGte) > Number(form.ageLte)) fail('ageLte');
    criteria.ageRating = {
      ...(form.ageGte ? { gte: Number(form.ageGte) } : {}),
      ...(form.ageLte ? { lte: Number(form.ageLte) } : {}),
      unit: form.ageUnit,
    };
  }
  for (const role of ['developer', 'publisher'] as const) {
    if (!form[role]) continue;
    if (!controls?.producers.some((producer) => producer.role === role) || !uuid.test(form[role])) fail(role);
    else criteria[role] = form[role].toLowerCase();
  }
  let condition: FilterDocument | undefined;
  if (form.condition) {
    try {
      condition = parseFilter(JSON.parse(form.condition));
    } catch {
      fail('condition');
    }
  }
  const cursor = raw.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4864))
    fail('cursor');
  const search: ReleaseSearch = {
    subtype: form.subtype,
    text: form.q,
    criteria,
    languages,
    sort: form.sort === 'relevance' ? 'relevance' : 'name',
    threshold: form.threshold === '1' ? 1 : form.threshold === '2' ? 2 : 0,
    ...(condition ? { condition } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
  if (!invalid.length && release) {
    try {
      releaseSearchRequest(search, release);
    } catch {
      fail('condition');
    }
  }
  return { form, search, controls, invalid };
}

/** One grouped request. Display languages never become release-language operands. */
export function releaseSearchRequest(search: ReleaseSearch, release: FilterRelease): ReleaseSearchRequest {
  const operands = buildReleaseSearchFilter(release, search.subtype, search.criteria);
  const filter = admitFilter(search.condition ? { and: [operands, search.condition] } : operands, release);
  const controls = admittedReleaseSearchControls(release, search.subtype)!;
  const properties = [
    ...(controls.date ? [controls.date.property] : []),
    ...(controls.platform ? [controls.platform.property] : []),
    ...controls.producers.map((producer) => producer.property),
  ].slice(0, 4);
  return {
    representation: 'release-groups-v1',
    filter,
    sort: search.sort,
    languages: search.languages,
    spoilerThreshold: search.threshold,
    descriptions: true,
    limit: 20,
    ...(properties.length ? { properties } : {}),
    ...(search.text.trim() ? { text: search.text } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
  };
}

/** Result continuations are explicit; applying form edits always starts a new traversal. */
export function releaseSearchHref(locale: string, form: ReleaseSearchForm, cursor?: string): string {
  const params = new URLSearchParams();
  for (const key of keys) if (form[key]) params.set(key, form[key]);
  if (cursor) params.set('cursor', cursor);
  return `/${encodeURIComponent(locale)}/search/releases?${params}`;
}
