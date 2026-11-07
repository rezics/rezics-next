import { AUTH_SDK_RETIREMENT_DISPATCH } from '../contract/index.ts';

function sum(
  parts: readonly { rows: number; points: number; statements: number; bytes: number; engineRequests: number }[],
) {
  return parts.reduce(
    (total, part) => ({
      rows: total.rows + part.rows,
      points: total.points + part.points,
      statements: total.statements + part.statements,
      bytes: total.bytes + part.bytes,
      engineRequests: total.engineRequests + part.engineRequests,
    }),
    { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  );
}

const envelope = [
  AUTH_SDK_RETIREMENT_DISPATCH.attempt,
  AUTH_SDK_RETIREMENT_DISPATCH.wait,
  AUTH_SDK_RETIREMENT_DISPATCH.backoff,
  AUTH_SDK_RETIREMENT_DISPATCH.reconcile,
] as const;

const retireBody = [
  AUTH_SDK_RETIREMENT_DISPATCH.rollback,
  AUTH_SDK_RETIREMENT_DISPATCH.begin,
  AUTH_SDK_RETIREMENT_DISPATCH.settings,
  AUTH_SDK_RETIREMENT_DISPATCH.lock,
  AUTH_SDK_RETIREMENT_DISPATCH.retire,
  AUTH_SDK_RETIREMENT_DISPATCH.commit,
] as const;

/** Nested Auth retention cost. A short returned page cannot reprice raw work. */
export const AUTH_WORKFLOW_RETENTION_COST = Object.freeze({
  rawLimit: 1000,
  maxPages: 60,
  preparation: Object.freeze({
    statements: 3,
    connections: 1,
    description: 'BEGIN/read/COMMIT of the singleton continuation',
  }),
  examination: Object.freeze({ statements: 5, connections: 1, description: 'BEGIN/read/page/update/COMMIT' }),
  initialization: Object.freeze({
    statements: 10,
    description: 'preparation plus the SDK upper-key seek and continuation write',
  }),
  emptyOmitsPage: Object.freeze({
    statements: 3,
    description: 'an empty captured horizon commits preparation and skips the page query',
  }),
  fundedClose: Object.freeze(sum([...envelope, ...retireBody])),
  technicalDelete: Object.freeze({
    applicationStatements: 4,
    controlStatements: 2,
    description: 'SDK deleteWorkflows(ids, false): BEGIN, four exact-ID deletes, COMMIT',
  }),
  requestTrigger: Object.freeze({
    statements: 1,
    description: 'auth_delete_workflow_request fires inside the SDK deletion transaction',
  }),
  absenceProbes: Object.freeze({
    families: 8,
    description: 'exact physical family probes after funded payload deletion',
  }),
  personalCopy: Object.freeze({
    artifacts: 139,
    bytes: 10 * 1024 * 1024,
    roles: 16,
    resultBytes: 64 * 1024,
    description: 'one admitted consumer neighbourhood, never priced by callback count',
  }),
});
