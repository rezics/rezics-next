import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import { storyId } from '../feed/fixtures.ts';
import type { SavedFilterApi } from './api.ts';
import { MAX_PINNED, splitFilters } from './tabs.ts';
import type { CommandFailure, ConceptDetail, SavedFilter, SavedFilters } from './types.ts';

// Story data for Saved Filters: a reader's pinned topics and filter, and an
// in-memory Main that keeps Main's rules (eight tabs, contiguous positions, a
// followed Concept's filter going with its follow).

const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conceptFacet = 'https://rezics.com/definition/facet-concept-v1';
const languageFacet = 'https://rezics.com/definition/facet-language-v1';

export const topics = {
  fiction: { id: storyId(310, 'eeee'), name: name('Fiction') },
  fantasy: { id: storyId(311, 'eeee'), name: name('Fantasy') },
  xianxia: { id: storyId(312, 'eeee'), name: name('仙侠', 'zh-Hans') },
  mystery: { id: storyId(313, 'eeee'), name: name('Mystery') },
  cozy: { id: storyId(314, 'eeee'), name: name('Cozy games') },
};
type Topic = (typeof topics)[keyof typeof topics];

const conceptFilter = (topic: Topic, id: number, position: number | null): SavedFilter => ({ id: uuid(id), name: null,
  profile: 'filter-document-v2', concept: { id: topic.id, name: topic.name }, filter: { all: [{ facet: conceptFacet, any: [topic.id] }] },
  facets: [conceptFacet], context: 'global', position, home: 'available', revision: uuid(100 + id) });

export const englishJapanese: SavedFilter = { id: uuid(3), name: 'English & Japanese', profile: 'filter-document-v2',
  concept: null,
  filter: { all: [{ facet: languageFacet, any: ['en', 'ja'] }] }, facets: [languageFacet], context: 'global',
  position: 1, home: 'available', revision: uuid(103) };

export const readerFilters: SavedFilters = { revision: uuid(90), pinned: [conceptFilter(topics.fantasy, 1, 0),
  englishJapanese, conceptFilter(topics.xianxia, 2, 2)], unpinned: [conceptFilter(topics.mystery, 4, null)] };

export const noFilters: SavedFilters = { revision: null, pinned: [], unpinned: [] };

const details: Record<string, { broader: Topic[]; narrower: Topic[] }> = {
  [topics.fiction.id]: { broader: [], narrower: [topics.fantasy, topics.mystery] },
  [topics.fantasy.id]: { broader: [topics.fiction], narrower: [topics.xianxia] },
  [topics.xianxia.id]: { broader: [topics.fantasy], narrower: [] },
  [topics.mystery.id]: { broader: [topics.fiction], narrower: [] },
  [topics.cozy.id]: { broader: [], narrower: [] },
};

export type MemorySavedFilters = SavedFilterApi & { calls: string[] };

/** An in-memory Main for Saved Filters; `refuse` makes every command fail with that reason. */
export function memorySavedFilters(initial: SavedFilters = readerFilters, options: { refuse?: CommandFailure } = {}):
  MemorySavedFilters {
  let items = [...initial.pinned, ...initial.unpinned].map(item => ({ ...item }));
  let revision = initial.revision ?? uuid(90);
  let next = 500;
  const calls: string[] = [];
  const bump = () => { revision = uuid(next++); };
  const pinnedCount = () => items.filter(item => item.position !== null).length;
  const compact = () => {
    items.filter(item => item.position !== null).sort((a, b) => a.position! - b.position!)
      .forEach((item, index) => { item.position = index; });
  };
  const receipt = (action: 'created' | 'updated' | 'reordered' | 'deleted', id: string | null) =>
    ({ ok: true as const, data: { profile: 'saved-filter-receipt-v1' as const, action, id,
      filterRevision: id ? items.find(item => item.id === id)?.revision ?? null : null, revision, replayed: false } });
  const refused = () => options.refuse ? { ok: false as const, failure: options.refuse } : null;
  return {
    calls,
    async list() {
      calls.push('list');
      return { ok: true, data: { profile: 'saved-filters-v1', revision, items: items.map(item => ({ ...item })),
        complete: true } };
    },
    async create(input) {
      calls.push(`create:${input.name}`);
      if (refused()) return refused()!;
      if (input.pinned && pinnedCount() >= MAX_PINNED) return { ok: false, failure: 'full' };
      const id = uuid(next++);
      items.push({ id, name: input.name, profile: 'filter-document-v2', concept: null,
        filter: input.filter as FilterDocument, facets: [languageFacet],
        context: 'global', position: input.pinned ? pinnedCount() : null, home: 'available', revision: uuid(next++) });
      bump();
      return receipt('created', id);
    },
    async update(filter, change) {
      calls.push(`update:${filter.id.slice(-2)}:${JSON.stringify(change)}`);
      if (refused()) return refused()!;
      const item = items.find(candidate => candidate.id === filter.id);
      if (!item || item.revision !== filter.revision) return { ok: false, failure: 'stale' };
      if (change.pinned === true && item.position === null) {
        if (pinnedCount() >= MAX_PINNED) return { ok: false, failure: 'full' };
        item.position = pinnedCount();
      }
      if (change.pinned === false) { item.position = null; compact(); }
      if (change.name !== undefined) item.name = change.name;
      item.revision = uuid(next++);
      bump();
      return receipt('updated', item.id);
    },
    async reorder(pinned, expected) {
      calls.push(`reorder:${pinned.map(id => id.slice(-2)).join(',')}`);
      if (refused()) return refused()!;
      if (expected !== revision) return { ok: false, failure: 'stale' };
      pinned.forEach((id, index) => { items.find(item => item.id === id)!.position = index; });
      bump();
      return receipt('reordered', null);
    },
    async remove(filter) {
      calls.push(`remove:${filter.id.slice(-2)}`);
      if (refused()) return refused()!;
      if (filter.concept) return { ok: false, failure: 'followed' };
      items = items.filter(item => item.id !== filter.id);
      compact(); bump();
      return receipt('deleted', filter.id);
    },
    async followConcept(concept, following) {
      calls.push(`follow:${concept.slice(-12)}:${following}`);
      if (refused()) return refused()!;
      if (!following) { items = items.filter(item => item.concept?.id !== concept); compact(); bump(); }
      else if (!items.some(item => item.concept?.id === concept)) {
        const topic = Object.values(topics).find(item => item.id === concept);
        items.push({ ...conceptFilter(topic ?? { id: concept, name: name('Topic') }, next++,
          pinnedCount() < MAX_PINNED ? pinnedCount() : null) });
        bump();
      }
      return { ok: true, data: null };
    },
    async searchConcepts(phrase) {
      calls.push(`search:${phrase}`);
      const found = Object.values(topics).filter(topic => topic.name.value.toLowerCase().includes(phrase.toLowerCase()));
      return { ok: true, data: found.map(topic => ({ concept: topic.id, label: topic.name.value,
        language: topic.name.language, realm: null })) };
    },
    async concept(id) {
      const topic = Object.values(topics).find(item => item.id === id);
      if (!topic) return { ok: false, failure: 'missing' };
      const links = (list: Topic[]) => list.map(item => ({ id: item.id, name: item.name }));
      return { ok: true, data: { profile: 'concept-v1', id, name: topic.name, description: null, realm: null,
        facet: conceptFacet, interpretations: [], broader: links(details[id]!.broader),
        narrower: links(details[id]!.narrower), moreNarrower: false, filter: { all: [{ facet: conceptFacet, any: [id] }] },
        sourcePosition: { dataEpoch: 'story', sequence: '1' } } as ConceptDetail };
    },
    async popularConcepts() {
      return { ok: true, data: [topics.fantasy, topics.mystery, topics.cozy] };
    },
  };
}

/** The reader's filters as Home's route splits them, from the in-memory Main's list. */
export async function listed(api: MemorySavedFilters): Promise<SavedFilters> {
  const read = await api.list('en');
  if (!read.ok) throw new Error('memory list failed');
  return splitFilters(read.data);
}
