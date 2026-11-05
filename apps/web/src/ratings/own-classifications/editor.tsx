import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { captureClassificationIntent, classificationActionAllowed, type ClassificationIntent } from './intent';
import type {
  ClassificationCommandResult,
  ClassificationReview,
  OwnClassification,
  OwnClassificationsRead,
} from './types';

export type ClassificationCommands = {
  read: Extract<OwnClassificationsRead, { state: 'ready' }>;
  retire?: () => void;
  csrfToken: () => string | null;
  send: (intent: ClassificationIntent, signal: AbortSignal) => Promise<ClassificationCommandResult>;
  review: (intent: ClassificationIntent, signal: AbortSignal) => Promise<ClassificationReview>;
  departure?: (dirty: boolean, locked: boolean, current: () => boolean, retire: () => void) => ReactNode;
};

/** One selected exact slot owns its draft, immutable request and independent current readback. */
export function ClassificationEditor({
  row,
  commands,
  isCurrent,
  refresh,
  onProtection,
  locale,
}: {
  row: OwnClassification;
  commands: ClassificationCommands;
  isCurrent: () => boolean;
  refresh: () => Promise<unknown>;
  onProtection: (locked: boolean) => void;
  locale: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const [assessment, setAssessment] = useState(row.own.assessment);
  const [falsePositive, setFalsePositive] = useState(row.own.falsePositive);
  const [feedback, setFeedback] = useState<ClassificationCommandResult['kind'] | null>(null);
  const [review, setReview] = useState<ClassificationReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const original = useRef<ClassificationIntent | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const abort = useRef(new AbortController());
  const current = () => {
    if (!mounted.current || abort.current.signal.aborted || !isCurrent()) {
      abort.current.abort();
      return false;
    }
    return true;
  };
  const dirty = feedback === null && (assessment !== row.own.assessment || falsePositive !== row.own.falsePositive);
  const locked = busy || original.current !== null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current.abort();
      original.current = null;
      onProtection(false);
    };
  }, []);
  useEffect(() => {
    onProtection(dirty || busy || feedback === 'uncertain');
  }, [dirty, busy, feedback]);
  const setAllowed = classificationActionAllowed(row, 'PUT');
  const clearAllowed = classificationActionAllowed(row, 'DELETE');

  async function send(method: 'PUT' | 'DELETE', retry = false) {
    if (!current() || pending.current || (!retry && original.current)) return;
    const csrf = commands.csrfToken();
    if (!csrf) return;
    let intent = original.current;
    if (!retry) {
      try {
        intent = captureClassificationIntent(
          commands.read,
          row,
          method,
          csrf,
          method === 'PUT' ? { assessment, falsePositive } : null,
        );
      } catch {
        return;
      }
      original.current = intent;
    }
    if (!intent || intent.csrfToken !== csrf) return;
    pending.current = true;
    setBusy(true);
    setConfirm(false);
    let result: ClassificationCommandResult;
    try {
      result = await commands.send(intent, abort.current.signal);
    } catch {
      result = { kind: 'uncertain' };
    }
    if (!current()) return;
    pending.current = false;
    setBusy(false);
    setFeedback(result.kind);
  }

  async function inspectCurrent() {
    const intent = original.current;
    if (!current() || pending.current || !intent || !intent.readback || commands.csrfToken() !== intent.csrfToken)
      return;
    pending.current = true;
    setBusy(true);
    let result: ClassificationReview;
    try {
      result = await commands.review(intent, abort.current.signal);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!current()) return;
    pending.current = false;
    setBusy(false);
    setReview(result);
    // Reviewing current state never settles or replaces an unknown original command.
  }

  return (
    <div className="min-w-0 space-y-3">
      {commands.departure?.(dirty, busy || feedback === 'uncertain', current, () => {
        abort.current.abort();
        commands.retire?.();
      })}
      {setAllowed ? (
        <fieldset disabled={locked || !isCurrent()} className="space-y-3">
          <legend>{m.subject_classification_assessment_select({}, options)}</legend>
          <label className="grid gap-2">
            <span>{m.subject_classification_assessment_select({}, options)}</span>
            <select
              className="min-h-11 max-w-full rounded border bg-background p-2"
              value={assessment}
              onChange={(event) =>
                current() && setAssessment(event.currentTarget.value === 'oppose' ? 'oppose' : 'support')
              }
            >
              <option value="support">{m.subject_classification_assessment_support({}, options)}</option>
              <option value="oppose">{m.subject_classification_assessment_oppose({}, options)}</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={falsePositive}
              onChange={(event) => current() && setFalsePositive(event.currentTarget.checked)}
            />
            {m.subject_classification_assessment_lie({}, options)}
          </label>
          <Button className="min-h-11 whitespace-normal" disabled={!dirty} onClick={() => void send('PUT')}>
            {m.subject_classification_assessment_change({}, options)}
          </Button>
          {dirty ? (
            <Button
              className="min-h-11"
              variant="outline"
              onClick={() => {
                if (current()) {
                  setAssessment(row.own.assessment);
                  setFalsePositive(row.own.falsePositive);
                }
              }}
            >
              {m.library_my_ratings_cancel({}, options)}
            </Button>
          ) : null}
        </fieldset>
      ) : null}
      {clearAllowed && !locked ? (
        <Button className="min-h-11 whitespace-normal" variant="outline" onClick={() => current() && setConfirm(true)}>
          {m.subject_classification_assessment_withdraw({}, options)}
        </Button>
      ) : null}
      {confirm && current() ? (
        <div
          role="group"
          aria-label={m.subject_classification_assessment_withdraw({}, options)}
          className="flex flex-wrap gap-3"
        >
          <Button className="min-h-11" onClick={() => void send('DELETE')}>
            {m.library_my_ratings_confirm_clear({}, options)}
          </Button>
          <Button className="min-h-11" variant="outline" onClick={() => current() && setConfirm(false)}>
            {m.library_my_ratings_cancel({}, options)}
          </Button>
        </div>
      ) : null}
      {feedback ? (
        <p role="status">
          {feedback === 'uncertain'
            ? m.subject_classification_assessment_uncertain({}, options)
            : feedback === 'acknowledged'
              ? m.own_classifications_acknowledged({}, options)
              : feedback === 'stale'
                ? m.subject_classification_assessment_conflict({}, options)
                : feedback === 'unavailable'
                  ? m.subject_classification_assessment_unavailable({}, options)
                  : m.subject_classification_assessment_denied({}, options)}
        </p>
      ) : null}
      {feedback === 'uncertain' ? (
        <div className="flex flex-wrap gap-3">
          <Button className="min-h-11" disabled={busy} onClick={() => void send(original.current!.method, true)}>
            {m.subject_classification_assessment_retry({}, options)}
          </Button>
          {original.current?.readback ? (
            <Button className="min-h-11" disabled={busy} onClick={() => void inspectCurrent()}>
              {m.own_classifications_readback({}, options)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <div role="status">
          <p>{m.own_classifications_readback_separate({}, options)}</p>
          <p>
            {review.kind === 'unavailable'
              ? m.subject_classification_assessment_unavailable({}, options)
              : !review.own.hasBallot
                ? m.subject_classification_assessment_absent({}, options)
                : review.own.assessment === 'support'
                  ? m.subject_classification_assessment_own_support({}, options)
                  : m.subject_classification_assessment_own_oppose({}, options)}
          </p>
        </div>
      ) : null}
      {feedback && feedback !== 'uncertain' ? (
        <Button className="min-h-11" onClick={() => current() && void refresh()}>
          {m.own_classifications_refresh({}, options)}
        </Button>
      ) : null}
      {!setAllowed && !clearAllowed ? <p>{m.own_classifications_read_only({}, options)}</p> : null}
    </div>
  );
}
