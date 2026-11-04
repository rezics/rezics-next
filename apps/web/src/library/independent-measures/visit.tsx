import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import type { ProgressSessionPage, ProgressSessionView, ProgressSnapshot } from '../progress-reads';
import { progressDecimalIssue } from '../progress-decimal-input';
import { collectEdits, sameCommand, sessionHasIndependentMeasures, type IndependentVisit } from './contract';
import {
  acknowledgeIndependentRetry,
  applyIndependentOutcome,
  cancelIndependentReview,
  editMeasure,
  independentDirty,
  independentLocked,
  readyVisit,
  refreshIndependentVisit,
  stageIndependentReview,
  submitIndependentVisit,
} from './controller';
import { recordProgressSession } from '../progress-server';
import { bindMeasureCommand, outcomeFromResult, retryOriginal, type MeasureSender } from './commands';
import { IndependentMeasuresEditor, IndependentMeasuresReadout } from './editor';
import { IndependentMeasuresReview } from './review';
import { IndependentMeasuresResult } from './result';
import { IndependentMeasuresRecovery, independentActionClass } from './recovery';
import { projectIndependentMeasures } from './contract';

export type IndependentMeasuresHost = {
  session: ProgressSessionView;
  credential: () => HeadersInit | null;
  isCurrent: () => boolean;
  onAcknowledged: (snapshot: ProgressSnapshot) => void;
  onRefresh: () => Promise<ProgressSessionPage | undefined>;
  sender?: MeasureSender;
  logsCursor?: string | undefined;
};

function invalidMeasureUnits(visit: IndependentVisit): string[] {
  return collectEdits(visit.measures, visit.drafts).flatMap((edit) => {
    if (edit.kind !== 'amount') return [];
    const measure = visit.measures.find((item) => item.unit === edit.unit);
    return measure?.recording === 'supported' && progressDecimalIssue(edit.amount ?? '', measure.inputRules ?? {}, true)
      ? [edit.unit]
      : [];
  });
}

export function IndependentMeasuresVisit({
  session,
  credential,
  isCurrent,
  onAcknowledged,
  onRefresh,
  sender = recordProgressSession,
  logsCursor,
}: IndependentMeasuresHost) {
  const measures = projectIndependentMeasures(session);
  const [visit, setVisit] = useState<IndependentVisit>(() => readyVisit(session.id, session.revision, measures));
  const [refreshing, setRefreshing] = useState(false);
  const [validationSubmitted, setValidationSubmitted] = useState(false);
  const refreshingRef = useRef(false);
  const refreshCycle = useRef(0);
  const commands = useRef<ReturnType<typeof bindMeasureCommand>[]>([]);
  const mounted = useRef(false);
  const identity = useRef({ sessionId: session.id, generation: 0 });
  if (identity.current.sessionId !== session.id) {
    identity.current = { sessionId: session.id, generation: identity.current.generation + 1 };
  }
  const actionIdentity = identity.current;
  const isCurrentRef = useRef(isCurrent);
  const onRefreshRef = useRef(onRefresh);
  const onAcknowledgedRef = useRef(onAcknowledged);
  isCurrentRef.current = isCurrent;
  onRefreshRef.current = onRefresh;
  onAcknowledgedRef.current = onAcknowledged;
  const current = () => mounted.current && identity.current === actionIdentity && isCurrentRef.current();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const next = projectIndependentMeasures(session);
    if (commands.current.some((command) => command.operands.sessionId !== session.id)) commands.current = [];
    setVisit((current) => {
      if (current.sessionId !== session.id) return readyVisit(session.id, session.revision, next);
      if (session.revision >= current.revision && current.kind !== 'submitting') {
        return refreshIndependentVisit(current, session.revision, next);
      }
      return current;
    });
  }, [session.id, session.revision, session.unit, session.mode, session.measures]);
  useEffect(() => {
    refreshCycle.current += 1;
    refreshingRef.current = false;
    setRefreshing(false);
  }, [session.id]);
  useEffect(() => setValidationSubmitted(false), [session.id, visit.revision]);
  useAuthoringDeparture(
    () => current() && independentDirty(visit),
    () => current() && independentLocked(visit),
    `${session.id}:${visit.revision}:${visit.drafts.map((draft) => `${draft.unit}:${draft.text}:${draft.clear}`).join('|')}`,
  );

  async function refresh() {
    const sessionId = session.id;
    if (!current() || refreshingRef.current) return;
    refreshingRef.current = true;
    const cycle = ++refreshCycle.current;
    setRefreshing(true);
    try {
      const page = await onRefreshRef.current();
      if (!current() || !page?.signedIn || page.session.id !== sessionId) return;
      setValidationSubmitted(false);
      setVisit((latest) => {
        if (latest.sessionId !== sessionId || latest.kind === 'submitting') return latest;
        return refreshIndependentVisit(latest, page.session.revision, projectIndependentMeasures(page.session));
      });
    } finally {
      if (refreshCycle.current === cycle) {
        refreshingRef.current = false;
        if (current()) setRefreshing(false);
      }
    }
  }

  function stageReview() {
    if (!current()) return;
    if (invalidMeasureUnits(visit).length) {
      setValidationSubmitted(true);
      return;
    }
    setValidationSubmitted(false);
    setVisit((latest) => stageIndependentReview(latest));
  }

  async function submit() {
    if (!current() || visit.kind === 'submitting' || visit.retry) return;
    const headers = credential();
    if (!headers) return;
    if (invalidMeasureUnits(visit).length) {
      setValidationSubmitted(true);
      return;
    }
    setValidationSubmitted(false);
    const staged = stageIndependentReview(visit);
    if (staged.kind !== 'review') {
      setVisit(staged);
      return;
    }
    setVisit({ ...staged, kind: 'submitting' });
    const result = await submitIndependentVisit(staged, headers, current, sender, commands.current);
    if (!current()) return;
    commands.current = result.visit.retry ? result.commands : [];
    setVisit((latest) =>
      latest.sessionId === result.visit.sessionId && latest.kind === 'submitting' ? result.visit : latest,
    );
    if (result.visit.outcome?.state === 'acknowledged' || result.visit.outcome?.state === 'partial') {
      const snapshot = result.visit.outcome.snapshot;
      if (snapshot) onAcknowledgedRef.current(snapshot);
    }
  }

  async function retry() {
    if (!current() || !visit.retry) return;
    const original = visit.retry;
    const command =
      commands.current.find((candidate) => sameCommand(candidate, original)) ?? bindMeasureCommand(original, sender);
    try {
      const result = await retryOriginal(command, current);
      if (!result || !current()) return;
      if (result.ok) {
        onAcknowledgedRef.current(result.session);
        commands.current = [];
        setVisit((latest) => {
          if (latest.sessionId !== session.id) return latest;
          return acknowledgeIndependentRetry(latest, original.operands.measureId!, result.session);
        });
        return;
      }
      const outcome = outcomeFromResult(original, result, visit.edits);
      if (!['conflict', 'uncertain', 'unavailable'].includes(outcome.state)) commands.current = [];
      setVisit((latest) => (latest.sessionId === session.id ? applyIndependentOutcome(latest, outcome) : latest));
    } catch {
      if (current()) {
        setVisit((latest) =>
          latest.sessionId === session.id
            ? applyIndependentOutcome(latest, { state: 'uncertain', command: original })
            : latest,
        );
      }
    }
  }

  const correctionUnits = invalidMeasureUnits(visit).filter((unit) =>
    visit.drafts.find((draft) => draft.unit === unit)?.text.trim(),
  );

  if (visit.sessionId !== session.id) return <IndependentMeasuresRecovery kind="preparing" />;
  if (!sessionHasIndependentMeasures(session) || measures.length <= 1) {
    if (!visit.retry) return <IndependentMeasuresRecovery kind="empty" />;
    return (
      <div className="space-y-4">
        <IndependentMeasuresRecovery kind="empty" />
        <IndependentMeasuresResult
          outcome={visit.outcome}
          onRetry={() => void retry()}
          onRefresh={() => void refresh()}
        />
      </div>
    );
  }
  if (visit.kind === 'denied') {
    return <IndependentMeasuresRecovery kind="denied" onRetry={() => void refresh()} />;
  }
  if (visit.kind === 'unavailable') {
    return (
      <IndependentMeasuresRecovery
        kind="unavailable"
        {...(visit.seam === undefined ? {} : { seam: visit.seam })}
        onRetry={() => void refresh()}
      />
    );
  }
  if (visit.kind === 'preparing') {
    return <IndependentMeasuresRecovery kind="preparing" />;
  }

  const busy = visit.kind === 'submitting';
  return (
    <div className="space-y-6">
      <IndependentMeasuresReadout measures={visit.measures} revision={visit.revision} />
      {visit.kind === 'stale' ? <IndependentMeasuresRecovery kind="stale" onRetry={() => void refresh()} /> : null}
      {visit.kind === 'review' || visit.kind === 'submitting' ? (
        <IndependentMeasuresReview
          revision={visit.revision}
          measures={visit.measures}
          edits={visit.edits}
          busy={busy}
          correction={correctionUnits.length > 0}
          {...(visit.retry ? {} : { onConfirm: () => void submit() })}
          {...(visit.retry
            ? {}
            : { onCancel: () => current() && setVisit((latest) => cancelIndependentReview(latest)) })}
        />
      ) : (
        <IndependentMeasuresEditor
          measures={visit.measures}
          drafts={visit.drafts}
          submitted={validationSubmitted}
          correctionUnits={correctionUnits}
          busy={busy}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onDraft={(unit, text) =>
            current() && (setValidationSubmitted(false), setVisit((latest) => editMeasure(latest, unit, { text })))
          }
          onClear={(unit) =>
            current() &&
            (setValidationSubmitted(false), setVisit((latest) => editMeasure(latest, unit, { clear: true })))
          }
          onReview={stageReview}
        />
      )}
      <IndependentMeasuresResult
        outcome={visit.outcome}
        {...(visit.retry ? { onRetry: () => void retry() } : {})}
        onRefresh={() => void refresh()}
      />
      <p>
        <Link
          to="/library/progress/$id"
          params={{ id: session.id }}
          search={logsCursor ? { logs: logsCursor } : {}}
          preload={false}
          className={independentActionClass}
        >
          {m.library_progress_measures_history()}
        </Link>
      </p>
    </div>
  );
}
