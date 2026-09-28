import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import { browserMainApi } from '../api/browser.ts';
import { type Loaded, type MainClient, settle } from '../feed/types.ts';
import type { CommandFailure, CommandResult, ConceptDetail, ConceptSearchItem, SavedFilter, SavedFilterReceipt,
  SavedFiltersPage } from './types.ts';

// The browser side of Saved Filters: every command acts as the session's
// Agent and carries its own idempotency key; the BFF adds the bearer token.
// Home's tabs and picker take a `SavedFilterApi`, so stories run against an
// in-memory Main.

export interface SavedFilterApi {
  list(locale: string): Promise<Loaded<SavedFiltersPage>>;
  create(input: { name: string; filter: FilterDocument; pinned: boolean }): Promise<CommandResult<SavedFilterReceipt>>;
  /** Rename (null restores a followed Concept's own label), pin or unpin one filter. */
  update(filter: SavedFilter, change: { name?: string | null; pinned?: boolean }):
    Promise<CommandResult<SavedFilterReceipt>>;
  /** The pinned tabs in their new order, under the list revision the reader saw. */
  reorder(pinned: readonly string[], revision: string): Promise<CommandResult<SavedFilterReceipt>>;
  remove(filter: SavedFilter): Promise<CommandResult<SavedFilterReceipt>>;
  /** Follows or unfollows a Concept; following pins its one-Condition filter while a tab is free. */
  followConcept(concept: string, following: boolean): Promise<CommandResult<unknown>>;
  searchConcepts(phrase: string, locale: string): Promise<Loaded<ConceptSearchItem[]>>;
  concept(id: string, locale: string): Promise<Loaded<ConceptDetail>>;
  /** Topics public Works carry most, as onboarding offers them, to start from before searching. */
  popularConcepts(locale: string): Promise<Loaded<{ id: string; name: { value: string; language: string } }[]>>;
}

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

/** A command's refusal in the reader's terms, from Main's status and problem code. */
export function commandFailure(status: number, code: unknown): CommandFailure {
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return code === 'home_tabs_full' ? 'full' : code === 'saved_filter_followed' ? 'followed' : 'stale';
  if (status === 422) return 'unsupported';
  return 'unavailable';
}

async function command<T>(call: () => Promise<Answer<T>>): Promise<CommandResult<T>> {
  try {
    const { data, error } = await call();
    if (error) {
      const code = error.value && typeof error.value === 'object' && 'code' in error.value ? error.value.code : null;
      return { ok: false, failure: commandFailure(error.status, code) };
    }
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

export function mainSavedFilterApi(actingSubject: string, main: MainClient = browserMainApi()): SavedFilterApi {
  const headers = () => ({ headers: { 'idempotency-key': crypto.randomUUID() } });
  const filters = main.v1.me['saved-filters'];
  return {
    list: locale => settle(() => filters.get({ query: { actingSubject, language: locale } })),

    create: input => command(() => filters.post({ profile: 'saved-filter-create-v1', actingSubject,
      context: 'global', ...input }, headers())),

    update: (filter, change) => command(() => filters({ id: filter.id }).patch({ profile: 'saved-filter-update-v1',
      actingSubject, expectedRevision: filter.revision, ...change }, headers())),

    reorder: (pinned, revision) => command(() => filters.order.put({ profile: 'saved-filter-order-v1', actingSubject,
      expectedRevision: revision, pinned: [...pinned] }, headers())),

    remove: filter => command(() => filters({ id: filter.id }).delete(undefined, {
      query: { actingSubject, expectedRevision: filter.revision }, ...headers() })),

    async followConcept(concept, following) {
      const state = await settle(() => main.v1.follows({ id: concept.slice(-36) })
        .get({ query: { kind: 'concept', actingSubject } }));
      if (!state.ok) return { ok: false, failure: state.failure === 'sign-in' ? 'sign-in' : 'unavailable' };
      if (state.data.following === following) return { ok: true, data: null };
      return command(() => main.v1.follows.post({ profile: 'follow-command-v1', target: concept, kind: 'concept',
        actingSubject, following, expectedRevision: state.data.revision }, headers()));
    },

    async searchConcepts(phrase, locale) {
      // The reader's language first, then English, as the Condition bar searches.
      const languages = locale === 'en' ? ['en'] : [locale, 'en'];
      const reads = await Promise.all(languages.map(language => settle(() => main.v1.concepts.get({ query: {
        q: phrase, language, limit: 8 } }))));
      const found = reads.flatMap(read => read.ok ? read.data.items : []);
      if (!found.length && reads.every(read => !read.ok)) return reads[0] as Loaded<never>;
      return { ok: true, data: [...new Map(found.filter(item => !item.realm).map(item => [item.concept, item] as const))
        .values()] };
    },

    concept: (id, locale) => settle(() => main.v1.concepts({ id: id.slice(-36) }).get({ query: { language: locale } })),

    async popularConcepts(locale) {
      const read = await settle(() => main.v1.onboarding.choices.get({ query: { locale } }));
      if (!read.ok) return read;
      const concepts = read.data.groups.flatMap(group => group.concepts.map(concept => ({ id: concept.id,
        name: concept.name })));
      return { ok: true, data: [...new Map(concepts.map(concept => [concept.id, concept] as const)).values()].slice(0, 12) };
    },
  };
}
