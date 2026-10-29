import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { appealDecision } from './appeal';
import { canAppealDecision, type DecisionPage, type ModerationDecision } from './decision-read';

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

export function DecisionPageView({ page, now = Date.now() }: { page: DecisionPage; now?: number }) {
  const [decision, setDecision] = useState(page.decision);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locale = getLocale();
  const allowed = canAppealDecision(decision, page.target.authorId ?? null, page.viewerId, now);
  const count = Array.from(text).length;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (count < 1 || count > 2000 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await appealDecision({ data: { id: decision.id, statement: text } });
      if (result.state === 'pending' || result.state === 'updated') {
        setDecision(result.decision);
        setText('');
      } else if (result.state === 'invalid') {
        setText(result.text);
        setError(m.decision_appeal_too_long());
      } else setError(m.decision_appeal_unavailable());
    } catch {
      setError(m.decision_appeal_unavailable());
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.decision_heading()}</h1>
      <section className="mt-8" aria-labelledby="decision-reasons">
        <h2 id="decision-reasons" className="text-lg font-semibold">
          {m.decision_reasons_heading()}
        </h2>
        <p className="mt-3 whitespace-pre-wrap leading-7">{decision.statement}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          {m.decision_decided_label()} <DecisionTime instant={decision.decidedAt} now={now} locale={locale} />
        </p>
      </section>
      <section className="mt-8" aria-labelledby="decision-applies">
        <h2 id="decision-applies" className="text-lg font-semibold">
          {m.decision_applies_heading()}
        </h2>
        <p className="mt-3 leading-7">
          <Link to={page.target.href as never} className="underline underline-offset-4">
            {page.target.text || m.decision_target_fallback({ kind: decision.targetKind })}
          </Link>
        </p>
      </section>
      <section className="mt-8 border-t border-border pt-6" aria-labelledby="decision-appeal">
        <h2 id="decision-appeal" className="text-lg font-semibold">
          {m.decision_appeal_heading()}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {m.decision_deadline_label()} <DecisionTime instant={decision.appealDeadline} now={now} locale={locale} />
        </p>
        {decision.appeal ? (
          <AppealState appeal={decision.appeal} />
        ) : allowed ? (
          <form className="mt-5 space-y-3" onSubmit={submit}>
            <label htmlFor="appeal-statement" className="block text-sm font-medium">
              {m.decision_appeal_prompt()}
            </label>
            <Textarea
              id="appeal-statement"
              name="statement"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              aria-describedby={error ? 'appeal-error appeal-count' : 'appeal-count'}
              aria-invalid={Boolean(error)}
            />
            <p id="appeal-count" className="text-sm text-muted-foreground">
              {m.decision_appeal_count({ count })}
            </p>
            {error ? (
              <p id="appeal-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={saving || count < 1 || count > 2000}>
              {saving ? m.decision_appeal_sending() : m.decision_appeal_submit()}
            </Button>
          </form>
        ) : page.viewerId === page.target.authorId && now > Date.parse(decision.appealDeadline) ? (
          <p className="mt-4 text-sm text-muted-foreground">{m.decision_appeal_expired()}</p>
        ) : null}
      </section>
    </main>
  );
}

function AppealState({ appeal }: { appeal: ModerationDecision['appeal'] }) {
  if (!appeal) return null;
  if (!appeal.outcome) return <p className="mt-4 rounded-xl bg-muted/50 p-4">{m.decision_appeal_pending()}</p>;
  return (
    <div className="mt-4 rounded-xl bg-muted/50 p-4">
      <p className="font-medium">
        {appeal.outcome === 'reversed' ? m.decision_appeal_reversed() : m.decision_appeal_upheld()}
      </p>
      {appeal.statement ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{appeal.statement}</p> : null}
    </div>
  );
}
