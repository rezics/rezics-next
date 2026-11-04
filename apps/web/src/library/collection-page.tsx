import { CollectionPresentationSummary } from './showcase-collection/presentation';
import { CollectionEditReview } from './showcase-collection/edit-review';
import { collectionComparisonHref } from './collection-comparison/model';
import type { CollectionComparisonDefinitions } from './collection-comparison/model';
import { useCollectionComparisonReturn } from './collection-comparison/return';
import { FilteredLibraryRemovalControl } from './bulk-filtered-library-removal-view';
import { CollectionFilteredStatus } from './bulk-filtered-status-view';
import { collectionTextIssue } from './collection-text-input';
import {
  batchRemoveCollectionMembers,
  transferCollectionMembers,
  type CollectionBatchResult,
  type CollectionTransferResult,
} from './collection-commands';
import { CollectionBatchRemoveConfirmation } from './collection-batch-remove';
import { useCollectionDraftNavigation } from './collection-draft-navigation';
import { CollectionMoveChooser, type CollectionMoveChoice } from './collection-move-chooser';
import { readCollectionDestination } from './collection-read';
import { readCollectionMovePlacements } from './collection-move-read';
import { CollectionAddMembers } from './collection-add-members';
import {
  CollectionMemberOccurrenceDetails,
  collectionPositionScopeMessage,
  type CollectionReadMember,
} from './collection-member-details';
import {
  collectionPageIsFiltered,
  collectionPositionScope,
  collectionPositionScopeFromAddress,
  collectionReadingPageKey,
} from './collection-public-reading/position';
import type { CollectionPositionScope } from './collection-public-reading/position';
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
import { useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
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
  collectionMemberReturnAddress,
  collectionViewerActionHref,
  collectionViewerFactForMember,
  collectionViewerHasPersonalAction,
  collectionViewerProjection,
  type CollectionViewerProjection,
} from './collection-viewer/model';
import { BulkFilteredAdd } from './bulk-filtered-add-view';
import {
  BulkOccurrenceRemoveJourney,
  bulkOccurrenceRemoveRestoreAvailable,
  bulkOccurrenceRemoveUndoReceipt,
  captureBulkOccurrenceRemove,
  createBulkOccurrenceRemoveManifest,
} from './bulk-occurrence-remove';
import { BulkOccurrenceRemoveJourneyControls, BulkOccurrenceRemoveReview } from './bulk-occurrence-remove-review';
import { bulkStatusSender } from './bulk-status';
import { FilteredOccurrenceRemoval, filteredOccurrenceRemovalManifest } from './bulk-filtered-occurrence-removal';
import { filteredOccurrenceRemovalSender } from './bulk-filtered-occurrence-removal-server';
import { FilteredOccurrenceRemovalReview } from './bulk-filtered-occurrence-removal-view';
import { readBulkOperation } from './bulk-operation-recovery-server';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import {
  CollectionMemberList,
  CollectionMetadataEditor,
  fieldClass,
  CollectionPresentationFields,
} from './collection-editor';
import {
  buildCollectionSaveReviewPlan,
  collectionSaveHasUnknown,
  collectionSaveOutcomeStatus,
  initialCollectionSaveOutcomes,
  rebaseRemainingCollectionDraft,
  remainingCollectionMemberOperations,
  runCollectionSaveSteps,
  type CollectionSavePlanStep,
  type CollectionSaveReviewPlan,
  type CollectionSaveStepOutcome,
  type ReviewedCollectionMemberOperation,
} from './collection-member-edit-plan';
import { CollectionMetadataHistory } from './collection-metadata-history-view';

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
  'inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

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
  return collectionPageAddress(getLocale(), id, cursor, search, layout);
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

type CollectionSaveCommandResult =
  | CollectionWriteResult
  | CollectionBatchResult
  | CollectionTransferResult;

type CapturedCollectionSaveAttempt = {
  operation: CollectionOperation;
  key: string;
  data: Readonly<Record<string, unknown>>;
  credential: string;
  send: () => Promise<CollectionSaveCommandResult>;
};

type CollectionSaveRunView = {
  plan: CollectionSaveReviewPlan;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  outcomes: readonly CollectionSaveStepOutcome[];
  complete: boolean;
  recoverCurrent: boolean;
};

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
  const returnOwner = useRef<CollectionAdmission['owner'] | undefined>(admission.owner);
  if (returnOwner.current !== admission.owner) returnOwner.current = undefined;
  // Permission renewals retire callbacks; the owning viewer/address alone owns drafts and uncertain keys.
  return (
    <CollectionPageLifetime
      key={admission.owner}
      {...props}
      current={current}
      admission={admission}
      admitInitialComparisonReturn={returnOwner.current === admission.owner}
    />
  );
}

function CollectionPageLifetime({
  page,
  queryKey,
  refreshPage,
  readEditorPage,
  cursor,
  layout = 'list',
  search,
  isCurrent: sourceCurrent,
  current,
  admission,
  admitInitialComparisonReturn,
}: CollectionPageProps & {
  current: (operation?: CollectionOperation) => boolean;
  admission: CollectionAdmission;
  admitInitialComparisonReturn: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const currentHref = useLocation({ select: (location) => location.publicHref });
  const viewerId = session.state === 'signed-in' ? (session.subject ?? null) : null;
  const viewerProjection = collectionViewerProjection(
    page.viewerFacts,
    page.provenance,
    viewerId,
    Boolean(viewerId && session.csrfToken && current() && (sourceCurrent?.() ?? true)),
  );
  const updateAdmitted = admitsCollectionOperation(page.viewerActions, 'collection:update', 'collection.update');
  // The editor also needs the loaded private metadata, independently of native action admission.
  const owner = updateAdmitted && page.visibility !== null && (page.memberState ?? 'ready') === 'ready';
  const ownerCurrent = owner && isCurrent();
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
  const [filteredRemoval, setFilteredRemoval] = useState<FilteredOccurrenceRemoval | null>(null);
  const [, refreshFilteredRemoval] = useState(0);
  const filteredRemovalRef = useRef<FilteredOccurrenceRemoval | null>(null);
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
  const [saveRunView, setSaveRunView] = useState<CollectionSaveRunView | null>(null);
  const [conflictBasis, setConflictBasis] = useState<EditableCollectionPage | null>(null);
  const [conflictBasisState, setConflictBasisState] = useState<'idle' | 'reading' | 'ready' | 'unavailable'>('idle');
  const [rebaseIssue, setRebaseIssue] = useState<{
    operation: ReviewedCollectionMemberOperation;
    reason: 'member-missing' | 'anchor-missing';
  } | null>(null);
  const [boundary, setBoundary] = useState<BoundaryMove | null>(null);
  const transferIds = new Set(transfer?.memberIds ?? []);
  const saveInitialMembers = (editorMembers ?? draftPage.members).filter((member) => !transferIds.has(member.id));
  const saveDesiredMembers = members.filter((member) => !transferIds.has(member.id));
  const savePlan = buildCollectionSaveReviewPlan({
    collectionId: page.id,
    revision: draftPage.revision,
    firstPage: draftPage.firstPage,
    initial: saveInitialMembers,
    desired: saveDesiredMembers,
    before: {
      title: draftPage.title,
      description: draftPage.description,
      visibility: draftPage.visibility,
      presentationKind: draftPage.presentationKindSource === 'owner' ? (draftPage.presentationKind ?? null) : null,
      coverMediaId: draftPage.coverMediaId ?? null,
    },
    after: {
      title,
      description,
      visibility,
      presentationKind: kind,
      coverMediaId,
    },
    batchRemovalIds,
    transfer: transfer
      ? {
          sourceTitle: transfer.sourceTitle,
          destinationTitle: transfer.destination.title,
          memberIds: transfer.memberIds,
          after: transfer.after,
        }
      : null,
  });
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
    plan: savePlan,
    outcomes: initialCollectionSaveOutcomes(savePlan),
    attempts: new Map<string, CapturedCollectionSaveAttempt>(),
    currentRevision: transfer?.sourceRevision ?? draftPage.revision,
    transferRevisions: null as { source: number; destination: number } | null,
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
      filteredRemovalRef.current?.retire();
    },
    [],
  );
  useEffect(() => {
    if (filteredRemovalRef.current?.retireIfStale()) {
      filteredRemovalRef.current = null;
      setFilteredRemoval(null);
    }
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
      setSaveRunView(null);
      setConflictBasis(null);
      setConflictBasisState('idle');
      setRebaseIssue(null);
      setEditing(true);
    } catch {
      if (isCurrent()) setFailure(m.error_message());
    } finally {
      finishRequest(request);
    }
  }

  function resetEditor(source: EditableCollectionPage, preserveSaveResult = false) {
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
    if (!preserveSaveResult) {
      setSaveRunView(null);
      setConflictBasis(null);
      setConflictBasisState('idle');
      setRebaseIssue(null);
    }
  }

  function cancelEditing() {
    if (!isCurrent() || pending || conflict || saveIntent.current !== null) return;
    resetEditor(page);
  }

  const draftTextInvalid = () =>
    collectionTextIssue('title', title) ||
    collectionTextIssue('description', description) ||
    members.some((member) => collectionTextIssue('note', member.note));

  function publishSaveRun(run: NonNullable<typeof saveIntent.current>, complete = false) {
    setSaveRunView({
      plan: run.plan,
      initial: run.editorMembers ?? run.page.members,
      desired: run.members,
      outcomes: run.outcomes.map((outcome) => ({ ...outcome, ...(outcome.undo ? { undo: [...outcome.undo] } : {}) })),
      complete,
      recoverCurrent: run.transfer === null,
    });
  }

  async function readCurrentConflictBasis() {
    if (!isCurrent() || !owner) return;
    setConflictBasisState('reading');
    setConflictBasis(null);
    setRebaseIssue(null);
    try {
      const basis = await (readEditorPage ? readEditorPage() : refreshPage());
      if (!isCurrent()) return;
      if (
        basis.id !== page.id ||
        basis.visibility === null ||
        !admitsCollectionOperation(basis.viewerActions, 'collection:update', 'collection.update') ||
        (basis.memberState ?? 'ready') !== 'ready' ||
        basis.filterStatus
      ) {
        setConflictBasisState('unavailable');
        return;
      }
      setConflictBasis(basis);
      setConflictBasisState('ready');
    } catch {
      if (isCurrent()) setConflictBasisState('unavailable');
    }
  }

  function discardDraftForCurrentBasis() {
    if (!conflictBasis || !saveIntent.current || collectionSaveHasUnknown(saveIntent.current.outcomes) || !isCurrent()) return;
    resetEditor(conflictBasis);
  }

  function reviewRemainingAgainstCurrent(discardOperationId?: string) {
    const run = saveIntent.current;
    const basis = conflictBasis;
    if (!run || !basis || run.transfer || collectionSaveHasUnknown(run.outcomes) || !isCurrent()) return;
    const remaining = remainingCollectionMemberOperations(run.plan, run.outcomes).filter(
      (entry) => entry.id !== discardOperationId,
    );
    const rebased = rebaseRemainingCollectionDraft(basis.members, remaining, basis.firstPage);
    if (!rebased.ok) {
      setRebaseIssue({ operation: rebased.operation, reason: rebased.reason });
      return;
    }
    const metadataConfirmed = run.outcomes.some(
      (outcome) => outcome.stepId === 'metadata' && outcome.status === 'confirmed',
    );
    editorPage.current = basis;
    setEditorMembers(basis.members);
    setMembers(rebased.members);
    setTitle(metadataConfirmed ? basis.title : run.title);
    setDescription(metadataConfirmed ? (basis.description ?? '') : run.description);
    setVisibility(metadataConfirmed ? (basis.visibility ?? 'private') : run.visibility);
    setKind(
      metadataConfirmed
        ? basis.presentationKindSource === 'owner'
          ? (basis.presentationKind ?? null)
          : null
        : run.kind,
    );
    setCoverMediaId(metadataConfirmed ? (basis.coverMediaId ?? null) : run.coverMediaId);
    saveIntent.current = null;
    writeKeys.current.clear();
    setSaveRunView(null);
    setConflictBasis(null);
    setConflictBasisState('idle');
    setRebaseIssue(null);
    setConflict(false);
    setSaveConfirmed(false);
    setFailure('');
  }

  function discardUnavailableDraftOperation() {
    if (!rebaseIssue) return;
    reviewRemainingAgainstCurrent(rebaseIssue.operation.id);
  }

  function restoreOffer(episode: CollectionMemberUndo) {
    const existing = nativeUndoKeys.current.get(episode.deletionId);
    const key = existing ?? crypto.randomUUID();
    if (!existing) nativeUndoKeys.current.set(episode.deletionId, key);
    return { ...episode, key };
  }

  function saveOperation(step: CollectionSavePlanStep): CollectionOperation {
    if (step.kind === 'metadata') return 'collection.update';
    if (step.kind === 'remove-batch') return 'collection_member.batch_remove';
    if (step.kind === 'transfer') return 'collection_member.transfer';
    switch (step.operation.operation.kind) {
      case 'remove':
        return 'collection_member.delete';
      case 'move':
        return 'collection_member.move';
      case 'note':
        return 'collection_member.update';
    }
  }

  function createSaveAttempt(
    run: NonNullable<typeof saveIntent.current>,
    step: CollectionSavePlanStep,
  ): CapturedCollectionSaveAttempt {
    const operation = saveOperation(step);
    const requestHeaders = headers(operation, run.credential ?? '');
    const fingerprintKey = (operands: unknown) => {
      const fingerprint = JSON.stringify(operands);
      let key = writeKeys.current.get(fingerprint);
      if (!key) {
        key = crypto.randomUUID();
        writeKeys.current.set(fingerprint, key);
      }
      return key;
    };
    const credential = requestHeaders['X-CSRF-Token'];
    if (step.kind === 'metadata') {
      if (run.currentRevision === undefined) throw new Error('Missing Collection revision');
      const body = {
        collectionId: run.page.id,
        revision: run.currentRevision,
        title: run.title,
        description: run.description,
        visibility: run.visibility,
        ...(run.kind !== run.storedKind ? { presentationKind: run.kind } : {}),
        ...(run.coverMediaId !== (run.page.coverMediaId ?? null) ? { coverMediaId: run.coverMediaId } : {}),
      };
      const key = fingerprintKey(body);
      const data = { ...body, idempotencyKey: key };
      return {
        operation,
        key,
        credential,
        data,
        send: () => run.send.updateCollection({ data, headers: requestHeaders }),
      };
    }
    if (step.kind === 'remove-batch') {
      if (run.currentRevision === undefined) throw new Error('Missing Collection revision');
      const body = {
        collectionId: run.page.id,
        revision: run.currentRevision,
        memberIds: step.operations.map((entry) => entry.operation.memberId),
      };
      const key = fingerprintKey(body);
      const data = { ...body, idempotencyKey: key };
      return {
        operation,
        key,
        credential,
        data,
        send: () => run.send.batchRemoveCollectionMembers({ data, headers: requestHeaders }),
      };
    }
    if (step.kind === 'transfer') {
      if (!run.transfer) throw new Error('Missing Collection transfer capture');
      const body = {
        collectionId: run.transfer.sourceId,
        revision: run.transfer.sourceRevision,
        memberIds: run.transfer.memberIds,
        destinationCollectionId: run.transfer.destination.id,
        destinationRevision: run.transfer.destination.revision,
        after: run.transfer.after,
      };
      const key = run.transfer.idempotencyKey;
      const data = { ...body, idempotencyKey: key };
      return {
        operation,
        key,
        credential,
        data,
        send: () => run.send.transferCollectionMembers({ data, headers: requestHeaders }),
      };
    }

    const memberOperation = step.operation.operation;
    const base = { collectionId: run.page.id };
    if (memberOperation.kind === 'remove') {
      if (run.currentRevision === undefined) throw new Error('Missing Collection revision');
      const body = { ...base, memberId: memberOperation.memberId, revision: run.currentRevision };
      const key = fingerprintKey([run.page.id, memberOperation, run.currentRevision]);
      const data = { ...body, idempotencyKey: key };
      return {
        operation,
        key,
        credential,
        data,
        send: () => run.send.removeCollectionMember({ data, headers: requestHeaders }),
      };
    }
    if (memberOperation.kind === 'move') {
      const body = { ...base, memberId: memberOperation.memberId, after: memberOperation.after };
      const key = fingerprintKey([run.page.id, memberOperation, run.currentRevision]);
      const data = { ...body, idempotencyKey: key };
      return {
        operation,
        key,
        credential,
        data,
        send: () => run.send.moveCollectionMember({ data, headers: requestHeaders }),
      };
    }
    const body = { ...base, memberId: memberOperation.memberId, note: memberOperation.note };
    const key = fingerprintKey([run.page.id, memberOperation, run.currentRevision]);
    const data = { ...body, idempotencyKey: key };
    return {
      operation,
      key,
      credential,
      data,
      send: () => run.send.updateMemberNote({ data, headers: requestHeaders }),
    };
  }

  async function executeSaveStep(
    run: NonNullable<typeof saveIntent.current>,
    step: CollectionSavePlanStep,
  ): Promise<CollectionSaveStepOutcome | null> {
    let attempt = run.attempts.get(step.id);
    if (!attempt) {
      try {
        attempt = createSaveAttempt(run, step);
        run.attempts.set(step.id, attempt);
      } catch {
        if (!isCurrent()) return null;
        setConflict(true);
        setFailure(m.collection_save_not_sent_help());
        setConflictBasisState('reading');
        void readCurrentConflictBasis();
        return { stepId: step.id, status: 'not-sent', reason: 'credential-unavailable' };
      }
    }

    let result: CollectionSaveCommandResult;
    try {
      result = await attempt.send();
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!isCurrent(attempt.operation)) return null;
    if (!result.ok) {
      const status = collectionSaveOutcomeStatus(result.reason);
      setConflict(status !== 'unknown');
      setFailure(
        status === 'unknown'
          ? m.collection_save_unknown_help()
          : status === 'conflict'
            ? m.library_collection_conflict()
            : writeMessage(result),
      );
      if (result.reason === 'closed' || result.reason === 'unavailable') setBulkUnavailable(true);
      if (step.kind === 'transfer') setTransferState(status === 'unknown' ? 'unknown' : 'refused');
      if (status !== 'unknown' && !run.transfer) {
        setConflictBasisState('reading');
        void readCurrentConflictBasis();
      }
      return { stepId: step.id, status, reason: result.reason };
    }

    const targetId = 'id' in result ? result.id : undefined;
    const revision = 'revision' in result ? result.revision : undefined;
    const undoEpisodes = 'undo' in result
      ? Array.isArray(result.undo)
        ? result.undo
        : result.undo
          ? [result.undo]
          : []
      : [];
    const outcome: CollectionSaveStepOutcome = {
      stepId: step.id,
      status: 'confirmed',
      ...(targetId ? { targetId } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(undoEpisodes.length ? { undo: undoEpisodes } : {}),
    };
    if (
      step.kind === 'metadata' ||
      step.kind === 'remove-batch' ||
      (step.kind === 'member' && step.operation.operation.kind === 'remove')
    )
      run.currentRevision = revision;
    if (step.kind === 'transfer' && 'destinationRevision' in result) {
      run.currentRevision = result.revision;
      run.transferRevisions = { source: result.revision, destination: result.destinationRevision };
      outcome.destinationRevision = result.destinationRevision;
      setTransferState('confirmed');
    }
    if (step.kind === 'member' && step.operation.operation.kind === 'note') {
      const memberId = step.operation.operation.memberId;
      setSavedNoteIds((current) => new Set([...current, memberId]));
    }
    if (undoEpisodes.length) {
      const offers = undoEpisodes.map((episode) => restoreOffer(episode));
      setUndo((current) => {
        const known = new Set(current.map((item) => item.deletionId));
        const added = offers.filter((item) => !known.has(item.deletionId));
        return added.length ? [...current, ...added] : current;
      });
    }
    return outcome;
  }

  async function save(event?: FormEvent<HTMLFormElement>, confirmed = false, confirmedTransfer = false) {
    event?.preventDefault();
    if (!isCurrent('collection.update') || !hydrated || pending || conflict || !editing || !owner) return;
    if (transfer && !confirmedTransfer && saveIntent.current === null) return;
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
    const run = (saveIntent.current ??= captureSave());
    publishSaveRun(run);
    try {
      const progression = await runCollectionSaveSteps(
        run.plan.steps,
        run.outcomes,
        (step) => executeSaveStep(run, step),
        () => publishSaveRun(run),
      );
      if (!progression.complete || !isCurrent()) return;
      publishSaveRun(run, true);
      saveIntent.current = null;
      setSaveConfirmed(true);
      setConflict(false);
      setFailure('');
      setConflictBasis(null);
      setConflictBasisState('idle');
      if (run.transfer && run.transferRevisions) {
        const capturedTransfer = run.transfer;
        const receipt: CollectionTransferReceipt = {
          sourceId: capturedTransfer.sourceId,
          destinationId: capturedTransfer.destination.id,
          sourceTitle: capturedTransfer.sourceTitle,
          destinationTitle: capturedTransfer.destination.title,
          sourceHref: capturedTransfer.sourceHref,
          destinationHref: capturedTransfer.destinationHref,
          sourceRevision: run.transferRevisions.source,
          destinationRevision: run.transferRevisions.destination,
          state: 'reading',
        };
        setTransferReceipt(receipt);
        const [sourceRead, destinationRead] = await Promise.allSettled([
          reloadCollection(true),
          readCollectionMovePlacements({
            data: { collectionId: capturedTransfer.destination.id, revision: run.transferRevisions.destination },
          }),
        ]);
        if (!isCurrent()) return;
        const sourcePage = sourceRead.status === 'fulfilled' ? sourceRead.value : undefined;
        const sourceReady = !!sourcePage && sourcePage.id === capturedTransfer.sourceId;
        const destinationReady = destinationRead.status === 'fulfilled';
        resetEditor(sourceReady ? sourcePage : run.page, true);
        setTransferReceipt({ ...receipt, state: sourceReady && destinationReady ? 'ready' : 'unavailable' });
        return;
      }
      const refreshed = await reloadCollection(true);
      if (!isCurrent()) return;
      resetEditor(refreshed ?? run.page, true);
    } catch {
      if (!isCurrent()) return;
      setFailure(m.error_message());
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

  function previewFilteredOccurrenceRemoval() {
    if (
      !owner ||
      !isCurrent('collection_member.batch_remove') ||
      !admission.current('library_operation.preview') ||
      pending ||
      draftFrozen ||
      conflict ||
      memberDraftChanged ||
      transfer !== null ||
      bulkOccurrenceRemoveRef.current ||
      filteredRemovalRef.current ||
      page.filterStatus ||
      page.filterIgnored?.length ||
      (page.filterActive && !page.filter)
    )
      return;
    const viewer = session.state === 'signed-in' ? session.subject : null;
    if (!viewer) return;
    try {
      const requestHeaders = Object.fromEntries(
        new Headers({
          ...headers('collection_member.batch_remove'),
          'accept-language': getLocale(),
          'content-type': 'application/json',
        }).entries(),
      );
      const manifest = filteredOccurrenceRemovalManifest(
        { id: page.id, title: page.title },
        page.filter,
        viewer,
        requestHeaders,
        filteredOccurrenceRemovalSender,
      );
      const journey = new FilteredOccurrenceRemoval(
        manifest,
        {
          context: () => admission.retained() && admission.observed() && current(),
          read: () =>
            isCurrent() &&
            admission.current('library_operation.get') &&
            admission.current('library_operation.outcomes'),
          preview: () => isCurrent('collection_member.batch_remove') && admission.current('library_operation.preview'),
          confirm: () => isCurrent('collection_member.batch_remove') && admission.current('library_operation.confirm'),
        },
        (address) => readBulkOperation({ data: address }),
        () => refreshFilteredRemoval((value) => value + 1),
      );
      filteredRemovalRef.current = journey;
      setFilteredRemoval(journey);
      void journey.preview().then((ok) => {
        if (ok) void journey.read();
      });
    } catch {
      setFailure(m.library_filtered_occurrence_remove_unavailable());
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
  const memberDraftChanged = editing && savePlan.operations.length > 0;
  const removalCount = savePlan.operations.filter((entry) => entry.operation.kind === 'remove').length;
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
  const activeSave = saveIntent.current;
  const activePlan = activeSave?.plan ?? savePlan;
  const activeInitial = activeSave?.editorMembers ?? activeSave?.page.members ?? saveInitialMembers;
  const activeDesired = activeSave?.members ?? saveDesiredMembers;
  const activeOutcomes = activeSave?.outcomes ?? [];
  const draftNavigation = useCollectionDraftNavigation({
    dirty: draftChanged && !saveConfirmed,
    locked:
      editing &&
      !saveConfirmed &&
      (writing || draftFrozen || (boundary !== null && ['pending', 'unknown', 'confirmed'].includes(boundary.phase))),
    isCurrent: () => owner && isCurrent(),
  });
  const readPageReady = (page.memberState ?? 'ready') === 'ready';
  const readMembers = readPageReady ? (page.filteredMembers ?? page.members) : [];
  const readPositionScope = collectionPositionScope(
    { firstPage: page.firstPage, cursor: cursor ?? page.cursor },
    collectionPageIsFiltered(page, search),
  );
  const readPageKey = collectionReadingPageKey(
    currentHref,
    collectionViewAddress(page.id, layout, cursor, search),
    page.revision,
    readMembers,
  );
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
          <CollectionPresentationSummary
            layout={layout}
            kind={page.presentationKindSource === 'owner' ? page.presentationKind : null}
            types={page.presentationTypes}
          />
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
                ...(ownerCurrent
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
        {ownerCurrent && isCurrent('collection_member.batch_remove') && admission.current('library_operation.preview') ? (
          <Button
            type="button"
            variant="outline"
            className="my-3"
            onClick={previewFilteredOccurrenceRemoval}
            disabled={
              pending ||
              draftFrozen ||
              conflict ||
              memberDraftChanged ||
              transfer !== null ||
              !!bulkOccurrenceRemove ||
              !!filteredRemoval ||
              !!page.filterStatus ||
              !!page.filterIgnored?.length ||
              (!!page.filterActive && !page.filter)
            }
          >
            {m.library_filtered_occurrence_remove_action()}
          </Button>
        ) : null}
        {filteredRemoval && isCurrent() ? (
          <FilteredOccurrenceRemovalReview
            journey={filteredRemoval}
            canPreview={isCurrent('collection_member.batch_remove') && admission.current('library_operation.preview')}
            canConfirm={isCurrent('collection_member.batch_remove') && admission.current('library_operation.confirm')}
          />
        ) : null}
        <AlertDialog
          open={deletion !== null && isCurrent()}
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
          open={removalConfirmation && ownerCurrent}
          count={removalCount}
          onOpenChange={setRemovalConfirmation}
          onConfirm={() => void save(undefined, true)}
        />

        {ownerCurrent && visibleUndo.length ? (
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
        {failure && isCurrent() ? <p role="alert">{failure}</p> : null}
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
        {conflict && ownerCurrent ? (
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

        {adding && isCurrent('collection_member.create') ? (
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
        {editing && ownerCurrent ? (
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
            <CollectionMetadataHistory collectionId={page.id} isCurrent={() => isCurrent('collection.update')} />
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
        {!editing ? (
          <>
            <BulkFilteredAdd
              source={{ id: page.id, ...(page.filter === undefined ? {} : { filter: page.filter }) }}
              address={JSON.stringify([page.id, cursor, search, queryKey])}
              disabled={
                page.filterStatus !== undefined ||
                (page.filterIgnored?.length ?? 0) > 0 ||
                (page.memberState ?? 'ready') !== 'ready'
              }
              isCurrent={() => admission.retained() && (sourceCurrent?.() ?? true)}
            />
            <FilteredLibraryRemovalControl
              source={{ id: page.id, ...(page.filter === undefined ? {} : { filter: page.filter }) }}
              boundary={JSON.stringify([page.visibility, cursor, search, queryKey])}
              eligible={(page.memberState ?? 'ready') === 'ready' && !page.filterStatus && !page.filterIgnored?.length}
              isCurrent={() => isCurrent()}
            />
            <CollectionFilteredStatus
              page={page}
              address={JSON.stringify([page.id, cursor, search, queryKey])}
              ready={(page.memberState ?? 'ready') === 'ready'}
              isCurrent={() => admission.retained() && (sourceCurrent?.() ?? true)}
            />
          </>
        ) : null}
        <section aria-label={m.library_collection_members()}>
          <h2 className="sr-only">{m.library_collection_members()}</h2>
          {editing && ownerCurrent && boundaryAdmitted ? (
            <div className="mb-3 space-y-1 text-sm text-muted-foreground" data-collection-boundary-guidance>
              <p>{m.library_collection_boundary_help()}</p>
              {draftChanged ? <p role="status">{m.library_collection_move_save_first()}</p> : null}
            </div>
          ) : null}
          {editing &&
          ownerCurrent &&
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
            <CollectionReadMembers<CollectionReadMember>
              members={readMembers}
              layout={layout}
              pageReady={readPageReady}
              pageKey={readPageKey}
              positionScope={readPositionScope}
              currentHref={currentHref}
              returnSource={page}
              admitInitialReturn={admitInitialComparisonReturn}
              onReferenceNavigate={() => setSelectedIds(new Set())}
              viewerProjection={viewerProjection}
              viewerActionHref={(member: CollectionReadMember) => {
                const row = collectionViewerFactForMember(viewerProjection, member);
                if (
                  viewerProjection.state !== 'current' ||
                  !member.subject ||
                  !member.subjectId ||
                  !collectionViewerHasPersonalAction(row, viewerProjection.question)
                )
                  return undefined;
                const title = pageText(libraryTitleValue(member.subject.label), getLocale()).text;
                const subject = subjectHref({ id: member.subjectId, label: title }, getLocale()).href;
                return collectionViewerActionHref(subject, collectionMemberReturnAddress(currentHref, member.id));
              }}
              presentationKind={page.presentationKind}
              typeRatios={page.typeRatios}
              listPresentations={page.listPresentations}
              comparisonDefinitions={page.comparisonDefinitions}
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
              comparisonDefinitions={page.comparisonDefinitions}
              editing={editing && ownerCurrent}
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
        {editing && ownerCurrent && (draftChanged || transfer || activeSave) ? (
          <CollectionEditReview
            plan={activePlan}
            initial={activeInitial}
            desired={activeDesired}
            types={page.presentationTypes}
            outcomes={activeOutcomes}
            basisState={conflictBasisState}
            currentBasis={conflictBasis}
            rebaseIssue={rebaseIssue}
            recoverCurrent={!activeSave?.transfer}
            onRetry={activeSave ? () => void save(undefined, true, Boolean(activeSave.transfer)) : undefined}
            onReadCurrent={activeSave && !activeSave.transfer ? () => void readCurrentConflictBasis() : undefined}
            onDiscard={activeSave && !activeSave.transfer ? discardDraftForCurrentBasis : undefined}
            onDiscardUnavailable={
              activeSave && !activeSave.transfer && rebaseIssue ? discardUnavailableDraftOperation : undefined
            }
            onReviewCurrent={
              activeSave && !activeSave.transfer ? () => reviewRemainingAgainstCurrent() : undefined
            }
          />
        ) : null}
        {!editing && ownerCurrent && saveRunView?.complete ? (
          <CollectionEditReview
            plan={saveRunView.plan}
            initial={saveRunView.initial}
            desired={saveRunView.desired}
            types={page.presentationTypes}
            outcomes={saveRunView.outcomes}
            complete
            recoverCurrent={false}
          />
        ) : null}
        {editing && ownerCurrent ? (
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

/** Read presentation is separate from the occurrence editor and performs no enrichment reads. */
export function CollectionReadMembers<Member extends CollectionReadMember>({
  members,
  layout = 'list',
  pageReady = true,
  pageKey: suppliedPageKey,
  positionScope: suppliedPositionScope,
  presentationKind,
  typeRatios,
  listPresentations,
  comparisonDefinitions,
  currentHref,
  returnSource,
  admitInitialReturn,
  onReferenceNavigate,
  viewerProjection,
  viewerActionHref,
  onCopy,
}: {
  members: readonly Member[];
  layout?: 'grid' | 'list';
  pageReady?: boolean;
  pageKey?: string;
  positionScope?: CollectionPositionScope;
  presentationKind?: string | null | undefined;
  typeRatios?: Readonly<Record<string, string>> | undefined;
  listPresentations?: CollectionListPresentations | undefined;
  comparisonDefinitions?: CollectionComparisonDefinitions | undefined;
  currentHref?: string | undefined;
  returnSource?: object | undefined;
  admitInitialReturn?: boolean | undefined;
  onReferenceNavigate?: (() => void) | undefined;
  viewerProjection?: CollectionViewerProjection;
  viewerActionHref?: (member: Member) => string | undefined;
  onCopy: (member: Member) => void | Promise<void>;
}) {
  const locale = getLocale();
  const pageKey = suppliedPageKey ?? collectionReadingPageKey(currentHref, currentHref ?? '/', 0, members);
  const positionScope = suppliedPositionScope ?? collectionPositionScopeFromAddress(currentHref);
  const { admitReferenceReturn, missingOccurrence } = useCollectionComparisonReturn(
    members,
    currentHref,
    returnSource,
    admitInitialReturn,
    pageReady,
  );
  const [noteExpansion, setNoteExpansion] = useState<{ pageKey: string; values: Readonly<Record<string, boolean>> }>({
    pageKey,
    values: {},
  });
  const expandedNotes = noteExpansion.pageKey === pageKey ? noteExpansion.values : {};
  useEffect(() => {
    setNoteExpansion((previous) => (previous.pageKey === pageKey ? previous : { pageKey, values: {} }));
  }, [pageKey]);
  function updateNoteExpansion(noteKey: string, expanded: boolean) {
    setNoteExpansion((previous) => ({
      pageKey,
      values: { ...(previous.pageKey === pageKey ? previous.values : {}), [noteKey]: expanded },
    }));
  }

  const items = members.map((member, index) => {
    const subject = member.subject;
    // Render-only keys keep unidentified rows separate without creating an occurrence identity for actions.
    const key = member.id ? `occurrence:${member.id}` : `display-only:${index}`;
    const noteKey = member.id ? `occurrence:${member.id}` : `display-only:${index}`;
    const titleValue = subject?.label ? pageText(libraryTitleValue(subject.label), locale) : undefined;
    const title = titleValue?.text || (subject ? m.subject_value_unlabelled() : m.library_subject_unavailable());
    const actionHref = viewerActionHref?.(member);
    const details = (
      <CollectionMemberOccurrenceDetails
        member={member}
        position={index + 1}
        scope={positionScope}
        pageKey={pageKey}
        noteStateKey={noteKey}
        noteExpanded={expandedNotes[noteKey] ?? false}
        onNoteExpandedChange={(expanded) => updateNoteExpansion(noteKey, expanded)}
        currentHref={currentHref}
        listPresentations={listPresentations}
        comparisonDefinitions={comparisonDefinitions}
        onReferenceNavigate={(anchor) => {
          admitReferenceReturn(anchor);
          onReferenceNavigate?.();
        }}
        {...(viewerProjection ? { viewerProjection } : {})}
        {...(actionHref ? { actionHref } : {})}
      />
    );

    if (!subject) {
      return layout === 'grid' ? (
        <div key={key} role="listitem" data-slot="collection-member-card" className="min-w-0 py-4 text-sm">
          {details}
        </div>
      ) : (
        <ListRow key={key} className="py-4 text-muted-foreground">
          {details}
        </ListRow>
      );
    }

    const presentation = listPresentations?.[subject.type];
    const menu = (
      <Menu
        title={m.library_collection_actions()}
        backLabel={m.library_collection_cancel()}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={`${m.library_collection_actions()}: ${title}`}
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
            href={collectionComparisonHref(subject.id, title, locale, currentHref, member.id)}
            title={title}
            {...(titleValue?.lang ? { titleLang: titleValue.lang } : {})}
            cover={{
              subject: { id: subject.id, title, types: [subject.type] },
              cover: subject.cover,
              src: coverSrc,
              ratio: collectionMemberRatio(subject, typeRatios, listPresentations),
              ...(presentation ? { listPresentation: presentation } : {}),
            }}
            state={details}
            menuTrigger={menu}
          />
        </div>
      );

    return (
      <MemberListRow
        key={key}
        href={collectionComparisonHref(subject.id, title, locale, currentHref, member.id)}
        subject={{ id: subject.id, title, types: [subject.type] }}
        cover={subject.cover}
        src={coverSrc}
        title={title}
        {...(titleValue?.lang ? { titleLang: titleValue.lang } : {})}
        ratio={collectionMemberRatio(subject, typeRatios, listPresentations)}
        {...(presentation ? { listPresentation: presentation } : {})}
        trailing={menu}
      >
        {details}
      </MemberListRow>
    );
  });

  const onReadNavigate = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (anchor && new URL(anchor.href).searchParams.has('via')) {
      // The UI row owns its stretched link; its disclosed details own the occurrence anchor.
      const row = anchor.closest('[data-slot="list-row"], [data-slot="collection-member-card"]');
      const occurrence = row?.querySelector<HTMLElement>('[data-collection-member-id]')?.dataset.collectionMemberId;
      if (occurrence && row instanceof HTMLElement) row.dataset.collectionMemberId = occurrence;
      admitReferenceReturn(anchor);
      onReferenceNavigate?.();
    }
  };

  return (
    <section aria-label={m.library_collection_members()} data-slot="collection-reading-region" className="space-y-3">
      {missingOccurrence ? (
        <p role="status" data-collection-return="missing-occurrence" className="text-sm text-muted-foreground">
          {m.library_collection_return_missing_occurrence()}
        </p>
      ) : null}
      <p data-slot="collection-reading-position-scope" className="text-sm text-muted-foreground">
        {collectionPositionScopeMessage(positionScope)}
      </p>
      {layout === 'grid' ? (
        <div
          role="list"
          className="min-w-0"
          data-collection-members
          data-collection-layout={layout}
          onClickCapture={onReadNavigate}
        >
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
        <ul
          className="min-w-0 space-y-3"
          data-collection-members
          data-collection-layout={layout}
          onClickCapture={onReadNavigate}
        >
          {items}
        </ul>
      )}
    </section>
  );
}
