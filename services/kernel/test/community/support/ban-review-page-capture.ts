import type { Capture } from '../../support/growth-cost.ts';

export type BanReviewPageCapturedRead = {
  readonly authCapture: Capture;
  readonly applicationRequestBytes: number;
  readonly applicationResponseBytes: number;
  readonly jwksRequestBytes: number;
  readonly jwksResponseBytes: number;
};

function isCapturedRead(value: unknown): value is BanReviewPageCapturedRead {
  if (typeof value !== 'object' || value === null || !('authCapture' in value)) return false;
  const sample = value as Partial<BanReviewPageCapturedRead>;
  return (
    typeof sample.authCapture === 'object' &&
    sample.authCapture !== null &&
    Array.isArray(sample.authCapture.statements) &&
    ['applicationRequestBytes', 'applicationResponseBytes', 'jwksRequestBytes', 'jwksResponseBytes'].every(
      (key) => typeof sample[key as keyof BanReviewPageCapturedRead] === 'number',
    )
  );
}

function concatenate<T>(values: readonly (readonly T[] | undefined)[]): readonly T[] | undefined {
  return values.some((value) => value !== undefined) ? values.flatMap((value) => value ?? []) : undefined;
}

function mergeCaptures(captures: readonly Capture[]): Capture {
  const statementOffsets: number[] = [];
  const backgroundOffsets: number[] = [];
  let statementCount = 0;
  let backgroundCount = 0;
  for (const capture of captures) {
    statementOffsets.push(statementCount);
    backgroundOffsets.push(backgroundCount);
    statementCount += capture.statements.length;
    backgroundCount += capture.backgroundStatements?.length ?? 0;
  }
  const plans = concatenate(captures.map((capture) => capture.plans)) ?? [];
  const backgroundPlans = concatenate(captures.map((capture) => capture.backgroundPlans));
  const planStatements = captures.some((capture) => capture.planStatements !== undefined)
    ? captures.flatMap((capture, index) => {
        if (capture.plans.length > 0 && capture.planStatements === undefined)
          throw new Error('Ban review capture omitted native plan statement ownership');
        return (capture.planStatements ?? []).map((statement) =>
          statement === undefined ? undefined : statementOffsets[index]! + statement,
        );
      })
    : undefined;
  const backgroundPlanStatements = captures.some((capture) => capture.backgroundPlanStatements !== undefined)
    ? captures.flatMap((capture, index) => {
        if ((capture.backgroundPlans?.length ?? 0) > 0 && capture.backgroundPlanStatements === undefined)
          throw new Error('Ban review capture omitted background plan statement ownership');
        return (capture.backgroundPlanStatements ?? []).map((statement) =>
          statement === undefined ? undefined : backgroundOffsets[index]! + statement,
        );
      })
    : undefined;
  return {
    statements: concatenate(captures.map((capture) => capture.statements)) ?? [],
    requestBytes: concatenate(captures.map((capture) => capture.requestBytes)),
    responseBytes: concatenate(captures.map((capture) => capture.responseBytes)),
    plans,
    planStatements,
    statementErrors: concatenate(captures.map((capture) => capture.statementErrors)),
    statementErrorMessages: concatenate(captures.map((capture) => capture.statementErrorMessages)),
    statementBackends: concatenate(captures.map((capture) => capture.statementBackends)),
    planBackends: concatenate(captures.map((capture) => capture.planBackends)),
    planDatabases: concatenate(captures.map((capture) => capture.planDatabases)),
    backgroundStatements: concatenate(captures.map((capture) => capture.backgroundStatements)),
    backgroundRequestBytes: concatenate(captures.map((capture) => capture.backgroundRequestBytes)),
    backgroundResponseBytes: concatenate(captures.map((capture) => capture.backgroundResponseBytes)),
    backgroundPlans,
    backgroundPlanStatements,
    backgroundStatementErrors: concatenate(captures.map((capture) => capture.backgroundStatementErrors)),
    backgroundStatementErrorMessages: concatenate(captures.map((capture) => capture.backgroundStatementErrorMessages)),
    backgroundStatementBackends: concatenate(captures.map((capture) => capture.backgroundStatementBackends)),
    backgroundPlanBackends: concatenate(captures.map((capture) => capture.backgroundPlanBackends)),
    backgroundPlanDatabases: concatenate(captures.map((capture) => capture.backgroundPlanDatabases)),
  };
}

/** Merge each invocation's pools before growth medians, while validating catalogs on their own databases. */
export function aggregateBanReviewPageCapture(primary: Capture, value: unknown) {
  if (!isCapturedRead(value)) throw new TypeError('Ban review growth operation omitted its Auth capture');
  const databases = [
    { name: 'kernel', capture: primary },
    { name: 'auth', capture: value.authCapture },
  ];
  return { capture: mergeCaptures(databases.map(({ capture }) => capture)), databases };
}

export function banReviewPageWireCounts(value: unknown) {
  if (!isCapturedRead(value)) throw new TypeError('Ban review growth operation omitted byte observations');
  return {
    applicationRequestBytes: value.applicationRequestBytes,
    applicationResponseBytes: value.applicationResponseBytes,
    jwksRequestBytes: value.jwksRequestBytes,
    jwksResponseBytes: value.jwksResponseBytes,
  };
}
