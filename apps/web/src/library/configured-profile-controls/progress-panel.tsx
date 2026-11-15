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
import { createGuardedCommand, dispatchGuardedCommand, progressWriteOutcome, type GuardedCommand, type GuardedOutcome, type GuardedSender } from './commands';
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
import { Button } from '@rezics/ui/shadcn/button';

const target = 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const button = `shrink-0`;
const quiet = `shrink-0`;
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
  const outcomeId = useId();
  const stored =
    progress.meaning === 'unsupported' ? '' : progress.meaning === 'absent' ? '' : (progress.session.amount ?? '');
  const [draft, setDraft] = useState(stored);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const uncertain = useRef(false);
  const [outcome, setOutcome] = useState<GuardedOutcome | null>(null);
  const [history, setHistory] = useState<{ open: boolean; page: ProgressSessionPage | null; error: boolean }>({
    open: false,
    page: null,
    error: false,
  });
  const startIntent = useRef<{
    command: GuardedCommand<ProgressStartInput, StartResult>;
    amount: string;
    recordKey: string;
  } | null>(null);
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
    if (result.state === 'unavailable') uncertain.current = true;
    if (uncertain.current && result.state !== 'acknowledged' && result.state !== 'conflict') return;
    uncertain.current = false;
    const cleared = recordIntent.current?.operands.clear === true;
    startIntent.current = null;
    recordIntent.current = null;
    if (result.state === 'acknowledged' && cleared) setDraft('');
    if (result.state === 'acknowledged' || result.state === 'conflict') onAcknowledged();
  }

  async function deliver() {
    if (!current() || busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    try {
      const start = startIntent.current;
      if (!recordIntent.current && start) {
        const started = await dispatchGuardedCommand(start.command, current);
        if (!started || !current()) return;
        if (!started.ok) {
          settle(progressWriteOutcome(started));
          return;
        }
        // A recovered start continues the reviewed amount with the same follow-up key.
        recordIntent.current = createGuardedCommand(recordSender, start.command.credential, {
          sessionId: started.id,
          revision: 1,
          measureId: start.command.operands.unit,
          amount: start.amount,
          idempotencyKey: start.recordKey,
        });
      }
      const record = recordIntent.current;
      if (!record) return;
      const recorded = await dispatchGuardedCommand(record, current);
      if (recorded && current()) settle(progressWriteOutcome(recorded));
    } catch {
      if (current()) settle({ state: 'unavailable' });
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  }

  function save() {
    if (!current() || progress.meaning === 'unsupported' || busy.current || startIntent.current || recordIntent.current)
      return;
    setSubmitted(true);
    if (issue) return;
    const amount = draft.trim();
    const session = progress.session;
    if (session) {
      recordIntent.current = createGuardedCommand(recordSender, credential, {
        sessionId: session.id,
        revision: session.revision,
        measureId: session.unit,
        amount,
        idempotencyKey: crypto.randomUUID(),
      });
    } else {
      startIntent.current = {
        command: createGuardedCommand(startSender, credential, {
          subjectId,
          mode: progress.measure.mode,
          unit: progress.measure.unit.id,
          idempotencyKey: crypto.randomUUID(),
        }),
        amount,
        recordKey: crypto.randomUUID(),
      };
    }
    void deliver();
  }

  function clearAmount() {
    if (!current() || progress.meaning === 'unsupported' || busy.current || startIntent.current || recordIntent.current)
      return;
    const session = progress.session;
    if (!session) return;
    recordIntent.current = createGuardedCommand(recordSender, credential, {
      sessionId: session.id,
      revision: session.revision,
      measureId: session.unit,
      clear: true,
      idempotencyKey: crypto.randomUUID(),
    });
    void deliver();
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
          disabled={locked}
          onChange={(event) => current() && !locked && setDraft(event.currentTarget.value)}
        />
        <ProgressInputError id={errorId} issue={submitted ? issue : null} rules={rules} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Exposure operation="progress_session.record">
          <Button type="button" variant="default" className={button} disabled={locked} onClick={save}>
            {progress.meaning === 'absent' && !('session' in progress)
              ? m.library_configured_start_progress()
              : m.library_configured_record_progress()}
          </Button>
        </Exposure>
        {'session' in progress ? (
          <Exposure operation="progress_session.record">
            <Button type="button" variant="outline" className={quiet} disabled={locked} onClick={clearAmount}>
              {m.library_configured_clear_progress()}
            </Button>
          </Exposure>
        ) : null}
      </div>
      {outcome?.state === 'conflict' ? <p role="alert">{m.library_configured_conflict()}</p> : null}
      {outcome?.state === 'acknowledged' ? <p role="status">{m.library_configured_saved()}</p> : null}
      {outcome && outcome.state !== 'acknowledged' && outcome.state !== 'conflict' ? (
        <p
          role="alert"
          id={outcome.state === 'unavailable' ? outcomeId : undefined}
          className="h-auto min-w-0 [overflow-wrap:anywhere]"
        >
          {outcome.state === 'unsupported'
            ? m.library_progress_unsupported()
            : outcome.state === 'refused'
              ? m.library_progress_refused()
              : outcome.state === 'invalid'
                ? progressFailureMessage('invalid')
                : m.library_progress_unavailable()}
        </p>
      ) : null}
      {outcome && uncertain.current ? (
        <Button
          type="button"
          variant="outline" className={quiet}
          disabled={pending}
          aria-describedby={outcome.state === 'unavailable' ? outcomeId : undefined}
          onClick={() => void deliver()}
        >
          {m.library_configured_retry()}
        </Button>
      ) : null}
      {'session' in progress ? (
        <div>
          <Button type="button" variant="outline" className={quiet} onClick={() => void openHistory()}>
            {m.library_configured_history()}
          </Button>
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
