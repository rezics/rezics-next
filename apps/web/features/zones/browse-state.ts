import { isUuid, type SearchParams } from '../discover/scope.ts';

// A Zone's browse page as its URL states it, and the links that change it.
// Values within a Facet match any and Facets match all, as Main's
// `zone-browse-v1` Conditions do; the URL keeps them short and readable
// (`?loader=fabric&version=1.21.1`), and every change is a link, so each
// filtered view has its own address and works without script.

export const browseSorts = ['relevance', 'newest', 'updated'] as const;
export const MOD_ENV_COOKIE = 'rezics_mod_environment';
export type BrowseSort = (typeof browseSorts)[number];
export type BrowseView = 'list' | 'grid';

/** The browse Facets in the order a reader scans them: mod compatibility, then Tags, story facts and type. */
export const browseFacets = ['modGameVersion', 'modLoader', 'modEnvironment', 'modRequiredDependency',
  'concept', 'status', 'length',
  'type'] as const;
export type BrowseFacet = (typeof browseFacets)[number];

/** Each Facet's URL parameter; one value per repetition. */
export const facetParams: Record<BrowseFacet, string> = { modLoader: 'loader', modGameVersion: 'version',
  modEnvironment: 'env', modRequiredDependency: 'requires', concept: 'concept', status: 'status',
  length: 'length', type: 'type' };

const loaders = ['Fabric', 'Forge', 'NeoForge'] as const;
const statuses = ['ongoing', 'completed', 'hiatus'] as const;
/** Main's length bands (`zoneLengthBands`), in words or CJK characters. */
export const lengthBands = ['0-99999', '100000-299999', '300000-999999', '1000000-'] as const;
/** Namespaces a type IRI is shortened to in the URL (`schema:Book`): prefixes, not a table of type names. */
const namespaces = { schema: 'https://schema.org/', rv: 'https://rezics.com/vocab/' } as const;
const idPrefix = 'https://rezics.com/id/';
const gameVersion = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const nativeModId = /^[a-z0-9][a-z0-9_.-]{0,159}$/;
const MAX_VALUES = 8;

/** A Facet value as the URL writes it: loaders in lower case, Concepts by UUID, types as CURIEs. */
export function urlValue(facet: BrowseFacet, value: string): string {
  if (facet === 'modLoader') return value.toLowerCase();
  if (facet === 'concept') return value.startsWith(idPrefix) ? value.slice(idPrefix.length) : value;
  if (facet === 'type') {
    for (const [prefix, namespace] of Object.entries(namespaces)) {
      if (value.startsWith(namespace)) return `${prefix}:${value.slice(namespace.length)}`;
    }
  }
  return value;
}

/** The URL's value as Main's, or null when it is not one Main admits for the Facet. */
export function mainValue(facet: BrowseFacet, value: string): string | null {
  switch (facet) {
    case 'modLoader': return loaders.find(loader => loader.toLowerCase() === value.toLowerCase()) ?? null;
    case 'modGameVersion': return gameVersion.test(value) ? value : null;
    case 'modEnvironment': return value === 'client' || value === 'server' ? value : null;
    case 'modRequiredDependency': return nativeModId.test(value) ? value : null;
    case 'concept': return isUuid(value) ? `${idPrefix}${value}` : null;
    case 'status': return (statuses as readonly string[]).includes(value) ? value : null;
    case 'length': return (lengthBands as readonly string[]).includes(value) ? value : null;
    case 'type': {
      const [prefix, local] = value.split(':');
      const namespace = namespaces[prefix as keyof typeof namespaces];
      return namespace && local && /^[A-Za-z]{1,64}$/.test(local) ? `${namespace}${local}` : null;
    }
  }
}

export interface BrowseState {
  text: string | null;
  /** Null: Main's default, relevance with text and newest without. */
  sort: BrowseSort | null;
  view: BrowseView;
  /** Chosen values per Facet, in Main's form. */
  filter: Partial<Record<BrowseFacet, string[]>>;
  /** Concept values to exclude after the included Conditions. */
  excludedConcepts?: string[];
  cursor: string | null;
}

/** Only public environment choices are remembered; filters such as Concepts stay in the URL. */
export function modPreference(filter: BrowseState['filter']): string {
  const values = new URLSearchParams();
  for (const facet of ['modGameVersion', 'modLoader', 'modEnvironment'] as const) {
    for (const value of filter[facet] ?? []) values.append(facetParams[facet], urlValue(facet, value));
  }
  return encodeURIComponent(values.toString());
}

export function readModPreference(value: string | undefined): BrowseState['filter'] {
  if (!value || value.length > 512) return {};
  try {
    const params = new URLSearchParams(decodeURIComponent(value));
    const parsed = parseBrowseState({ version: params.getAll('version'), loader: params.getAll('loader'),
      env: params.getAll('env') });
    return { ...parsed.filter.modGameVersion ? { modGameVersion: parsed.filter.modGameVersion } : {},
      ...parsed.filter.modLoader ? { modLoader: parsed.filter.modLoader } : {},
      ...parsed.filter.modEnvironment ? { modEnvironment: parsed.filter.modEnvironment } : {} };
  } catch { return {}; }
}

/** An explicit environment in a link wins; otherwise the last choice fills the browse URL. */
export function withModPreference(state: BrowseState, remembered: BrowseState['filter'],
  explicit: boolean): BrowseState {
  return explicit ? state : { ...state, filter: { ...state.filter, ...remembered } };
}

const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []);

/** The URL's browse state. Unknown values are dropped: a link from an old page still opens, only wider. */
export function parseBrowseState(params: SearchParams): BrowseState {
  const text = list(params.q)[0]?.trim().slice(0, 100) || null;
  const sort = list(params.sort)[0];
  const cursor = list(params.cursor)[0];
  const filter: BrowseState['filter'] = {};
  for (const facet of browseFacets) {
    const values = [...new Set(list(params[facetParams[facet]]).flatMap(value => mainValue(facet, value) ?? []))]
      .slice(0, facet === 'length' ? 1 : MAX_VALUES);
    if (values.length) filter[facet] = values;
  }
  const excludedConcepts = [...new Set(list(params.exclude).flatMap(value => mainValue('concept', value) ?? []))]
    .slice(0, MAX_VALUES);
  return { text, sort: (browseSorts as readonly string[]).includes(sort ?? '') && (sort !== 'relevance' || text)
    ? sort as BrowseSort : null,
  view: list(params.view)[0] === 'grid' ? 'grid' : 'list', filter,
  ...excludedConcepts.length ? { excludedConcepts } : {},
  cursor: cursor && cursor.length <= 2048 ? cursor : null };
}

/** The Query Main's browse read takes for this state; `mainValue` admitted every value. */
export function mainBrowseQuery(state: BrowseState) {
  const filter = state.filter as Partial<Record<BrowseFacet, string[]>> & {
    status?: (typeof statuses)[number][]; modLoader?: (typeof loaders)[number][];
    modEnvironment?: ('client' | 'server')[] };
  return { ...state.text ? { q: state.text } : {}, ...state.sort ? { sort: state.sort } : {},
    ...state.cursor ? { cursor: state.cursor } : {},
    ...filter.type ? { type: filter.type } : {}, ...filter.concept ? { concept: filter.concept } : {},
    ...filter.status ? { status: filter.status } : {}, ...filter.length ? { length: filter.length[0] } : {},
    ...filter.modLoader ? { loader: filter.modLoader } : {},
    ...filter.modGameVersion ? { gameVersion: filter.modGameVersion } : {},
    ...filter.modEnvironment ? { environment: filter.modEnvironment } : {},
    ...filter.modRequiredDependency ? { requiredDependency: filter.modRequiredDependency } : {},
    ...state.excludedConcepts?.length ? { excludeConcept: state.excludedConcepts } : {} };
}

/** The browse page's address for a state; a new filter or sort starts from the first page. */
export function browseHref(base: string, state: Omit<BrowseState, 'cursor'> & { cursor?: string | null }): string {
  const query = new URLSearchParams();
  if (state.text) query.set('q', state.text);
  for (const facet of browseFacets) {
    for (const value of state.filter[facet] ?? []) query.append(facetParams[facet], urlValue(facet, value));
  }
  for (const value of state.excludedConcepts ?? []) query.append('exclude', urlValue('concept', value));
  if (state.sort) query.set('sort', state.sort);
  if (state.view === 'grid') query.set('view', 'grid');
  if (state.cursor) query.set('cursor', state.cursor);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

const withFilter = (state: BrowseState, facet: BrowseFacet, values: string[]): BrowseState => {
  const filter = { ...state.filter };
  if (values.length) filter[facet] = values;
  else delete filter[facet];
  return { ...state, filter, cursor: null };
};

/** The environment picker chooses one value per axis; advanced multi-value URLs still round-trip. */
export function toggled(state: BrowseState, facet: BrowseFacet, value: string): BrowseState {
  const chosen = state.filter[facet] ?? [];
  if (chosen.includes(value)) return withFilter(state, facet, chosen.filter(item => item !== value));
  return withFilter(state, facet, facet === 'length' || facet === 'modGameVersion' || facet === 'modLoader'
    || facet === 'modEnvironment'
    ? [value] : [...chosen, value].slice(0, MAX_VALUES));
}

export function toggledExcludedConcept(state: BrowseState, value: string): BrowseState {
  const chosen = state.excludedConcepts ?? [];
  return { ...state, excludedConcepts: chosen.includes(value)
    ? chosen.filter(item => item !== value) : [...chosen, value].slice(0, MAX_VALUES), cursor: null };
}

export const cleared = (state: BrowseState): BrowseState => ({ ...state, filter: {}, excludedConcepts: [], cursor: null });

/** How many Conditions the state applies, for a "Filters (2)" label. */
export const chosenCount = (state: BrowseState) =>
  browseFacets.reduce((total, facet) => total + (state.filter[facet]?.length ?? 0),
    state.excludedConcepts?.length ?? 0);

/** A home chip: the browse page filtered by one value. */
export function chipHref(base: string, facet: BrowseFacet, value: string): string {
  return browseHref(base, { text: null, sort: null, view: 'list', filter: { [facet]: [value] } });
}
