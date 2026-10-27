import { Cover } from '@rezics/ui/cover';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link, useLocation } from '@tanstack/react-router';
import { coverSrc } from '../media/cover-src';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
import { AccountRef } from './account-ref';
import type { CollectionVisibility } from './reads';
import type { MineCollectionsPage } from './mine-collections';

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

export function MineCollectionsPageView({ page }: { page: MineCollectionsPage }) {
  const location = useLocation();
  if (!page.signedIn) return <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />;

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_collections_heading()}</PageHeading>
        <a href={`/${getLocale()}/collections/new`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
          {m.library_collection_new()}
        </a>
      </header>
      {page.collections.length ? (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {page.collections.map((collection) => (
            <li key={collection.id} className="flex items-center gap-3 py-3">
              <Cover
                subject={{ id: collection.id, title: collection.title, types: [] }}
                cover={null}
                size="xs"
                ratio="1:1"
                src={coverSrc}
                decorative
              />
              <div className="min-w-0 space-y-0.5">
                <h2 className="text-lg font-semibold break-words">
                  <Link
                    to="/collections/$id"
                    params={{ id: collection.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {collection.title}
                  </Link>
                </h2>
                <p className="text-sm text-muted-foreground">
                  {visibilityLabel(collection.visibility)} · {m.library_member_count({ count: collection.memberCount })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {m.library_curator()} <AccountRef account={collection.curator} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground">{m.library_collections_empty()}</p>
      )}
      {page.next ? (
        <nav aria-label={m.library_collections_heading()}>
          <Link
            to="/library/collections"
            search={{ cursor: page.next }}
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            {m.library_collection_more()}
          </Link>
        </nav>
      ) : null}
    </article>
  );
}
