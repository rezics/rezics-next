import { useId, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { Exposure } from '../../kernel/exposure';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ProgressDecimalInput, ProgressInputError } from '../progress-decimal-input-field';
import { progressDecimalIssue } from '../progress-decimal-input';
import { libraryUnitLabel } from '../profiles';
import type { Release } from '../../subject/definitions';
import { recordProgressSession, startProgressSession } from '../progress-server';
import { readConfiguredProgressHistory } from './actions';
import {
  createGuardedCommand,
  dispatchGuardedCommand,
  progressWriteOutcome,
  type GuardedCommand,
  type GuardedOutcome,
  type GuardedSender,
} from './commands';
import type { VisitProgress } from './visit';
import type {
  ProgressChange,
  ProgressFailure,
  ProgressRecorded,
  ProgressRecordInput,
  ProgressSessionPage,
  ProgressStartInput,
  ProgressStarted,
} from '../progress-reads';
import { progressFailureMessage, progressView } from '../progress-label';
import { useAuthoringDeparture } from '../../threads/authoring-departure';

const target =
  'min-h-11 min-w-11 max-w-full cursor-pointer whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const button = `${target} inline-flex items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60`;
const quiet = `${target} inline-flex items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60`;
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';
type StartResult = ProgressStarted | ProgressFailure;
type RecordResult = ProgressRecorded | ProgressFailure;
const startSender = startProgressSession as GuardedSender<ProgressStartInput, StartResult>;
const recordSender = recordProgressSession as GuardedSender<ProgressRecordInput, RecordResult>;

export function ConfiguredProgressPanel({
  subjectId,
  type,
  locale,
  release,
  progress,
  credential,
  current,
  onAcknowledged,
}: {
  subjectId: string;
  type: string;
  locale: string;
  release: Release | undefined;
  progress: VisitProgress;
  credential: string;
  current: () => boolean;
  onAcknowledged: () => void;
}) {
  const headingId = useId();
  const inputId = useId();
  const errorId = useId();
  const stored =
    progress.meaning === 'unsupported' ? '' : progress.meaning === 'absent' ? '' : (progress.session.amount ?? '');
  const [draft, setDraft] = useState(stored);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<GuardedOutcome | null>(null);
  const [history, setHistory] = useState<{ open: boolean; page: ProgressSessionPage | null; error: boolean }>({
    open: false,
    page: null,
    error: false,
  });
  const startIntent = useRef<GuardedCommand<ProgressStartInput, StartResult> | null>(null);
  const recordIntent = useRef<GuardedCommand<ProgressRecordInput, RecordResult> | null>(null);
  const rules = progress.meaning === 'unsupported' ? undefined : progress.rules;
  const issue = progressDecimalIssue(draft, rules ?? {}, true);
  const unitLabel =
    progress.meaning === 'unsupported'
      ? m.library_progress_unit_unspecified()
      : (progress.session && 'session' in progress && progress.session.unitLabel) ||
        (release
          ? libraryUnitLabel(release, type, progress.measure.mode, progress.measure.unit.id, locale)?.text
          : undefined) ||
        progress.measure.unit.id;
  const display =
    progress.meaning === 'recorded' || progress.meaning === 'zero'
      ? progressView(
          {
            mode: progress.measure.mode,
            unit: progress.measure.unit.id,
            amount: progress.session.amount,
            total: progress.session.total,
            completedUnitCount: Number(progress.session.amount ?? 0),
            locator: null,
            ...(progress.session.unitLabel ? { unitLabel: progress.session.unitLabel } : {}),
          },
          locale,
        )
      : null;
  const dirty = draft !== stored;
  const locked = pending || startIntent.current !== null || recordIntent.current !== null;
  useAuthoringDeparture(
    () => dirty || locked,
    () => locked,
    `${subjectId}:${progress.meaning}:${'session' in progress ? progress.session.id : ''}:${draft}`,
  );

  function settle(result: GuardedOutcome) {
    setOutcome(result);
    if (result.state === 'acknowledged' || result.state === 'conflict') {
      startIntent.current = null;
      recordIntent.current = null;
      onAcknowledged();
    }
  }

  async function recordAmount(sessionId: string, revision: number, measureId: string) {
    const record =
      recordIntent.current ??
      createGuardedCommand<ProgressRecordInput, RecordResult>(recordSender, credential, {
        sessionId,
        revision,
        measureId,
        amount: draft.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
    recordIntent.current = record;
    const recorded = await dispatchGuardedCommand(record, current);
    if (!recorded || !current()) return;
    settle(progressWriteOutcome(recorded));
  }

  async function save() {
    if (!current() || progress.meaning === 'unsupported' || pending) return;
    setSubmitted(true);
    if (issue) return;
    setPending(true);
    setOutcome(null);
    try {
      if (progress.meaning === 'absent' && !('session' in progress)) {
        const start =
          startIntent.current ??
          createGuardedCommand<ProgressStartInput, StartResult>(startSender, credential, {
            subjectId,
            mode: progress.measure.mode,
            unit: progress.measure.unit.id,
            idempotencyKey: crypto.randomUUID(),
          });
        startIntent.current = start;
        const started = await dispatchGuardedCommand(start, current);
        if (!started || !current()) return;
        const startOutcome = progressWriteOutcome(started);
        if (startOutcome.state !== 'acknowledged' || !started.ok) {
          settle(startOutcome);
          return;
        }
        await recordAmount(started.id, 1, progress.measure.unit.id);
        return;
      }
      if (!('session' in progress)) return;
      await recordAmount(progress.session.id, progress.session.revision, progress.session.unit);
    } finally {
      if (current()) setPending(false);
    }
  }

  async function clearAmount() {
    if (!current() || !('session' in progress) || pending) return;
    setPending(true);
    setOutcome(null);
    try {
      const record =
        recordIntent.current ??
        createGuardedCommand<ProgressRecordInput, RecordResult>(recordSender, credential, {
          sessionId: progress.session.id,
          revision: progress.session.revision,
          measureId: progress.session.unit,
          clear: true,
          idempotencyKey: crypto.randomUUID(),
        });
      recordIntent.current = record;
      const recorded = await dispatchGuardedCommand(record, current);
      if (!recorded || !current()) return;
      const result = progressWriteOutcome(recorded);
      setOutcome(result);
      if (result.state === 'acknowledged' || result.state === 'conflict') {
        recordIntent.current = null;
        if (result.state === 'acknowledged') setDraft('');
        onAcknowledged();
      }
    } finally {
      if (current()) setPending(false);
    }
  }

  async function retry() {
    if (!current() || progress.meaning === 'unsupported') return;
    setPending(true);
    try {
      if (recordIntent.current) {
        const recorded = await dispatchGuardedCommand(recordIntent.current, current);
        if (!recorded || !current()) return;
        settle(progressWriteOutcome(recorded));
        return;
      }
      if (!startIntent.current) return;
      const started = await dispatchGuardedCommand(startIntent.current, current);
      if (!started || !current()) return;
      const startOutcome = progressWriteOutcome(started);
      if (startOutcome.state !== 'acknowledged' || !started.ok) {
        settle(startOutcome);
        return;
      }
      await recordAmount(started.id, 1, progress.measure.unit.id);
    } finally {
      if (current()) setPending(false);
    }
  }

  async function openHistory() {
    if (!current() || !('session' in progress)) return;
    const open = !history.open;
    setHistory((currentHistory) => ({ ...currentHistory, open }));
    if (!open || history.page) return;
    try {
      const page = await readConfiguredProgressHistory({ data: { id: progress.session.id } });
      if (!current()) return;
      setHistory({ open: true, page, error: false });
    } catch {
      if (current()) setHistory({ open: true, page: null, error: true });
    }
  }

  if (progress.meaning === 'unsupported') {
    return (
      <section className="min-w-0 space-y-2" aria-labelledby={headingId}>
        <h3 id={headingId} className="text-base font-medium">
          {m.library_configured_progress_heading()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.library_progress_unsupported()}</p>
      </section>
    );
  }

  const changes: ProgressChange[] = history.page && history.page.signedIn ? history.page.session.changes : [];

  return (
    <section className="min-w-0 space-y-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-medium">
        {m.library_configured_progress_heading()}
      </h3>
      {progress.meaning === 'absent' ? (
        <p className="text-sm text-muted-foreground">{m.library_configured_absent_progress()}</p>
      ) : progress.meaning === 'zero' ? (
        <p className="text-sm">{m.library_configured_progress_zero()}</p>
      ) : progress.meaning === 'historical' ? (
        <p className="text-sm text-muted-foreground">{m.library_configured_historical()}</p>
      ) : display ? (
        <p className="text-sm">{display.text}</p>
      ) : null}
      <Field>
        <FieldLabel htmlFor={inputId}>{unitLabel}</FieldLabel>
        <ProgressDecimalInput
          id={inputId}
          value={draft}
          issue={submitted ? issue : null}
          rules={rules}
          aria-describedby={submitted && issue ? errorId : undefined}
          onChange={(event) => current() && setDraft(event.currentTarget.value)}
        />
        <ProgressInputError id={errorId} issue={submitted ? issue : null} rules={rules} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Exposure operation="progress_session.record">
          <button type="button" className={button} disabled={pending} onClick={() => void save()}>
            {progress.meaning === 'absent' && !('session' in progress)
              ? m.library_configured_start_progress()
              : m.library_configured_record_progress()}
          </button>
        </Exposure>
        {'session' in progress ? (
          <Exposure operation="progress_session.record">
            <button type="button" className={quiet} disabled={pending} onClick={() => void clearAmount()}>
              {m.library_configured_clear_progress()}
            </button>
          </Exposure>
        ) : null}
        {'session' in progress ? (
          <a
            data-configured-progress-session
            className={linkClass}
            href={`/${locale}/library/progress/${encodeURIComponent(progress.session.id)}`}
          >
            {m.library_progress_open()}
          </a>
        ) : null}
      </div>
      {outcome?.state === 'conflict' ? <p role="alert">{m.library_configured_conflict()}</p> : null}
      {outcome?.state === 'acknowledged' ? <p role="status">{m.library_configured_saved()}</p> : null}
      {outcome && outcome.state !== 'acknowledged' && outcome.state !== 'conflict' ? (
        <p role="alert">
          {outcome.state === 'unsupported'
            ? m.library_progress_unsupported()
            : outcome.state === 'refused'
              ? m.library_progress_refused()
              : outcome.state === 'invalid'
                ? progressFailureMessage('invalid')
                : m.library_progress_unavailable()}
        </p>
      ) : null}
      {outcome?.state === 'unavailable' ? (
        <button type="button" className={quiet} disabled={pending} onClick={() => void retry()}>
          {m.library_configured_retry()}
        </button>
      ) : null}
      {'session' in progress ? (
        <div>
          <button type="button" className={quiet} onClick={() => void openHistory()}>
            {m.library_configured_history()}
          </button>
          {history.open ? (
            history.error ? (
              <p role="alert" className="mt-2 text-sm">
                {m.library_progress_unavailable()}
              </p>
            ) : changes.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{m.library_configured_history_empty()}</p>
            ) : (
              <ol className="mt-2 space-y-1 text-sm">
                {changes.map((change) => (
                  <li key={change.id}>
                    {change.amount ?? change.action ?? change.locator ?? m.library_progress_change_recorded()}
                  </li>
                ))}
              </ol>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
