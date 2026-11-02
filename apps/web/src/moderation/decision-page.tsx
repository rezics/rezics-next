import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowUpRight, Check, FileText, ShieldCheck } from 'lucide-react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Withheld } from '@rezics/ui/withheld';
import { QueryClientContext } from '@tanstack/react-query';
import { createPrivateReaderLifetime, type PrivateReaderNavigation } from './private-reader-lifetime';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import { appealDecision, type AppealSubmission } from './appeal';
import { createDecisionAppealIntent } from './command-intent';
import { useSession } from '../session/query';
import {
  decisionReadFailure,
  decisionReadKey,
  prepareDecisionRead,
  sameDecision,
  type DecisionReadState,
} from './decision-read-model';
import { canAppealDecision, canAttemptAppealWithoutTarget, type DecisionPage, readDecisionPage } from './decision-read';

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

export type DecisionAppealAction = (input: {
  id: string;
  statement: string;
  idempotencyKey: string;
}) => Promise<AppealSubmission>;
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
const sendAppeal: DecisionAppealAction = (data) => appealDecision({ data, headers: csrfHeaders() });
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
  return <DecisionBoundPage key={props.page.readGeneration ?? props.page.decision.id} {...props} />;
}

function DecisionBoundPage(props: DecisionPageProps) {
  // Initialize the existing imperative token from the real session hook; admission uses the exact cache source.
  useSession();
  const client = useContext(QueryClientContext);
  const [original] = useState(props);
  const [page, setPage] = useState(props.page);
  const [owner, setOwner] = useState(() =>
    client && typeof window !== 'undefined'
      ? createPrivateReaderLifetime(client, page, decisionReadKey(page.decision.id), props.navigation)
      : null,
  );
  const originalClient = useRef(client).current;
  if (
    client !== originalClient ||
    props.navigation !== original.navigation ||
    props.onRefresh !== original.onRefresh ||
    props.onAppeal !== original.onAppeal ||
    !sameDecision(props.page.decision, original.page.decision)
  )
    owner?.retire();
  useSyncExternalStore(owner?.subscribe ?? emptySubscribe, owner?.snapshot ?? zeroSnapshot, zeroSnapshot);
  if (typeof window !== 'undefined' && !client) return <DecisionReadStatus state="closed" />;
  if (owner && (!owner.healthy() || !owner.available())) {
    return (
      <DecisionFreshRecovery
        key={page.readGeneration ?? page.decision.id}
        state={owner.healthy() ? 'unavailable' : 'closed'}
        original={page}
        read={original.onRefresh ?? refreshDecision}
        allowed={() => client === originalClient && owner.canRecover()}
        prepare={(id, read) => prepareDecisionRead(client!, id, read)}
        onAdmit={(next) => {
          owner.retire();
          setOwner(createPrivateReaderLifetime(client!, next, decisionReadKey(next.decision.id), original.navigation));
          setPage(next);
        }}
      />
    );
  }
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a') && owner && (!owner.isCurrent() || !owner.available()))
          event.preventDefault();
      }}
    >
      <DecisionVisit
        key={page.readGeneration ?? 'presenter'}
        {...original}
        page={page}
        {...(owner
          ? { isCurrent: owner.isCurrent, canCommand: owner.canCommand, accepts: owner.accepts, retire: owner.retire }
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
  original: DecisionPage;
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
      const next = await prepare(original.decision.id, read);
      if (!current()) return;
      if (!sameDecision(next.decision, original.decision)) setState('closed');
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
  retire,
}: DecisionPageProps & { retire?: () => void }) {
  const [current, setCurrent] = useState<DecisionPage | null>(page);
  const [readState, setReadState] = useState<DecisionReadState>('unavailable');
  const [composition] = useState(createDecisionAppealIntent);
  const [, redraw] = useState(0);
  const text = composition.text;
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = sending || refreshing;
  const pending = useRef(false);
  const reading = useRef(false);
  const lifetime = useRef({ active: true, retired: false, serial: 0, readSerial: 0 });
  function leave() {
    lifetime.current.retired = true;
    lifetime.current.active = false;
    lifetime.current.serial++;
    lifetime.current.readSerial++;
    composition.discard();
    retire?.();
  }
  function discard() {
    // Forget local recovery without claiming that the native request was cancelled.
    lifetime.current.serial++;
    pending.current = false;
    composition.discard();
    setSending(false);
    setFeedback(null);
    redraw((value) => value + 1);
  }
  const active = () => lifetime.current.active && !lifetime.current.retired && isCurrent();
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
  const target = displayed.target?.id === decision.targetId ? displayed.target : null;
  const targetKind = decision.targetKind === 'post' ? m.reporter_status_post() : m.reporter_status_thread();
  const locale = getLocale();
  // This hint controls presentation only; an unavailable target cannot establish authorship.
  const allowed = target
    ? canAppealDecision(decision, target.authorId ?? null, displayed.viewerId, now)
    : canAttemptAppealWithoutTarget(decision, displayed.viewerId, now);
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

  async function submit(retry = false) {
    if (!active() || !canCommand() || pending.current || (!retry && (locked || !allowed || count < 1 || count > 2000)))
      return;
    if (retry && (feedback !== 'uncertain' || !composition.unresolved)) return;
    const token = ++lifetime.current.serial;
    const command = retry ? composition.retry()! : composition.freeze(decision.id);
    pending.current = true;
    setSending(true);
    setFeedback(null);
    // A previous target snapshot is no longer a current link after a write attempt.
    setCurrent((value) => (value ? { ...value, target: null } : null));
    try {
      if (!active() || !canCommand()) return;
      const result = await onAppeal(command);
      if (!active() || lifetime.current.serial !== token) return;
      // A concurrent admitted read may already have confirmed this request.
      if (composition.retry() !== command) return;
      if (result.state === 'pending' || result.state === 'updated') {
        if (!sameDecision(result.decision, decision) || (result.state === 'pending' && !result.decision.appeal)) {
          setFeedback('uncertain');
          return;
        }
        composition.settle(Boolean(result.decision.appeal));
        setCurrent((value) => (value ? { ...value, decision: result.decision, target: null } : null));
        setFeedback(result.state === 'updated' ? 'conflict' : null);
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
    setCurrent((value) => (value ? { ...value, target: null } : null));
    try {
      const next = await onRefresh(decision.id);
      if (!active() || lifetime.current.readSerial !== token) return;
      if (
        !sameDecision(next.decision, page.decision) ||
        next.viewerId !== page.viewerId ||
        (accepts ? !(await accepts(next)) : next.sessionEpoch !== page.sessionEpoch)
      ) {
        setCurrent(null);
        setReadState('closed');
        discard();
        return;
      }
      if (!active() || lifetime.current.readSerial !== token) return;
      // An overlapping target read cannot roll back an acknowledged appeal receipt.
      setCurrent((value) =>
        value?.decision.appeal && !next.decision.appeal ? { ...next, decision: value.decision } : next,
      );
      // A successful read without an appeal cannot settle a lost command response.
      if (!composition.unresolved || next.decision.appeal) {
        composition.settle(Boolean(next.decision.appeal));
        setFeedback(null);
      }
    } catch (error) {
      if (active() && lifetime.current.readSerial === token) {
        const state = decisionReadFailure(error);
        setCurrent(null);
        setReadState(state);
        if (state !== 'unavailable') {
          discard();
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
            {target ? (
              <>
                <p className="text-sm font-medium">{m.decision_target_available()}</p>
                <a
                  href={localizeHref(target.href)}
                  className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 text-sm font-medium underline underline-offset-4"
                >
                  <span className="line-clamp-3 wrap-anywhere">
                    {target.text || m.decision_target_fallback({ kind: targetKind })}
                  </span>
                  <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </>
            ) : (
              <Withheld shape="passage" labels={{ withheld: m.moderation_target_unavailable() }} />
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
          <dl className="mt-5 border-y border-border py-4 text-sm leading-6 sm:flex sm:gap-6">
            <dt className="font-medium">{m.decision_deadline_label()}</dt>
            <dd className="mt-1 text-muted-foreground sm:mt-0">
              <DecisionTime instant={decision.appealDeadline} now={now} locale={locale} />
            </dd>
          </dl>
          {appeal ? (
            <div className="mt-5 space-y-3">
              <p className="flex items-center gap-2 font-medium">
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
                void submit();
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
              {now > Date.parse(decision.appealDeadline) ? m.decision_appeal_expired() : m.decision_author_only()}
            </p>
          )}
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
                <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void submit(true)}>
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
            {target ? (
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
  return [page.decision.id, page.decision.targetKind, page.decision.targetId];
}
