import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { RuleEditLink } from '../collection-rule-editor';
import { browseCollectionTitle } from '../collection-browser';
import type { MineCollection } from '../mine-collections';

export type SavedQueryLayout = 'rows' | 'previews';

/** Membership and owner facts only; a missing native dynamic DTO never looks like an empty directory. */
export function ownedSavedQueries(collections: readonly MineCollection[], viewerId: string): MineCollection[] {
  return collections.filter(
    (collection) =>
      collection.curatorAccountId === viewerId &&
      collection.membershipKind === 'dynamic' &&
      !collection.builtinKind,
  );
}

function collectionHref(id: string): string {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
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
  capability: 'available' | 'unavailable';
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
      {capability === 'unavailable' ? (
        <div className="mt-3 space-y-2">
          <p role="status">{m.library_saved_queries_unavailable()}</p>
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
            const href = collectionHref(collection.id);
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
