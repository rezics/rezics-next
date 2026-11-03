import { Link } from '@tanstack/react-router';
import { parseFilter, type FilterDocument } from '@rezics/filter';
import { m } from '../paraglide/messages.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import type { SavedQuerySelection } from './saved-query-editor/selection';

export type SavedQueryHandoff = {
  viewerId: string;
  filter: FilterDocument;
  sort: 'id';
};

/** A one-use, in-memory handoff. It has no server or browser-storage instance. */
export function createSavedQueryHandoffStore() {
  let pending: SavedQueryHandoff | null = null;
  return {
    write(value: SavedQueryHandoff): boolean {
      if (!value.viewerId || value.sort !== 'id') return false;
      try {
        pending = { viewerId: value.viewerId, filter: parseFilter(value.filter), sort: 'id' };
        return true;
      } catch {
        pending = null;
        return false;
      }
    },
    take(viewerId: string | null): SavedQueryHandoff | null {
      const value = pending;
      pending = null;
      return value && viewerId && value.viewerId === viewerId ? value : null;
    },
    clear() {
      pending = null;
    },
  };
}

const browserHandoff = typeof window === 'undefined' ? null : createSavedQueryHandoffStore();

export function writeSavedQueryHandoff(value: SavedQueryHandoff): boolean {
  return browserHandoff?.write(value) ?? false;
}

/** Consume even on a viewer mismatch so a replacement session can never inherit the query. */
export function takeSavedQueryHandoff(viewerId: string | null): SavedQueryHandoff | null {
  return browserHandoff?.take(viewerId) ?? null;
}

export function SaveQueryLink({ id, selection }: { id: string; selection: SavedQuerySelection }) {
  const owner = useCollectionOwnerCurrent(JSON.stringify(['saved-query-source', id]));
  if (selection.state === 'empty') return null;
  if (selection.state === 'invalid') {
    const stateFilter = selection.issues.some((issue) => issue.key === 'state');
    return (
      <div role="status">
        <p>{m.library_saved_query_invalid()}</p>
        {stateFilter ? <p>{m.library_saved_query_state()}</p> : null}
      </div>
    );
  }

  return (
    <Link
      to="/library/rules/new"
      className="inline-flex min-h-11 items-center rounded-lg border border-border px-4"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        if (
          !owner.subject ||
          !owner.isOwnerCurrent() ||
          !writeSavedQueryHandoff({ viewerId: owner.subject, filter: selection.filter, sort: selection.sort })
        )
          event.preventDefault();
      }}
    >
      {m.library_saved_query_create()}
    </Link>
  );
}
