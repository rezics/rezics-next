import { mergeGrowthCaptures } from './growth-capture-merge.ts';
import type { Capture } from './growth-cost.ts';
import { requireDenseArray } from './growth-numeric.ts';

function requireParallel(
  values: readonly unknown[] | undefined,
  name: string,
  relatedName: string,
  expectedLength: number,
): void {
  if (values === undefined) return;
  requireDenseArray(values, `Capture ${name}`);
  if (values.length !== expectedLength)
    throw new TypeError(`Capture ${name} has ${values.length} items, but ${relatedName} has ${expectedLength}`);
}

function requireBackends(values: readonly (number | undefined)[] | undefined, name: string): void {
  if (values === undefined) return;
  for (let index = 0; index < values.length; index += 1) {
    const backend = values[index];
    if (backend !== undefined && !Number.isSafeInteger(backend))
      throw new TypeError(`Capture ${name}[${index}] must be a safe integer backend ID or undefined`);
  }
}

function requireOwners(
  values: readonly (number | undefined)[] | undefined,
  name: string,
  statementCount: number,
): void {
  if (values === undefined) return;
  for (let index = 0; index < values.length; index += 1) {
    const owner = values[index];
    if (owner !== undefined && (!Number.isInteger(owner) || owner < 0 || owner >= statementCount))
      throw new TypeError(
        `Capture ${name}[${index}] must be undefined or a statement index from 0 to ${statementCount - 1}; received ${owner}`,
      );
  }
}

function requireErrorValues(values: readonly (string | null)[] | undefined, name: string): void {
  if (values === undefined) return;
  for (let index = 0; index < values.length; index += 1)
    if (values[index] !== null && typeof values[index] !== 'string')
      throw new TypeError(`Capture ${name}[${index}] must be a string or null`);
}

function requireBackendPair(
  statements: readonly (number | undefined)[] | undefined,
  plans: readonly (number | undefined)[] | undefined,
  statementName: string,
  planName: string,
): void {
  if (statements !== undefined && plans === undefined)
    throw new TypeError(`Capture ${statementName} requires ${planName} for coherent backend attribution`);
  if (plans !== undefined && statements === undefined)
    throw new TypeError(`Capture ${planName} requires ${statementName} for coherent backend attribution`);
}

function requireOwnerBackends(
  owners: readonly (number | undefined)[] | undefined,
  statementBackends: readonly (number | undefined)[] | undefined,
  planBackends: readonly (number | undefined)[] | undefined,
  ownerName: string,
  statementBackendName: string,
  planBackendName: string,
): void {
  if (owners === undefined || statementBackends === undefined || planBackends === undefined) return;
  for (let planIndex = 0; planIndex < owners.length; planIndex += 1) {
    const owner = owners[planIndex];
    if (owner === undefined) continue;
    const statementBackend = statementBackends[owner];
    const planBackend = planBackends[planIndex];
    if (statementBackend !== undefined && planBackend !== undefined && statementBackend !== planBackend)
      throw new TypeError(
        `Capture ${planBackendName}[${planIndex}] backend ${planBackend} conflicts with ${statementBackendName}[${owner}] backend ${statementBackend} for ${ownerName}[${planIndex}]`,
      );
  }
}

function requireErrorMessages(
  errors: readonly (string | null)[] | undefined,
  messages: readonly (string | null)[] | undefined,
  errorName: string,
  messageName: string,
): void {
  if (messages === undefined) return;
  if (errors === undefined) throw new TypeError(`Capture ${messageName} requires ${errorName}`);
  for (let index = 0; index < messages.length; index += 1)
    if (messages[index] !== null && errors[index] === null)
      throw new TypeError(
        `Capture ${messageName}[${index}] has a message without an error code in ${errorName}[${index}]`,
      );
}

/** Rejects malformed present capture metadata while retaining optional legacy fields and unowned plans. */
export function validateCaptureEvidence(capture: Capture): void {
  requireDenseArray(capture.statements, 'Capture statements');
  requireDenseArray(capture.plans, 'Capture plans');
  if (capture.backgroundStatements !== undefined)
    requireDenseArray(capture.backgroundStatements, 'Capture backgroundStatements');
  if (capture.backgroundPlans !== undefined) requireDenseArray(capture.backgroundPlans, 'Capture backgroundPlans');

  const backgroundStatementCount = capture.backgroundStatements?.length ?? 0;
  const backgroundPlanCount = capture.backgroundPlans?.length ?? 0;

  requireParallel(capture.requestBytes, 'requestBytes', 'statements', capture.statements.length);
  requireParallel(capture.responseBytes, 'responseBytes', 'statements', capture.statements.length);
  requireParallel(capture.planStatements, 'planStatements', 'plans', capture.plans.length);
  requireParallel(capture.planDatabases, 'planDatabases', 'plans', capture.plans.length);
  requireParallel(capture.statementErrors, 'statementErrors', 'statements', capture.statements.length);
  requireParallel(capture.statementErrorMessages, 'statementErrorMessages', 'statements', capture.statements.length);
  requireParallel(capture.statementBackends, 'statementBackends', 'statements', capture.statements.length);
  requireParallel(capture.planBackends, 'planBackends', 'plans', capture.plans.length);

  requireParallel(
    capture.backgroundRequestBytes,
    'backgroundRequestBytes',
    'backgroundStatements',
    backgroundStatementCount,
  );
  requireParallel(
    capture.backgroundResponseBytes,
    'backgroundResponseBytes',
    'backgroundStatements',
    backgroundStatementCount,
  );
  requireParallel(capture.backgroundPlanStatements, 'backgroundPlanStatements', 'backgroundPlans', backgroundPlanCount);
  requireParallel(
    capture.backgroundStatementErrors,
    'backgroundStatementErrors',
    'backgroundStatements',
    backgroundStatementCount,
  );
  requireParallel(
    capture.backgroundStatementErrorMessages,
    'backgroundStatementErrorMessages',
    'backgroundStatements',
    backgroundStatementCount,
  );
  requireParallel(
    capture.backgroundStatementBackends,
    'backgroundStatementBackends',
    'backgroundStatements',
    backgroundStatementCount,
  );
  requireParallel(capture.backgroundPlanBackends, 'backgroundPlanBackends', 'backgroundPlans', backgroundPlanCount);
  requireParallel(capture.backgroundPlanDatabases, 'backgroundPlanDatabases', 'backgroundPlans', backgroundPlanCount);

  requireOwners(capture.planStatements, 'planStatements', capture.statements.length);
  requireOwners(capture.backgroundPlanStatements, 'backgroundPlanStatements', backgroundStatementCount);
  requireErrorValues(capture.statementErrors, 'statementErrors');
  requireErrorValues(capture.statementErrorMessages, 'statementErrorMessages');
  requireErrorValues(capture.backgroundStatementErrors, 'backgroundStatementErrors');
  requireErrorValues(capture.backgroundStatementErrorMessages, 'backgroundStatementErrorMessages');
  requireErrorMessages(
    capture.statementErrors,
    capture.statementErrorMessages,
    'statementErrors',
    'statementErrorMessages',
  );
  requireErrorMessages(
    capture.backgroundStatementErrors,
    capture.backgroundStatementErrorMessages,
    'backgroundStatementErrors',
    'backgroundStatementErrorMessages',
  );

  requireBackends(capture.statementBackends, 'statementBackends');
  requireBackends(capture.planBackends, 'planBackends');
  requireBackends(capture.backgroundStatementBackends, 'backgroundStatementBackends');
  requireBackends(capture.backgroundPlanBackends, 'backgroundPlanBackends');
  requireBackendPair(capture.statementBackends, capture.planBackends, 'statementBackends', 'planBackends');
  requireBackendPair(
    capture.backgroundStatementBackends,
    capture.backgroundPlanBackends,
    'backgroundStatementBackends',
    'backgroundPlanBackends',
  );
  requireOwnerBackends(
    capture.planStatements,
    capture.statementBackends,
    capture.planBackends,
    'planStatements',
    'statementBackends',
    'planBackends',
  );
  requireOwnerBackends(
    capture.backgroundPlanStatements,
    capture.backgroundStatementBackends,
    capture.backgroundPlanBackends,
    'backgroundPlanStatements',
    'backgroundStatementBackends',
    'backgroundPlanBackends',
  );
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (!sameValue(left[index], right[index])) return false;
  return true;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && sameArray(left, right);
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(rightRecord, key) || !sameValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function captureWork(capture: Capture): Record<string, unknown> {
  return {
    statements: capture.statements,
    requestBytes: capture.requestBytes,
    responseBytes: capture.responseBytes,
    plans: capture.plans,
    planStatements: capture.planStatements,
    statementErrors: capture.statementErrors,
    statementErrorMessages: capture.statementErrorMessages,
    statementBackends: capture.statementBackends,
    planBackends: capture.planBackends,
    planDatabases: capture.planDatabases,
    backgroundStatements: capture.backgroundStatements,
    backgroundRequestBytes: capture.backgroundRequestBytes,
    backgroundResponseBytes: capture.backgroundResponseBytes,
    backgroundPlans: capture.backgroundPlans,
    backgroundPlanStatements: capture.backgroundPlanStatements,
    backgroundStatementErrors: capture.backgroundStatementErrors,
    backgroundStatementErrorMessages: capture.backgroundStatementErrorMessages,
    backgroundStatementBackends: capture.backgroundStatementBackends,
    backgroundPlanBackends: capture.backgroundPlanBackends,
    backgroundPlanDatabases: capture.backgroundPlanDatabases,
  };
}

function sameCaptureWork(left: Capture, right: Capture): boolean {
  return sameValue(captureWork(left), captureWork(right));
}

function listedLabel(database: { readonly name: string; readonly capture: Capture }): string {
  const { capture } = database;
  const backgroundStatements = capture.backgroundStatements?.length ?? 0;
  const backgroundPlans = capture.backgroundPlans?.length ?? 0;
  return `${database.name}=${capture.statements.length}/${capture.plans.length}/${backgroundStatements}/${backgroundPlans}`;
}

/**
 * Derive the costed aggregate from listed native captures. Optional legacy fields stay omitted when every listed
 * capture omitted them. Refuse dropped or replaced statements, plans, bytes or attribution, including the primary.
 */
export function admitAggregatedCaptures(
  name: string,
  merged: Capture,
  databases: readonly { readonly name: string; readonly capture: Capture }[],
  primary: Capture,
): Capture {
  validateCaptureEvidence(merged);
  validateCaptureEvidence(primary);
  const listed = databases.map((database) => {
    validateCaptureEvidence(database.capture);
    return database.capture;
  });
  if (!listed.some((capture) => sameCaptureWork(capture, primary)))
    throw new Error(`${name}: aggregateCaptures omitted the primary capture`);
  const admitted = mergeGrowthCaptures(listed);
  if (!sameCaptureWork(merged, admitted)) {
    const listedCaptures = databases.map(listedLabel).join(', ');
    throw new Error(
      `${name}: aggregateCaptures omitted native statements, plans or background work (merged evidence does not match listed captures: ${listedCaptures})`,
    );
  }
  return admitted;
}
