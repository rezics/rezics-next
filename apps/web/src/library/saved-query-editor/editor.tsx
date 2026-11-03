import { useState } from 'react';
import { CollectionRuleCurrent } from '../collection-rule-current';
import { takeSavedQueryHandoff } from '../save-query';
import type { RulePage } from '../collection-rule-read';
import { savedQuerySeed, type SavedQuerySelection } from './selection';
import { m } from '../../paraglide/messages.js';

/** Review a carried selection, then the existing rule editor. Invalid selections never POST. */
export function SavedQueryEditor({
  page,
  collectionId,
  navigate,
}: {
  page: RulePage;
  collectionId: string | null;
  navigate?: (id: string) => void;
}) {
  const [handoff] = useState(() =>
    collectionId === null && (page.state === 'new' || page.state === 'ready')
      ? takeSavedQueryHandoff(page.viewerId)
      : null,
  );
  const selection: SavedQuerySelection =
    collectionId === null && page.state === 'new' && handoff?.viewerId === page.viewerId && handoff.sort === 'id'
      ? { state: 'admitted', filter: handoff.filter, sort: handoff.sort }
      : { state: 'empty' };
  const seed = savedQuerySeed(collectionId, selection);
  return (
    <>
      {collectionId === null && page.state === 'new' && !seed ? (
        <p role="status" className="mx-auto mb-4 max-w-4xl text-sm text-muted-foreground">
          {m.library_saved_query_reloaded()}
        </p>
      ) : null}
      <CollectionRuleCurrent
        page={page}
        collectionId={collectionId}
        {...(seed ? { seed } : {})}
        {...(navigate ? { navigate } : {})}
      />
    </>
  );
}
