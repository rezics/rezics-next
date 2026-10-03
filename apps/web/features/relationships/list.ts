import { EntityPickerSource } from '@rezics/ui/entity-picker';
import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import { RelationshipError } from './api.ts';

/** Reuse the picker's query-generation fence, deduplication and retryable continuation for inventories. */
export function relationshipSource<T>(
  load: (query: { q: string; cursor: string | null }) => Promise<EntityPickerPage<T>>,
  identity: (item: T) => string,
  label: (item: T) => string,
) {
  let moved = false;
  const source = new EntityPickerSource(async (query) => {
    moved = false;
    try {
      const page = await load(query);
      return {
        ...page,
        items: page.items.map((item) => ({ ...item, value: identity(item), label: label(item) })),
      };
    } catch (error) {
      moved = error instanceof RelationshipError && error.status === 409;
      throw error;
    }
  });
  const retry = source.retry;
  // Main fences cursors to the inventory revision. A moved cursor must restart instead of failing forever.
  source.retry = () => (moved ? source.search(source.getSnapshot().q) : retry());
  return source;
}

/** A lazy drawer may mount after its server snapshot's last relationship change. */
export function relationshipNavigationSource<T>(
  initial: EntityPickerPage<T> | null,
  load: ((q: string, cursor: string | null) => Promise<EntityPickerPage<T>>) | undefined,
  identity: (item: T) => string,
  label: (item: T) => string,
) {
  return relationshipSource(
    async (query) => {
      // A live owner read is authoritative on every mount, including a phone
      // drawer opened after Follow, Pin or Unfollow while it was unmounted.
      if (load) return load(query.q, query.cursor);
      if (!initial) throw new Error('Relationship read unavailable');
      return {
        items: initial.items.filter((item) =>
          label(item).toLocaleLowerCase().includes(query.q.toLocaleLowerCase()),
        ),
        nextCursor: null,
        complete: true,
      };
    },
    identity,
    label,
  );
}
