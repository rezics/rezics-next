import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import type { ProgressSessionPage, ProgressSessionView, ProgressSnapshot } from '../progress-reads';
import { progressDecimalIssue } from '../progress-decimal-input';
import {
  collectEdits,
  sessionHasIndependentMeasures,
  type IndependentVisit,
} from './contract';
import {
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
  logsCursor?: string;
};

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
  const commands = useRef<ReturnType<typeof bindMeasureCommand>[]>([]);
  const token = {};
  const rendered = useRef(token);
  rendered.current = token;
  const current = () => rendered.current === token && isCurrent();
  useLayoutEffect(() => {
    return () => {
      rendered.current = {};
    };
  }, []);
  useEffect(() => {
    const next = projectIndependentMeasures(session);
    setVisit((current) => {
      if (current.sessionId !== session.id) return readyVisit(session.id, session.revision, next);
      if (session.revision > current.revision && current.kind !== 'submitting') {
        return refreshIndependentVisit(current, session.revision, next);
      }
      return current;
    });
  }, [session.id, session.revision, session.unit, session.mode, session.measures]);
  useAuthoringDeparture(
    () => current() && independentDirty(visit),
    () => current() && independentLocked(visit),
    `${session.id}:${visit.revision}:${visit.drafts.map((draft) => `${draft.unit}:${draft.text}:${draft.clear}`).join('|')}`,
  );

  async function refresh() {
    if (!current()) return;
    const page = await onRefresh();
    if (!current() || !page?.signedIn) return;
    setVisit(refreshIndependentVisit(visit, page.session.revision, projectIndependentMeasures(page.session)));
  }

  async function submit() {
    if (!current() || visit.kind === 'submitting') return;
    const headers = credential();
    if (!headers) return;
    const edits = collectEdits(visit.measures, visit.drafts);
    for (const edit of edits) {
      if (edit.kind === 'amount') {
        const measure = visit.measures.find((item) => item.unit === edit.unit);
        if (progressDecimalIssue(edit.amount ?? '', measure?.inputRules ?? {}, true)) return;
      }
    }
    const staged = stageIndependentReview(visit);
    setVisit({ ...staged, kind: 'submitting' });
    const result = await submitIndependentVisit(staged, headers, current, sender, commands.current);
    if (!current()) return;
    commands.current = result.commands;
    setVisit(result.visit);
    if (result.visit.outcome?.state === 'acknowledged' || result.visit.outcome?.state === 'partial') {
      const snapshot = result.visit.outcome.snapshot;
      if (snapshot) onAcknowledged(snapshot);
    }
  }

  async function retry() {
    if (!current() || !visit.retry) return;
    const command = bindMeasureCommand(visit.retry, sender);
    try {
      const result = await retryOriginal(command, current);
      if (!result || !current()) return;
      if (result.ok) {
        onAcknowledged(result.session);
        setVisit(refreshIndependentVisit({ ...visit, retry: null, outcome: null }, result.session.revision, visit.measures, result.session));
        return;
      }
      setVisit(applyIndependentOutcome(visit, outcomeFromResult(visit.retry, result, visit.edits)));
    } catch {
      if (current()) setVisit(applyIndependentOutcome(visit, { state: 'uncertain', command: visit.retry }));
    }
  }

  if (!sessionHasIndependentMeasures(session) || measures.length <= 1) {
    return <IndependentMeasuresRecovery kind="empty" />;
  }
  if (visit.kind === 'denied') {
    return <IndependentMeasuresRecovery kind="denied" onRetry={() => void refresh()} />;
  }
  if (visit.kind === 'unavailable') {
    return <IndependentMeasuresRecovery kind="unavailable" seam={visit.seam} onRetry={() => void refresh()} />;
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
          onConfirm={() => void submit()}
          onCancel={() => current() && !visit.retry && setVisit(cancelIndependentReview(visit))}
        />
      ) : (
        <IndependentMeasuresEditor
          measures={visit.measures}
          drafts={visit.drafts}
          submitted={false}
          busy={busy}
          onDraft={(unit, text) => current() && setVisit(editMeasure(visit, unit, { text }))}
          onClear={(unit) => current() && setVisit(editMeasure(visit, unit, { clear: true }))}
          onReview={() => current() && setVisit(stageIndependentReview(visit))}
        />
      )}
      <IndependentMeasuresResult
        outcome={visit.outcome}
        onRetry={visit.retry ? () => void retry() : undefined}
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
