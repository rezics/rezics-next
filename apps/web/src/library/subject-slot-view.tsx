import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { LibraryRestoreInput, LibraryRestoreReceipt } from './entries-read';
import type { SubjectLabelStep } from './subject-label-step';
import { SubjectLabelMore } from './subject-labels.tsx';
import { labelReadMessage, SubjectLabelReadNotice } from './subject-labels.tsx';
import { EntryUndoForm, EntryRemoveForm, EntryRestoreFeedback } from './entry-undo';
import { Exposure, operationIsAdmitted, useOperation } from '../kernel/exposure';
import { undoToast } from '@rezics/ui/undo-toast';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Menu } from '@rezics/ui/menu';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { SubjectLabelNotice } from './subject-labels.tsx';
import { subjectHref } from '../subject/subject-href';
import { subjectProgressEntryLocationState, subjectSlotReturnTo } from './subject-slot-return-context';
import { useSession } from '../session/query';
import type { SubjectReference } from './subject-ref';
import {
  mutateSubjectLabelAction,
  mutateSubjectLibrarySlot,
  readSubjectLibraryCollections,
  readSubjectPublicCollections,
  searchSubjectLabelsAction,
  restoreSubjectLibrarySlot,
} from './subject-slot-actions';
import { CollectionChooserPanel } from './subject-collection-journey/chooser';
import { PublicCollectionsPanel } from './subject-collection-journey/public';
import { publicCountOf, type CapturedChooserTarget } from './subject-collection-journey';
import type { SubjectLibraryMutation, SubjectLibraryMutationResponse, SubjectLibrarySlotData } from './subject-slot';
import {
  SubjectEntryStateReview,
  captureEntryStateBasis,
  entryStateBasisMatches,
  type EntryStateConflictIntent,
  type ReviewedEntryState,
} from './subject-entry-state-review/review';
import {
  SubjectEntryRemovalReview,
  captureEntryRemovalReview,
  entryRemovalReviewMatches,
  type ReviewedEntryRemoval,
} from './subject-entry-removal-review/review';
import { normalizeLibraryLabelName } from './subject-label-name';
import { subjectLabelInputIssue } from './subject-label-input.ts';
import { SubjectLabelInput } from './subject-label-input.tsx';
import type {
  LibraryLabelSummary,
  SubjectLabel,
  SubjectLabelMutationInput,
  SubjectLabelMutationResult,
} from './subject-labels.ts';
import { useSubjectLibraryObservation, type SlotLifetime } from './subject-library-current-origin';
export { useSubjectLibraryObservation } from './subject-library-current-origin';

type SubjectSlotProps = {
  subject: SubjectReference;
  locale: string;
  data: SubjectLibrarySlotData;
};

// The state action is the page's one filled primary button; every other control here is a secondary (outline) button.
const buttonClass = buttonVariants({ variant: 'outline' });
const primaryClass = buttonVariants({ variant: 'default' });
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';
const controlFocusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const labelButtonClass = cn(
  buttonClass,
  'h-auto min-h-[44px] min-w-0 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]',
  controlFocusClass,
);
const labelChoiceClass = `min-h-[44px] w-full min-w-0 rounded px-2 py-2 text-start text-sm whitespace-normal [overflow-wrap:anywhere] hover:bg-muted disabled:opacity-50 ${controlFocusClass}`;
const subscribe = () => () => {};
type SlotAdmission = {
  signature: string;
  lifetime: SlotLifetime;
  seen: Set<string>;
  retired: Set<string>;
  episode?: string;
};

/** The shared owner observes the browser even when a direct Subject or Zone host retains its old props. */
export function SubjectLibrarySlot(props: SubjectSlotProps) {
  const session = useSession();
  const observation = useSubjectLibraryObservation(props.subject, props.locale);
  const observedScope = observation.value.scope;
  const browser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const currentHref = useLocation({ select: (location) => location.publicHref });
  const returnTo = subjectSlotReturnTo(currentHref, props.subject, props.locale);
  const entryGet = useOperation('library_entry.get');
  const assignments = useOperation('library_label.assignment_list');
  const collectionList = useOperation('collection.list');
  const admissions = useRef<Partial<Record<'entry' | 'labels' | 'collections', SlotAdmission>>>({});
  const scope = JSON.stringify([
    props.subject.id,
    props.subject.type,
    props.locale,
    returnTo,
    browser ? session.state : 'presentation',
    browser ? session.subject : null,
    observation.owner,
    browser ? observedScope : 0,
  ]);
  const scopeSequence = useRef({ scope, value: 0 });
  if (scopeSequence.current.scope !== scope) scopeSequence.current = { scope, value: scopeSequence.current.value + 1 };
  const { data } = props;
  const provenance = data.provenance;
  const actualIdentity =
    !browser ||
    (observation.value.sessionReady &&
      session.state === 'signed-in' &&
      observation.value.viewer === session.subject &&
      observation.value.credential === session.csrfToken &&
      !!session.subject &&
      data.session === 'signed-in' &&
      provenance?.viewer === session.subject &&
      provenance.subjectId === props.subject.id &&
      !!provenance.readId &&
      (!data.entry || data.entry.subjectId === props.subject.id) &&
      (!data.undo || data.undo.subjectId === props.subject.id) &&
      (!data.restore ||
        !('entry' in data.restore) ||
        !data.restore.entry ||
        data.restore.entry.subjectId === props.subject.id));
  // Separate native operation admissions. Changing a label gate cannot retire a healthy entry or Collection read.
  const families = {
    entry: {
      admitted: entryGet && data.entryAvailable && (!browser || observation.value.entryAdmitted),
      revision: observation.value.entry,
      seed: observation.value.entrySeed,
    },
    labels: {
      admitted: assignments && data.labels !== null && (!browser || observation.value.labelsAdmitted),
      revision: observation.value.labels,
      seed: observation.value.labelsSeed,
    },
    collections: {
      admitted: collectionList && (!browser || observation.value.collectionsAdmitted),
      revision: observation.value.collections,
      seed: observation.value.collectionsSeed,
    },
  };
  const ready = { entry: false, labels: false, collections: false };
  for (const family of ['entry', 'labels', 'collections'] as const) {
    let observed = admissions.current[family];
    const revision = families[family].revision;
    const isCurrent = (...operations: Parameters<SlotLifetime['current']>) => {
      const current = observation.read();
      return (
        !browser ||
        (observation.isMounted() &&
          current.sessionReady &&
          current.scope === observedScope &&
          current[family] === revision &&
          operations.every((operation) => operationIsAdmitted(operation, current.admitted)))
      );
    };
    const signature = JSON.stringify([scope, browser ? families[family].seed : 0]);
    if (!observed || observed.signature !== signature) {
      const retired = observed?.retired ?? new Set<string>();
      for (const id of observed?.seen ?? []) retired.add(id);
      if (observed) observed.lifetime.active = false;
      observed = {
        signature,
        lifetime: { seed: signature, active: false, current: () => false },
        seen: new Set(),
        retired,
      };
      admissions.current[family] = observed;
    }
    const accepted =
      actualIdentity &&
      families[family].admitted &&
      (!browser || (!!provenance && !observed.retired.has(provenance.readId)));
    // The dispatch episode changes on every actual observation. Private read retirement is independent
    // of healthy credential/admission refreshes so uncertain native intent is not silently replaced.
    const episode = `${signature}:${revision}:${accepted}:${provenance?.readId}`;
    if (observed.episode !== episode) {
      observed.lifetime.active = false;
      const lifetime = {
        seed: signature,
        active: accepted,
        current: (...operations: Parameters<SlotLifetime['current']>) => lifetime.active && isCurrent(...operations),
      };
      observed.episode = episode;
      observed.lifetime = lifetime;
    }
    if (provenance) observed.seen.add(provenance.readId);
    ready[family] = accepted;
  }
  const memberResult = data.result === 'added' || data.result === 'collection-full' || data.result === 'dynamic';
  const current: SubjectLibrarySlotData = !browser
    ? data
    : {
        session:
          session.state === 'signed-out'
            ? 'signed-out'
            : actualIdentity && session.state === 'signed-in' && (ready.entry || ready.labels || ready.collections)
              ? 'signed-in'
              : 'unavailable',
        csrfToken: session.csrfToken,
        ...(provenance ? { provenance } : {}),
        entryAvailable: ready.entry && data.entryAvailable,
        entry: ready.entry ? data.entry : null,
        stateOptions: ready.entry ? (data.stateOptions ?? []) : [],
        ...(ready.entry && data.entryStateLabel ? { entryStateLabel: data.entryStateLabel } : {}),
        ...(ready.entry && data.undo ? { undo: data.undo } : {}),
        ...(ready.entry && data.restore ? { restore: data.restore } : {}),
        publicCollections: data.publicCollections,
        publicCollectionsNext: data.publicCollectionsNext,
        ...(data.publicCollectionsCount ? { publicCollectionsCount: data.publicCollectionsCount } : {}),
        collectionsLoaded: ready.collections && data.collectionsLoaded,
        collections: ready.collections ? data.collections : null,
        ...(ready.collections && data.collectionsNext !== undefined ? { collectionsNext: data.collectionsNext } : {}),
        labels: ready.labels ? data.labels : null,
        ...(ready.labels
          ? {
              ...(data.labelCreateKey ? { labelCreateKey: data.labelCreateKey } : {}),
              ...(data.labelAssignKey ? { labelAssignKey: data.labelAssignKey } : {}),
              ...(data.labelRemoveKeys ? { labelRemoveKeys: data.labelRemoveKeys } : {}),
              ...(data.labelUndoKey ? { labelUndoKey: data.labelUndoKey } : {}),
              ...(data.labelUndo ? { labelUndo: data.labelUndo } : {}),
              ...(data.labelResult ? { labelResult: data.labelResult } : {}),
            }
          : {}),
        ...(data.result && (memberResult ? ready.collections : ready.entry) ? { result: data.result } : {}),
      };
  return (
    <SubjectLibrarySlotView
      key={scopeSequence.current.value}
      {...props}
      data={current}
      entryIdentity={scope}
      entryObservation={observation.value.entry}
      entryLifetime={admissions.current.entry!.lifetime}
      labelLifetime={admissions.current.labels!.lifetime}
      collectionLifetime={admissions.current.collections!.lifetime}
    />
  );
}

/** Compact subject-level Library controls rendered in the page's template action slot. */
function SubjectLibrarySlotView({
  subject,
  locale,
  data,
  entryLifetime,
  entryIdentity,
  entryObservation,
  labelLifetime,
  collectionLifetime,
}: SubjectSlotProps & {
  entryLifetime: SlotLifetime;
  entryIdentity: string;
  entryObservation: number;
  labelLifetime: SlotLifetime;
  collectionLifetime: SlotLifetime;
}) {
  const queryClient = useQueryClient();
  const action = subjectHref({ id: subject.id, label: subject.label }, locale).href;
  const currentHref = useLocation({ select: (location) => location.publicHref });
  const returnTo = subjectSlotReturnTo(currentHref, subject, locale);
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionResult, setActionResult] = useState(data.result);
  const [memberResult, setMemberResult] = useState<SubjectLibrarySlotData['result']>();
  const entryFlight = useRef(false);
  const memberFlight = useRef(false);
  const pickerFlight = useRef(false);
  const labelFlight = useRef(false);
  // Explicit retry owns the original sender, credential and exact native command across read recovery.
  const uncertainEntry = useRef<{
    input: SubjectLibraryMutation;
    csrfToken: string;
    send: typeof mutateSubjectLibrarySlot;
    previous: string;
    review?: ReviewedEntryState;
    running: boolean;
    response?: SubjectLibraryMutationResponse | undefined;
  } | null>(null);
  const uncertainMember = useRef<{
    input: SubjectLibraryMutation;
    csrfToken: string;
    send: typeof mutateSubjectLibrarySlot;
    running: boolean;
    response?: SubjectLibraryMutationResponse | undefined;
  } | null>(null);
  const uncertainLabel = useRef<{
    input: SubjectLabelMutationInput;
    step?: SubjectLabelStep;
    seed: string;
    csrfToken: string;
    send: typeof mutateSubjectLabelAction;
    label?: LibraryLabelSummary | SubjectLabel;
    running: boolean;
    response?: SubjectLabelMutationResult | undefined;
  } | null>(null);
  const initialEntry =
    data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
  const [entry, setEntry] = useState(initialEntry);
  const [entryStateLabel, setEntryStateLabel] = useState(data.entryStateLabel ?? m.library_other());
  const [entryConflict, setEntryConflict] = useState<EntryStateConflictIntent | null>(null);
  const [removalReview, setRemovalReview] = useState<ReviewedEntryRemoval | null>(null);
  const [removalNotice, setRemovalNotice] = useState<'changed' | 'unavailable' | null>(null);
  const slotSection = useRef<HTMLElement | null>(null);
  const removalReviewTrigger = useRef<HTMLElement | null>(null);
  const removalFocusReturn = useRef(false);
  const removalConflictObservation = useRef<number | null>(null);
  const [removeKey] = useState(() => crypto.randomUUID());
  const [collections, setCollections] = useState(data.collections);
  const [collectionsLoaded, setCollectionsLoaded] = useState(data.collectionsLoaded);
  const [collectionsNext, setCollectionsNext] = useState(data.collectionsNext ?? null);
  const [collectionsProblem, setCollectionsProblem] = useState<'closed' | 'unavailable' | 'expired' | null>(null);
  const [chooserTarget, setChooserTarget] = useState<CapturedChooserTarget | null>(null);
  const chooserTargetRef = useRef<CapturedChooserTarget | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const captureRestore = (receipt: LibraryRestoreReceipt): LibraryRestoreInput => ({
    ...receipt,
    idempotencyKey: receipt.idempotencyKey ?? crypto.randomUUID(),
  });
  const [entryUndo, setEntryUndo] = useState(() => (data.undo ? captureRestore(data.undo) : undefined));
  const uncertainRestore = useRef<{
    input: LibraryRestoreInput;
    headers: Headers;
    send: typeof restoreSubjectLibrarySlot;
    running: boolean;
    response?: Awaited<ReturnType<typeof restoreSubjectLibrarySlot>> | undefined;
  } | null>(null);
  const restoreIdentity = useRef(entryIdentity);
  if (restoreIdentity.current !== entryIdentity) {
    restoreIdentity.current = entryIdentity;
    uncertainRestore.current = null;
    setEntryUndo(undefined);
  }
  const memberCreateAdmitted = useOperation('collection_member.create');
  const restoreAdmitted = useOperation('library_entry.restore');
  const entryPutAdmitted = useOperation('library_entry.put');
  const entryDeleteAdmitted = useOperation('library_entry.delete');
  const labelListAdmitted = useOperation('library_label.list');
  const [labels, setLabels] = useState(data.labels ?? []);
  const [labelQuery, setLabelQuery] = useState('');
  const [labelNameSubmitted, setLabelNameSubmitted] = useState(false);
  const labelInputIssue = subjectLabelInputIssue(labelQuery, !labelNameSubmitted);
  const [labelNext, setLabelNext] = useState<string | null>(null);
  const [labelReadReason, setLabelReadReason] = useState<string>();
  const [labelChoices, setLabelChoices] = useState<LibraryLabelSummary[]>([]);
  const [labelSearchState, setLabelSearchState] = useState<'idle' | 'loaded' | 'closed' | 'unavailable' | 'signed-out'>(
    'idle',
  );
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const labelPickerTrigger = useRef<HTMLElement>(null);
  const [labelPending, setLabelPending] = useState(false);
  const [labelNotice, setLabelNotice] = useState<string | undefined>(data.labelResult);
  const [labelUndo, setLabelUndo] = useState(data.labelUndo);
  const labelUndoKeys = useRef(new Map<string, string>());
  const restoredLabelEpisodes = useRef(new Set<string>());
  const usedLabelKeys = useRef(new Set<string>());
  const labelEpisode = (assignmentId: string, revision: number) => `${assignmentId}:${revision}`;
  function labelUndoKeyFor(assignmentId: string, revision: number) {
    const episode = labelEpisode(assignmentId, revision);
    let key = labelUndoKeys.current.get(episode);
    if (!key) {
      key =
        data.labelUndo?.assignmentId === assignmentId && data.labelUndo.revision === revision
          ? (data.labelUndoKey ?? crypto.randomUUID())
          : crypto.randomUUID();
      labelUndoKeys.current.set(episode, key);
    }
    return key;
  }
  const latestLabelQuery = useRef('');
  const searchOrigin = useRef({ query: labelQuery, open: labelPickerOpen, sequence: 0 });
  if (searchOrigin.current.query !== labelQuery || searchOrigin.current.open !== labelPickerOpen)
    searchOrigin.current = { query: labelQuery, open: labelPickerOpen, sequence: searchOrigin.current.sequence + 1 };
  const searchSequence = searchOrigin.current.sequence;
  const [entryOrigin, setEntryOrigin] = useState(entryLifetime);
  const [labelOrigin, setLabelOrigin] = useState(labelLifetime);
  const [collectionOrigin, setCollectionOrigin] = useState(collectionLifetime);
  // Render-time retirement prevents a stale private value from surviving even one committed replacement render.
  if (entryOrigin !== entryLifetime) {
    if (entryOrigin.seed !== entryLifetime.seed) {
      setEntryUndo(undefined);
    }
    setEntryOrigin(entryLifetime);
    setEntry(initialEntry);
    setEntryStateLabel(data.entryStateLabel ?? m.library_other());
    setEntryConflict(null);
    setRemovalReview(null);
    setRemovalNotice(null);
    removalReviewTrigger.current = null;
    removalFocusReturn.current = false;
    removalConflictObservation.current = null;
    setPending(false);
    setActionResult(undefined);
    setRestoreMessage(null);
    if (uncertainEntry.current) uncertainEntry.current.response = undefined;
    entryFlight.current = false;
  }
  if (labelOrigin !== labelLifetime) {
    if (labelOrigin.seed !== labelLifetime.seed) {
      if (
        uncertainLabel.current?.step ||
        uncertainLabel.current?.input.intent === 'create-and-assign' ||
        uncertainLabel.current?.input.intent === 'capture-assign'
      )
        uncertainLabel.current = null;
      setLabelUndo(undefined);
      labelUndoKeys.current.clear();
      restoredLabelEpisodes.current.clear();
    }
    setLabelOrigin(labelLifetime);
    setLabels(data.labels ?? []);
    setLabelPickerOpen(false);
    setLabelQuery('');
    setLabelNameSubmitted(false);
    latestLabelQuery.current = '';
    setLabelChoices([]);
    setLabelNext(null);
    setLabelReadReason(undefined);
    setLabelSearchState('idle');
    setLabelPending(false);
    setLabelNotice(undefined);
    labelFlight.current = false;
  }
  if (collectionOrigin !== collectionLifetime) {
    if (collectionOrigin.seed !== collectionLifetime.seed) {
      setChooserTarget(null);
      chooserTargetRef.current = null;
    }
    setCollectionOrigin(collectionLifetime);
    setCollections(data.collections);
    setCollectionsLoaded(data.collectionsLoaded);
    setCollectionsNext(data.collectionsNext ?? null);
    setCollectionsProblem(null);
    setMemberResult(undefined);
    memberFlight.current = false;
    pickerFlight.current = false;
  }
  const stateOptions = (data.stateOptions ?? []).map(({ id, label }) => [id, label.text] as const);
  const entryReviewOrigin = JSON.stringify([
    entryIdentity,
    entryObservation,
    data.provenance?.viewer,
    data.provenance?.readId,
    data.entryAvailable,
    data.entryStateLabel,
    subject.id,
    subject.type,
    subject.label,
    subject.typeLabel,
    locale,
    (data.stateOptions ?? []).map(({ id, label }) => [id, label.text, label.lang]),
  ]);
  if (removalConflictObservation.current !== null && entryObservation !== removalConflictObservation.current) {
    removalConflictObservation.current = null;
  }
  if (removalReview && removalReview.originKey !== entryReviewOrigin) {
    setRemovalReview(null);
    setRemovalNotice(null);
    removalReviewTrigger.current = null;
    removalFocusReturn.current = false;
  } else if (removalReview && !entryStateBasisMatches(removalReview.basis, entry)) {
    setRemovalReview(null);
    setRemovalNotice(entry ? 'changed' : 'unavailable');
    removalReviewTrigger.current = null;
    removalFocusReturn.current = false;
  }
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (!entryLifetime.current()) return;
    const loadedEntry =
      data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
    setEntry(loadedEntry);
    setEntryStateLabel((current) => {
      if (entryStateBasisMatches(captureEntryStateBasis(loadedEntry), entry)) return current;
      return loadedEntry
        ? ((data.stateOptions ?? []).find(({ id }) => id === loadedEntry.state)?.label.text ?? m.library_other())
        : m.library_other();
    });
    if (data.undo && !uncertainRestore.current)
      setEntryUndo((current) =>
        current?.deletionId === data.undo!.deletionId && current.revision === data.undo!.revision
          ? current
          : captureRestore(data.undo!),
      );
  }, [data.entry, data.restore, data.undo, entryLifetime]);
  useLayoutEffect(() => {
    if (removalReview || !removalFocusReturn.current) return;
    removalFocusReturn.current = false;
    const trigger = removalReviewTrigger.current;
    removalReviewTrigger.current = null;
    if (trigger?.isConnected && entryLifetime.current('library_entry.get', 'library_entry.delete')) trigger.focus();
  }, [removalReview, entryLifetime]);
  useEffect(() => {
    if (!collectionLifetime.current()) return;
    setCollections(data.collections);
    setCollectionsLoaded(data.collectionsLoaded);
    setCollectionsNext(data.collectionsNext ?? null);
  }, [data.collections, data.collectionsLoaded, data.collectionsNext, collectionLifetime]);
  useEffect(() => {
    if (labelLifetime.current()) setLabels(data.labels ?? []);
  }, [data.labels, labelLifetime]);
  useEffect(() => {
    if (!labelLifetime.current()) return;
    setLabelNotice(data.labelResult);
    if (
      data.labelUndo &&
      restoredLabelEpisodes.current.has(labelEpisode(data.labelUndo.assignmentId, data.labelUndo.revision))
    )
      return;
    if (!data.labelUndo && labelUndo) return;
    setLabelUndo(data.labelUndo);
  }, [data.labelResult, data.labelUndo, labelLifetime]);
  useEffect(() => {
    if (
      !hydrated ||
      !labelPickerOpen ||
      !labelListAdmitted ||
      !labelLifetime.current('library_label.assignment_list', 'library_label.list')
    )
      return;
    let current = true;
    const query = labelQuery;
    const currentSearch = () =>
      current &&
      labelLifetime.current('library_label.assignment_list', 'library_label.list') &&
      searchOrigin.current.sequence === searchSequence;
    setLabelNext(null);
    setLabelChoices([]);
    setLabelSearchState('idle');
    setLabelReadReason(undefined);
    if (subjectLabelInputIssue(query, true)) return;
    const timeout = setTimeout(() => {
      if (!currentSearch()) return;
      void searchSubjectLabelsAction({ data: { query } })
        .then((response) => {
          if (!currentSearch() || latestLabelQuery.current !== query) return;
          if (
            response.provenance?.viewer !== data.provenance?.viewer ||
            !response.provenance ||
            response.provenance.query !== query ||
            response.provenance.cursor !== undefined
          ) {
            setLabelSearchState('unavailable');
            return;
          }
          setLabelNext(response.next ?? null);
          setLabelChoices(response.labels);
          setLabelReadReason(response.reason);
          if (labelReadMessage(response.reason)) {
            setLabelSearchState('idle');
            return;
          }
          setLabelSearchState(response.state);
        })
        .catch(() => {
          if (currentSearch() && latestLabelQuery.current === query) setLabelSearchState('unavailable');
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [labelLifetime, labelListAdmitted, hydrated, labelPickerOpen, labelQuery, searchSequence]);
  const result = memberResult ?? actionResult ?? data.result;
  const resultText =
    result === 'saved'
      ? m.library_subject_saved()
      : result === 'cleared'
        ? m.library_subject_cleared()
        : result === 'added'
          ? m.library_subject_collection_added()
          : result === 'collection-full'
            ? m.library_subject_collection_full()
            : result === 'dynamic'
              ? m.library_subject_collection_dynamic()
              : result === 'closed'
                ? m.library_subject_closed()
                : result === 'unsupported_library_profile'
                  ? m.library_entry_profile_unsupported()
                  : result === 'conflict'
                    ? m.library_conflict()
                    : result === 'unavailable'
                      ? m.library_subject_unavailable()
                      : null;
  const entryRemovalMessage =
    uncertainEntry.current?.input.action === 'clear'
      ? m.library_entry_removal_unconfirmed()
      : result === 'cleared' && !entryUndo
        ? m.library_entry_removal_no_undo()
        : result === 'cleared' && entryUndo && !restoreAdmitted
          ? m.library_entry_removal_undo_unavailable()
          : null;
  const removalNoticeText =
    removalNotice === 'changed'
      ? m.library_entry_removal_changed()
      : removalNotice === 'unavailable'
        ? m.library_entry_removal_unavailable()
        : null;

  const discardRestore = () => {
    uncertainRestore.current = null;
    setEntryUndo(undefined);
    setRestoreMessage(null);
  };
  useAuthoringDeparture(
    () => uncertainRestore.current !== null,
    () => uncertainRestore.current !== null,
    `${entryLifetime.seed}:${entryUndo?.idempotencyKey}:${restoreMessage}`,
    discardRestore,
    discardRestore,
  );

  async function restoreEntry(input: LibraryRestoreInput) {
    if (!hydrated || !entryLifetime.current('library_entry.get', 'library_entry.restore') || !restoreAdmitted) return;
    if (!uncertainRestore.current && !data.csrfToken) return;
    const operation: NonNullable<typeof uncertainRestore.current> = uncertainRestore.current ?? {
      input: { ...input },
      headers: new Headers({ 'X-CSRF-Token': data.csrfToken! }),
      send: restoreSubjectLibrarySlot,
      running: false,
    };
    if (operation.running) return;
    uncertainRestore.current = operation;
    operation.running = true;
    try {
      const restored =
        operation.response ??
        (await operation.send({
          data: { ...operation.input },
          headers: new Headers(operation.headers),
        }));
      operation.response =
        restored.ok ||
        (restored.reason !== 'unavailable' && restored.reason !== 'closed' && restored.reason !== 'signed-out')
          ? restored
          : undefined;
      if (!entryLifetime.current() || uncertainRestore.current !== operation) return;
      if ('entry' in restored && restored.entry && restored.entry.subjectId !== subject.id) return;
      void queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
      if (operation.response) uncertainRestore.current = null;
      if (restored.ok) {
        setEntryUndo(undefined);
        setEntry(restored.entry);
        setEntryStateLabel(
          (data.stateOptions ?? []).find(({ id }) => id === restored.entry.state)?.label.text ?? m.library_other(),
        );
        setEntryConflict(null);
        setActionResult('saved');
        setRestoreMessage(null);
      } else if (restored.reason === 'occupied') {
        if (restored.entry) {
          setEntry(restored.entry);
          setEntryStateLabel(
            (data.stateOptions ?? []).find(({ id }) => id === restored.entry!.state)?.label.text ?? m.library_other(),
          );
        }
        setActionResult(undefined);
        setRestoreMessage(m.library_restore_occupied());
      } else if (restored.reason === 'stale') setRestoreMessage(m.library_restore_stale());
      else if (restored.reason === 'expired') setRestoreMessage(m.library_restore_expired());
      else if (restored.reason === 'closed') setRestoreMessage(m.platform_closed_message());
      else setRestoreMessage(m.library_subject_unavailable());
    } catch {
      if (entryLifetime.current()) setRestoreMessage(m.library_entry_restore_unconfirmed());
    } finally {
      operation.running = false;
    }
  }

  function applyEntryResult(response: SubjectLibraryMutationResponse) {
    if (!entryLifetime.current() || (response.entry && response.entry.subjectId !== subject.id)) return;
    if (response.result === 'saved' && response.entry) {
      setEntry(response.entry);
      setEntryStateLabel(
        (data.stateOptions ?? []).find(({ id }) => id === response.entry!.state)?.label.text ?? m.library_other(),
      );
      setEntryConflict(null);
      setActionResult('saved');
      return;
    }
    if (response.result === 'cleared') {
      setEntry(null);
      setEntryStateLabel(m.library_other());
      setEntryConflict(null);
      setActionResult('cleared');
      const receipt = response.undo ? captureRestore({ subjectId: subject.id, ...response.undo }) : undefined;
      if (receipt) setEntryUndo(receipt);
      if (receipt && restoreAdmitted) {
        undoToast(
          m.library_removed(),
          () => {
            if (!entryLifetime.current('library_entry.get', 'library_entry.restore') || !restoreAdmitted) return;
            void restoreEntry(receipt);
          },
          { undo: m.editor_undo() },
        );
      }
      return;
    }
    if (response.result === 'conflict' && 'entry' in response) {
      setEntry(response.entry ?? null);
      setEntryStateLabel(
        (data.stateOptions ?? []).find(({ id }) => id === response.entry?.state)?.label.text ?? m.library_other(),
      );
      setActionResult('conflict');
      return;
    }
    setActionResult(response.result);
  }

  async function writeEntry(
    input: SubjectLibraryMutation,
    previous: string,
    review?: ReviewedEntryState,
  ): Promise<SubjectLibraryMutationResponse | undefined> {
    if (
      !entryLifetime.current(
        'library_entry.get',
        input.action === 'clear' ? 'library_entry.delete' : 'library_entry.put',
      ) ||
      entryFlight.current ||
      uncertainEntry.current?.running ||
      (input.action === 'clear' ? !entryDeleteAdmitted : !entryPutAdmitted)
    )
      return;
    if (!uncertainEntry.current && !data.csrfToken) return;
    entryFlight.current = true;
    const operation: NonNullable<typeof uncertainEntry.current> = uncertainEntry.current ?? {
      input,
      csrfToken: data.csrfToken!,
      send: mutateSubjectLibrarySlot,
      previous,
      ...(review ? { review } : {}),
      running: false,
    };
    uncertainEntry.current = operation;
    operation.running = true;
    setPending(true);
    try {
      const response =
        operation.response ??
        (await operation.send({
          data: operation.input,
          headers: { 'X-CSRF-Token': operation.csrfToken },
        }));
      operation.response = response.result === 'unavailable' || response.result === 'closed' ? undefined : response;
      if (!entryLifetime.current()) {
        operation.response = undefined;
        return;
      }
      if (response.entry && response.entry.subjectId !== subject.id) {
        setActionResult('unavailable');
        return;
      }
      if (operation.response) uncertainEntry.current = null;
      if (response.result === 'conflict' && operation.input.action !== 'clear' && operation.input.state) {
        const choice = (data.stateOptions ?? []).find(({ id }) => id === operation.input.state);
        setEntryConflict({
          state: operation.input.state,
          stateLabel: choice?.label.text ?? operation.review?.stateLabel ?? m.library_other(),
          stateLabelLanguage: choice?.label.lang ?? operation.review?.stateLabelLanguage ?? locale,
          originKey: entryReviewOrigin,
          hasAcceptedBasis: 'entry' in response,
          ...('entry' in response ? { acceptedEntry: response.entry ?? null } : {}),
        });
      }
      if (response.result === 'conflict' && operation.input.action === 'clear' && !('entry' in response)) {
        removalConflictObservation.current = entryObservation;
      }
      applyEntryResult(response);
      if (
        response.result === 'saved' ||
        response.result === 'cleared' ||
        (response.result === 'conflict' && 'entry' in response)
      ) {
        queryClient.setQueryData(
          ['subject-library', subject.id, locale],
          (current: SubjectLibrarySlotData | undefined) =>
            entryLifetime.current() &&
            current?.provenance?.viewer === data.provenance?.viewer &&
            current?.provenance?.subjectId === subject.id
              ? { ...current, entryAvailable: true, entry: response.entry ?? null }
              : current,
        );
      }
      return response;
    } catch {
      if (!entryLifetime.current()) return;
      setActionResult('unavailable');
      return;
    } finally {
      operation.running = false;
      if (entryLifetime.current()) {
        entryFlight.current = false;
        setPending(false);
      }
    }
  }

  function openEntryRemovalReview() {
    if (
      !hydrated ||
      pending ||
      uncertainEntry.current ||
      removalReview ||
      removalConflictObservation.current !== null ||
      !entry ||
      !data.csrfToken ||
      !entryLifetime.current('library_entry.get', 'library_entry.delete') ||
      !entryDeleteAdmitted
    )
      return;
    const stateLabel =
      (data.stateOptions ?? []).find(({ id }) => id === entry.state)?.label.text ??
      (entryStateLabel !== m.library_other() ? entryStateLabel : m.library_entry_removal_state_unknown());
    const review = captureEntryRemovalReview({
      subject,
      entry,
      stateLabel,
      originKey: entryReviewOrigin,
      lifetime: entryLifetime,
    });
    if (!review) return;
    if (typeof document !== 'undefined') {
      const stateTrigger = slotSection.current?.querySelector<HTMLElement>('[data-entry-state-trigger]');
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      removalReviewTrigger.current = stateTrigger ?? active;
    }
    removalFocusReturn.current = false;
    setRemovalNotice(null);
    setRemovalReview(review);
  }

  function keepEntryFromRemovalReview() {
    removalFocusReturn.current = true;
    setRemovalReview(null);
    setRemovalNotice(null);
  }

  function confirmEntryRemoval(review: ReviewedEntryRemoval) {
    if (
      !hydrated ||
      pending ||
      uncertainEntry.current ||
      !data.csrfToken ||
      !entryDeleteAdmitted ||
      !entryRemovalReviewMatches(review, {
        subject,
        entry,
        originKey: entryReviewOrigin,
        lifetime: entryLifetime,
      })
    )
      return;
    const input: SubjectLibraryMutation = {
      subjectId: review.subjectId,
      intent: 'entry',
      action: 'clear',
      revision: review.basis.revision,
      ...(review.basis.incarnationId === undefined ? {} : { incarnationId: review.basis.incarnationId }),
      idempotencyKey: crypto.randomUUID(),
    };
    removalFocusReturn.current = false;
    removalReviewTrigger.current = null;
    setRemovalReview(null);
    setRemovalNotice(null);
    setActionResult(undefined);
    void writeEntry(input, review.basis.state);
  }

  async function saveReviewedEntry(review: ReviewedEntryState) {
    if (
      !hydrated ||
      pending ||
      uncertainEntry.current ||
      !data.csrfToken ||
      review.subjectId !== subject.id ||
      review.subjectLabel !== subject.label ||
      review.originKey !== entryReviewOrigin ||
      review.lifetime !== entryLifetime ||
      !entryLifetime.current('library_entry.get', 'library_entry.put') ||
      !entryPutAdmitted ||
      !entryStateBasisMatches(review.basis, entry)
    )
      return;
    const choice = (data.stateOptions ?? []).find(
      ({ id, label }) =>
        id === review.state && label.text === review.stateLabel && label.lang === review.stateLabelLanguage,
    );
    if (!choice) return;
    const input: SubjectLibraryMutation = {
      subjectId: review.subjectId,
      intent: 'entry',
      action: 'save',
      state: review.state,
      ...(review.basis
        ? {
            revision: review.basis.revision,
            ...(review.basis.incarnationId === undefined ? {} : { incarnationId: review.basis.incarnationId }),
          }
        : {}),
      idempotencyKey: crypto.randomUUID(),
    };
    setEntryConflict(null);
    setActionResult(undefined);
    setPending(true);
    return writeEntry(input, review.basis?.state ?? '', review);
  }

  async function mutate(input: SubjectLibraryMutation) {
    if (
      !hydrated ||
      !collectionLifetime.current('collection.list', 'collection_member.create') ||
      memberFlight.current ||
      uncertainMember.current?.running
    )
      return;
    if (!uncertainMember.current && !data.csrfToken) return;
    memberFlight.current = true;
    const operation: NonNullable<typeof uncertainMember.current> = uncertainMember.current ?? {
      input,
      csrfToken: data.csrfToken!,
      send: mutateSubjectLibrarySlot,
      running: false,
    };
    uncertainMember.current = operation;
    operation.running = true;
    try {
      const response =
        operation.response ??
        (await operation.send({
          data: operation.input,
          headers: { 'X-CSRF-Token': operation.csrfToken },
        }));
      operation.response = response.result === 'unavailable' || response.result === 'closed' ? undefined : response;
      if (!collectionLifetime.current()) return;
      if (operation.response) uncertainMember.current = null;
      setMemberResult(response.result);
      await queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
    } catch {
      if (collectionLifetime.current()) setMemberResult('unavailable');
    } finally {
      operation.running = false;
      if (collectionLifetime.current()) memberFlight.current = false;
    }
  }

  function addToCollection(collectionId: string) {
    if (
      !collectionLifetime.current('collection.list', 'collection_member.create') ||
      (uncertainMember.current
        ? uncertainMember.current.input.collectionId !== collectionId
        : chooserTargetRef.current?.id !== collectionId)
    )
      return;
    return mutate({
      subjectId: subject.id,
      intent: 'member',
      collectionId,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function readChooserPage(cursor?: string) {
    if (!hydrated || !collectionLifetime.current('collection.list'))
      return { state: 'unavailable' as const, collections: null, next: null };
    pickerFlight.current = true;
    try {
      const response = await readSubjectLibraryCollections({
        data: { subjectId: subject.id, ...(cursor ? { cursor } : {}) },
      });
      if (!collectionLifetime.current()) return { state: 'unavailable' as const, collections: null, next: null };
      if (!response.provenance || response.provenance.viewer !== data.provenance?.viewer) {
        setCollections(null);
        setCollectionsLoaded(false);
        setCollectionsNext(null);
        setCollectionsProblem('unavailable');
        return { state: 'unavailable' as const, collections: null, next: null };
      }
      setCollections(response.collections);
      setCollectionsLoaded(response.state === 'loaded');
      setCollectionsNext(response.next ?? null);
      setCollectionsProblem(response.state === 'loaded' ? null : response.state);
      return { collections: response.collections, next: response.next ?? null, state: response.state };
    } catch {
      if (collectionLifetime.current()) setCollectionsProblem('unavailable');
      return { state: 'unavailable' as const, collections: null, next: null };
    } finally {
      if (collectionLifetime.current()) pickerFlight.current = false;
    }
  }

  async function readPublicPage(cursor?: string) {
    const response = await readSubjectPublicCollections({
      data: { subjectId: subject.id, ...(cursor ? { cursor } : {}) },
    });
    return response;
  }

  function labelFailure(reason: string) {
    if (!labelLifetime.current()) return;
    if (reason === 'restore-stale') {
      setLabelNotice('label-restore-stale');
      return;
    }
    if (reason === 'conflict') setLabelNotice('label-conflict');
    else if (reason === 'capacity') setLabelNotice('label-capacity');
    else if (reason === 'restore-expired') setLabelNotice('label-restore-expired');
    else if (reason === 'restore-occupied') setLabelNotice('label-restore-occupied');
    else if (reason === 'restore-capacity') setLabelNotice('label-restore-capacity');
    else if (reason === 'closed') setLabelNotice('closed');
    else setLabelNotice('unavailable');
  }

  async function performLabel(command: SubjectLabelMutationInput, label?: LibraryLabelSummary | SubjectLabel) {
    if (uncertainLabel.current && command !== uncertainLabel.current.input) return;
    if (!uncertainLabel.current && !data.csrfToken) return;
    const operation: NonNullable<typeof uncertainLabel.current> = uncertainLabel.current ?? {
      input: command,
      seed: labelLifetime.seed,
      csrfToken: data.csrfToken!,
      send: mutateSubjectLabelAction,
      ...(label ? { label } : {}),
      running: false,
    };
    let input = operation.input;
    const allowed = () =>
      input.intent === 'unassign'
        ? labelLifetime.current('library_label.assignment_list', 'library_label.unassign')
        : input.intent === 'create-and-assign'
          ? labelLifetime.current(
              'library_label.assignment_list',
              'library_label.list',
              'library_label.create',
              'library_label.assign',
            )
          : input.intent === 'label-step' && operation.step?.kind === 'create'
            ? operation.seed === labelLifetime.seed &&
              labelLifetime.current('library_label.assignment_list', 'library_label.create')
            : labelLifetime.current('library_label.assignment_list', 'library_label.assign');
    if (!hydrated || !data.csrfToken || !allowed() || labelFlight.current || operation.running) return;
    if (!uncertainLabel.current && input.intent !== 'restore' && input.intent !== 'label-step') {
      const freshKey = (preferred: string) => {
        const key = usedLabelKeys.current.has(preferred) ? crypto.randomUUID() : preferred;
        usedLabelKeys.current.add(key);
        return key;
      };
      input = {
        ...input,
        idempotencyKey: freshKey(input.idempotencyKey),
        ...(input.intent === 'create-and-assign' && input.createKey ? { createKey: freshKey(input.createKey) } : {}),
      };
      operation.input = input;
    }
    uncertainLabel.current = operation;
    operation.running = true;
    labelFlight.current = true;
    setLabelPending(true);
    setLabelNotice(undefined);
    try {
      let response: SubjectLabelMutationResult;
      while (true) {
        response =
          operation.response ??
          (await operation.send({
            data: input,
            headers: { 'X-CSRF-Token': operation.csrfToken },
          }));
        // Capture the next native operands before checking whether this UI can still advance.
        // A retired response may be retained, but never dispatches its next command automatically.
        if (!response.ok && response.reason === 'continue') {
          operation.step = response.step;
          operation.input = input = {
            intent: 'label-step',
            subjectId: response.step.subjectId,
            token: response.step.token,
          };
          operation.response = undefined;
          if (!labelLifetime.current() || !allowed()) return;
          continue;
        }
        break;
      }
      // Keep a dispatched native outcome even if its originating UI episode has since retired.
      operation.response =
        !response.ok &&
        (response.reason === 'unavailable' || response.reason === 'closed' || response.reason === 'signed-out')
          ? undefined
          : response;
      if (!labelLifetime.current()) return;
      if (!response.ok) {
        if (operation.response) uncertainLabel.current = null;
        labelFailure(response.reason);
        return;
      }
      uncertainLabel.current = null;
      if (input.intent === 'unassign') {
        const removedInput = input;
        setLabels((current) => current.filter((row) => row.id !== removedInput.assignmentId));
        const revision = response.restoreRevision;
        if (revision === undefined) {
          setLabelNotice('unavailable');
          return;
        }
        setLabelUndo({ labelId: removedInput.labelId, assignmentId: removedInput.assignmentId, revision });
        undoToast(
          m.library_subject_label_removed({ name: operation.label?.name ?? '' }),
          () => {
            if (!labelLifetime.current('library_label.assignment_list', 'library_label.assign')) return;
            void performLabel(
              {
                intent: 'restore',
                subjectId: subject.id,
                labelId: removedInput.labelId,
                assignmentId: removedInput.assignmentId,
                revision,
                idempotencyKey: labelUndoKeyFor(removedInput.assignmentId, revision),
              },
              operation.label,
            );
          },
          { undo: m.library_subject_label_undo() },
        );
      } else {
        if (input.intent === 'restore') {
          restoredLabelEpisodes.current.add(labelEpisode(input.assignmentId, input.revision));
          setLabelUndo(undefined);
        }
        const applied = response.label?.name ? response.label : operation.label;
        if (applied?.name) {
          const labelId = 'labelId' in applied && typeof applied.labelId === 'string' ? applied.labelId : applied.id;
          setLabels((current) => [
            ...current.filter((row) => row.labelId !== labelId),
            { id: response.assignment.id, labelId, name: applied.name, revision: response.assignment.revision },
          ]);
        }
        setLabelPickerOpen(false);
        setLabelQuery('');
        setLabelNameSubmitted(false);
        latestLabelQuery.current = '';
        setLabelChoices([]);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]);
    } catch {
      if (labelLifetime.current()) setLabelNotice('unavailable');
    } finally {
      operation.running = false;
      if (labelLifetime.current()) {
        labelFlight.current = false;
        setLabelPending(false);
      }
    }
  }

  async function writeLabel(input: {
    intent: 'assign' | 'create-and-assign' | 'restore';
    label?: LibraryLabelSummary | SubjectLabel;
    name?: string;
    assignment?: SubjectLabel;
    revision?: number;
  }) {
    if (!labelLifetime.current()) return;
    if (input.intent === 'create-and-assign') {
      setLabelNameSubmitted(true);
      if (subjectLabelInputIssue(input.name ?? '')) return;
    }
    const labelId = input.label && 'labelId' in input.label ? input.label.labelId : (input.label?.id ?? '');
    const command: SubjectLabelMutationInput =
      input.intent === 'create-and-assign'
        ? {
            intent: input.intent,
            subjectId: subject.id,
            name: input.name ?? '',
            createKey: data.labelCreateKey ?? crypto.randomUUID(),
            idempotencyKey: data.labelAssignKey ?? crypto.randomUUID(),
          }
        : input.intent === 'assign'
          ? {
              intent: 'capture-assign',
              subjectId: subject.id,
              labelId,
              idempotencyKey: data.labelAssignKey ?? crypto.randomUUID(),
            }
          : {
              intent: input.intent,
              subjectId: subject.id,
              labelId,
              assignmentId: input.assignment?.id ?? '',
              revision: input.revision ?? 0,
              idempotencyKey: labelUndoKeyFor(input.assignment?.id ?? '', input.revision ?? 0),
            };
    await performLabel(command, input.label);
  }

  async function submitLabelName(event: FormEvent<HTMLFormElement>) {
    if (!hydrated) return;
    event.preventDefault();
    if (!labelLifetime.current()) return;
    setLabelNameSubmitted(true);
    if (subjectLabelInputIssue(labelQuery)) return;
    if (
      !labelLifetime.current('library_label.assignment_list', 'library_label.list') ||
      !labelListAdmitted ||
      labelSearchState !== 'loaded'
    )
      return;
    const name = normalizeLibraryLabelName(labelQuery);
    if (!name) return;
    const existing = labelChoices.find((candidate) => normalizeLibraryLabelName(candidate.name) === name);
    if (existing) await writeLabel({ intent: 'assign', label: existing });
    else await writeLabel({ intent: 'create-and-assign', name: labelQuery });
  }

  async function removeLabel(label: SubjectLabel) {
    await performLabel(
      {
        intent: 'unassign',
        subjectId: subject.id,
        labelId: label.labelId,
        assignmentId: label.id,
        revision: label.revision,
        idempotencyKey: data.labelRemoveKeys?.[label.id] ?? crypto.randomUUID(),
      },
      label,
    );
  }

  function onRemoveForm(event: FormEvent<HTMLFormElement>, label: SubjectLabel) {
    if (!hydrated) return;
    event.preventDefault();
    void removeLabel(label);
  }

  const undoReceipt = uncertainRestore.current?.input ?? entryUndo;
  return (
    <section ref={slotSection} aria-label={m.library_subject_heading()} className="flex flex-wrap items-center gap-2">
      {undoReceipt && data.entryAvailable ? (
        <div
          onSubmit={(event) => {
            if (!hydrated) return;
            event.preventDefault();
            if (undoReceipt.subjectId === subject.id) void restoreEntry(undoReceipt);
          }}
        >
          <fieldset disabled={!data.csrfToken && !uncertainRestore.current}>
            <EntryUndoForm
              undo={undoReceipt}
              locale={locale}
              csrfToken={uncertainRestore.current?.headers.get('x-csrf-token') ?? data.csrfToken}
              retry={!!uncertainRestore.current}
              returnTo={returnTo}
            />
          </fieldset>
        </div>
      ) : null}
      {data.restore ? <EntryRestoreFeedback restore={data.restore} locale={locale} /> : null}
      {entry && data.session === 'signed-in' && data.csrfToken ? (
        <noscript>
          <EntryRemoveForm
            subjectId={subject.id}
            revision={entry.revision}
            {...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId })}
            idempotencyKey={removeKey}
            locale={locale}
            csrfToken={data.csrfToken}
            returnTo={returnTo}
          />
        </noscript>
      ) : null}
      {data.session === 'signed-in' && data.entryAvailable && stateOptions.length > 0 && entryPutAdmitted ? (
        <Exposure operation="library_entry.put">
          <form
            method="get"
            action={action}
            onSubmit={(event) => event.preventDefault()}
            className="flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="subjectId" value={subject.id} />
            {entry ? <input type="hidden" name="revision" value={entry.revision} /> : null}
            {typeof entry?.incarnationId === 'string' ? (
              <input type="hidden" name="incarnationId" value={entry.incarnationId} />
            ) : null}
            <SubjectEntryStateReview
              subject={subject}
              entry={entry}
              receivedLabel={entryStateLabel}
              stateOptions={data.stateOptions ?? []}
              canRemove={entryDeleteAdmitted && removalConflictObservation.current === null}
              originKey={entryReviewOrigin}
              lifetime={entryLifetime}
              disabled={!hydrated || !data.csrfToken || !entryPutAdmitted}
              busy={pending}
              uncertain={uncertainEntry.current !== null}
              conflict={entryConflict}
              onSave={saveReviewedEntry}
              onRemove={openEntryRemovalReview}
              onDismissConflict={() => setEntryConflict(null)}
            />
          </form>
        </Exposure>
      ) : null}

      {removalReview ? (
        <Exposure operation="library_entry.delete">
          <SubjectEntryRemovalReview
            review={removalReview}
            valid={entryRemovalReviewMatches(removalReview, {
              subject,
              entry,
              originKey: entryReviewOrigin,
              lifetime: entryLifetime,
            })}
            busy={pending || uncertainEntry.current !== null}
            onConfirm={confirmEntryRemoval}
            onKeep={keepEntryFromRemovalReview}
          />
        </Exposure>
      ) : null}

      {data.session === 'signed-in' && data.entryAvailable && entry && (!stateOptions.length || !entryPutAdmitted) ? (
        <div data-library-entry className="flex min-w-0 flex-wrap items-center gap-2">
          <span data-library-entry-state className="min-w-0 break-words [overflow-wrap:anywhere]">
            {entryStateLabel}
          </span>
          {entryDeleteAdmitted ? (
            <Exposure operation="library_entry.delete">
              <button
                type="button"
                className={buttonClass}
                data-entry-removal-trigger
                disabled={
                  !hydrated ||
                  !data.csrfToken ||
                  pending ||
                  uncertainEntry.current !== null ||
                  removalConflictObservation.current !== null
                }
                onClick={openEntryRemovalReview}
              >
                {m.library_subject_remove()}
              </button>
            </Exposure>
          ) : null}
        </div>
      ) : null}

      {hydrated &&
      !pending &&
      uncertainEntry.current &&
      entryLifetime.current(
        'library_entry.get',
        uncertainEntry.current.input.action === 'clear' ? 'library_entry.delete' : 'library_entry.put',
      ) &&
      (uncertainEntry.current.input.action === 'clear' ? entryDeleteAdmitted : entryPutAdmitted) ? (
        <button
          type="button"
          data-entry-state-retry={uncertainEntry.current.input.action === 'save' ? true : undefined}
          data-entry-removal-retry={uncertainEntry.current.input.action === 'clear' ? true : undefined}
          className={buttonClass}
          disabled={pending}
          onClick={() => {
            const original = uncertainEntry.current;
            if (
              original &&
              entryLifetime.current(
                'library_entry.get',
                original.input.action === 'clear' ? 'library_entry.delete' : 'library_entry.put',
              ) &&
              (original.input.action === 'clear' ? entryDeleteAdmitted : entryPutAdmitted)
            )
              void writeEntry(original.input, original.previous);
          }}
        >
          {uncertainEntry.current.input.action === 'save'
            ? m.library_entry_review_retry()
            : m.library_entry_removal_retry()}
        </button>
      ) : null}

      {hydrated && collectionLifetime.current() && uncertainMember.current ? (
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            if (collectionLifetime.current() && uncertainMember.current) void mutate(uncertainMember.current.input);
          }}
        >
          {m.library_selection_retry()}
        </button>
      ) : null}

      {data.session === 'signed-in' && (!hydrated || collectionLifetime.current()) ? (
        <Exposure operation="collection.list">
          <Menu
            title={m.library_subject_add_collection()}
            closeOnNavigation
            trigger={
              <button data-add-to-collection type="button" className={buttonClass}>
                {m.library_subject_add_collection()}
              </button>
            }
            entries={[]}
            content={
              <CollectionChooserPanel
                key={collectionLifetime.seed}
                subject={subject}
                locale={locale}
                action={action}
                readerHref={returnTo}
                csrfToken={data.csrfToken}
                admitted={memberCreateAdmitted}
                hydrated={hydrated}
                loaded={collectionsLoaded}
                collections={collections}
                next={collectionsNext}
                problem={collectionsProblem}
                pending={memberFlight.current}
                addedId={memberResult === 'added' ? (chooserTarget?.id ?? null) : null}
                current={() => collectionLifetime.current('collection.list')}
                readPage={readChooserPage}
                onSelect={(target) => {
                  if (uncertainMember.current) return;
                  chooserTargetRef.current = target;
                  setChooserTarget(target);
                }}
                onConfirm={(collectionId) => void addToCollection(collectionId)}
              />
            }
          />
        </Exposure>
      ) : data.session === 'signed-out' ? (
        <Exposure operation="library_entry.put">
          <a
            data-library-sign-in
            className={primaryClass}
            href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
          >
            {m.account_sign_in()}
          </a>
        </Exposure>
      ) : null}

      {data.session === 'signed-in' ? (
        <nav
          data-library-subject-links
          aria-label={m.library_subject_more_options()}
          className="mt-4 flex flex-col gap-2 border-t border-border pt-3 empty:hidden"
        >
          <Exposure operation="progress_session.create">
            <Link
              to="/library/progress"
              search={{ subjectId: subject.id }}
              state={subjectProgressEntryLocationState(returnTo) as never}
              className={linkClass}
            >
              {m.library_subject_start_progress()}
            </Link>
          </Exposure>
          <Exposure operation="copy.list">
            <a className={linkClass} href={`/library/copies?subjectId=${encodeURIComponent(subject.id)}`}>
              {m.library_subject_your_copies()}
            </a>
          </Exposure>
        </nav>
      ) : null}
      {data.publicCollections !== null || data.publicCollectionsCount ? (
        <Exposure operation="subject_collection.list">
          <PublicCollectionsPanel
            key={`${subject.id}:${locale}`}
            locale={locale}
            collections={data.publicCollections}
            next={data.publicCollectionsNext}
            count={data.publicCollectionsCount ?? publicCountOf(undefined)}
            current={() => true}
            readPage={readPublicPage}
          />
        </Exposure>
      ) : null}
      {data.session === 'signed-in' && data.labels === null ? (
        <Exposure operation="library_label.assignment_list">
          <p role="alert" className="basis-full text-sm text-muted-foreground">
            {m.library_subject_label_unavailable()}
          </p>
        </Exposure>
      ) : null}
      {data.session === 'signed-in' && data.labels !== null ? (
        <Exposure operation="library_label.assignment_list">
          <div data-subject-labels className="min-w-0 max-w-full basis-full space-y-2">
            {labels.length ? (
              <ul className="flex flex-wrap items-center gap-2">
                {labels.map((label) => (
                  <li
                    key={label.id}
                    data-subject-label-chip
                    className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-muted/60 px-3 py-1 text-sm"
                  >
                    <a
                      href={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(label.labelId)}`}
                      className={`inline-flex min-h-[44px] min-w-[44px] items-center rounded-sm py-2 text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline ${controlFocusClass}`}
                    >
                      {label.name}
                    </a>
                    <Exposure operation="library_label.unassign">
                      <form
                        data-subject-label-remove
                        method="post"
                        action={action}
                        onSubmit={(event) => onRemoveForm(event, label)}
                        className="m-0 shrink-0"
                      >
                        <input type="hidden" name="intent" value="unassign" />
                        <input type="hidden" name="subjectId" value={subject.id} />
                        <input type="hidden" name="labelId" value={label.labelId} />
                        <input type="hidden" name="assignmentId" value={label.id} />
                        <input type="hidden" name="idempotencyKey" value={data.labelRemoveKeys?.[label.id]} />
                        <input type="hidden" name="revision" value={label.revision} />
                        <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                        <button
                          type="submit"
                          disabled={!data.csrfToken || (hydrated && labelPending)}
                          aria-label={m.library_subject_label_remove({ name: label.name })}
                          className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-2 text-muted-foreground hover:text-foreground disabled:opacity-50 ${controlFocusClass}`}
                        >
                          ×
                        </button>
                      </form>
                    </Exposure>
                  </li>
                ))}
              </ul>
            ) : null}
            <Exposure operation="library_label.list">
              <details
                data-subject-label-picker-details
                open={labelPickerOpen}
                onToggle={(event) => {
                  if (hydrated && !labelLifetime.current()) return;
                  const open = event.currentTarget.open;
                  if (!open) setLabelNameSubmitted(false);
                  if (searchOrigin.current.open !== open)
                    searchOrigin.current = {
                      ...searchOrigin.current,
                      open,
                      sequence: searchOrigin.current.sequence + 1,
                    };
                  setLabelPickerOpen(open);
                }}
                className="min-w-0 max-w-md"
              >
                <summary
                  ref={labelPickerTrigger}
                  role="button"
                  aria-expanded={hydrated ? labelPickerOpen : undefined}
                  className={`${labelButtonClass} cursor-pointer list-none`}
                >
                  {m.library_subject_label_add()}
                </summary>
                {/* Keep the no-script form; hydrated closed pickers have no inactive required controls. */}
                {!hydrated || labelPickerOpen ? (
                  <form
                    data-subject-label-picker
                    method="post"
                    action={action}
                    onSubmit={(event) => void submitLabelName(event)}
                    className="mt-2 space-y-2 rounded-lg border bg-background p-3"
                  >
                    <input type="hidden" name="intent" value="assign-by-name" />
                    <input type="hidden" name="idempotencyKey" value={data.labelAssignKey} />
                    <input type="hidden" name="createKey" value={data.labelCreateKey} />
                    <input type="hidden" name="subjectId" value={subject.id} />
                    <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                    <SubjectLabelInput
                      value={labelQuery}
                      issue={labelInputIssue}
                      onChange={(value) => {
                        if (!labelLifetime.current()) return;
                        searchOrigin.current = {
                          ...searchOrigin.current,
                          query: value,
                          sequence: searchOrigin.current.sequence + 1,
                        };
                        setLabelNameSubmitted(false);
                        setLabelChoices([]);
                        setLabelNext(null);
                        setLabelSearchState('idle');
                        setLabelReadReason(undefined);
                        latestLabelQuery.current = value;
                        setLabelQuery(value);
                      }}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Exposure operation="library_label.create">
                        <button
                          type="submit"
                          disabled={!data.csrfToken || (hydrated && labelPending)}
                          className={labelButtonClass}
                        >
                          {m.library_subject_label_add()}
                        </button>
                      </Exposure>
                      <button
                        type="button"
                        className={labelButtonClass}
                        onClick={() => {
                          if (!labelLifetime.current()) return;
                          searchOrigin.current = {
                            query: '',
                            open: false,
                            sequence: searchOrigin.current.sequence + 1,
                          };
                          setLabelPickerOpen(false);
                          setLabelQuery('');
                          setLabelNameSubmitted(false);
                          latestLabelQuery.current = '';
                          labelPickerTrigger.current?.focus();
                        }}
                      >
                        {m.library_collection_cancel()}
                      </button>
                    </div>
                    <SubjectLabelMore
                      key={searchSequence}
                      query={labelQuery}
                      next={labelNext}
                      isCurrent={() =>
                        labelLifetime.current('library_label.assignment_list', 'library_label.list') &&
                        searchOrigin.current.sequence === searchSequence &&
                        searchOrigin.current.open
                      }
                      acceptPage={(page, request) =>
                        !!page.provenance &&
                        page.provenance.viewer === data.provenance?.viewer &&
                        page.provenance.query === request.query &&
                        page.provenance.cursor === request.cursor
                      }
                      onPage={(page) => {
                        if (!labelLifetime.current() || searchOrigin.current.sequence !== searchSequence) return;
                        setLabelNext(page.next ?? null);
                        setLabelChoices(page.labels);
                        setLabelSearchState(page.state);
                      }}
                    />
                    <SubjectLabelReadNotice {...(labelReadReason !== undefined ? { reason: labelReadReason } : {})} />
                    {labelSearchState === 'loaded' ? (
                      <ul aria-label={m.library_subject_label_input()} className="space-y-1">
                        {labelChoices.map((choice) => (
                          <li key={choice.id}>
                            <Exposure operation="library_label.assign">
                              <button
                                type="button"
                                disabled={!data.csrfToken || (hydrated && labelPending)}
                                onClick={() => void writeLabel({ intent: 'assign', label: choice })}
                                className={labelChoiceClass}
                              >
                                {choice.name}
                              </button>
                            </Exposure>
                          </li>
                        ))}
                        {normalizeLibraryLabelName(labelQuery) &&
                        !labelChoices.some(
                          (choice) => normalizeLibraryLabelName(choice.name) === normalizeLibraryLabelName(labelQuery),
                        ) ? (
                          <li>
                            <Exposure operation="library_label.create">
                              <button
                                type="button"
                                disabled={!data.csrfToken || (hydrated && labelPending)}
                                onClick={() => void writeLabel({ intent: 'create-and-assign', name: labelQuery })}
                                className={`${labelChoiceClass} font-medium text-primary`}
                              >
                                {m.library_subject_label_create({ name: normalizeLibraryLabelName(labelQuery) })}
                              </button>
                            </Exposure>
                          </li>
                        ) : null}
                        {labelChoices.length === 0 ? (
                          <li className="px-2 py-1 text-sm text-muted-foreground">
                            {m.library_subject_label_no_results()}
                          </li>
                        ) : null}
                      </ul>
                    ) : labelSearchState === 'closed' ? (
                      <p role="status" className="text-sm text-muted-foreground">
                        {m.library_subject_label_closed()}
                      </p>
                    ) : labelSearchState === 'unavailable' ? (
                      <p role="alert" className="text-sm text-muted-foreground">
                        {m.library_subject_label_unavailable()}
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </details>
            </Exposure>
            {uncertainLabel.current?.step?.created ? (
              <p role="status" className="text-sm text-muted-foreground">
                {m.library_subject_label_steps_created()}
              </p>
            ) : null}
            <SubjectLabelNotice {...(labelNotice !== undefined ? { result: labelNotice } : {})} />
            {uncertainLabel.current ? (
              <button
                type="button"
                className={labelButtonClass}
                disabled={labelPending}
                onClick={() => {
                  if (labelLifetime.current() && uncertainLabel.current)
                    void performLabel(uncertainLabel.current.input);
                }}
              >
                {m.library_selection_retry()}
              </button>
            ) : null}
            {labelUndo ? (
              <form
                data-label-undo
                method="post"
                action={action}
                className="flex flex-wrap items-center gap-2 text-sm"
                onSubmit={(event) => {
                  if (!hydrated) return;
                  event.preventDefault();
                  if (!labelLifetime.current()) return;
                  void writeLabel({
                    intent: 'restore',
                    label: { id: labelUndo.labelId, name: '', revision: 1 },
                    assignment: {
                      id: labelUndo.assignmentId,
                      labelId: labelUndo.labelId,
                      name: '',
                      revision: labelUndo.revision,
                    },
                    revision: labelUndo.revision,
                  });
                }}
              >
                <input type="hidden" name="intent" value="restore" />
                <input type="hidden" name="subjectId" value={subject.id} />
                <input type="hidden" name="labelId" value={labelUndo.labelId} />
                <input type="hidden" name="assignmentId" value={labelUndo.assignmentId} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={labelUndoKeyFor(labelUndo.assignmentId, labelUndo.revision)}
                />
                <input type="hidden" name="revision" value={labelUndo.revision} />
                <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                <span>{m.library_subject_label_removed_status()}</span>
                <button
                  type="submit"
                  disabled={!data.csrfToken}
                  className={`${linkClass} min-h-[44px] min-w-[44px] rounded px-2 py-2 ${controlFocusClass}`}
                >
                  {m.library_subject_label_undo()}
                </button>
              </form>
            ) : null}
          </div>
        </Exposure>
      ) : null}
      {entryRemovalMessage ? (
        <p role="status" aria-live="polite" className="basis-full text-sm text-muted-foreground">
          {entryRemovalMessage}
        </p>
      ) : null}
      {!entryRemovalMessage && resultText && result !== 'cleared' ? (
        <p role="alert" className="basis-full text-sm text-muted-foreground">
          {resultText}
        </p>
      ) : null}
      {removalNoticeText ? (
        <p role="status" aria-live="polite" className="basis-full text-sm text-muted-foreground">
          {removalNoticeText}
        </p>
      ) : null}
      {restoreMessage ? (
        <p role="status" className="basis-full text-sm text-muted-foreground">
          {restoreMessage}
        </p>
      ) : null}
    </section>
  );
}
