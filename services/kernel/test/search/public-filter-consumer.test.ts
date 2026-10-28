import { expect, test } from 'bun:test';
import { systemClock } from '../../src/clock.ts';
import { releaseDigest } from '@rezics/definitions';
import { randomUUID } from 'node:crypto';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { admitFilter, type FilterDocument } from '@rezics/filter';
import { parseText } from '../../src/search/text.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import { capture, costOf, isControlStatement, withoutCatalogStatements, type Capture } from '../support/growth.ts';
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
const positive = (author: string): PublicFilterConsumerCaptureInput => ({
  sort: 'id',
  size: 20,
  text: undefined,
  filterDocument: { statement: { property: 'schema:author', in: [author] } },
});
const negative = (author: string): PublicFilterConsumerCaptureInput => ({
  sort: 'name',
  size: 20,
  text: undefined,
  filterDocument: {
    and: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:author', in: [author] } } }],
  },
});

async function setup(type = 'schema:Book', configure?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    await configure?.(f);
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
async function captured(n: Native, plan: PublicFilterConsumerCaptureInput, snapshot: 'pit' | 'prepared' = 'pit') {
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
    Object.assign(plan, { filter: { match_none: {} }, filterDocument: { type: { in: ['schema:Person'] } } });
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
      query: compileFilter(positive(author).filterDocument!, { prefix: 'f', relationOverflow: true }).query,
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
    const plan: PublicFilterConsumerCaptureInput = {
      text: undefined,
      filterDocument: { statement: { property: 'rezics:penNameOf', in: [agent.subject.id] } },
      sort: 'id',
      size: 20,
      filter: compileFilter(
        {
          statement: {
            property: 'rezics:penNameOf',
            in: [agent.subject.id],
          },
        },
        { prefix: 'f', relationOverflow: true },
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
    const started = Promise.withResolvers<Awaited<ReturnType<typeof execute>>>();
    const repaired = Promise.withResolvers<void>();
    // Bound fixture coordination; context() keeps every native deadline unchanged, including after this wait.
    const timer = setTimeout(() => {
      const error = new Error('Native ACK-before-final fixture barrier timed out');
      started.reject(error);
      repaired.reject(error);
    }, 60_000);
    // Observe early failures even while the outside controller is doing native fixture work.
    void started.promise.catch(() => {});
    void repaired.promise.catch(() => {});
    const measured = capture(
      n.f.db,
      async () => {
        try {
          const start = await execute(n, observation.queried);
          started.resolve(start);
          await repaired.promise;
          return { start, final: await status(n.operations, start.queried, start.execution) };
        } catch (error) {
          started.reject(error);
          throw error;
        }
      },
      { includeBackends: true },
    );
    // Capture can fail before invoking its callback (for example, on native instrumentation setup).
    // Release the controller with that original failure instead of waiting for the barrier timeout.
    void measured.catch((error: unknown) => started.reject(error));
    try {
      const start = await started.promise;
      // No candidates to recheck: a stale negative exclusion still discloses the removed fact.
      expect(start.result.hits).toEqual([]);
      const before = await head(n.source, home(book));
      await n.f.post(`/v1/subjects/${book}/candidates/${candidate}:hide`, { reason: 'Reduction AFTER query start' });
      const reduction = await head(n.source, home(book));
      expect(reduction.position > before.position).toBe(true);
      // The controller stays outside the measured async scope. Its native SQL is background, not page work.
      // A nested capturedStep on this same database would replace/fail the inclusive page capture.
      const preparationCosts: Awaited<ReturnType<PublicFilterConsumerOperations['repairStep']>>['cost'][] = [];
      async function repair(job: PublicFilterConsumerJob) {
        for (let step = 0; step < 256; step++) {
          const result = await n.operations.repairStep(job, context());
          preparationCosts.push(result.cost);
          expect(['progress', 'settled']).toContain(result.status);
          for (const value of Object.values(result.cost)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
          expect(result.cost.inputKeys).toBeLessThanOrEqual(1000);
          expect(result.cost.candidates).toBeLessThanOrEqual(result.cost.inputKeys);
          expect(result.cost.accessPoints + result.cost.dependencyPoints).toBeLessThanOrEqual(
            8 * result.cost.inputKeys,
          );
          expect(result.cost.resultWrites).toBeLessThanOrEqual(1000);
          expect(result.cost.frontierWrites).toBeLessThanOrEqual(1);
          expect(result.cost.engineSearches).toBeLessThanOrEqual(4);
          if (result.status === 'settled') return;
        }
        throw new Error('Finite native consumer repair did not finish');
      }
      await repair(observation.repair);
      // Preserve fresh capture/preparation and native identity checks in the controller's background scope.
      let fresh: Awaited<ReturnType<typeof captured>> | undefined;
      for (let step = 0; step < 256; step++) {
        const result = await n.operations.capture({ plan: negative(author), snapshot: 'pit' }, context());
        expect(['captured', 'preparing']).toContain(result.status);
        if (result.status === 'captured') {
          expect(result.queried.consumer.physicalTarget).toBe(n.consumer.physicalTarget);
          expect(result.queried.consumer.incarnation).toBe(await n.consumer.incarnation());
          expect(result.queried.consumer.meaningDigest).toBe(n.f.meaning.digest);
          expect(result.queried.consumer.readDefinition).toBeString();
          expect(result.queried.consumer.readDefinition!.length).toBeGreaterThan(0);
          expect(result.queried.snapshot.kind).toBe('pit');
          fresh = result;
          break;
        }
        if (result.status === 'preparing') await repair(result.repair);
      }
      if (!fresh) throw new Error('Finite native consumer capture did not finish');
      expect((await execute(n, fresh.queried)).result.hits.map((hit) => hit.id)).toEqual([book]);
      expect((await status(n.operations, fresh.queried)).pending).toEqual([]);
      // Final runs AFTER native repair, refresh and persisted ACK, against the ORIGINAL execution.
      repaired.resolve();
      const { value, capture: whole } = await measured;
      const final = value.final;
      expect(final.pending).toEqual([]);
      expect(final.changed).toContainEqual(reduction);
      expect(final.blocking).toContainEqual({ head: reduction, phase: 'changed', scope: 'filter_or_order' });
      expect(final.queried.snapshot.observation).toBe(observation.queried.snapshot.observation);

      const operation = (text: string) =>
        /^\s*\/\* semantic\.(privacy-start|privacy-final|own-rows) \*\//.exec(text)?.[1];
      const coverageStatement = (text: string) => ['privacy-start', 'privacy-final'].includes(operation(text) ?? '');
      const evidence = new URL('../../../../.temp/goal/public-filter-consumer-ack-before-final.json', import.meta.url);
      // Retain the inclusive native evidence even when attribution itself fails.
      await Bun.write(evidence, JSON.stringify({ whole, preparationCosts }));
      expect(whole.statementBackends).toHaveLength(whole.statements.length);
      expect(whole.planBackends).toHaveLength(whole.plans.length);
      expect(whole.requestBytes).toHaveLength(whole.statements.length);
      expect(whole.responseBytes).toHaveLength(whole.statements.length);
      expect(whole.statementErrors).toEqual(whole.statements.map(() => null));
      const statements = whole.statements.flatMap((text, i) => (coverageStatement(text) ? [i] : []));
      const plans = whole.plans.flatMap((document, i) => {
        const entries: unknown[] = Array.isArray(document) ? document : [document];
        return entries.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null || !('Query Text' in entry))
            throw new Error('Native plan is missing Query Text for operation attribution');
          const text = entry['Query Text'];
          if (typeof text !== 'string') throw new Error('Native plan Query Text must be SQL');
          return [{ document: entry, text, backend: whole.planBackends?.[i] }];
        });
      });
      const coveragePlans = plans.filter(({ text }) => coverageStatement(text));
      const coverage: Capture = {
        statements: statements.map((i) => whole.statements[i]!),
        plans: coveragePlans.map(({ document }) => document),
        requestBytes: statements.map((i) => whole.requestBytes![i]!),
        responseBytes: statements.map((i) => whole.responseBytes![i]!),
        statementErrors: statements.map((i) => whole.statementErrors![i]!),
        statementBackends: statements.map((i) => whole.statementBackends![i]),
        planBackends: coveragePlans.map(({ backend }) => backend),
      };
      await Bun.write(evidence, JSON.stringify({ whole, coverage, preparationCosts }));
      // Match occurrences, not distinct SQL. This also checks own-row and unclassified bookkeeping plans.
      const key = (text: string, backend: number | undefined) => JSON.stringify([backend, text]);
      expect(plans.map(({ text, backend }) => key(text, backend)).sort()).toEqual(
        whole.statements
          .flatMap((text, i) => (isControlStatement(text) ? [] : [key(text, whole.statementBackends![i])]))
          .sort(),
      );
      expect(coverage.statements.map(operation).sort()).toEqual(['privacy-final', 'privacy-start']);
      for (const text of whole.statements.filter((text) => operation(text) !== undefined)) {
        const rest = text.replace(/^\s*\/\* semantic\.(privacy-start|privacy-final|own-rows) \*\//, '');
        expect(operation(rest), 'Exactly one leading semantic operation annotation is required').toBeUndefined();
      }
      const privacy = costOf(coverage);
      expect(privacy.plans).toBe(coverage.statements.length);
      expect(privacy.statements).toBe(coverage.statements.length);
      expect(privacy.statements).toBeLessThanOrEqual(2);
      const behindHomes = new Set(final.pending.map((head) => head.partition));
      const changedHomes = new Set(final.changed.map((head) => head.partition));
      expect(privacy.rows).toBeLessThanOrEqual(64 + 2 * (behindHomes.size + changedHomes.size));

      const work = costOf(whole);
      const candidates = value.start.cost.candidates + final.cost.candidates;
      for (const cost of [value.start.cost, final.cost])
        for (const count of Object.values(cost)) expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
      expect(candidates).toBeLessThanOrEqual(Math.min(600, 6 * 20 + 3));
      expect(
        value.start.cost.accessPoints +
          value.start.cost.dependencyPoints +
          final.cost.accessPoints +
          final.cost.dependencyPoints,
      ).toBeLessThanOrEqual(16 + 8 * candidates);
      expect(value.start.cost.engineSearches + final.cost.engineSearches).toBeLessThanOrEqual(6);
      expect(value.start.cost.outputSlots + final.cost.outputSlots).toBeLessThanOrEqual(20);
      expect(work.rows).toBeLessThanOrEqual(64 + 16 * candidates);
      expect(work.blocks).toBeLessThanOrEqual(6 * (64 + 16 * candidates));
      expect(work.requestBytes).toBeDefined();
      expect(work.responseBytes).toBeDefined();
      expect(work.requestBytes!).toBeLessThanOrEqual(64 * 1024 + 1024 * candidates);
      expect(work.responseBytes!).toBeLessThanOrEqual(16 * 1024 + 4 * 1024 * candidates);
      const charged = withoutCatalogStatements('native ACK-before-final whole read', whole);
      const backends = new Set(whole.statementBackends);
      expect(backends.has(undefined)).toBe(false);
      expect(backends.size).toBeLessThanOrEqual(1);
      for (const backend of backends)
        expect(
          charged.statements.filter((text, i) => charged.statementBackends![i] === backend && !isControlStatement(text))
            .length,
        ).toBeLessThanOrEqual(12);
    } finally {
      repaired.resolve();
      clearTimeout(timer);
      await Promise.allSettled([measured, started.promise, repaired.promise]);
    }
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

test('native capture retains the expanded shared query meaning before deriving its physical plan and complete dependency keys', async () => {
  let author!: string;
  let book!: string;
  const n = await setup('schema:Book', async (f) => {
    author = await f.create();
    book = await f.create('schema:Book', { 'schema:author': [statement('schema:author', author)] });
    const release = structuredClone(f.meaning.release);
    release.filters = {
      'native/public': { labels: { en: 'Public books' }, filter: { type: { in: ['schema:Book'] } } },
    };
    // Install the real accepted release before constructing Source and the native consumer.
    const active = await activeRelease(f.db.pool);
    const digest = releaseDigest(release);
    await f.post('/v1/definitions/releases', { release });
    await f.post(`/v1/definitions/releases/${digest}:activate`, { expected_head: active?.head ?? null });
    Object.assign(f.meaning, { release, digest });
  });
  try {
    const release = n.f.meaning.release;
    const expand = (): FilterDocument =>
      admitFilter(
        {
          and: [
            { saved: 'native/public' },
            {
              or: [
                { statement: { property: 'schema:author', in: [author] } },
                { not: { statement: { property: 'schema:inLanguage', in: ['ja'] } } },
              ],
            },
          ],
        },
        release,
      );
    const expanded = expand();
    const text = parseText('Native -"unpublished phrase"');
    const input: PublicFilterConsumerCaptureInput = {
      filterDocument: expanded,
      text,
      sort: 'name',
      size: 20,
    };
    const observation = await captured(n, input);
    const first = await execute(n, observation.queried);
    expect(first.result.hits.map((hit) => hit.id)).toEqual([book]);
    const definition = observation.queried.consumer.readDefinition;
    // The native retained definition owns both trees and keyset/order, not this mutable caller graph.
    Object.assign(text, { kind: 'term', value: 'absent' });
    Object.assign(input, { text: parseText('absent'), sort: 'id', size: 1, after: ['zzzz'] });
    Object.assign(expanded, { and: [{ type: { in: ['schema:Person'] } }] });
    expect((await execute(n, observation.queried)).result.hits.map((hit) => hit.id)).toEqual([book]);
    expect(observation.queried.consumer.readDefinition).toBe(definition);
    const semantic = {
      ...positive(author),
      filterDocument: expand(),
      text: parseText('Native -"unpublished phrase"'),
      sort: 'name' as const,
    };
    const compatible = await captured(n, {
      ...semantic,
      filter: compileFilter(semantic.filterDocument, { prefix: 'f', relationOverflow: true }).query,
    });
    expect(compatible.queried.consumer.readDefinition).toBe(definition);
    for (const change of [
      { text: parseText('absent') },
      { sort: 'id' as const },
      { size: 1 },
      { after: ['zzzz', book] },
    ]) {
      const other = await captured(n, { ...semantic, ...change });
      expect(other.queried.consumer.readDefinition).not.toBe(definition);
    }
    const after = ['zzzz', book];
    const keyset = await captured(n, { ...semantic, after });
    expect((await execute(n, keyset.queried)).result.hits).toEqual([]);
    after[0] = '';
    expect((await execute(n, keyset.queried)).result.hits).toEqual([]);

    // An owner-context expansion is untrusted input, never a shipped public release definition.
    const privateRelease = {
      ...release,
      filters: { 'native/private': { filter: { owner: { presence: true as const } } } },
    };
    const owner = admitFilter({ saved: 'native/private' }, privateRelease, { owner: true });
    for (const filterDocument of [
      owner,
      { not: owner },
      { or: [{ type: { in: ['schema:Book'] } }, owner] },
      { saved: 'native/public' },
    ]) {
      const before = n.consumer.engineResponses();
      const rejected = await capture(
        n.f.db,
        async () => {
          await expect(
            n.operations.capture(
              { plan: { filterDocument, text: undefined, sort: 'id', size: 20 }, snapshot: 'pit' },
              context(),
            ),
          ).rejects.toThrow();
        },
        { includeBackends: true },
      );
      expect(costOf(rejected.capture).statements).toBe(0);
      expect(n.consumer.engineResponses()).toBe(before);
    }
    const before = n.consumer.engineResponses();
    // Optional native DSL is comparison evidence only. It cannot override an admitted AST.
    await expect(
      n.operations.capture({ plan: { ...positive(author), filter: { match_none: {} } }, snapshot: 'pit' }, context()),
    ).rejects.toThrow();
    // Runtime validation rejects a compiled-only caller even if it bypasses TypeScript.
    await expect(
      n.operations.capture(
        {
          plan: { filter: { match_all: {} }, sort: 'id', size: 20 } as unknown as PublicFilterConsumerCaptureInput,
          snapshot: 'pit',
        },
        context(),
      ),
    ).rejects.toThrow();
    expect(n.consumer.engineResponses()).toBe(before);
    const projected = await complete(n.f, n.source, book);
    const candidate = projected.records.find((row) => row.statement.property.id === 'schema:author')!.candidate;
    // This OR branch is sufficient but is not the only matching alternative. It remains a dependency.
    await n.f.post(`/v1/subjects/${book}/candidates/${candidate}:hide`, { reason: 'Expanded shared OR dependency' });
    const reduced = await head(n.source, home(book));
    expect((await status(n.operations, observation.queried, first.execution)).changed).toContainEqual(reduced);
    expect(
      (await status(n.operations, observation.queried, first.execution)).blocking.some(
        (entry) => entry.scope === 'filter_or_order',
      ),
    ).toBe(true);
  } finally {
    await n.close();
  }
}, 600_000);

test('native refresh controls cover explicit refresh and genuine bulk wait_for completion without acknowledging bare writes', async () => {
  const n = await setup();
  try {
    const target = `/${n.consumer.physicalTarget}`;
    const bareId = randomUUID();
    const gate = n.consumer.arm('refresh');
    let refreshEntered = false;
    void gate.reached.then(() => {
      refreshEntered = true;
    });
    const bare = await n.consumer.transport.bulk<{ errors: boolean }>([
      { index: { _index: n.consumer.physicalTarget, _id: bareId } },
      { id: bareId },
    ]);
    expect(bare.errors).toBe(false);
    expect(refreshEntered).toBe(false);
    const explicit = n.consumer.transport.request<{ _shards: { failed: number } }>('POST', `${target}/_refresh`);
    try {
      expect(await gate.reached).toEqual({ kind: 'explicit_refresh', stage: 'before_send' });
      expect(n.consumer.nativeReceipts().at(-1)!.kind).toBe('write');
    } finally {
      gate.release();
    }
    expect((await explicit).body._shards.failed).toBe(0);
    const id = randomUUID();
    const completion = n.consumer.arm('refresh');
    let delivered = false;
    const waitFor = n.consumer.transport
      .bulk<{ errors: boolean; items: { index: { _shards: { failed: number } } }[] }>(
        [{ index: { _index: n.consumer.physicalTarget, _id: id } }, { id }],
        { query: { refresh: 'wait_for' } },
      )
      .then((response) => {
        delivered = true;
        return response;
      });
    try {
      expect(await completion.reached).toEqual({ kind: 'bulk_wait_for', stage: 'after_response' });
      expect(delivered).toBe(false);
      expect(n.consumer.nativeReceipts().at(-1)!.kind).toBe('bulk_wait_for');
      const visible = await n.search.request<{ hits: { hits: { _id: string }[] } }>('POST', `${target}/_search`, {
        query: { ids: { values: [id] } },
      });
      expect(visible.body.hits.hits.map((hit) => hit._id)).toEqual([id]);
    } finally {
      completion.release();
    }
    const response = await waitFor;
    expect(response.errors).toBe(false);
    expect(response.items[0]!.index._shards.failed).toBe(0);
    expect(delivered).toBe(true);
    // The same refresh fault names retain their before/after native-effect distinction for wait_for.
    for (const fault of ['disconnect_before', 'disconnect_after'] as const) {
      const failedId = randomUUID();
      const receipts = n.consumer.nativeReceipts().length;
      const disconnected = n.consumer.arm('refresh', fault);
      const attempt = n.consumer.transport
        .bulk([{ index: { _index: n.consumer.physicalTarget, _id: failedId } }, { id: failedId }], {
          query: { refresh: 'wait_for' },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        expect(await disconnected.reached).toEqual({
          kind: 'bulk_wait_for',
          stage: fault === 'disconnect_before' ? 'before_send' : 'after_response',
        });
        expect(n.consumer.nativeReceipts().length).toBe(receipts + (fault === 'disconnect_after' ? 1 : 0));
        const actual = await n.search.request<{ hits: { hits: { _id: string }[] } }>('POST', `${target}/_search`, {
          query: { ids: { values: [failedId] } },
        });
        expect(actual.body.hits.hits.map((hit) => hit._id)).toEqual(fault === 'disconnect_after' ? [failedId] : []);
      } finally {
        disconnected.release();
      }
      expect(await attempt).toBeInstanceOf(Error);
    }
  } finally {
    await n.close();
  }
}, 600_000);
