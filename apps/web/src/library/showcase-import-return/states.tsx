import { m } from '../../paraglide/messages.js';
import type { ImportLibraryFailure, ImportLibrarySnapshot } from './browser';

export function importLibraryFailureText(result: ImportLibraryFailure): string {
  switch (result.state) {
    case 'closed':
      return m.platform_closed_message();
    case 'denied':
      return m.library_bangumi_denied();
    case 'signed-out':
      return m.library_sign_in();
    case 'expired':
      return m.library_vndb_browse_expired();
    case 'unavailable':
      return m.library_bangumi_unavailable();
  }
}

/** A failed next request says nothing about completeness or membership of an independently read page. */
export function ImportLibraryReadState({
  snapshot,
  available,
  returned,
}: {
  snapshot: ImportLibrarySnapshot;
  available: boolean;
  returned: boolean;
}) {
  const { visible, pending, failed } = snapshot;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2 text-sm" data-vndb-browse-status>
      {!available ? <p>{m.library_vndb_browse_not_admitted()}</p> : null}
      {returned && !visible && !pending && !failed ? <p>{m.library_vndb_browse_lost_visit()}</p> : null}
      {available && !returned && !visible && !pending && !failed ? <p>{m.library_vndb_browse_ready()}</p> : null}
      {pending ? (
        <>
          <p>
            {pending.kind === 'next'
              ? m.library_vndb_browse_loading_next()
              : pending.kind === 'previous'
                ? m.library_vndb_browse_loading_previous()
                : pending.kind === 'restart'
                  ? m.library_vndb_browse_loading_first()
                  : m.library_vndb_library_loading()}
          </p>
          {visible ? <p className="text-muted-foreground">{m.library_vndb_browse_pending_keeps_page()}</p> : null}
        </>
      ) : null}
      {failed ? (
        <div className="rounded-md border border-border bg-muted/40 p-3" data-vndb-browse-failure={failed.result.state}>
          <p>{importLibraryFailureText(failed.result)}</p>
          <p className="mt-1 text-muted-foreground">
            {visible ? m.library_vndb_browse_failed_keeps_page() : m.library_vndb_browse_failed_no_page()}
          </p>
        </div>
      ) : null}
      {visible && !pending && !failed ? (
        <p>{m.library_vndb_library_count({ count: visible.page.libraryEntries.length })}</p>
      ) : null}
    </div>
  );
}

/** Native sparse pages retain their continuation; an empty window is not an empty whole Library. */
export function ImportLibraryEmptyState({ snapshot }: { snapshot: ImportLibrarySnapshot }) {
  if (!snapshot.visible || snapshot.visible.page.libraryEntries.length) return null;
  const sparse = snapshot.visible.page.next !== null;
  const first = snapshot.cursor === null;
  return (
    <div
      className="space-y-2 rounded-md border border-dashed p-4"
      data-vndb-browse-empty={sparse ? 'sparse' : first ? 'empty' : 'end'}
    >
      <p className="font-medium">
        {sparse
          ? m.library_vndb_browse_sparse()
          : first
            ? m.library_vndb_browse_empty()
            : m.library_vndb_browse_empty_end()}
      </p>
      <p className="text-sm text-muted-foreground">
        {sparse ? m.library_vndb_browse_sparse_help() : m.library_vndb_browse_empty_help()}
      </p>
    </div>
  );
}
