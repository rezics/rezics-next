import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link, useLocation } from '@tanstack/react-router';
import { coverSrc } from '../media/cover-src';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
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
        <CoverGrid
          ratio={sharedRatio(
            page.collections.map((collection) => ({ id: collection.id, title: collection.title, types: [] })),
          )}
        >
          {page.collections.map((collection) => (
            <CoverCard
              key={collection.id}
              href={`/${getLocale()}/collections/${encodeURIComponent(collection.id)}`}
              title={collection.title}
              cover={{ subject: { id: collection.id, title: collection.title, types: [] }, cover: null, src: coverSrc }}
              secondary={m.library_collection_item_count({ count: collection.memberCount })}
              state={visibilityLabel(collection.visibility)}
            />
          ))}
        </CoverGrid>
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
