import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { dockerEnvironment, root, stream } from '../../../scripts/fixture/stack.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import type { CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import { restoreWorkProfileCorpus, type CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkProfile,
} from '../support/work-profile.ts';
import {
  readRetainedSeed,
  seedApi,
  seedAuthorName,
  seedSelection,
  seedDirectory,
  type RetainedSeedCut,
} from '../support/seed-checkpoints.ts';
import type { MediaStack } from './media-support.ts';
type MediaStackStarter = typeof import('./media-support.ts').startMediaStack;

const workAxis = 'unrelatedWorks' satisfies keyof CorpusDimensions;
// Own-shelf contract: readerShelfEntries at 4/16/64, one distinct Work per entry
// with a reading-status row on the same reader's shelf. The shelf page is bounded
// by its page size (linear during page fill, with bounded candidate lookahead).
// A single-Work status read stays constant: it uses reader/Work keys rather than
// enumerating the shelf. Indexed shelf seeks compose O(log N + P) with that bound.
const shelfAxis = 'readerShelfEntries' satisfies keyof CorpusDimensions;
type GrowthAxis = typeof workAxis | typeof shelfAxis;
type Operation = 'status-shelf' | 'reader-state';
const scales = [4, 16, 64] as const;
const serviceName = 'library-growth-cost';
const readerName = 'Library growth measurement reader';
type SqlEvidence = { text: string; callSites: string[] };

// Calibrated at 80cf2a520: two seven-statement baseline admission transactions
// plus three principal resolutions for status, or two for the shelf.
const MEMBERSHIP_SESSION_SQL_COST = { 'reader-state': 17, 'status-shelf': 16 } as const;
// Calibrated at 80cf2a520: ten agent-fence statements plus preferences, recovery,
// disclosure and addresses; the 20-item shelf can hydrate two candidate batches.
const ACCESS_DISCLOSURE_SQL_COST = { 'reader-state': 15, 'status-shelf': 24 } as const;
// Calibrated at 80cf2a520: one avatar read for status; two per shelf hydration,
// bounded by its two candidate batches at the 20-item page size.
const CONTENT_SQL_COST = { 'reader-state': 1, 'status-shelf': 4 } as const;
const NON_STORE_SQL_COST = {
  'membership/session': MEMBERSHIP_SESSION_SQL_COST,
  'Access/authority/disclosure': ACCESS_DISCLOSURE_SQL_COST,
  Content: CONTENT_SQL_COST,
} as const;
const SQL_GROUP_OWNER = {
  'library-revision': 'library store',
  'library-entries': 'library store',
  'baseline-member-admission': 'membership/session',
  'active-principal': 'membership/session',
  'agent-fence': 'Access/authority/disclosure',
  disclosure: 'Access/authority/disclosure',
  'canonical-address': 'Access/authority/disclosure',
  preferences: 'Access/authority/disclosure',
  'recovery-readiness': 'Access/authority/disclosure',
  'avatar-hydration': 'Content',
} as const;
type SqlGroup = keyof typeof SQL_GROUP_OWNER;
type SqlCounts = Record<SqlGroup, number>;
const sqlGroups = Object.keys(SQL_GROUP_OWNER) as SqlGroup[];

function sqlGroup(statement: SqlEvidence): SqlGroup {
  // Store budgets apply to these tables, regardless of the PostgreSQL owner.
  if (/\breader\.library_status_revision\b/.test(statement.text)) return 'library-revision';
  if (/\breader\.library_status\b/.test(statement.text)) return 'library-entries';
  const caller = statement.callSites[0] ?? '';
  // Transaction controls inherit the initiating admission/fence owner's scope.
  if (/baselineMemberDecision|baselineMemberProof|requireRecoveryOpen/.test(caller)
    || caller.includes('/access/admission.ts') && /^(BEGIN|SET LOCAL|COMMIT)\b/.test(statement.text.trim()))
    return 'baseline-member-admission';
  if (caller.includes('activePrincipalId')) return 'active-principal';
  if (caller.includes('/profiles/access.ts')) return 'agent-fence';
  if (caller.includes('/disclosure/read.ts')) return 'disclosure';
  if (caller.includes('/address/registry.ts')) return 'canonical-address';
  if (caller.includes('/preferences/store.ts')) return 'preferences';
  if (caller.includes('assertRecoveryOpen')) return 'recovery-readiness';
  if (/\b(content|media)\./.test(statement.text)) return 'avatar-hydration';
  throw new Error(`Unclassified library request SQL: ${caller}: ${statement.text.slice(0, 160)}`);
}

function sqlCount(counts: SqlCounts, owner: typeof SQL_GROUP_OWNER[SqlGroup]): number {
  return sqlGroups.filter(group => SQL_GROUP_OWNER[group] === owner)
    .reduce((total, group) => total + counts[group], 0);
}

async function reportSqlStatements() {
  // Pair local query text with the existing pg spans, without bound values or
  // changes to exported telemetry. No additional instrumentation or spans are added.
  const [{ Client, Pool }, { default: instrumentation }] = await Promise.all([
    import('pg'),
    import('@opentelemetry/instrumentation-pg/package.json'),
  ]);
  const tracer = trace.getTracer(instrumentation.name, instrumentation.version);
  const queries = new AsyncLocalStorage<SqlEvidence>();
  const evidence = new Map<string, SqlEvidence>();
  const originalStart = tracer.startSpan;
  const originalClientQuery = Client.prototype.query;
  const originalPoolQuery = Pool.prototype.query;
  const callSites = () => (new Error().stack ?? '').split('\n')
    .filter(line => line.includes('/services/') || line.includes('/tests/qa/'))
    .filter(line => !line.includes('/library-growth.test.ts'))
    .map(line => line.trim().replaceAll(`${root}/`, ''));
  const queryText = (input: unknown) => typeof input === 'string' ? input
    : input && typeof input === 'object' && 'text' in input && typeof input.text === 'string' ? input.text : '';

  tracer.startSpan = function (...args) {
    const span = originalStart.apply(this, args);
    const query = queries.getStore();
    if (query && args[1]?.attributes?.['db.system.name'] === 'postgresql') {
      const { traceId, spanId } = span.spanContext();
      evidence.set(`${traceId}:${spanId}`, query);
    }
    return span;
  };
  Pool.prototype.query = function (...args: Parameters<typeof originalPoolQuery>) {
    return queries.run({ text: queryText(args[0]), callSites: callSites() },
      () => originalPoolQuery.apply(this, args));
  } as typeof originalPoolQuery;
  Client.prototype.query = function (...args: Parameters<typeof originalClientQuery>) {
    const query = { text: queryText(args[0]), callSites: queries.getStore()?.callSites ?? callSites() };
    return queries.run(query, () => originalClientQuery.apply(this, args));
  } as typeof originalClientQuery;
  return {
    statements(profile: WorkProfile) {
      return profile.postgres.map(statement => {
        const query = evidence.get(`${profile.traceId}:${statement.spanId}`);
        if (!query?.text) throw new Error(`SQL reporting lacks text for ${statement.spanId}`);
        const group = sqlGroup(query);
        return { ...statement, ...query, group, owner: SQL_GROUP_OWNER[group] };
      });
    },
    clear: () => evidence.clear(),
    stop() {
      tracer.startSpan = originalStart;
      Client.prototype.query = originalClientQuery;
      Pool.prototype.query = originalPoolQuery;
    },
  };
}

type RestoredContext = {
  stack: MediaStack;
  readerToken: string;
  readerAgent: string;
  seededReaderToken: string;
  seededReaderAgent: string;
  seededShelfWorks: string[];
  targetWork: string;
  fusekiUrl: string;
};

async function openRestoredStack(input: CorpusRestoreSmokeInput, startMediaStack: MediaStackStarter) {
  const env = {
    ...input.apps,
    REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration',
    REZICS_STACK_PROFILE: 'qa',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    return await startMediaStack(`library-growth-${input.target}`, {
      library: true,
      ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!,
        content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
      },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

function actorCommand() {
  return {
    method: 'POST' as const,
    path: '/v1/agents' as const,
    body: {
      profile: 'agent-provision-v1',
      kind: 'person',
      displayName: readerName,
    },
  };
}

async function profileRead(
  context: RestoredContext,
  sink: ReturnType<typeof startWorkProfileSink>,
  path: string,
  token?: string,
) {
  const { result, profile } = await profileRequest(
    sink,
    async (headers) => {
      if (token) headers.set('authorization', `Bearer ${token}`);
      const response = await context.stack.main.handle(
        new Request(`http://main.local${path}`, { headers }),
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as Record<string, unknown>;
    },
    {
      service: serviceName,
      peers: { fuseki: context.fusekiUrl },
      flush: flushTelemetryTraces,
    },
  );
  expect(profile.mainCalls).toBe(0);
  expect(profile.unclassifiedFetches).toBe(0);
  return { result, profile };
}

function costContract(maxima: Omit<WorkCostContract, 'growth'>, axis: GrowthAxis, operation: Operation): WorkCostContract {
  // Own-shelf card hydration grows with P up to the 40-candidate window cap; the
  // indexed seek is O(log N + P). A single Work and unrelated data stay constant.
  const growthClass = axis === shelfAxis && operation === 'status-shelf' ? 'linear' : 'constant';
  return {
    ...maxima,
    growth: {
      fusekiRequests: { class: growthClass, dimension: 'mainCalls' },
      fusekiSentBytes: { class: growthClass, dimension: 'mainCalls' },
      fusekiReceivedBytes: { class: growthClass, dimension: 'mainCalls' },
      postgresStatements: { class: growthClass, dimension: 'mainCalls' },
    },
  };
}

test.todo('Library reads: unrelatedPosts growth coverage awaits kernel seed owner; retained cuts have zero Posts despite the summaries Post UNION');

test('Reader library shelf and Work status costs follow unrelated Work and own-shelf growth contracts', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through goalctl integration QA');
  }
  const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${runId}`);
  if (readEnv(join(sourceDirectory, 'compose.env')).REZICS_STACK_STORAGE !== 'persistent') {
    throw new Error('Library growth checkpoints require the persistent catalogue-disk QA project');
  }

  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions[workAxis])).toEqual(scales);
  expect(retained.axes[shelfAxis].map((cut) => cut.manifest.dimensions[shelfAxis])).toEqual(scales);
  const cuts = [...retained.axes[workAxis], ...retained.axes[shelfAxis]];
  for (const cut of cuts) {
    expect(cut.population.shelfWorks).toHaveLength(cut.manifest.dimensions[shelfAxis]!);
    expect(new Set(cut.population.shelfWorks).size).toBe(cut.population.shelfWorks.length);
  }
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry(serviceName, {
    ...process.env,
    ...sink.env,
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  // The backup driver also imports pg; defer it along with product composition
  // until the SDK can instrument SQL. Delaying only media-support misses it.
  const [
    { createCorpusBackupDriver },
    { READER_LIBRARY_COST },
    { STATUS_SHELF_COST },
    { startMediaStack },
  ] = await Promise.all([
    import('../../../scripts/load/corpus-backup-driver.ts'),
    import('../../../services/main/src/modules/library/read.ts'),
    import('../../../services/main/src/modules/library/status.ts'),
    import('./media-support.ts'),
  ]);
  const readerCost = {
    fusekiRequests: READER_LIBRARY_COST.graphCalls,
    fusekiReceivedBytes: READER_LIBRARY_COST.responseBytes,
    postgresStatements: READER_LIBRARY_COST.sqlReads,
    accountCalls: 0,
    otherFetches: 0,
    unclassifiedFetches: 0,
  } satisfies Omit<WorkCostContract, 'growth'>;
  // The shelf's SQL budget composes reader reads and indexed candidate batches.
  const shelfCost = {
    ...readerCost,
    postgresStatements: READER_LIBRARY_COST.sqlReads + STATUS_SHELF_COST.candidateBatches,
  } satisfies Omit<WorkCostContract, 'growth'>;
  const sqlReporter = await reportSqlStatements();
  const sqlReports: Array<{
    axis: GrowthAxis;
    size: number;
    operation: Operation;
    traceId: string;
    statements: ReturnType<typeof sqlReporter.statements>;
  }> = [];
  const reportDirectory = join(root, '.temp/work-profiles');
  const reportPath = join(reportDirectory, `library-sql-${runId}.json`);
  mkdirSync(reportDirectory, { recursive: true });
  let activeCut: RetainedSeedCut | undefined;
  const restored = new Map<string, RestoredContext>();
  const targets: string[] = [];
  const profiles: Array<{
    scale: number;
    axis: GrowthAxis;
    operation: Operation;
    profile: WorkProfile;
    sql: SqlCounts;
    pageBatches: number;
  }> = [];
  const driver = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId,
    directory: seedDirectory,
    resumeSource: false,
    restoreResourceClass: 'ordinary',
    quiesce: async () => {
      throw new Error('Routine growth measurement only restores retained checkpoints');
    },
    async smokeRead(input) {
      const stack = await openRestoredStack(input, startMediaStack);
      try {
        if (!activeCut) throw new Error('No active retained Work-profile checkpoint');
        const target = activeCut.population.works[0]!;
        expect(activeCut.population.shelfWorks).toContain(target.work);
        const author = await stack.member(seedAuthorName, { stable: true, verified: true });
        const authorApi = seedApi(stack, author.token);
        const selected = await authorApi.read(seedSelection(target.mainVersion));
        expect(selected).toMatchObject({
          work: target.work,
          mainVersion: target.mainVersion,
          body: 'Checkpoint population text 0',
        });

        const reader = await stack.member(`library-growth-${input.target}`, {
          stable: true,
          verified: true,
        });
        const readerApi = seedApi(stack, reader.token);
        const agent = await readerApi.command<{ agent: string }>(
          `library-growth:${input.target}:agent`,
          actorCommand(),
        );
        await readerApi.command(`library-growth:${input.target}:status`, {
          method: 'PUT',
          path: `/v1/works/${target.work.slice(-36)}/reader-status`,
          body: {
            actingSubject: agent.agent,
            expectedVersion: 0,
            status: 'reading',
            startedOn: null,
            finishedOn: null,
          },
        });

        restored.set(input.target, {
          stack,
          readerToken: reader.token,
          readerAgent: agent.agent,
          seededReaderToken: author.token,
          seededReaderAgent: activeCut.population.actor,
          seededShelfWorks: activeCut.population.shelfWorks,
          targetWork: target.work,
          fusekiUrl: input.apps.FUSEKI_URL!,
        });
        return async () => {
          restored.delete(input.target);
          await stack.stop();
        };
      } catch (error) {
        await stack.stop();
        throw error;
      }
    },
  });

  try {
    await stream(
      'task',
      ['stack:down', '--', '--profile', 'qa', '--run-id', runId, '--persistent'],
      dockerEnvironment(),
    );

    for (const cut of cuts) {
      activeCut = cut;
      const scale = cut.manifest.dimensions[workAxis];
      const target = `lib-growth-${cut.manifest.dimension}-${cut.manifest.scale}-${runId}`;
      targets.push(target);
      const restoreStarted = performance.now();
      const elapsedMs = await restoreWorkProfileCorpus(cut.manifest, target, driver, restoreStarted);
      expect(elapsedMs).toBeLessThan(600_000);
      const context = restored.get(target);
      if (!context) throw new Error(`Restored library checkpoint ${target} is unavailable`);

      // A public Work-page request must prove both meters in this same harness before
      // a zero from either library endpoint can be interpreted as a measured zero.
      const calibration = await profileRead(
        context,
        sink,
        `/v1/works/${context.targetWork.slice(-36)}?language=en`,
      );
      console.log('Library growth meter calibration', {
        dimension: workAxis,
        size: scale,
        postgresStatements: calibration.profile.postgresStatements,
        fusekiRequests: calibration.profile.fusekiRequests,
      });
      if (
        (calibration.profile.postgresStatements ?? 0) <= 0 ||
        (calibration.profile.fusekiRequests ?? 0) <= 0
      ) {
        throw new Error(
          `Library growth meter wiring failed at ${scale} Works: known public Work read must have nonzero postgresStatements and fusekiRequests`,
        );
      }
      expect(calibration.result).toMatchObject({ profile: 'work-read-v1', id: context.targetWork });
      sink.clear();

      for (const axis of [cut.manifest.dimension as typeof workAxis | typeof shelfAxis]) {
        const ownShelf = axis === shelfAxis;
        const size = cut.manifest.dimensions[axis]!;
        const actingSubject = encodeURIComponent(ownShelf ? context.seededReaderAgent : context.readerAgent);
        const token = ownShelf ? context.seededReaderToken : context.readerToken;
        const requests = [
          {
            operation: 'status-shelf' as const,
            path: `/v1/me/shelves/status/reading/works?actingSubject=${actingSubject}&sort=added&order=desc&limit=${STATUS_SHELF_COST.pageSize}`,
          },
          {
            operation: 'reader-state' as const,
            path: `/v1/works/${context.targetWork.slice(-36)}/reader-state?actingSubject=${actingSubject}`,
          },
        ];
        for (const request of requests) {
          const { result, profile } = await profileRead(context, sink, request.path, token);
          const statements = sqlReporter.statements(profile);
          expect(statements).toHaveLength(profile.postgresStatements!);
          const sql = Object.fromEntries(sqlGroups.map(group => [group, 0])) as SqlCounts;
          for (const statement of statements) sql[statement.group]++;
          // A full first candidate batch triggers bounded lookahead. Derive the
          // expected step from the seeded shelf size, never from observed costs.
          const pageBatches = ownShelf && request.operation === 'status-shelf'
            ? Math.min(STATUS_SHELF_COST.candidateBatches, 1 + Math.floor(size / STATUS_SHELF_COST.candidateBatch))
            : 1;
          sqlReports.push({ axis, size, operation: request.operation, traceId: profile.traceId, statements });
          writeFileSync(reportPath, JSON.stringify(sqlReports, null, 2) + '\n', { mode: 0o600 });
          console.log('Library SQL report', { axis, size, operation: request.operation,
            statements: statements.length, path: reportPath });
          sqlReporter.clear();
          if (request.operation === 'status-shelf') {
            const shelf = result as { items: Array<{ work: string; status: string }> };
            expect(shelf.items).toHaveLength(ownShelf ? Math.min(size, STATUS_SHELF_COST.pageSize) : 1);
            expect(new Set(shelf.items.map(item => item.work)).size).toBe(shelf.items.length);
            for (const item of shelf.items) {
              expect(item.status).toBe('reading');
              expect(ownShelf ? context.seededShelfWorks : [context.targetWork]).toContain(item.work);
            }
          } else {
            expect(result).toMatchObject({
              work: context.targetWork,
              status: { status: 'reading' },
            });
          }

          // assertWorkCostAtScales consumes a WorkProfile dimension. Use its marker
          // for the retained checkpoint size; mainCalls itself was checked above.
          profiles.push({
            scale: size,
            axis,
            operation: request.operation,
            profile: { ...profile, mainCalls: size },
            sql,
            pageBatches,
          });
          console.log('Library growth counters', {
            dimension: axis,
            size,
            operation: request.operation,
            fusekiRequests: profile.fusekiRequests,
            fusekiSentBytes: profile.fusekiSentBytes,
            fusekiReceivedBytes: profile.fusekiReceivedBytes,
            postgresStatements: profile.postgresStatements,
          });
          console.log('Library SQL owner counters', { dimension: axis, size, operation: request.operation,
            pageBatches, libraryStore: sqlCount(sql, 'library store'),
            membershipSession: sqlCount(sql, 'membership/session'),
            accessDisclosure: sqlCount(sql, 'Access/authority/disclosure'), content: sqlCount(sql, 'Content') });
          sink.clear();
        }
      }
      await driver.stop(target);
    }

    const failures: string[] = [];
    const check = (group: WorkProfile[], contract: WorkCostContract, label: string, owner: string) => {
      try {
        assertWorkCostAtScales(group, contract, label);
        console.log('Library growth verdict', { label, owner, verdict: 'pass' });
      } catch (error) {
        const failure = `${label}, owner ${owner}: ${error instanceof Error ? error.message : String(error)}`;
        console.log('Library growth verdict', { label, owner, verdict: 'fail', failure });
        failures.push(failure);
      }
    };
    for (const axis of [workAxis, shelfAxis]) {
      for (const operation of ['status-shelf', 'reader-state'] as const) {
        const maxima = operation === 'status-shelf' ? shelfCost : readerCost;
        const measured = profiles
          .filter((item) => item.operation === operation && item.axis === axis)
          .sort((a, b) => a.scale - b.scale);
        const group = measured.map(item => ({ ...item.profile, postgresStatements: sqlCount(item.sql, 'library store') }));
        const label = `library-${operation}-${axis}`;
        check(group, costContract(maxima, axis, operation), label,
          operation === 'status-shelf' ? 'library/read.ts::readStatusShelf and library/status.ts::sortedPage'
            : 'library/read.ts::readReaderStates');
        // Preserve the measured whole-request counter alongside store and owner
        // slices: its absolute bound composes the declared budgets, not their usage.
        const requestCost = { ...maxima, postgresStatements: maxima.postgresStatements
          + Object.values(NON_STORE_SQL_COST).reduce((total, budget) => total + budget[operation], 0) };
        check(measured.map(item => item.profile), costContract(requestCost, axis, operation),
          `${label}-request`, 'Main full request');
        for (const owner of ['membership/session', 'Access/authority/disclosure', 'Content'] as const) {
          const scoped = measured.map(item => ({ ...item.profile, postgresStatements: sqlCount(item.sql, owner) }));
          check(scoped, { postgresStatements: NON_STORE_SQL_COST[owner][operation] },
            `${label}-${owner.replaceAll(/[^a-zA-Z]/g, '-')}-budget`, owner);
        }
        for (const sqlGroup of sqlGroups.filter(group => SQL_GROUP_OWNER[group] !== 'library store')) {
          const owner = SQL_GROUP_OWNER[sqlGroup];
          if (owner === 'library store') continue;
          const scoped = measured.map(item => ({ ...item.profile,
            // Only these hydration groups can take the shelf's own page-fill
            // step. Their cost per seeded candidate batch must remain flat.
            postgresStatements: item.sql[sqlGroup] / (['disclosure', 'canonical-address', 'avatar-hydration'].includes(sqlGroup)
              ? item.pageBatches : 1) }));
          check(scoped, { growth: { postgresStatements: { class: 'constant', dimension: 'mainCalls' } } },
            `${label}-${sqlGroup}-growth`, owner);
        }
        for (const counter of ['fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes', 'postgresStatements'] as const) {
          const ratio = (from: number, to: number) => {
            const smaller = group[from]![counter], larger = group[to]![counter];
            return smaller === null || larger === null ? null : smaller === 0
              ? larger === 0 ? 1 : 'Infinity' : larger / smaller;
          };
          console.log('Library growth ratios', { dimension: axis, operation, counter,
            ratio16To4: ratio(0, 1), ratio64To16: ratio(1, 2), ratio64To4: ratio(0, 2) });
        }
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    sqlReporter.stop();
    const cleanupErrors: unknown[] = [];
    for (const target of targets) {
      try {
        await driver.stop(target);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const context of restored.values()) {
      try {
        await context.stack.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await shutdownTelemetry();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await sink.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Library growth cleanup failed');
  }
}, 600_000);
