import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, FileText, ShieldCheck } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Withheld } from '@rezics/ui/withheld';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { appealDecision, type AppealSubmission } from './appeal';
import { createModerationIntent } from './command-intent';
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
};
const sendAppeal: DecisionAppealAction = (data) => appealDecision({ data, headers: csrfHeaders() });
const refreshDecision = (id: string) => readDecisionPage({ data: { id } });
type Feedback = 'denied' | 'conflict' | 'uncertain' | 'invalid' | 'refused' | 'refresh-failed';

/** The route and Pattern share this view. Native reads and commands remain the only outcome authority. */
export function DecisionPageView({
  page,
  now = Date.now(),
  onAppeal = sendAppeal,
  onRefresh = refreshDecision,
}: DecisionPageProps) {
  const [current, setCurrent] = useState(page);
  const currentSource = useRef(page);
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [commandIntent] = useState(createModerationIntent);
  const pending = useRef(false);
  const lastCommand = useRef<Parameters<DecisionAppealAction>[0] | null>(null);
  const source = useRef<DecisionPage | null>(page);
  source.current = page;
  useEffect(() => {
    source.current = page;
    currentSource.current = page;
    setCurrent(page);
    setText('');
    setFeedback(null);
    setBusy(false);
    pending.current = false;
    lastCommand.current = null;
    commandIntent.changed();
    return () => {
      source.current = null;
    };
  }, [page, commandIntent]);
  const displayed = currentSource.current === page ? current : page;
  const { decision } = displayed;
  const target = displayed.target?.id === decision.targetId ? displayed.target : null;
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
            : feedback === 'refresh-failed'
              ? m.decision_refresh_failed()
              : m.decision_appeal_refused();

  async function submit(retry = false) {
    if (pending.current || (!retry && (locked || !allowed || count < 1 || count > 2000))) return;
    if (retry && (feedback !== 'uncertain' || !lastCommand.current)) return;
    const origin = source.current;
    const intent = { id: decision.id, statement: text };
    const command = retry ? lastCommand.current! : { ...intent, idempotencyKey: commandIntent.keyFor(intent) };
    lastCommand.current = command;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    // A previous target snapshot is no longer a current link after a write attempt.
    setCurrent((value) => ({ ...value, target: null }));
    try {
      const result = await onAppeal(command);
      if (source.current !== origin) return;
      if (result.state === 'pending' || result.state === 'updated') {
        if (
          result.decision.id !== decision.id ||
          result.decision.targetId !== decision.targetId ||
          result.decision.targetKind !== decision.targetKind ||
          (result.state === 'pending' && !result.decision.appeal)
        ) {
          setFeedback('uncertain');
          return;
        }
        setCurrent((value) => ({ ...value, decision: result.decision, target: null }));
        setFeedback(result.state === 'updated' ? 'conflict' : null);
      } else if (result.state === 'invalid') setFeedback('invalid');
      else setFeedback(result.state === 'failed' ? 'uncertain' : result.state);
    } catch {
      if (source.current === origin) setFeedback('uncertain');
    } finally {
      if (source.current === origin) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  async function refresh() {
    if (pending.current) return;
    const origin = source.current;
    pending.current = true;
    setBusy(true);
    setCurrent((value) => ({ ...value, target: null }));
    try {
      const next = await onRefresh(decision.id);
      if (source.current !== origin) return;
      if (
        next.decision.id !== decision.id ||
        next.decision.targetId !== decision.targetId ||
        next.decision.targetKind !== decision.targetKind
      )
        throw new Error('Decision changed');
      setCurrent(next);
      setFeedback(null);
      lastCommand.current = null;
      commandIntent.changed();
    } catch {
      if (source.current === origin) setFeedback('refresh-failed');
    } finally {
      if (source.current === origin) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

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
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6" role="status">
          <p className="text-xs font-medium text-muted-foreground">{m.decision_current_outcome()}</p>
          <p className="mt-2 text-xl font-semibold tracking-tight">{outcome}</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {appeal ? m.decision_outcome_independent() : m.decision_original_effect()}
          </p>
        </div>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-4" aria-labelledby="decision-reasons">
          <h2 id="decision-reasons" className="flex items-center gap-2 text-base font-semibold">
            <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
            {m.decision_original_heading()}
          </h2>
          <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <p className="text-xs font-medium text-muted-foreground">{m.decision_original_action()}</p>
            <h3 className="mt-5 text-sm font-semibold">{m.decision_reasons_heading()}</h3>
            <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-7">{decision.statement}</p>
            <p className="mt-5 border-t border-border pt-4 text-xs leading-6 text-muted-foreground">
              {m.decision_decided_label()} <DecisionTime instant={decision.decidedAt} now={now} locale={locale} />
            </p>
          </div>
        </section>
        <section className="min-w-0 space-y-4" aria-labelledby="decision-applies">
          <h2 id="decision-applies" className="text-base font-semibold">
            {m.decision_current_target()}
          </h2>
          <div className="rounded-2xl border border-border bg-muted/30 p-5 sm:p-6">
            {target ? (
              <>
                <p className="text-sm font-medium">{m.decision_target_available()}</p>
                <a
                  href={localizeHref(target.href)}
                  className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 text-sm font-medium underline underline-offset-4"
                >
                  <span className="line-clamp-3 wrap-anywhere">
                    {target.text || m.decision_target_fallback({ kind: decision.targetKind })}
                  </span>
                  <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </>
            ) : (
              <Withheld shape="passage" labels={{ withheld: m.moderation_target_unavailable() }} />
            )}
            <p className="mt-3 text-xs leading-6 text-muted-foreground">{m.decision_target_independent()}</p>
            <Button className="mt-4 min-h-11" variant="outline" disabled={busy} onClick={() => void refresh()}>
              {busy ? m.decision_refreshing() : m.decision_refresh()}
            </Button>
          </div>
        </section>
      </div>
      <section
        className="min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6"
        aria-labelledby="decision-appeal"
      >
        <h2 id="decision-appeal" className="text-lg font-semibold">
          {m.decision_appeal_heading()}
        </h2>
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
                commandIntent.changed();
                setText(event.target.value);
                setFeedback(null);
              }}
              disabled={busy || locked}
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
          <div className="mt-5 space-y-3 rounded-xl border border-border bg-muted/50 p-4">
            <p role="alert" className="text-sm leading-6">
              {feedbackText}
            </p>
            {feedback === 'uncertain' ? (
              <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void submit(true)}>
                {m.decision_retry_same()}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <p className="wrap-anywhere border-t border-border pt-4 text-xs leading-6 text-muted-foreground">
        {m.decision_reference()} <span className="font-mono">{decision.id}</span>
      </p>
    </article>
  );
}
