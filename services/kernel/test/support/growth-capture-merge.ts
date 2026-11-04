import type { Capture } from './growth-cost.ts';

function appendOptional<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  previousCount: number,
  nextCount: number,
  label: string,
  fill: () => T,
): readonly T[] | undefined {
  if (previous === undefined && next === undefined) return undefined;
  const left = previous ?? Array.from({ length: previousCount }, fill);
  const right = next ?? Array.from({ length: nextCount }, fill);
  if (left.length !== previousCount || right.length !== nextCount)
    throw new TypeError(
      `Capture ${label} misaligned while merging: ${left.length}/${previousCount} and ${right.length}/${nextCount}`,
    );
  return [...left, ...right];
}

function appendPlanOwners(
  previous: readonly (number | undefined)[] | undefined,
  next: readonly (number | undefined)[] | undefined,
  previousPlanCount: number,
  nextPlanCount: number,
  previousStatementCount: number,
  label: string,
): readonly (number | undefined)[] | undefined {
  const aligned = appendOptional(previous, next, previousPlanCount, nextPlanCount, label, () => undefined);
  if (aligned === undefined || nextPlanCount === 0) return aligned;
  return [
    ...aligned.slice(0, previousPlanCount),
    ...aligned
      .slice(previousPlanCount)
      .map((index) => (index === undefined ? undefined : index + previousStatementCount)),
  ];
}

function appendCapture(previous: Capture, next: Capture): Capture {
  const previousBackgroundStatements = previous.backgroundStatements ?? [];
  const nextBackgroundStatements = next.backgroundStatements ?? [];
  const previousBackgroundPlans = previous.backgroundPlans ?? [];
  const nextBackgroundPlans = next.backgroundPlans ?? [];
  const requestBytes = appendOptional(
    previous.requestBytes,
    next.requestBytes,
    previous.statements.length,
    next.statements.length,
    'requestBytes',
    () => 0,
  );
  const responseBytes = appendOptional(
    previous.responseBytes,
    next.responseBytes,
    previous.statements.length,
    next.statements.length,
    'responseBytes',
    () => 0,
  );
  const planStatements = appendPlanOwners(
    previous.planStatements,
    next.planStatements,
    previous.plans.length,
    next.plans.length,
    previous.statements.length,
    'planStatements',
  );
  const statementErrors = appendOptional(
    previous.statementErrors,
    next.statementErrors,
    previous.statements.length,
    next.statements.length,
    'statementErrors',
    () => null,
  );
  const statementErrorMessages = appendOptional(
    previous.statementErrorMessages,
    next.statementErrorMessages,
    previous.statements.length,
    next.statements.length,
    'statementErrorMessages',
    () => null,
  );
  const statementBackends = appendOptional(
    previous.statementBackends,
    next.statementBackends,
    previous.statements.length,
    next.statements.length,
    'statementBackends',
    () => undefined,
  );
  const planBackends = appendOptional(
    previous.planBackends,
    next.planBackends,
    previous.plans.length,
    next.plans.length,
    'planBackends',
    () => undefined,
  );
  const planDatabases = appendOptional(
    previous.planDatabases,
    next.planDatabases,
    previous.plans.length,
    next.plans.length,
    'planDatabases',
    () => undefined,
  );
  const backgroundRequestBytes = appendOptional(
    previous.backgroundRequestBytes,
    next.backgroundRequestBytes,
    previousBackgroundStatements.length,
    nextBackgroundStatements.length,
    'backgroundRequestBytes',
    () => 0,
  );
  const backgroundResponseBytes = appendOptional(
    previous.backgroundResponseBytes,
    next.backgroundResponseBytes,
    previousBackgroundStatements.length,
    nextBackgroundStatements.length,
    'backgroundResponseBytes',
    () => 0,
  );
  const backgroundPlanStatements = appendPlanOwners(
    previous.backgroundPlanStatements,
    next.backgroundPlanStatements,
    previousBackgroundPlans.length,
    nextBackgroundPlans.length,
    previousBackgroundStatements.length,
    'backgroundPlanStatements',
  );
  const backgroundStatementErrors = appendOptional(
    previous.backgroundStatementErrors,
    next.backgroundStatementErrors,
    previousBackgroundStatements.length,
    nextBackgroundStatements.length,
    'backgroundStatementErrors',
    () => null,
  );
  const backgroundStatementErrorMessages = appendOptional(
    previous.backgroundStatementErrorMessages,
    next.backgroundStatementErrorMessages,
    previousBackgroundStatements.length,
    nextBackgroundStatements.length,
    'backgroundStatementErrorMessages',
    () => null,
  );
  const backgroundStatementBackends = appendOptional(
    previous.backgroundStatementBackends,
    next.backgroundStatementBackends,
    previousBackgroundStatements.length,
    nextBackgroundStatements.length,
    'backgroundStatementBackends',
    () => undefined,
  );
  const backgroundPlanBackends = appendOptional(
    previous.backgroundPlanBackends,
    next.backgroundPlanBackends,
    previousBackgroundPlans.length,
    nextBackgroundPlans.length,
    'backgroundPlanBackends',
    () => undefined,
  );
  const backgroundPlanDatabases = appendOptional(
    previous.backgroundPlanDatabases,
    next.backgroundPlanDatabases,
    previousBackgroundPlans.length,
    nextBackgroundPlans.length,
    'backgroundPlanDatabases',
    () => undefined,
  );
  const backgroundStatements =
    previous.backgroundStatements === undefined && next.backgroundStatements === undefined
      ? undefined
      : [...previousBackgroundStatements, ...nextBackgroundStatements];
  const backgroundPlans =
    previous.backgroundPlans === undefined && next.backgroundPlans === undefined
      ? undefined
      : [...previousBackgroundPlans, ...nextBackgroundPlans];
  return {
    statements: [...previous.statements, ...next.statements],
    plans: [...previous.plans, ...next.plans],
    ...(previous.elapsedMs === undefined && next.elapsedMs === undefined
      ? {}
      : { elapsedMs: previous.elapsedMs ?? next.elapsedMs }),
    ...(requestBytes === undefined ? {} : { requestBytes }),
    ...(responseBytes === undefined ? {} : { responseBytes }),
    ...(planStatements === undefined ? {} : { planStatements }),
    ...(statementErrors === undefined ? {} : { statementErrors }),
    ...(statementErrorMessages === undefined ? {} : { statementErrorMessages }),
    ...(statementBackends === undefined ? {} : { statementBackends }),
    ...(planBackends === undefined ? {} : { planBackends }),
    ...(planDatabases === undefined ? {} : { planDatabases }),
    ...(backgroundStatements === undefined ? {} : { backgroundStatements }),
    ...(backgroundRequestBytes === undefined ? {} : { backgroundRequestBytes }),
    ...(backgroundResponseBytes === undefined ? {} : { backgroundResponseBytes }),
    ...(backgroundPlans === undefined ? {} : { backgroundPlans }),
    ...(backgroundPlanStatements === undefined ? {} : { backgroundPlanStatements }),
    ...(backgroundStatementErrors === undefined ? {} : { backgroundStatementErrors }),
    ...(backgroundStatementErrorMessages === undefined ? {} : { backgroundStatementErrorMessages }),
    ...(backgroundStatementBackends === undefined ? {} : { backgroundStatementBackends }),
    ...(backgroundPlanBackends === undefined ? {} : { backgroundPlanBackends }),
    ...(backgroundPlanDatabases === undefined ? {} : { backgroundPlanDatabases }),
  };
}

/** Concatenate native captures and rebase plan owners, retaining every optional parallel array. */
export function mergeGrowthCaptures(captures: readonly Capture[]): Capture {
  if (captures.length === 0) return { statements: [], plans: [] };
  return captures.reduce(appendCapture);
}
