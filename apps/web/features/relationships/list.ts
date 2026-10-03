import { EntityPickerSource } from '@rezics/ui/entity-picker';
import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import { RelationshipError } from './api.ts';

/** Reuse the picker's query-generation fence, deduplication and retryable continuation for inventories. */
export function relationshipSource<T>(load: (query: { q: string; cursor: string | null }) => Promise<EntityPickerPage<T>>,
  identity: (item: T) => string, label: (item: T) => string) {
  let moved = false;
  const source = new EntityPickerSource(async query => {
    moved = false;
    try {
      const page = await load(query);
      return { ...page, items: page.items.map(item => ({ ...item, value: identity(item), label: label(item) })) };
    } catch (error) {
      moved = error instanceof RelationshipError && error.status === 409;
      throw error;
    }
  });
  const retry = source.retry;
  // Main fences cursors to the inventory revision. A moved cursor must restart instead of failing forever.
  source.retry = () => moved ? source.search(source.getSnapshot().q) : retry();
  return source;
}
