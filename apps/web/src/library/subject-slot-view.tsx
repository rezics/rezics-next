import { SubjectLabelMore } from './subject-labels.tsx';
import { labelReadMessage, SubjectLabelReadNotice } from './subject-labels.tsx';
import { EntryUndoForm, EntryRemoveForm, EntryRestoreFeedback } from './entry-undo';
import { Exposure, operationIsAdmitted, useOperation } from '../kernel/exposure';
import { undoToast } from '@rezics/ui/undo-toast';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItem } from '@rezics/ui/content-item';
import { useQueryClient } from '@tanstack/react-query';
import { Menu } from '@rezics/ui/menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@rezics/ui/shadcn/select';
import { Loader2Icon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { SubjectLabelNotice } from './subject-labels.tsx';
import { subjectHref } from '../subject/subject-href';
import { subjectSlotReturnTo } from './subject-slot-return-context';
import { useSession } from '../session/query';
import { AccountRef } from './account-ref';
import { SubjectRef } from './subject-ref';
import type { SubjectReference } from './subject-ref';
import {
  mutateSubjectLabelAction,
  mutateSubjectLibrarySlot,
  readSubjectLibraryCollections,
  searchSubjectLabelsAction,
  restoreSubjectLibrarySlot,
} from './subject-slot-actions';
import type {
  LibraryEntryStateWrite,
  SubjectLibraryMutation,
  SubjectLibraryMutationResponse,
  SubjectLibrarySlotData,
} from './subject-slot';
import { normalizeLibraryLabelName } from './subject-label-name';
import type { LibraryLabelSummary, SubjectLabel } from './subject-labels.ts';

type SubjectSlotProps = {
  subject: SubjectReference;
  locale: string;
  data: SubjectLibrarySlotData;
};

// The state action is the page's one filled primary button; every other control here is a secondary (outline) button.
const buttonClass = buttonVariants({ variant: 'outline' });
const primaryClass = buttonVariants({ variant: 'default' });
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';
const removeValue = 'remove';
const otherStateValue = '__library_other__';
const subscribe = () => () => {};
type SlotLifetime = { active: boolean; current: () => boolean };
type SlotAdmission = {
  signature: string;
  lifetime: SlotLifetime;
  seen: Set<string>;
  retired: Set<string>;
  accepted?: string;
};

/** Remember actual cache/address transitions, including replacements React batches into an ABA render. */
export function useSubjectLibraryObservation(subject: SubjectReference, locale: string) {
  const client = useQueryClient();
  const router = useRouter();
  const observation = useMemo(() => {
    let address = subjectSlotReturnTo(router.state.location.publicHref, subject, locale);
    let value = {
      scope: 0,
      entry: 0,
      labels: 0,
      collections: 0,
      sessionReady: false,
      entryAdmitted: false,
      labelsAdmitted: false,
      collectionsAdmitted: false,
    };
    let previous: string[] | undefined;
    const read = () => {
      const session = client.getQueryState<ReturnType<typeof useSession>>(['session']);
      const exposure = client.getQueryState<string[]>(['exposure', 'viewer']);
      const viewer = session?.data;
      const sessionReady =
        session?.status === 'success' && viewer?.state === 'signed-in' && !!viewer.subject && !!viewer.csrfToken;
      const admitted = sessionReady && exposure?.status === 'success' ? exposure.data : undefined;
      const allowed = (operation: Parameters<typeof operationIsAdmitted>[0]) =>
        operationIsAdmitted(operation, admitted);
      const next = [
        JSON.stringify([address, session?.status, viewer?.state, viewer?.subject, !!viewer?.csrfToken]),
        JSON.stringify(
          ['library_entry.get', 'library_entry.put', 'library_entry.delete', 'library_entry.restore'].map((op) =>
            allowed(op as Parameters<typeof allowed>[0]),
          ),
        ),
        JSON.stringify(
          [
            'library_label.assignment_list',
            'library_label.list',
            'library_label.assign',
            'library_label.create',
            'library_label.unassign',
          ].map((op) => allowed(op as Parameters<typeof allowed>[0])),
        ),
        JSON.stringify([allowed('collection.list'), allowed('collection_member.create')]),
      ];
      if (!previous || next.some((key, index) => key !== previous![index])) {
        value = {
          scope: value.scope + (previous && next[0] !== previous[0] ? 1 : 0),
          entry: value.entry + (previous && next[1] !== previous[1] ? 1 : 0),
          labels: value.labels + (previous && next[2] !== previous[2] ? 1 : 0),
          collections: value.collections + (previous && next[3] !== previous[3] ? 1 : 0),
          sessionReady,
          entryAdmitted: allowed('library_entry.get'),
          labelsAdmitted: allowed('library_label.assignment_list'),
          collectionsAdmitted: allowed('collection.list') && allowed('collection_member.create'),
        };
        previous = next;
      }
      return value;
    };
    const server = value;
    return {
      owner: crypto.randomUUID(),
      read,
      server: () => server,
      subscribe: (notify: () => void) => {
        read();
        const cache = client.getQueryCache().subscribe(({ query }) => {
          if (query.queryKey[0] !== 'session' && query.queryKey[0] !== 'exposure') return;
          const before = value;
          if (read() !== before) notify();
        });
        const navigation = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          const next = subjectSlotReturnTo(toLocation.publicHref, subject, locale);
          if (address === next) return;
          address = next;
          read();
          notify();
        });
        return () => {
          cache();
          navigation();
        };
      },
    };
  }, [client, router, subject.id, subject.type, locale]);
  const value = useSyncExternalStore(observation.subscribe, observation.read, observation.server);
  return { ...observation, value };
}

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
  const entryPut = useOperation('library_entry.put');
  const entryDelete = useOperation('library_entry.delete');
  const entryRestore = useOperation('library_entry.restore');
  const assignments = useOperation('library_label.assignment_list');
  const labelList = useOperation('library_label.list');
  const labelAssign = useOperation('library_label.assign');
  const labelCreate = useOperation('library_label.create');
  const labelUnassign = useOperation('library_label.unassign');
  const collectionList = useOperation('collection.list');
  const memberCreate = useOperation('collection_member.create');
  const mounted = useRef(true);
  const admissions = useRef<Partial<Record<'entry' | 'labels' | 'collections', SlotAdmission>>>({});
  const scope = JSON.stringify([
    props.subject.id,
    props.subject.type,
    props.locale,
    returnTo,
    browser ? session.state : 'presentation',
    browser ? session.subject : null,
    browser ? !!session.csrfToken : false,
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
      !!session.subject &&
      !!session.csrfToken &&
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
      admitted: entryGet && (!browser || observation.value.entryAdmitted),
      operations: [entryGet, entryPut, entryDelete, entryRestore],
      revision: observation.value.entry,
    },
    labels: {
      admitted: assignments && (!browser || observation.value.labelsAdmitted),
      operations: [assignments, labelList, labelAssign, labelCreate, labelUnassign],
      revision: observation.value.labels,
    },
    collections: {
      admitted: collectionList && memberCreate && (!browser || observation.value.collectionsAdmitted),
      operations: [collectionList, memberCreate],
      revision: observation.value.collections,
    },
  };
  const ready = { entry: false, labels: false, collections: false };
  for (const family of ['entry', 'labels', 'collections'] as const) {
    let observed = admissions.current[family];
    const credentialMatches =
      !browser ||
      (provenance?.csrfToken === session.csrfToken && data.csrfToken === session.csrfToken) ||
      (!!provenance && observed?.accepted === provenance.readId);
    const revision = families[family].revision;
    const isCurrent = () => {
      const current = observation.read();
      return mounted.current && (!browser || (current.scope === observedScope && current[family] === revision));
    };
    const signature = JSON.stringify([
      scope,
      families[family].operations,
      browser ? revision : 0,
      actualIdentity && credentialMatches,
    ]);
    if (!observed || observed.signature !== signature) {
      if (observed) observed.lifetime.active = false;
      const retired = observed?.retired ?? new Set<string>();
      for (const id of observed?.seen ?? []) retired.add(id);
      const lifetime: SlotLifetime = { active: false, current: () => isCurrent() && lifetime.active };
      observed = { signature, lifetime, seen: new Set(), retired };
      admissions.current[family] = observed;
    }
    const accepted =
      actualIdentity &&
      credentialMatches &&
      families[family].admitted &&
      (!browser || (!!provenance && !observed.retired.has(provenance.readId)));
    if (accepted !== observed.lifetime.active) {
      observed.lifetime.active = false;
      const lifetime: SlotLifetime = { active: accepted, current: () => isCurrent() && lifetime.active };
      observed.lifetime = lifetime;
    }
    if (provenance) observed.seen.add(provenance.readId);
    if (accepted && provenance) observed.accepted = provenance.readId;
    ready[family] = accepted;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const memberResult = data.result === 'added' || data.result === 'collection-full';
  const current: SubjectLibrarySlotData = !browser
    ? data
    : {
        session:
          session.state === 'signed-out'
            ? 'signed-out'
            : actualIdentity && credentialReady(session) && (ready.entry || ready.labels || ready.collections)
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
        collectionsLoaded: ready.collections && data.collectionsLoaded,
        collections: ready.collections ? data.collections : null,
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
      entryLifetime={admissions.current.entry!.lifetime}
      labelLifetime={admissions.current.labels!.lifetime}
      collectionLifetime={admissions.current.collections!.lifetime}
    />
  );
}

function credentialReady(session: ReturnType<typeof useSession>) {
  return session.state === 'signed-in' && !!session.subject && !!session.csrfToken;
}

function LibraryStateSelect({
  busy,
  disabled,
  hasEntry,
  selectedState,
  selectedStateLabel,
  stateOptions,
  onChoose,
}: {
  busy: boolean;
  disabled: boolean;
  hasEntry: boolean;
  selectedState: string;
  selectedStateLabel: string;
  stateOptions: readonly (readonly [LibraryEntryStateWrite, string])[];
  onChoose: (value: string) => void;
}) {
  const knownState = stateOptions.some(([value]) => value === selectedState);
  const choices = [
    ...(hasEntry && selectedState && !knownState ? [{ value: otherStateValue, label: selectedStateLabel }] : []),
    ...stateOptions.map(([value, label]) => ({ value, label })),
    ...(hasEntry ? [{ value: removeValue, label: m.library_subject_remove() }] : []),
  ];
  return (
    <Select
      disabled={disabled}
      items={choices}
      onValueChange={(value) => onChoose(value ?? '')}
      value={selectedState ? (knownState ? selectedState : otherStateValue) : null}
    >
      <SelectTrigger
        aria-busy={busy ? true : undefined}
        aria-label={m.library_subject_entry()}
        className="w-fit bg-primary text-primary-foreground hover:bg-primary/80 data-placeholder:text-primary-foreground [&_svg]:text-primary-foreground"
      >
        {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        <SelectValue placeholder={m.library_subject_add()} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {choices.map((option) => (
          <Fragment key={option.value}>
            {option.value === removeValue ? <SelectSeparator /> : null}
            <SelectItem value={option.value}>{option.label}</SelectItem>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Compact subject-level Library controls rendered in the page's template action slot. */
function SubjectLibrarySlotView({
  subject,
  locale,
  data,
  entryLifetime,
  labelLifetime,
  collectionLifetime,
}: SubjectSlotProps & {
  entryLifetime: SlotLifetime;
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
  const uncertainEntry = useRef<{ input: SubjectLibraryMutation; previous: string } | null>(null);
  const initialEntry =
    data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
  const [entry, setEntry] = useState(initialEntry);
  const [selectedState, setSelectedState] = useState(initialEntry?.state ?? '');
  const [removeKey] = useState(() => crypto.randomUUID());
  const [collections, setCollections] = useState(data.collections);
  const [collectionsLoaded, setCollectionsLoaded] = useState(data.collectionsLoaded);
  const [collectionsProblem, setCollectionsProblem] = useState<'closed' | 'unavailable' | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const restoreAdmitted = useOperation('library_entry.restore');
  const entryPutAdmitted = useOperation('library_entry.put');
  const entryDeleteAdmitted = useOperation('library_entry.delete');
  const labelListAdmitted = useOperation('library_label.list');
  const labelAssignAdmitted = useOperation('library_label.assign');
  const labelCreateAdmitted = useOperation('library_label.create');
  const labelUnassignAdmitted = useOperation('library_label.unassign');
  const [labels, setLabels] = useState(data.labels ?? []);
  const [labelQuery, setLabelQuery] = useState('');
  const [labelNext, setLabelNext] = useState<string | null>(null);
  const [labelReadReason, setLabelReadReason] = useState<string>();
  const [labelChoices, setLabelChoices] = useState<LibraryLabelSummary[]>([]);
  const [labelSearchState, setLabelSearchState] = useState<'idle' | 'loaded' | 'closed' | 'unavailable' | 'signed-out'>(
    'idle',
  );
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const labelPickerTrigger = useRef<HTMLElement>(null);
  const [labelPending, setLabelPending] = useState(false);
  const [labelNotice, setLabelNotice] = useState(data.labelResult);
  const [labelUndo, setLabelUndo] = useState(data.labelUndo);
  const labelUndoKeys = useRef(new Map<string, string>());
  const restoredLabelEpisodes = useRef(new Set<string>());
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
    setEntryOrigin(entryLifetime);
    setEntry(initialEntry);
    setSelectedState(initialEntry?.state ?? '');
    setPending(false);
    setActionResult(undefined);
    setRestoreMessage(null);
    uncertainEntry.current = null;
    entryFlight.current = false;
  }
  if (labelOrigin !== labelLifetime) {
    setLabelOrigin(labelLifetime);
    setLabels(data.labels ?? []);
    setLabelPickerOpen(false);
    setLabelQuery('');
    latestLabelQuery.current = '';
    setLabelChoices([]);
    setLabelNext(null);
    setLabelReadReason(undefined);
    setLabelSearchState('idle');
    setLabelPending(false);
    setLabelNotice(undefined);
    setLabelUndo(undefined);
    labelUndoKeys.current.clear();
    restoredLabelEpisodes.current.clear();
    labelFlight.current = false;
  }
  if (collectionOrigin !== collectionLifetime) {
    setCollectionOrigin(collectionLifetime);
    setCollections(data.collections);
    setCollectionsLoaded(data.collectionsLoaded);
    setCollectionsProblem(null);
    setMemberResult(undefined);
    memberFlight.current = false;
    pickerFlight.current = false;
  }
  const stateOptions = (data.stateOptions ?? []).map(({ id, label }) => [id, label.text] as const);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    const loadedEntry =
      data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
    setEntry(loadedEntry);
    setSelectedState(loadedEntry?.state ?? '');
    setCollections(data.collections);
    setCollectionsLoaded(data.collectionsLoaded);
  }, [data.entry, data.restore, data.collections, data.collectionsLoaded]);
  useEffect(() => setLabels(data.labels ?? []), [data.labels]);
  useEffect(() => {
    setLabelNotice(data.labelResult);
    if (
      data.labelUndo &&
      restoredLabelEpisodes.current.has(labelEpisode(data.labelUndo.assignmentId, data.labelUndo.revision))
    )
      return;
    if (!data.labelUndo && labelUndo) return;
    setLabelUndo(data.labelUndo);
  }, [data.labelResult, data.labelUndo]);
  useEffect(() => {
    if (!hydrated || !labelPickerOpen || !labelListAdmitted || !labelLifetime.current()) return;
    let current = true;
    const query = labelQuery;
    const currentSearch = () => current && labelLifetime.current() && searchOrigin.current.sequence === searchSequence;
    setLabelNext(null);
    setLabelChoices([]);
    setLabelSearchState('idle');
    setLabelReadReason(undefined);
    const timeout = setTimeout(() => {
      if (!currentSearch()) return;
      const credential = data.csrfToken;
      void searchSubjectLabelsAction({ data: { query } })
        .then((response) => {
          if (!currentSearch() || latestLabelQuery.current !== query) return;
          if (
            response.provenance?.viewer !== data.provenance?.viewer ||
            !response.provenance ||
            response.provenance.csrfToken !== credential ||
            response.provenance.query !== query
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
            : result === 'closed'
              ? m.library_subject_closed()
              : result === 'unsupported_library_profile'
                ? m.library_entry_profile_unsupported()
                : result === 'conflict'
                  ? m.library_conflict()
                  : result === 'unavailable'
                    ? m.library_subject_unavailable()
                    : null;

  async function restoreEntry(receipt: { deletionId: string; revision: number }) {
    if (!hydrated || !entryLifetime.current() || !restoreAdmitted) return;
    try {
      const restored = await restoreSubjectLibrarySlot({
        data: { subjectId: subject.id, ...receipt },
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      if (!entryLifetime.current()) return;
      void queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
      if (restored.ok) {
        setEntry(restored.entry);
        setSelectedState(restored.entry.state);
        setActionResult('saved');
        setRestoreMessage(null);
      } else if (restored.reason === 'occupied') {
        if (restored.entry) {
          setEntry(restored.entry);
          setSelectedState(restored.entry.state);
        }
        setActionResult(undefined);
        setRestoreMessage(m.library_restore_occupied());
      } else if (restored.reason === 'stale') setRestoreMessage(m.library_restore_stale());
      else if (restored.reason === 'expired') setRestoreMessage(m.library_restore_expired());
      else setRestoreMessage(m.library_subject_unavailable());
    } catch {
      if (entryLifetime.current()) setRestoreMessage(m.library_subject_unavailable());
    }
  }

  function applyEntryResult(response: SubjectLibraryMutationResponse, previous: string) {
    if (!entryLifetime.current()) return;
    if (response.result === 'saved' && response.entry) {
      setEntry(response.entry);
      setSelectedState(response.entry.state);
      setActionResult('saved');
      return;
    }
    if (response.result === 'cleared') {
      setEntry(null);
      setSelectedState('');
      setActionResult('cleared');
      if (response.undo && restoreAdmitted) {
        const receipt = response.undo;
        undoToast(
          m.library_removed(),
          () => {
            if (!entryLifetime.current() || !restoreAdmitted) return;
            void restoreEntry(receipt);
          },
          { undo: m.editor_undo() },
        );
      }
      return;
    }
    if (response.result === 'conflict' && 'entry' in response) {
      setEntry(response.entry ?? null);
      setSelectedState(response.entry?.state ?? '');
      setActionResult('conflict');
      return;
    }
    setSelectedState(previous);
    setActionResult(response.result);
  }

  async function writeEntry(input: SubjectLibraryMutation, previous: string) {
    if (
      !entryLifetime.current() ||
      entryFlight.current ||
      (input.action === 'clear' ? !entryDeleteAdmitted : !entryPutAdmitted)
    )
      return;
    entryFlight.current = true;
    uncertainEntry.current = { input, previous };
    setPending(true);
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      if (!entryLifetime.current()) return;
      if (response.result !== 'unavailable') uncertainEntry.current = null;
      applyEntryResult(response, previous);
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
    } catch {
      if (!entryLifetime.current()) return;
      setSelectedState(previous);
      setActionResult('unavailable');
    } finally {
      if (entryLifetime.current()) {
        entryFlight.current = false;
        setPending(false);
      }
    }
  }

  function choose(value: string) {
    if (!hydrated || pending || !value || !entryLifetime.current()) return;
    if (uncertainEntry.current) {
      void writeEntry(uncertainEntry.current.input, uncertainEntry.current.previous);
      return;
    }
    if (value === 'remove') {
      if (!entry) return;
      const previous = selectedState;
      setPending(true);
      void writeEntry(
        {
          subjectId: subject.id,
          intent: 'entry',
          action: 'clear',
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: crypto.randomUUID(),
        },
        previous,
      );
      return;
    }
    if (value === selectedState || !stateOptions.some(([state]) => state === value)) return;
    const next = value as LibraryEntryStateWrite;
    const previous = selectedState;
    setSelectedState(next);
    setPending(true);
    void writeEntry(
      {
        subjectId: subject.id,
        intent: 'entry',
        action: 'save',
        state: next,
        ...(entry ? { revision: entry.revision } : {}),
        ...(entry?.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        idempotencyKey: crypto.randomUUID(),
      },
      previous,
    );
  }

  async function mutate(input: SubjectLibraryMutation) {
    if (!hydrated || !collectionLifetime.current() || memberFlight.current) return;
    memberFlight.current = true;
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      if (!collectionLifetime.current()) return;
      setMemberResult(response.result);
      await queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
    } catch {
      if (collectionLifetime.current()) setMemberResult('unavailable');
    } finally {
      if (collectionLifetime.current()) memberFlight.current = false;
    }
  }

  function addToCollection(collectionId: string) {
    return mutate({
      subjectId: subject.id,
      intent: 'member',
      collectionId,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function loadCollections(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!hydrated || !collectionLifetime.current() || pickerFlight.current) return;
    pickerFlight.current = true;
    const credential = data.csrfToken;
    try {
      const response = await readSubjectLibraryCollections({ data: { subjectId: subject.id } });
      if (!collectionLifetime.current()) return;
      if (
        !response.provenance ||
        response.provenance.viewer !== data.provenance?.viewer ||
        response.provenance.csrfToken !== credential
      ) {
        setCollections(null);
        setCollectionsLoaded(false);
        setCollectionsProblem('unavailable');
        return;
      }
      setCollections(response.collections);
      setCollectionsLoaded(response.state === 'loaded');
      setCollectionsProblem(response.state === 'loaded' ? null : response.state);
    } catch {
      if (collectionLifetime.current()) setCollectionsProblem('unavailable');
    } finally {
      if (collectionLifetime.current()) pickerFlight.current = false;
    }
  }

  function labelFailure(reason: string) {
    if (!labelLifetime.current()) return;
    if (reason === 'restore-stale') {
      setLabelNotice('label-restore-stale');
      return;
    }
    if (reason === 'capacity') setLabelNotice('label-capacity');
    else if (reason === 'restore-expired') setLabelNotice('label-restore-expired');
    else if (reason === 'restore-occupied') setLabelNotice('label-restore-occupied');
    else if (reason === 'restore-capacity') setLabelNotice('label-restore-capacity');
    else if (reason === 'closed') setLabelNotice('closed');
    else setLabelNotice('unavailable');
  }

  async function writeLabel(input: {
    intent: 'assign' | 'create-and-assign' | 'restore';
    label?: LibraryLabelSummary | SubjectLabel;
    name?: string;
    assignment?: SubjectLabel;
    revision?: number;
  }) {
    if (
      !hydrated ||
      !labelLifetime.current() ||
      labelFlight.current ||
      !labelAssignAdmitted ||
      (input.intent === 'create-and-assign' && (!labelCreateAdmitted || !labelListAdmitted))
    )
      return;
    labelFlight.current = true;
    setLabelPending(true);
    setLabelNotice(undefined);
    try {
      const headers = { 'X-CSRF-Token': data.csrfToken ?? '' };
      const response =
        input.intent === 'create-and-assign'
          ? await mutateSubjectLabelAction({
              data: {
                intent: 'create-and-assign',
                subjectId: subject.id,
                name: input.name ?? '',
                createKey: crypto.randomUUID(),
                ...(data.labelCreateKey ? { createKey: data.labelCreateKey } : {}),
                idempotencyKey: crypto.randomUUID(),
                ...(data.labelAssignKey ? { idempotencyKey: data.labelAssignKey } : {}),
              },
              headers,
            })
          : input.intent === 'assign'
            ? await mutateSubjectLabelAction({
                data: {
                  intent: 'assign',
                  subjectId: subject.id,
                  labelId: input.label && 'labelId' in input.label ? input.label.labelId : (input.label?.id ?? ''),
                  idempotencyKey: crypto.randomUUID(),
                  ...(data.labelAssignKey ? { idempotencyKey: data.labelAssignKey } : {}),
                },
                headers,
              })
            : await mutateSubjectLabelAction({
                data: {
                  intent: 'restore',
                  subjectId: subject.id,
                  labelId: input.label && 'labelId' in input.label ? input.label.labelId : (input.label?.id ?? ''),
                  assignmentId: input.assignment?.id ?? '',
                  revision: input.revision ?? 0,
                  idempotencyKey: crypto.randomUUID(),
                  ...(input.assignment && input.revision !== undefined
                    ? { idempotencyKey: labelUndoKeyFor(input.assignment.id, input.revision) }
                    : {}),
                },
                headers,
              });
      if (!labelLifetime.current()) return;
      if (!response.ok) {
        labelFailure(response.reason);
        return;
      }
      setLabelUndo(undefined);
      if (input.intent === 'restore' && input.assignment && input.revision !== undefined)
        restoredLabelEpisodes.current.add(labelEpisode(input.assignment.id, input.revision));
      if (input.intent !== 'restore') setLabelUndo(labelUndo);
      const label = response.label ?? input.label;
      if (label?.name) {
        const labelId = 'labelId' in label ? label.labelId : label.id;
        setLabels((current) => [
          ...current.filter((row) => row.labelId !== labelId),
          { id: response.assignment.id, labelId, name: label.name, revision: response.assignment.revision },
        ]);
      }
      setLabelPickerOpen(false);
      setLabelQuery('');
      latestLabelQuery.current = '';
      setLabelChoices([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]);
    } catch {
      if (labelLifetime.current()) setLabelNotice('unavailable');
    } finally {
      if (labelLifetime.current()) {
        labelFlight.current = false;
        setLabelPending(false);
      }
    }
  }

  async function submitLabelName(event: FormEvent<HTMLFormElement>) {
    if (!hydrated) return;
    event.preventDefault();
    if (!labelLifetime.current() || !labelListAdmitted || labelSearchState !== 'loaded') return;
    const name = normalizeLibraryLabelName(labelQuery);
    if (!name) return;
    const existing = labelChoices.find((candidate) => normalizeLibraryLabelName(candidate.name) === name);
    if (existing) await writeLabel({ intent: 'assign', label: existing });
    else await writeLabel({ intent: 'create-and-assign', name: labelQuery });
  }

  async function removeLabel(label: SubjectLabel) {
    if (!hydrated || !labelLifetime.current() || labelFlight.current || !labelUnassignAdmitted) return;
    labelFlight.current = true;
    setLabelPending(true);
    try {
      const response = await mutateSubjectLabelAction({
        data: {
          intent: 'unassign',
          subjectId: subject.id,
          labelId: label.labelId,
          assignmentId: label.id,
          revision: label.revision,
          idempotencyKey: crypto.randomUUID(),
          ...(data.labelRemoveKeys?.[label.id] ? { idempotencyKey: data.labelRemoveKeys[label.id] } : {}),
        },
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      if (!labelLifetime.current()) return;
      if (!response.ok) {
        labelFailure(response.reason);
        return;
      }
      setLabels((current) => current.filter((row) => row.id !== label.id));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]);
      if (!labelLifetime.current()) return;
      const restoreRevision = response.restoreRevision;
      if (restoreRevision === undefined) {
        setLabelNotice('unavailable');
        return;
      }
      setLabelUndo({ labelId: label.labelId, assignmentId: label.id, revision: restoreRevision });
      undoToast(
        m.library_subject_label_removed({ name: label.name }),
        () =>
          void writeLabel({
            intent: 'restore',
            label: { id: label.labelId, name: label.name, revision: 1 },
            assignment: label,
            revision: restoreRevision,
          }),
        { undo: m.library_subject_label_undo() },
      );
    } catch {
      if (labelLifetime.current()) setLabelNotice('unavailable');
    } finally {
      if (labelLifetime.current()) {
        labelFlight.current = false;
        setLabelPending(false);
      }
    }
  }

  function onRemoveForm(event: FormEvent<HTMLFormElement>, label: SubjectLabel) {
    if (!hydrated) return;
    event.preventDefault();
    void removeLabel(label);
  }

  return (
    <section aria-label={m.library_subject_heading()} className="flex flex-wrap items-center gap-2">
      {data.undo ? (
        <div
          onSubmit={(event) => {
            if (!hydrated) return;
            event.preventDefault();
            if (data.undo && data.undo.subjectId === subject.id) void restoreEntry(data.undo);
          }}
        >
          <EntryUndoForm undo={data.undo} locale={locale} csrfToken={data.csrfToken} returnTo={returnTo} />
        </div>
      ) : null}
      {data.restore ? <EntryRestoreFeedback restore={data.restore} locale={locale} /> : null}
      {entry && data.session === 'signed-in' ? (
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
            data-library-entry
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
            <LibraryStateSelect
              busy={pending}
              disabled={!hydrated || pending}
              hasEntry={entry !== null}
              onChoose={choose}
              selectedState={selectedState}
              selectedStateLabel={data.entryStateLabel ?? m.library_other()}
              stateOptions={stateOptions}
            />
          </form>
        </Exposure>
      ) : null}

      {data.session === 'signed-in' && data.entryAvailable && entry && (!stateOptions.length || !entryPutAdmitted) ? (
        <div data-library-entry className="flex items-center gap-2">
          <span data-library-entry-state>{data.entryStateLabel ?? m.library_other()}</span>
          {entryDeleteAdmitted ? (
            <Exposure operation="library_entry.delete">
              <button
                type="button"
                className={buttonClass}
                disabled={!hydrated || pending}
                onClick={() => choose('remove')}
              >
                {m.library_subject_remove()}
              </button>
            </Exposure>
          ) : null}
        </div>
      ) : null}

      {hydrated && !pending && entryLifetime.current() && uncertainEntry.current ? (
        <button
          type="button"
          className={buttonClass}
          disabled={pending}
          onClick={() => {
            const original = uncertainEntry.current;
            if (original && entryLifetime.current()) void writeEntry(original.input, original.previous);
          }}
        >
          {m.library_selection_retry()}
        </button>
      ) : null}

      {data.session === 'signed-in' && (!hydrated || collectionLifetime.current()) ? (
        <Exposure operation="collection_member.create">
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
              <div className="max-h-[70vh] w-full min-w-0 overflow-y-auto p-4 sm:w-72">
                <p className="mb-3 text-sm text-muted-foreground">
                  {m.library_subject_add_subject()} <SubjectRef subject={subject} />
                </p>
                {collectionsLoaded && collections ? (
                  collections.length ? (
                    <ul className="space-y-2">
                      {collections.map((collection) => (
                        <li key={collection.id}>
                          <button
                            className={`${linkClass} inline-flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-start hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60`}
                            type="button"
                            disabled={!hydrated}
                            onClick={() => void addToCollection(collection.id)}
                          >
                            <span className="truncate">{collection.title}</span>
                            <span className="shrink-0 text-muted-foreground">{collection.memberCount}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{m.library_subject_no_collections()}</p>
                  )
                ) : (
                  <form method="get" action={action} onSubmit={(event) => void loadCollections(event)}>
                    <input type="hidden" name="slot" value="collections" />
                    <button className={buttonClass} type="submit">
                      {m.library_subject_load_collections()}
                    </button>
                  </form>
                )}
                {collectionsProblem ? (
                  <p role="alert" className="mt-3 text-sm text-muted-foreground">
                    {collectionsProblem === 'closed' ? m.library_subject_closed() : m.library_subject_unavailable()}
                  </p>
                ) : null}
              </div>
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
            <a className={linkClass} href={`/library/progress?subjectId=${encodeURIComponent(subject.id)}`}>
              {m.library_subject_start_progress()}
            </a>
          </Exposure>
          <Exposure operation="copy.list">
            <a className={linkClass} href={`/library/copies?subjectId=${encodeURIComponent(subject.id)}`}>
              {m.library_subject_your_copies()}
            </a>
          </Exposure>
        </nav>
      ) : null}
      {data.publicCollections ? (
        <Exposure operation="subject_collection.list">
          <details data-public-collections className="relative">
            <summary className={`${buttonClass} cursor-pointer list-none`}>
              {m.library_subject_public_collections({ count: data.publicCollections.length })}
            </summary>
            <div className="absolute end-0 z-20 mt-2 w-80 max-w-[90vw] rounded-xl border border-border bg-background p-4 shadow-xl">
              {data.publicCollections.length ? (
                <ul className="space-y-3">
                  {data.publicCollections.map((collection) => (
                    <ContentItem
                      key={collection.id}
                      title={collection.title}
                      headingLevel={3}
                      href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(collection.id)}`}
                      metadata={
                        <>
                          {collection.curator?.handle ? (
                            <a
                              href={`/${encodeURIComponent(locale)}/@${encodeURIComponent(collection.curator.handle)}`}
                            >
                              <AccountRef account={collection.curator} />
                            </a>
                          ) : (
                            <AccountRef account={collection.curator} />
                          )}
                          <span>{m.library_subject_multiplicity({ count: collection.multiplicity })}</span>
                        </>
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{m.library_subject_no_public_collections()}</p>
              )}
            </div>
          </details>
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
          <div data-subject-labels className="basis-full space-y-2">
            {labels.length ? (
              <ul className="flex flex-wrap items-center gap-2">
                {labels.map((label) => (
                  <li
                    key={label.id}
                    data-subject-label-chip
                    className="inline-flex min-w-0 items-center gap-1 rounded-full border bg-muted/60 px-3 py-1 text-sm"
                  >
                    <a
                      href={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(label.labelId)}`}
                      className="max-w-48 truncate text-primary underline-offset-4 hover:underline"
                    >
                      {label.name}
                    </a>
                    <Exposure operation="library_label.unassign">
                      <form
                        data-subject-label-remove
                        method="post"
                        action={action}
                        onSubmit={(event) => onRemoveForm(event, label)}
                        className="m-0"
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
                          disabled={hydrated && labelPending}
                          aria-label={m.library_subject_label_remove({ name: label.name })}
                          className="rounded-full px-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
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
                  className={`${buttonClass} cursor-pointer list-none`}
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
                    <label className="grid gap-1 text-sm font-medium">
                      {m.library_subject_label_input()}
                      <input
                        name="name"
                        aria-label={m.library_subject_label_name()}
                        autoComplete="off"
                        maxLength={200}
                        required
                        value={labelQuery}
                        onChange={(event) => {
                          if (!labelLifetime.current()) return;
                          searchOrigin.current = {
                            ...searchOrigin.current,
                            query: event.currentTarget.value,
                            sequence: searchOrigin.current.sequence + 1,
                          };
                          setLabelChoices([]);
                          setLabelNext(null);
                          setLabelSearchState('idle');
                          latestLabelQuery.current = event.currentTarget.value;
                          setLabelQuery(event.currentTarget.value);
                        }}
                        className="h-11 w-full min-w-0 rounded-md border bg-background px-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Exposure operation="library_label.create">
                        <button type="submit" disabled={hydrated && labelPending} className={buttonClass}>
                          {m.library_subject_label_add()}
                        </button>
                      </Exposure>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          if (!labelLifetime.current()) return;
                          searchOrigin.current = {
                            query: '',
                            open: false,
                            sequence: searchOrigin.current.sequence + 1,
                          };
                          setLabelPickerOpen(false);
                          setLabelQuery('');
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
                        labelLifetime.current() &&
                        searchOrigin.current.sequence === searchSequence &&
                        searchOrigin.current.open
                      }
                      acceptPage={(page, request) =>
                        !!page.provenance &&
                        page.provenance.viewer === data.provenance?.viewer &&
                        page.provenance.csrfToken === data.csrfToken &&
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
                                disabled={hydrated && labelPending}
                                onClick={() => void writeLabel({ intent: 'assign', label: choice })}
                                className="w-full rounded px-2 py-1 text-start text-sm hover:bg-muted disabled:opacity-50"
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
                                disabled={hydrated && labelPending}
                                onClick={() => void writeLabel({ intent: 'create-and-assign', name: labelQuery })}
                                className="w-full rounded px-2 py-1 text-start text-sm font-medium text-primary hover:bg-muted disabled:opacity-50"
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
            <SubjectLabelNotice {...(labelNotice !== undefined ? { result: labelNotice } : {})} />
            {labelUndo ? (
              <form
                data-label-undo
                method="post"
                action={action}
                className="flex items-center gap-2 text-sm"
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
                <button type="submit" className={linkClass}>
                  {m.library_subject_label_undo()}
                </button>
              </form>
            ) : null}
          </div>
        </Exposure>
      ) : null}
      {resultText ? (
        <p role="alert" className="basis-full text-sm text-muted-foreground">
          {resultText}
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
