import { Exposure, useOperation } from '../kernel/exposure';
import { ContentActions } from '@rezics/ui/content-actions';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { MetaLine } from '@rezics/ui/meta-line';
import { RelativeTime } from '@rezics/ui/relative-time';
import { useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import type { CollectionMember, CollectionVisibility } from './reads';
import { pageHead, type HeadContext } from '../shell/head';
import { LibraryNavigation } from './library-nav';
import { libraryNavigationQuery } from './pins-read';
import { PinControl, PinControlNotice, usePinControlActions } from './pin-control';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { validatePublicOrigin } from '../shell/origin';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { EllipsisIcon, Share2Icon } from 'lucide-react';
import { reorderCollectionMembers } from './collection-presentation';
import {
  CollectionMemberList,
  applyCollectionMemberEditPlan,
  buildCollectionMemberEditPlan,
} from './collection-editor';

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

const visibilities = ['private', 'unlisted', 'public'] as const;
export const fieldClass =
  'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary';
export const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

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

function visibilityNote(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public_note();
  if (visibility === 'unlisted') return m.library_visibility_unlisted_note();
  return m.library_visibility_private_note();
}

function writeMessage(result: Extract<CollectionWriteResult, { ok: false }>): string {
  return result.reason === 'full' ? m.library_collection_full() : m.error_message();
}

function collectionHref(id: string) {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
}

export function CollectionPage({
  page,
  queryKey,
  refreshPage,
  cursor,
}: {
  page: EditableCollectionPage;
  queryKey: readonly unknown[];
  refreshPage: () => Promise<EditableCollectionPage>;
  cursor: string | undefined;
  layout?: 'grid' | 'list';
  search?: Record<string, string | string[]>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const updateAdmitted = useOperation('collection.update');
  const owner = page.visibility !== null && updateAdmitted;
  const canFollow = useOperation('follow.put');
  const navigation = useQuery(libraryNavigationQuery(getLocale(), 100));
  const pins = navigation.data?.pins ?? { state: 'closed' as const };
  const navigationCollections = navigation.data?.collections ?? [];
  const pinActions = usePinControlActions({ collectionId: page.id, pins, mode: 'collection' });
  const [hydrated, setHydrated] = useState(false);
  const [members, setMembers] = useState(page.members);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const writeKeys = useRef(new Map<string, string>());
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description ?? '');
  const [visibility, setVisibility] = useState<CollectionVisibility>(page.visibility ?? 'public');
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [following, setFollowing] = useState(page.following);
  const [pending, setPending] = useState(false);
  const snapshot = [
    page.id,
    page.revision,
    page.title,
    page.description ?? '',
    page.following,
    page.members.map((member) => `${member.id}:${member.note ?? ''}`).join('\n'),
  ].join('\n');

  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (editing) {
      setConflict(true);
      return;
    }
    setMembers(page.members);
    setTitle(page.title);
    setDescription(page.description ?? '');
    setVisibility(page.visibility ?? 'public');
    setFollowing(page.following);
    setSelectedIds(new Set());
    setConflict(false);
  }, [snapshot]);

  async function reloadCollection() {
    const refreshed = await refreshPage();
    queryClient.setQueryData(queryKey, refreshed);
    await router.invalidate();
  }

  function beginEditing() {
    writeKeys.current.clear();
    setFailure('');
    setConflict(false);
    setMembers(page.members);
    setTitle(page.title);
    setDescription(page.description ?? '');
    setVisibility(page.visibility ?? 'public');
    setSelectedIds(new Set());
    setEditing(true);
  }

  function cancelEditing() {
    setMembers(page.members);
    setTitle(page.title);
    setDescription(page.description ?? '');
    setVisibility(page.visibility ?? 'public');
    setSelectedIds(new Set());
    setConflict(false);
    setFailure('');
    setEditing(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending || conflict || !owner) return;
    setPending(true);
    setFailure('');
    setConflict(false);
    let committed = 0;

    const keyFor = (operation: unknown) => {
      const fingerprint = JSON.stringify(operation);
      let key = writeKeys.current.get(fingerprint);
      if (!key) {
        key = crypto.randomUUID();
        writeKeys.current.set(fingerprint, key);
      }
      return key;
    };
    try {
      const plan = buildCollectionMemberEditPlan(page.members, members, page.firstPage);
      if (title !== page.title || description !== (page.description ?? '') || visibility !== page.visibility) {
        const result = await updateCollection({
          data: {
            collectionId: page.id,
            revision: page.revision,
            title,
            description,
            visibility,
            idempotencyKey: keyFor([page.id, page.revision, title, description, visibility]),
          },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          if (result.reason === 'conflict') setConflict(true);
          else setFailure(writeMessage(result));
          return;
        }
        committed += 1;
      }

      const applied = await applyCollectionMemberEditPlan(plan, async (operation) => {
        const common = { collectionId: page.id, idempotencyKey: keyFor([page.id, operation]) };
        if (operation.kind === 'remove')
          return removeCollectionMember({ data: { ...common, memberId: operation.memberId }, headers: csrfHeaders() });
        if (operation.kind === 'move')
          return moveCollectionMember({
            data: { ...common, memberId: operation.memberId, after: operation.after },
            headers: csrfHeaders(),
          });
        return updateMemberNote({
          data: { ...common, memberId: operation.memberId, note: operation.note },
          headers: csrfHeaders(),
        });
      });
      committed += applied.completed;
      if (applied.failed) {
        if (committed > 0) {
          await reloadCollection();
          setEditing(false);
          setFailure(m.library_collection_save_partial({ count: committed }));
        } else if (applied.failed.reason === 'conflict') setConflict(true);
        else setFailure(m.error_message());
        return;
      }
      await reloadCollection();
      setEditing(false);
      setSelectedIds(new Set());
      setFailure('');
    } catch {
      if (committed > 0) {
        try {
          await reloadCollection();
        } catch {
          // Keep the failure visible even when refresh cannot confirm already accepted writes.
        }
        setEditing(false);
        setFailure(m.library_collection_save_partial({ count: committed }));
      } else setFailure(m.error_message());
    } finally {
      setPending(false);
    }
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
    if (!result.ok) {
      setFailure(writeMessage(result));
      throw new Error(writeMessage(result));
    }
    window.location.assign(`/${getLocale()}/library/collections`);
  }

  async function toggleFollow() {
    if (!hydrated || pending || following === null) return;
    setPending(true);
    setFailure('');
    try {
      const result = await setCollectionFollow({
        data: { collectionId: page.id, follow: !following, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      });
      if (result.ok) setFollowing(!following);
      else setFailure(writeMessage(result));
    } catch {
      setFailure(m.error_message());
    } finally {
      setPending(false);
    }
  }

  function setMemberOrder(memberId: string, after: string | null) {
    setMembers((current) => reorderCollectionMembers(current, memberId, after, page.firstPage));
  }

  function copyLink(href: string) {
    void navigator.clipboard.writeText(`${location.origin}${href}`).catch(() => setFailure(m.error_message()));
  }

  const visibleVisibility = page.visibility ?? page.disclosedVisibility;
  return (
    <div className="w-full min-w-0 space-y-6 text-foreground">
      <LibraryNavigation current={{ collectionId: page.id }} pins={pins} collections={navigationCollections} />
      <article className="w-full min-w-0 space-y-7">
        <header className="flex min-w-0 flex-col gap-4 rounded-2xl bg-card px-4 py-5 sm:px-6 sm:py-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <PageHeading>{page.title}</PageHeading>
            {page.curator ? (
              <a
                href={`/${getLocale()}/@${encodeURIComponent(page.curator.handle ?? '')}`}
                className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <AccountRef account={page.curator} avatar />
              </a>
            ) : (
              <AccountRef account={null} avatar />
            )}
            <MetaLine
              items={[
                page.memberCount === null ? null : m.library_member_count({ count: page.memberCount }),
                visibleVisibility ? visibilityLabel(visibleVisibility) : null,
                <span>
                  {m.library_collection_updated()} <RelativeTime value={page.updatedAt} locale={getLocale()} />
                </span>,
              ]}
            />
            {page.description ? (
              <p className="max-w-4xl whitespace-pre-wrap text-muted-foreground">{page.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            {owner && !pending && !editing ? (
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
                onCopyLink={() => copyLink(collectionHref(page.id))}
                onEdit={beginEditing}
                onDelete={removeCollection}
              />
            ) : (
              <>
                <Menu
                  title={m.library_collection_actions()}
                  trigger={
                    <Button type="button" aria-label={m.library_collection_actions()} size="icon-sm" variant="ghost">
                      <EllipsisIcon aria-hidden="true" />
                    </Button>
                  }
                  entries={[
                    {
                      type: 'item',
                      label: m.library_collection_copy(),
                      onSelect: () => copyLink(collectionHref(page.id)),
                    },
                  ]}
                />
                {!owner ? <PinControl collectionId={page.id} pins={pins} mode="collection" /> : null}
              </>
            )}
            <Button type="button" variant="outline" onClick={() => copyLink(collectionHref(page.id))}>
              <Share2Icon aria-hidden="true" />
              {m.library_collection_copy()}
            </Button>
            {owner ? <PinControlNotice notice={pinActions.notice} /> : null}
            {canFollow && following !== null ? (
              <Exposure operation="follow.put">
                {following ? (
                  <span className="self-center text-sm text-muted-foreground">{m.library_following()}</span>
                ) : null}
                <Button variant="outline" disabled={!hydrated || pending} onClick={() => void toggleFollow()}>
                  {following ? m.library_follow_unfollow() : m.library_follow()}
                </Button>
              </Exposure>
            ) : null}
          </div>
        </header>

        {failure ? <p role="alert">{failure}</p> : null}
        {conflict ? (
          <p role="alert">
            {m.library_collection_conflict()}{' '}
            <button
              className="text-primary underline"
              type="button"
              disabled={pending}
              onClick={() => {
                cancelEditing();
                void reloadCollection().catch(() => setFailure(m.error_message()));
              }}
            >
              {m.library_collection_reload()}
            </button>
          </p>
        ) : null}

        {editing && owner ? (
          <form
            className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-6"
            onSubmit={(event) => void save(event)}
          >
            <h2 className="text-xl font-semibold">{m.library_collection_edit()}</h2>
            <label className="block max-w-3xl">
              {m.library_collection_title()}
              <input
                disabled={pending}
                className={fieldClass}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={512}
                value={title}
              />
            </label>
            <label className="block max-w-3xl">
              {m.library_collection_description()}
              <textarea
                disabled={pending}
                maxLength={20_000}
                className={fieldClass}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                value={description}
              />
            </label>
            <p className="text-sm text-muted-foreground" role="note">
              {m.library_collection_cover_unavailable()}
            </p>
            <VisibilityField onChange={setVisibility} value={visibility} disabled={pending} />
            <p className="text-sm text-muted-foreground">{m.library_collection_independent_writes()}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!hydrated || pending || conflict}>
                {pending ? m.library_collection_save_pending() : m.library_collection_save()}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={cancelEditing}>
                {m.library_collection_cancel()}
              </Button>
            </div>
          </form>
        ) : null}

        {!editing && page.filterProperties && page.filterParams ? (
          <CollectionFilters
            id={page.id}
            type={page.filterType ?? 'schema:Book'}
            properties={page.filterProperties}
            params={page.filterParams}
          />
        ) : null}
        <CollectionFilterFeedback
          id={page.id}
          {...(page.filter === undefined ? {} : { filter: page.filter })}
          {...(page.filterIgnored === undefined ? {} : { ignored: page.filterIgnored })}
          {...(page.filterStatus === undefined ? {} : { status: page.filterStatus })}
          {...(page.filterType === undefined ? {} : { filterType: page.filterType })}
          empty={members.length === 0}
          emptyLabel={m.library_collection_empty()}
        />
        <section aria-label={m.library_collection_members()}>
          <h2 className="sr-only">{m.library_collection_members()}</h2>
          {editing && owner ? (
            <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl bg-muted/40 p-3">
              <p className="me-auto self-center text-sm text-muted-foreground">
                {m.library_collection_selection_count({ count: selectedIds.size })}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={pending || selectedIds.size === 0}
                onClick={() => {
                  setMembers((current) => current.filter((member) => !selectedIds.has(member.id)));
                  setSelectedIds(new Set());
                }}
              >
                {m.library_collection_remove_selected()}
              </Button>
              <p className="basis-full text-sm text-muted-foreground">{m.library_collection_move_unavailable()}</p>
            </div>
          ) : null}
          <CollectionMemberList
            members={members}
            typeRatios={page.typeRatios}
            editing={editing && owner}
            firstPage={page.firstPage}
            busy={pending}
            selectedIds={selectedIds}
            onSelectionChange={(memberId, selected) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (selected) next.add(memberId);
                else next.delete(memberId);
                return next;
              })
            }
            onMove={setMemberOrder}
            onNoteChange={(memberId, note) =>
              setMembers((current) =>
                current.map((member) => (member.id === memberId ? { ...member, note: note || null } : member)),
              )
            }
            onRemove={(memberId) => {
              setMembers((current) => current.filter((member) => member.id !== memberId));
              setSelectedIds((current) => new Set([...current].filter((id) => id !== memberId)));
            }}
            onCopy={(memberId) => {
              const subject = members.find((member) => member.id === memberId)?.subject;
              if (subject)
                copyLink(
                  subjectHref(
                    { id: subject.id, label: pageText(libraryTitleValue(subject.label), getLocale()).text },
                    getLocale(),
                  ).href,
                );
            }}
          />
        </section>
        {page.next && !editing ? (
          <nav aria-label={m.library_collection_members()}>
            <a href={`${collectionHref(page.id)}?cursor=${encodeURIComponent(page.next)}`} className={buttonClass}>
              {m.library_collection_more()}
            </a>
          </nav>
        ) : null}
      </article>
    </div>
  );
}
