import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import {
  writeSavedQueryHandoff,
  type SavedQueryHandoff,
  type SavedQuerySelection,
} from './saved-query-editor/selection';

export type { SavedQueryHandoff, SavedQuerySelection };
export {
  createSavedQueryHandoffStore,
  takeSavedQueryHandoff,
  writeSavedQueryHandoff,
} from './saved-query-editor/selection';

/** Library view for an admitted saved-filter selection. Owner observation stays on this native command. */
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
          !writeSavedQueryHandoff({
            viewerId: owner.subject,
            filter: selection.filter,
            sort: selection.sort,
            source: selection.source,
          })
        )
          event.preventDefault();
      }}
    >
      {m.library_saved_query_create()}
    </Link>
  );
}
