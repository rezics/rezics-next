import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import type { SavedFilter, SavedFilters, SavedFiltersPage } from './types.ts';

// Pure helpers for Home's pinned tabs, shared by the route, its components and tests.

/** Home shows at most eight pinned tabs after Following and All (Main's bound). */
export const MAX_PINNED = 8;

/** Pinned filters in tab order, then the rest as Main lists them. */
export function splitFilters(page: Pick<SavedFiltersPage, 'revision' | 'items'>): SavedFilters {
  const items = page.items as SavedFilter[];
  return { revision: page.revision,
    pinned: items.filter(item => item.position !== null).sort((a, b) => a.position! - b.position!),
    unpinned: items.filter(item => item.position === null) };
}

/**
 * What a tab reads as: the reader's name for it, else the followed Concept's
 * own label (docs/contracts/queries.md: every displayed name belongs to something).
 */
export function filterTitle(filter: Pick<SavedFilter, 'name' | 'concept'>): { value: string; language?: string } | null {
  if (filter.name) return { value: filter.name };
  return filter.concept?.name ? { value: filter.concept.name.value, language: filter.concept.name.language } : null;
}

/** The order after moving one tab by `offset` places, clamped to the ends. */
export function moved(order: readonly string[], id: string, offset: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = Math.min(order.length - 1, Math.max(0, from + offset));
  const next = order.filter(item => item !== id);
  next.splice(to, 0, id);
  return next;
}

/** The order after dropping `id` where `target` is. */
export function droppedOn(order: readonly string[], id: string, target: string): string[] {
  return moved(order, id, order.indexOf(target) - order.indexOf(id));
}

/**
 * Home's current Filters as a FilterDocument: any of the chosen content
 * languages, from any of the chosen communities. Null when none are active.
 * Main admits it and keeps the exact Facet versions.
 */
export function currentFiltersDocument(input: { languages: readonly string[]; realms: readonly string[] }):
  FilterDocument | null {
  const conditions = [
    ...input.languages.length ? [{ facet: 'language', any: [...input.languages] }] : [],
    ...input.realms.length ? [{ facet: 'realm', any: [...input.realms] }] : [],
  ];
  return conditions.length ? { all: conditions } : null;
}

/** A name to start from for saved Filters: their values' own names, as the chips read. */
export function currentFiltersName(labels: readonly string[], limit = 80): string {
  const name = labels.join(' · ');
  return name.length <= limit ? name : `${name.slice(0, limit - 1).trimEnd()}…`;
}
