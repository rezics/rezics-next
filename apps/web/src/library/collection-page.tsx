import { batchRemoveCollectionMembers, transferCollectionMembers } from './collection-commands';
import { readCollectionDestination, type CollectionDestination } from './collection-read';
import { CollectionMemberDetails } from './collection-member-row';
import { ResourceAccessLink } from '../accounts/resource-access/link';
import { Cover } from '@rezics/ui/cover';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { MemberListRow } from '@rezics/ui/list-presentation';
import { ListRow } from '@rezics/ui/list-row';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
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
  restoreCollectionMember,
  updateCollection,
  updateMemberNote,
  type CollectionWriteResult,
} from './collection-edit';
import {
  collectionRenderPolicy,
  type CollectionPageResult,
  type CollectionPolicyPage,
  type EditableCollectionPage,
} from './collection-load';
import { admitsCollectionOperation, type CollectionMemberUndo } from './collection-records';
import type { CollectionMember, CollectionVisibility } from './reads';
import { pageHead, type HeadContext } from '../shell/head';
import { LibraryNavigation } from './library-nav';
import { libraryNavigationQuery } from './pins-read';
import { PinControlNotice, usePinControlActions } from './pin-control';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { validatePublicOrigin } from '../shell/origin';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { BookmarkIcon, EllipsisIcon, HeartIcon, Share2Icon } from 'lucide-react';
import {
  collectionMemberRatio,
  collectionPageAddress,
  reorderCollectionMembers,
  type CollectionListPresentations,
} from './collection-presentation';
import { FollowTargetControl } from './follow-target-control';
import {
  CollectionMemberList,
  CollectionPresentationFields,
  applyCollectionMemberEditPlan,
  buildCollectionMemberEditPlan,
} from './collection-editor';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export function collectionPageHead(
  page: Pick<CollectionPageResult, 'id' | 'title' | 'description' | 'curator' | 'members'> & CollectionPolicyPage,
  suppliedContext?: HeadContext,
  laterPage = false,
) {
  const path = `/collections/${encodeURIComponent(page.id)}`;
  const context = suppliedContext ?? {
    origin: publicOrigin(),
    locale: getLocale(),
    path,
  };
  const policy = collectionRenderPolicy(page, laterPage);
  if (page.visibility === 'private')
    return pageHead({ title: m.not_found_heading(), robots: 'noindex, follow' }, context);
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
            ...(policy.completeItemList
              ? {
                  mainEntity: {
                    '@type': 'ItemList',
                    numberOfItems: items.length,
                    itemListOrder: 'https://schema.org/ItemListOrderAscending',
                    itemListElement: items,
                  },
                }
              : {}),
          },
          { '@type': 'BreadcrumbList', itemListElement: breadcrumbs },
        ],
      },
      ...(!policy.indexable ? { robots: 'noindex, follow' } : {}),
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

function collectionViewAddress(
  id: string,
  layout: 'grid' | 'list',
  cursor: string | undefined,
  search?: Record<string, string | string[]>,
) {
  const [path, query] = collectionPageAddress(getLocale(), id, cursor ?? '', search).split('?');
  const params = new URLSearchParams(query);
  if (!cursor) params.delete('cursor');
  if (layout === 'grid') params.set('layout', 'grid');
  const suffix = params.toString();
  return `${path}${suffix ? `?${suffix}` : ''}`;
}

export function CollectionPage({
  page,
  queryKey,
  refreshPage,
  readEditorPage,
  cursor,
  layout = 'list',
  search,
}: {
  page: EditableCollectionPage;
  queryKey: readonly unknown[];
  refreshPage: () => Promise<EditableCollectionPage>;
  readEditorPage?: () => Promise<EditableCollectionPage>;
  cursor: string | undefined;
  layout?: 'grid' | 'list';
  search?: Record<string, string | string[]>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const updateAdmitted = admitsCollectionOperation(page.viewerActions, 'collection:update', 'collection.update');
  // The editor also needs the loaded private metadata, independently of native action admission.
  const owner = updateAdmitted && page.visibility !== null && (page.memberState ?? 'ready') === 'ready';
  const deleteAdmitted = admitsCollectionOperation(page.viewerActions, 'collection:delete', 'collection.delete');
  const navigation = useQuery(libraryNavigationQuery(getLocale(), 100));
  const pins = navigation.data?.pins ?? { state: 'closed' as const };
  const navigationCollections = navigation.data?.collections ?? [];
  const pinActions = usePinControlActions({ collectionId: page.id, pins, mode: 'collection' });
  const [hydrated, setHydrated] = useState(false);
  const [members, setMembers] = useState(page.members);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const writeKeys = useRef(new Map<string, string>());
  const [editing, setEditing] = useState(false);
  const [destinationId, setDestinationId] = useState('');
  const [destination, setDestination] = useState<CollectionDestination | null>(null);
  const [destinationLoading, setDestinationLoading] = useState(false);
  const [transfer, setTransfer] = useState<{ destination: CollectionDestination; memberIds: string[] } | null>(null);
  const [bulkUnavailable, setBulkUnavailable] = useState(false);
  const [batchRemovalIds, setBatchRemovalIds] = useState<ReadonlySet<string>>(new Set());
  const [editorMembers, setEditorMembers] = useState<CollectionMember[] | null>(null);
  const [title, setTitle] = useState(page.title);
  const storedKind = page.presentationKindSource === 'owner' ? (page.presentationKind ?? null) : null;
  const [kind, setKind] = useState(storedKind);
  const [coverMediaId, setCoverMediaId] = useState(page.coverMediaId ?? null);
  const [undo, setUndo] = useState<(CollectionMemberUndo & { key: string })[]>([]);
  const [description, setDescription] = useState(page.description ?? '');
  const [visibility, setVisibility] = useState<CollectionVisibility>(page.visibility ?? 'public');
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const [deletion, setDeletion] = useState<{ collectionId: string; revision: number; idempotencyKey: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState('');
  const snapshot = [
    page.id,
    page.revision,
    page.title,
    page.description ?? '',
    page.following,
    page.presentationKind,
    page.presentationKindSource,
    page.coverMediaId,
    page.visibility,
    page.memberState,
    page.members.map((member) => `${member.id}:${member.note ?? ''}`).join('\n'),
  ].join('\n');

  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    let current = true;
    setDestination(null);
    if (!editing || !destinationId) {
      setDestinationLoading(false);
      return;
    }
    setDestinationLoading(true);
    void readCollectionDestination({ data: destinationId })
      .then(
        (value) => {
          if (current) setDestination(value);
        },
        () => {
          if (current) setDestination(null);
        },
      )
      .finally(() => {
        if (current) setDestinationLoading(false);
      });
    return () => {
      current = false;
    };
  }, [editing, destinationId]);
  useEffect(() => {
    if (editing) {
      setConflict(true);
      return;
    }
    setMembers(page.members);
    setTitle(page.title);
    setKind(storedKind);
    setCoverMediaId(page.coverMediaId ?? null);
    setDescription(page.description ?? '');
    setVisibility(page.visibility ?? 'public');
    setSelectedIds(new Set());
    setConflict(false);
  }, [snapshot]);

  async function reloadCollection() {
    const refreshed = await refreshPage();
    queryClient.setQueryData(queryKey, refreshed);
    await router.invalidate();
  }

  async function beginEditing() {
    if (pending) return;
    setPending(true);
    setFailure('');
    try {
      const editable = readEditorPage ? await readEditorPage() : page;
      if (editable.revision !== page.revision) {
        setConflict(true);
        return;
      }
      if ((editable.memberState ?? 'ready') !== 'ready' || editable.filterStatus)
        throw new Error('Collection members are not ready');
      writeKeys.current.clear();
      setConflict(false);
      setEditorMembers(editable.members);
      setMembers(editable.members);
      setTitle(editable.title);
      setKind(editable.presentationKindSource === 'owner' ? (editable.presentationKind ?? null) : null);
      setCoverMediaId(editable.coverMediaId ?? null);
      setDescription(editable.description ?? '');
      setVisibility(editable.visibility ?? 'public');
      setSelectedIds(new Set());
      setBatchRemovalIds(new Set());
      setTransfer(null);
      setDestinationId('');
      setBulkUnavailable(false);
      setEditing(true);
    } catch {
      setFailure(m.error_message());
    } finally {
      setPending(false);
    }
  }

  function cancelEditing() {
    setBatchRemovalIds(new Set());
    setTransfer(null);
    setDestinationId('');
    setBulkUnavailable(false);
    setMembers(page.members);
    setEditorMembers(null);
    setTitle(page.title);
    setKind(storedKind);
    setCoverMediaId(page.coverMediaId ?? null);
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
    let currentRevision: number | undefined = page.revision;

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
      const initial = (editorMembers ?? page.members).filter((member) => !transfer?.memberIds.includes(member.id));
      const plan = buildCollectionMemberEditPlan(initial, members, page.firstPage);
      const fail = async (result: Extract<CollectionWriteResult, { ok: false }>) => {
        if (committed > 0) {
          await reloadCollection();
          setEditing(false);
          setConflict(false);
          setFailure(m.library_collection_save_partial({ count: committed }));
        } else if (result.reason === 'conflict') setConflict(true);
        else {
          setFailure(writeMessage(result));
          if (result.reason === 'unavailable' || result.reason === 'closed') setBulkUnavailable(true);
        }
      };
      if (
        title !== page.title ||
        description !== (page.description ?? '') ||
        visibility !== page.visibility ||
        kind !== storedKind ||
        coverMediaId !== (page.coverMediaId ?? null)
      ) {
        const result = await updateCollection({
          data: {
            collectionId: page.id,
            revision: page.revision,
            title,
            description,
            visibility,
            ...(kind !== storedKind ? { presentationKind: kind } : {}),
            ...(coverMediaId !== (page.coverMediaId ?? null) ? { coverMediaId } : {}),
            idempotencyKey: keyFor([page.id, page.revision, title, description, visibility, kind, coverMediaId]),
          },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          if (result.reason === 'conflict') setConflict(true);
          else setFailure(writeMessage(result));
          return;
        }
        currentRevision = result.revision;
        committed += 1;
      }

      if (transfer) {
        if (currentRevision === undefined) throw new Error('Missing source revision');
        const data = {
          collectionId: page.id,
          revision: currentRevision,
          memberIds: transfer.memberIds,
          destinationCollectionId: transfer.destination.id,
          destinationRevision: transfer.destination.revision,
          after: null,
        };
        const result = await transferCollectionMembers({
          data: { ...data, idempotencyKey: keyFor(data) },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          await fail(result);
          return;
        }
        currentRevision = result.revision;
        committed += 1;
      }
      const removals = plan.filter((operation) => operation.kind === 'remove');
      const batchRemoval = removals.length > 1 || removals.some((operation) => batchRemovalIds.has(operation.memberId));
      if (batchRemoval) {
        if (currentRevision === undefined) throw new Error('Missing source revision');
        const data = {
          collectionId: page.id,
          revision: currentRevision,
          memberIds: removals.map((operation) => operation.memberId),
        };
        const result = await batchRemoveCollectionMembers({
          data: { ...data, idempotencyKey: keyFor(data) },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          await fail(result);
          return;
        }
        currentRevision = result.revision;
        committed += 1;
        setUndo((current) => [
          ...current,
          ...result.undo
            .filter((episode) => !current.some((item) => item.deletionId === episode.deletionId))
            .map((episode) => ({ ...episode, key: crypto.randomUUID() })),
        ]);
      }
      const applied = await applyCollectionMemberEditPlan(
        batchRemoval ? plan.filter((operation) => operation.kind !== 'remove') : plan,
        async (operation) => {
          const common = { collectionId: page.id, idempotencyKey: keyFor([page.id, operation, currentRevision]) };
          if (operation.kind === 'remove') {
            if (currentRevision === undefined) return { ok: false, reason: 'unavailable' };
            const result = await removeCollectionMember({
              data: { ...common, memberId: operation.memberId, revision: currentRevision },
              headers: csrfHeaders(),
            });
            if (result.ok) {
              currentRevision = result.revision;
              const episode = result.undo;
              if (episode)
                setUndo((current) =>
                  current.some((item) => item.deletionId === episode.deletionId)
                    ? current
                    : [...current, { ...episode, key: crypto.randomUUID() }],
                );
            }
            return result;
          }
          if (operation.kind === 'move')
            return moveCollectionMember({
              data: { ...common, memberId: operation.memberId, after: operation.after },
              headers: csrfHeaders(),
            });
          return updateMemberNote({
            data: { ...common, memberId: operation.memberId, note: operation.note },
            headers: csrfHeaders(),
          });
        },
      );
      committed += applied.completed;
      if (applied.failed) {
        if (committed > 0) {
          await reloadCollection();
          setEditing(false);
          setConflict(false);
          setFailure(m.library_collection_save_partial({ count: committed }));
        } else if (applied.failed.reason === 'conflict') setConflict(true);
        else setFailure(m.error_message());
        return;
      }
      await reloadCollection();
      setEditing(false);
      setConflict(false);
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
        setConflict(false);
        setFailure(m.library_collection_save_partial({ count: committed }));
      } else setFailure(m.error_message());
    } finally {
      setPending(false);
    }
  }

  async function undoRemoval(episode: CollectionMemberUndo & { key: string }) {
    if (pending || !owner) return;
    setPending(true);
    setFailure('');
    try {
      const { key, ...deletion } = episode;
      const result = await restoreCollectionMember({
        data: { ...deletion, idempotencyKey: key },
        headers: csrfHeaders(),
      });
      if (result.ok || (!result.ok && result.reason === 'expired'))
        setUndo((current) => current.filter((item) => item.deletionId !== episode.deletionId));
      if (result.ok) await reloadCollection();
      else setFailure(result.reason === 'expired' ? m.library_restore_expired() : writeMessage(result));
    } catch {
      setFailure(m.error_message());
    } finally {
      setPending(false);
    }
  }

  async function removeCollection() {
    if (!deletion || deleting || !deleteAdmitted) return;
    setDeleting(true);
    setDeleteFailure('');
    try {
      const result = await deleteCollection({ data: deletion, headers: csrfHeaders() });
      if (!result.ok) {
        setDeleteFailure(result.reason === 'conflict' ? m.library_collection_conflict() : writeMessage(result));
        return;
      }
      window.location.assign(`/${getLocale()}/library/collections`);
    } catch {
      setDeleteFailure(m.error_message());
    } finally {
      setDeleting(false);
    }
  }

  function setMemberOrder(memberId: string, after: string | null) {
    setMembers((current) => reorderCollectionMembers(current, memberId, after, page.firstPage));
  }

  async function copyLink(href: string) {
    try {
      await navigator.clipboard.writeText(`${location.origin}${href}`);
    } catch {
      setFailure(m.error_message());
    }
  }

  const visibleVisibility = page.visibility ?? page.disclosedVisibility;
  const destinations = navigationCollections.filter(
    (collection) => collection.id !== page.id && collection.membershipKind !== 'dynamic',
  );
  const memberDraftChanged =
    editing &&
    buildCollectionMemberEditPlan(
      (editorMembers ?? page.members).filter((member) => !transfer?.memberIds.includes(member.id)),
      members,
      page.firstPage,
    ).length > 0;
  return (
    <div className="w-full min-w-0 space-y-6 text-foreground">
      <LibraryNavigation current={{ collectionId: page.id }} pins={pins} collections={navigationCollections} />
      <article className="w-full min-w-0 space-y-7">
        <header className="flex min-w-0 flex-col gap-4 rounded-2xl bg-card px-4 py-5 sm:px-6 sm:py-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            {page.cover ? (
              <div className="w-24 sm:w-40" data-collection-cover-source={page.coverSource}>
                <Cover
                  subject={{ id: page.id, title: page.title, types: [] }}
                  cover={page.cover}
                  size="fill"
                  src={coverSrc}
                  decorative
                  ratio={collectionMemberRatio(
                    page.presentationKind ? { type: page.presentationKind } : null,
                    page.typeRatios,
                    page.listPresentations,
                  )}
                />
              </div>
            ) : null}
            <PageHeading>{page.title}</PageHeading>
            <div className="flex min-w-0" data-collection-owner>
              {page.curator?.handle ? (
                <a
                  href={`/${getLocale()}/@${encodeURIComponent(page.curator.handle)}`}
                  className="min-w-0 text-sm text-muted-foreground hover:text-foreground"
                >
                  <AccountRef account={page.curator} avatar />
                </a>
              ) : (
                <AccountRef account={page.curator} avatar />
              )}
            </div>
            <MetaLine
              items={[
                page.memberCount == null ? null : m.library_member_count({ count: page.memberCount }),
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
            <ResourceAccessLink resourceId={page.id} />
            <CollectionReadActions
              onShare={() => copyLink(collectionHref(page.id))}
              entries={[
                ...(owner
                  ? [
                      {
                        type: 'item' as const,
                        label: m.library_collection_edit(),
                        onSelect: beginEditing,
                        disabled: !hydrated || pending || editing,
                      },
                    ]
                  : []),
                ...pinActions.entries,
                ...(deleteAdmitted
                  ? [
                      {
                        type: 'destructive' as const,
                        label: m.library_collection_delete(),
                        disabled: !hydrated || pending || editing,
                        onSelect: () => {
                          setDeleteFailure('');
                          setDeletion({
                            collectionId: page.id,
                            revision: page.revision,
                            idempotencyKey: crypto.randomUUID(),
                          });
                        },
                      },
                    ]
                  : []),
              ]}
            />
            <PinControlNotice notice={pinActions.notice} />
            <FollowTargetControl
              targetId={page.id}
              {...(page.visibility === null ? { following: page.following } : {})}
            />
          </div>
        </header>
        <p className="text-sm text-muted-foreground">{m.library_collection_social_unavailable()}</p>
        {page.viewerActions?.state === 'unavailable' ? (
          <p role="status">{m.library_collection_actions_unavailable()}</p>
        ) : null}
        {page.presentationKindSource === 'pending' || page.coverSource === 'pending' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.library_collection_kind_pending()}
          </p>
        ) : null}
        <AlertDialog
          open={deletion !== null}
          onOpenChange={(open, details) => {
            if (!open && deleting) {
              details.cancel();
              return;
            }
            if (!open) setDeletion(null);
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{m.library_collection_delete_title()}</AlertDialogTitle>
              <AlertDialogDescription>{m.library_collection_delete_description()}</AlertDialogDescription>
            </AlertDialogHeader>
            {deleteFailure ? <p role="alert">{deleteFailure}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{m.library_collection_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleting || !deleteAdmitted}
                aria-busy={deleting}
                onClick={() => void removeCollection()}
              >
                {m.library_collection_delete_confirm()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {owner && undo.length ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 p-3"
            data-collection-undo
          >
            <p className="basis-full text-sm">{m.library_collection_undo_note()}</p>
            {undo.map((episode, index) => (
              <Button
                key={episode.deletionId}
                variant="outline"
                type="button"
                disabled={pending || editing}
                onClick={() => void undoRemoval(episode)}
              >
                {m.editor_undo()} {undo.length > 1 ? index + 1 : ''}
              </Button>
            ))}
          </div>
        ) : null}
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
            <CollectionPresentationFields
              types={page.presentationTypes}
              kind={kind}
              onKindChange={setKind}
              coverMediaId={coverMediaId}
              onCoverChange={setCoverMediaId}
              members={page.members}
              disabled={pending}
            />
            {page.presentationKindSource === 'pending' ? (
              <p role="status" className="text-sm text-muted-foreground">
                {m.library_collection_kind_pending()}
              </p>
            ) : null}
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
        {!editing ? (
          <nav aria-label={m.library_layout()} data-slot="collection-layout" className="flex items-center gap-2">
            <a
              className={buttonClass}
              href={collectionViewAddress(page.id, 'list', cursor, search)}
              aria-current={layout === 'list' ? 'page' : undefined}
            >
              {m.library_layout_list()}
            </a>
            <a
              className={buttonClass}
              href={collectionViewAddress(page.id, 'grid', cursor, search)}
              aria-current={layout === 'grid' ? 'page' : undefined}
            >
              {m.library_layout_grid()}
            </a>
          </nav>
        ) : null}
        <CollectionFilterFeedback
          id={page.id}
          {...(page.filter === undefined ? {} : { filter: page.filter })}
          {...(page.filterIgnored === undefined ? {} : { ignored: page.filterIgnored })}
          {...(page.filterStatus === undefined ? {} : { status: page.filterStatus })}
          {...(page.filterType === undefined ? {} : { filterType: page.filterType })}
          empty={(editing ? members : page.members).length === 0 && (page.memberState ?? 'ready') === 'ready'}
          unavailable={page.memberState === 'unavailable'}
          emptyLabel={m.library_collection_empty()}
        />
        <section aria-label={m.library_collection_members()}>
          <h2 className="sr-only">{m.library_collection_members()}</h2>
          {editing && owner ? (
            <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl bg-muted/40 p-3" data-collection-selection>
              <p className="me-auto self-center text-sm text-muted-foreground">
                {m.library_collection_selection_count({ count: selectedIds.size })}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={pending || conflict || bulkUnavailable || selectedIds.size === 0}
                onClick={() => {
                  setBatchRemovalIds((current) => new Set([...current, ...selectedIds]));
                  setMembers((current) => current.filter((member) => !selectedIds.has(member.id)));
                  setSelectedIds(new Set());
                }}
              >
                {m.library_collection_remove_selected()}
              </Button>
              <label className="min-w-0 basis-full space-y-1 sm:basis-auto">
                <span className="text-sm">{m.library_collection_move_destination()}</span>
                <select
                  className={fieldClass}
                  value={destinationId}
                  disabled={pending || conflict || transfer !== null}
                  onChange={(event) => setDestinationId(event.target.value)}
                >
                  <option value="">{m.library_collection_choose_destination()}</option>
                  {destinations.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.title}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  conflict ||
                  bulkUnavailable ||
                  destinationLoading ||
                  !destination ||
                  selectedIds.size === 0 ||
                  memberDraftChanged ||
                  transfer !== null
                }
                onClick={() => {
                  if (!destination) return;
                  const memberIds = members.filter((member) => selectedIds.has(member.id)).map((member) => member.id);
                  setTransfer({ destination, memberIds });
                  setMembers((current) => current.filter((member) => !selectedIds.has(member.id)));
                  setSelectedIds(new Set());
                }}
              >
                {m.library_collection_move_selected()}
              </Button>
              {transfer ? (
                <p role="status" className="basis-full text-sm">
                  {m.library_collection_move_pending({
                    count: transfer.memberIds.length,
                    title: transfer.destination.title,
                  })}
                </p>
              ) : null}
              {memberDraftChanged && !transfer ? (
                <p className="basis-full text-sm text-muted-foreground">{m.library_collection_move_save_first()}</p>
              ) : null}
              {bulkUnavailable ? (
                <p className="basis-full text-sm text-muted-foreground">{m.library_collection_batch_unavailable()}</p>
              ) : null}
              {!destinationLoading && (!destinations.length || (destinationId && !destination) || bulkUnavailable) ? (
                <p className="basis-full text-sm text-muted-foreground">{m.library_collection_move_unavailable()}</p>
              ) : null}
            </div>
          ) : null}
          {page.memberState === 'preparing' ? (
            <div className="space-y-3">
              <p role="status">{m.library_dynamic_preparing()}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void reloadCollection().catch(() => setFailure(m.error_message()))}
              >
                {m.library_collection_reload()}
              </Button>
            </div>
          ) : null}
          {page.memberState === 'unavailable' ? (
            <div className="space-y-3">
              <p role="alert">{m.library_dynamic_unavailable()}</p>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void reloadCollection().catch(() => setFailure(m.error_message()))}
              >
                {m.library_collection_reload()}
              </Button>
            </div>
          ) : null}
          {!editing ? (
            <CollectionReadMembers
              members={page.memberState === 'preparing' || page.memberState === 'unavailable' ? [] : page.members}
              layout={layout}
              presentationKind={page.presentationKind}
              typeRatios={page.typeRatios}
              listPresentations={page.listPresentations}
              onCopy={(member) => {
                if (member.subject)
                  void copyLink(
                    subjectHref(
                      {
                        id: member.subject.id,
                        label: pageText(libraryTitleValue(member.subject.label), getLocale()).text,
                      },
                      getLocale(),
                    ).href,
                  );
              }}
            />
          ) : (
            <CollectionMemberList
              members={members}
              typeRatios={page.typeRatios}
              listPresentations={page.listPresentations}
              editing={editing && owner}
              firstPage={page.firstPage}
              busy={pending}
              selectedIds={selectedIds}
              onSelectionChange={(memberId, selected) =>
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (selected && next.size < 100 && members.some((member) => member.id === memberId))
                    next.add(memberId);
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
          )}
        </section>
        {page.next && !editing ? (
          <nav aria-label={m.library_collection_members()}>
            <a href={collectionViewAddress(page.id, layout, page.next, search)} className={buttonClass}>
              {m.library_collection_more()}
            </a>
          </nav>
        ) : null}
      </article>
    </div>
  );
}

/** Current product actions only; missing Collection social producers never become pin/follow writes. */
export function CollectionReadActions({
  onShare,
  entries = [],
}: {
  onShare: () => void | Promise<void>;
  entries?: MenuEntry[];
}) {
  return (
    <>
      <Button type="button" variant="outline" disabled title={m.library_collection_social_unavailable()}>
        <HeartIcon aria-hidden="true" />
        {m.reaction_like()}
      </Button>
      <Button type="button" variant="outline" disabled title={m.library_collection_social_unavailable()}>
        <BookmarkIcon aria-hidden="true" />
        {m.library_subject_save()}
      </Button>
      <Button type="button" variant="outline" onClick={onShare}>
        <Share2Icon aria-hidden="true" />
        {m.library_collection_share()}
      </Button>
      <Menu
        title={m.library_collection_actions()}
        backLabel={m.library_collection_cancel()}
        trigger={
          <Button type="button" aria-label={m.library_collection_actions()} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
        entries={[...entries, { type: 'item', label: m.report_action(), disabled: true, onSelect: () => {} }]}
      />
    </>
  );
}

type ReadMember = {
  id?: string;
  subject: CollectionMember['subject'];
  facts?: CollectionMember['facts'];
  note?: string | null;
};

/** Read presentation is separate from the existing occurrence editor; it performs no enrichment reads. */
export function CollectionReadMembers<Member extends ReadMember>({
  members,
  layout = 'list',
  presentationKind,
  typeRatios,
  listPresentations,
  onCopy,
}: {
  members: readonly Member[];
  layout?: 'grid' | 'list';
  presentationKind?: string | null | undefined;
  typeRatios?: Readonly<Record<string, string>> | undefined;
  listPresentations?: CollectionListPresentations | undefined;
  onCopy: (member: Member) => void | Promise<void>;
}) {
  const locale = getLocale();
  const items = members.map((member, index) => {
    const subject = member.subject;
    const key = member.id ?? `${subject?.id ?? 'unavailable'}:${index}`;
    if (!subject) {
      return layout === 'grid' ? (
        <div key={key} role="listitem" className="py-4 text-sm text-muted-foreground">
          {m.library_subject_unavailable()}
        </div>
      ) : (
        <ListRow key={key} className="py-4 text-muted-foreground">
          {m.library_subject_unavailable()}
        </ListRow>
      );
    }
    const title = pageText(libraryTitleValue(subject.label), locale);
    const presentation = listPresentations?.[subject.type];
    const menu = (
      <Menu
        title={m.library_collection_actions()}
        backLabel={m.library_collection_cancel()}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${m.library_collection_actions()}: ${title.text}`}
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
        entries={[{ type: 'item', label: m.library_collection_copy(), onSelect: () => void onCopy(member) }]}
      />
    );
    if (layout === 'grid')
      return (
        <div key={key} role="listitem" data-slot="collection-member-card" className="min-w-0">
          <CoverCard
            href={subjectHref({ id: subject.id, label: title.text }, locale).href}
            title={title.text}
            {...(title.lang ? { titleLang: title.lang } : {})}
            cover={{
              subject: { id: subject.id, title: title.text, types: [subject.type] },
              cover: subject.cover,
              src: coverSrc,
              ratio: collectionMemberRatio(subject, typeRatios, listPresentations),
              ...(presentation ? { listPresentation: presentation } : {}),
            }}
            state={
              <div className="space-y-1">
                <CollectionMemberDetails member={member} listPresentations={listPresentations} />
                {member.note ? (
                  <p
                    data-slot="collection-member-note"
                    className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground"
                  >
                    {member.note}
                  </p>
                ) : null}
              </div>
            }
            menuTrigger={menu}
          />
        </div>
      );
    return (
      <MemberListRow
        key={key}
        href={subjectHref({ id: subject.id, label: title.text }, locale).href}
        subject={{ id: subject.id, title: title.text, types: [subject.type] }}
        cover={subject.cover}
        src={coverSrc}
        title={title.text}
        {...(title.lang ? { titleLang: title.lang } : {})}
        ratio={collectionMemberRatio(subject, typeRatios, listPresentations)}
        {...(presentation ? { listPresentation: presentation } : {})}
        trailing={menu}
      >
        <CollectionMemberDetails member={member} listPresentations={listPresentations} />
        {member.note ? (
          <p data-slot="collection-member-note" className="whitespace-pre-wrap text-sm text-muted-foreground">
            {member.note}
          </p>
        ) : null}
      </MemberListRow>
    );
  });
  return layout === 'grid' ? (
    <div role="list" className="min-w-0" data-collection-members>
      <CoverGrid
        ratio={collectionMemberRatio(
          presentationKind ? { type: presentationKind } : null,
          typeRatios,
          listPresentations,
        )}
      >
        {items}
      </CoverGrid>
    </div>
  ) : (
    <ul className="min-w-0 space-y-3" data-collection-members>
      {items}
    </ul>
  );
}
