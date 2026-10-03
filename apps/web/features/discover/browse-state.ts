import type { FilterCondition } from '../../../../model/definitions/filter-document-v1.ts';
import { browseTypes, type ResourceQuery, type SectionId } from './api.ts';
import {
  idOf,
  iriOf,
  isUuid,
  parseScope,
  scopeQuery,
  single,
  withQuery,
  type BrowseScope,
  type SearchParams,
} from './scope.ts';

export const browseTabs = [
  'all',
  'works',
  'communities',
  'sites',
  'people',
  'lists',
  'topics',
] as const;
export type BrowseTab = (typeof browseTabs)[number];
export interface BrowseState {
  scope: Exclude<BrowseScope, { kind: 'mine' }>;
  tab: BrowseTab;
  q: string;
  conditions: { include: string[]; exclude: string[]; match: 'all' | 'any' };
  cursor: string | null;
  section: SectionId | null;
  personalized: boolean;
}
export const emptyBrowse: BrowseState = {
  scope: { kind: 'global' },
  tab: 'all',
  q: '',
  conditions: { include: [], exclude: [], match: 'all' },
  cursor: null,
  section: null,
  personalized: true,
};

export function parseBrowseState(params: SearchParams): BrowseState | null {
  if (
    [
      'scope',
      'realm',
      'tab',
      'type',
      'topic',
      'q',
      'ci',
      'ce',
      'cm',
      'cursor',
      'section',
      'personalization',
    ].some((key) => Array.isArray(params[key]))
  )
    return null;
  const scope = parseScope(params);
  // G-943's /r redirect spells the same structural category as `type`.
  const tab = single(params.tab) ?? single(params.type) ?? 'all',
    q = (single(params.q) ?? '').trim();
  const list = (raw: string | undefined) => (raw ? raw.split(',') : []);
  const include = list(single(params.ci)),
    exclude = list(single(params.ce));
  const topic = single(params.topic);
  if (topic !== undefined) {
    const id = idOf(topic);
    if (tab !== 'communities' || !id || include.length) return null;
    include.push(id);
  }
  const match = single(params.cm) ?? 'all';
  const cursor = single(params.cursor) ?? null,
    section = single(params.section) ?? null;
  const personalization = single(params.personalization);
  // Refuse legacy selectors rather than silently display a wider catalogue.
  if (
    (params.type !== undefined &&
      (single(params.type) !== tab || !browseTabs.some((value) => value === params.type))) ||
    params.term !== undefined ||
    params.context !== undefined ||
    !scope ||
    scope.kind === 'mine' ||
    !browseTabs.some((value) => value === tab) ||
    q.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(q) ||
    ![...include, ...exclude].every(isUuid) ||
    include.length > 8 ||
    exclude.length > 8 ||
    new Set([...include, ...exclude]).size !== include.length + exclude.length ||
    (match !== 'all' && match !== 'any') ||
    (cursor !== null && (!cursor || cursor.length > 2048)) ||
    (section !== null && !['popular', 'communities', 'sites'].includes(section)) ||
    (section !== null &&
      (tab !== 'all' || q || include.length || exclude.length || scope.kind !== 'global')) ||
    (personalization !== undefined && personalization !== 'off')
  )
    return null;
  return {
    scope,
    tab: tab as BrowseTab,
    q,
    conditions: { include, exclude, match },
    cursor,
    section: section as SectionId | null,
    personalized: personalization !== 'off',
  };
}
export function browseHref(state: BrowseState): string {
  return withQuery('/discover', {
    ...scopeQuery(state.scope),
    tab: state.tab === 'all' ? null : state.tab,
    q: state.q,
    ci: state.conditions.include.join(','),
    ce: state.conditions.exclude.join(','),
    cm: state.conditions.match === 'any' ? 'any' : null,
    section: state.section,
    cursor: state.cursor,
    personalization: state.personalized ? null : 'off',
  });
}
/** Every change of selection starts a new traversal; continuations never cross query meaning. */
export function changeBrowse(state: BrowseState, patch: Partial<BrowseState>): BrowseState {
  return { ...state, cursor: null, section: null, ...patch };
}
export function browseQuery(state: BrowseState, limit = 20): ResourceQuery {
  const all: FilterCondition[] = [];
  if (state.tab !== 'all') all.push({ facet: 'type', any: [browseTypes[state.tab]] });
  if (state.conditions.include.length)
    all.push({ facet: 'concept', [state.conditions.match]: state.conditions.include.map(iriOf) });
  if (state.conditions.exclude.length)
    all.push({ facet: 'concept', none: state.conditions.exclude.map(iriOf) });
  return {
    profile: 'resource-list-v1',
    context: state.scope.kind === 'realm' ? { realm: iriOf(state.scope.realm) } : 'global',
    scope:
      state.scope.kind === 'realm'
        ? { kind: 'realm', realm: iriOf(state.scope.realm) }
        : { kind: 'all' },
    sort: state.q ? 'relevance' : 'newest',
    limit,
    ...(state.q ? { q: state.q } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}),
    ...(all.length ? { filter: { all } } : {}),
  };
}
