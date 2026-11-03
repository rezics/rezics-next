import type { ProfileMigrationBoundary, ProfileMigrationPage } from '../../../../../specs/library-profiles-driver.ts';
import type {
  LibraryProfileMigrationObservation,
  LibraryProfileMigrationPageObservation,
} from '../../../src/library/profile-migration-runtime.ts';
import { costOf, type Capture } from '../../support/growth.ts';
import { explainPlanEntries, walkPlanTree } from '../../support/growth-plan-walk.ts';
import { unavailable } from './native-conformance.ts';

export class ProfileMigrationCrash extends Error {
  constructor(readonly boundary: ProfileMigrationBoundary) {
    super(`Native Library migration interrupted at ${boundary}`);
  }
}
type CapturedPage = { page: LibraryProfileMigrationPageObservation; capture?: Capture; measurementError?: unknown };

/** One fixture's controls. A fault is consumed before waiting/throwing, so retries
 * cannot re-arm it. Operations and every recovery use the production executor. */
export function createProfileMigrationObservation() {
  const attempts: CapturedPage[] = [];
  let fault: {
    boundary: ProfileMigrationBoundary;
    hit(): void | Promise<void>;
  } | undefined;
  const arm = (next: NonNullable<typeof fault>) => {
    if (fault) throw new Error('A native migration interruption is already armed');
    fault = next;
  };
  return {
    attempts,
    async observe(event: LibraryProfileMigrationObservation) {
      if (event.kind === 'settled') attempts.push({ page: event.page });
      else if (fault?.boundary === event.boundary) {
        const current = fault;
        fault = undefined;
        await current.hit();
      }
    },
    pause(boundary: ProfileMigrationBoundary) {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      arm({ boundary, hit: async () => { reached.resolve(); await released.promise; } });
      return { reached: reached.promise, async resume() { released.resolve(); } };
    },
    crash(boundary: ProfileMigrationBoundary) {
      arm({ boundary, hit: () => { throw new ProfileMigrationCrash(boundary); } });
    },
    async capture<T>(
      operation: () => Promise<T>,
      capture: (operation: () => Promise<
        { ok: true; value: T } | { ok: false; error: unknown }
      >) => Promise<{ value: { ok: true; value: T } | { ok: false; error: unknown }; capture: Capture }>,
    ): Promise<T> {
      const start = attempts.length;
      // Keep the native capture on failure, including ROLLBACK and wire costs.
      const measured = await capture(async () => {
        try { return { ok: true as const, value: await operation() }; }
        catch (error) { return { ok: false as const, error }; }
      });
      const cursors = new Map<number, number>();
      for (const attempt of attempts.slice(start)) {
        const backend = attempt.page.backendId;
        try {
          const sliced = transactionCapture(measured.capture, backend, cursors.get(backend) ?? 0);
          cursors.set(backend, sliced.end + 1);
          attempt.capture = sliced.capture;
        } catch (error) {
          attempt.measurementError = error;
        }
      }
      if (!measured.value.ok) throw measured.value.error;
      return measured.value.value;
    },
    pages(): ProfileMigrationPage[] {
      return attempts.map(({ page, capture, measurementError }) => {
        if (measurementError) throw measurementError;
        return profilePage(page, capture);
      });
    },
  };
}

/** Attribute by backend AND the actual transaction, excluding readProgress and
 * any concurrent HTTP transaction captured on a different connection. */
function transactionCapture(capture: Capture, backend: number, from: number) {
  if (!capture.statementBackends || !capture.planStatements)
    return unavailable('native migration transaction/backend plan attribution');
  const marker = capture.statements.findIndex((sql, index) => index >= from &&
    capture.statementBackends![index] === backend && sql.includes('pg_current_xact_id()'));
  if (marker < 0) return unavailable('native migration transaction identity statement');
  let begin = marker;
  while (begin >= from && !(capture.statementBackends[begin] === backend &&
    /^BEGIN ISOLATION LEVEL SERIALIZABLE$/i.test(capture.statements[begin]!.trim()))) begin--;
  const end = capture.statements.findIndex((sql, index) => index > marker &&
    capture.statementBackends![index] === backend && /^(COMMIT|ROLLBACK)$/i.test(sql.trim()));
  if (begin < from || end < 0) return unavailable('native migration transaction begin/end');
  const statements = capture.statements.flatMap((_, index) =>
    index >= begin && index <= end && capture.statementBackends![index] === backend ? [index] : []);
  const indexes = new Map(statements.map((index, offset) => [index, offset]));
  const plans = capture.plans.flatMap((_, index) =>
    indexes.has(capture.planStatements![index] ?? -1) ? [index] : []);
  return {
    end,
    capture: {
      statements: statements.map((index) => capture.statements[index]!),
      statementBackends: statements.map((index) => capture.statementBackends![index]),
      ...(capture.requestBytes ? { requestBytes: statements.map((index) => capture.requestBytes![index]!) } : {}),
      ...(capture.responseBytes ? { responseBytes: statements.map((index) => capture.responseBytes![index]!) } : {}),
      ...(capture.statementErrors ? { statementErrors: statements.map((index) => capture.statementErrors![index]!) } : {}),
      plans: plans.map((index) => capture.plans[index]),
      planStatements: plans.map((index) => indexes.get(capture.planStatements![index]!)),
      ...(capture.planBackends ? { planBackends: plans.map((index) => capture.planBackends![index]) } : {}),
      ...(capture.planDatabases ? { planDatabases: plans.map((index) => capture.planDatabases![index]) } : {}),
    } satisfies Capture,
  };
}

function profilePage(page: LibraryProfileMigrationPageObservation, capture?: Capture): ProfileMigrationPage {
  if (!capture) return unavailable('native migration page Performance capture');
  const cost = costOf(capture);
  if (cost.requestBytes === undefined || cost.responseBytes === undefined)
    return unavailable('native migration page SQL wire bytes');
  const sourcePlans: ProfileMigrationPage['sourcePlans'] = [];
  const relationRowsRead: Record<string, number> = {};
  for (const relation of Object.values(cost.relations)) {
    if (!relation.identity?.schema) return unavailable('native migration relation identity');
    const name = `${relation.identity.schema}.${relation.identity.name}`;
    relationRowsRead[name] = (relationRowsRead[name] ?? 0) + relation.rows;
  }
  const explainedSources = new Set<string>();
  for (let index = 0; index < capture.plans.length; index++) {
    const statement = capture.statements[capture.planStatements?.[index] ?? -1];
    if (!statement) return unavailable('native migration page statement/plan identity');
    if (!statement.includes('library.profileMigration.source:')) continue;
    for (const { plan, location } of explainPlanEntries(capture.plans[index])) {
      for (const { node } of walkPlanTree(plan, location)) {
        if (node.Schema !== 'library' || !['entry', 'progress_session', 'copy'].includes(String(node['Relation Name']))) continue;
        const loops = node['Actual Loops'];
        const rows = node['Actual Rows'];
        const filtered = node['Rows Removed by Filter'] ?? 0;
        if (typeof loops !== 'number' || typeof rows !== 'number' || typeof filtered !== 'number')
          return unavailable('native migration source scan rows/loops');
        const relation = `library.${node['Relation Name']}`;
        sourcePlans.push({ relation, indexName: String(node['Index Name'] ?? ''),
          rowsExamined: (rows + filtered) * loops, rowsRemovedByFilter: filtered * loops });
        explainedSources.add(relation);
      }
    }
  }
  for (const source of page.sources) {
    const relation = `library.${source.phase === 'session' ? 'progress_session' : source.phase}`;
    if (!explainedSources.has(relation)) return unavailable(`native migration ${relation} source plan`);
  }
  return {
    transactionId: page.transactionId,
    ownerRowsRead: page.sources.reduce((n, source) => n + source.rows.length, 0),
    ownerRowsChanged: page.sources.reduce((n, source) => n + source.changedIds.length, 0),
    sourceRowsExamined: sourcePlans.reduce((n, source) => n + source.rowsExamined, 0), sourcePlans,
    bytesRead: cost.responseBytes, bytesWritten: cost.requestBytes, statements: cost.statements,
    relationRowsRead,
    get relationRowsWritten(): Record<string, number> {
      // RETURNING source IDs do not measure the checkpoint, index-maintenance
      // triggers or durable intent's affected tuples. Performance owns this gap.
      return unavailable('native migration per-relation affected-row attribution including triggers');
    },
    checkpointBefore: page.checkpointBefore, checkpointAfter: page.checkpointAfter,
    committed: page.committed, ownerFenceChecked: page.ownerFenceChecked,
  };
}
