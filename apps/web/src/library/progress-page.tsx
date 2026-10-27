import { ProgressRow } from '@rezics/ui/progress-row';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt, csrfHeaders } from '../threads/composer';
import type { ProgressIndex, ProgressMode, ProgressUnit } from './progress-reads';
import { startProgressSession } from './progress-server';
import { rowRatio, SubjectIdentity } from './subject-row';

const modeChoices: { value: ProgressMode; label: () => string }[] = [
  { value: 'scalar_amount', label: () => m.library_progress_mode_amount() },
  { value: 'cursor_position', label: () => m.library_progress_mode_cursor() },
  { value: 'completed_units', label: () => m.library_progress_mode_units() },
];

const unitChoices: { value: ProgressUnit; label: () => string }[] = [
  { value: 'page', label: () => m.library_progress_unit_page() },
  { value: 'chapter', label: () => m.library_progress_unit_chapter() },
  { value: 'episode', label: () => m.library_progress_unit_episode() },
  { value: 'volume', label: () => m.library_progress_unit_volume() },
  { value: 'minute', label: () => m.library_progress_unit_minute() },
  { value: 'percent', label: () => m.library_progress_unit_percent() },
];

function modeLabel(mode: ProgressMode): string {
  return modeChoices.find((choice) => choice.value === mode)?.label() ?? m.library_progress_mode_amount();
}

function unitLabel(unit: ProgressUnit): string {
  return unitChoices.find((choice) => choice.value === unit)?.label() ?? m.library_progress_unit_page();
}

function stateLabel(state: ProgressIndex['sessions'][number]['state']): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

export function progressValue(session: ProgressIndex['sessions'][number]): { value: number | null; label: string } {
  const amount =
    session.mode === 'completed_units'
      ? String(session.completedUnitCount)
      : session.mode === 'cursor_position'
        ? session.position
        : session.amount;
  if (amount == null || amount === '') return { value: null, label: '' };
  if (session.unit === 'percent') return { value: Number(amount) / 100, label: `${amount}%` };
  if (!session.total || Number(session.total) <= 0 || !Number.isFinite(Number(amount)))
    return { value: null, label: amount };
  const prefixes: Record<ProgressUnit, string> = {
    page: 'p.',
    episode: 'Ep',
    chapter: 'Ch',
    volume: 'Vol',
    minute: 'min',
    percent: '%',
  };
  return {
    value: Number(amount) / Number(session.total),
    label: `${getLocale() === 'en' ? prefixes[session.unit] : unitLabel(session.unit)} ${amount}/${session.total}`,
  };
}

const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2';
const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

export function ProgressIndexPage({ page }: { page: ProgressIndex }) {
  const router = useRouter();
  const location = useLocation();
  const [subject, setSubject] = useState(page.subjectId);
  const [mode, setMode] = useState<ProgressMode>('scalar_amount');
  const [unit, setUnit] = useState<ProgressUnit>('page');
  const [total, setTotal] = useState('');
  const [key, setKey] = useState(page.idempotencyKey);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    setPending(true);
    const totalValue = mode === 'scalar_amount' ? total.trim() : '';
    try {
      const result = await startProgressSession({
        data: {
          subjectId: subject.trim(),
          mode,
          unit,
          idempotencyKey: key,
          ...(totalValue ? { total: totalValue } : {}),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setAlert(result.reason === 'conflict' ? m.library_progress_conflict() : m.library_progress_invalid());
        return;
      }
      setKey(crypto.randomUUID());
      window.location.assign(router.buildLocation({ to: '/library/progress/$id', params: { id: result.id } }).href);
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      setPending(false);
    }
  }

  const ratio = rowRatio(page.signedIn ? page.sessions.map((session) => session.subject) : []);
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
      </header>
      {page.signedIn ? (
        <>
          <form className="space-y-4" onSubmit={onStart}>
            <input type="hidden" name="idempotencyKey" value={key} />
            <label className="block space-y-1">
              <span className="text-sm font-medium">{m.library_progress_subject()}</span>
              <input className={fieldClass} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{m.library_progress_mode()}</legend>
              {modeChoices.map((choice) => (
                <label key={choice.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="progress-mode"
                    value={choice.value}
                    checked={mode === choice.value}
                    onChange={() => setMode(choice.value)}
                  />
                  {choice.label()}
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{m.library_progress_unit()}</span>
              <select
                className={fieldClass}
                value={unit}
                onChange={(event) => setUnit(event.target.value as ProgressUnit)}
              >
                {unitChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label()}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{m.library_progress_total()}</span>
              <input
                className={fieldClass}
                value={total}
                disabled={mode !== 'scalar_amount'}
                onChange={(event) => setTotal(event.target.value)}
              />
            </label>
            {alert ? (
              <p role="alert" className="rounded-lg border border-border bg-card p-3">
                {alert}
              </p>
            ) : null}
            <button type="submit" className={buttonClass} disabled={pending}>
              {m.library_progress_start()}
            </button>
          </form>
          {page.sessions.length ? (
            <ol className="divide-y divide-border/60 border-y border-border/60">
              {page.sessions.map((session) => (
                <li key={session.id} className="space-y-2 py-4">
                  <div className="flex items-center gap-3">
                    <SubjectIdentity subject={session.subject} ratio={ratio} />
                  </div>
                  <p>{stateLabel(session.state)}</p>
                  <p>{modeLabel(session.mode)}</p>
                  <p>{unitLabel(session.unit)}</p>
                  <ProgressRow {...progressValue(session)} />
                  <p>
                    <Link
                      to="/library/progress/$id"
                      params={{ id: session.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {m.library_progress_open()}
                    </Link>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">{m.library_progress_empty()}</p>
          )}
          {page.next ? (
            <nav>
              <Link
                to="/library/progress"
                search={{ subjectId: page.subjectId, cursor: page.next }}
                className={buttonClass}
              >
                {m.library_progress_more()}
              </Link>
            </nav>
          ) : null}
        </>
      ) : (
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0] ?? location.pathname} />
      )}
    </article>
  );
}
