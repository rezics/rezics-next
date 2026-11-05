import { expect, test } from 'bun:test';
import type { Capture } from '../support/growth.ts';
import { costOf } from '../support/growth.ts';
import { appendImportPostgresCapture, type ImportPostgresCapture } from './api-capture.ts';
import { associatePostgresStatements } from './growth-fixture.ts';

const observedSql =
  "SELECT operation FROM semantic.fact WHERE route = $1::integer AND subject_id = $2::uuid AND slot_id = $3::uuid\nORDER BY log_seq DESC LIMIT 1 /*file='..%2F..%2Fsrc%2Fsemantic%2Fslots-read-operation.sql'*/;";
const backgroundSql = 'SELECT 1 AS worker_probe';
const authBackgroundSql = 'SELECT 2 AS worker_probe';

function nativePlan(queryText: string, rows: number) {
  return [
    {
      'Query Text': queryText,
      Plan: {
        'Node Type': 'ModifyTable',
        'Actual Rows': rows,
        'Actual Loops': 2,
        'Shared Hit Blocks': rows + 1,
        'Shared Read Blocks': 1,
        Schema: 'semantic',
        'Relation Name': 'fact',
        Plans: [],
      },
    },
  ];
}

function capture(
  statements: readonly string[],
  errors: readonly (string | null)[],
  backends: readonly (number | undefined)[],
  plans: readonly unknown[],
  planStatements: readonly (number | undefined)[],
  planBackends: readonly (number | undefined)[],
  options: {
    readonly errorMessages?: readonly (string | null)[];
    readonly backgroundStatements?: readonly string[];
    readonly backgroundPlans?: readonly unknown[];
    readonly backgroundPlanStatements?: readonly (number | undefined)[];
    readonly backgroundBackends?: readonly (number | undefined)[];
    readonly backgroundPlanBackends?: readonly (number | undefined)[];
  } = {},
): Capture {
  const backgroundStatements = options.backgroundStatements ?? [];
  const backgroundPlans = options.backgroundPlans ?? [];
  return {
    statements,
    requestBytes: statements.map(() => 12),
    responseBytes: statements.map(() => 20),
    plans,
    planStatements,
    statementErrors: errors,
    statementErrorMessages: options.errorMessages ?? errors.map(() => null),
    statementBackends: backends,
    planBackends,
    backgroundStatements,
    backgroundRequestBytes: backgroundStatements.map(() => 3),
    backgroundResponseBytes: backgroundStatements.map(() => 5),
    backgroundPlans,
    backgroundPlanStatements: options.backgroundPlanStatements ?? [],
    backgroundStatementErrors: backgroundStatements.map(() => null),
    backgroundStatementErrorMessages: backgroundStatements.map(() => null),
    backgroundStatementBackends: options.backgroundBackends ?? backgroundStatements.map(() => 909),
    backgroundPlanBackends: options.backgroundPlanBackends ?? backgroundPlans.map(() => 909),
  };
}

test('Imports keeps each native plan on its captured owner, backend, and execution occurrence', () => {
  // These hand-built captures prove the projection only; growth-outcomes remains the native proof.
  const failedThenSuccess = capture(
    [observedSql, observedSql],
    ['40001', null],
    [303, 303],
    [nativePlan(observedSql, 3)],
    [1],
    [303],
    {
      errorMessages: ['serialization failure', null],
      backgroundStatements: [backgroundSql],
      backgroundPlans: [nativePlan(backgroundSql, 1)],
      backgroundPlanStatements: [0],
      backgroundBackends: [909],
      backgroundPlanBackends: [909],
    },
  );
  const sameBackendDifferentOwner = capture(
    [observedSql, observedSql],
    [null, null],
    [303, 303],
    [nativePlan(observedSql, 9), nativePlan(observedSql, 4)],
    [1, 0],
    [303, 303],
    {
      backgroundStatements: [authBackgroundSql],
      backgroundPlans: [nativePlan(authBackgroundSql, 2)],
      backgroundPlanStatements: [0],
      backgroundBackends: [910],
      backgroundPlanBackends: [910],
    },
  );
  const distinctBackend = capture([observedSql], [null], [202], [nativePlan(observedSql, 5)], [0], [202]);

  let raw: Capture & Partial<ImportPostgresCapture> = { statements: [], plans: [] };
  raw = appendImportPostgresCapture(raw, failedThenSuccess, 'kernel');
  raw = appendImportPostgresCapture(raw, sameBackendDifferentOwner, 'auth');
  raw = appendImportPostgresCapture(raw, distinctBackend, 'auth');
  const before = structuredClone(raw);
  const canonicalCost = costOf(raw);

  const projected = associatePostgresStatements(raw as ImportPostgresCapture);

  expect(projected.map(({ explain }) => (explain ? JSON.parse(explain)[0]['Plan']['Actual Rows'] : null))).toEqual([
    null,
    3,
    4,
    9,
    5,
  ]);
  expect(projected.map(({ rowsAppended }) => rowsAppended)).toEqual([0, 6, 8, 18, 10]);
  expect(projected.reduce((total, statement) => total + statement.rowsAppended, 0)).toBe(42);
  expect(projected[0]).toEqual({ engine: 'postgres', sql: observedSql, explain: '', rowsAppended: 0 });

  // The failed occurrence retains its SQLSTATE, and the success on the same backend receives its own plan.
  expect(raw.statementErrors).toEqual(['40001', null, null, null, null]);
  expect(raw.statementErrorMessages).toEqual(['serialization failure', null, null, null, null]);
  expect(raw.statementBackends).toEqual([303, 303, 303, 303, 202]);
  expect(raw.planBackends).toEqual([303, 303, 303, 202]);
  expect(raw.planStatements).toEqual([1, 3, 2, 4]);
  expect(raw.importStatementOwners).toEqual(['kernel', 'kernel', 'auth', 'auth', 'auth']);
  expect(raw.importPlanOwners).toEqual(['kernel', 'auth', 'auth', 'auth']);

  // Keep every measured foreground/background entry and the canonical shared cost unchanged.
  expect(raw.statements).toEqual([observedSql, observedSql, observedSql, observedSql, observedSql]);
  expect(raw.plans).toEqual([
    nativePlan(observedSql, 3),
    nativePlan(observedSql, 9),
    nativePlan(observedSql, 4),
    nativePlan(observedSql, 5),
  ]);
  expect(
    raw.plans.flatMap((document) => document as { 'Query Text': string }[]).map((root) => root['Query Text']),
  ).toEqual([observedSql, observedSql, observedSql, observedSql]);
  expect(raw.requestBytes).toEqual([12, 12, 12, 12, 12]);
  expect(raw.responseBytes).toEqual([20, 20, 20, 20, 20]);
  expect(raw.backgroundStatements).toEqual([backgroundSql, authBackgroundSql]);
  expect(raw.backgroundRequestBytes).toEqual([3, 3]);
  expect(raw.backgroundResponseBytes).toEqual([5, 5]);
  expect(raw.backgroundPlans).toEqual([nativePlan(backgroundSql, 1), nativePlan(authBackgroundSql, 2)]);
  expect(raw.backgroundPlanStatements).toEqual([0, 1]);
  expect(raw.backgroundStatementErrors).toEqual([null, null]);
  expect(raw.backgroundStatementErrorMessages).toEqual([null, null]);
  expect(raw.backgroundStatementBackends).toEqual([909, 910]);
  expect(raw.backgroundPlanBackends).toEqual([909, 910]);
  expect(raw.importBackgroundStatementOwners).toEqual(['kernel', 'auth']);
  expect(raw.importBackgroundPlanOwners).toEqual(['kernel', 'auth']);
  expect(raw).toEqual(before);
  expect(costOf(raw)).toEqual(canonicalCost);
  expect(canonicalCost.plans).toBe(4);
});
