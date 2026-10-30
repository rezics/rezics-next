import { Exposure, useOperation } from '../kernel/exposure';
import type { CoverRatio } from '@rezics/ui/cover';
import { ContentActions } from '@rezics/ui/content-actions';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { sharedRatio } from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { RelativeTime } from '@rezics/ui/relative-time';
import { useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { ShelfLayout } from './shelf-params';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { AccountRef } from './account-ref';
import { coverSrc } from '../media/cover-src';
import { subjectHref } from '../subject/subject-href';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import {
  deleteCollection,
  moveCollectionMember,
  removeCollectionMember,
  setCollectionFollow,
  updateCollection,
  updateMemberNote,
  type CollectionWriteResult,
} from './collection-edit';
import type { EditableCollectionPage } from './collection-load';
import { pageHead, type HeadContext } from '../shell/head';
import { LibraryNavigation } from './library-nav';
import { libraryNavigationQuery } from './pins-read';
import { PinControl, PinControlNotice, usePinControlActions } from './pin-control';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { validatePublicOrigin } from '../shell/origin';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export function collectionPageHead(
  page:
    | Pick<
        EditableCollectionPage,
        'id' | 'title' | 'description' | 'curator' | 'members' | 'memberCount' | 'visibility'
      >
    | Pick<DynamicCollectionPageData, 'id' | 'title' | 'description' | 'curator' | 'members'>,
  suppliedContext?: HeadContext,
  laterPage = false,
) {
  const path = `/collections/${encodeURIComponent(page.id)}`;
  const context = suppliedContext ?? {
    origin: publicOrigin(),
    locale: getLocale(),
    path,
  };
  const title = pageText(libraryTitleValue(page.title), context.locale).text;
  const imageSubject = page.members[0]?.subject;
  const cover = imageSubject?.cover;
  const variants = cover && !cover.withheld ? cover.variants : [];
  const width = variants.length
    ? [...new Set(variants.map((v) => v.width))].sort((a, b) => Math.abs(a - 1200) - Math.abs(b - 1200))[0]
    : undefined;
  const format =
    width === undefined
      ? undefined
      : (variants.find((v) => v.width === width && v.format === 'webp')?.format ??
        variants.find((v) => v.width === width)?.format);
  const image =
    cover && width && format && cover.width > 0
      ? {
          url: coverSrc(cover.media, format, width),
          width,
          height: Math.round((cover.height * width) / cover.width),
          alt: imageSubject ? pageText(libraryTitleValue(imageSubject.label), context.locale).text : title,
        }
      : undefined;
  const items = page.members.flatMap((member, index) =>
    member.subject
      ? [
          {
            '@type': 'ListItem',
            position: index + 1,
            url: new URL(
              subjectHref(
                {
                  id: member.subject.id,
                  label: pageText(libraryTitleValue(member.subject.label), context.locale).text,
                },
                context.locale,
              ).href,
              context.origin,
            ).href,
          },
        ]
      : [],
  );
  const breadcrumbs = [
    { '@type': 'ListItem', position: 1, name: 'REZICS', item: context.origin },
    ...(page.curator?.handle
      ? [
          {
            '@type': 'ListItem',
            position: 2,
            name: page.curator.displayName || page.curator.handle,
            item: `${context.origin}/${context.locale}/@${encodeURIComponent(page.curator.handle)}`,
          },
        ]
      : []),
    {
      '@type': 'ListItem',
      position: page.curator?.handle ? 3 : 2,
      name: title,
      item: `${context.origin}/${context.locale}${path}`,
    },
  ];
  const description = page.description?.trim() || undefined;
  return pageHead(
    {
      title,
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'CollectionPage',
            name: title,
            ...(description ? { description } : {}),
            url: `${context.origin}/${context.locale}${path}`,
            mainEntity: {
              '@type': 'ItemList',
              ...('memberCount' in page ? { numberOfItems: page.memberCount } : {}),
              itemListOrder: 'https://schema.org/ItemListOrderAscending',
              itemListElement: items,
            },
          },
          { '@type': 'BreadcrumbList', itemListElement: breadcrumbs },
        ],
      },
      ...(laterPage || ('visibility' in page && page.visibility === 'private') ? { robots: 'noindex, follow' } : {}),
    },
    context,
  );
}
import type { CollectionMember, CollectionVisibility } from './reads';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { rowRatio, SubjectCover } from './subject-row';

/** The kernel holds at most this many members in one collection. */
const COLLECTION_LIMIT = 5000;
const collectionMemberDragType = 'application/x-rezics-collection-member';

const visibilities = ['private', 'unlisted', 'public'] as const;
const collectionLayouts = ['list', 'grid'] as const satisfies readonly ShelfLayout[];
type CollectionLayout = (typeof collectionLayouts)[number];
type CollectionPageSearch = {
  cursor?: string;
  filters?: Record<string, string | string[]>;
};

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

function visibilityNote(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public_note();
  if (visibility === 'unlisted') return m.library_visibility_unlisted_note();
  return m.library_visibility_private_note();
}

export const fieldClass =
  'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary';
export const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

function collectionHref(id: string): string {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
}

function collectionLayoutHref(id: string, layout: CollectionLayout, search: CollectionPageSearch): string {
  const params = new URLSearchParams();
  if (layout !== 'list') params.set('layout', layout);
  if (search.cursor) params.set('cursor', search.cursor);
  for (const [key, value] of Object.entries(search.filters ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => params.append(key, entry));
    else params.set(key, value);
  }
  const query = params.toString();
  return `${collectionHref(id)}${query ? `?${query}` : ''}`;
}

function collectionLayoutLabel(layout: CollectionLayout): string {
  return layout === 'grid' ? m.library_layout_grid() : m.library_layout_list();
}

function CollectionLayoutLinks({
  id,
  layout,
  search,
}: {
  id: string;
  layout: CollectionLayout;
  search: CollectionPageSearch;
}) {
  return (
    <nav data-slot="collection-layout" aria-label={m.library_layout()} className="flex gap-1">
      {collectionLayouts.map((option) => (
        <a
          key={option}
          href={collectionLayoutHref(id, option, search)}
          {...(layout === option ? { 'aria-current': 'page' as const } : {})}
          className={buttonVariants({
            variant: layout === option ? 'secondary' : 'outline',
            size: 'sm',
          })}
        >
          {collectionLayoutLabel(option)}
        </a>
      ))}
    </nav>
  );
}

function failureText(result: Extract<CollectionWriteResult, { ok: false }>): string {
  return result.reason === 'full' ? m.library_collection_full() : m.error_message();
}

/** The radio group both the editor and the create page use: each visibility with one plain sentence. */
export function VisibilityField({
  value,
  onChange,
  disabled = false,
}: {
  value: CollectionVisibility | '';
  onChange: (value: CollectionVisibility) => void;
  disabled?: boolean;
}) {
  return (
    <FieldSet className="gap-2" disabled={disabled}>
      <FieldLegend variant="label">{m.library_collection_visibility()}</FieldLegend>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as CollectionVisibility)} className="gap-2">
        {visibilities.map((option) => (
          <Field key={option} orientation="horizontal" className="items-start">
            <RadioGroupItem id={`collection-visibility-${option}`} value={option} />
            <FieldLabel htmlFor={`collection-visibility-${option}`} className="items-start">
              <span>
                <strong className="font-medium">{visibilityLabel(option)}</strong> {visibilityNote(option)}
              </span>
            </FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

/** Where a member lands when moved one place up, one place down or to the top, as the `after` member id. */
function placementAfter(
  kind: 'up' | 'down' | 'top',
  index: number,
  members: CollectionMember[],
  firstPage: boolean,
): string | null | undefined {
  if (kind === 'top') return index === 0 && firstPage ? undefined : null;
  if (kind === 'up') {
    if (index === 1 && firstPage) return null;
    return index >= 2 ? members[index - 2]!.id : undefined;
  }
  return index < members.length - 1 ? members[index + 1]!.id : undefined;
}

function moveWithin(members: CollectionMember[], memberId: string, after: string | null): CollectionMember[] {
  const moved = members.find((member) => member.id === memberId);
  if (!moved) return members;
  const rest = members.filter((member) => member.id !== memberId);
  const at = after === null ? 0 : rest.findIndex((member) => member.id === after) + 1;
  if (after !== null && at === 0) return members;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

export function CollectionPage({
  page,
  queryKey,
  refreshPage,
  cursor,
  layout = 'list',
  search,
}: {
  page: EditableCollectionPage;
  queryKey: readonly unknown[];
  refreshPage: () => Promise<EditableCollectionPage>;
  cursor: string | undefined;
  layout?: CollectionLayout;
  search?: Record<string, string | string[]>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const admitted = useOperation('collection.update');
  const owner = page.visibility !== null && admitted;
  const navigation = useQuery(libraryNavigationQuery(getLocale(), 100));
  const pins = navigation.data?.pins ?? { state: 'closed' as const };
  const navigationCollections = navigation.data?.collections ?? [];
  const pinActions = usePinControlActions({ collectionId: page.id, pins, mode: 'collection' });
  const [hydrated, setHydrated] = useState(false);
  const [members, setMembers] = useState(page.members);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description ?? '');
  const [visibility, setVisibility] = useState<CollectionVisibility>(page.visibility ?? 'public');
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [following, setFollowing] = useState(page.following);
  const [pending, setPending] = useState(false);
  const preserveEditingAfterMemberWrite = useRef(false);
  const membersRef = useRef(members);
  const draggedMember = useRef<{ id: string; dropped: boolean } | null>(null);
  membersRef.current = members;
  const snapshot = [
    page.id,
    page.revision,
    page.title,
    page.description ?? '',
    page.following,
    page.members.map((member) => `${member.id}:${member.note ?? ''}`).join('\n'),
  ].join('\n');

  useEffect(() => setHydrated(true), []);

  // A changed server snapshot replaces the list; member writes can refresh it without leaving edit mode.
  useEffect(() => {
    setMembers(page.members);
    if (preserveEditingAfterMemberWrite.current) {
      preserveEditingAfterMemberWrite.current = false;
    } else {
      setEditing(false);
    }
    setConflict(false);
    setFailure('');
    setTitle(page.title);
    setDescription(page.description ?? '');
    setFollowing(page.following);
    if (page.visibility) setVisibility(page.visibility);
  }, [snapshot]);

  async function reloadCollection(keepEditing = false) {
    const refreshed = await refreshPage();
    preserveEditingAfterMemberWrite.current = keepEditing;
    queryClient.setQueryData(queryKey, refreshed);
    await router.invalidate();
  }

  /** One write at a time, so the next control always starts from the state the last one left. */
  async function write(run: () => Promise<CollectionWriteResult>): Promise<CollectionWriteResult> {
    setPending(true);
    setFailure('');
    try {
      return await run();
    } catch {
      return { ok: false, reason: 'unavailable' };
    } finally {
      setPending(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending) return;
    const result = await write(() =>
      updateCollection({
        data: {
          collectionId: page.id,
          revision: page.revision,
          title,
          description,
          visibility,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      await reloadCollection();
      return;
    }
    if (result.reason === 'conflict') setConflict(true);
    else setFailure(failureText(result));
  }

  async function removeCollection() {
    const result = await deleteCollection({
      data: {
        collectionId: page.id,
        revision: page.revision,
        idempotencyKey: crypto.randomUUID(),
      },
      headers: csrfHeaders(),
    });
    if (!result.ok) throw new Error(m.error_message());
    window.location.assign(`/${getLocale()}/library/collections`);
  }

  async function moveMember(memberId: string, after: string | null) {
    if (!hydrated || pending) return;
    const before = membersRef.current;
    setMembers(moveWithin(before, memberId, after));
    const result = await write(() =>
      moveCollectionMember({
        data: {
          collectionId: page.id,
          memberId,
          after,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (!result.ok) {
      setMembers(before);
      setFailure(failureText(result));
    } else await reloadCollection(true);
  }

  async function saveNote(memberId: string, note: string) {
    if (!hydrated || pending) return;
    const result = await write(() =>
      updateMemberNote({
        data: {
          collectionId: page.id,
          memberId,
          note: note.length > 0 ? note : null,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      setMembers((current) =>
        current.map((member) => (member.id === memberId ? { ...member, note: note.length > 0 ? note : null } : member)),
      );
      await reloadCollection(true);
    } else setFailure(failureText(result));
  }

  async function removeMember(memberId: string) {
    if (!hydrated || pending) return;
    const result = await write(() =>
      removeCollectionMember({
        data: {
          collectionId: page.id,
          memberId,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      setMembers((current) => current.filter((member) => member.id !== memberId));
      await reloadCollection(true);
    } else setFailure(failureText(result));
  }

  async function toggleFollow() {
    if (!hydrated || pending || following === null) return;
    const result = await write(() =>
      setCollectionFollow({
        data: {
          collectionId: page.id,
          follow: !following,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) setFollowing(!following);
    else setFailure(failureText(result));
  }

  function dropMember(memberId: string, event: PointerEvent<HTMLElement>) {
    dropMemberAt(memberId, event.clientX, event.clientY);
  }

  function dropMemberAt(memberId: string, clientX: number, clientY: number) {
    let targetId = '';
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const id = element.closest('[data-member]')?.getAttribute('data-member');
      if (id && id !== memberId) {
        targetId = id;
        break;
      }
    }
    placeMember(memberId, targetId);
  }

  function placeMember(memberId: string, targetId: string) {
    const current = membersRef.current;
    const from = current.findIndex((member) => member.id === memberId);
    const to = current.findIndex((member) => member.id === targetId);
    if (from < 0 || to < 0) return;
    // Dropping on a row puts the member where that row was: before it when moving up, after it when moving down.
    if (from < to) return void moveMember(memberId, targetId);
    if (to > 0) return void moveMember(memberId, current[to - 1]!.id);
    if (page.firstPage) void moveMember(memberId, null);
  }

  const atLimit = page.visibility !== null && page.memberCount !== null && page.memberCount >= COLLECTION_LIMIT;
  const canEditMembers = owner && editing;
  const ratio = rowRatio(members.map((member) => member.subject));
  return (
    <div className="min-w-0 max-w-7xl space-y-6 text-foreground">
      <LibraryNavigation
        current={{ collectionId: page.id }}
        pins={pins}
        collections={navigationCollections}
        activeCollection={{ id: page.id, title: page.title }}
      />
      <article className="min-w-0 max-w-4xl space-y-8 text-foreground">
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <PageHeading>{page.title}</PageHeading>
            {owner ? (
              hydrated ? (
                <ContentActions
                  ownsContent
                  labels={{
                    moreActions: m.library_collection_actions(),
                    copyLink: m.library_collection_copy(),
                    edit: m.library_collection_edit(),
                    delete: m.library_collection_delete(),
                    confirmDelete: m.library_collection_delete_confirm(),
                    deleteTitle: m.library_collection_delete_title(),
                    deleteDescription: m.library_collection_delete_description(),
                    cancel: m.library_collection_cancel(),
                  }}
                  extraEntries={pinActions.entries}
                  onCopyLink={() => {
                    void navigator.clipboard.writeText(`${location.origin}${collectionHref(page.id)}`).catch(() => {});
                  }}
                  onEdit={() => {
                    setFailure('');
                    setEditing(true);
                  }}
                  onDelete={removeCollection}
                />
              ) : (
                <button
                  aria-label={m.library_collection_actions()}
                  className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  disabled
                  type="button"
                >
                  <EllipsisIcon aria-hidden="true" className="size-4" />
                </button>
              )
            ) : (
              <PinControl collectionId={page.id} pins={pins} mode="collection" />
            )}
            {owner ? <PinControlNotice notice={pinActions.notice} /> : null}
          </div>
          {page.description !== null ? <p className="whitespace-pre-wrap">{page.description}</p> : null}
          <p data-slot="collection-metadata" className="text-sm text-muted-foreground">
            <MetaLine
              items={[
                <span>
                  <span>{m.library_curator()}</span>{' '}
                  {page.curator ? (
                    <>
                      <a
                        href={`/${getLocale()}/@${encodeURIComponent(page.curator.handle ?? '')}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {page.curator.displayName ?? page.curator.handle}
                      </a>
                      {page.curator.handle ? <span> @{page.curator.handle}</span> : null}
                    </>
                  ) : (
                    <AccountRef account={null} />
                  )}
                </span>,
                !page.filter && page.memberCount !== null ? m.library_member_count({ count: page.memberCount }) : null,
                <span>
                  {m.library_collection_updated()} <RelativeTime value={page.updatedAt} locale={getLocale()} />
                </span>,
              ]}
            />
          </p>
          {atLimit ? <p>{m.library_collection_full()}</p> : null}
          {page.visibility ? <p data-visibility={page.visibility}>{visibilityLabel(page.visibility)}</p> : null}
          {following !== null ? (
            <Exposure operation="follow.put">
              <div className="flex flex-wrap items-center gap-3">
                {following ? <p>{m.library_following()}</p> : null}
                <button
                  className={buttonClass}
                  disabled={!hydrated || pending}
                  onClick={() => void toggleFollow()}
                  type="button"
                >
                  {following ? m.library_follow_unfollow() : m.library_follow()}
                </button>
              </div>
            </Exposure>
          ) : null}
          {owner && editing ? (
            <form className="space-y-4" onSubmit={(event) => void save(event)}>
              <label className="block">
                {m.library_collection_title()}
                <input
                  className={fieldClass}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
              </label>
              <label className="block">
                {m.library_collection_description()}
                <textarea
                  className={fieldClass}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  value={description}
                />
              </label>
              <VisibilityField onChange={setVisibility} value={visibility} />
              {conflict ? (
                <p role="alert">
                  {m.library_collection_conflict()}{' '}
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={collectionHref(page.id)}
                    onClick={(event) => {
                      event.preventDefault();
                      void reloadCollection();
                    }}
                  >
                    {m.library_collection_reload()}
                  </a>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button className={buttonClass} disabled={!hydrated || pending} type="submit">
                  {m.library_collection_save()}
                </button>
                <button className={buttonClass} onClick={() => setEditing(false)} type="button">
                  {m.library_collection_cancel()}
                </button>
              </div>
            </form>
          ) : null}
          {failure ? <p role="alert">{failure}</p> : null}
        </header>
        <section className="space-y-4" aria-labelledby="collection-members-heading">
          {page.filterProperties && page.filterParams ? (
            <CollectionFilters
              id={page.id}
              type={page.filterType ?? 'schema:Book'}
              properties={page.filterProperties}
              params={page.filterParams}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="collection-members-heading" className="text-xl font-semibold">
              {m.library_collection_members()}
            </h2>
            <CollectionLayoutLinks
              id={page.id}
              layout={layout}
              search={{
                ...(cursor ? { cursor } : {}),
                ...(search ? { filters: search } : {}),
              }}
            />
          </div>
          <CollectionFilterFeedback
            id={page.id}
            {...(page.filter === undefined ? {} : { filter: page.filter })}
            {...(page.filterIgnored === undefined ? {} : { ignored: page.filterIgnored })}
            {...(page.filterStatus === undefined ? {} : { status: page.filterStatus })}
            {...(page.filterType === undefined ? {} : { filterType: page.filterType })}
            empty={members.length === 0}
            emptyLabel={m.library_collection_empty()}
            buttonClass={buttonClass}
          />
          {members.length && layout === 'grid' ? (
            <div className="[&_[data-slot=cover-grid]]:grid-cols-1 md:[&_[data-slot=cover-grid]]:grid-cols-2 xl:[&_[data-slot=cover-grid]]:grid-cols-3">
              <CoverGrid ratio={ratio}>
                {members.map((member, index) => {
                  const subject = member.subject;
                  const locale = getLocale();
                  const localizedTitle = subject ? pageText(libraryTitleValue(subject.label), locale) : null;
                  const title = localizedTitle?.text ?? m.library_subject_unavailable();
                  const href = subject ? subjectHref({ id: subject.id, label: title }, getLocale()).href : undefined;
                  return (
                    <div
                      key={member.id}
                      data-member={member.id}
                      data-slot="collection-member-card"
                      className="min-w-0 self-start space-y-2"
                      onPointerDown={
                        canEditMembers && hydrated && !pending
                          ? (event) => {
                              const target = event.target;
                              if (!(target instanceof Element) || !target.closest('[data-drag-handle]')) return;
                              event.currentTarget.setPointerCapture(event.pointerId);
                              draggedMember.current = {
                                id: member.id,
                                dropped: false,
                              };
                              event.currentTarget.dataset.dragging = member.id;
                            }
                          : undefined
                      }
                      onPointerUp={
                        canEditMembers
                          ? (event) => {
                              if (event.currentTarget.dataset.dragging !== member.id) return;
                              delete event.currentTarget.dataset.dragging;
                              const drag = draggedMember.current;
                              if (drag?.id === member.id && drag.dropped) return;
                              if (drag?.id === member.id) drag.dropped = true;
                              dropMember(member.id, event);
                            }
                          : undefined
                      }
                      onDragOver={
                        canEditMembers && hydrated && !pending ? (event) => event.preventDefault() : undefined
                      }
                      onDrop={
                        canEditMembers && hydrated && !pending
                          ? (event) => {
                              event.preventDefault();
                              const memberId =
                                draggedMember.current?.id ||
                                event.dataTransfer.getData('application/x-rezics-collection-member') ||
                                document.querySelector<HTMLElement>('[data-member][data-dragging]')?.dataset.dragging ||
                                '';
                              if (memberId) {
                                draggedMember.current = {
                                  id: memberId,
                                  dropped: true,
                                };
                                placeMember(memberId, member.id);
                              }
                            }
                          : undefined
                      }
                    >
                      {canEditMembers ? (
                        <ListRowControl className="flex justify-end">
                          <span
                            aria-hidden="true"
                            className="inline-block h-10 w-6 cursor-grab touch-none select-none rounded-sm border border-border/70"
                            data-drag-handle=""
                            draggable={hydrated && !pending}
                            onDragStart={(event) => {
                              draggedMember.current = {
                                id: member.id,
                                dropped: false,
                              };
                              event.currentTarget
                                .closest<HTMLElement>('[data-member]')
                                ?.setAttribute('data-dragging', member.id);
                              event.dataTransfer.setData(collectionMemberDragType, member.id);
                              event.dataTransfer.effectAllowed = 'move';
                            }}
                            onDragEnd={(event) => {
                              const drag = draggedMember.current;
                              if (drag?.id === member.id && !drag.dropped) {
                                drag.dropped = true;
                                dropMemberAt(member.id, event.clientX, event.clientY);
                              }
                              event.currentTarget
                                .closest<HTMLElement>('[data-member]')
                                ?.removeAttribute('data-dragging');
                              if (drag?.id === member.id) draggedMember.current = null;
                            }}
                          />
                        </ListRowControl>
                      ) : null}
                      <CoverCard
                        {...(href ? { href } : {})}
                        title={title}
                        {...(localizedTitle?.lang ? { titleLang: localizedTitle?.lang } : {})}
                        cover={{
                          subject: subject
                            ? { id: subject.id, title, types: subject.types }
                            : { id: 'unavailable', title, types: [] },
                          cover: subject?.cover ?? null,
                          src: coverSrc,
                          labels: {
                            withheld: m.thread_cover_withheld(),
                            reveal: m.thread_cover_reveal(),
                            credit: m.thread_cover_credit(),
                            via: m.thread_cover_via(),
                          },
                        }}
                        secondary={subject?.typeLabel}
                        linkLabel={title}
                      />
                      {member.note ? <MemberNote note={member.note} layout="grid" /> : null}
                      {canEditMembers ? (
                        <ListRowControl className="space-y-2">
                          <MemberRowControls
                            member={member}
                            index={index}
                            members={members}
                            firstPage={page.firstPage}
                            busy={!hydrated || pending}
                            moveMember={moveMember}
                            saveNote={saveNote}
                            removeMember={removeMember}
                          />
                        </ListRowControl>
                      ) : null}
                    </div>
                  );
                })}
              </CoverGrid>
            </div>
          ) : null}
          {members.length && layout === 'list' ? (
            <ul className="space-y-1">
              {members.map((member, index) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  index={index}
                  members={members}
                  firstPage={page.firstPage}
                  owner={canEditMembers}
                  ratio={ratio}
                  locale={getLocale()}
                  busy={!hydrated || pending}
                  moveMember={moveMember}
                  saveNote={saveNote}
                  removeMember={removeMember}
                  placeMember={placeMember}
                  dropMember={dropMember}
                  dropMemberAt={dropMemberAt}
                />
              ))}
            </ul>
          ) : null}
          {page.next ? (
            <Exposure operation="collection_member.list">
              <nav aria-label={m.library_collection_members()}>
                <a
                  href={collectionLayoutHref(page.id, layout, {
                    ...(page.next ? { cursor: page.next } : {}),
                    ...(search ? { filters: search } : {}),
                  })}
                  className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
                >
                  {m.library_collection_more()}
                </a>
              </nav>
            </Exposure>
          ) : null}
        </section>
      </article>
    </div>
  );
}

function MemberRowControls({
  member,
  index,
  members,
  firstPage,
  busy,
  moveMember,
  saveNote,
  removeMember,
}: {
  member: CollectionMember;
  index: number;
  members: CollectionMember[];
  firstPage: boolean;
  busy: boolean;
  moveMember: (memberId: string, after: string | null) => Promise<void>;
  saveNote: (memberId: string, note: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
}) {
  const [note, setNote] = useState(member.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setNote(member.note ?? ''), [member.id, member.note]);
  const up = placementAfter('up', index, members, firstPage);
  const down = placementAfter('down', index, members, firstPage);
  const top = placementAfter('top', index, members, firstPage);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {up !== undefined ? (
          <button className={buttonClass} disabled={busy} onClick={() => void moveMember(member.id, up)} type="button">
            {m.library_member_move_up()}
          </button>
        ) : null}
        {down !== undefined ? (
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void moveMember(member.id, down)}
            type="button"
          >
            {m.library_member_move_down()}
          </button>
        ) : null}
        {top !== undefined ? (
          <button className={buttonClass} disabled={busy} onClick={() => void moveMember(member.id, top)} type="button">
            {m.library_member_move_to_top()}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1">
          {m.library_member_note()}
          <textarea
            className={fieldClass}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            value={note}
          />
        </label>
        <button className={buttonClass} disabled={busy} onClick={() => void saveNote(member.id, note)} type="button">
          {m.library_member_note_save()}
        </button>
      </div>
      <Field orientation="horizontal" className="items-center">
        <Checkbox
          id={`remove-member-${member.id}-controls`}
          aria-label={m.library_member_remove_confirm()}
          checked={confirmed}
          disabled={busy}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
        />
        <FieldLabel htmlFor={`remove-member-${member.id}-controls`}>{m.library_member_remove_confirm()}</FieldLabel>
      </Field>
      <button
        className={buttonClass}
        disabled={busy || !confirmed}
        onClick={() => void removeMember(member.id)}
        type="button"
      >
        {m.library_member_remove()}
      </button>
    </>
  );
}

function MemberNote({ note, layout }: { note: string; layout: CollectionLayout }) {
  return (
    <p
      data-slot="collection-member-note"
      className={`whitespace-pre-wrap text-sm text-muted-foreground${layout === 'grid' ? ' line-clamp-4' : ''}`}
    >
      {note}
    </p>
  );
}

function MemberRow({
  member,
  index,
  members,
  firstPage,
  owner,
  ratio,
  locale,
  busy,
  moveMember,
  saveNote,
  removeMember,
  placeMember,
  dropMember,
  dropMemberAt,
}: {
  member: CollectionMember;
  index: number;
  members: CollectionMember[];
  firstPage: boolean;
  owner: boolean;
  ratio: CoverRatio;
  locale: string;
  busy: boolean;
  moveMember: (memberId: string, after: string | null) => Promise<void>;
  saveNote: (memberId: string, note: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  placeMember: (memberId: string, targetId: string) => void;
  dropMember: (memberId: string, event: PointerEvent<HTMLLIElement>) => void;
  dropMemberAt: (memberId: string, clientX: number, clientY: number) => void;
}) {
  const dragged = useRef(false);
  const localizedTitle = member.subject ? pageText(libraryTitleValue(member.subject.label), locale) : null;
  const title = localizedTitle?.text ?? m.library_subject_unavailable();
  const href = member.subject ? subjectHref({ id: member.subject.id, label: title }, locale).href : undefined;
  return (
    <ListRow
      className="flex flex-wrap items-start gap-3 rounded-xl py-3"
      data-member={member.id}
      onPointerDown={
        owner && !busy
          ? (event) => {
              const target = event.target;
              if (!(target instanceof Element) || !target.closest('[data-drag-handle]')) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.dataset.dragging = member.id;
            }
          : undefined
      }
      onPointerUp={
        owner
          ? (event) => {
              if (event.currentTarget.dataset.dragging !== member.id) return;
              delete event.currentTarget.dataset.dragging;
              dropMember(member.id, event);
            }
          : undefined
      }
      onDragOver={owner && !busy ? (event) => event.preventDefault() : undefined}
      onDrop={
        owner && !busy
          ? (event) => {
              event.preventDefault();
              const source = document.querySelector<HTMLElement>('[data-member][data-dragging]');
              const memberId = event.dataTransfer.getData(collectionMemberDragType) || source?.dataset.dragging;
              if (memberId) placeMember(memberId, member.id);
              source?.removeAttribute('data-dragging');
            }
          : undefined
      }
    >
      {owner ? (
        <ListRowControl>
          <span
            aria-hidden="true"
            className="inline-block h-10 w-6 shrink-0 cursor-grab touch-none select-none rounded-sm border border-border/70"
            data-drag-handle=""
            draggable={owner && !busy}
            onDragStart={(event) => {
              dragged.current = true;
              event.currentTarget.closest<HTMLElement>('[data-member]')?.setAttribute('data-dragging', member.id);
              event.dataTransfer.setData(collectionMemberDragType, member.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={(event) => {
              const memberId = event.dataTransfer.getData(collectionMemberDragType);
              event.currentTarget.closest<HTMLElement>('[data-member]')?.removeAttribute('data-dragging');
              if (dragged.current && memberId === member.id) dropMemberAt(member.id, event.clientX, event.clientY);
              dragged.current = false;
            }}
          />
        </ListRowControl>
      ) : null}
      <div
        className="pointer-events-none w-[72px] shrink-0 overflow-hidden rounded sm:w-24"
        style={{ aspectRatio: ratio.replace(':', ' / ') }}
      >
        <SubjectCover subject={member.subject} ratio={ratio} size="fill" />
      </div>
      <div className="min-w-0 flex-1 basis-[12rem] space-y-0.5">
        {href ? (
          <ListRowLink href={href} lang={localizedTitle?.lang}>
            {title}
          </ListRowLink>
        ) : null}
        <div aria-hidden={href ? 'true' : undefined} lang={localizedTitle?.lang} className="font-medium break-words">
          {title}
        </div>
        {member.subject?.typeLabel ? <p className="text-sm text-muted-foreground">{member.subject.typeLabel}</p> : null}
        {member.note ? <MemberNote note={member.note} layout="list" /> : null}
      </div>
      {owner ? (
        <ListRowControl className="w-full space-y-2 sm:ml-auto sm:w-auto sm:max-w-[22rem]">
          <MemberRowControls
            member={member}
            index={index}
            members={members}
            firstPage={firstPage}
            busy={busy}
            moveMember={moveMember}
            saveNote={saveNote}
            removeMember={removeMember}
          />
        </ListRowControl>
      ) : null}
    </ListRow>
  );
}
