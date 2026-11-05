import { VNDB_APPLY, VNDB_ID, VNDB_ROWS, type VndbApplyRow, type VndbReviewInput } from './contract';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid VNDB import');
  return value as Record<string, unknown>;
}

export function requireVndbId(value: unknown): string {
  if (typeof value !== 'string' || !VNDB_ID.test(value)) throw new Error('Invalid VNDB import');
  return value;
}

export function requireVndbOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= VNDB_ROWS)
    throw new Error('Invalid VNDB import');
  return value;
}

type ProgressInput = Extract<VndbReviewInput, { action: 'progress' }>['progress'];

function progressBody(value: unknown): ProgressInput {
  const body = object(value);
  const selected = object(body.occurrence);
  let occurrence: ProgressInput['occurrence'];
  if (selected.kind === 'existing') occurrence = { kind: 'existing', sessionId: requireVndbId(selected.sessionId) };
  else if (
    selected.kind === 'start' &&
    typeof selected.primaryUnit === 'string' &&
    selected.primaryUnit.length > 0 &&
    selected.primaryUnit.length <= 64
  )
    occurrence = { kind: 'start', primaryUnit: selected.primaryUnit };
  else throw new Error('Invalid VNDB import');
  if (!Array.isArray(body.measures) || !body.measures.length || body.measures.length > 8)
    throw new Error('Invalid VNDB import');
  const measures = body.measures.map((value): ProgressInput['measures'][number] => {
    const measure = object(value);
    if (
      typeof measure.field !== 'string' ||
      !measure.field.length ||
      measure.field.length > 64 ||
      (measure.action !== 'adopt' && measure.action !== 'clear') ||
      (measure.replace !== undefined && typeof measure.replace !== 'boolean')
    )
      throw new Error('Invalid VNDB import');
    return {
      field: measure.field,
      action: measure.action,
      ...(measure.replace === undefined ? {} : { replace: measure.replace }),
    };
  });
  return { occurrence, measures };
}

/** Server-function request boundary; retain every explicitly selected native operand. */
export function vndbReviewBody(value: unknown): VndbReviewInput {
  const body = object(value);
  const ordinal = requireVndbOrdinal(body.ordinal);
  const target = body.targetId === undefined ? {} : { targetId: requireVndbId(body.targetId) };
  if (body.action === 'skip' || body.action === 'retain') return { ordinal, action: body.action, ...target };
  if (body.action === 'progress')
    return { ordinal, action: 'progress', ...target, progress: progressBody(body.progress) };
  if (body.action === 'state') {
    if (
      typeof body.state !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(body.state) ||
      (body.replace !== undefined && typeof body.replace !== 'boolean')
    )
      throw new Error('Invalid VNDB import');
    return {
      ordinal,
      action: 'state',
      ...target,
      state: body.state,
      ...(body.replace === undefined ? {} : { replace: body.replace }),
      ...(body.progress === undefined ? {} : { progress: progressBody(body.progress) }),
    };
  }
  if (body.action !== 'score') throw new Error('Invalid VNDB import');
  const selection = object(body.selection);
  if (!Number.isSafeInteger(body.questionRevision) || Number(body.questionRevision) < 1)
    throw new Error('Invalid VNDB import');
  if (body.consent !== 'adopt-native-vote' && body.consent !== 'clear-native-vote')
    throw new Error('Invalid VNDB import');
  if (
    selection.kind !== 'clear' &&
    (selection.kind !== 'vote' ||
      !Number.isSafeInteger(selection.units) ||
      Number(selection.units) < 0 ||
      Number(selection.units) > 20)
  )
    throw new Error('Invalid VNDB import');
  if (body.consent !== (selection.kind === 'clear' ? 'clear-native-vote' : 'adopt-native-vote'))
    throw new Error('Invalid VNDB import');
  return {
    ordinal,
    action: 'score',
    ...target,
    questionId: requireVndbId(body.questionId),
    questionRevision: Number(body.questionRevision),
    consent: body.consent,
    selection: selection.kind === 'clear' ? { kind: 'clear' } : { kind: 'vote', units: Number(selection.units) },
  };
}

export function vndbApplyBody(value: unknown): { rows: VndbApplyRow[] } {
  const body = object(value);
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > VNDB_APPLY)
    throw new Error('Invalid VNDB import');
  const rows = body.rows.map((value): VndbApplyRow => {
    const row = object(value);
    if (row.reviewId === undefined && row.scoreReviewId === undefined) throw new Error('Invalid VNDB import');
    return {
      ordinal: requireVndbOrdinal(row.ordinal),
      ...(row.reviewId === undefined ? {} : { reviewId: requireVndbId(row.reviewId) }),
      ...(row.scoreReviewId === undefined ? {} : { scoreReviewId: requireVndbId(row.scoreReviewId) }),
    };
  });
  if (rows.reduce((total, row) => total + Number(!!row.reviewId) + Number(!!row.scoreReviewId), 0) > VNDB_APPLY)
    throw new Error('Invalid VNDB import');
  return { rows };
}
