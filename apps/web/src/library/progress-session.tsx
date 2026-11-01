import * as exposure from '../kernel/exposure';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import type { ProgressDetail, ProgressDetailAddress } from './progress-detail-server';
import { ProgressLogs } from './logs-progress';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import type { ReactNode } from 'react';
import { RelativeTime } from './logs-progress';
import { ProgressRow } from '@rezics/ui/progress-row';
import { Button } from '@rezics/ui/shadcn/button';
import { isNotFound, Link } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@rezics/ui/menu';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import {
  parseUnitBatch,
  type ProgressFailure,
  type ProgressSessionPage,
  type ProgressState,
  type ProgressRecordInput,
  type ProgressFinishInput,
} from './progress-reads';
import { finishProgressSession, recordProgressSession, readProgressSession } from './progress-server';
import { rowRatio, SubjectCover, SubjectIdentity } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';
import { progressFailureMessage, progressView } from './progress-label';
import { scalarRecordingValue } from './progress-view';
import { isPlatformClosedError } from '../kernel/platform-closed';

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
const subscribe = () => () => {};

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

/** An originating operand is stable across token rotation and ordinary authoritative refreshes. */
export type ProgressDetailOrigin = {
  viewer: string;
  address: ProgressDetailAddress;
  isCurrent: (write?: boolean) => boolean;
  refresh: () => Promise<ProgressSessionPage>;
};

/** The route's mounted composition observes the actual session, independently of loader retention. */
export function CurrentProgressDetail({ loaded, address }: { loaded: ProgressDetail; address: ProgressDetailAddress }) {
  const observed = useSession();
  const client = useQueryClient();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const read = exposure.useOperation('progress_session.read');
  const changes = exposure.useOperation('progress_session.changes');
  const units = exposure.useOperation('progress_session.units');
  const logs = exposure.useOperation('published_log.list');
  const record = exposure.useOperation('progress_session.record');
  const complete = exposure.useOperation('progress_session.complete');
  const abandon = exposure.useOperation('progress_session.abandon');
  const publish = exposure.useOperation('published_log.create');
  const admission = [read, changes, units, logs, record, complete, abandon, publish];
  const viewer = hydrated
    ? observed.state === 'signed-in' && observed.subject
      ? observed.subject
      : null
    : loaded.viewer;
  const allowed = !hydrated || admission.slice(0, 4).every(Boolean);
  const locale = getLocale();
  const signature = JSON.stringify([
    viewer,
    address.id,
    address.changes,
    address.units,
    address.logs,
    locale,
    hydrated ? admission : null,
    hydrated && Boolean(observed.csrfToken),
  ]);
  const [instance] = useState(() => crypto.randomUUID());
  type Boundary = { signature: string; active: boolean; hydrated: boolean; epoch: number; seed?: ProgressDetail };
  const boundaryRef = useRef<Boundary | null>(null);
  const [, renderRetired] = useState(0);
  const seeded = useRef<ProgressDetail | null>(null);
  if (boundaryRef.current?.signature !== signature || !boundaryRef.current.active) {
    const previous = boundaryRef.current;
    if (previous) previous.active = false;
    const handover = previous && !previous.hydrated && hydrated;
    const seed =
      allowed && matchingDetail(loaded, viewer, address) && (loaded !== seeded.current || handover)
        ? loaded
        : undefined;
    if (seed) seeded.current = seed;
    boundaryRef.current = { signature, active: true, hydrated, epoch: (previous?.epoch ?? 0) + 1, seed };
  }
  const boundary = boundaryRef.current;
  useLayoutEffect(() => {
    boundary.active = true;
    const observe = () => {
      // Retire even an away/back identity change batched before React's next render.
      if (hydrated && viewer && allowed && boundary.active && !isCurrent()) {
        boundary.active = false;
        renderRetired((value) => value + 1);
      }
    };
    const unsubscribe = client.getQueryCache().subscribe(observe);
    observe();
    return () => {
      unsubscribe();
      boundary.active = false;
    };
  }, [boundary, client]);
  const queryKey = ['progress-detail', instance, signature, boundary.epoch] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    queryFn: () => readDetail(address, isCurrent),
    enabled: personalRead.enabled && hydrated && Boolean(viewer) && allowed,
    initialData: boundary.seed,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  function isCurrent(write = false) {
    if (boundaryRef.current !== boundary || !boundary.active || !viewer || !allowed) return false;
    if (!hydrated) return !write;
    const now = client.getQueryData(sessionQuery.queryKey);
    const groups = client.getQueryData(exposureQuery.queryKey);
    return (
      now?.state === 'signed-in' &&
      now.subject === viewer &&
      Boolean(now.csrfToken) === Boolean(observed.csrfToken) &&
      (!write || Boolean(now.csrfToken)) &&
      detailOperations.every((operation, index) => exposure.operationIsAdmitted(operation, groups) === admission[index])
    );
  }
  // The operand belongs to this admission episode, never to a response object or CSRF string.
  const originRef = useRef<{ boundary: Boundary; value: ProgressDetailOrigin } | null>(null);
  if (originRef.current?.boundary !== boundary && viewer) {
    originRef.current = {
      boundary,
      value: {
        viewer,
        address,
        isCurrent,
        refresh: async () => {
          if (!isCurrent()) return { signedIn: false, idempotencyKey: '' };
          const fresh = await readDetail(address, isCurrent);
          if (!isCurrent() || !matchingDetail(fresh, viewer, address)) return { signedIn: false, idempotencyKey: '' };
          return fresh.progress;
        },
      },
    };
  }
  let detail = matchingDetail(query.data, viewer, address) ? query.data : undefined;
  if (
    detail &&
    matchingDetail(loaded, viewer, address) &&
    loaded.progress.session.revision > detail.progress.session.revision
  )
    detail = loaded;
  if (!viewer || !allowed || !detail)
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
  originating?: ProgressDetailOrigin;
  pending: boolean;
  history: symbol | null;
  retry?: CapturedIntent;
};
const editorLifetime = (page: LoadedPage, originating?: ProgressDetailOrigin): EditorLifetime => ({
  page,
  originating,
  pending: false,
  history: null,
});

function stateLabel(state: ProgressState): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
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
  originating?: ProgressDetailOrigin;
}) {
  if (!page.signedIn) return null;
  return (
    <SessionEditor page={page} logsCursor={logsCursor} originating={originating}>
      {children}
    </SessionEditor>
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
  originating?: ProgressDetailOrigin;
}) {
  const [session, setSession] = useState(page.session);
  const [seenPage, setSeenPage] = useState(page);
  const [key, setKey] = useState(page.idempotencyKey);
  const [amount, setAmount] = useState('');
  const [locator, setLocator] = useState('');
  const [position, setPosition] = useState('');
  const [addText, setAddText] = useState('');
  const [removeText, setRemoveText] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [editing, setEditing] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [readDenied, setReadDenied] = useState(false);
  const offered = !unsupported && session.meaning === 'known' && session.recordingState === 'supported';
  const [phone, setPhone] = useState(false);
  const lifetime = useRef<EditorLifetime | null>(editorLifetime(page, originating));
  const addId = useId();
  const removeId = useId();
  const addHint = useId();
  const removeHint = useId();
  const changesHeading = useId();
  const unitsHeading = useId();
  const amountHint = useId();

  useLayoutEffect(() => {
    // Restore an identity after React's development effect cleanup/setup cycle.
    const origin = (lifetime.current ??= editorLifetime(page, originating));
    return () => {
      if (lifetime.current === origin) lifetime.current = null;
    };
  }, [originating ? originating : page]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px), (pointer: coarse)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  function openUpdate() {
    setAmount(session.amount ?? '');
    setLocator(session.locator ?? '');
    setPosition(session.position ?? '');
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
      setKey(page.idempotencyKey);
      setAmount('');
      setLocator('');
      setPosition('');
      setAddText('');
      setRemoveText('');
      setEditing(false);
      setAlert(null);
      setConfirming(null);
    }
  }

  function isCurrent(origin: EditorLifetime | null): origin is EditorLifetime {
    return (
      origin !== null &&
      lifetime.current === origin &&
      origin.originating === originating &&
      (originating ? originating.isCurrent() : origin.page === page)
    );
  }

  function explain(reason: ProgressFailure['reason'], recording = false) {
    setAlert(progressFailureMessage(reason));
    if (reason === 'forbidden' || reason === 'closed') {
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
    if (!isCurrent(origin) || (originating && !originating.isCurrent(true)) || origin.pending) return;
    origin.retry ??= intent;
    const captured = origin.retry;
    if (
      captured.kind !== intent.kind ||
      (captured.kind === 'finish' && intent.kind === 'finish' && captured.data.action !== intent.data.action)
    )
      return;
    setAlert(null);
    origin.pending = true;
    origin.history = null;
    try {
      const result =
        captured.kind === 'finish'
          ? await finishProgressSession({ data: captured.data, headers: csrfHeaders() })
          : await recordProgressSession({ data: captured.data, headers: csrfHeaders() });
      // Native work may commit after retirement; its completion has no replacement UI authority.
      if (!isCurrent(origin) || (originating && !originating.isCurrent(true))) return;
      if (!result.ok) {
        explain(result.reason, captured.kind !== 'finish');
        return;
      }
      if (originating && result.session.id !== originating.address.id) {
        setReadDenied(true);
        return;
      }
      origin.retry = undefined;
      setKey(crypto.randomUUID());
      if (captured.kind === 'record') {
        setAmount('');
        setLocator('');
        setPosition('');
      }
      if (captured.kind === 'add') setAddText('');
      if (captured.kind === 'remove') setRemoveText('');
      if (captured.kind === 'finish') setConfirming(null);
      setSession((current) =>
        !originating || result.session.revision >= current.revision ? { ...current, ...result.session } : current,
      );
      await refreshHistory(origin);
      if (!isCurrent(origin)) return;
      setEditing(false);
    } catch {
      if (!isCurrent(origin)) return;
      setAlert(m.library_progress_unavailable());
    } finally {
      if (isCurrent(origin)) origin.pending = false;
    }
  }

  async function onRecord() {
    const origin = lifetime.current;
    if (!isCurrent(origin) || session.state !== 'active' || !offered) return;
    const intent =
      session.mode === 'cursor_position' ? { locator, position: position.trim() } : { amount: amount.trim() };
    await dispatch(
      { kind: 'record', data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, ...intent } },
      origin,
    );
  }

  async function onUnits(kind: 'add' | 'remove') {
    const origin = lifetime.current;
    if (!isCurrent(origin) || origin.pending || session.state !== 'active' || !offered) return;
    if (origin.retry) {
      if (origin.retry.kind === kind) await dispatch(origin.retry, origin);
      return;
    }
    const parsed = parseUnitBatch(kind === 'add' ? addText : removeText);
    if (!parsed.ok) {
      setAlert(parsed.reason === 'limit' ? m.library_progress_batch_limit() : m.library_progress_invalid());
      return;
    }
    await dispatch(
      {
        kind,
        data: {
          sessionId: session.id,
          revision: session.revision,
          idempotencyKey: key,
          ...(kind === 'add' ? { add: parsed.ids } : { remove: parsed.ids }),
        },
      },
      origin,
    );
  }

  async function onFinish(action: 'complete' | 'abandon') {
    const origin = lifetime.current;
    if (!isCurrent(origin) || session.state !== 'active') return;
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
        <Button variant="outline" onClick={() => void refreshHistory()}>
          {m.library_progress_retry()}
        </Button>
      </article>
    );
  }

  const { min, max, step } = session.inputRules ?? {};
  const inputBounds = { min, max, step: step ?? 'any' };
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
        {session.state !== 'active' ? <p className="text-muted-foreground">{stateLabel(session.state)}</p> : null}
        {offered && session.state === 'active' && session.mode !== 'completed_units' ? (
          <form
            className="max-w-xl space-y-4"
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
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{m.library_progress_amount()}</span>
                  <Input
                    type="number"
                    {...inputBounds}
                    aria-describedby={amountHint}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
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
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{m.library_progress_locator()}</span>
                  <Input value={locator} onChange={(event) => setLocator(event.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{m.library_progress_position()}</span>
                  <Input
                    type="number"
                    {...inputBounds}
                    value={position}
                    onChange={(event) => setPosition(event.target.value)}
                  />
                </label>
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
                onChange={(event) => setAddText(event.target.value)}
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
                onChange={(event) => setRemoveText(event.target.value)}
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
            <Button variant="outline" onClick={() => setConfirming(null)}>
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
              <p className="text-2xl font-medium sm:text-3xl">
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
            <p className="text-sm text-muted-foreground">
              <span data-progress-state={session.state}>{stateLabel(session.state)}</span>
            </p>
            <ProgressRow value={progress?.percent == null ? null : progress.percent / 100} label={progressLabel} />
            {session.mode === 'cursor_position' && session.position !== null && session.locator ? (
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <div className="space-y-1">
                  <dt className="text-muted-foreground">{m.library_progress_locator()}</dt>
                  <dd className="break-words">{session.locator}</dd>
                </div>
              </dl>
            ) : null}
            {session.total && session.mode === 'scalar_amount' && session.amount === null ? (
              <p className="text-sm text-muted-foreground">
                {m.library_progress_total()}: {session.total}
              </p>
            ) : null}
          </div>
        </div>
        {session.versionSubjectId ? <SubjectIdentity subject={session.versionSubject} ratio={ratio} /> : null}
      </header>
      {session.meaning !== 'known' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {session.meaning === 'unknown' ? m.library_progress_meaning_unknown() : m.library_history_unavailable()}
        </p>
      ) : null}
      <details className="space-y-2 text-sm text-muted-foreground">
        <summary className="cursor-pointer">{m.library_progress_details()}</summary>
        <p>
          {m.library_progress_mode()} / {m.library_progress_unit()}:{' '}
          <code className="break-all">
            {session.mode} / {session.unit}
          </code>
        </p>
      </details>
      {session.mode === 'completed_units' || session.mode === 'cursor_position' ? (
        <p className="text-sm text-muted-foreground">{m.library_progress_structure_unverified()}</p>
      ) : null}
      {unsupported || session.recordingState === 'unsupported' ? (
        <p role="status">{m.library_progress_no_longer_offered()}</p>
      ) : session.recordingState !== 'supported' ? (
        <div className="space-y-2">
          <p role="status">{m.library_progress_recording_unavailable()}</p>
          <Button variant="outline" onClick={() => void refreshHistory()}>
            {m.library_progress_retry()}
          </Button>
        </div>
      ) : null}
      {alert && !editing ? <p role="alert">{alert}</p> : null}
      {session.state === 'active' ? (
        <div className="flex items-center gap-2">
          {offered ? <Button onClick={openUpdate}>{m.library_progress_update()}</Button> : null}
          <Exposure operation="progress_session.complete">
            <Menu
              title={m.library_collection_actions()}
              trigger={
                <Button variant="ghost" className="min-h-10 px-3" aria-label={m.library_collection_actions()}>
                  {m.library_collection_actions()}
                </Button>
              }
              entries={[
                { type: 'item', label: m.library_progress_complete(), onSelect: () => setConfirming('complete') },
                { type: 'item', label: m.library_progress_abandon(), onSelect: () => setConfirming('abandon') },
              ]}
            />
          </Exposure>
        </div>
      ) : null}
      {session.state === 'active' && confirming && !editing ? (
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void onFinish(confirming)}>
            {confirming === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon()}
          </Button>
          <Button variant="outline" onClick={() => setConfirming(null)}>
            {m.library_progress_cancel()}
          </Button>
        </div>
      ) : null}
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
          <BottomSheet open={editing} onOpenChange={setEditing} title={m.library_progress_update()}>
            <input type="hidden" name="idempotencyKey" value={key} />
            {alert ? (
              <p role="alert" className="rounded-lg border border-border bg-card p-3">
                {alert}
              </p>
            ) : null}
            {offered ? recordForm : null}
          </BottomSheet>
        ) : (
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
              <DialogTitle>{m.library_progress_update()}</DialogTitle>
              <input type="hidden" name="idempotencyKey" value={key} />
              {alert ? (
                <p role="alert" className="rounded-lg border border-border bg-card p-3">
                  {alert}
                </p>
              ) : null}
              {offered ? recordForm : null}
            </DialogContent>
          </Dialog>
        )
      ) : null}
      <section role="region" aria-labelledby={changesHeading} className="space-y-3">
        <h2 id={changesHeading} className="text-xl font-semibold">
          {m.library_progress_changes()}
        </h2>
        {session.changes.length ? (
          <ol className="space-y-3">
            {session.changes.map((change) => (
              <ListRow key={change.id} className="py-3">
                <div className="mb-2 text-sm text-muted-foreground">
                  <RelativeTime value={change.createdAt} />
                </div>
                {change.action ? (
                  <p>{stateLabel(change.action === 'complete' ? 'completed' : 'abandoned')}</p>
                ) : (
                  <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                    {[
                      [m.library_progress_amount(), change.amount],
                      [m.library_progress_locator(), change.locator],
                      [m.library_progress_position(), change.position],
                      [m.library_progress_add_units(), change.add.join(', ')],
                      [m.library_progress_remove_units(), change.remove.join(', ')],
                    ]
                      .filter(([, value]) => value != null && value !== '')
                      .map(([label, value]) => (
                        <div key={label} className="space-y-1">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-words">{value}</dd>
                        </div>
                      ))}
                  </dl>
                )}
              </ListRow>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_changes_empty()}</p>
        )}
        {session.changesNext ? (
          <Exposure operation="progress_session.changes">
            <Link
              to="/library/progress/$id"
              params={{ id: session.id }}
              search={{
                changes: session.changesNext,
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
              }}
              className={buttonClass}
            >
              {m.library_progress_more()}
            </Link>
          </Exposure>
        ) : null}
      </section>
      <section role="region" aria-labelledby={unitsHeading} className="space-y-3">
        <h2 id={unitsHeading} className="text-xl font-semibold">
          {m.library_progress_units()}
        </h2>
        {session.units.length ? (
          <ul className="space-y-3">
            {session.units.map((unit) => (
              <ListRow key={unit} className="py-2">
                {unit}
              </ListRow>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_units_empty()}</p>
        )}
        {session.unitsNext ? (
          <Exposure operation="progress_session.units">
            <Link
              to="/library/progress/$id"
              params={{ id: session.id }}
              search={{
                units: session.unitsNext,
                ...(logsCursor ? { logs: logsCursor } : {}),
                ...(page.changesCursor ? { changes: page.changesCursor } : {}),
              }}
              className={buttonClass}
            >
              {m.library_progress_more()}
            </Link>
          </Exposure>
        ) : null}
      </section>
      {children}
    </article>
  );
}
