import { collectionTextIssue } from './collection-text-input';
import { batchRemoveCollectionMembers, transferCollectionMembers } from './collection-commands';
import { CollectionBatchRemoveConfirmation } from './collection-batch-remove';
import { useCollectionDraftNavigation } from './collection-draft-navigation';
import { CollectionMoveChooser, type CollectionMoveChoice } from './collection-move-chooser';
import { readCollectionDestination } from './collection-read';
import { readCollectionMovePlacements } from './collection-move-read';
import { CollectionAddMembers } from './collection-add-members';
import { CollectionMemberDetails } from './collection-member-row';
import { CollectionNoteReader } from './collection-note-reader';
import { CollectionDescriptionReader } from './collection-description-reader';
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
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import {
  useCollectionCurrentAdmission,
  type CollectionAdmission,
  type CollectionOperation,
} from './collection-current-admission';
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
  collectionRequestVariant,
  type CollectionPageResult,
  type CollectionPolicyPage,
  type EditableCollectionPage,
} from './collection-load';
import { admitsCollectionOperation, type CollectionMemberUndo } from './collection-records';
import type { CollectionMember, CollectionVisibility } from './reads';
import { pageHead, type HeadContext } from '../shell/head';
import { LibraryNavigationNotice, libraryNavigationMenuEntries } from './library-nav';
import { useCurrentLibraryNavigation } from './pins-current';
import { PinControlNotice, usePinControlActions } from './pin-control';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { validatePublicOrigin } from '../shell/origin';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { EllipsisIcon, Share2Icon } from 'lucide-react';
import {
  collectionMemberRatio,
  collectionPageAddress,
  reorderCollectionMembers,
  type CollectionListPresentations,
} from './collection-presentation';
import { FollowTargetControl } from './follow-target-control';
import { collectionPublicItemList } from './collection-public-document';
import { CollectionExport } from './collection-export';
import {
  BulkOccurrenceRemoveJourney,
  bulkOccurrenceRemoveRestoreAvailable,
  bulkOccurrenceRemoveUndoReceipt,
  captureBulkOccurrenceRemove,
  createBulkOccurrenceRemoveManifest,
} from './bulk-occurrence-remove';
import { BulkOccurrenceRemoveJourneyControls, BulkOccurrenceRemoveReview } from './bulk-occurrence-remove-review';
import { bulkStatusSender } from './bulk-status';
import { readBulkOperation } from './bulk-operation-recovery-server';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import {
  CollectionMemberList,
  CollectionMetadataEditor,
  fieldClass,
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
  const itemList = collectionPublicItemList(page, context, laterPage);
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
            ...(itemList ? { mainEntity: itemList } : {}),
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
export { fieldClass } from './collection-editor';
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
  return result.reason === 'full'
    ? m.library_collection_full()
    : result.reason === 'unsupported'
      ? m.library_collection_move_unsupported()
      : m.error_message();
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

type BoundaryMove = {
  intent: Readonly<{
    context: string;
    title: string;
    placement: 'start' | 'end';
    data: Readonly<{ collectionId: string; memberId: string; after?: null; idempotencyKey: string }>;
  }>;
  phase: 'pending' | 'unknown' | 'refused' | 'confirmed' | 'done';
  reading: boolean;
  refusal?: string;
};

type CollectionTransferReview = CollectionMoveChoice & {
  sourceId: string;
  sourceTitle: string;
  sourceRevision: number;
  sourceHref: string;
  destinationHref: string;
  occurrences: ReadonlyArray<{ id: string; title: string }>;
  idempotencyKey: string;
};

type CollectionTransferReceipt = {
  sourceId: string;
  destinationId: string;
  sourceTitle: string;
  destinationTitle: string;
  sourceHref: string;
  destinationHref: string;
  sourceRevision: number;
  destinationRevision: number;
  state: 'reading' | 'ready' | 'unavailable';
};

/** Members read recovery shares the active editor's fence, but never starts a writer. */
export function CollectionMembersStatus({
  state,
  retrying,
  disabled,
  onRetry,
}: {
  state: NonNullable<EditableCollectionPage['memberState']>;
  retrying: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (state === 'ready') return null;
  return (
    <div className="space-y-3" aria-busy={retrying}>
      <p role={state === 'preparing' ? 'status' : 'alert'}>
        {state === 'preparing'
          ? m.library_dynamic_preparing()
          : state === 'unavailable'
            ? m.library_dynamic_unavailable()
            : m.error_message()}
      </p>
      <Button type="button" variant="outline" disabled={disabled || retrying} onClick={onRetry}>
        {m.library_collection_reload()}
      </Button>
    </div>
  );
}

type CollectionPageProps = {
  page: EditableCollectionPage;
  queryKey: readonly unknown[];
  refreshPage: () => Promise<EditableCollectionPage>;
  readEditorPage?: () => Promise<EditableCollectionPage>;
  cursor: string | undefined;
  layout?: 'grid' | 'list';
  search?: Record<string, string | string[]>;
  /** An enclosing read lifetime can retire this editor; it never supplies viewer authority. */
  isCurrent?: () => boolean;
};

type CollectionRestoreOffer = CollectionMemberUndo & { key: string; purgeAfter?: string; uncertain?: boolean };

export function CollectionPage(props: CollectionPageProps) {
  useSession();
  const { page } = props;
  const address = JSON.stringify([
    getLocale(),
    collectionRequestVariant({ id: page.id, cursor: props.cursor, search: props.search }),
    props.queryKey,
  ]);
  const admission = useCollectionCurrentAdmission(
    address,
    JSON.stringify([page.visibility !== null, page.viewerActions]),
    props.queryKey,
  );
  function current(operation: CollectionOperation = 'collection.get') {
    const action = operation === 'collection.delete' ? 'collection:delete' : 'collection:update';
    return (
      admission.current('collection.get') &&
      admission.current(operation) &&
      (operation === 'collection.get' || admitsCollectionOperation(page.viewerActions, action, operation)) &&
      (props.isCurrent?.() ?? true)
    );
  }
  // Permission renewals retire callbacks; the owning viewer/address alone owns drafts and uncertain keys.
  return <CollectionPageLifetime key={admission.owner} {...props} current={current} admission={admission} />;
}

function CollectionPageLifetime({
  page,
  queryKey,
  refreshPage,
  readEditorPage,
  cursor,
  layout = 'list',
  search,
  current,
  admission,
}: CollectionPageProps & { current: (operation?: CollectionOperation) => boolean; admission: CollectionAdmission }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const updateAdmitted = admitsCollectionOperation(page.viewerActions, 'collection:update', 'collection.update');
  // The editor also needs the loaded private metadata, independently of native action admission.
  const owner = updateAdmitted && page.visibility !== null && (page.memberState ?? 'ready') === 'ready';
  const boundaryAdmitted =
    owner && admitsCollectionOperation(page.viewerActions, 'collection:update', 'collection_member.move');
  const addAdmitted =
    page.visibility !== null &&
    admitsCollectionOperation(page.viewerActions, 'collection:update', 'collection_member.create');
  const deleteAdmitted = admitsCollectionOperation(page.viewerActions, 'collection:delete', 'collection.delete');
  const navigation = useCurrentLibraryNavigation(getLocale(), 100, JSON.stringify([page.id, cursor, search, queryKey]));
  const pins = navigation.data?.pins ?? { state: 'closed' as const };
  const navigationCollections = navigation.data?.collections ?? [];
  const pinActions = usePinControlActions({
    collectionId: page.id,
    pins,
    mode: 'collection',
    origin: navigation.pinsOrigin,
  });
  const [hydrated, setHydrated] = useState(false);
  const [members, setMembers] = useState(page.members);
  const [savedNoteIds, setSavedNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const writeKeys = useRef(new Map<string, string>());
  const commandCredentials = useRef(new Map<string, string>());
  const [editing, setEditing] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [readingMembers, setReadingMembers] = useState(false);
  const membersReadActive = useRef(false);
  const [adding, setAdding] = useState(false);
  const [moveChoice, setMoveChoice] = useState<CollectionMoveChoice | null>(null);
  const [transfer, setTransfer] = useState<(CollectionTransferReview & { memberIds: string[] }) | null>(null);
  const [chooserEpoch, setChooserEpoch] = useState(0);
  const [transferState, setTransferState] = useState<'review' | 'pending' | 'unknown' | 'refused' | 'confirmed' | null>(
    null,
  );
  const [transferReceipt, setTransferReceipt] = useState<CollectionTransferReceipt | null>(null);
  const transferReceiptHeading = useRef<HTMLHeadingElement>(null);
  const transferReviewHeading = useRef<HTMLHeadingElement>(null);
  const [bulkUnavailable, setBulkUnavailable] = useState(false);
  const [removalConfirmation, setRemovalConfirmation] = useState(false);
  const [batchRemovalIds, setBatchRemovalIds] = useState<ReadonlySet<string>>(new Set());
  const [editorMembers, setEditorMembers] = useState<CollectionMember[] | null>(null);
  const [bulkOccurrenceRemove, setBulkOccurrenceRemove] = useState<BulkOccurrenceRemoveJourney | null>(null);
  const [bulkOccurrenceRemoveRevision, setBulkOccurrenceRemoveRevision] = useState(0);
  const bulkOccurrenceRemoveRef = useRef<BulkOccurrenceRemoveJourney | null>(null);
  const nativeUndoKeys = useRef(new Map<string, string>());
  // The edit session owns its read revision, even if a background read replaces the reader page.
  const editorPage = useRef<EditableCollectionPage | null>(null);
  const draftPage = editorPage.current ?? page;
  const [title, setTitle] = useState(page.title);
  const [textSubmitted, setTextSubmitted] = useState(false);
  const storedKind = draftPage.presentationKindSource === 'owner' ? (draftPage.presentationKind ?? null) : null;
  const [kind, setKind] = useState(storedKind);
  const [coverMediaId, setCoverMediaId] = useState(page.coverMediaId ?? null);
  const [undo, setUndo] = useState<CollectionRestoreOffer[]>([]);
  const [description, setDescription] = useState(page.description ?? '');
  const [visibility, setVisibility] = useState<CollectionVisibility>(page.visibility ?? 'private');
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [writing, setPending] = useState(false);
  const [boundary, setBoundary] = useState<BoundaryMove | null>(null);
  const captureSave = () => ({
    credential: admission.csrf('collection.update'),
    send: {
      updateCollection,
      batchRemoveCollectionMembers,
      transferCollectionMembers,
      removeCollectionMember,
      moveCollectionMember,
      updateMemberNote,
    },
    page: draftPage,
    members,
    editorMembers,
    transfer,
    batchRemovalIds,
    title,
    description,
    visibility,
    kind,
    storedKind,
    coverMediaId,
  });
  const saveIntent = useRef<ReturnType<typeof captureSave> | null>(null);
  const draftFrozen = saveIntent.current !== null;
  const boundaryRef = useRef<BoundaryMove | null>(null);
  const mounted = useRef(false);
  function isCurrent(operation: CollectionOperation = 'collection.get') {
    return mounted.current && current(operation);
  }

  useEffect(
    () => () => {
      bulkOccurrenceRemoveRef.current?.retire();
    },
    [],
  );
  useEffect(() => {
    const journey = bulkOccurrenceRemoveRef.current;
    if (!journey?.retireIfStale()) return;
    bulkOccurrenceRemoveRef.current = null;
    setBulkOccurrenceRemove((currentJourney) => (currentJourney === journey ? null : currentJourney));
  }, [current]);

  useEffect(() => {
    const journey = bulkOccurrenceRemoveRef.current;
    const capture = journey?.capture;
    const result = journey?.state.read;
    if (
      !journey ||
      journey !== bulkOccurrenceRemove ||
      !capture ||
      result?.state !== 'ready' ||
      result.operation.action !== 'remove_from_collection' ||
      result.operation.selectionKind !== 'occurrences' ||
      result.operation.collectionId !== capture.source.id
    )
      return;

    const removeIds = new Set<string>();
    const offers: CollectionRestoreOffer[] = [];
    for (const outcome of result.page.outcomes) {
      if (outcome.state !== 'applied' || !outcome.memberId) continue;
      const target = capture.targets.find(
        (selected) => selected.memberId === outcome.memberId && selected.subjectId === outcome.subjectId,
      );
      if (!target) continue;
      removeIds.add(target.memberId);
      const receipt = bulkOccurrenceRemoveUndoReceipt(capture, result.operation, outcome);
      if (!receipt) continue;
      let key = nativeUndoKeys.current.get(receipt.deletionId);
      if (!key) {
        key = crypto.randomUUID();
        nativeUndoKeys.current.set(receipt.deletionId, key);
      }
      offers.push({ ...receipt, key });
    }
    if (offers.length) {
      setUndo((current) => {
        const known = new Set(current.map((item) => item.deletionId));
        const added = offers.filter((item) => !known.has(item.deletionId));
        return added.length ? [...current, ...added] : current;
      });
    }
    if (removeIds.size) {
      setMembers((current) => {
        const next = current.filter((member) => !removeIds.has(member.id));
        return next.length === current.length ? current : next;
      });
      setEditorMembers((current) => {
        if (!current) return current;
        const next = current.filter((member) => !removeIds.has(member.id));
        return next.length === current.length ? current : next;
      });
      if (editorPage.current) {
        editorPage.current = {
          ...editorPage.current,
          members: editorPage.current.members.filter((member) => !removeIds.has(member.id)),
        };
      }
      setSelectedIds((current) => {
        const next = new Set([...current].filter((id) => !removeIds.has(id)));
        return next.size === current.size ? current : next;
      });
    }
  }, [bulkOccurrenceRemove, bulkOccurrenceRemoveRevision, page.id]);
  function headers(operation: CollectionOperation, credential = admission.csrf(operation)) {
    if (!isCurrent(operation)) throw new Error('Collection authority retired');
    if (!credential) throw new Error('Collection mutation credential unavailable');
    return { 'X-CSRF-Token': credential };
  }
  function commandHeaders(operation: CollectionOperation, key: string) {
    const current = headers(operation);
    if (!commandCredentials.current.has(key)) commandCredentials.current.set(key, current['X-CSRF-Token']);
    return headers(operation, commandCredentials.current.get(key)!);
  }
  const inFlight = useRef<object | null>(null);
  const deleteInFlight = useRef<object | null>(null);
  function startRequest() {
    if (inFlight.current) return null;
    const request = {};
    inFlight.current = request;
    setPending(true);
    return request;
  }
  function finishRequest(request: object) {
    if (inFlight.current !== request) return;
    inFlight.current = null;
    // Physical progress settles even when permission is temporarily unavailable.
    if (admission.retained()) setPending(false);
  }
  const pending = writing || (boundary !== null && boundary.phase !== 'done');
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
    JSON.stringify(page.members.map((member) => [member.id, member.note, member.subject?.id ?? null])),
  ].join('\n');
  // Capture the actual page and actor, not a row index that another read can reuse.
  const boundaryContext = JSON.stringify([
    snapshot,
    cursor,
    search,
    queryKey,
    page.firstPage,
    page.viewerActions,
    session.state,
    session.subject,
  ]);
  const currentBoundaryContext = useRef(boundaryContext);
  currentBoundaryContext.current = boundaryContext;
  const boundaryFenced = boundary !== null && boundary.phase !== 'done' && boundary.intent.context !== boundaryContext;

  useEffect(() => setHydrated(true), []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (transfer && transferState === 'review') transferReviewHeading.current?.focus();
  }, [transfer?.idempotencyKey, transferState]);
  useEffect(() => {
    if (transferReceipt?.state === 'reading') transferReceiptHeading.current?.focus();
  }, [transferReceipt?.state === 'reading']);
  useEffect(() => {
    if (editing) {
      setConflict(true);
      return;
    }
    resetEditor(page);
  }, [snapshot]);

  async function reloadCollection(requireReady = false) {
    if (!isCurrent()) return;
    const refreshed = await refreshPage();
    if (!isCurrent()) return;
    if (refreshed.id !== page.id || (requireReady && (refreshed.memberState ?? 'ready') !== 'ready'))
      throw new Error('Collection page is not ready');
    queryClient.setQueryData(queryKey, refreshed);
    if (!isCurrent()) return;
    await router.invalidate();
    return isCurrent() ? refreshed : undefined;
  }

  async function reloadFromControl() {
    if (!isCurrent() || pending || draftFrozen || editing || membersReadActive.current) return;
    const context = currentBoundaryContext.current;
    membersReadActive.current = true;
    setReadingMembers(true);
    setFailure('');
    try {
      const refreshed = await refreshPage();
      // A newer status or writer result owns the page; this old read cannot replace it.
      if (!isCurrent() || currentBoundaryContext.current !== context) return;
      if (refreshed.id !== page.id) throw new Error('Collection response changed address');
      queryClient.setQueryData(queryKey, refreshed);
      await router.invalidate();
    } catch {
      if (isCurrent() && currentBoundaryContext.current === context) setFailure(m.error_message());
    } finally {
      membersReadActive.current = false;
      // Settle physical progress even when admission is temporarily unavailable.
      if (admission.retained()) setReadingMembers(false);
    }
  }

  async function reloadEditor() {
    if (!isCurrent()) return;
    const request = startRequest();
    if (!request) return;
    setFailure('');
    try {
      // Do not discard notes, metadata or uncertain operation identities until the read succeeds.
      const refreshed = await reloadCollection(true);
      if (refreshed) resetEditor(refreshed);
    } catch {
      if (isCurrent()) setFailure(m.error_message());
    } finally {
      finishRequest(request);
    }
  }

  function recordBoundary(value: BoundaryMove | null) {
    boundaryRef.current = value;
    setBoundary(value);
  }

  function boundaryIsCurrent(value: BoundaryMove) {
    return (
      isCurrent() &&
      boundaryRef.current?.intent === value.intent &&
      currentBoundaryContext.current === value.intent.context
    );
  }

  async function refreshBoundary(value: BoundaryMove) {
    if (!boundaryIsCurrent(value) || boundaryRef.current !== value || value.reading) return;
    recordBoundary({ ...value, reading: true });
    try {
      // One bounded read through the page's established callback. Its native source may restart a stale cursor once.
      const refreshed = await refreshPage();
      if (!boundaryIsCurrent(value)) return;
      if (refreshed.id !== value.intent.data.collectionId || (refreshed.memberState ?? 'ready') !== 'ready')
        throw new Error('Collection page is not ready');
      recordBoundary(value.phase === 'refused' ? null : { ...value, phase: 'done', reading: false });
      setEditing(false);
      setEditorMembers(null);
      setSelectedIds(new Set());
      setConflict(false);
      queryClient.setQueryData(queryKey, refreshed);
    } catch {
      if (boundaryIsCurrent(value)) recordBoundary({ ...value, reading: false });
    } finally {
      // A page/actor change fences the result, including an in-flight read, without abandoning its intent.
      if (admission.retained() && boundaryRef.current?.intent === value.intent && boundaryRef.current.reading)
        recordBoundary({ ...boundaryRef.current, reading: false });
    }
  }

  async function dispatchBoundary(value: BoundaryMove) {
    if (
      !boundaryIsCurrent(value) ||
      !isCurrent('collection_member.move') ||
      boundaryRef.current !== value ||
      !boundaryAdmitted
    )
      return;
    recordBoundary({ ...value, phase: 'pending' });
    let result: CollectionWriteResult;
    try {
      result = await moveCollectionMember({
        data: value.intent.data,
        headers: commandHeaders('collection_member.move', value.intent.data.idempotencyKey),
      });
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!isCurrent('collection_member.move') || boundaryRef.current?.intent !== value.intent) {
      // Release only this request's physical pending phase. Its old response cannot publish a result.
      if (
        admission.retained() &&
        boundaryRef.current?.intent === value.intent &&
        boundaryRef.current.phase === 'pending'
      )
        recordBoundary({ ...value, phase: 'unknown', reading: false });
      return;
    }
    if (result.ok) {
      const confirmed: BoundaryMove = { ...value, phase: 'confirmed', reading: false };
      recordBoundary(confirmed);
      if (boundaryIsCurrent(confirmed)) await refreshBoundary(confirmed);
    } else {
      recordBoundary({
        ...value,
        phase: result.reason === 'unavailable' ? 'unknown' : 'refused',
        ...(result.reason === 'conflict' ? { refusal: m.library_collection_conflict() } : {}),
      });
    }
  }

  function moveToBoundary(memberId: string, placement: 'start' | 'end') {
    if (
      !hydrated ||
      !isCurrent() ||
      pending ||
      conflict ||
      !editing ||
      !boundaryAdmitted ||
      !isCurrent('collection_member.move') ||
      draftChanged ||
      session.state !== 'signed-in' ||
      !session.subject ||
      (boundaryRef.current !== null && boundaryRef.current.phase !== 'done')
    )
      return;
    const index = members.findIndex((member) => member.id === memberId && member.subject !== null);
    const member = members[index];
    if (!member?.subject) return;
    const intent = Object.freeze({
      context: boundaryContext,
      placement,
      title: m.library_member_occurrence({
        title: pageText(libraryTitleValue(member.subject.label), getLocale()).text,
        position: index + 1,
      }),
      data: Object.freeze({
        collectionId: page.id,
        memberId,
        ...(placement === 'start' ? { after: null } : {}),
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const value: BoundaryMove = { intent, phase: 'pending', reading: false };
    recordBoundary(value);
    setFailure('');
    void dispatchBoundary(value);
  }

  async function beginEditing() {
    if (!isCurrent() || pending || editing || !owner) return;
    const request = startRequest();
    if (!request) return;
    setFailure('');
    try {
      const editable = readEditorPage ? await readEditorPage() : page;
      if (!isCurrent()) return;
      if (editable.id !== page.id) throw new Error('Collection editor address changed');
      if (editable.revision !== page.revision) {
        setConflict(true);
        return;
      }
      if (
        editable.visibility === null ||
        !admitsCollectionOperation(editable.viewerActions, 'collection:update', 'collection.update') ||
        (editable.memberState ?? 'ready') !== 'ready' ||
        editable.filterStatus
      )
        throw new Error('Collection members are not ready');
      editorPage.current = editable;
      writeKeys.current.clear();
      setSavedNoteIds(new Set());
      setConflict(false);
      setEditorMembers(editable.members);
      setMembers(editable.members);
      setTitle(editable.title);
      setKind(editable.presentationKindSource === 'owner' ? (editable.presentationKind ?? null) : null);
      setCoverMediaId(editable.coverMediaId ?? null);
      setDescription(editable.description ?? '');
      setVisibility(editable.visibility);
      setSelectedIds(new Set());
      setBatchRemovalIds(new Set());
      setTransfer(null);
      setTransferState(null);
      setMoveChoice(null);
      setBulkUnavailable(false);
      setSaveConfirmed(false);
      setEditing(true);
    } catch {
      if (isCurrent()) setFailure(m.error_message());
    } finally {
      finishRequest(request);
    }
  }

  function resetEditor(source: EditableCollectionPage) {
    editorPage.current = null;
    saveIntent.current = null;
    writeKeys.current.clear();
    setSavedNoteIds(new Set());
    setBatchRemovalIds(new Set());
    setTransfer(null);
    setTransferState(null);
    setMoveChoice(null);
    setBulkUnavailable(false);
    setMembers(source.members);
    setEditorMembers(null);
    setTitle(source.title);
    setKind(source.presentationKindSource === 'owner' ? (source.presentationKind ?? null) : null);
    setCoverMediaId(source.coverMediaId ?? null);
    setDescription(source.description ?? '');
    setVisibility(source.visibility ?? 'private');
    setSelectedIds(new Set());
    setConflict(false);
    setFailure('');
    setEditing(false);
  }

  function cancelEditing() {
    if (!isCurrent() || pending || conflict || saveIntent.current !== null) return;
    resetEditor(page);
  }

  const draftTextInvalid = () =>
    collectionTextIssue('title', title) ||
    collectionTextIssue('description', description) ||
    members.some((member) => collectionTextIssue('note', member.note));

  async function save(event?: FormEvent<HTMLFormElement>, confirmed = false, confirmedTransfer = false) {
    event?.preventDefault();
    if (!isCurrent('collection.update') || !hydrated || pending || conflict || !editing || !owner) return;
    if (transfer && !confirmedTransfer) return;
    // Validate the entire new Save before capture or any independently receipted write.
    // An uncertain plan already owns its exact operands, sender and credential.
    if (saveIntent.current === null) {
      setTextSubmitted(true);
      if (draftTextInvalid()) return;
    }
    if (!confirmed && saveIntent.current === null && removalCount > 0) {
      setRemovalConfirmation(true);
      return;
    }
    setRemovalConfirmation(false);
    const request = startRequest();
    if (!request) return;
    setFailure('');
    setConflict(false);
    const {
      credential,
      send,
      page,
      members,
      editorMembers,
      transfer: capturedTransfer,
      batchRemovalIds,
      title,
      description,
      visibility,
      kind,
      storedKind,
      coverMediaId,
    } = (saveIntent.current ??= captureSave());
    let committed = 0;
    let currentRevision: number | undefined = capturedTransfer?.sourceRevision ?? page.revision;
    let transferRevisions: { source: number; destination: number } | null = null;

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
      const transferIds = new Set(capturedTransfer?.memberIds ?? []);
      const initial = (editorMembers ?? page.members).filter((member) => !transferIds.has(member.id));
      const remainingMembers = members.filter((member) => !transferIds.has(member.id));
      const plan = buildCollectionMemberEditPlan(initial, remainingMembers, page.firstPage);
      const fail = async (result: Extract<CollectionWriteResult, { ok: false }>) => {
        if (!isCurrent()) return;
        if (committed > 0) {
          setConflict(result.reason !== 'unavailable');
          setFailure(m.library_collection_save_partial({ count: committed }));
        } else if (result.reason === 'conflict') setConflict(true);
        else {
          setFailure(writeMessage(result));
          if (result.reason === 'unavailable' || result.reason === 'closed') setBulkUnavailable(true);
        }
      };
      const removals = plan.filter((operation) => operation.kind === 'remove');
      const batchRemoval = removals.length > 1 || removals.some((operation) => batchRemovalIds.has(operation.memberId));
      if (batchRemoval) {
        if (!isCurrent()) return;
        if (currentRevision === undefined) throw new Error('Missing source revision');
        const data = {
          collectionId: page.id,
          revision: currentRevision,
          memberIds: removals.map((operation) => operation.memberId),
        };
        const result = await send.batchRemoveCollectionMembers({
          data: { ...data, idempotencyKey: keyFor(data) },
          headers: headers('collection_member.batch_remove', credential),
        });
        if (!isCurrent('collection_member.batch_remove')) return;
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
      // Batch removal owns the loaded CAS first: a rejected selection must not save even a metadata no-op.
      // Other draft edits remain independently receipted commands after the atomic removal.
      if (
        plan.some((operation) => operation.kind !== 'remove') ||
        (!batchRemoval && removals.length > 0) ||
        title !== page.title ||
        description !== (page.description ?? '') ||
        visibility !== page.visibility ||
        kind !== storedKind ||
        coverMediaId !== (page.coverMediaId ?? null)
      ) {
        if (!isCurrent()) return;
        const result = await send.updateCollection({
          data: {
            collectionId: page.id,
            revision: currentRevision!,
            title,
            description,
            visibility,
            ...(kind !== storedKind ? { presentationKind: kind } : {}),
            ...(coverMediaId !== (page.coverMediaId ?? null) ? { coverMediaId } : {}),
            idempotencyKey: keyFor([page.id, currentRevision, title, description, visibility, kind, coverMediaId]),
          },
          headers: headers('collection.update', credential),
        });
        if (!isCurrent()) return;
        if (!result.ok) {
          if (result.reason !== 'unavailable' && result.reason !== 'conflict') saveIntent.current = null;
          if (result.reason === 'conflict') setConflict(true);
          else {
            setFailure(writeMessage(result));
            if (result.reason === 'unavailable' || result.reason === 'closed') setBulkUnavailable(true);
          }
          return;
        }
        currentRevision = result.revision;
        committed += 1;
      }

      if (capturedTransfer) {
        if (!isCurrent()) return;
        const data = {
          collectionId: capturedTransfer.sourceId,
          revision: capturedTransfer.sourceRevision,
          memberIds: capturedTransfer.memberIds,
          destinationCollectionId: capturedTransfer.destination.id,
          destinationRevision: capturedTransfer.destination.revision,
          after: capturedTransfer.after,
        };
        setTransferState('pending');
        const result = await send.transferCollectionMembers({
          data: { ...data, idempotencyKey: capturedTransfer.idempotencyKey },
          headers: headers('collection_member.transfer', credential),
        });
        if (!isCurrent('collection_member.transfer')) return;
        if (!result.ok) {
          if (result.reason === 'unavailable') {
            setTransferState('unknown');
            setFailure(m.library_collection_move_unknown());
          } else {
            saveIntent.current = null;
            setTransferState('refused');
            setConflict(false);
            setFailure(result.reason === 'conflict' ? m.library_collection_conflict() : writeMessage(result));
          }
          return;
        }
        currentRevision = result.revision;
        transferRevisions = { source: result.revision, destination: result.destinationRevision };
        committed += 1;
        saveIntent.current = null;
      }
      const applied = await applyCollectionMemberEditPlan(
        batchRemoval ? plan.filter((operation) => operation.kind !== 'remove') : plan,
        async (operation) => {
          if (!isCurrent()) return { ok: false, reason: 'unavailable' };
          const common = { collectionId: page.id, idempotencyKey: keyFor([page.id, operation, currentRevision]) };
          if (operation.kind === 'remove') {
            if (currentRevision === undefined) return { ok: false, reason: 'unavailable' };
            const result = await send.removeCollectionMember({
              data: { ...common, memberId: operation.memberId, revision: currentRevision },
              headers: headers('collection_member.delete', credential),
            });
            if (!isCurrent('collection_member.delete')) return { ok: false, reason: 'unavailable' };
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
          const result =
            operation.kind === 'move'
              ? await send.moveCollectionMember({
                  data: { ...common, memberId: operation.memberId, after: operation.after },
                  headers: headers('collection_member.move', credential),
                })
              : await send.updateMemberNote({
                  data: { ...common, memberId: operation.memberId, note: operation.note },
                  headers: headers('collection_member.update', credential),
                });
          if (!isCurrent(operation.kind === 'move' ? 'collection_member.move' : 'collection_member.update'))
            return { ok: false, reason: 'unavailable' };
          if (operation.kind === 'note' && result.ok)
            setSavedNoteIds((current) => new Set([...current, operation.memberId]));
          return result;
        },
      );
      if (!isCurrent()) return;
      committed += applied.completed;
      if (applied.failed) {
        if (committed > 0) {
          const retryable = applied.failed.reason === 'unavailable';
          setConflict(!retryable);
          setFailure(m.library_collection_save_partial({ count: committed }));
        } else {
          setConflict(applied.failed.reason !== 'unavailable');
          setFailure(m.error_message());
        }
        return;
      }
      if (capturedTransfer && transferRevisions) {
        const receipt: CollectionTransferReceipt = {
          sourceId: capturedTransfer.sourceId,
          destinationId: capturedTransfer.destination.id,
          sourceTitle: capturedTransfer.sourceTitle,
          destinationTitle: capturedTransfer.destination.title,
          sourceHref: capturedTransfer.sourceHref,
          destinationHref: capturedTransfer.destinationHref,
          sourceRevision: transferRevisions.source,
          destinationRevision: transferRevisions.destination,
          state: 'reading',
        };
        setTransferReceipt(receipt);
        setTransferState('confirmed');
        setSaveConfirmed(true);
        const [sourceRead, destinationRead] = await Promise.allSettled([
          reloadCollection(true),
          readCollectionMovePlacements({
            data: { collectionId: capturedTransfer.destination.id, revision: transferRevisions.destination },
          }),
        ]);
        if (!isCurrent()) return;
        const sourcePage = sourceRead.status === 'fulfilled' ? sourceRead.value : undefined;
        const sourceReady = !!sourcePage && sourcePage.id === capturedTransfer.sourceId;
        const destinationReady = destinationRead.status === 'fulfilled';
        if (sourceReady) resetEditor(sourcePage);
        setTransferReceipt({ ...receipt, state: sourceReady && destinationReady ? 'ready' : 'unavailable' });
        return;
      }
      setSaveConfirmed(true);
      const refreshed = await reloadCollection(true);
      if (refreshed) resetEditor(refreshed);
    } catch {
      if (!isCurrent()) return;
      if (capturedTransfer && transferRevisions) {
        // The native receipt is definitive. Reconciliation cannot repeat a confirmed transfer.
        setTransferReceipt((receipt) => (receipt ? { ...receipt, state: 'unavailable' } : receipt));
      } else if (capturedTransfer) {
        setTransferState('unknown');
        setFailure(m.library_collection_move_unknown());
      } else if (committed > 0) {
        setConflict(true);
        setFailure(m.library_collection_save_partial({ count: committed }));
      } else setFailure(m.error_message());
    } finally {
      finishRequest(request);
    }
  }

  async function rereadRefusedTransfer() {
    if (!transfer || transferState !== 'refused' || !isCurrent() || inFlight.current) return;
    const request = startRequest();
    if (!request) return;
    setFailure('');
    try {
      const [source, target] = await Promise.all([
        refreshPage(),
        readCollectionDestination({ data: transfer.destination.id }),
      ]);
      if (!isCurrent()) return;
      if (
        source.id !== transfer.sourceId ||
        (source.memberState ?? 'ready') !== 'ready' ||
        !target ||
        target.id !== transfer.destination.id
      )
        throw new Error('Collection transfer recovery unavailable');
      await readCollectionMovePlacements({ data: { collectionId: target.id, revision: target.revision } });
      if (!isCurrent()) return;
      queryClient.setQueryData(queryKey, source);
      await router.invalidate();
      if (!isCurrent()) return;
      resetEditor(source);
      setFailure(m.library_collection_move_reselect());
    } catch {
      if (isCurrent()) setFailure(m.library_collection_move_read_failed());
    } finally {
      finishRequest(request);
    }
  }

  async function rereadTransferReceipt() {
    if (!transferReceipt || transferReceipt.state !== 'unavailable' || !isCurrent() || inFlight.current) return;
    const previousReceipt = transferReceipt;
    const request = startRequest();
    if (!request) return;
    setTransferReceipt({ ...previousReceipt, state: 'reading' });
    try {
      const [source, target] = await Promise.all([
        refreshPage(),
        readCollectionDestination({ data: previousReceipt.destinationId }),
      ]);
      if (!isCurrent()) return;
      if (
        source.id !== previousReceipt.sourceId ||
        (source.memberState ?? 'ready') !== 'ready' ||
        !target ||
        target.id !== previousReceipt.destinationId
      )
        throw new Error('Collection transfer reconciliation unavailable');
      await readCollectionMovePlacements({ data: { collectionId: target.id, revision: target.revision } });
      if (!isCurrent()) return;
      queryClient.setQueryData(queryKey, source);
      await router.invalidate();
      if (!isCurrent()) return;
      if (editing) resetEditor(source);
      setTransferReceipt({
        ...previousReceipt,
        sourceRevision: source.revision,
        destinationRevision: target.revision,
        state: 'ready',
      });
    } catch {
      if (isCurrent()) setTransferReceipt({ ...previousReceipt, state: 'unavailable' });
    } finally {
      finishRequest(request);
    }
  }

  function previewSelectedOccurrenceRemoval() {
    if (
      !isCurrent('collection_member.batch_remove') ||
      pending ||
      draftFrozen ||
      conflict ||
      bulkUnavailable ||
      memberDraftChanged ||
      transfer !== null ||
      selectedIds.size === 0 ||
      bulkOccurrenceRemoveRef.current
    )
      return;
    const viewer = session.state === 'signed-in' ? session.subject : null;
    if (!viewer) return;
    const source = editorPage.current ?? page;
    const captured = captureBulkOccurrenceRemove({ id: source.id, title: source.title }, source.members, selectedIds);
    if (!captured.ok) {
      setFailure(m.library_collection_batch_unavailable());
      return;
    }
    const requestHeaders = Object.fromEntries(new Headers(headers('collection_member.batch_remove')).entries());
    const manifest = createBulkOccurrenceRemoveManifest(captured, requestHeaders, bulkStatusSender);
    const journey = new BulkOccurrenceRemoveJourney(
      captured,
      manifest,
      viewer,
      {
        context: () => admission.retained() && admission.observed() && current(),
        read: () => isCurrent(),
        write: () => isCurrent('collection_member.batch_remove'),
      },
      async (address) => receiveUndoEvidence(await readBulkOperation({ data: address })),
      () => setBulkOccurrenceRemoveRevision((revision) => revision + 1),
    );
    bulkOccurrenceRemoveRef.current = journey;
    setBulkOccurrenceRemove(journey);
    setFailure('');
    void journey.preview();
  }

  async function undoRemoval(episode: CollectionRestoreOffer) {
    if (!isCurrent('collection_member.restore') || pending || !owner) return;
    if (!bulkOccurrenceRemoveRestoreAvailable(episode.purgeAfter, true, Date.now(), episode.uncertain)) {
      setUndo((current) => current.filter((item) => item.deletionId !== episode.deletionId));
      return;
    }
    const request = startRequest();
    if (!request) return;
    setFailure('');
    try {
      const { collectionId, memberId, deletionId, revision, key } = episode;
      const result = await restoreCollectionMember({
        data: { collectionId, memberId, deletionId, revision, idempotencyKey: key },
        headers: commandHeaders('collection_member.restore', key),
      });
      if (!isCurrent()) return;
      if (result.ok || (!result.ok && result.reason === 'expired'))
        setUndo((current) => current.filter((item) => item.deletionId !== episode.deletionId));
      else
        setUndo((current) =>
          current.map((item) =>
            item.deletionId === episode.deletionId ? { ...item, uncertain: result.reason === 'unavailable' } : item,
          ),
        );
      if (result.ok) await reloadCollection();
      else setFailure(result.reason === 'expired' ? m.library_restore_expired() : writeMessage(result));
    } catch {
      if (isCurrent()) {
        setUndo((current) =>
          current.map((item) => (item.deletionId === episode.deletionId ? { ...item, uncertain: true } : item)),
        );
        setFailure(m.error_message());
      }
    } finally {
      finishRequest(request);
    }
  }

  async function removeCollection() {
    if (
      !isCurrent('collection.delete') ||
      !deletion ||
      deleting ||
      pending ||
      deleteInFlight.current ||
      !deleteAdmitted
    )
      return;
    const request = {};
    deleteInFlight.current = request;
    setDeleting(true);
    setDeleteFailure('');
    try {
      const result = await deleteCollection({
        data: deletion,
        headers: commandHeaders('collection.delete', deletion.idempotencyKey),
      });
      if (!isCurrent()) return;
      if (!result.ok) {
        setDeleteFailure(result.reason === 'conflict' ? m.library_collection_conflict() : writeMessage(result));
        return;
      }
      window.location.assign(`/${getLocale()}/library/collections`);
    } catch {
      if (isCurrent()) setDeleteFailure(m.error_message());
    } finally {
      if (deleteInFlight.current === request) {
        deleteInFlight.current = null;
        if (admission.retained()) setDeleting(false);
      }
    }
  }

  function setMemberOrder(memberId: string, after: string | null) {
    if (!isCurrent('collection_member.move') || inFlight.current || saveIntent.current !== null) return;
    setMembers((current) => reorderCollectionMembers(current, memberId, after, draftPage.firstPage));
  }

  async function copyLink(href: string) {
    if (!mounted.current || !admission.observed()) return;
    try {
      await navigator.clipboard.writeText(`${location.origin}${href}`);
    } catch {
      if (mounted.current && admission.observed()) setFailure(m.error_message());
    }
  }

  const visibleVisibility = page.visibility ?? page.disclosedVisibility;
  const bulkOccurrenceCapture = bulkOccurrenceRemove?.capture;
  const currentRestore = isCurrent('collection_member.restore');
  const visibleUndo = undo.filter((episode) =>
    bulkOccurrenceRemoveRestoreAvailable(episode.purgeAfter, currentRestore, Date.now(), episode.uncertain),
  );
  const memberDraftChanged =
    editing &&
    buildCollectionMemberEditPlan(
      (editorMembers ?? draftPage.members).filter((member) => !transfer?.memberIds.includes(member.id)),
      transfer ? members.filter((member) => !transfer.memberIds.includes(member.id)) : members,
      draftPage.firstPage,
    ).length > 0;
  const removalCount = buildCollectionMemberEditPlan(
    (editorMembers ?? draftPage.members).filter((member) => !transfer?.memberIds.includes(member.id)),
    transfer ? members.filter((member) => !transfer.memberIds.includes(member.id)) : members,
    draftPage.firstPage,
  ).filter((operation) => operation.kind === 'remove').length;
  const transferHasIndependentDraft =
    memberDraftChanged ||
    title !== draftPage.title ||
    description !== (draftPage.description ?? '') ||
    visibility !== draftPage.visibility ||
    kind !== storedKind ||
    coverMediaId !== (draftPage.coverMediaId ?? null);
  const draftChanged =
    editing &&
    (memberDraftChanged ||
      transfer !== null ||
      title !== draftPage.title ||
      description !== (draftPage.description ?? '') ||
      visibility !== draftPage.visibility ||
      kind !== storedKind ||
      coverMediaId !== (draftPage.coverMediaId ?? null));
  const draftNavigation = useCollectionDraftNavigation({
    dirty: draftChanged && !saveConfirmed,
    locked:
      editing &&
      !saveConfirmed &&
      (writing || draftFrozen || (boundary !== null && ['pending', 'unknown', 'confirmed'].includes(boundary.phase))),
    isCurrent: () => owner && isCurrent(),
  });
  return (
    <div className="w-full min-w-0 text-foreground">
      {draftNavigation}
      <article className="w-full min-w-0 space-y-4 sm:space-y-5">
        <header data-slot="collection-hero" className="min-w-0 space-y-3 rounded-2xl bg-card p-4 sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="w-16 shrink-0 sm:w-24" data-collection-cover-source={page.coverSource}>
              <Cover
                subject={{ id: page.id, title: page.title, types: [] }}
                cover={page.cover ?? null}
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
            <div className="min-w-0 flex-1 space-y-2">
              <h1 className="text-2xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
                {page.title}
              </h1>
              <div className="flex min-w-0 text-sm text-muted-foreground" data-collection-owner>
                {page.curator?.handle ? (
                  <a
                    href={`/${getLocale()}/@${encodeURIComponent(page.curator.handle)}`}
                    className="min-w-0 [overflow-wrap:anywhere] hover:text-foreground"
                  >
                    <AccountRef account={page.curator} avatar />
                  </a>
                ) : (
                  <AccountRef account={page.curator} avatar />
                )}
              </div>
            </div>
          </div>
          <MetaLine
            className="block text-sm leading-5 text-muted-foreground"
            items={[
              page.memberCount == null ? null : m.library_member_count({ count: page.memberCount }),
              visibleVisibility ? visibilityLabel(visibleVisibility) : null,
              <span>
                {m.library_collection_updated()} <RelativeTime value={page.updatedAt} locale={getLocale()} />
              </span>,
            ]}
          />
          <CollectionDescriptionReader description={page.description} />
          <div data-slot="collection-actions" className="flex min-w-0 flex-wrap items-center gap-2">
            <ResourceAccessLink resourceId={page.id} />
            {addAdmitted ? (
              <Button
                type="button"
                disabled={!hydrated || pending || editing || adding}
                onClick={() => {
                  if (isCurrent('collection_member.create')) setAdding(true);
                }}
              >
                {m.library_collection_add_items()}
              </Button>
            ) : null}
            {page.visibility === null ? <FollowTargetControl targetId={page.id} following={page.following} /> : null}
            <CollectionReadActions
              onShare={() => copyLink(collectionHref(page.id))}
              primaryShare={!addAdmitted}
              entries={[
                ...(owner
                  ? [
                      {
                        type: 'item' as const,
                        label: m.library_collection_edit(),
                        onSelect: beginEditing,
                        disabled: !hydrated || pending || editing || adding,
                      },
                    ]
                  : []),
                ...pinActions.entries,
                {
                  type: 'submenu',
                  label: m.library_nav_selector(),
                  entries: libraryNavigationMenuEntries({ collectionId: page.id }, pins, navigationCollections),
                },
                ...(deleteAdmitted
                  ? [
                      {
                        type: 'destructive' as const,
                        label: m.library_collection_delete(),
                        disabled: !hydrated || pending || editing || adding,
                        onSelect: () => {
                          if (!isCurrent('collection.delete')) return;
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
          </div>
        </header>
        <LibraryNavigationNotice pins={pins} collectionsState={navigation.data?.collectionsState ?? 'loaded'} />
        {page.viewerActions?.state === 'unavailable' ? (
          <p role="status">{m.library_collection_actions_unavailable()}</p>
        ) : null}
        <AlertDialog
          open={deletion !== null}
          onOpenChange={(open, details) => {
            if (!isCurrent()) return;
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

        <CollectionBatchRemoveConfirmation
          open={removalConfirmation && owner}
          count={removalCount}
          onOpenChange={setRemovalConfirmation}
          onConfirm={() => void save(undefined, true)}
        />

        {owner && visibleUndo.length ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 p-3"
            data-collection-undo
          >
            <p className="basis-full text-sm">{m.library_collection_undo_note()}</p>
            {visibleUndo.map((episode, index) => (
              <Button
                key={episode.deletionId}
                variant="outline"
                type="button"
                disabled={pending || editing}
                onClick={() => void undoRemoval(episode)}
              >
                {episode.uncertain ? m.library_bulk_occurrence_remove_retry_restore() : m.editor_undo()}{' '}
                {visibleUndo.length > 1 ? index + 1 : ''}
              </Button>
            ))}
          </div>
        ) : null}
        {failure ? <p role="alert">{failure}</p> : null}
        {transferReceipt && isCurrent() ? (
          <section
            className="space-y-3 rounded-xl border p-3"
            data-collection-transfer-receipt
            aria-labelledby="collection-transfer-receipt-heading"
          >
            <h2
              id="collection-transfer-receipt-heading"
              ref={transferReceiptHeading}
              tabIndex={-1}
              className="font-semibold"
            >
              {m.library_collection_move_receipt()}
            </h2>
            <p>
              {m.library_collection_move_receipt_revisions({
                source: transferReceipt.sourceRevision,
                destination: transferReceipt.destinationRevision,
              })}
            </p>
            {transferReceipt.state === 'reading' ? (
              <p role="status">{m.library_collection_move_reconciling()}</p>
            ) : null}
            {transferReceipt.state === 'ready' ? <p role="status">{m.library_collection_move_reconciled()}</p> : null}
            {transferReceipt.state === 'unavailable' ? (
              <div role="alert" className="space-y-2">
                <p>{m.library_collection_move_reconcile_failed()}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                  disabled={pending}
                  onClick={() => void rereadTransferReceipt()}
                >
                  {m.library_collection_move_read_current()}
                </Button>
              </div>
            ) : null}
            <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.library_collection_move_return_links()}>
              <a
                className="inline-flex min-h-11 max-w-full items-center break-words rounded-lg border px-3 py-2 underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                href={transferReceipt.sourceHref}
              >
                {m.library_collection_move_source_link({ title: transferReceipt.sourceTitle })}
              </a>
              <a
                className="inline-flex min-h-11 max-w-full items-center break-words rounded-lg border px-3 py-2 underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                href={transferReceipt.destinationHref}
              >
                {m.library_collection_move_destination_link({ title: transferReceipt.destinationTitle })}
              </a>
            </nav>
          </section>
        ) : null}
        {boundary ? (
          <div role="status" className="space-y-2 rounded-xl bg-muted/40 p-3" data-collection-boundary>
            <p>
              {boundaryFenced
                ? m.library_collection_boundary_fenced()
                : boundary.phase === 'pending'
                  ? m.library_collection_boundary_pending({ title: boundary.intent.title })
                  : boundary.phase === 'unknown'
                    ? m.library_collection_boundary_unknown({ title: boundary.intent.title })
                    : boundary.phase === 'refused'
                      ? m.library_collection_boundary_refused()
                      : boundary.intent.placement === 'start'
                        ? m.library_collection_boundary_moved_start({ title: boundary.intent.title })
                        : m.library_collection_boundary_moved_end({ title: boundary.intent.title })}
            </p>
            {boundary.refusal ? <p>{boundary.refusal}</p> : null}
            {boundary.phase === 'unknown' ? (
              <Button
                type="button"
                variant="outline"
                disabled={boundaryFenced || !boundaryAdmitted}
                onClick={() => void dispatchBoundary(boundary)}
              >
                {m.library_collection_boundary_retry()}
              </Button>
            ) : null}
            {boundary.phase === 'confirmed' || boundary.phase === 'refused' ? (
              <>
                {boundary.phase === 'confirmed' && !boundary.reading && !boundaryFenced ? (
                  <p>{m.library_collection_boundary_refresh_failed()}</p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  disabled={boundaryFenced || boundary.reading}
                  aria-busy={boundary.reading}
                  onClick={() => void refreshBoundary(boundary)}
                >
                  {m.library_collection_boundary_refresh()}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {conflict ? (
          <p role="alert">
            {m.library_collection_conflict()}{' '}
            <button
              className="text-primary underline"
              type="button"
              disabled={pending}
              onClick={() => void reloadEditor()}
            >
              {m.library_collection_reload()}
            </button>
          </p>
        ) : null}

        {adding ? (
          <CollectionAddMembers
            key={page.id}
            collectionId={page.id}
            isCurrent={() => isCurrent('collection_member.create')}
            onAdded={async () => {
              await reloadCollection();
            }}
            onClose={() => {
              if (isCurrent()) setAdding(false);
            }}
          />
        ) : null}
        {editing && owner ? (
          <CollectionMetadataEditor
            textSubmitted={textSubmitted}
            title={title}
            description={description}
            disabled={pending || draftFrozen || transfer !== null || !isCurrent('collection.update')}
            onSubmit={(event) => void save(event)}
            onTitleChange={(value) => {
              if (
                isCurrent('collection.update') &&
                !inFlight.current &&
                saveIntent.current === null &&
                transfer === null
              )
                setTitle(value);
            }}
            onDescriptionChange={(value) => {
              if (
                isCurrent('collection.update') &&
                !inFlight.current &&
                saveIntent.current === null &&
                transfer === null
              )
                setDescription(value);
            }}
          >
            <CollectionPresentationFields
              types={page.presentationTypes}
              kind={kind}
              onKindChange={(value) => {
                if (
                  isCurrent('collection.update') &&
                  !inFlight.current &&
                  saveIntent.current === null &&
                  transfer === null
                )
                  setKind(value);
              }}
              coverMediaId={coverMediaId}
              onCoverChange={(value) => {
                if (
                  isCurrent('collection.update') &&
                  !inFlight.current &&
                  saveIntent.current === null &&
                  transfer === null
                )
                  setCoverMediaId(value);
              }}
              members={page.members}
              disabled={pending || draftFrozen || transfer !== null || !isCurrent('collection.update')}
            />
            <VisibilityField
              onChange={(value) => {
                if (
                  isCurrent('collection.update') &&
                  !inFlight.current &&
                  saveIntent.current === null &&
                  transfer === null
                )
                  setVisibility(value);
              }}
              value={visibility}
              disabled={pending || draftFrozen || transfer !== null || !isCurrent('collection.update')}
            />
            <p className="text-sm text-muted-foreground">{m.library_collection_independent_writes()}</p>
          </CollectionMetadataEditor>
        ) : null}

        {!editing ? (
          <div data-slot="collection-toolbar" className="flex min-w-0 items-center justify-between gap-2">
            {page.filterProperties && page.filterParams ? (
              <CollectionFilters
                id={page.id}
                type={page.filterType ?? 'schema:Book'}
                properties={page.filterProperties}
                params={page.filterParams}
                {...(page.filterReleaseKey ? { filterReleaseKey: page.filterReleaseKey } : {})}
                viewerKey={session.state === 'signed-in' ? (session.subject ?? 'signed-in') : 'anonymous'}
              />
            ) : null}
            <nav
              aria-label={m.library_layout()}
              data-slot="collection-layout"
              className="ms-auto flex shrink-0 items-center gap-1 text-sm"
            >
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
          </div>
        ) : null}
        <CollectionFilterFeedback
          id={page.id}
          {...(page.filter === undefined ? {} : { filter: page.filter })}
          {...(page.filterIgnored === undefined ? {} : { ignored: page.filterIgnored })}
          {...(page.filterStatus === undefined ? {} : { status: page.filterStatus })}
          {...(page.filterType === undefined ? {} : { filterType: page.filterType })}
          empty={
            (editing ? members : (page.filteredMembers ?? page.members)).length === 0 &&
            (page.memberState ?? 'ready') === 'ready'
          }
          unavailable={page.memberState === 'unavailable'}
          emptyLabel={m.library_collection_empty()}
        />
        <section aria-label={m.library_collection_members()}>
          <h2 className="sr-only">{m.library_collection_members()}</h2>
          {editing && boundaryAdmitted ? (
            <div className="mb-3 space-y-1 text-sm text-muted-foreground" data-collection-boundary-guidance>
              <p>{m.library_collection_boundary_help()}</p>
              {draftChanged ? <p role="status">{m.library_collection_move_save_first()}</p> : null}
            </div>
          ) : null}
          {editing &&
          owner &&
          (selectedIds.size > 0 || batchRemovalIds.size > 0 || transfer !== null || !!bulkOccurrenceCapture) ? (
            <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl bg-muted/40 p-3" data-collection-selection>
              <p className="me-auto self-center text-sm text-muted-foreground">
                {m.library_collection_selection_count({ count: selectedIds.size })}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending || draftFrozen || conflict || bulkUnavailable || selectedIds.size === 0 || transfer !== null
                }
                onClick={() => {
                  if (
                    !isCurrent('collection_member.batch_remove') ||
                    inFlight.current ||
                    saveIntent.current !== null ||
                    transfer !== null
                  )
                    return;
                  setBatchRemovalIds((current) => new Set([...current, ...selectedIds]));
                  setMembers((current) => current.filter((member) => !selectedIds.has(member.id)));
                  setSelectedIds(new Set());
                }}
              >
                {m.library_collection_remove_selected()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  draftFrozen ||
                  conflict ||
                  bulkUnavailable ||
                  memberDraftChanged ||
                  transfer !== null ||
                  selectedIds.size === 0 ||
                  !isCurrent('collection_member.batch_remove') ||
                  !!bulkOccurrenceRemove
                }
                onClick={previewSelectedOccurrenceRemoval}
              >
                {m.library_bulk_occurrence_remove_preview()}
              </Button>
              <CollectionMoveChooser
                key={chooserEpoch}
                sourceId={page.id}
                disabled={pending || draftFrozen || conflict || transfer !== null || transferHasIndependentDraft}
                focusHeadingOnMount={chooserEpoch > 0}
                current={() => isCurrent('collection_member.transfer') && transfer === null}
                onChange={(choice) => {
                  if (isCurrent('collection_member.transfer') && transfer === null) setMoveChoice(choice);
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                disabled={
                  pending ||
                  conflict ||
                  bulkUnavailable ||
                  draftFrozen ||
                  transferHasIndependentDraft ||
                  !moveChoice ||
                  selectedIds.size === 0 ||
                  transfer !== null
                }
                onClick={() => {
                  if (
                    !isCurrent('collection_member.transfer') ||
                    inFlight.current ||
                    saveIntent.current !== null ||
                    !moveChoice
                  )
                    return;
                  const source = editorPage.current ?? page;
                  const sourceMembers = editorMembers ?? page.members;
                  const selected = sourceMembers.filter((member) => selectedIds.has(member.id));
                  if (
                    source.id !== page.id ||
                    !Number.isSafeInteger(source.revision) ||
                    selected.length !== selectedIds.size ||
                    moveChoice.destination.id === source.id
                  ) {
                    setFailure(m.library_collection_move_read_failed());
                    return;
                  }
                  const occurrences = selected.map((member) => ({
                    id: member.id,
                    title: member.subject
                      ? pageText(libraryTitleValue(member.subject.label), getLocale()).text
                      : m.library_collection_move_occurrence_unavailable(),
                  }));
                  setTransfer({
                    ...moveChoice,
                    sourceId: source.id,
                    sourceTitle: source.title,
                    sourceRevision: source.revision,
                    sourceHref: collectionViewAddress(source.id, layout, cursor, search),
                    destinationHref: collectionViewAddress(moveChoice.destination.id, 'list', undefined),
                    occurrences,
                    memberIds: selected.map((member) => member.id),
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setTransferState('review');
                  setFailure('');
                }}
              >
                {m.library_collection_move_review_button()}
              </Button>
              {transfer ? (
                <section
                  className="basis-full space-y-3 rounded-xl border p-3"
                  data-collection-transfer-review
                  aria-labelledby="collection-transfer-review-heading"
                >
                  <h3
                    id="collection-transfer-review-heading"
                    ref={transferReviewHeading}
                    tabIndex={-1}
                    className="font-semibold"
                  >
                    {m.library_collection_move_review_heading()}
                  </h3>
                  <p>
                    <strong>{m.library_collection_move_review_source()}</strong> {transfer.sourceTitle}
                  </p>
                  <p>{m.library_collection_move_review_occurrences({ count: transfer.occurrences.length })}</p>
                  <ul className="min-w-0 space-y-1">
                    {transfer.occurrences.map((occurrence) => (
                      <li key={occurrence.id} className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {occurrence.title} <code className="break-all text-xs">{occurrence.id}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="break-words [overflow-wrap:anywhere]">
                    <strong>{m.library_collection_move_review_destination()}</strong>{' '}
                    <a href={transfer.destinationHref} className="underline underline-offset-4">
                      {transfer.destination.title}
                    </a>{' '}
                    {m.library_collection_move_review_revision({ revision: transfer.destination.revision })}
                  </p>
                  {transfer.anchor ? (
                    <p>
                      <strong>{m.library_collection_move_review_placement()}</strong>{' '}
                      {m.library_collection_move_anchor_review({
                        page: transfer.anchor.page,
                        position: transfer.anchor.position,
                        title: transfer.anchor.title,
                      })}{' '}
                      <code className="break-all text-xs">{transfer.anchor.id}</code>
                    </p>
                  ) : (
                    <p>
                      <strong>{m.library_collection_move_review_placement()}</strong>{' '}
                      {m.library_collection_move_first()}
                    </p>
                  )}
                  <p className="text-sm">{m.library_collection_move_atomic()}</p>
                  {transferState === 'pending' ? <p role="status">{m.library_collection_move_sending()}</p> : null}
                  {transferState === 'unknown' ? (
                    <div role="alert" className="space-y-2">
                      <p>{m.library_collection_move_unknown()}</p>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                        disabled={pending || !isCurrent('collection_member.transfer')}
                        onClick={() => void save(undefined, false, true)}
                      >
                        {m.library_collection_move_retry_exact()}
                      </Button>
                    </div>
                  ) : null}
                  {transferState === 'refused' ? (
                    <div role="alert" className="space-y-2">
                      <p>{failure || m.library_collection_move_refused()}</p>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                        disabled={pending || !isCurrent()}
                        onClick={() => void rereadRefusedTransfer()}
                      >
                        {m.library_collection_move_read_current()}
                      </Button>
                    </div>
                  ) : null}
                  {transferState === 'review' ? (
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <Button
                        type="button"
                        className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                        disabled={pending || conflict || !isCurrent('collection_member.transfer')}
                        onClick={() => void save(undefined, false, true)}
                      >
                        {m.library_collection_move_confirm()}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                        disabled={pending || draftFrozen || transferState !== 'review'}
                        onClick={() => {
                          if (!isCurrent() || saveIntent.current !== null) return;
                          setTransfer(null);
                          setTransferState(null);
                          setMoveChoice(null);
                          setChooserEpoch((value) => value + 1);
                          setFailure('');
                        }}
                      >
                        {m.library_collection_move_cancel_review()}
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              {transferHasIndependentDraft && !transfer ? (
                <p className="basis-full text-sm text-muted-foreground">{m.library_collection_move_save_first()}</p>
              ) : null}
              {bulkUnavailable ? (
                <p className="basis-full text-sm text-muted-foreground">{m.library_collection_batch_unavailable()}</p>
              ) : null}
              {bulkOccurrenceCapture && bulkOccurrenceRemove && isCurrent() ? (
                <div className="basis-full space-y-3">
                  <BulkOccurrenceRemoveReview capture={bulkOccurrenceCapture} />
                  <BulkOccurrenceRemoveJourneyControls
                    state={bulkOccurrenceRemove.state}
                    canWrite={isCurrent('collection_member.batch_remove')}
                    onPreview={() => void bulkOccurrenceRemove.preview()}
                    onRetryPreview={() => void bulkOccurrenceRemove.preview(true)}
                    onConfirm={() =>
                      void bulkOccurrenceRemove.confirm().then((confirmed) => {
                        if (confirmed) void bulkOccurrenceRemove.read();
                      })
                    }
                    onRetryConfirm={() =>
                      void bulkOccurrenceRemove.confirm(true).then((confirmed) => {
                        if (confirmed) void bulkOccurrenceRemove.read();
                      })
                    }
                    onRead={() => void bulkOccurrenceRemove.read()}
                    onReadMore={(cursor) => void bulkOccurrenceRemove.read(cursor)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <CollectionMembersStatus
            state={page.memberState ?? 'ready'}
            retrying={readingMembers}
            disabled={pending || draftFrozen || editing || readingMembers}
            onRetry={() => void reloadFromControl()}
          />
          {!editing ? (
            <CollectionReadMembers<ReadMember>
              members={(page.memberState ?? 'ready') !== 'ready' ? [] : (page.filteredMembers ?? page.members)}
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
              textSubmitted={textSubmitted}
              members={members}
              typeRatios={page.typeRatios}
              listPresentations={page.listPresentations}
              editing={editing && owner}
              firstPage={page.firstPage}
              busy={pending || draftFrozen || transfer !== null}
              selectedIds={selectedIds}
              savedNoteIds={savedNoteIds}
              onSelectionChange={(memberId, selected) => {
                if (!isCurrent() || inFlight.current || saveIntent.current !== null || transfer !== null) return;
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (selected && next.size < 100 && members.some((member) => member.id === memberId))
                    next.add(memberId);
                  else next.delete(memberId);
                  return next;
                });
              }}
              onMove={(memberId, after) => {
                if (transfer === null) setMemberOrder(memberId, after);
              }}
              onBoundaryMove={boundaryAdmitted ? moveToBoundary : undefined}
              boundaryBlocked={draftChanged || conflict || session.state !== 'signed-in' || !session.subject}
              onNoteChange={(memberId, note) => {
                if (
                  !isCurrent('collection_member.update') ||
                  inFlight.current ||
                  saveIntent.current !== null ||
                  transfer !== null
                )
                  return;
                setMembers((current) =>
                  current.map((member) => (member.id === memberId ? { ...member, note: note || null } : member)),
                );
                setSavedNoteIds((current) => {
                  if (!current.has(memberId)) return current;
                  const next = new Set(current);
                  next.delete(memberId);
                  return next;
                });
              }}
              onRemove={(memberId) => {
                if (
                  !isCurrent('collection_member.delete') ||
                  inFlight.current ||
                  saveIntent.current !== null ||
                  transfer !== null
                )
                  return;
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
        {editing && owner ? (
          <div
            className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-sm"
            data-collection-save
          >
            <Button
              type="submit"
              form="collection-edit-form"
              disabled={!hydrated || pending || conflict || transfer !== null}
            >
              {writing ? m.library_collection_save_pending() : m.library_collection_save()}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || conflict || draftFrozen}
              onClick={cancelEditing}
            >
              {m.library_collection_cancel()}
            </Button>
            {!saveConfirmed && (memberDraftChanged || transfer) ? (
              <span role="status" className="text-sm text-muted-foreground">
                {m.library_collection_unsaved_members()}
              </span>
            ) : null}
          </div>
        ) : null}
        {page.next && !editing ? (
          <nav aria-label={m.library_collection_members()}>
            <a href={collectionViewAddress(page.id, layout, page.next, search)} className={buttonClass}>
              {m.library_collection_more()}
            </a>
          </nav>
        ) : null}
        {!editing ? (
          <CollectionExport
            page={page}
            context={{ origin: publicOrigin(), locale: getLocale() }}
            laterPage={cursor !== undefined}
          />
        ) : null}
      </article>
    </div>
  );
}

/** Current product actions only; missing Collection social producers never become pin/follow writes. */
export function CollectionReadActions({
  onShare,
  entries = [],
  primaryShare = true,
}: {
  primaryShare?: boolean;
  onShare: () => void | Promise<void>;
  entries?: MenuEntry[];
}) {
  return (
    <>
      {primaryShare ? (
        <Button type="button" variant="outline" onClick={onShare}>
          <Share2Icon aria-hidden="true" />
          {m.library_collection_share()}
        </Button>
      ) : null}
      {entries.length || !primaryShare ? (
        <Menu
          title={m.library_collection_actions()}
          backLabel={m.library_collection_cancel()}
          trigger={
            <Button type="button" aria-label={m.library_collection_actions()} size="icon-sm" variant="ghost">
              <EllipsisIcon aria-hidden="true" />
            </Button>
          }
          entries={
            primaryShare
              ? entries
              : [{ type: 'item', label: m.library_collection_share(), onSelect: onShare }, ...entries]
          }
        />
      ) : null}
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
                  <CollectionNoteReader
                    key={member.id ?? member.note}
                    note={member.note}
                    previewLines={4}
                    occurrence={m.library_member_occurrence({ title: title.text, position: index + 1 })}
                  />
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
          <CollectionNoteReader
            key={member.id ?? member.note}
            note={member.note}
            occurrence={m.library_member_occurrence({ title: title.text, position: index + 1 })}
          />
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
