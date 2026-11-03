import type { Actor } from '../request/access.ts';
import { createHash } from 'node:crypto';
import { ProblemError } from '../http/problem.ts';
import { nativeProgressUnit, type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
import { parseProgressMeasureCreate, parseRecord, parseSessionCreate, type ProgressSessionCreate } from './progress.ts';
import type { ProgressPresentation, ProgressSession } from './progress-model.ts';
import type { createSessionCommands } from './sessions.ts';
import { ProgressConflictError } from './sessions.ts';
import { LibraryConflictError } from './entries.ts';
import { LibraryNotFoundError } from './command-support.ts';

export type ProgressSourceValue = {
  field: string;
  unit: string | null;
  state: 'zero' | 'value' | 'missing' | 'unknown' | 'invalid';
  amount?: string;
};
export type ProgressAdoptionInput = {
  occurrence:
    | { kind: 'existing'; sessionId: string }
    | { kind: 'start'; primaryUnit: string };
  measures: { field: string; action: 'adopt' | 'clear'; replace?: boolean }[];
};
export type ProgressProfileBinding = {
  pin: Extract<LibraryProfilePin, { provenance: 'profile' }>;
  epoch: string;
  acceptingType: string;
};
export type ProgressAdoptionPlanMeasure = {
  field: string;
  unit: string | null;
  action: 'adopt' | 'clear';
  replace: boolean;
  state: ProgressSourceValue['state'];
  amount: string | null;
  currentAmount: string | null;
  eligibility: 'ready' | 'missing' | 'unknown' | 'invalid' | 'unsupported';
  reason: string | null;
};
export type ProgressAdoptionPlan = {
  subjectId: string;
  profile: ProgressProfileBinding;
  requestKeySeed: string;
  occurrence:
    | {
        kind: 'existing';
        sessionId: string;
        startedAt: string;
        transactionId: string;
        revision: number;
        state: string;
        mode: string;
        units: string[];
      }
    | {
        kind: 'start';
        primaryUnit: string;
        requestKey: string;
        input: ProgressSessionCreate | null;
        reason: string | null;
      };
  measures: ProgressAdoptionPlanMeasure[];
};
export type ProgressAdoptionMeasureResult = {
  field: string;
  unit: string | null;
  action: 'adopt' | 'clear';
  status:
    | 'applied'
    | 'cleared'
    | 'preserved'
    | 'missing'
    | 'unknown'
    | 'invalid'
    | 'unsupported'
    | 'stale'
    | 'failed'
    | 'unattempted';
  sourceAmount: string | null;
  currentAmount: string | null;
  reason: string | null;
};
export type ProgressAdoptionCheckpoint = {
  startAttempted?: boolean;
  occurrence: { sessionId: string; startedAt: string; transactionId: string; revision: number } | null;
  lastRevision: number | null;
  steps: Record<
    string,
    {
      requestKey: string;
      revision: number;
      attempted: boolean;
      result?: ProgressAdoptionMeasureResult;
    }
  >;
  measures: ProgressAdoptionMeasureResult[];
  complete: boolean;
};

type SessionCommands = ReturnType<typeof createSessionCommands>;
type Presented = {
  session: ProgressSession;
  presentation: ProgressPresentation;
  measurePresentations: readonly { unit: string; presentation: ProgressPresentation }[];
};
type NativeCommand =
  | Awaited<ReturnType<SessionCommands['startSession']>>
  | Awaited<ReturnType<SessionCommands['recordProgress']>>;

export function progressMeasureUnit(
  profile: LibraryProfileDescriptor | null,
  unit: string | null,
): ReturnType<typeof nativeProgressUnit> {
  return profile && unit ? nativeProgressUnit(profile, { mode: 'scalar_amount', unit }) : null;
}

function bindingMatches(left: ProgressProfileBinding, right: ProgressProfileBinding | null): boolean {
  return right !== null &&
    left.epoch === right.epoch &&
    left.acceptingType === right.acceptingType &&
    left.pin.provenance === right.pin.provenance &&
    left.pin.releaseDigest === right.pin.releaseDigest &&
    left.pin.profileId === right.pin.profileId &&
    left.pin.acceptingType === right.pin.acceptingType;
}

function staleError(error: unknown) {
  return error instanceof ProgressConflictError ||
    error instanceof LibraryConflictError ||
    error instanceof LibraryNotFoundError ||
    (error instanceof ProblemError && ['unsupported_library_profile', 'not_found', 'conflict'].includes(error.code));
}

export function describeProgressSources(
  profile: LibraryProfileDescriptor | null,
  sources: readonly ProgressSourceValue[],
) {
  return sources.map((source) => {
    const descriptor = progressMeasureUnit(profile, source.unit);
    const amount = source.amount ?? null;
    const numeric = source.state === 'zero' || source.state === 'value';
    const parsed = numeric && amount !== null && descriptor
      ? parseRecord('scalar_amount', { amount }, { unit: source.unit!, state: 'active' }, descriptor)
      : null;
    const supported = descriptor !== null && (!numeric || parsed?.ok === true);
    return {
      field: source.field,
      unit: source.unit,
      state: source.state,
      unitSupported: descriptor !== null,
      ...(amount === null ? {} : { amount }),
      eligibility: !numeric ? source.state : !supported ? 'unsupported' : 'ready',
      reason:
        source.unit === null
          ? 'source-field-has-no-unit-mapping'
          : descriptor === null
            ? 'current-profile-does-not-admit-scalar-unit'
            : numeric && parsed?.ok !== true
              ? 'source-value-is-outside-current-profile-rules'
              : null,
    } as const;
  });
}

function amountOf(session: ProgressSession, unit: string): string | null {
  if (session.unit === unit) return session.amount;
  return session.measures?.find((measure) => measure.unit === unit)?.amount ?? null;
}

function hasUnit(session: ProgressSession, unit: string): boolean {
  return session.unit === unit || Boolean(session.measures?.some((measure) => measure.unit === unit));
}

function recordingFor(presented: Presented, unit: string) {
  return unit === presented.session.unit
    ? presented.presentation.recording.state
    : (presented.measurePresentations.find((measure) => measure.unit === unit)?.presentation.recording.state ??
        'unavailable');
}

async function inspect(sessions: SessionCommands, actor: Actor, sessionId: string): Promise<Presented> {
  return sessions.readPresentedSession(actor, sessionId, async (session, presentation, _disclosure, measures) => ({
    session,
    presentation,
    measurePresentations: measures,
  }));
}

export async function reviewProgressAdoption(
  sessions: SessionCommands,
  actor: Actor,
  subjectId: string,
  profile: LibraryProfileDescriptor,
  binding: ProgressProfileBinding,
  sourceValues: readonly ProgressSourceValue[],
  input: ProgressAdoptionInput,
  startRequestKey: string,
): Promise<ProgressAdoptionPlan> {
  if (!input.measures.length || input.measures.length > 8 || new Set(input.measures.map((m) => m.field)).size !== input.measures.length)
    throw new ProblemError('invalid_request');
  const sourceByField = new Map(sourceValues.map((source) => [source.field, source]));
  if (input.measures.some((measure) => !sourceByField.has(measure.field))) throw new ProblemError('invalid_request');

  let presented: Presented | null = null;
  if (input.occurrence.kind === 'existing') presented = await inspect(sessions, actor, input.occurrence.sessionId);
  if (presented && presented.session.subjectId !== subjectId) throw new ProblemError('not_found');
  const current = presented?.session;
  const measurePlans: ProgressAdoptionPlanMeasure[] = input.measures.map((selection) => {
    const source = sourceByField.get(selection.field)!;
    const descriptor = progressMeasureUnit(profile, source.unit);
    const numeric = source.state === 'value' || source.state === 'zero';
    const nonNumericState = source.state === 'missing' || source.state === 'unknown' || source.state === 'invalid'
      ? source.state
      : 'invalid';
    let eligibility: ProgressAdoptionPlanMeasure['eligibility'] =
      selection.action === 'adopt' && !numeric
        ? nonNumericState
        : descriptor === null
          ? 'unsupported'
          : 'ready';
    let reason: string | null = null;
    if (selection.action === 'adopt' && !numeric) {
      eligibility = nonNumericState;
      reason = source.unit === null
        ? 'source-field-has-no-unit-mapping'
        : descriptor === null
          ? 'current-profile-does-not-admit-scalar-unit'
          : null;
    } else if (source.unit === null || !descriptor) {
      eligibility = 'unsupported';
      reason = source.unit === null ? 'source-field-has-no-unit-mapping' : 'current-profile-does-not-admit-scalar-unit';
    } else if (selection.action === 'adopt' && (!source.amount || !parseRecord(
      'scalar_amount',
      { amount: source.amount },
      { unit: source.unit, state: 'active' },
      descriptor,
    ).ok)) {
      eligibility = 'invalid';
      reason = 'source-value-is-outside-current-profile-rules';
    }
    if (input.occurrence.kind === 'existing' && current && (selection.action === 'clear' || eligibility === 'ready')) {
      if (!hasUnit(current, source.unit ?? '') || current.state !== 'active' || current.mode !== 'scalar_amount') {
        eligibility = 'unsupported';
        reason = current.state !== 'active' ? 'selected-occurrence-is-not-active' : 'selected-occurrence-does-not-contain-unit';
      } else if (recordingFor(presented!, source.unit!) !== 'supported') {
        eligibility = 'unsupported';
        reason = 'selected-occurrence-unit-is-not-currently-recordable';
      }
    }
    if (selection.action === 'clear' && descriptor && input.occurrence.kind === 'existing' && current &&
      current.state === 'active' && current.mode === 'scalar_amount' && hasUnit(current, source.unit ?? '') &&
      recordingFor(presented!, source.unit!) === 'supported') {
      eligibility = 'ready';
      reason = null;
    }
    const currentAmount = current && source.unit ? amountOf(current, source.unit) : null;
    return {
      field: selection.field,
      unit: source.unit,
      action: selection.action,
      replace: selection.replace === true,
      state: source.state,
      amount: source.amount ?? null,
      currentAmount,
      eligibility,
      reason,
    };
  });

  if (input.occurrence.kind === 'existing') {
    if (!current || !presented) throw new ProblemError('not_found');
    return {
      subjectId,
      profile: binding,
      requestKeySeed: startRequestKey,
      occurrence: {
        kind: 'existing',
        sessionId: current.id,
        startedAt: current.startedAt,
        transactionId: current.transactionId,
        revision: current.revision,
        state: current.state,
        mode: current.mode,
        units: [current.unit, ...(current.measures ?? []).map((measure) => measure.unit)],
      },
      measures: measurePlans,
    };
  }

  if (input.measures.some((measure) => measure.action !== 'adopt')) throw new ProblemError('invalid_request');
  const primary = input.occurrence.primaryUnit;
  const primaryMeasure = measurePlans.find((measure) => measure.unit === primary && measure.action === 'adopt');
  if (!primaryMeasure) throw new ProblemError('invalid_request');
  const startable = measurePlans.filter((measure) => measure.action === 'adopt' && measure.eligibility === 'ready');
  const selectedPrimary = startable.find((measure) => measure.unit === primary);
  let startInput: ProgressSessionCreate | null = null;
  let reason: string | null = null;
  if (!selectedPrimary) reason = 'primary-measure-is-not-admissible';
  else {
    const additionalMeasures = startable
      .filter((measure) => measure.unit !== primary)
      .map((measure) => ({ unit: measure.unit!, total: null }));
    const candidate = {
      subjectId,
      versionSubjectId: null,
      mode: 'scalar_amount' as const,
      unit: primary,
      total: null,
      ...(additionalMeasures.length ? { additionalMeasures } : {}),
    };
    const primaryDescriptor = progressMeasureUnit(profile, primary)!;
    const primaryTotal = parseProgressMeasureCreate({ unit: primary, total: null }, primaryDescriptor);
    const additionalValid = additionalMeasures.every((measure) => {
      const descriptor = progressMeasureUnit(profile, measure.unit);
      return descriptor !== null && parseProgressMeasureCreate(measure, descriptor).ok;
    });
    const parsed = parseSessionCreate(candidate, primaryDescriptor);
    if (!primaryTotal.ok || !additionalValid || !parsed.ok) reason = 'current-profile-requires-an-unavailable-total-or-shape';
    else startInput = parsed.value;
  }
  return {
    subjectId,
    profile: binding,
    requestKeySeed: startRequestKey,
    occurrence: { kind: 'start', primaryUnit: primary, requestKey: startRequestKey, input: startInput!, reason },
    measures: measurePlans,
  };
}

export function emptyProgressCheckpoint(): ProgressAdoptionCheckpoint {
  return { occurrence: null, lastRevision: null, steps: {}, measures: [], complete: false };
}

export function progressResults(
  plan: ProgressAdoptionPlan,
  checkpoint: ProgressAdoptionCheckpoint | null | undefined,
): ProgressAdoptionMeasureResult[] {
  return plan.measures.map((measure) => {
    const result = checkpoint?.steps[measure.field]?.result;
    if (result) return result;
    const status: ProgressAdoptionMeasureResult['status'] =
      measure.eligibility === 'ready'
        ? 'unattempted'
        : measure.eligibility;
    return {
      field: measure.field,
      unit: measure.unit,
      action: measure.action,
      status,
      sourceAmount: measure.amount,
      currentAmount: measure.currentAmount,
      reason: measure.reason,
    };
  });
}

export async function executeProgressAdoption(
  actor: Actor,
  sessions: SessionCommands,
  plan: ProgressAdoptionPlan,
  prior: ProgressAdoptionCheckpoint | null | undefined,
  controls: {
    canceled(): Promise<boolean>;
    binding(): Promise<ProgressProfileBinding | null>;
    save(checkpoint: ProgressAdoptionCheckpoint, admission?: boolean): Promise<boolean | void>;
    recordNative?(command: NativeCommand): void;
  },
): Promise<ProgressAdoptionCheckpoint> {
  const checkpoint = structuredClone(prior ?? emptyProgressCheckpoint());
  const currentBinding = async () => bindingMatches(plan.profile, await controls.binding());
  if (checkpoint.complete) return checkpoint;
  const stopRemaining = async (from: number, status: 'stale' | 'unattempted', reason: string) => {
    for (const measure of plan.measures.slice(from)) {
      const step = checkpoint.steps[measure.field];
      if (step?.result && step.result.status !== 'failed' && step.result.status !== 'unattempted') continue;
      if (measure.action === 'adopt' && measure.eligibility !== 'ready') continue;
      if (measure.action === 'clear' && measure.eligibility !== 'ready') continue;
      const result: ProgressAdoptionMeasureResult = {
        field: measure.field,
        unit: measure.unit,
        action: measure.action,
        status,
        sourceAmount: measure.amount,
        currentAmount: measure.currentAmount,
        reason,
      };
      checkpoint.steps[measure.field] = {
        requestKey: step?.requestKey ?? '',
        revision: step?.revision ?? checkpoint.lastRevision ?? (plan.occurrence.kind === 'existing' ? plan.occurrence.revision : 0),
        attempted: step?.attempted ?? false,
        result,
      };
    }
    checkpoint.complete = true;
    checkpoint.measures = progressResults(plan, checkpoint);
    await controls.save(checkpoint);
  };

  if (!checkpoint.occurrence && plan.occurrence.kind === 'start') {
    if (!plan.occurrence.input || plan.occurrence.reason) {
      checkpoint.complete = true;
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      return checkpoint;
    }
    if (!checkpoint.startAttempted && await controls.canceled()) {
      await stopRemaining(0, 'unattempted', 'import-was-canceled-before-start');
      return checkpoint;
    }
    if (!(await currentBinding())) {
      await stopRemaining(0, 'stale', 'current-profile-or-subject-changed');
      return checkpoint;
    }
    if (!checkpoint.startAttempted) {
      checkpoint.startAttempted = true;
      if (await controls.save(checkpoint, true) === false) {
        checkpoint.startAttempted = false;
        await stopRemaining(0, 'unattempted', 'import-was-canceled-before-start');
        return checkpoint;
      }
    }
    try {
      const command = await sessions.startSession(actor, plan.occurrence.input, plan.occurrence.requestKey);
      controls.recordNative?.(command);
      const session = command.value;
      checkpoint.occurrence = {
        sessionId: session.id,
        startedAt: session.startedAt,
        transactionId: session.transactionId,
        revision: session.revision,
      };
      checkpoint.lastRevision = session.revision;
      await controls.save(checkpoint);
    } catch (error) {
      if (staleError(error)) {
        await stopRemaining(0, 'stale', 'native-occurrence-start-was-refused');
        return checkpoint;
      }
      throw error;
    }
  }

  const occurrence = checkpoint.occurrence ??
    (plan.occurrence.kind === 'existing'
      ? {
          sessionId: plan.occurrence.sessionId,
          startedAt: plan.occurrence.startedAt,
          transactionId: plan.occurrence.transactionId,
          revision: plan.occurrence.revision,
        }
      : null);
  if (!occurrence) return checkpoint;
  if (!checkpoint.occurrence) checkpoint.occurrence = occurrence;
  if (checkpoint.lastRevision === null)
    checkpoint.lastRevision = plan.occurrence.kind === 'existing' ? plan.occurrence.revision : occurrence.revision;

  for (const [index, measure] of plan.measures.entries()) {
    const existingStep = checkpoint.steps[measure.field];
    if (existingStep?.result && existingStep.result.status !== 'failed' && existingStep.result.status !== 'unattempted')
      continue;
    if (measure.eligibility !== 'ready' && measure.action === 'adopt') {
      checkpoint.steps[measure.field] = {
        requestKey: existingStep?.requestKey ?? '',
        revision: existingStep?.revision ?? checkpoint.lastRevision,
        attempted: false,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: measure.eligibility,
          sourceAmount: measure.amount,
          currentAmount: measure.currentAmount,
          reason: measure.reason,
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      continue;
    }
    if (measure.eligibility !== 'ready' && measure.action === 'clear') {
      checkpoint.steps[measure.field] = {
        requestKey: existingStep?.requestKey ?? '',
        revision: existingStep?.revision ?? checkpoint.lastRevision,
        attempted: false,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: measure.eligibility,
          sourceAmount: null,
          currentAmount: measure.currentAmount,
          reason: measure.reason,
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      continue;
    }
    if (!measure.unit) {
      checkpoint.steps[measure.field] = {
        requestKey: '',
        revision: checkpoint.lastRevision,
        attempted: false,
        result: {
          field: measure.field,
          unit: null,
          action: measure.action,
          status: 'unsupported',
          sourceAmount: measure.amount,
          currentAmount: measure.currentAmount,
          reason: measure.reason ?? 'source-field-has-no-unit-mapping',
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      continue;
    }
    if (measure.action === 'adopt' && plan.occurrence.kind === 'existing' && measure.currentAmount !== null && !measure.replace) {
      checkpoint.steps[measure.field] = {
        requestKey: '',
        revision: checkpoint.lastRevision,
        attempted: false,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: 'preserved',
          sourceAmount: measure.amount,
          currentAmount: measure.currentAmount,
          reason: 'preserve-local-measure',
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      continue;
    }
    if (measure.action === 'clear' && measure.currentAmount === null) {
      checkpoint.steps[measure.field] = {
        requestKey: '',
        revision: checkpoint.lastRevision,
        attempted: false,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: 'cleared',
          sourceAmount: null,
          currentAmount: null,
          reason: 'measure-was-already-clear',
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      continue;
    }
    if (!existingStep?.attempted && await controls.canceled()) {
      await stopRemaining(index, 'unattempted', 'import-was-canceled');
      break;
    }
    if (!(await currentBinding())) {
      await stopRemaining(index, 'stale', 'current-profile-or-subject-changed');
      break;
    }

    let latest: Presented;
    try {
      latest = await inspect(sessions, actor, occurrence.sessionId);
    } catch (error) {
      if (error instanceof ProblemError && ['not_found', 'conflict', 'unsupported_library_profile'].includes(error.code)) {
        await stopRemaining(index, 'stale', 'selected-occurrence-is-no-longer-current');
        break;
      }
      throw error;
    }
    const sameOccurrence = latest.session.id === occurrence.sessionId &&
      latest.session.subjectId === plan.subjectId &&
      latest.session.startedAt === occurrence.startedAt &&
      latest.session.transactionId === occurrence.transactionId;
    if (!sameOccurrence || latest.session.state !== 'active' || latest.session.mode !== 'scalar_amount' ||
      recordingFor(latest, measure.unit) !== 'supported') {
      await stopRemaining(index, 'stale', 'selected-occurrence-or-measure-changed');
      break;
    }

    const step = checkpoint.steps[measure.field];
    const revision = step?.attempted ? step.revision : checkpoint.lastRevision ?? latest.session.revision;
    if (!step?.attempted && latest.session.revision !== revision) {
      await stopRemaining(index, 'stale', 'shared-occurrence-revision-changed');
      break;
    }
    const requestKey = step?.requestKey || `progress-adopt:${createHash('sha256')
      .update(`${plan.requestKeySeed}\0${measure.field}\0${measure.action}`)
      .digest('hex')}`;
    const pending = {
      requestKey,
      revision,
      attempted: true,
    };
    checkpoint.steps[measure.field] = pending;
    checkpoint.measures = progressResults(plan, checkpoint);
    if (await controls.save(checkpoint, true) === false) {
      checkpoint.steps[measure.field] = {
        ...pending,
        attempted: false,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: 'unattempted',
          sourceAmount: measure.action === 'clear' ? null : measure.amount,
          currentAmount: measure.currentAmount,
          reason: 'import-was-canceled-before-measure-write',
        },
      };
      await controls.save(checkpoint);
      await stopRemaining(index + 1, 'unattempted', 'import-was-canceled');
      break;
    }
    try {
      const command = await sessions.recordProgress(
        actor,
        occurrence.sessionId,
        {
          revision,
          measureId: measure.unit,
          ...(measure.action === 'clear' ? { clear: true } : { amount: measure.amount }),
        },
        requestKey,
      );
      controls.recordNative?.(command);
      const updated = command.value;
      const verify = await inspect(sessions, actor, occurrence.sessionId);
      if (
        verify.session.id !== updated.id ||
        verify.session.startedAt !== occurrence.startedAt ||
        verify.session.transactionId !== occurrence.transactionId ||
        verify.session.revision !== updated.revision
      ) {
        await stopRemaining(index, 'stale', 'occurrence-changed-after-measure-write');
        break;
      }
      checkpoint.lastRevision = updated.revision;
      checkpoint.steps[measure.field] = {
        ...pending,
        result: {
          field: measure.field,
          unit: measure.unit,
          action: measure.action,
          status: measure.action === 'clear' ? 'cleared' : 'applied',
          sourceAmount: measure.action === 'clear' ? null : measure.amount,
          currentAmount: measure.action === 'clear' ? null : measure.amount,
          reason: null,
        },
      };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
    } catch (error) {
      if (staleError(error)) {
        await stopRemaining(index, 'stale', 'native-measure-write-was-refused');
        break;
      }
      const failed: ProgressAdoptionMeasureResult = {
        field: measure.field,
        unit: measure.unit,
        action: measure.action,
        status: 'failed',
        sourceAmount: measure.action === 'clear' ? null : measure.amount,
        currentAmount: measure.currentAmount,
        reason: 'native-measure-write-can-retry-with-original-receipt',
      };
      checkpoint.steps[measure.field] = { ...pending, result: failed };
      checkpoint.measures = progressResults(plan, checkpoint);
      await controls.save(checkpoint);
      checkpoint.complete = false;
      return checkpoint;
    }
  }
  checkpoint.complete = plan.measures.every((measure) => {
    const status = checkpoint.steps[measure.field]?.result?.status;
    return status !== undefined && status !== 'failed' && status !== 'unattempted';
  });
  checkpoint.measures = progressResults(plan, checkpoint);
  await controls.save(checkpoint);
  return checkpoint;
}
