import { Cover } from '@rezics/ui/cover';
import { CoverCard } from '@rezics/ui/cover-card';
import { ContentItem } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link, useLinkProps } from '@tanstack/react-router';
import {
  ChevronRightIcon,
  EllipsisIcon,
  LayoutListIcon,
  PanelsTopLeftIcon,
  LockKeyholeIcon,
  SearchIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { displayLibraryTitle } from './title';
import { dynamicCollectionTitle } from './dynamic-collection';
import type { LibrarySubject } from './reads';
import type { MineCollection, MineCollectionPreview } from './mine-collections';
import { collectionMemberRatio } from './collection-presentation';

export type CollectionBrowseLayout = 'rows' | 'previews';
export type CollectionPreviewData = MineCollectionPreview;

export type CollectionBrowseRecord = MineCollection & {
  preview: CollectionPreviewData;
};

export function browseCollectionTitle(
  collection: Pick<MineCollection, 'title' | 'builtinKind' | 'builtinLabels'>,
): string {
  if (collection.title !== null) return collection.title;
  return dynamicCollectionTitle(
    {
      builtinKind: collection.builtinKind ?? 'unknown',
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
  if (collection.coverSource !== undefined || collection.cover) {
    return (
      <div className="min-w-0" data-collection-cover={collection.coverSource}>
        <Cover
          subject={{ id: collection.id, title, types: [] }}
          cover={collection.cover ?? null}
          size="fill"
          ratio={collectionMemberRatio(collection.presentationKind ? { type: collection.presentationKind } : null)}
          src={coverSrc}
          decorative
        />
        {collection.coverSource === 'pending' ? (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {m.library_collection_preview_preparing()}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Cover
      subject={
        subject
          ? { id: subject.id, title: displayLibraryTitle(subject.label, getLocale()).text, types: subject.types }
          : { id: collection.id, title, types: [] }
      }
      cover={subject?.cover ?? null}
      size="fill"
      ratio={collectionMemberRatio(
        subject ?? (collection.presentationKind ? { type: collection.presentationKind } : null),
      )}
      src={coverSrc}
      decorative
    />
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
          <EllipsisIcon aria-hidden="true" className="size-4" />
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
  const collectionLink = useLinkProps({ to: '/collections/$id', params: { id: collection.id } });
  const href = readable
    ? collectionLink.href
    : `/${getLocale()}/auth/sign-in?return_to=${encodeURIComponent(collectionHref(collection.id))}`;
  return (
    <ContentItem
      title={title}
      {...(href !== undefined ? { href } : {})}
      data-collection-row={collection.id}
      visual={
        <div className="w-[72px] sm:w-24">
          <CollectionCover collection={collection} subject={firstMember ?? null} />
        </div>
      }
      metadata={<CollectionFacts collection={collection} />}
      actions={menu}
      trailing={
        readable ? (
          <Link to="/collections/$id" params={{ id: collection.id }} className={buttonVariants({ size: 'lg' })}>
            {action}
          </Link>
        ) : (
          <a
            href={`/${getLocale()}/auth/sign-in?return_to=${encodeURIComponent(collectionHref(collection.id))}`}
            className={buttonVariants({ size: 'lg' })}
          >
            {action}
          </a>
        )
      }
    />
  );
}

function PreviewStrip({ members }: { members: readonly LibrarySubject[] }) {
  return (
    <ul className="grid min-w-0 grid-cols-3 gap-3">
      {members.slice(0, 3).map((subject, index) => {
        const title = displayLibraryTitle(subject.label, getLocale()).text;
        const href = subjectHref({ id: subject.id, label: title }, getLocale());
        return (
          <li key={`${subject.id}:${index}`} className="min-w-0">
            <CoverCard
              title={title}
              href={href.href}
              cover={{
                subject: { id: subject.id, title, types: subject.types },
                cover: subject.cover,
                ratio: collectionMemberRatio(subject),
                src: coverSrc,
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** A preview entry uses only the bounded members supplied by its producer; an absent batch stays explicitly unavailable. */
export function CollectionPreview({ collection, menu }: { collection: CollectionBrowseRecord; menu?: ReactNode }) {
  const title = browseCollectionTitle(collection);
  const members = collection.preview.state === 'loaded' ? collection.preview.members.slice(0, 3) : [];
  const { href } = useLinkProps({ to: '/collections/$id', params: { id: collection.id } });
  return (
    <ContentItem
      title={title}
      {...(href !== undefined ? { href } : {})}
      data-collection-preview={collection.id}
      metadata={<CollectionFacts collection={collection} />}
      actions={menu}
      trailing={<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />}
      preview={
        <ListRowControl>
          {members.length ? (
            <PreviewStrip members={members} />
          ) : collection.preview.state === 'loaded' && collection.memberCount === 0 ? (
            <p className="text-sm text-muted-foreground">{m.library_collection_empty()}</p>
          ) : collection.preview.state === 'loaded' && collection.preview.emptyConfirmed ? (
            <p className="text-sm text-muted-foreground">{m.library_collection_preview_no_visible_members()}</p>
          ) : (
            <p role="status" data-preview-state={collection.preview.state} className="text-sm text-muted-foreground">
              {collection.preview.state === 'preparing'
                ? m.library_collection_preview_preparing()
                : m.library_collection_preview_unavailable()}
            </p>
          )}
        </ListRowControl>
      }
    />
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
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-collection-browser-toolbar>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      <nav aria-label={m.library_layout()} className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant={layout === 'rows' ? 'secondary' : 'outline'}
          aria-label={m.library_layout_list()}
          aria-pressed={layout === 'rows'}
          onClick={() => onLayoutChange('rows')}
        >
          <LayoutListIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant={layout === 'previews' ? 'secondary' : 'outline'}
          aria-label={m.library_collection_previews()}
          aria-pressed={layout === 'previews'}
          onClick={() => onLayoutChange('previews')}
        >
          <PanelsTopLeftIcon aria-hidden="true" />
        </Button>
      </nav>
      <div className="flex items-center gap-2">
        <SearchLauncher />
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
      <ul className="min-w-0 space-y-3" data-collection-browse="previews">
        {collections.map((collection) => (
          <CollectionPreview key={collection.id} collection={collection} menu={menuFor?.(collection)} />
        ))}
      </ul>
    );
  return (
    <ul className="min-w-0 space-y-3" data-collection-browse="rows">
      {collections.map((collection) => (
        <CollectionBrowseRow
          key={collection.id}
          collection={collection}
          readable={readable}
          menu={menuFor?.(collection)}
        />
      ))}
    </ul>
  );
}

export function CollectionCopyMenu({ title, onCopy }: { title: string; onCopy: () => void | Promise<void> }) {
  return <CopyMenu title={title} onCopy={onCopy} />;
}
