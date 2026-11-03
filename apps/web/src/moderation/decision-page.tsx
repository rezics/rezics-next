import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowUpRight, Check, FileText, ShieldCheck } from 'lucide-react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { QueryClientContext } from '@tanstack/react-query';
import { createPrivateReaderLifetime, type PrivateReaderNavigation } from './private-reader-lifetime';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import { appealDecision, type AppealSubmission, type DecisionAppealReadback } from './appeal';
import { createDecisionAppealIntent, type DecisionAppealIntent } from './command-intent';
import { useSession } from '../session/query';
import {
  decisionReadFailure,
  decisionReadKey,
  prepareDecisionRead,
  sameDecision,
  sameDecisionObservation,
  type DecisionReadState,
} from './decision-read-model';
import { type DecisionPage, readDecisionPage } from './decision-read';

function relativeTime(instant: string, now: number, locale: string) {
  const delta = Date.parse(instant) - now;
  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ] as const;
  for (const [unit, size] of units) {
    if (Math.abs(delta) >= size || unit === 'minute')
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(delta / size), unit);
  }
  return '';
}

export function DecisionTime({
  instant,
  now,
  locale = getLocale(),
}: {
  instant: string;
  now: number;
  locale?: string;
}) {
  const date = new Date(instant);
  return (
    <time dateTime={instant}>
      {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(date)}{' '}
      <span className="text-muted-foreground">({relativeTime(instant, now, locale)})</span>
    </time>
  );
}

export type DecisionAppealAction = (input: DecisionAppealIntent) => Promise<AppealSubmission>;
export type DecisionPageProps = {
  page: DecisionPage;
  now?: number;
  onAppeal?: DecisionAppealAction;
  onRefresh?: (id: string) => Promise<DecisionPage>;
  navigation?: PrivateReaderNavigation;
  isCurrent?: () => boolean;
  canCommand?: () => boolean;
  accepts?: (page: DecisionPage) => Promise<boolean>;
};
const sendAppeal: DecisionAppealAction = ({ credentials, ...data }) =>
  appealDecision({ data, headers: credentials });
const refreshDecision = (id: string) => readDecisionPage({ data: { id } });
type Feedback = 'denied' | 'conflict' | 'uncertain' | 'invalid' | 'refused';

/** No private content or native problem details appear in a loading/failed current read. */
export function DecisionReadStatus({
  state,
  onRetry,
  busy = false,
}: {
  state: DecisionReadState;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <article className="mx-auto w-full max-w-4xl space-y-5 py-4" aria-labelledby="decision-read-heading">
      <h1 id="decision-read-heading" className="font-display text-3xl font-semibold">
        {m.decision_heading()}
      </h1>
      <p role={state === 'loading' ? 'status' : 'alert'} aria-busy={state === 'loading' || busy}>
        {state === 'loading'
          ? m.moderation_decision_read_loading()
          : state === 'closed'
            ? m.moderation_decision_read_closed()
            : state === 'platform-closed'
              ? m.moderation_decision_read_platform_closed()
              : m.moderation_decision_read_unavailable()}
      </p>
      {state !== 'loading' && state !== 'platform-closed' && onRetry ? (
        <Button variant="outline" className="min-h-11" disabled={busy} onClick={onRetry}>
          {m.moderation_decision_read_retry()}
        </Button>
      ) : null}
    </article>
  );
}

/** Existing explicitly injected fixture pairs do not acquire browser production authority. */
export function DecisionPageView(props: DecisionPageProps) {
  return (
    <AuthoringDepartureBoundary
      sessionBound={false}
      navigationMessages={{
        title: m.decision_appeal_leave_title(),
        unsaved: m.decision_appeal_leave_unsaved(),
        pending: m.decision_appeal_leave_pending(),
        discardTitle: m.decision_appeal_discard_title(),
        discardUnsaved: m.decision_appeal_discard_unsaved(),
        discardPending: m.decision_appeal_discard_pending(),
        discardAction: m.decision_appeal_discard(),
      }}
    >
      {props.onAppeal && props.onRefresh ? <DecisionFixture {...props} /> : <DecisionSessionPage {...props} />}
    </AuthoringDepartureBoundary>
  );
}

function DecisionFixture(props: DecisionPageProps) {
  const [source, setSource] = useState({ page: props.page, revision: 0 });
  if (source.page !== props.page) {
    setSource({ page: props.page, revision: source.revision + 1 });
    return null;
  }
  return <DecisionVisit key={source.revision} {...props} />;
}

const emptySubscribe = () => () => {};
const zeroSnapshot = () => 0;

function DecisionSessionPage(props: DecisionPageProps) {
  return (
    <DecisionBoundPage
      key={`${props.page.readGeneration ?? props.page.decision.id}:${props.page.nativeSourceFingerprint}`}
      {...props}
    />
  );
}

function DecisionBoundPage(props: DecisionPageProps) {
  // Initialize the existing imperative token from the real session hook; admission uses the exact cache source.
  useSession();
  const client = useContext(QueryClientContext);
  const original = useRef({
    now: props.now,
    onAppeal: props.onAppeal,
    onRefresh: props.onRefresh,
    navigation: props.navigation,
    isCurrent: props.isCurrent,
    canCommand: props.canCommand,
    accepts: props.accepts,
  }).current;
  const originalDecision = useRef({
    id: props.page.decision.id,
    targetKind: props.page.decision.targetKind,
    targetId: props.page.decision.targetId,
    nativeSourceFingerprint: props.page.nativeSourceFingerprint,
    viewerId: props.page.viewerId,
  }).current;
  const originalLocale = useRef(getLocale()).current;
  const [page, setPage] = useState<DecisionPage | null>(props.page);
  const departed = useRef(false);
  const [owner, setOwner] = useState(() =>
    client && typeof window !== 'undefined'
      ? createPrivateReaderLifetime(client, props.page, decisionReadKey(props.page.decision.id), props.navigation)
      : null,
  );
  const originalClient = useRef(client).current;
  const [retiredReadState, setRetiredReadState] = useState<DecisionReadState | null>(null);
  const ownerSnapshot = useSyncExternalStore(owner?.subscribe ?? emptySubscribe, owner?.snapshot ?? zeroSnapshot, zeroSnapshot);
  useEffect(() => {
    if (owner && (!owner.healthy() || !owner.available())) setPage(null);
  }, [owner, ownerSnapshot]);
  if (
    client !== originalClient ||
    props.navigation !== original.navigation ||
    props.onRefresh !== original.onRefresh ||
    props.onAppeal !== original.onAppeal ||
    getLocale() !== originalLocale ||
    props.page.decision.id !== originalDecision.id ||
    props.page.decision.targetKind !== originalDecision.targetKind ||
    props.page.decision.targetId !== originalDecision.targetId ||
    props.page.nativeSourceFingerprint !== originalDecision.nativeSourceFingerprint ||
    props.page.viewerId !== originalDecision.viewerId
  )
    owner?.retire();
  if (typeof window !== 'undefined' && !client) return <DecisionReadStatus state="closed" />;
  if (departed.current) return <DecisionReadStatus state="closed" />;
  if (owner && (!owner.healthy() || !owner.available())) {
    return (
      <DecisionFreshRecovery
        key={page?.readGeneration ?? originalDecision.id}
        state={retiredReadState ?? (owner.healthy() ? 'unavailable' : 'closed')}
        original={originalDecision}
        read={original.onRefresh ?? refreshDecision}
        allowed={() => !departed.current && client === originalClient && owner.canRecover()}
        prepare={(id, read) => prepareDecisionRead(client!, id, read)}
        onAdmit={(next) => {
          if (departed.current) return;
          owner.retire();
          setRetiredReadState(null);
          setOwner(createPrivateReaderLifetime(client!, next, decisionReadKey(next.decision.id), original.navigation));
          setPage(next);
        }}
      />
    );
  }
  if (!page) return <DecisionReadStatus state="closed" />;
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a') && owner && (!owner.isCurrent() || !owner.available()))
          event.preventDefault();
      }}
    >
      <DecisionVisit
        key={`${page.readGeneration ?? 'presenter'}:${page.nativeSourceFingerprint}`}
        {...original}
        page={page}
        {...(owner
          ? {
              isCurrent: owner.isCurrent,
              canCommand: owner.canCommand,
              accepts: owner.accepts,
              adopt: (next) => setPage({ ...next, readGeneration: page.readGeneration }),
              replace: (state: DecisionReadState = 'closed') => {
                setPage(null);
                setRetiredReadState(state);
                owner.retire();
              },
              retire: () => {
                departed.current = true;
                setPage(null);
                owner.retire();
              },
            }
          : {})}
      />
    </div>
  );
}

/** Explicit fresh read creates a new observation; the retired owner never borrows it. */
function DecisionFreshRecovery({
  state: initial,
  original,
  read,
  prepare,
  allowed,
  onAdmit,
}: {
  state: DecisionReadState;
  original: Pick<DecisionPage['decision'], 'id' | 'targetKind' | 'targetId'>;
  read: (id: string) => Promise<DecisionPage>;
  prepare: (id: string, read: (id: string) => Promise<DecisionPage>) => Promise<DecisionPage>;
  allowed: () => boolean;
  onAdmit: (page: DecisionPage) => void;
}) {
  const [state, setState] = useState(initial);
  const connection = useRef({ active: true, serial: 0 });
  const pending = useRef(false);
  useEffect(() => {
    connection.current.active = true;
    return () => {
      connection.current.active = false;
      connection.current.serial++;
    };
  }, []);
  async function retry() {
    if (pending.current || !connection.current.active || !allowed()) return;
    pending.current = true;
    const ticket = connection.current.serial;
    const current = () => connection.current.active && ticket === connection.current.serial && allowed();
    setState('loading');
    try {
      const next = await prepare(original.id, read);
      if (!current()) return;
      if (
        next.decision.id !== original.id ||
        next.decision.targetKind !== original.targetKind ||
        next.decision.targetId !== original.targetId
      )
        setState('closed');
      else onAdmit(next);
    } catch (error) {
      if (current()) setState(decisionReadFailure(error));
    } finally {
      if (current()) pending.current = false;
    }
  }
  return <DecisionReadStatus state={state} onRetry={() => void retry()} />;
}

/** Native reads and commands remain the only outcome authority; this state lives for one admitted visit. */
function DecisionVisit({
  page,
  now = Date.now(),
  onAppeal = sendAppeal,
  onRefresh = refreshDecision,
  isCurrent = () => true,
  canCommand = () => true,
  accepts,
  adopt,
  retire,
  replace,
}: DecisionPageProps & {
  adopt?: (page: DecisionPage) => void;
  retire?: () => void;
  replace?: (state?: DecisionReadState) => void;
}) {
  const [current, setCurrent] = useState<DecisionPage | null>(page);
  const confirmedAppeal = useRef(page.decision.appeal ? page.decision : null);
  const [readState, setReadState] = useState<DecisionReadState>('unavailable');
  const [composition] = useState(createDecisionAppealIntent);
  const [, redraw] = useState(0);
  const text = composition.text;
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [readback, setReadback] = useState<DecisionAppealReadback | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = sending || refreshing;
  const pending = useRef(false);
  const reading = useRef(false);
  const lifetime = useRef({ active: true, retired: false, serial: 0, readSerial: 0 });
  const outcomeFocus = useRef<{
    serial: number;
    decision: DecisionPage['decision'];
    nativeSourceFingerprint: string;
    control: HTMLButtonElement;
  } | null>(null);
  const keyboardActivation = useRef<HTMLButtonElement | null>(null);
  const keyboardClick = useRef<HTMLButtonElement | null>(null);
  const pendingOutcome = useRef<HTMLParagraphElement | null>(null);
  const clearOutcomeFocus = () => {
    outcomeFocus.current = null;
  };
  function leave() {
    lifetime.current.retired = true;
    lifetime.current.active = false;
    lifetime.current.serial++;
    lifetime.current.readSerial++;
    clearOutcomeFocus();
    composition.discard();
    setAcknowledged(false);
    setReadback(null);
    retire?.();
  }
  function discard() {
    // Forget local recovery without claiming that the native request was cancelled.
    lifetime.current.serial++;
    clearOutcomeFocus();
    pending.current = false;
    composition.discard();
    setSending(false);
    setFeedback(null);
    redraw((value) => value + 1);
  }
  const active = () => lifetime.current.active && !lifetime.current.retired && isCurrent();
  useEffect(() => {
    const cancel = () => {
      clearOutcomeFocus();
      keyboardActivation.current = null;
      keyboardClick.current = null;
    };
    const focusMoved = (event: FocusEvent) => {
      const pending = outcomeFocus.current;
      if (
        pending &&
        event.target !== pending.control &&
        !(event.target === pending.control.ownerDocument.body && !pending.control.isConnected)
      )
        clearOutcomeFocus();
    };
    const focusLeft = (event: FocusEvent) => {
      const pending = outcomeFocus.current;
      if (pending && event.target === pending.control)
        queueMicrotask(() => {
          if (outcomeFocus.current === pending && pending.control.isConnected) clearOutcomeFocus();
        });
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', focusMoved, true);
    document.addEventListener('focusout', focusLeft, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', focusMoved, true);
      document.removeEventListener('focusout', focusLeft, true);
      clearOutcomeFocus();
    };
  }, []);
  const departure = useAuthoringDeparture(
    () => active() && composition.needsDecision,
    () => active() && composition.unresolved,
    JSON.stringify([decisionIdentity(page), text, sending, composition.unresolved]),
    discard,
    leave,
  );
  useEffect(() => {
    lifetime.current.active = !lifetime.current.retired;
    return () => {
      lifetime.current.active = false;
      lifetime.current.serial++;
      lifetime.current.readSerial++;
      // StrictMode may reconnect synchronously; async work is fenced immediately.
      queueMicrotask(() => {
        if (!lifetime.current.active) composition.discard();
      });
    };
  }, [composition]);
  const displayed = current ?? page;
  const { decision } = displayed;
  const context = decision.targetContext;
  const targetKind = m.decision_target_fallback({ kind: decision.targetKind });
  const locale = getLocale();
  const nativeAdvice = decision.viewer.appeal;
  const deadlineOpen = decision.appealDeadline !== null && now <= Date.parse(decision.appealDeadline);
  const allowed =
    !acknowledged &&
    !decision.appeal &&
    nativeAdvice.state === 'permitted' &&
    deadlineOpen &&
    canCommand();
  const adviceMessage =
    nativeAdvice.state === 'unsupported'
      ? m.decision_appeal_unsupported()
      : nativeAdvice.state === 'unavailable'
        ? nativeAdvice.reason === 'not_affected_author'
          ? m.decision_author_only()
          : nativeAdvice.reason === 'already_appealed'
            ? m.decision_appeal_already()
            : nativeAdvice.reason === 'deadline_passed'
              ? m.decision_appeal_expired()
              : m.decision_appeal_advice_unavailable()
        : !deadlineOpen
          ? m.decision_appeal_expired()
          : !canCommand()
            ? m.decision_appeal_advice_unavailable()
            : null;
  const count = Array.from(text).length;
  const locked = Boolean(feedback && feedback !== 'invalid');
  const appeal = decision.appeal;
  const outcome =
    appeal?.outcome === 'reversed'
      ? m.decision_appeal_reversed()
      : appeal?.outcome === 'upheld'
        ? m.decision_appeal_upheld()
        : appeal
          ? m.decision_status_pending()
          : m.decision_status_taken_down();
  const feedbackText =
    feedback === 'denied'
      ? m.decision_appeal_denied()
      : feedback === 'conflict'
        ? m.decision_appeal_conflict()
        : feedback === 'uncertain'
          ? m.decision_appeal_uncertain()
          : feedback === 'invalid'
            ? m.decision_appeal_too_long()
            : m.decision_appeal_refused();
  const readbackDecision = readback?.state === 'available' ? readback.decision : null;
  const readbackAppeal = readbackDecision?.appeal ?? null;
  const readbackStatus = readbackAppeal?.outcome === 'reversed'
    ? m.decision_appeal_reversed()
    : readbackAppeal?.outcome === 'upheld'
      ? m.decision_appeal_upheld()
      : readbackAppeal
        ? m.decision_status_pending()
        : m.decision_status_taken_down();
  const contextHref =
    context.state !== 'available'
      ? null
      : context.kind === 'board'
        ? `/boards/${encodeURIComponent(context.boardId)}`
        : `/threads/${encodeURIComponent(context.threadId)}${context.postId ? `#${encodeURIComponent(context.postId)}` : ''}`;
  const contextTitle =
    context.state !== 'available'
      ? null
      : context.kind === 'board'
        ? context.boardTitle
        : context.threadTitle;

  useEffect(() => {
    const pending = outcomeFocus.current;
    if (!pending) return;
    if (
      !active() ||
      pending.serial !== lifetime.current.serial ||
      !sameDecision(pending.decision, decision) ||
      pending.nativeSourceFingerprint !== displayed.nativeSourceFingerprint
    ) {
      clearOutcomeFocus();
      return;
    }
    if (!appeal || appeal.outcome !== null) {
      if (appeal) clearOutcomeFocus();
      return;
    }
    const summary = pendingOutcome.current;
    if (!summary) return;
    const activeElement = summary.ownerDocument.activeElement;
    if (
      pending.control.isConnected ||
      (activeElement !== pending.control && activeElement !== summary.ownerDocument.body)
    ) {
      clearOutcomeFocus();
      return;
    }
    clearOutcomeFocus();
    summary.focus();
  }, [current]);

  async function submit(retry = false, keyboardControl: HTMLButtonElement | null = null) {
    if (!active() || !canCommand() || pending.current || (!retry && (locked || !allowed || count < 1 || count > 2000)))
      return;
    if (retry && (feedback !== 'uncertain' || !composition.unresolved)) return;
    const token = ++lifetime.current.serial;
    const command = retry
      ? composition.retry()!
      : composition.freeze(
          decision.id,
          Object.fromEntries(new Headers(csrfHeaders()).entries()),
        );
    outcomeFocus.current =
      keyboardControl && document.activeElement === keyboardControl && !decision.appeal
        ? { serial: token, decision, nativeSourceFingerprint: page.nativeSourceFingerprint, control: keyboardControl }
        : null;
    pending.current = true;
    setSending(true);
    setFeedback(null);
    try {
      if (!active() || !canCommand()) return;
      const result = await onAppeal(command);
      if (!active() || lifetime.current.serial !== token) return;
      if (composition.retry() !== command) return;
      if (result.state === 'acknowledged' || result.state === 'conflict') {
        setReadback(result.readback);
        if (
          result.readback.state === 'available' &&
          result.readback.nativeSourceFingerprint !== page.nativeSourceFingerprint
        ) {
          setCurrent(null);
          setReadState('closed');
          setAcknowledged(false);
          setReadback(null);
          discard();
          replace?.('closed');
          return;
        }
        if (result.readback.state === 'available') {
          const refreshed = { ...page, decision: result.readback.decision };
          setCurrent(refreshed);
          adopt?.(refreshed);
        }
        if (result.state === 'acknowledged') {
          composition.settle(true);
          setAcknowledged(true);
          setFeedback(null);
        } else {
          composition.settle();
          setFeedback('conflict');
        }
      } else {
        if (result.state !== 'failed') composition.settle();
        setFeedback(result.state === 'failed' ? 'uncertain' : result.state);
      }
    } catch {
      if (active() && lifetime.current.serial === token) setFeedback('uncertain');
    } finally {
      if (active() && lifetime.current.serial === token) {
        pending.current = false;
        setSending(false);
      }
    }
  }

  async function refresh() {
    if (!active() || reading.current) return;
    const token = ++lifetime.current.readSerial;
    reading.current = true;
    setRefreshing(true);
    if (!current) setReadState('loading');
    setReadback(null);
    try {
      const next = await onRefresh(decision.id);
      if (!active() || lifetime.current.readSerial !== token) return;
      if (
        !sameDecisionObservation(next, page) ||
        next.viewerId !== page.viewerId ||
        (accepts ? !(await accepts(next)) : next.sessionEpoch !== page.sessionEpoch)
      ) {
        setCurrent(null);
        setReadState('closed');
        confirmedAppeal.current = null;
        setAcknowledged(false);
        setReadback(null);
        discard();
        replace?.('closed');
        return;
      }
      if (!active() || lifetime.current.readSerial !== token) return;
      const admitted = { ...next, readGeneration: page.readGeneration };
      setCurrent(admitted);
      adopt?.(admitted);
      if (!composition.unresolved) setFeedback(null);
    } catch (error) {
      if (active() && lifetime.current.readSerial === token) {
        const state = decisionReadFailure(error);
        setCurrent(null);
        setReadState(state);
        if (state !== 'unavailable') {
          confirmedAppeal.current = null;
          setAcknowledged(false);
          setReadback(null);
          discard();
          replace?.(state);
        }
      }
    } finally {
      if (active() && lifetime.current.readSerial === token) {
        reading.current = false;
        setRefreshing(false);
      }
    }
  }

  if (!current) return <DecisionReadStatus state={readState} busy={busy} onRetry={() => void refresh()} />;

  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-7 py-1 sm:py-4"
      aria-labelledby="decision-heading"
      aria-busy={busy}
      onKeyDownCapture={(event) => {
        const target = event.target;
        keyboardActivation.current =
          target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ') ? target : null;
      }}
      onClickCapture={(event) => {
        const target = event.target;
        keyboardClick.current =
          target instanceof HTMLButtonElement && keyboardActivation.current === target ? target : null;
        keyboardActivation.current = null;
      }}
      onPointerDownCapture={() => {
        keyboardActivation.current = null;
        keyboardClick.current = null;
        clearOutcomeFocus();
      }}
    >
      <header className="space-y-5">
        <a
          href={localizeHref('/inbox')}
          className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {m.decision_back()}
        </a>
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              {m.decision_eyebrow()}
            </p>
            <h1 id="decision-heading" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              {m.decision_heading()}
            </h1>
          </div>
        </div>
        <ContentItemFrame as="div" className="p-5 sm:p-6" role="status">
          <ContentItemHeading level={2} className="text-xs font-medium text-muted-foreground">
            {m.decision_current_outcome()}
          </ContentItemHeading>
          <p className="mt-2 text-xl font-semibold tracking-tight">{outcome}</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {appeal ? m.decision_outcome_independent() : m.decision_original_effect()}
          </p>
        </ContentItemFrame>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-4" aria-labelledby="decision-reasons">
          <ContentItemHeading
            id="decision-reasons"
            level={2}
            className="flex items-center gap-2 text-base font-semibold"
          >
            <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
            {m.decision_original_heading()}
          </ContentItemHeading>
          <ContentItemFrame as="div" className="p-5 sm:p-6">
            <p className="text-xs font-medium text-muted-foreground">{m.decision_original_action()}</p>
            <ContentItemHeading level={3} className="mt-5 text-sm font-semibold">
              {m.decision_reasons_heading()}
            </ContentItemHeading>
            <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-7">{decision.statement}</p>
            <p className="mt-5 border-t border-border pt-4 text-xs leading-6 text-muted-foreground">
              {m.decision_decided_label()} <DecisionTime instant={decision.decidedAt} now={now} locale={locale} />
            </p>
          </ContentItemFrame>
        </section>
        <section className="min-w-0 space-y-4" aria-labelledby="decision-applies">
          <ContentItemHeading id="decision-applies" level={2} className="text-base font-semibold">
            {m.decision_current_target()}
          </ContentItemHeading>
          <ContentItemFrame as="div" className="p-5 sm:p-6">
            <Badge variant="outline">{targetKind}</Badge>
            {context.state === 'available' && contextHref ? (
              <>
                <p className="text-sm font-medium">{m.decision_target_available()}</p>
                <a
                  href={localizeHref(contextHref)}
                  className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 text-sm font-medium underline underline-offset-4"
                >
                  <span className="line-clamp-3 wrap-anywhere">
                    {contextTitle || m.decision_target_fallback({ kind: decision.targetKind })}
                  </span>
                  <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
                </a>
                {context.kind === 'thread' && context.boardTitle ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {m.decision_target_fallback({ kind: 'board' })}: {context.boardTitle}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {context.state === 'concealed' ? m.decision_target_concealed() : m.decision_target_context_unavailable()}
              </p>
            )}
            <p className="mt-3 text-xs leading-6 text-muted-foreground">{m.decision_target_independent()}</p>
            <Button className="mt-4 min-h-11" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? m.decision_refreshing() : m.decision_refresh()}
            </Button>
          </ContentItemFrame>
        </section>
      </div>
      <section className="min-w-0" aria-labelledby="decision-appeal">
        <ContentItemFrame as="div" className="p-5 sm:p-6">
          <ContentItemHeading id="decision-appeal" level={2} className="text-lg font-semibold">
            {m.decision_appeal_heading()}
          </ContentItemHeading>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{m.decision_appeal_explanation()}</p>
          {decision.appealDeadline ? (
            <dl className="mt-5 border-y border-border py-4 text-sm leading-6 sm:flex sm:gap-6">
              <dt className="font-medium">{m.decision_deadline_label()}</dt>
              <dd className="mt-1 text-muted-foreground sm:mt-0">
                <DecisionTime instant={decision.appealDeadline} now={now} locale={locale} />
              </dd>
            </dl>
          ) : null}
          {appeal ? (
            <div className="mt-5 space-y-3">
              <p
                ref={appeal.outcome ? null : pendingOutcome}
                tabIndex={appeal.outcome ? undefined : -1}
                className="flex items-center gap-2 font-medium"
              >
                <Check className="size-4 text-primary" aria-hidden="true" />
                {appeal.outcome ? m.decision_review_heading() : m.decision_appeal_pending()}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                {appeal.outcome ? m.decision_review_explanation() : m.decision_pending_explanation()}
              </p>
              {appeal.outcome && appeal.statement ? (
                <blockquote className="border-s-2 border-primary/30 ps-4 whitespace-pre-wrap wrap-anywhere text-sm leading-7">
                  {appeal.statement}
                </blockquote>
              ) : null}
              {appeal.resolvedAt ? (
                <p className="text-xs text-muted-foreground">
                  {m.decision_resolved_label()} <DecisionTime instant={appeal.resolvedAt} now={now} locale={locale} />
                </p>
              ) : null}
            </div>
          ) : allowed ? (
            <form
              className="mt-5 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const submitter = (event.nativeEvent as SubmitEvent).submitter;
                const keyboardControl =
                  submitter instanceof HTMLButtonElement && keyboardClick.current === submitter ? submitter : null;
                keyboardClick.current = null;
                void submit(false, keyboardControl);
              }}
            >
              <label htmlFor="appeal-statement" className="block text-sm font-medium">
                {m.decision_appeal_prompt()}
              </label>
              <Textarea
                id="appeal-statement"
                name="statement"
                value={text}
                onChange={(event) => {
                  composition.change(event.target.value);
                  redraw((value) => value + 1);
                  setFeedback(null);
                }}
                disabled={sending || locked}
                rows={5}
                className="min-h-36"
                aria-describedby="appeal-count appeal-hint"
                aria-invalid={feedback === 'invalid' || count > 2000}
              />
              <p id="appeal-count" className="text-xs text-muted-foreground">
                {m.decision_appeal_count({ count })}
              </p>
              <p id="appeal-hint" className="text-xs leading-6 text-muted-foreground">
                {m.decision_authority_hint()}
              </p>
              <Button
                type="submit"
                className="min-h-11 w-full sm:w-auto"
                disabled={busy || locked || count < 1 || count > 2000}
              >
                {busy ? m.decision_appeal_sending() : m.decision_appeal_submit()}
              </Button>
            </form>
          ) : (
            <p className="mt-5 text-sm leading-6 text-muted-foreground">
              {acknowledged ? m.decision_appeal_acknowledged() : adviceMessage ?? m.decision_appeal_advice_unavailable()}
            </p>
          )}
          {acknowledged && appeal ? (
            <p className="mt-4 text-sm leading-6 text-muted-foreground" role="status">
              {m.decision_appeal_acknowledged()}
            </p>
          ) : null}
          {readback?.state === 'unavailable' ? (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">{m.decision_readback_unavailable()}</p>
          ) : readbackDecision ? (
            <p className="mt-4 text-sm leading-6 text-muted-foreground" role="status">
              {m.decision_current_readback()}: {readbackStatus}
            </p>
          ) : null}
          {text && (appeal || !allowed) ? (
            <div className="mt-5 space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium text-muted-foreground">{m.decision_draft_label()}</p>
              <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-6">{text}</p>
            </div>
          ) : null}
          {feedback ? (
            <ContentItemFrame as="div" className="mt-5 space-y-3 p-4">
              <p role="alert" className="text-sm leading-6">
                {feedbackText}
              </p>
              {feedback === 'uncertain' ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={(event) => {
                    const keyboardControl = keyboardClick.current === event.currentTarget ? event.currentTarget : null;
                    keyboardClick.current = null;
                    void submit(true, keyboardControl);
                  }}
                >
                  {m.decision_retry_same()}
                </Button>
              ) : null}
            </ContentItemFrame>
          ) : null}
          {composition.needsDecision ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11"
              onClick={() => departure.requestDiscard()}
            >
              {m.decision_appeal_discard()}
            </Button>
          ) : null}
        </ContentItemFrame>
      </section>
      <details className="border-t border-border pt-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{m.reporter_status_reference()}</summary>
        <ContentItemFrame as="div" className="space-y-4 p-4">
          <dl className="space-y-4 text-sm">
            <div className="space-y-1">
              <dt className="text-muted-foreground">{m.moderation_case_details_decision_id()}</dt>
              <dd className="select-text break-all font-mono leading-6">{decision.id}</dd>
            </div>
            {context.state === 'available' ? (
              <div className="space-y-1">
                <dt className="text-muted-foreground">{m.moderation_case_details_target_id()}</dt>
                <dd className="select-text break-all font-mono leading-6">{decision.targetId}</dd>
              </div>
            ) : null}
            {appeal ? (
              <div className="space-y-1">
                <dt className="text-muted-foreground">{m.moderation_case_details_appeal_id()}</dt>
                <dd className="select-text break-all font-mono leading-6">{appeal.id}</dd>
              </div>
            ) : null}
          </dl>
        </ContentItemFrame>
      </details>
    </article>
  );
}

function decisionIdentity(page: DecisionPage) {
  return [page.decision.id, page.decision.targetKind, page.decision.targetId, page.nativeSourceFingerprint];
}
