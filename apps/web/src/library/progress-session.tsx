import { Link, useLocation } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { SignInPrompt, csrfHeaders } from '../threads/composer';
import {
  parseUnitBatch,
  type ProgressChange,
  type ProgressMode,
  type ProgressSessionPage,
  type ProgressSessionView,
  type ProgressState,
  type ProgressUnit,
} from './progress-reads';
import { finishProgressSession, recordProgressSession } from './progress-server';
import { SubjectRef } from './subject-ref';

const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';
const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2';

function modeLabel(mode: ProgressMode): string {
  if (mode === 'cursor_position') return m.library_progress_mode_cursor();
  if (mode === 'completed_units') return m.library_progress_mode_units();
  return m.library_progress_mode_amount();
}

function unitLabel(unit: ProgressUnit): string {
  if (unit === 'chapter') return m.library_progress_unit_chapter();
  if (unit === 'episode') return m.library_progress_unit_episode();
  if (unit === 'volume') return m.library_progress_unit_volume();
  if (unit === 'minute') return m.library_progress_unit_minute();
  if (unit === 'percent') return m.library_progress_unit_percent();
  return m.library_progress_unit_page();
}

function stateLabel(state: ProgressState): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

function percentOf(amount: string, total: string): string {
  const value = Number(amount);
  const whole = Number(total);
  if (!Number.isFinite(value) || !Number.isFinite(whole) || whole === 0) return '0';
  return String(Math.round((value / whole) * 100 * 100) / 100);
}

function progressText(session: ProgressSessionView): string | null {
  if (session.mode === 'scalar_amount' && session.amount && session.total) {
    return m.library_progress_ratio({
      amount: session.amount,
      total: session.total,
      percent: percentOf(session.amount, session.total),
    });
  }
  if (session.mode === 'scalar_amount' && session.unit === 'percent' && session.amount) {
    return m.library_progress_percent({ percent: session.amount });
  }
  if (session.mode === 'completed_units' && session.total) {
    return m.library_progress_ratio({
      amount: String(session.completedUnitCount),
      total: session.total,
      percent: percentOf(String(session.completedUnitCount), session.total),
    });
  }
  return null;
}

function changeText(change: ProgressChange): string {
  return [change.amount, change.locator, change.position, ...change.add, ...change.remove].filter(Boolean).join(' ');
}

export function ProgressSessionPage({ page }: { page: ProgressSessionPage }) {
  const location = useLocation();
  if (!page.signedIn) {
    return (
      <article className="max-w-4xl space-y-8 text-foreground">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{m.library_progress_heading()}</h1>
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0] ?? location.pathname} />
      </article>
    );
  }
  return <SessionEditor page={page} />;
}

function SessionEditor({ page }: { page: Extract<ProgressSessionPage, { signedIn: true }> }) {
  const [session, setSession] = useState(page.session);
  const [seenId, setSeenId] = useState(page.session.id);
  const [key, setKey] = useState(page.idempotencyKey);
  const [amount, setAmount] = useState('');
  const [locator, setLocator] = useState('');
  const [position, setPosition] = useState('');
  const [addText, setAddText] = useState('');
  const [removeText, setRemoveText] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const pending = useRef(false);
  const addId = useId();
  const removeId = useId();
  const addHint = useId();
  const removeHint = useId();
  const changesHeading = useId();
  const unitsHeading = useId();

  if (page.session.id !== seenId) {
    setSeenId(page.session.id);
    setSession(page.session);
    setKey(page.idempotencyKey);
    setAmount('');
    setLocator('');
    setPosition('');
    setAddText('');
    setRemoveText('');
    setAlert(null);
    setConfirming(null);
  }

  function explain(reason: string) {
    setAlert(reason === 'conflict' ? m.library_progress_conflict() : m.library_progress_invalid());
  }

  async function onRecord() {
    if (pending.current || session.state !== 'active') return;
    setAlert(null);
    const intent =
      session.mode === 'cursor_position'
        ? { locator: locator.trim(), position: position.trim() }
        : { amount: amount.trim() };
    pending.current = true;
    try {
      const result = await recordProgressSession({
        data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, ...intent },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      const change: ProgressChange = {
        id: `${session.id}:${result.session.revision}`,
        revision: result.session.revision,
        createdAt: new Date().toISOString(),
        amount: 'amount' in intent ? intent.amount : null,
        locator: 'locator' in intent ? intent.locator : null,
        position: 'position' in intent ? intent.position : null,
        add: [],
        remove: [],
      };
      setKey(crypto.randomUUID());
      setAmount('');
      setLocator('');
      setPosition('');
      setSession((current) => ({
        ...current,
        revision: result.session.revision,
        amount: result.session.amount,
        locator: result.session.locator,
        position: result.session.position,
        completedUnitCount: result.session.completedUnitCount,
        state: result.session.state,
        completedAt: result.session.completedAt,
        total: result.session.total,
        changes: [...current.changes, change],
      }));
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  async function onUnits(kind: 'add' | 'remove') {
    if (pending.current || session.state !== 'active') return;
    const parsed = parseUnitBatch(kind === 'add' ? addText : removeText);
    if (!parsed.ok) {
      setAlert(parsed.reason === 'limit' ? m.library_progress_batch_limit() : m.library_progress_invalid());
      return;
    }
    setAlert(null);
    pending.current = true;
    try {
      const result = await recordProgressSession({
        data: {
          sessionId: session.id,
          revision: session.revision,
          idempotencyKey: key,
          ...(kind === 'add' ? { add: parsed.ids } : { remove: parsed.ids }),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      const change: ProgressChange = {
        id: `${session.id}:${result.session.revision}`,
        revision: result.session.revision,
        createdAt: new Date().toISOString(),
        amount: null,
        locator: null,
        position: null,
        add: kind === 'add' ? parsed.ids : [],
        remove: kind === 'remove' ? parsed.ids : [],
      };
      setKey(crypto.randomUUID());
      if (kind === 'add') setAddText('');
      else setRemoveText('');
      setSession((current) => {
        const next = new Set(current.units);
        if (kind === 'add') for (const id of parsed.ids) next.add(id);
        else for (const id of parsed.ids) next.delete(id);
        return {
          ...current,
          revision: result.session.revision,
          completedUnitCount: result.session.completedUnitCount,
          state: result.session.state,
          completedAt: result.session.completedAt,
          units: [...next].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
          changes: [...current.changes, change],
        };
      });
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  async function onFinish(action: 'complete' | 'abandon') {
    if (pending.current || session.state !== 'active') return;
    setAlert(null);
    pending.current = true;
    try {
      const result = await finishProgressSession({
        data: { sessionId: session.id, action, revision: session.revision, idempotencyKey: key },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      setKey(crypto.randomUUID());
      setConfirming(null);
      setSession((current) => ({
        ...current,
        revision: result.session.revision,
        amount: result.session.amount,
        state: result.session.state,
        completedAt: result.session.completedAt,
      }));
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  const progress = progressText(session);

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{m.library_progress_heading()}</h1>
        <p className="flex flex-wrap items-baseline gap-2">
          <SubjectRef subject={session.subject} />
        </p>
        {session.versionSubjectId ? (
          <p className="flex flex-wrap items-baseline gap-2">
            <SubjectRef subject={session.versionSubject} />
          </p>
        ) : null}
        <p>{modeLabel(session.mode)}</p>
        <p>{unitLabel(session.unit)}</p>
        {session.total ? <p>{session.total}</p> : null}
        <p data-progress-state={session.state}>{stateLabel(session.state)}</p>
        {progress ? <p data-progress>{progress}</p> : null}
        {session.mode === 'cursor_position' && (session.locator || session.position) ? (
          <p>{[session.locator, session.position].filter(Boolean).join(' ')}</p>
        ) : null}
      </header>
      <input type="hidden" name="idempotencyKey" value={key} />
      {alert ? (
        <p role="alert" className="rounded-lg border border-border bg-card p-3">
          {alert}
        </p>
      ) : null}
      {session.state === 'active' && session.mode !== 'completed_units' ? (
        <div className="space-y-4">
          {session.mode === 'scalar_amount' ? (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{m.library_progress_amount()}</span>
              <input className={fieldClass} value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
          ) : (
            <>
              <label className="block space-y-1">
                <span className="text-sm font-medium">{m.library_progress_locator()}</span>
                <input className={fieldClass} value={locator} onChange={(event) => setLocator(event.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium">{m.library_progress_position()}</span>
                <input className={fieldClass} value={position} onChange={(event) => setPosition(event.target.value)} />
              </label>
            </>
          )}
          <button type="button" className={buttonClass} onClick={() => void onRecord()}>
            {m.library_progress_record()}
          </button>
        </div>
      ) : null}
      {session.state === 'active' && session.mode === 'completed_units' ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor={addId} className="text-sm font-medium">
              {m.library_progress_add_units()}
            </label>
            <textarea
              id={addId}
              className={fieldClass}
              aria-describedby={addHint}
              value={addText}
              onChange={(event) => setAddText(event.target.value)}
            />
            <p id={addHint} className="text-sm text-muted-foreground">
              {m.library_progress_batch_limit()}
            </p>
            <button type="button" className={buttonClass} onClick={() => void onUnits('add')}>
              {m.library_progress_add_units()}
            </button>
          </div>
          <div className="space-y-2">
            <label htmlFor={removeId} className="text-sm font-medium">
              {m.library_progress_remove_units()}
            </label>
            <textarea
              id={removeId}
              className={fieldClass}
              aria-describedby={removeHint}
              value={removeText}
              onChange={(event) => setRemoveText(event.target.value)}
            />
            <p id={removeHint} className="text-sm text-muted-foreground">
              {m.library_progress_batch_limit()}
            </p>
            <button type="button" className={buttonClass} onClick={() => void onUnits('remove')}>
              {m.library_progress_remove_units()}
            </button>
          </div>
        </div>
      ) : null}
      {session.state === 'active' ? (
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass} onClick={() => setConfirming('complete')}>
            {m.library_progress_complete()}
          </button>
          <button type="button" className={buttonClass} onClick={() => setConfirming('abandon')}>
            {m.library_progress_abandon()}
          </button>
          {confirming === 'complete' ? (
            <>
              <button type="button" className={buttonClass} onClick={() => void onFinish('complete')}>
                {m.library_progress_confirm_complete()}
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirming(null)}>
                {m.library_progress_cancel()}
              </button>
            </>
          ) : null}
          {confirming === 'abandon' ? (
            <>
              <button type="button" className={buttonClass} onClick={() => void onFinish('abandon')}>
                {m.library_progress_confirm_abandon()}
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirming(null)}>
                {m.library_progress_cancel()}
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <p>
          <Link
            to="/library/progress"
            search={{ subjectId: session.subjectId }}
            className="text-primary underline-offset-4 hover:underline"
          >
            {m.library_progress_restart()}
          </Link>
        </p>
      )}
      <section role="region" aria-labelledby={changesHeading} className="space-y-3">
        <h2 id={changesHeading} className="text-xl font-semibold">
          {m.library_progress_changes()}
        </h2>
        {session.changes.length ? (
          <ol className="divide-y divide-border/60 border-y border-border/60">
            {session.changes.map((change) => (
              <li key={change.id} className="py-3">
                <span>{changeText(change)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_empty()}</p>
        )}
        {session.changesNext ? (
          <Link
            to="/library/progress/$id"
            params={{ id: session.id }}
            search={{
              changes: session.changesNext,
              ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
            }}
            className={buttonClass}
          >
            {m.library_progress_more()}
          </Link>
        ) : null}
      </section>
      <section role="region" aria-labelledby={unitsHeading} className="space-y-3">
        <h2 id={unitsHeading} className="text-xl font-semibold">
          {m.library_progress_units()}
        </h2>
        {session.units.length ? (
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {session.units.map((unit) => (
              <li key={unit} className="py-2">
                {unit}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_empty()}</p>
        )}
        {session.unitsNext ? (
          <Link
            to="/library/progress/$id"
            params={{ id: session.id }}
            search={{
              units: session.unitsNext,
              ...(page.changesCursor ? { changes: page.changesCursor } : {}),
            }}
            className={buttonClass}
          >
            {m.library_progress_more()}
          </Link>
        ) : null}
      </section>
    </article>
  );
}
