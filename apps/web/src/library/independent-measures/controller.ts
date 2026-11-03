import type { ProgressSnapshot } from '../progress-reads';
import {
  applySnapshot,
  collectEdits,
  draftsFrom,
  draftDirty,
  replaceDraft,
  type IndependentCommand,
  type IndependentMeasure,
  type IndependentOutcome,
  type IndependentVisit,
  type MeasureDraft,
  type MeasureEdit,
} from './contract';
import { bindMeasureCommand, submitIndependentEdits, type BoundMeasureCommand, type MeasureSender } from './commands';

export type IndependentController = {
  visit: IndependentVisit;
  commands: BoundMeasureCommand[];
};

export function readyVisit(
  sessionId: string,
  revision: number,
  measures: IndependentMeasure[],
  drafts?: MeasureDraft[],
): IndependentVisit {
  return {
    kind: 'ready',
    sessionId,
    revision,
    measures,
    drafts: drafts ?? draftsFrom(measures),
    edits: [],
    outcome: null,
    retry: null,
  };
}

export function editMeasure(visit: IndependentVisit, unit: string, change: Partial<MeasureDraft>): IndependentVisit {
  if (visit.kind === 'submitting' || visit.retry) return visit;
  const drafts = replaceDraft(visit.drafts, unit, change);
  return { ...visit, kind: visit.kind === 'review' ? 'ready' : visit.kind === 'preparing' ? 'preparing' : 'ready', drafts, edits: collectEdits(visit.measures, drafts), outcome: visit.kind === 'review' ? null : visit.outcome };
}

export function stageIndependentReview(visit: IndependentVisit): IndependentVisit {
  const edits = collectEdits(visit.measures, visit.drafts);
  if (!edits.length) return { ...visit, kind: 'ready', edits };
  return { ...visit, kind: 'review', edits, outcome: null };
}

export function cancelIndependentReview(visit: IndependentVisit): IndependentVisit {
  if (visit.retry) return visit;
  return { ...visit, kind: 'ready', edits: collectEdits(visit.measures, visit.drafts) };
}

function nextDrafts(measures: IndependentMeasure[], drafts: MeasureDraft[], remaining: MeasureEdit[]): MeasureDraft[] {
  const pending = new Set(remaining.map((edit) => edit.unit));
  return measures.map((measure) => {
    const draft = drafts.find((item) => item.unit === measure.unit);
    if (draft && pending.has(measure.unit)) return draft;
    return { unit: measure.unit, text: measure.amount ?? '', clear: false };
  });
}

export function applyIndependentOutcome(visit: IndependentVisit, outcome: IndependentOutcome): IndependentVisit {
  if (outcome.state === 'acknowledged') {
    const measures = applySnapshot(visit.measures, outcome.snapshot);
    return {
      kind: 'ready',
      sessionId: visit.sessionId,
      revision: outcome.revision,
      measures,
      drafts: draftsFrom(measures),
      edits: [],
      outcome,
      retry: null,
    };
  }
  if (outcome.state === 'partial') {
    const measures = applySnapshot(visit.measures, outcome.snapshot);
    const drafts = nextDrafts(measures, visit.drafts, outcome.remaining);
    return {
      kind: 'review',
      sessionId: visit.sessionId,
      revision: outcome.revision,
      measures,
      drafts,
      edits: outcome.remaining,
      outcome,
      retry: outcome.failed,
    };
  }
  if (outcome.state === 'conflict') {
    return { ...visit, kind: 'stale', outcome, retry: outcome.command };
  }
  if (outcome.state === 'uncertain' || outcome.state === 'unavailable') {
    return { ...visit, kind: visit.kind === 'submitting' ? 'review' : visit.kind, outcome, retry: outcome.command };
  }
  if (outcome.state === 'refused') {
    return { ...visit, kind: 'denied', outcome, retry: null };
  }
  if (outcome.state === 'unsupported') {
    return { ...visit, kind: 'unavailable', outcome, retry: null, seam: visit.seam };
  }
  return { ...visit, kind: 'ready', outcome, retry: null };
}

export function refreshIndependentVisit(
  visit: IndependentVisit,
  revision: number,
  measures: IndependentMeasure[],
  snapshot?: ProgressSnapshot,
): IndependentVisit {
  const nextMeasures = snapshot ? applySnapshot(measures, snapshot) : measures;
  const drafts = visit.drafts.map((draft) => {
    const measure = nextMeasures.find((item) => item.unit === draft.unit);
    if (!measure) return draft;
    if (draftDirty(measure, draft) || draft.clear) return draft;
    return { unit: measure.unit, text: measure.amount ?? '', clear: false };
  });
  const retry = visit.retry;
  return {
    ...visit,
    kind: retry ? 'review' : 'ready',
    revision,
    measures: nextMeasures,
    drafts,
    edits: collectEdits(nextMeasures, drafts),
    outcome: visit.outcome?.state === 'conflict' ? null : visit.outcome,
    retry,
  };
}

export async function submitIndependentVisit(
  visit: IndependentVisit,
  credential: HeadersInit,
  current: () => boolean,
  sender: MeasureSender,
  captured?: BoundMeasureCommand[],
): Promise<{ visit: IndependentVisit; commands: BoundMeasureCommand[] }> {
  const edits = visit.edits.length ? visit.edits : collectEdits(visit.measures, visit.drafts);
  if (!edits.length) return { visit: { ...visit, kind: 'ready' }, commands: captured ?? [] };
  const submitting: IndependentVisit = { ...visit, kind: 'submitting', edits };
  const retry = visit.retry ? bindMeasureCommand(visit.retry, sender) : undefined;
  const result = await submitIndependentEdits(
    visit.sessionId,
    visit.revision,
    edits,
    credential,
    current,
    sender,
    edits.map((edit, index) => (retry && index === 0 ? retry.key : crypto.randomUUID())),
    retry ? [retry, ...(captured ?? []).slice(1)] : captured,
  );
  if (!current()) return { visit: applyIndependentOutcome(submitting, { state: 'uncertain', command: result.commands[0] ?? retry! }), commands: result.commands };
  return { visit: applyIndependentOutcome(submitting, result.outcome), commands: result.commands };
}

export function independentDirty(visit: IndependentVisit): boolean {
  return visit.measures.some((measure) => {
    const draft = visit.drafts.find((item) => item.unit === measure.unit);
    return draft ? draftDirty(measure, draft) : false;
  });
}

export function independentLocked(visit: IndependentVisit): boolean {
  return visit.kind === 'submitting' || visit.retry !== null;
}
