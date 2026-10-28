import { expect, test } from 'bun:test';
import { systemClock } from '../../src/clock.ts';
import { randomUUID } from 'node:crypto';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type {
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { SearchPlan } from '../../src/search/query.ts';
import { capture, costOf } from '../support/growth.ts';
import {
  complete,
  capturedStep,
  fixture,
  head,
  home,
  nativeProducer,
  statement,
} from '../semantic/support/public-filter-source.ts';
import { createPublicFilterConsumerFixture } from './support/public-filter-consumer.ts';

const context = () => ({ deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) });
const positive = (author: string): SearchPlan => ({
  sort: 'id',
  size: 20,
  filter: compileFilter({ statement: { property: 'schema:author', in: [author] } }, { prefix: 'native-' }).query,
});
const negative = (author: string): SearchPlan => ({
  sort: 'name',
  size: 20,
  filter: compileFilter(
    { and: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:author', in: [author] } } }] },
    { prefix: 'native-' },
  ).query,
});

async function setup(type = 'schema:Book') {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const url = process.env.OPENSEARCH_URL;
    if (!url) throw new Error('OPENSEARCH_URL must name the configured native engine');
    const search = createOpenSearch(url);
    const consumer = await createPublicFilterConsumerFixture({
      pool: f.db.pool,
      source,
      search,
      clock: systemClock,
      context: context(),
      meaning: { ...f.meaning, type },
    });
    return {
      f,
      source,
      search,
      consumer,
      operations: consumer.operations,
      async close() {
        try {
          await consumer.close();
        } finally {
          await f.close();
        }
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
type Native = Awaited<ReturnType<typeof setup>>;

async function settle(n: Native, job: PublicFilterConsumerJob) {
  // Finite small native fixture. Each retry uses ONLY the retained job, never supplied repair truth.
  for (let step = 0; step < 256; step++) {
    const result = await capturedStep(n.f.db, () => n.operations.repairStep(job, context()));
    expect(['progress', 'settled']).toContain(result.status);
    if (result.status === 'settled') return;
  }
  throw new Error('Finite native consumer repair did not finish');
}
async function captured(n: Native, plan: SearchPlan, snapshot: 'pit' | 'prepared' = 'pit') {
  for (let step = 0; step < 256; step++) {
    const result = await n.operations.capture({ plan, snapshot }, context());
    expect(['captured', 'preparing']).toContain(result.status);
    if (result.status === 'captured') {
      expect(result.queried.consumer.physicalTarget).toBe(n.consumer.physicalTarget);
      expect(result.queried.consumer.incarnation).toBe(await n.consumer.incarnation());
      expect(result.queried.consumer.meaningDigest).toBe(n.f.meaning.digest);
      expect(result.queried.consumer.readDefinition).toBeString();
      expect(result.queried.consumer.readDefinition!.length).toBeGreaterThan(0);
      expect(result.queried.snapshot.kind).toBe(snapshot);
      return result;
    }
    if (result.status === 'preparing') await settle(n, result.repair);
  }
  throw new Error('Finite native consumer capture did not finish');
}
async function status(
  operations: PublicFilterConsumerOperations,
  queried: PublicFilterQueriedObservation,
  execution?: string,
) {
  const result = await operations.readStatus({ queried, ...(execution ? { execution } : {}) }, context());
  expect(result.status).toBe('observed');
  if (result.status !== 'observed') throw new Error(`Native persisted status ${result.status}`);
  return result;
}
async function execute(n: Native, queried: PublicFilterQueriedObservation) {
  const result = await n.operations.query(queried, context());
  expect(result.status).toBe('queried');
  if (result.status !== 'queried') throw new Error(`Native immutable query ${result.status}`);
  expect(result.queried.consumer).toEqual(queried.consumer);
  expect(result.queried.snapshot.observation).toBe(queried.snapshot.observation);
  return result;
}
async function liveDocument(n: Native, subject: string) {
  return (
    await n.search.request<{ _version: number; _source: { statements: string[] } }>(
      'GET',
      `/${n.consumer.physicalTarget}/_doc/${subject}`,
    )
  ).body;
}

test('native queried observation retains the physical incarnation and immutable query across refresh-visible local and foreign repair', async () => {
  const n = await setup();
  try {
    const author = await n.f.create();
    const book = await n.f.create('schema:Book', { 'schema:author': [statement('schema:author', author)] });
    const local = await complete(n.f, n.source, book);
    const candidate = local.records.find((row) => row.statement.property.id === 'schema:author')!.candidate;
    const plan = positive(author);
    const initial = await captured(n, plan);
    const old = structuredClone(initial.queried);
    const first = await execute(n, old);
    expect(first.result.hits.map((hit) => hit.id)).toEqual([book]);
    const covered = (await status(n.operations, old)).covered;
    // Mutating a caller object cannot change the retained plan, meaning or snapshot.
    plan.filter = { match_none: {} };
    const repeated = await execute(n, first.queried);
    expect(repeated.result.hits.map((hit) => hit.id)).toEqual([book]);
    await n.f.post(`/v1/subjects/${book}/candidates/${candidate}:hide`, { reason: 'Local selected fact reduction' });
    await settle(n, initial.repair);
    const fresh = await captured(n, positive(author));
    expect((await execute(n, fresh.queried)).result.hits).toEqual([]);
    expect((await status(n.operations, old)).covered).toEqual(covered);
    expect((await status(n.operations, old, first.execution)).blocking.length).toBeGreaterThan(0);
    // A native PIT still contains its original result, even though public disclosure now blocks.
    expect(old.snapshot.kind).toBe('pit');
    if (old.snapshot.kind !== 'pit') throw new Error('Expected native PIT');
    const raw = await n.search.request<{
      timed_out: boolean;
      _shards: { failed: number };
      hits: { hits: { _id: string }[] };
    }>('POST', '/_search', {
      size: 20,
      pit: {
        id: repeated.queried.snapshot.kind === 'pit' ? repeated.queried.snapshot.pit : old.snapshot.pit,
        keep_alive: '1m',
      },
      query: positive(author).filter,
    });
    expect(raw.body.timed_out).toBe(false);
    expect(raw.body._shards.failed).toBe(0);
    expect(raw.body.hits.hits.map((hit) => hit._id)).toEqual([book]);

    const foreign = await n.f.create();
    const dependent = await n.f.create('schema:Book', { 'schema:author': [statement('schema:author', foreign)] });
    const prepared = await captured(n, positive(foreign), 'prepared');
    const preparedResult = await execute(n, prepared.queried);
    expect(preparedResult.result.hits.map((hit) => hit.id)).toEqual([dependent]);
    const preparedCut = (await status(n.operations, prepared.queried)).covered;
    const before = await liveDocument(n, dependent);
    await n.f.post(`/v1/subjects/${foreign}:hide`, { reason: 'Foreign target reduction' });
    await settle(n, prepared.repair);
    const after = await liveDocument(n, dependent);
    expect(after._version).toBeGreaterThan(before._version);
    expect(after._source.statements).not.toContain(`schema:author=${foreign}`);
    expect((await status(n.operations, prepared.queried)).covered).toEqual(preparedCut);
    expect((await status(n.operations, prepared.queried, preparedResult.execution)).blocking.length).toBeGreaterThan(0);
    expect((await execute(n, (await captured(n, positive(foreign), 'prepared')).queried)).result.hits).toEqual([]);

    await n.consumer.recreate();
    for (const queried of [old, prepared.queried]) {
      const stale = await n.operations.readStatus({ queried }, context());
      expect(stale.status).toBe('unready');
      if (stale.status === 'unready') expect(stale.reason).toBe('incarnation_changed');
      expect((await n.operations.query(queried, context())).status).not.toBe('queried');
    }
    const replacement = await captured(n, positive(author));
    expect(replacement.queried.consumer.incarnation).not.toBe(old.consumer.incarnation);
    expect(replacement.queried.consumer.consumerGeneration).not.toBe(old.consumer.consumerGeneration);
    expect(n.consumer.engineResponses()).toBeGreaterThan(0);
  } finally {
    await n.close();
  }
}, 600_000);

test('native tuple and consent reductions repair their dependent source keys before acknowledgement', async () => {
  const n = await setup();
  try {
    const author = await n.f.create();
    const book = await n.f.create('schema:Book');
    const origin = {
      source: 'openlibrary',
      external_id: randomUUID(),
      field_group: 'facts' as const,
      record_revision: 'unversioned',
      digest: 'e'.repeat(64),
      converter_revision: 'openlibrary@1',
    };
    const read = { pool: n.f.db.pool, ...context() };
    const actor = await n.f.config.access.authenticate(n.f.real.bearer('editor'), read);
    if (actor.kind !== 'account') throw new Error('Expected actual authenticated native editor');
    const authorization = await accessCommandAuthorization(
      n.f.config.access,
      actor,
      'statement:propose',
      { route: 0, id: GLOBAL_CONTEXT },
      read,
      () => new Error('Native imported proposal denied'),
    );
    const proposed = await batchCommand(n.f.db.pool, {
      actor,
      authorization,
      route: routeOf(book)!,
      release: { digest: n.f.meaning.digest, release: n.f.meaning.release },
      deadline: read.deadline,
      clock: systemClock,
      command: {
        op: 'propose',
        key: randomUUID(),
        source: origin,
        subject: book,
        statement: {
          property: { id: 'schema:author' },
          value: { type: 'value', content: author },
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/import' } },
              ],
            },
          ],
        },
      },
    });
    expect(proposed.status).toBe(201);
    if (!('candidate' in proposed.value)) throw new Error('Expected native imported candidate');
    const candidate = proposed.value.candidate;
    await n.f.post(`/v1/subjects/${book}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    await n.f.post(`/v1/subjects/${book}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:author',
      target: author,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    });
    const initial = await captured(n, positive(author));
    const started = await execute(n, initial.queried);
    expect(started.result.hits.map((hit) => hit.id)).toEqual([book]);
    const before = await liveDocument(n, book);
    await n.f.post('/v1/sourceFences:takedown', {
      source: origin.source,
      externalId: origin.external_id,
      fieldGroup: 'facts',
      reason: 'Foreign tuple reduction before ordinary relays',
    });
    const reduced = await head(
      n.source,
      partitionOf(tupleRoute(n.f.config.routeKey, origin.source, origin.external_id)),
    );
    expect((await status(n.operations, initial.queried, started.execution)).pending).toContainEqual(reduced);
    await settle(n, initial.repair);
    const after = await liveDocument(n, book);
    expect(after._version).toBeGreaterThan(before._version);
    expect(after._source.statements).not.toContain(`schema:author=${author}`);
    const fresh = await captured(n, positive(author));
    expect((await status(n.operations, fresh.queried)).pending).toEqual([]);
    expect((await execute(n, fresh.queried)).result.hits).toEqual([]);
    expect((await status(n.operations, started.queried, started.execution)).changed).toContainEqual(reduced);
  } finally {
    await n.close();
  }

  const consent = await setup('schema:Organization');
  try {
    const agent = await ensureAccountAgent(consent.f.db.pool, {
      account: consent.f.accounts.editor,
      kind: 'person',
      name: 'Native consent owner',
    });
    const pen = await consent.f.create('schema:Organization');
    const candidate = (
      await consent.f.post(`/v1/subjects/${pen}/candidates`, {
        statement: { ...statement('rezics:penNameOf', agent.subject.id), references: [] },
      })
    ).candidate as string;
    await consent.f.post(`/v1/statements/${candidate}/disclose`, {});
    const plan: SearchPlan = {
      sort: 'id',
      size: 20,
      filter: compileFilter(
        {
          statement: {
            property: 'rezics:penNameOf',
            in: [agent.subject.id],
          },
        },
        { prefix: 'consent-' },
      ).query,
    };
    const initial = await captured(consent, plan);
    const started = await execute(consent, initial.queried);
    expect(started.result.hits.map((hit) => hit.id)).toEqual([pen]);
    await consent.f.post(`/v1/statements/${candidate}/retract`, {});
    const reduced = await head(consent.source, home(pen));
    expect((await status(consent.operations, initial.queried, started.execution)).pending).toContainEqual(reduced);
    await settle(consent, initial.repair);
    const fresh = await captured(consent, plan);
    expect((await status(consent.operations, fresh.queried)).pending).toEqual([]);
    expect((await execute(consent, fresh.queried)).result.hits).toEqual([]);
    expect((await status(consent.operations, started.queried, started.execution)).changed).toContainEqual(reduced);
  } finally {
    await consent.close();
  }
}, 600_000);

test('native query revalidation detects a reduction even when repair is acknowledged before final disclosure', async () => {
  const n = await setup();
  try {
    const author = await n.f.create();
    const book = await n.f.create('schema:Book', { 'schema:author': [statement('schema:author', author)] });
    const projected = await complete(n.f, n.source, book);
    const candidate = projected.records.find((row) => row.statement.property.id === 'schema:author')!.candidate;
    const observation = await captured(n, negative(author));
    const start = await capture(n.f.db, () => execute(n, observation.queried), { includeBackends: true });
    // No candidates to recheck: a stale negative exclusion still discloses the removed fact.
    expect(start.value.result.hits).toEqual([]);
    const before = await head(n.source, home(book));
    await n.f.post(`/v1/subjects/${book}/candidates/${candidate}:hide`, { reason: 'Reduction AFTER query start' });
    const reduction = await head(n.source, home(book));
    expect(reduction.position > before.position).toBe(true);
    await settle(n, observation.repair);
    const fresh = await captured(n, negative(author));
    expect((await execute(n, fresh.queried)).result.hits.map((hit) => hit.id)).toEqual([book]);
    expect((await status(n.operations, fresh.queried)).pending).toEqual([]);
    // Final runs AFTER native repair, refresh and persisted ACK, against the ORIGINAL execution.
    const final = await capture(n.f.db, () => status(n.operations, start.value.queried, start.value.execution), {
      includeBackends: true,
    });
    expect(final.value.pending).toEqual([]);
    expect(final.value.changed).toContainEqual(reduction);
    expect(final.value.blocking).toContainEqual({ head: reduction, phase: 'changed', scope: 'filter_or_order' });
    expect(final.value.queried.snapshot.observation).toBe(observation.queried.snapshot.observation);
    const work = [costOf(start.capture), costOf(final.capture)];
    expect(work.reduce((sum, cost) => sum + cost.statements, 0)).toBeLessThanOrEqual(2);
    const behindHomes = new Set(final.value.pending.map((head) => head.partition));
    const changedHomes = new Set(final.value.changed.map((head) => head.partition));
    expect(work.reduce((sum, cost) => sum + cost.rows, 0)).toBeLessThanOrEqual(
      64 + 2 * (behindHomes.size + changedHomes.size),
    );
    expect(work.every((cost) => cost.responseBytes !== undefined)).toBe(true);
  } finally {
    await n.close();
  }
}, 600_000);

test('native foreign repair visibility failure version race late registration and competing repair cannot publish an acknowledgement', async () => {
  const n = await setup();
  try {
    for (const fault of ['hold', 'disconnect_before', 'disconnect_after'] as const) {
      const target = await n.f.create();
      const book = await n.f.create('schema:Book', { 'schema:author': [statement('schema:author', target)] });
      const initial = await captured(n, positive(target));
      const started = await execute(n, initial.queried);
      const before = await liveDocument(n, book);
      await n.f.post(`/v1/subjects/${target}:hide`, { reason: `Foreign native transport ${fault}` });
      const foreignHead = await head(n.source, home(target));
      const gate = n.consumer.arm('write', fault);
      // Attach rejection immediately; a deliberately lost response is expected to reject or report unavailable.
      const repairing = n.operations.repairStep(initial.repair, context()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await gate.reached;
      try {
        const blocked = await status(n.operations, initial.queried, started.execution);
        expect(blocked.pending).toContainEqual(foreignHead);
        expect(blocked.blocking.some((entry) => entry.head.partition === foreignHead.partition)).toBe(true);
        // Change the dependent OWN home while the foreign writer is paused: its stale version must lose.
        await n.f.post(`/v1/subjects/${book}:hide`, { reason: 'Newer anchored source version wins' });
        // A late capture may prepare, but cannot publish a clean observation on an incomplete registration.
        const late = await n.operations.capture({ plan: positive(target), snapshot: 'prepared' }, context());
        if (late.status === 'captured')
          expect((await status(n.operations, late.queried)).blocking.length).toBeGreaterThan(0);
        else expect(['preparing', 'unready']).toContain(late.status);
        // Competing retained job attempt exercises the actual native frontier CAS, never a CAS-success flag.
        const competing = n.operations.repairStep(initial.repair, context());
        gate.release();
        const winner = await competing;
        expect(['progress', 'settled', 'unready', 'unavailable']).toContain(winner.status);
      } finally {
        gate.release();
      }
      await repairing;
      await settle(n, initial.repair);
      const fresh = await captured(n, positive(target));
      expect((await status(n.operations, fresh.queried)).pending).toEqual([]);
      expect((await execute(n, fresh.queried)).result.hits).toEqual([]);
      // No stale writer resurrected the value; native source versions really advanced.
      const after = await n.search.request<{ hits: { hits: { _version: number }[] } }>(
        'POST',
        `/${n.consumer.physicalTarget}/_search`,
        { version: true, query: { term: { id: book } } },
      );
      expect(after.body.hits.hits).toEqual([]);
      expect(before._version).toBeGreaterThan(0);
    }
    // Hold actual refresh AFTER sink writes. Local success alone cannot publish the foreign prefix.
    const target = await n.f.create();
    await n.f.create('schema:Book', { 'schema:author': [statement('schema:author', target)] });
    const initial = await captured(n, positive(target));
    await n.f.post(`/v1/subjects/${target}:hide`, { reason: 'Dependent refresh delayed' });
    const foreignHead = await head(n.source, home(target));
    const refresh = n.consumer.arm('refresh');
    const repairing = n.operations.repairStep(initial.repair, context());
    await refresh.reached;
    try {
      expect((await status(n.operations, initial.queried)).pending).toContainEqual(foreignHead);
    } finally {
      refresh.release();
    }
    await repairing;
    await settle(n, initial.repair);
    expect((await status(n.operations, (await captured(n, positive(target))).queried)).pending).toEqual([]);
  } finally {
    await n.close();
  }
}, 600_000);

test('native irrelevant key narrowing never suppresses own-row or excluded negative and order protection', async () => {
  const n = await setup();
  try {
    const author = await n.f.create();
    const book = await n.f.create('schema:Book', {
      'schema:author': [statement('schema:author', author)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    });
    const projected = await complete(n.f, n.source, book);
    const language = projected.records.find((row) => row.statement.property.id === 'schema:inLanguage')!.candidate;
    const own = await captured(n, positive(author));
    const excluded = await captured(n, negative(author));
    const ownStart = await execute(n, own.queried);
    const excludedStart = await execute(n, excluded.queried);
    expect(ownStart.result.hits.map((hit) => hit.id)).toEqual([book]);
    expect(excludedStart.result.hits).toEqual([]);
    await n.f.post(`/v1/subjects/${book}/candidates/${language}:hide`, { reason: 'Unrelated filter property' });
    expect((await status(n.operations, excludedStart.queried, excludedStart.execution)).blocking).toEqual([]);
    expect(
      (await status(n.operations, ownStart.queried, ownStart.execution)).blocking.some(
        (entry) => entry.scope === 'returned_subject',
      ),
    ).toBe(true);
    await n.f.post(`/v1/subjects/${book}:hide`, { reason: 'Subject-wide reduction affects every query key' });
    expect(
      (await status(n.operations, excludedStart.queried, excludedStart.execution)).blocking.some(
        (entry) => entry.scope === 'filter_or_order',
      ),
    ).toBe(true);
    expect((await status(n.operations, ownStart.queried, ownStart.execution)).blocking.length).toBeGreaterThan(0);
  } finally {
    await n.close();
  }
}, 600_000);
