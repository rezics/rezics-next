import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import { browserMainApi } from '../api/browser.ts';
import { discoveryApi, type ConceptChoice, type ListInput, type ListPage } from '../discover/api.ts';
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
  /** Indexed Concepts: followed first for an empty query, with continuation over the whole vocabulary. */
  conceptChoices?(query: ListInput, locale: string): Promise<Loaded<ListPage<ConceptChoice>>>;
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
      try {
        const page = await discoveryApi(main, locale, actingSubject).concepts({ q: phrase });
        return { ok: true, data: page.items.map(item => ({ concept: item.id, label: item.name.value,
          language: item.name.language, realm: null })) };
      } catch { return { ok: false, failure: 'unavailable' }; }
    },

    concept: (id, locale) => settle(() => main.v1.concepts({ id: id.slice(-36) }).get({ query: { language: locale } })),

    async popularConcepts(locale) {
      try { return { ok: true, data: (await discoveryApi(main, locale, actingSubject).concepts({ limit: 12 })).items }; }
      catch { return { ok: false, failure: 'unavailable' }; }
    },
    async conceptChoices(query, locale) {
      try { return { ok: true, data: await discoveryApi(main, locale, actingSubject).concepts(query) }; }
      catch { return { ok: false, failure: 'unavailable' }; }
    },
  };
}
