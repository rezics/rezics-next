import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { RuleEditLink } from '../collection-rule-editor';
import { browseCollectionTitle } from '../collection-browser';
import type { MineCollection } from '../mine-collections';

export type SavedQueryLayout = 'rows' | 'previews';

/** A row requires the native dynamic DTO and the current session owner. */
export function ownedSavedQueries(collections: readonly MineCollection[], viewerId: string): MineCollection[] {
  return collections.filter(
    (collection) =>
      collection.curatorAccountId === viewerId && collection.membershipKind === 'dynamic' && !collection.builtinKind,
  );
}

function collectionHref(id: string, returnTo: string): string {
  const search = new URLSearchParams({ returnTo });
  return `/${getLocale()}/collections/${encodeURIComponent(id)}?${search}`;
}

function nextPageHref(next: string, layout: SavedQueryLayout): string {
  const search = new URLSearchParams({ cursor: next, layout });
  return `/${getLocale()}/library/collections?${search}`;
}

export function SavedQueryDirectory({
  collections,
  capability,
  viewerId,
  canEditRules,
  currentHref,
  next,
  layout,
}: {
  collections: readonly MineCollection[];
  capability: 'unknown' | 'available' | 'denied' | 'unavailable';
  viewerId: string;
  canEditRules: boolean;
  currentHref: string;
  next: string | null;
  layout: SavedQueryLayout;
}) {
  const queries = ownedSavedQueries(collections, viewerId);
  return (
    <section aria-labelledby="saved-query-directory-heading" data-saved-query-directory>
      <h2 id="saved-query-directory-heading" className="text-lg font-semibold">
        {m.library_saved_queries_heading()}
      </h2>
      {capability === 'unknown' ? (
        <p role="status" data-capability="unknown" className="mt-3">
          {m.settings_sections_loading()}
        </p>
      ) : capability === 'denied' ? (
        <p role="status" data-capability="denied" className="mt-3">
          {m.library_collections_denied()}
        </p>
      ) : capability === 'unavailable' ? (
        <div className="mt-3 space-y-2">
          <p role="status" data-capability="unavailable">{m.library_saved_queries_unavailable()}</p>
          <a href={currentHref} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.library_collections_retry()}
          </a>
          {next ? (
            <a href={nextPageHref(next, layout)} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {m.library_collection_more()}
            </a>
          ) : null}
        </div>
      ) : queries.length ? (
        <ul className="mt-3 space-y-3">
          {queries.map((collection) => {
            const href = collectionHref(collection.id, currentHref);
            return (
              <ContentItem
                key={collection.id}
                title={browseCollectionTitle(collection)}
                href={href}
                data-saved-query-row={collection.id}
                trailing={
                  <a href={href} className={buttonVariants({ size: 'lg' })}>
                    {m.library_collection_open()}
                  </a>
                }
                actions={
                  canEditRules ? (
                    <RuleEditLink
                      collection={collection}
                      viewerId={viewerId}
                      allowed={canEditRules}
                      className={buttonVariants({ variant: 'outline', size: 'lg' })}
                    />
                  ) : null
                }
              />
            );
          })}
        </ul>
      ) : (
        <div className="mt-3 space-y-2">
          <p role="status">{m.library_saved_queries_empty_page()}</p>
          {next ? (
            <a href={nextPageHref(next, layout)} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {m.library_collection_more()}
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}
