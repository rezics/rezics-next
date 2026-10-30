import { Cover, coverRatio } from '@rezics/ui/cover';
import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, ImageOffIcon, LockKeyholeIcon, SearchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { displayLibraryTitle } from './title';
import { dynamicCollectionTitle, type DynamicBuiltinKind } from './dynamic-collection';
import type { LibrarySubject } from './reads';
import type { MineCollection } from './mine-collections';

export type CollectionBrowseLayout = 'rows' | 'previews';
export type CollectionPreviewData =
  | { state: 'unavailable' }
  | { state: 'loaded'; members: readonly LibrarySubject[] };

export type CollectionBrowseRecord = MineCollection & {
  preview: CollectionPreviewData;
};

export function browseCollectionTitle(collection: Pick<MineCollection, 'title' | 'builtinKind' | 'builtinLabels'>): string {
  if (collection.title !== null) return collection.title;
  return dynamicCollectionTitle(
    {
      builtinKind: (collection.builtinKind ?? 'state') as DynamicBuiltinKind,
      title: null,
      ...(collection.builtinLabels ? { builtinLabels: collection.builtinLabels } : {}),
    },
    getLocale(),
  );
}

function collectionHref(id: string): string {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
}

function privateCollection(collection: MineCollection): boolean {
  return collection.visibility === 'private';
}

function CollectionCover({ collection, subject }: { collection: MineCollection; subject?: LibrarySubject | null }) {
  const title = browseCollectionTitle(collection);
  if (subject) {
    const label = displayLibraryTitle(subject.label, getLocale()).text;
    return (
      <Cover
        subject={{ id: subject.id, title: label, types: subject.types }}
        cover={subject.cover}
        size="md"
        ratio={coverRatio(subject.types)}
        src={coverSrc}
        decorative
      />
    );
  }
  return (
    <div
      className="flex aspect-[4/5] w-40 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted/40 px-3 text-center text-muted-foreground"
      role="img"
      aria-label={`${title}: ${m.library_collection_preview_unavailable()}`}
      data-collection-cover="unavailable"
    >
      <ImageOffIcon aria-hidden="true" className="size-6" />
      <span className="text-xs">{m.library_collection_preview_unavailable()}</span>
    </div>
  );
}

function CollectionFacts({ collection }: { collection: MineCollection }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {privateCollection(collection) ? (
        <span className="inline-flex items-center gap-1" data-collection-visibility="private">
          <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
          {m.library_visibility_private()}
        </span>
      ) : collection.visibility ? (
        <span data-collection-visibility={collection.visibility}>
          {collection.visibility === 'public'
            ? m.library_visibility_public()
            : collection.visibility === 'unlisted'
              ? m.library_visibility_unlisted()
              : m.library_visibility_private()}
        </span>
      ) : null}
      {collection.memberCount !== undefined ? (
        <span data-collection-member-count={collection.memberCount}>
          {m.library_collection_item_count({ count: collection.memberCount })}
        </span>
      ) : null}
    </div>
  );
}

function CopyMenu({ title, onCopy }: { title: string; onCopy: () => void | Promise<void> }) {
  return (
    <Menu
      title={`${m.library_collection_actions()}: ${title}`}
      trigger={
          <Button type="button" aria-label={`${m.library_collection_actions()}: ${title}`} variant="ghost" size="icon-sm">
          <ChevronRightIcon aria-hidden="true" className="size-4 rotate-90" />
        </Button>
      }
      entries={[{ type: 'item', label: m.library_collection_copy(), onSelect: onCopy }]}
    />
  );
}

/** One bounded Collection row with the available member cover, truthful native count and one primary action. */
export function CollectionBrowseRow({
  collection,
  readable = true,
  menu,
}: {
  collection: CollectionBrowseRecord;
  readable?: boolean;
  menu?: ReactNode;
}) {
  const title = browseCollectionTitle(collection);
  const firstMember = collection.preview.state === 'loaded' ? collection.preview.members[0] : undefined;
  const action = readable ? m.library_collection_open() : m.account_sign_in();
  return (
    <ListRow className="flex min-w-0 items-center gap-4 rounded-xl p-3 sm:gap-6 sm:p-4" data-collection-row={collection.id}>
      <CollectionCover collection={collection} subject={firstMember} />
      <div className="min-w-0 flex-1 py-1">
        <h2 className="line-clamp-2 text-lg font-semibold leading-snug sm:text-xl">{title}</h2>
        <CollectionFacts collection={collection} />
      </div>
      {menu ? <ListRowControl>{menu}</ListRowControl> : null}
      <ListRowControl className="shrink-0">
        {readable ? (
          <Link to="/collections/$id" params={{ id: collection.id }} className={buttonVariants({ size: 'lg' })}>
            {action}
          </Link>
        ) : (
          <a href={`/${getLocale()}/auth/sign-in?return_to=${encodeURIComponent(collectionHref(collection.id))}`} className={buttonVariants({ size: 'lg' })}>
            {action}
          </a>
        )}
      </ListRowControl>
    </ListRow>
  );
}

function PreviewStrip({ members }: { members: readonly LibrarySubject[] }) {
  return (
    <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
      {members.slice(0, 3).map((subject) => {
        const title = displayLibraryTitle(subject.label, getLocale()).text;
        const href = subjectHref({ id: subject.id, label: title }, getLocale());
        return (
          <li key={subject.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-muted/30 p-2">
            <Cover
              subject={{ id: subject.id, title, types: subject.types }}
              cover={subject.cover}
              size="sm"
              ratio={coverRatio(subject.types)}
              src={coverSrc}
              decorative
            />
            <Link to={href.to} params={href.params} className="line-clamp-2 min-w-0 text-sm font-medium hover:underline">
              {title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** A preview entry uses only the bounded members supplied by its producer; an absent batch stays explicitly unavailable. */
export function CollectionPreview({ collection }: { collection: CollectionBrowseRecord }) {
  const title = browseCollectionTitle(collection);
  const members = collection.preview.state === 'loaded' ? collection.preview.members.slice(0, 3) : [];
  return (
    <article className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4" data-collection-preview={collection.id}>
      <header className="flex min-w-0 items-center gap-3">
        <Link to="/collections/$id" params={{ id: collection.id }} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
          <span className="line-clamp-2 min-w-0 text-lg font-semibold">{title}</span>
          {privateCollection(collection) ? <LockKeyholeIcon aria-label={m.library_visibility_private()} className="size-4 shrink-0" /> : null}
          {collection.memberCount !== undefined ? (
            <span className="shrink-0 text-sm text-muted-foreground">{m.library_collection_item_count({ count: collection.memberCount })}</span>
          ) : null}
          <ChevronRightIcon aria-hidden="true" className="ms-auto size-4 shrink-0" />
        </Link>
      </header>
      <div className="mt-3">
        {members.length ? (
          <PreviewStrip members={members} />
        ) : collection.memberCount === 0 ? (
          <p className="text-sm text-muted-foreground">{m.library_collection_empty()}</p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {m.library_collection_preview_unavailable()}
          </p>
        )}
      </div>
    </article>
  );
}

function SearchLauncher() {
  const href = `/${getLocale()}/search`;
  return (
    <a
      href={href}
      className={buttonVariants({ variant: 'outline', size: 'icon' })}
      aria-label={m.search_label()}
      title={m.search_label()}
      onClick={(event) => {
        const field = document.querySelector<HTMLInputElement>('input[name="q"]');
        if (!field) return;
        event.preventDefault();
        field.focus();
      }}
    >
      <SearchIcon aria-hidden="true" />
    </a>
  );
}

export function CollectionBrowseToolbar({
  layout,
  onLayoutChange,
  children,
}: {
  layout: CollectionBrowseLayout;
  onLayoutChange: (layout: CollectionBrowseLayout) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-collection-browser-toolbar>
      <nav aria-label={m.library_layout()} className="flex items-center gap-1">
        <Button type="button" variant={layout === 'rows' ? 'secondary' : 'outline'} aria-pressed={layout === 'rows'} onClick={() => onLayoutChange('rows')}>
          {m.library_layout_list()}
        </Button>
        <Button type="button" variant={layout === 'previews' ? 'secondary' : 'outline'} aria-pressed={layout === 'previews'} onClick={() => onLayoutChange('previews')}>
          {m.library_layout_grid()}
        </Button>
      </nav>
      <div className="flex items-center gap-2">
        <SearchLauncher />
        {children}
      </div>
    </div>
  );
}

export function CollectionBrowseList({
  collections,
  layout,
  readable = true,
  menuFor,
}: {
  collections: readonly CollectionBrowseRecord[];
  layout: CollectionBrowseLayout;
  readable?: boolean;
  menuFor?: (collection: CollectionBrowseRecord) => ReactNode;
}) {
  if (layout === 'previews')
    return (
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2" data-collection-browse="previews">
        {collections.map((collection) => <CollectionPreview key={collection.id} collection={collection} />)}
      </div>
    );
  return (
    <ul className="min-w-0 space-y-3" data-collection-browse="rows">
      {collections.map((collection) => (
        <CollectionBrowseRow key={collection.id} collection={collection} readable={readable} menu={menuFor?.(collection)} />
      ))}
    </ul>
  );
}

export function CollectionCopyMenu({ title, onCopy }: { title: string; onCopy: () => void | Promise<void> }) {
  return <CopyMenu title={title} onCopy={onCopy} />;
}
