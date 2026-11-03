import { progressDecimalIssue, progressLocatorIssue } from './progress-decimal-input';
import { ProgressDecimalInput, ProgressInputError } from './progress-decimal-input-field';
import { ProgressAddressCorrection } from './progress-address-correction';
import * as exposure from '../kernel/exposure';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useReadingAuthority } from './reading-detail-current-origin';
import type { GatedOperation } from '../kernel/exposure';
import type { ProgressDetail, ProgressDetailAddress } from './progress-detail-server';
import { ProgressLogs } from './logs-progress';
import { PublicationNoteDraftNavigation, usePublicationNoteDraftNavigation } from './publication-note-draft-navigation';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import type { ReactNode } from 'react';
import { RelativeTime } from './logs-progress';
import { ProgressRow } from '@rezics/ui/progress-row';
import { Button } from '@rezics/ui/shadcn/button';
import { isNotFound, Link } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@rezics/ui/menu';
import { ContentItem } from '@rezics/ui/content-item';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import {
  parseUnitBatch,
  type ProgressChange,
  type ProgressFailure,
  type ProgressSessionPage,
  type ProgressState,
  type ProgressRecordInput,
  type ProgressFinishInput,
  type ProgressSessionView,
  type ProgressSnapshot,
  applyProgressSnapshot,
} from './progress-reads';
import { finishProgressSession, recordProgressSession, readProgressSession } from './progress-server';
import { rowRatio, SubjectCover, SubjectIdentity } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';
import { progressFailureMessage, progressView } from './progress-label';
import { scalarRecordingValue } from './progress-view';
import { ProgressCorrectionReview } from './progress-actions';
import { isPlatformClosedError } from '../kernel/platform-closed';
import {
  IndependentMeasuresReadout,
  IndependentMeasuresVisit,
  projectIndependentMeasures,
  sessionHasIndependentMeasures,
} from './independent-measures';

const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

const { Exposure } = exposure;
const readDetail = async (data: ProgressDetailAddress, isCurrent: () => boolean) => {
  if (!isCurrent()) throw new Error('Progress detail read retired');
  const { readProgressDetail } = await import('./progress-detail-server');
  if (!isCurrent()) throw new Error('Progress detail read retired');
  const result = await readProgressDetail({ data });
  if (!isCurrent()) throw new Error('Progress detail read retired');
  return result;
};

const detailOperations = [
  'progress_session.read',
  'progress_session.changes',
  'progress_session.units',
  'published_log.list',
  'progress_session.record',
  'progress_session.complete',
  'progress_session.abandon',
  'published_log.create',
] as const;
function sameAddress(a: ProgressDetailAddress, b: ProgressDetailAddress) {
  return a.id === b.id && a.changes === b.changes && a.units === b.units && a.logs === b.logs;
}

function matchingDetail(
  detail: ProgressDetail | undefined,
  viewer: string | null,
  address: ProgressDetailAddress,
): detail is Extract<ProgressDetail, { state: 'ready' }> {
  return (
    detail?.state === 'ready' &&
    detail.viewer === viewer &&
    sameAddress(detail.address, address) &&
    detail.progress.signedIn &&
    detail.logs.signedIn &&
    detail.progress.session.id === address.id
  );
}

export type ProgressCommandGuard = {
  isCurrent: () => boolean;
  headers: () => HeadersInit | null;
};

/** Compatible standalone callers may omit the mounted command capture. */
export type ProgressDetailOrigin = {
  viewer: string;
  address: ProgressDetailAddress;
  isCurrent: (write?: boolean) => boolean;
  refresh: () => Promise<ProgressSessionPage>;
  capture?: (operation?: GatedOperation) => ProgressCommandGuard;
  observation?: object | undefined;
  /** Private intent custody survives admission/read replacement, never viewer or address replacement. */
  lifetime?: object | undefined;
};
const detailReads = detailOperations.slice(0, 4);

/** The actual viewer observation owns the read; loader identity only rejects mismatches. */
export function CurrentProgressDetail({ loaded, address }: { loaded: ProgressDetail; address: ProgressDetailAddress }) {
  const { client, browser, store, snapshot } = useReadingAuthority(detailOperations);
  const viewer = browser ? snapshot.viewer : loaded.viewer;
  const locale = getLocale();
  const custodySignature = JSON.stringify([
    browser ? snapshot.owner : viewer,
    address.id,
    address.changes,
    address.units,
    address.logs,
    locale,
  ]);
  const custody = useRef<{ signature: string; identity: object; value: object } | null>(null);
  if (custody.current?.signature !== custodySignature || custody.current.identity !== snapshot.identity)
    custody.current = { signature: custodySignature, identity: snapshot.identity, value: {} };
  const readEpisode = detailReads.map((operation) => snapshot.admissions.get(operation)?.id);
  const signature = JSON.stringify([
    viewer,
    address.id,
    address.changes,
    address.units,
    address.logs,
    locale,
    readEpisode,
  ]);
  const [instance] = useState(() => crypto.randomUUID());
  type Boundary = { signature: string; identity: object; active: boolean; epoch: number; seed?: ProgressDetail };
  const ref = useRef<Boundary | null>(null);
  const enrolled = useRef(false);
  if (
    !ref.current ||
    !ref.current.active ||
    ref.current.signature !== signature ||
    ref.current.identity !== snapshot.identity
  ) {
    const previous = ref.current;
    if (previous) previous.active = false;
    const seed =
      (!browser || (!enrolled.current && snapshot.viewer && snapshot.ready)) && matchingDetail(loaded, viewer, address)
        ? loaded
        : undefined;
    if (browser && snapshot.viewer && snapshot.ready) enrolled.current = true;
    ref.current = {
      signature,
      identity: snapshot.identity,
      active: true,
      epoch: (previous?.epoch ?? 0) + 1,
      ...(seed ? { seed } : {}),
    };
  }
  const boundary = ref.current;
  const mounted = useRef(0);
  useLayoutEffect(() => {
    mounted.current++;
    return () => {
      mounted.current--;
    };
  }, []);
  const sameBoundary = () => ref.current === boundary && boundary.active && getLocale() === locale;
  const isCurrent = () => sameBoundary() && (!browser || store.current(snapshot, detailReads));
  const allowed = !browser || store.current(snapshot, detailReads);
  const queryKey = ['progress-detail', instance, signature, boundary.epoch] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    queryFn: () => readDetail(address, isCurrent),
    enabled: personalRead.enabled && browser && !!viewer && allowed,
    initialData: boundary.seed,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [, renderRetired] = useState(0);
  const evidence = useRef<{ boundary: Boundary; query: object; version: number; retired: boolean } | null>(null);
  const checkEvidence = () => {
    const enrolled = evidence.current;
    if (!enrolled || enrolled.boundary !== boundary || enrolled.retired) return false;
    const query = client.getQueryCache().find({ queryKey, exact: true });
    const state = client.getQueryState<ProgressDetail>(queryKey);
    if (
      query === enrolled.query &&
      state?.status === 'success' &&
      state.dataUpdateCount === enrolled.version &&
      matchingDetail(state.data, viewer, address)
    )
      return true;
    enrolled.retired = true;
    return false;
  };
  const actualQuery = client.getQueryCache().find({ queryKey, exact: true });
  const actualState = client.getQueryState<ProgressDetail>(queryKey);
  if (
    actualQuery &&
    actualState?.status === 'success' &&
    matchingDetail(actualState.data, viewer, address) &&
    (evidence.current?.boundary !== boundary ||
      evidence.current.query !== actualQuery ||
      evidence.current.version !== actualState.dataUpdateCount)
  ) {
    if (evidence.current) evidence.current.retired = true;
    evidence.current = { boundary, query: actualQuery, version: actualState.dataUpdateCount, retired: false };
  }
  useLayoutEffect(() => {
    const observe = () => {
      const accepted = evidence.current;
      if (accepted?.boundary === boundary && !accepted.retired && !checkEvidence()) renderRetired((value) => value + 1);
    };
    const release = client.getQueryCache().subscribe(observe);
    observe();
    return release;
  }, [boundary, client, actualQuery]);
  const originRef = useRef<{ boundary: Boundary; value: ProgressDetailOrigin } | null>(null);
  if (originRef.current?.boundary !== boundary && viewer) {
    // These methods retain the owning viewer/address, while captures enroll a particular
    // successful observation and operation. Churn cannot replace the editor's exact intent.
    const owns = () => mounted.current > 0 && sameBoundary();
    const currentReads = () =>
      owns() &&
      checkEvidence() &&
      store.current(store.read(), detailReads) &&
      store.read().identity === boundary.identity;
    originRef.current = {
      boundary,
      value: {
        viewer,
        address,
        lifetime: custody.current.value,
        isCurrent: (write = false) =>
          currentReads() && (!write || store.current(store.read(), ['published_log.create'])),
        capture: (operation) => {
          const enrolled = store.read();
          const actualRead = evidence.current;
          const operations = operation ? [...detailReads, operation] : detailReads;
          const current = () =>
            owns() &&
            actualRead === evidence.current &&
            checkEvidence() &&
            enrolled.identity === boundary.identity &&
            store.current(enrolled, operations, true);
          return { isCurrent: current, headers: () => (current() ? store.headers(enrolled, operations) : null) };
        },
        get observation() {
          return store.read().observation;
        },
        refresh: async () => {
          const enrolled = store.read();
          const actualRead = evidence.current;
          const current = () =>
            owns() &&
            actualRead === evidence.current &&
            checkEvidence() &&
            enrolled.identity === boundary.identity &&
            store.current(enrolled, detailReads, true);
          if (!current()) return { signedIn: false, idempotencyKey: '' };
          const fresh = await readDetail(address, current);
          if (!current() || !matchingDetail(fresh, viewer, address)) return { signedIn: false, idempotencyKey: '' };
          return fresh.progress;
        },
      },
    };
  }
  let detail = (!browser || checkEvidence()) && matchingDetail(query.data, viewer, address) ? query.data : undefined;
  if (
    detail &&
    matchingDetail(loaded, viewer, address) &&
    loaded.progress.session.revision > detail.progress.session.revision
  )
    detail = loaded;
  // A healthy same-viewer rotation pauses dispatch while its new scoped read is pending.
  // Keeping this already accepted read mounted preserves the existing publication editor.
  const healthyPause = browser && snapshot.healthyPause;
  if (query.data?.state === 'invalid' && sameAddress(query.data.address, address) && isCurrent())
    return <ProgressAddressCorrection address={address} issue={query.data.issue} />;
  if (!viewer || (!allowed && !healthyPause) || !detail)
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <p role="status">{m.library_progress_unavailable()}</p>
        {viewer && allowed ? (
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => {
              if (isCurrent()) void query.refetch();
            }}
          >
            {m.library_progress_retry()}
          </Button>
        ) : null}
      </article>
    );
  const originating = originRef.current!.value;
  return (
    <ProgressSessionPage
      key={`${instance}:${boundary.epoch}`}
      page={detail.progress}
      logsCursor={address.logs}
      originating={originating}
    >
      <ProgressLogs progress={detail.progress} logs={detail.logs} search={address} originating={originating} />
    </ProgressSessionPage>
  );
}

type LoadedPage = Extract<ProgressSessionPage, { signedIn: true }>;
type CapturedIntent =
  | { kind: 'record' | 'add' | 'remove'; data: ProgressRecordInput }
  | { kind: 'finish'; data: ProgressFinishInput };
type EditorLifetime = {
  page: LoadedPage;
  originating?: ProgressDetailOrigin | undefined;
  custody: EditorCustody;
  history: symbol | null;
};
type EditorCustody = { retry?: CapturedIntent; credential?: HeadersInit; flight?: object };
type ProgressDraftBaseline = {
  amount: string;
  locator: string;
  position: string;
  addText: string;
  removeText: string;
};

function hasUnsavedProgressDraft(
  mode: LoadedPage['session']['mode'],
  baseline: ProgressDraftBaseline,
  draft: ProgressDraftBaseline,
): boolean {
  if (mode === 'scalar_amount') return draft.amount.trim() !== baseline.amount.trim();
  if (mode === 'cursor_position')
    return draft.locator !== baseline.locator || draft.position.trim() !== baseline.position.trim();
  return draft.addText.trim() !== baseline.addText.trim() || draft.removeText.trim() !== baseline.removeText.trim();
}

const editors = new WeakMap<object, EditorCustody>();
function editorLifetime(page: LoadedPage, originating?: ProgressDetailOrigin): EditorLifetime {
  const key = originating?.lifetime ?? originating;
  const custody = (key && editors.get(key)) || {};
  if (key) editors.set(key, custody);
  return { page, originating, history: null, custody };
}

function stateLabel(state: ProgressState): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

const historyTextLimit = 160;
const historyUnitLimit = 4;
const historyDisclosureClass =
  'min-h-11 cursor-pointer content-center rounded-md text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const historyPreviewClass = 'min-w-0 [&:has(>details[open])>[data-history-preview]]:hidden';

function longHistoryText(value: string): boolean {
  return value.length > historyTextLimit || value.split(/\r\n|\r|\n/, 4).length > 3;
}

function historyExcerpt(value: string): string {
  // Do not split a surrogate pair. Only the preview is shortened; disclosure uses the original.
  const end = (value.codePointAt(historyTextLimit - 1) ?? 0) > 0xffff ? historyTextLimit - 1 : historyTextLimit;
  return value.length > end ? `${value.slice(0, end)}…` : value;
}

function mergeIndependentSnapshot(current: ProgressSessionView, snapshot: ProgressSnapshot): ProgressSessionView {
  return applyProgressSnapshot(current, snapshot);
}

function ProgressHistoryFacts({ change, preview = false }: { change: ProgressChange; preview?: boolean }) {
  return (
    <dl className="flex min-w-0 flex-wrap gap-x-8 gap-y-3">
      {(
        [
          [m.library_progress_unit(), change.measureId],
          [m.library_progress_amount(), change.amount],
          [m.library_progress_locator(), change.locator],
          [m.library_progress_position(), change.position],
          [m.library_progress_clear(), change.cleared ? m.library_progress_measure_clear() : null],
        ] as const
      )
        .filter(([, value]) => value != null)
        .map(([label, value]) => (
          <div key={label} className="min-w-0 max-w-full space-y-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${preview ? 'line-clamp-2' : ''}`}>
              {preview ? historyExcerpt(value!) : value}
            </dd>
          </div>
        ))}
      {(
        [
          [m.library_progress_units_added(), change.add],
          [m.library_progress_units_removed(), change.remove],
        ] as const
      ).map(([label, units]) =>
        units.length ? (
          <div key={label} className="min-w-0 max-w-full space-y-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>
              <ul className="space-y-1">
                {(preview ? units.slice(0, 2) : units).map((unit, occurrence) => (
                  // Each immutable change owns its ordered occurrences, including duplicates.
                  <li
                    key={occurrence}
                    className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${preview ? 'line-clamp-2' : ''}`}
                  >
                    {preview ? historyExcerpt(unit) : unit}
                  </li>
                ))}
              </ul>
              {preview && units.length > 2 ? <span aria-hidden="true">…</span> : null}
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function progressHistoryPreview(change: ProgressChange, occurrence: number) {
  const values = [change.amount, change.locator, change.position];
  if (!values.some((value) => value !== null) && !change.add.length && !change.remove.length) return null;
  const expandable =
    values.some((value) => value !== null && longHistoryText(value)) ||
    [change.add, change.remove].some((units) => units.length > historyUnitLimit || units.some(longHistoryText));
  if (!expandable) return <ProgressHistoryFacts change={change} />;
  return (
    <div className={historyPreviewClass}>
      <div data-history-preview>
        <ProgressHistoryFacts change={change} preview />
      </div>
      <details className="min-w-0 space-y-3">
        <summary className={historyDisclosureClass}>
          {m.library_progress_history_reader_change_details({ number: occurrence })}
        </summary>
        <ProgressHistoryFacts change={change} />
      </details>
    </div>
  );
}

function ProgressHistoryUnit({ value, occurrence }: { value: string; occurrence: number }) {
  if (!longHistoryText(value)) return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</span>;
  return (
    <div className={historyPreviewClass}>
      <p data-history-preview className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {historyExcerpt(value)}
      </p>
      <details className="min-w-0 space-y-3">
        <summary className={historyDisclosureClass}>
          {m.library_progress_history_reader_unit_details({ number: occurrence })}
        </summary>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</p>
      </details>
    </div>
  );
}

/** Read-only navigation captures this render's current authority without joining editor custody. */
function ProgressHistoryLink({
  operation,
  id,
  search,
  originating,
  children,
}: {
  operation: 'progress_session.changes' | 'progress_session.units';
  id: string;
  search: { changes?: string; units?: string; logs?: string };
  originating: ProgressDetailOrigin | undefined;
  children: ReactNode;
}) {
  const admitted = exposure.useOperation(operation);
  const locale = getLocale();
  const guard = originating?.capture?.();
  const token = {};
  const rendered = useRef(token);
  rendered.current = token;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    rendered.current === token &&
    admitted &&
    getLocale() === locale &&
    (guard ? guard.isCurrent() : !originating || originating.isCurrent());
  if (!admitted) return null;
  return (
    <Link
      to="/library/progress/$id"
      params={{ id }}
      search={search}
      preload={false}
      onClick={(event) => {
        if (!current()) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (!current()) event.preventDefault();
      }}
      className={buttonClass}
    >
      {children}
    </Link>
  );
}

export function ProgressSessionPage({
  page,
  children,
  logsCursor,
  originating,
}: {
  page: ProgressSessionPage;
  children?: ReactNode;
  logsCursor?: string | undefined;
  originating?: ProgressDetailOrigin | undefined;
}) {
  if (!page.signedIn) return null;
  return (
    <PublicationNoteDraftNavigation messages="progress">
      <SessionEditor page={page} logsCursor={logsCursor} originating={originating}>
        {children}
      </SessionEditor>
    </PublicationNoteDraftNavigation>
  );
}

function SessionEditor({
  page,
  children,
  logsCursor,
  originating,
}: {
  page: LoadedPage;
  children?: ReactNode;
  logsCursor?: string | undefined;
  originating?: ProgressDetailOrigin | undefined;
}) {
  const lifetime = useRef<EditorLifetime | null>(null);
  const draftBaseline = useRef<ProgressDraftBaseline | null>(null);
  lifetime.current ??= editorLifetime(page, originating);
  const retained = lifetime.current.custody.retry;
  const retainedRecord = retained && retained.kind !== 'finish' ? retained.data : undefined;
  const [session, setSession] = useState(page.session);
  const [seenPage, setSeenPage] = useState(page);
  const [key, setKey] = useState(retained?.data.idempotencyKey ?? page.idempotencyKey);
  const [amount, setAmount] = useState(retainedRecord?.amount ?? '');
  const [locator, setLocator] = useState(retainedRecord?.locator ?? '');
  const [position, setPosition] = useState(retainedRecord?.position ?? '');
  const [validateRecord, setValidateRecord] = useState(false);
  const [addText, setAddText] = useState(retainedRecord?.add?.join('\n') ?? '');
  const [removeText, setRemoveText] = useState(retainedRecord?.remove?.join('\n') ?? '');
  const [alert, setAlert] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(
    retained?.kind === 'finish' ? retained.data.action : null,
  );
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<CapturedIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [draftOpened, setDraftOpened] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [readDenied, setReadDenied] = useState(false);
  const completeAllowed = exposure.useOperation('progress_session.complete');
  const abandonAllowed = exposure.useOperation('progress_session.abandon');
  const offered = !unsupported && session.meaning === 'known' && session.recordingState === 'supported';
  const [phone, setPhone] = useState(false);
  const addId = useId();
  const removeId = useId();
  const addHint = useId();
  const removeHint = useId();
  const changesHeading = useId();
  const unitsHeading = useId();
  const amountHint = useId();
  const locatorError = useId();
  const amountId = useId();
  const locatorId = useId();
  const positionId = useId();
  const structureHint = useId();

  useLayoutEffect(() => {
    // Restore an identity after React's development effect cleanup/setup cycle.
    const origin = (lifetime.current ??= editorLifetime(page, originating));
    return () => {
      if (lifetime.current === origin) lifetime.current = null;
    };
  }, [originating ?? page]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px), (pointer: coarse)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const viewGuard = originating?.capture?.();
  const canEdit = () => !originating || (viewGuard ? viewGuard.isCurrent() : originating.isCurrent());
  const commandGuards = {
    record: originating?.capture?.('progress_session.record'),
    complete: originating?.capture?.('progress_session.complete'),
    abandon: originating?.capture?.('progress_session.abandon'),
  };
  const renderToken = {};
  const rendered = useRef(renderToken);
  rendered.current = renderToken;
  const canHandle = () => rendered.current === renderToken && canEdit();
  function edit(change: () => void) {
    if (canHandle()) change();
  }
  function editRecord(change: () => void) {
    if (!commandGuards.record || commandGuards.record.isCurrent()) edit(change);
  }

  function openUpdate() {
    if (!canHandle() || (commandGuards.record && !commandGuards.record.isCurrent())) return;
    const retry = lifetime.current?.custody.retry;
    const recording = retry && retry.kind !== 'finish' ? retry.data : undefined;
    if (!draftOpened) {
      const baseline = {
        amount: recording?.amount ?? session.amount ?? '',
        locator: recording?.locator ?? session.locator ?? '',
        position: recording?.position ?? session.position ?? '',
        addText: recording?.add?.join('\n') ?? '',
        removeText: recording?.remove?.join('\n') ?? '',
      };
      draftBaseline.current = baseline;
      setValidateRecord(false);
      setAmount(baseline.amount);
      setLocator(baseline.locator);
      setPosition(baseline.position);
      setAddText(baseline.addText);
      setRemoveText(baseline.removeText);
      setDraftOpened(true);
    }
    if (retry) setReview(retry);
    setEditing(true);
  }

  const originChanged = lifetime.current !== null && lifetime.current.originating !== originating;
  if (page !== seenPage || originChanged) {
    setSeenPage(page);
    if (originating && !originChanged) {
      // A current refresh reconciles revision without rebuilding an unresolved command.
      if (page.session.revision >= session.revision) setSession(page.session);
      if (lifetime.current) lifetime.current.history = null;
      setReadDenied(false);
    } else {
      // Compatible standalone pages retain their page replacement fence.
      lifetime.current = editorLifetime(page, originating);
      setUnsupported(false);
      setReadDenied(false);
      setSession(page.session);
      setKey(lifetime.current.custody.retry?.data.idempotencyKey ?? page.idempotencyKey);
      setValidateRecord(false);
      setAmount('');
      setLocator('');
      setPosition('');
      setAddText('');
      setRemoveText('');
      draftBaseline.current = null;
      setEditing(false);
      setReview(null);
      setBusy(false);
      setConflict(false);
      setDraftOpened(false);
      setAlert(null);
      setConfirming(null);
    }
  }

  function isCurrent(origin: EditorLifetime | null): origin is EditorLifetime {
    return (
      origin !== null &&
      lifetime.current === origin &&
      canEdit() &&
      origin.originating === originating &&
      (originating ? originating.isCurrent() : origin.page === page)
    );
  }

  const pendingCommand =
    lifetime.current?.custody.retry !== undefined || lifetime.current?.custody.flight !== undefined;
  const baseline = draftBaseline.current;
  const draftDirty =
    draftOpened &&
    baseline !== null &&
    session.state === 'active' &&
    offered &&
    hasUnsavedProgressDraft(session.mode, baseline, { amount, locator, position, addText, removeText });
  const stagedIntent = review !== null && !pendingCommand;
  const progressDraftDirty = () => draftDirty || stagedIntent || confirming !== null;
  const departure = usePublicationNoteDraftNavigation({
    identity: lifetime.current!,
    state: {
      active: isCurrent(lifetime.current),
      dirty: progressDraftDirty(),
      locked: pendingCommand,
    },
    getState: () => ({
      active: isCurrent(lifetime.current),
      dirty: progressDraftDirty(),
      locked: lifetime.current?.custody.flight !== undefined || lifetime.current?.custody.retry !== undefined,
    }),
    discard: () => {
      const origin = lifetime.current;
      if (!isCurrent(origin) || origin.custody.flight || origin.custody.retry) return;
      draftBaseline.current = null;
      setValidateRecord(false);
      setAmount(session.amount ?? '');
      setLocator(session.locator ?? '');
      setPosition(session.position ?? '');
      setAddText('');
      setRemoveText('');
      setDraftOpened(false);
      setEditing(false);
      setReview(null);
      setConflict(false);
      setConfirming(null);
      setAlert(null);
    },
  });
  function closeUpdate() {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin)) return;
    void departure.requestNavigation().then((stay) => {
      if (!stay && canHandle() && isCurrent(origin)) setEditing(false);
    });
  }

  function explain(reason: ProgressFailure['reason'], recording = false) {
    setAlert(progressFailureMessage(reason));
    if (reason === 'forbidden' || reason === 'closed') {
      const origin = lifetime.current;
      if (origin) {
        delete origin.custody.retry;
        delete origin.custody.credential;
      }
      draftBaseline.current = null;
      setDraftOpened(false);
      setAmount('');
      setLocator('');
      setPosition('');
      setAddText('');
      setRemoveText('');
      setReview(null);
      setConflict(false);
      setSession((current) => ({ ...current, subject: null, versionSubject: null, recordingState: 'unavailable' }));
      setEditing(false);
    }
    if (recording && reason === 'unsupported_library_profile') {
      setUnsupported(true);
      setEditing(false);
    }
  }

  async function refreshHistory(origin = lifetime.current) {
    if (!isCurrent(origin)) return;
    const request = Symbol();
    origin.history = request;
    const isLatest = () => isCurrent(origin) && origin.history === request;
    try {
      const fresh = originating
        ? await originating.refresh()
        : await readProgressSession({
            data: {
              id: session.id,
              ...(page.changesCursor ? { changes: page.changesCursor } : {}),
              ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
            },
          });
      if (!isLatest()) return;
      if (fresh.signedIn) {
        setSession((current) => (!originating || fresh.session.revision >= current.revision ? fresh.session : current));
        setReadDenied(false);
        setAlert(null);
        return fresh;
      } else {
        setReadDenied(true);
        setAlert(m.library_progress_refused());
      }
    } catch (error) {
      if (!isLatest()) return;
      if (isNotFound(error) || isPlatformClosedError(error)) {
        setReadDenied(true);
        setAlert(m.library_progress_refused());
      } else {
        setSession((current) => ({ ...current, subject: null, versionSubject: null, recordingState: 'unavailable' }));
        setAlert(m.library_progress_unavailable());
      }
      setEditing(false);
    }
  }

  async function dispatch(intent: CapturedIntent, origin: EditorLifetime) {
    const guard = commandGuards[intent.kind === 'finish' ? intent.data.action : 'record'];
    if (
      !isCurrent(origin) ||
      (guard && !guard.isCurrent()) ||
      (originating && !guard && !originating.isCurrent(true)) ||
      origin.custody.flight
    )
      return;
    const headers = guard ? guard.headers() : csrfHeaders();
    if (!headers) return;
    origin.custody.retry ??= intent;
    const captured = origin.custody.retry;
    const credential = (origin.custody.credential ??= headers);
    if (
      captured.kind !== intent.kind ||
      (captured.kind === 'finish' && intent.kind === 'finish' && captured.data.action !== intent.data.action)
    )
      return;
    setAlert(null);
    setBusy(true);
    const flight = {};
    origin.custody.flight = flight;
    const currentAttempt = () => isCurrent(origin) && origin.custody.flight === flight && (!guard || guard.isCurrent());
    origin.history = null;
    try {
      const result =
        captured.kind === 'finish'
          ? await finishProgressSession({ data: captured.data, headers: credential })
          : await recordProgressSession({ data: captured.data, headers: credential });
      // Native work may commit after retirement; its completion has no replacement UI authority.
      if (!currentAttempt()) return;
      if (!result.ok) {
        setConflict(result.reason === 'conflict');
        explain(result.reason, captured.kind !== 'finish');
        return;
      }
      if (originating && result.session.id !== originating.address.id) {
        setReadDenied(true);
        return;
      }
      delete origin.custody.retry;
      delete origin.custody.credential;
      setConflict(false);
      setReview(null);
      setDraftOpened(false);
      setKey(crypto.randomUUID());
      if (captured.kind === 'record') {
        if (captured.data.clear) {
          setAddText('');
          setRemoveText('');
        }
        setAmount('');
        setLocator('');
        setPosition('');
      }
      if (captured.kind === 'add') setAddText('');
      if (captured.kind === 'remove') setRemoveText('');
      if (captured.kind === 'finish') setConfirming(null);
      draftBaseline.current = null;
      setSession((current) =>
        !originating || result.session.revision >= current.revision
          ? applyProgressSnapshot(current, result.session)
          : current,
      );
      await refreshHistory(origin);
      if (!currentAttempt()) return;
      setEditing(false);
    } catch {
      if (!currentAttempt()) return;
      setAlert(m.library_progress_unavailable());
    } finally {
      // This physical latch belongs to the dispatched command, not an admission render.
      if (origin.custody.flight === flight) delete origin.custody.flight;
      if (isCurrent(origin)) setBusy(false);
    }
  }

  async function onRecord() {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin) || session.state !== 'active' || !offered) return;
    if (origin.custody.retry) {
      stage(origin.custody.retry);
      return;
    }
    setValidateRecord(true);
    if (session.mode === 'cursor_position') {
      if (progressLocatorIssue(locator) || progressDecimalIssue(position, session.inputRules)) return;
    } else if (progressDecimalIssue(amount, session.inputRules)) return;
    const intent =
      session.mode === 'cursor_position' ? { locator, position: position.trim() } : { amount: amount.trim() };
    stage({
      kind: 'record',
      data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, ...intent },
    });
  }

  async function onUnits(kind: 'add' | 'remove') {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin) || origin.custody.flight || session.state !== 'active' || !offered) return;
    if (origin.custody.retry) {
      if (origin.custody.retry.kind === kind) stage(origin.custody.retry);
      return;
    }
    const parsed = parseUnitBatch(kind === 'add' ? addText : removeText);
    if (!parsed.ok) {
      setAlert(parsed.reason === 'limit' ? m.library_progress_batch_limit() : m.library_progress_invalid());
      return;
    }
    stage({
      kind,
      data: {
        sessionId: session.id,
        revision: session.revision,
        idempotencyKey: key,
        ...(kind === 'add' ? { add: parsed.ids } : { remove: parsed.ids }),
      },
    });
  }

  function stage(intent: CapturedIntent) {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin) || origin.custody.flight) return;
    setReview(origin.custody.retry ?? intent);
    setEditing(true);
  }

  async function reviewLatest() {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin) || !conflict || origin.custody.flight) return;
    setBusy(true);
    const fresh = await refreshHistory(origin);
    if (!isCurrent(origin)) return;
    setBusy(false);
    if (!fresh || fresh.session.revision < session.revision) return;
    // Only an explicit conflict recovery retires the rejected operands. Uncertain retries keep them exactly.
    delete origin.custody.retry;
    delete origin.custody.credential;
    const newKey = crypto.randomUUID();
    setKey(newKey);
    setConflict(false);
    if (review?.kind === 'record' && review.data.clear) {
      setReview({ kind: 'record', data: { ...review.data, revision: fresh.session.revision, idempotencyKey: newKey } });
    } else setReview(null);
  }

  async function onFinish(action: 'complete' | 'abandon') {
    const origin = lifetime.current;
    if (!canHandle() || !isCurrent(origin) || session.state !== 'active') return;
    await dispatch(
      { kind: 'finish', data: { sessionId: session.id, action, revision: session.revision, idempotencyKey: key } },
      origin,
    );
  }

  if (readDenied) {
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <p role="alert">{m.library_progress_refused()}</p>
        <Button
          variant="outline"
          onClick={() => {
            if (canHandle()) void refreshHistory();
          }}
        >
          {m.library_progress_retry()}
        </Button>
      </article>
    );
  }

  const locatorIssue = validateRecord ? progressLocatorIssue(locator) : null;
  const ratio = rowRatio([session.subject, session.versionSubjectId ? session.versionSubject : session.subject]);
  const progress = progressView(session, getLocale());
  const currentAmount = scalarRecordingValue(session, session.amount, getLocale());
  const resultingAmount = scalarRecordingValue(session, amount, getLocale());
  const sessionTotal = scalarRecordingValue(session, session.total, getLocale());
  const progressLabel =
    session.mode === 'cursor_position' && session.position !== null && progress
      ? `${m.library_progress_position()}: ${progress.text}`
      : (progress?.text ?? m.home_continue_in_progress());
  const recordForm = (
    <Exposure operation="progress_session.record">
      <section aria-labelledby="record-progress-heading" className="space-y-4">
        <h2 id="record-progress-heading" className="text-xl font-semibold">
          {m.library_progress_record_heading()}
        </h2>
        <p className="text-lg font-medium break-words">
          {session.subject ? (
            <LibraryTitle label={session.subject.label} locale={getLocale()} />
          ) : (
            m.library_subject_unavailable()
          )}
        </p>
        {session.versionSubjectId ? (
          <p className="text-sm text-muted-foreground">
            {session.versionSubject ? (
              <LibraryTitle label={session.versionSubject.label} locale={getLocale()} />
            ) : (
              m.library_subject_unavailable()
            )}
          </p>
        ) : null}
        <p className="text-sm">
          {m.library_progress_unit()}: {session.unitLabel || m.library_progress_unit_unspecified()}
        </p>
        {session.mode === 'completed_units' || session.mode === 'cursor_position' ? (
          <p className="text-sm text-muted-foreground">{m.library_progress_structure_unverified()}</p>
        ) : null}
        {session.state !== 'active' ? <p className="text-muted-foreground">{stateLabel(session.state)}</p> : null}
        {offered && session.state === 'active' && sessionHasIndependentMeasures(session) ? (
          <IndependentMeasuresVisit
            session={session}
            credential={() => commandGuards.record?.headers() ?? csrfHeaders()}
            isCurrent={() => canHandle() && (commandGuards.record?.isCurrent() ?? true)}
            onAcknowledged={(snapshot) => {
              if (!canHandle()) return;
              setSession((current) => mergeIndependentSnapshot(current, snapshot));
              void refreshHistory();
            }}
            onRefresh={() => refreshHistory()}
            {...(logsCursor === undefined ? {} : { logsCursor })}
          />
        ) : null}
        {offered &&
        session.state === 'active' &&
        session.mode !== 'completed_units' &&
        !sessionHasIndependentMeasures(session) ? (
          <form
            className="max-w-xl space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void onRecord();
            }}
          >
            {session.mode === 'scalar_amount' ? (
              <div className="space-y-3">
                <p className="text-sm">
                  {m.library_progress_current_total({ value: currentAmount ?? m.library_progress_unrecorded() })}
                </p>
                <div className="space-y-1">
                  <label htmlFor={amountId} className="text-sm font-medium">
                    {m.library_progress_amount()}
                  </label>
                  <ProgressDecimalInput
                    id={amountId}
                    rules={session.inputRules}
                    issue={validateRecord ? progressDecimalIssue(amount, session.inputRules) : null}
                    required
                    aria-describedby={amountHint}
                    value={amount}
                    onChange={(event) => editRecord(() => setAmount(event.target.value))}
                  />
                </div>
                <p id={amountHint} className="text-sm text-muted-foreground">
                  {m.library_progress_replace_total()}
                </p>
                <p role="status" className="text-sm font-medium">
                  {resultingAmount === null
                    ? m.library_progress_total_preview_empty()
                    : m.library_progress_resulting_total({ value: resultingAmount })}
                </p>
                {sessionTotal !== null ? (
                  <p className="text-sm text-muted-foreground">
                    {m.library_progress_session_total({ value: sessionTotal })}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <label htmlFor={locatorId} className="text-sm font-medium">
                    {m.library_progress_locator()}
                  </label>
                  <Input
                    id={locatorId}
                    value={locator}
                    required
                    aria-invalid={locatorIssue ? true : undefined}
                    aria-describedby={locatorIssue ? locatorError : undefined}
                    onChange={(event) => editRecord(() => setLocator(event.target.value))}
                  />
                  <ProgressInputError id={locatorError} issue={locatorIssue} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={positionId} className="text-sm font-medium">
                    {m.library_progress_position()}
                  </label>
                  <ProgressDecimalInput
                    id={positionId}
                    rules={session.inputRules}
                    issue={validateRecord ? progressDecimalIssue(position, session.inputRules) : null}
                    required
                    value={position}
                    onChange={(event) => editRecord(() => setPosition(event.target.value))}
                  />
                </div>
              </>
            )}
            <Button type="submit">{m.library_progress_record()}</Button>
          </form>
        ) : null}
        {offered && session.state === 'active' && session.mode === 'completed_units' ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor={addId} className="text-sm font-medium">
                {m.library_progress_add_units()}
              </label>
              <Textarea
                id={addId}
                aria-describedby={addHint}
                value={addText}
                onChange={(event) => editRecord(() => setAddText(event.target.value))}
              />
              <p id={addHint} className="text-sm text-muted-foreground">
                {m.library_progress_batch_limit()}
              </p>
              <Button variant="outline" onClick={() => void onUnits('add')}>
                {m.library_progress_add_units()}
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor={removeId} className="text-sm font-medium">
                {m.library_progress_remove_units()}
              </label>
              <Textarea
                id={removeId}
                aria-describedby={removeHint}
                value={removeText}
                onChange={(event) => editRecord(() => setRemoveText(event.target.value))}
              />
              <p id={removeHint} className="text-sm text-muted-foreground">
                {m.library_progress_batch_limit()}
              </p>
              <Button variant="outline" onClick={() => void onUnits('remove')}>
                {m.library_progress_remove_units()}
              </Button>
            </div>
          </div>
        ) : null}
        {session.state === 'active' && confirming ? (
          <div className="flex flex-wrap gap-3">
            {confirming === 'complete' ? (
              <Button variant="outline" onClick={() => void onFinish('complete')}>
                {m.library_progress_confirm_complete()}
              </Button>
            ) : null}
            {confirming === 'abandon' ? (
              <Button variant="outline" onClick={() => void onFinish('abandon')}>
                {m.library_progress_confirm_abandon()}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => edit(() => setConfirming(null))}>
              {m.library_progress_cancel()}
            </Button>
          </div>
        ) : session.state !== 'active' ? (
          <p>
            <a
              href={`/${getLocale()}/library/progress?subjectId=${encodeURIComponent(session.subjectId)}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {m.library_progress_restart()}
            </a>
          </p>
        ) : null}
      </section>
    </Exposure>
  );

  const editorContent = (
    <>
      {offered ? recordForm : null}
      {review && review.kind !== 'finish' ? (
        <ProgressCorrectionReview
          data={review.data}
          busy={busy}
          conflict={conflict}
          onConfirm={() => {
            const origin = lifetime.current;
            if (canHandle() && isCurrent(origin)) void dispatch(review, origin);
          }}
          onCancel={() => edit(() => setReview(null))}
          onReload={() => void reviewLatest()}
        />
      ) : null}
    </>
  );

  return (
    <article className="max-w-4xl space-y-10 text-foreground">
      <header className="space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <div className="flex items-start gap-5 sm:gap-7">
          <div className="w-24 shrink-0 sm:w-40">
            <SubjectCover subject={session.subject} ratio={ratio} size="fill" priority />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1">
              <p className="text-2xl font-medium [overflow-wrap:anywhere] sm:text-3xl">
                {session.subject ? (
                  <Link
                    to={
                      subjectHref(
                        { id: session.subject.id, label: displayLibraryTitle(session.subject.label, getLocale()).text },
                        getLocale(),
                      ).to
                    }
                    params={
                      subjectHref(
                        { id: session.subject.id, label: displayLibraryTitle(session.subject.label, getLocale()).text },
                        getLocale(),
                      ).params
                    }
                    className="underline-offset-4 hover:underline"
                  >
                    <LibraryTitle label={session.subject.label} locale={getLocale()} />
                  </Link>
                ) : (
                  m.library_subject_unavailable()
                )}
              </p>
              {session.subject?.typeLabel ? (
                <p className="text-sm text-muted-foreground">{session.subject.typeLabel}</p>
              ) : null}
            </div>
            <p className="text-sm font-medium">
              <span data-progress-state={session.state}>{stateLabel(session.state)}</span>
            </p>
            {sessionHasIndependentMeasures(session) ? (
              <IndependentMeasuresReadout measures={projectIndependentMeasures(session)} revision={session.revision} />
            ) : (
              <ProgressRow value={progress?.percent == null ? null : progress.percent / 100} label={progressLabel} />
            )}
            {session.meaning !== 'known' ? (
              <p role="status" className="text-sm text-muted-foreground">
                {session.meaning === 'unknown' ? m.library_progress_meaning_unknown() : m.library_history_unavailable()}
              </p>
            ) : null}
            {session.mode === 'completed_units' || session.mode === 'cursor_position' ? (
              <p id={structureHint} className="text-sm text-muted-foreground">
                {m.library_progress_structure_unverified()}
              </p>
            ) : null}
            {session.mode === 'cursor_position' && session.position !== null && session.locator ? (
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <div className="space-y-1">
                  <dt className="text-muted-foreground">{m.library_progress_locator()}</dt>
                  <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{session.locator}</dd>
                </div>
              </dl>
            ) : null}
            {session.total && session.mode === 'scalar_amount' && session.amount === null ? (
              <p className="text-sm text-muted-foreground">
                {m.library_progress_total()}: {session.total}
              </p>
            ) : null}
            <details className="space-y-2 text-sm text-muted-foreground">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.library_progress_details()}
              </summary>
              <dl className="space-y-2">
                <div>
                  <dt>{m.library_progress_mode()}</dt>
                  <dd>
                    <code className="break-all">{session.mode}</code>
                  </dd>
                </div>
                <div>
                  <dt>{m.library_progress_unit()}</dt>
                  <dd>
                    <code className="break-all">{session.unit}</code>
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        </div>
        {session.versionSubjectId ? <SubjectIdentity subject={session.versionSubject} ratio={ratio} /> : null}
      </header>
      {unsupported || session.recordingState === 'unsupported' ? (
        <p role="status">{m.library_progress_no_longer_offered()}</p>
      ) : session.recordingState !== 'supported' ? (
        <div className="space-y-2">
          <p role="status">{m.library_progress_recording_unavailable()}</p>
          <Button
            variant="outline"
            onClick={() => {
              if (canHandle()) void refreshHistory();
            }}
          >
            {m.library_progress_retry()}
          </Button>
        </div>
      ) : null}
      {alert && !editing ? <p role="alert">{alert}</p> : null}
      {session.state === 'active' ? (
        <div className="flex items-center gap-2">
          {offered ? <Button onClick={openUpdate}>{m.library_progress_update()}</Button> : null}
          {completeAllowed || abandonAllowed ? (
            <Menu
              title={m.library_collection_actions()}
              trigger={
                <Button variant="ghost" className="min-h-10 px-3" aria-label={m.library_collection_actions()}>
                  {m.library_collection_actions()}
                </Button>
              }
              entries={[
                ...(completeAllowed
                  ? [
                      {
                        type: 'item' as const,
                        label: m.library_progress_complete(),
                        onSelect: () => {
                          if (canHandle() && (commandGuards.complete?.isCurrent() ?? true)) setConfirming('complete');
                        },
                      },
                    ]
                  : []),
                ...(abandonAllowed
                  ? [
                      {
                        type: 'item' as const,
                        label: m.library_progress_abandon(),
                        onSelect: () => {
                          if (canHandle() && (commandGuards.abandon?.isCurrent() ?? true)) setConfirming('abandon');
                        },
                      },
                    ]
                  : []),
              ]}
            />
          ) : null}
        </div>
      ) : null}
      {session.state === 'active' && confirming && !editing ? (
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void onFinish(confirming)}>
            {confirming === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon()}
          </Button>
          <Button variant="outline" onClick={() => edit(() => setConfirming(null))}>
            {m.library_progress_cancel()}
          </Button>
        </div>
      ) : null}
      <Exposure operation="progress_session.record">
        <Button
          variant="outline"
          onClick={() =>
            stage({
              kind: 'record',
              data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, clear: true },
            })
          }
        >
          {m.library_progress_clear()}
        </Button>
      </Exposure>
      <Exposure operation="progress_session.create">
        <section className="space-y-3">
          <Link to="/library/progress" search={{ subjectId: session.subjectId }} className={buttonClass}>
            {m.library_progress_new_session()}
          </Link>
          <p className="text-sm text-muted-foreground">{m.library_progress_new_session_scope()}</p>
        </section>
      </Exposure>
      {editing ? (
        phone ? (
          <BottomSheet
            open={editing}
            onOpenChange={(value) => (value ? edit(() => setEditing(true)) : closeUpdate())}
            title={m.library_progress_update()}
          >
            <input type="hidden" name="idempotencyKey" value={key} />
            {alert ? (
              <p role="alert" className="rounded-lg border border-border bg-card p-3">
                {alert}
              </p>
            ) : null}
            {editorContent}
          </BottomSheet>
        ) : (
          <Dialog open={editing} onOpenChange={(value) => (value ? edit(() => setEditing(true)) : closeUpdate())}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
              <DialogTitle>{m.library_progress_update()}</DialogTitle>
              <input type="hidden" name="idempotencyKey" value={key} />
              {alert ? (
                <p role="alert" className="rounded-lg border border-border bg-card p-3">
                  {alert}
                </p>
              ) : null}
              {editorContent}
            </DialogContent>
          </Dialog>
        )
      ) : null}
      <section role="region" aria-labelledby={changesHeading} className="space-y-3">
        <h2 id={changesHeading} className="text-xl font-semibold">
          {m.library_progress_changes()}
        </h2>
        {session.changes.length ? (
          <ol className="space-y-1">
            {session.changes.map((change, occurrence) => (
              <ContentItem
                key={change.id}
                headingLevel={3}
                title={
                  change.action
                    ? stateLabel(change.action === 'complete' ? 'completed' : 'abandoned')
                    : m.library_progress_change_recorded()
                }
                metadata={<RelativeTime value={change.createdAt} />}
                preview={progressHistoryPreview(change, occurrence + 1)}
              />
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">
            {page.changesCursor || session.changesNext
              ? m.library_progress_history_reader_changes_page_empty()
              : m.library_progress_changes_empty()}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {page.changesCursor ? (
            <ProgressHistoryLink
              operation="progress_session.changes"
              id={session.id}
              originating={originating}
              search={{
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
              }}
            >
              {m.library_collections_first_page()}
            </ProgressHistoryLink>
          ) : null}
          {session.changesNext ? (
            <ProgressHistoryLink
              operation="progress_session.changes"
              id={session.id}
              originating={originating}
              search={{
                changes: session.changesNext,
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
              }}
            >
              {m.library_progress_more()}
            </ProgressHistoryLink>
          ) : null}
        </div>
      </section>
      <section
        role="region"
        aria-labelledby={unitsHeading}
        aria-describedby={session.mode === 'completed_units' ? structureHint : undefined}
        className="space-y-3"
      >
        <h2 id={unitsHeading} className="text-xl font-semibold">
          {m.library_progress_units()}
        </h2>
        {session.units.length ? (
          <ul
            // Native unit rows have no IDs. Scope occurrence identity to this exact ordered page,
            // so an open disclosure cannot migrate to another record after page replacement.
            key={JSON.stringify([session.id, page.unitsCursor, session.units])}
            className="space-y-3"
          >
            {session.units.map((unit, occurrence) => (
              <li key={occurrence} className="min-w-0 py-2">
                <ProgressHistoryUnit value={unit} occurrence={occurrence + 1} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            {page.unitsCursor || session.unitsNext
              ? m.library_progress_history_reader_units_page_empty()
              : m.library_progress_units_empty()}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {page.unitsCursor ? (
            <ProgressHistoryLink
              operation="progress_session.units"
              id={session.id}
              originating={originating}
              search={{
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.changesCursor ? { changes: page.changesCursor } : {}),
              }}
            >
              {m.library_collections_first_page()}
            </ProgressHistoryLink>
          ) : null}
          {session.unitsNext ? (
            <ProgressHistoryLink
              operation="progress_session.units"
              id={session.id}
              originating={originating}
              search={{
                units: session.unitsNext,
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.changesCursor ? { changes: page.changesCursor } : {}),
              }}
            >
              {m.library_progress_more()}
            </ProgressHistoryLink>
          ) : null}
        </div>
      </section>
      {children}
    </article>
  );
}
