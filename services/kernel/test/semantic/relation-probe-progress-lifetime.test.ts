import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { deadlineFor, withRequestDeadline } from '../../src/request/deadline.ts';
import type { SelectedStatement } from '../../src/semantic/search-relations.ts';

test('retained relation progress expires on its original budget and resumes an uncertain committed cursor', async (t) => {
  const budget = 2000;
  const zero = '00000000-0000-0000-0000-000000000000';
  const subjectId = '00000000-0000-4000-8000-000000000001';
  const targetId = '00000000-0000-4000-8000-000000000002';
  const property = 'schema:character';
  const digest = 'retained-relation-release';
  const release = { properties: { [property]: { datatype: 'wikibase-item' } } };
  const runtime = { release, digest, head: '1' };
  const subject = {
    id: subjectId,
    route: 1,
    type: 'schema:CreativeWork',
    visibility: 'visible',
    redirect: null,
    currentRelease: digest,
    securityRevision: '1',
    current_revision: 7,
    selection_ready: true,
  };
  const rejected: SelectedStatement = {
    route: 1,
    subject_id: subjectId,
    slot_id: '00000000-0000-4000-8000-000000000010',
    candidate_id: '00000000-0000-4000-8000-000000000011',
    property,
    rank: 'normal',
    ordinal: 0,
    revision: 7,
    body: { value: { type: 'value', content: targetId } },
    release: digest,
    source: null,
    relation: true,
    eligible: false,
  };
  type Cursor = { after_slot: string; after_candidate: string };
  type Progress = Cursor & {
    route: number;
    subject_id: string;
    property: string;
    value: string;
    revision: number;
    previous_slot: string;
    previous_candidate: string;
  };
  type Query = { text: string; values?: unknown[]; query_timeout?: number };
  let cursor: Cursor = { after_slot: zero, after_candidate: zero };
  const seeks: Cursor[] = [];
  const writes: { progress: Progress; timeout: number | undefined }[] = [];
  const releases: (Error | undefined)[] = [];
  let held = 0;
  let checkouts = 0;
  let progressStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    progressStarted = resolve;
  });
  let completeProgress!: (result: { rows: unknown[] }) => void;
  const stalledProgress = new Promise<{ rows: unknown[] }>((resolve) => {
    completeProgress = resolve;
  });
  const pool = {
    async connect() {
      assert.equal(held, 0, 'local native ownership must end before another checkout');
      held++;
      checkouts++;
      return {
        async query(input: Query | string) {
          const query: Query = typeof input === 'string' ? { text: input } : input;
          if (query.text !== 'relation-progress') {
            assert.ok(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'].includes(query.text));
            return { rows: [] };
          }
          const [progress] = query.values![0] as Progress[];
          assert.ok(progress);
          assert.equal(progress.previous_slot, cursor.after_slot);
          assert.equal(progress.previous_candidate, cursor.after_candidate);
          assert.equal(progress.revision, subject.current_revision);
          writes.push({ progress: { ...progress }, timeout: query.query_timeout });
          // The server may commit before the client receives completion. Retirement must not undo this.
          cursor = { after_slot: progress.after_slot, after_candidate: progress.after_candidate };
          if (writes.length === 1) {
            progressStarted();
            return stalledProgress;
          }
          return { rows: [] };
        },
        release(error?: Error) {
          assert.equal(held, 1);
          held--;
          releases.push(error);
        },
      };
    },
    query() {
      assert.fail('Derived writes must not dispatch through the pool');
    },
  } as unknown as Pool;

  // Keep the real retained Search page, request context, and physical connection owner.
  // Isolate native rows and admission; integrated relation/voice witness receivers are separate acceptance.
  t.mock.module('../../src/commerce/config.ts', { namedExports: { ConfigError: class extends Error {} } });
  t.mock.module('../../src/database/read-snapshot.ts', {
    namedExports: {
      partitionReadClient: () => assert.fail('No partition read client is requested'),
      partitionReadClientObservation: () => assert.fail('No partition read observation is requested'),
      partitionReadClients: () => assert.fail('No partition read clients are requested'),
    },
  });
  t.mock.module('../../src/database/bounded-read-window.ts', {
    namedExports: { boundedReadWindow: () => assert.fail('No separate read window is requested') },
  });
  const { withBoundedReadOnlyTransaction } = await import('../../src/database/pool.ts');
  t.mock.module('@rezics/definitions', { namedExports: { releaseDigest: () => digest } });
  t.mock.module('@rezics/filter', {
    namedExports: {
      createFilterConstruction: () => ({ admitFilter() {} }),
      facetProperties: () => [property],
      FilterError: class extends Error {},
      parseFilter() {},
      readNativeSpoilerLevel: () => null,
      relationFacetProperty: () => true,
    },
  });
  t.mock.module('../../src/command/command.ts', { namedExports: { DEFAULT_REQUEST_DEADLINE_MS: budget } });
  t.mock.module('../../src/partition/partition.ts', {
    namedExports: { readPartition: async () => ({ writeState: 'active' }) },
  });
  t.mock.module('../../src/route/route.ts', { namedExports: { routeOf: () => 1, partitionOf: () => 0 } });
  t.mock.module('../../src/content/source-fences.ts', {
    namedExports: { readFences: () => assert.fail('No imported tuple is present') },
  });
  t.mock.module('../../src/semantic/fences.ts', {
    namedExports: { sourceTuple: () => assert.fail('No imported tuple is present') },
  });
  t.mock.module('../../src/semantic/definition-release-read.ts', {
    namedExports: { activeRelease: async () => runtime, readRelease: async () => release },
  });
  t.mock.module('../../src/search/current-leaf.ts', {
    namedExports: { holdsCurrentStatements: () => assert.fail('Ineligible rows cannot become witnesses') },
  });
  t.mock.module('../../src/search/concept-browse-statements.ts', {
    namedExports: {
      nativeConceptStatementCoverage: () => assert.fail('No concept probe is present'),
      conceptStatementRequest: () => assert.fail('No concept probe is present'),
      conceptStatementQualifiers: () => assert.fail('No concept probe is present'),
    },
  });
  t.mock.module('../../src/semantic/search-source.ts', {
    namedExports: {
      indexedStatement: () => assert.fail('Ineligible rows cannot become witnesses'),
      readSearchCanonicalGeneration: () => assert.fail('No concept probe is present'),
      inSearchSnapshot: <T>(connectionPool: Pool, work: (client: PoolClient) => Promise<T>) =>
        withBoundedReadOnlyTransaction(connectionPool, deadlineFor(budget), work, {
          deadlineError: () => new AccessUnavailableError('deadline'),
        }),
    },
  });
  t.mock.module('../../src/semantic/search-source-subjects.sql', {
    defaultExport: { run: async () => [subject] },
  });
  t.mock.module('../../src/semantic/search-source-releases.sql', {
    defaultExport: { run: async () => [{ digest, body: release }] },
  });
  t.mock.module('../../src/semantic/search-selected-cursors.sql', {
    defaultExport: {
      run: async (_: PoolClient, { requests }: { requests: object[] }) =>
        requests.map((request) => ({ ...request, ...cursor })),
    },
  });
  t.mock.module('../../src/semantic/search-selected-probe-batch.sql', {
    defaultExport: {
      run: async (_: PoolClient, { requests }: { requests: Cursor[] }) => {
        const position = requests[0]!;
        seeks.push({ after_slot: position.after_slot, after_candidate: position.after_candidate });
        return position.after_slot === zero ? [rejected] : [];
      },
    },
  });
  t.mock.module('../../src/semantic/search-selected-progress.sql', {
    defaultExport: {
      run: (client: PoolClient, { progress }: { progress: Progress[] }) =>
        client.query({ text: 'relation-progress', values: [progress] }),
    },
  });
  for (const name of [
    'search-source-concepts',
    'search-source-concept-observation',
    'search-source-concept-children',
    'search-selected-batch',
    'search-selected-rebuild',
  ])
    t.mock.module(new URL(`../../src/semantic/${name}.sql`, import.meta.url), {
      defaultExport: { run: () => assert.fail(`Unexpected native work: ${name}`) },
    });

  const { relationSource } = await import('../../src/semantic/search-relations.ts');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const source = relationSource(pool, new Uint8Array(32));
  const probes = [{ subject: subjectId, property, value: targetId }];
  const page = await withRequestDeadline(1100, () => source.preparePage(probes));
  assert.equal(held, 0);
  assert.equal(deadlineFor(budget), 3000, 'preparation has left the ambient request');
  t.mock.timers.tick(70);

  // Even an unrelated later request must not replenish the retained page's budget.
  const matching = withRequestDeadline(9000, () => page.match());
  const expired = assert.rejects(
    matching,
    (error: unknown) => error instanceof AccessUnavailableError && error.reason === 'deadline',
  );
  await started;
  assert.equal(writes[0]!.timeout, 30);
  t.mock.timers.tick(30);
  await expired;
  await setImmediate();
  assert.equal(held, 0, 'the stalled progress checkout is released without waiting for native completion');
  const discarded = releases.filter((error) => error !== undefined);
  assert.equal(discarded.length, 1);
  assert.ok(discarded[0] instanceof AccessUnavailableError);
  assert.equal(discarded[0].reason, 'deadline');
  const committed = { after_slot: rejected.slot_id, after_candidate: rejected.candidate_id };
  assert.deepEqual(cursor, committed);

  const released = releases.length;
  completeProgress({ rows: [] });
  await setImmediate();
  assert.equal(releases.length, released, 'late completion cannot release or revive the retired client');
  assert.equal(writes.length, 1);
  assert.deepEqual(cursor, committed);
  const beforeExpiredRevalidation = checkouts;
  await assert.rejects(
    page.revalidate(),
    (error: unknown) => error instanceof AccessUnavailableError && error.reason === 'deadline',
  );
  assert.equal(checkouts, beforeExpiredRevalidation, 'expired retained calls fail before checkout');

  const resumed = await source.preparePage(probes);
  assert.deepEqual(seeks, [{ after_slot: zero, after_candidate: zero }, committed]);
  assert.deepEqual(await resumed.match(), ['not_proven'], 'EOF does not invent absence after uncertain progress');
  assert.equal(writes[1]!.timeout, budget, 'a new page outside request work receives the established default');
  assert.deepEqual(writes[1]!.progress, {
    route: 1,
    subject_id: subjectId,
    property,
    value: targetId,
    revision: 7,
    previous_slot: rejected.slot_id,
    previous_candidate: rejected.candidate_id,
    after_slot: zero,
    after_candidate: zero,
  });
  assert.deepEqual(cursor, { after_slot: zero, after_candidate: zero }, 'healthy EOF retains the existing resweep');
  assert.deepEqual(await (await source.preparePage(probes)).match(), ['not_proven']);
  assert.equal(held, 0);
  assert.equal(releases.filter((error) => error !== undefined).length, 1);
});
