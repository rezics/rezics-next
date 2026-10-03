import { registryEntries, type TypeEntry } from './types.ts';

export type BrowseCategory = NonNullable<TypeEntry['browse']> & { types: string[] };

/** Group and order Main's browse metadata; category selections retain every served type. */
export function browseCategories(
  entries: readonly TypeEntry[] = registryEntries(),
): BrowseCategory[] {
  const categories = new Map<string, BrowseCategory>();
  for (const entry of entries) {
    if (!entry.browse) continue;
    const prior = categories.get(entry.browse.id);
    if (prior) prior.types.push(entry.type);
    else categories.set(entry.browse.id, { ...entry.browse, types: [entry.type] });
  }
  return [...categories.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
