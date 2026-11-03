import {
  PROGRESS_MEASURE_CAP,
  type ProgressMeasureView,
  type ProgressRecordInput,
  type ProgressSessionView,
  type ProgressSnapshot,
} from '../progress-reads';

export const INDEPENDENT_MEASURE_SEAM = 'KernelClient.progressSessions({ sessionId }).$record.post';
export const INDEPENDENT_MEASURE_READ_SEAM = 'KernelClient.progressSessions({ sessionId }).get';
export const INDEPENDENT_MEASURE_CREATE_SEAM = 'KernelClient.progressSessions.post';
export { PROGRESS_MEASURE_CAP };

/** Native record addresses one unit; a dual-measure save sequences those records on the shared revision. */
export const INDEPENDENT_RECORD_ADDRESSES_ONE_UNIT = true;

export type MeasureRecording = 'supported' | 'unsupported' | 'unavailable' | 'historical';
export type MeasureValueKind = 'absent' | 'zero' | 'recorded';

export type IndependentDescriptor = {
  unit: string;
  primary: boolean;
  label: string;
  total: string | null;
  meaning: 'known' | 'unknown' | 'unavailable';
  recording: MeasureRecording;
  inputRules?: ProgressMeasureView['inputRules'];
};

export type IndependentMeasure = IndependentDescriptor & {
  amount: string | null;
  kind: MeasureValueKind;
};

export type MeasureDraft = {
  unit: string;
  text: string;
  clear: boolean;
};

export type MeasureEdit = {
  unit: string;
  kind: 'amount' | 'clear';
  amount?: string;
};

export type IndependentCommand = {
  sender: 'recordProgressSession';
  credential: HeadersInit;
  key: string;
  operands: ProgressRecordInput;
};

export type IndependentOutcome =
  | { state: 'acknowledged'; revision: number; snapshot: ProgressSnapshot; remaining: MeasureEdit[] }
  | { state: 'partial'; revision: number; snapshot: ProgressSnapshot; remaining: MeasureEdit[]; failed: IndependentCommand }
  | { state: 'conflict'; command: IndependentCommand; revision: number }
  | { state: 'uncertain'; command: IndependentCommand }
  | { state: 'unsupported'; command: IndependentCommand }
  | { state: 'refused'; command: IndependentCommand }
  | { state: 'invalid'; command: IndependentCommand }
  | { state: 'unavailable'; command: IndependentCommand; seam: typeof INDEPENDENT_MEASURE_SEAM };

export type IndependentVisitKind =
  | 'preparing'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'stale'
  | 'ready'
  | 'review'
  | 'submitting';

export type IndependentVisit = {
  kind: IndependentVisitKind;
  sessionId: string;
  revision: number;
  measures: IndependentMeasure[];
  drafts: MeasureDraft[];
  edits: MeasureEdit[];
  outcome: IndependentOutcome | null;
  retry: IndependentCommand | null;
  seam?: string;
  closed?: boolean;
};

export function measureValueKind(amount: string | null): MeasureValueKind {
  if (amount === null) return 'absent';
  if (amount === '0' || /^0(?:\.0+)?$/.test(amount)) return 'zero';
  return 'recorded';
}

export function recordingOf(measure: ProgressMeasureView): MeasureRecording {
  if (measure.meaning === 'unknown' || measure.meaning === 'unavailable') return 'historical';
  if (measure.recordingState === 'unsupported') return 'unsupported';
  if (measure.recordingState === 'unavailable') return 'unavailable';
  if (measure.recordingState === 'supported') return 'supported';
  return 'unavailable';
}

export function descriptorLabel(measure: ProgressMeasureView): string {
  if (measure.meaning !== 'known') return measure.unit;
  return measure.unitLabel || measure.unit;
}

export function toIndependentMeasure(measure: ProgressMeasureView): IndependentMeasure {
  return {
    unit: measure.unit,
    primary: measure.primary,
    label: descriptorLabel(measure),
    total: measure.total,
    meaning: measure.meaning ?? 'unavailable',
    recording: recordingOf(measure),
    ...(measure.inputRules ? { inputRules: measure.inputRules } : {}),
    amount: measure.amount,
    kind: measureValueKind(measure.amount),
  };
}

/** Primary stays first; additional units keep native order and never replace the primary. */
export function projectIndependentMeasures(session: Pick<ProgressSessionView, 'unit' | 'mode' | 'measures'>): IndependentMeasure[] {
  if (session.mode !== 'scalar_amount' || !session.measures?.length) return [];
  const projected = session.measures.slice(0, PROGRESS_MEASURE_CAP).map(toIndependentMeasure);
  const primary = projected.find((measure) => measure.unit === session.unit) ?? projected[0];
  if (!primary) return [];
  const additional = projected
    .filter((measure) => measure.unit !== primary.unit)
    .slice()
    .sort((left, right) => (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0));
  return [{ ...primary, primary: true }, ...additional.map((measure) => ({ ...measure, primary: false }))];
}

export function sessionHasIndependentMeasures(session: Pick<ProgressSessionView, 'mode' | 'measures'>): boolean {
  return session.mode === 'scalar_amount' && (session.measures?.length ?? 0) > 1;
}

export function draftFor(measure: IndependentMeasure): MeasureDraft {
  return { unit: measure.unit, text: measure.amount ?? '', clear: false };
}

export function draftsFrom(measures: IndependentMeasure[]): MeasureDraft[] {
  return measures.map(draftFor);
}

export function storedText(measure: IndependentMeasure): string {
  return measure.amount ?? '';
}

export function draftDirty(measure: IndependentMeasure, draft: MeasureDraft): boolean {
  if (draft.clear) return measure.amount !== null;
  return draft.text !== storedText(measure);
}

export function collectEdits(measures: IndependentMeasure[], drafts: MeasureDraft[]): MeasureEdit[] {
  const edits: MeasureEdit[] = [];
  for (const measure of measures) {
    const draft = drafts.find((item) => item.unit === measure.unit);
    if (!draft || !draftDirty(measure, draft)) continue;
    if (draft.clear) edits.push({ unit: measure.unit, kind: 'clear' });
    else edits.push({ unit: measure.unit, kind: 'amount', amount: draft.text });
  }
  return edits;
}

export function replaceDraft(drafts: MeasureDraft[], unit: string, change: Partial<MeasureDraft>): MeasureDraft[] {
  return drafts.map((draft) => {
    if (draft.unit !== unit) return draft;
    const next = { ...draft, ...change, unit };
    if (change.clear === true) return { ...next, text: '', clear: true };
    if (change.text !== undefined) return { ...next, clear: false };
    return next;
  });
}

export function retainUnedited(measures: IndependentMeasure[], drafts: MeasureDraft[], unit: string): IndependentMeasure[] {
  return measures.map((measure) => {
    if (measure.unit === unit) return measure;
    const draft = drafts.find((item) => item.unit === measure.unit);
    if (!draft || draftDirty(measure, draft)) return measure;
    return measure;
  });
}

export function applySnapshot(
  measures: IndependentMeasure[],
  snapshot: ProgressSnapshot,
): IndependentMeasure[] {
  const values = snapshot.measures;
  return measures.map((measure) => {
    const next =
      values?.find((item) => item.unit === measure.unit) ??
      (measure.unit === measures.find((item) => item.primary)?.unit
        ? { unit: measure.unit, amount: snapshot.amount, total: snapshot.total }
        : undefined);
    if (!next) return measure;
    return {
      ...measure,
      amount: next.amount,
      total: next.total,
      kind: measureValueKind(next.amount),
    };
  });
}

export function sameCommand(left: IndependentCommand, right: IndependentCommand): boolean {
  return (
    left.sender === right.sender &&
    left.credential === right.credential &&
    left.key === right.key &&
    left.operands === right.operands
  );
}

export function operandsFor(
  sessionId: string,
  revision: number,
  key: string,
  edit: MeasureEdit,
): ProgressRecordInput {
  return {
    sessionId,
    revision,
    idempotencyKey: key,
    measureId: edit.unit,
    ...(edit.kind === 'clear' ? { clear: true as const } : { amount: edit.amount! }),
  };
}
