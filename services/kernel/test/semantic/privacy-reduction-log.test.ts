import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, costOf } from '../support/growth.ts';
import {
  complete,
  readContext,
  capturedStep,
  fixture,
  head,
  home,
  nativeProducer,
  statement,
  consumerFixture,
  capturedConsumer,
  settleConsumer,
  assertPageCapture,
  type Fixture,
} from './support/public-filter-source.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import type { PublicFilterSource, PrivacyReductionLogEntry } from '../../src/semantic/public-filter-source-contract.ts';

const name =
  'perhome privacy reductions commit monotonic log positions atomically and public query acknowledgement waits actual local and dependent foreign refresh';
test(name, async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    // Force the formerly random collision through the actual route function; retain all tuple entries.
    const { tupleRoute } = await import('../../src/content/imported-contract.ts');
    const collisionHome = partitionOf(tupleRoute(f.config.routeKey, 'native', 'privacy'));
    let subjectKey: string;
    for (let attempt = 0; ; attempt++) {
      subjectKey = `collision-${attempt}`;
      if (partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, subjectKey).route) === collisionHome) break;
    }
    const subject = await f.create('schema:Book', {}, subjectKey);
    const partition = home(subject);
    const before = await head(source, partition);
    const key = randomUUID();
    await f.post(`/v1/subjects/${subject}:hide`, { reason: 'Native reduction' }, key);
    const after = await head(source, partition);
    expect(after.position > before.position).toBe(true);
    await f.post(`/v1/subjects/${subject}:hide`, { reason: 'Native reduction' }, key);
    expect(await head(source, partition)).toEqual(after);
    // Current authorization must precede the receipt lookup even for a previously successful key.
    await f.real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'moderation:hide');
    expect((await f.call(`/v1/subjects/${subject}:hide`, { reason: 'Native reduction' }, key)).status).toBe(403);
    expect(await head(source, partition)).toEqual(after);
    await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'moderation:hide');
    await f.post(`/v1/subjects/${subject}:restore`, { reason: 'Restore is not a reduction' });
    expect(await head(source, partition)).toEqual(after);
    const concurrent = await Promise.all([
      f.post(`/v1/subjects/${subject}:hide`, { reason: 'Hide again' }),
      // Tuple-home reduction runs with all ordinary Semantic/Search relays absent.
      f.post('/v1/sourceFences:takedown', {
        source: 'native',
        externalId: 'privacy',
        fieldGroup: 'facts',
        reason: 'Tuple removed',
      }),
    ]);
    expect(concurrent).toHaveLength(2);
    const tupleHome = partitionOf(tupleRoute(f.config.routeKey, 'native', 'privacy'));
    const tupleHead = await head(source, tupleHome);
    expect(tupleHome).toBe(partition);
    expect(tupleHead.position > 0n).toBe(true);
    const last = await head(source, partition);
    expect(last.position > after.position).toBe(true);
    const entries: PrivacyReductionLogEntry[] = [];
    let cursor = before.position;
    for (let step = 0; step < 100; step++) {
      const page = await capturedStep(f.db, () =>
        source.readPrivacyReductionPage({
          context: readContext(),
          partition,
          epoch: last.epoch,
          after: cursor,
          through: last.position,
          inputLimit: 1,
        }),
      );
      expect(['progress', 'complete']).toContain(page.status);
      if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native log ${page.status}`);
      expect(page.cost.inputKeys).toBeLessThanOrEqual(1);
      expect(page.entries.length).toBeLessThanOrEqual(1);
      entries.push(...page.entries);
      expect(page.head.position).toBe(last.position);
      expect(page.head.epoch).toBe(last.epoch);
      if (page.status === 'complete') {
        expect(page.after).toBe(last.position);
        break;
      }
      expect(page.after > cursor).toBe(true);
      cursor = page.after;
      expect(step).toBeLessThan(99);
    }
    expect(entries.filter((entry) => entry.cause === 'subject')).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.head.position)).size).toBe(entries.length);
    expect(
      entries.every((entry, index) => index === 0 || entry.head.position > entries[index - 1]!.head.position),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.cause === 'subject')
        .every((entry) => entry.affected.some((key) => key.kind === 'subject' && key.subject === subject)),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.cause === 'subject')
        .every((entry) => entry.impacts.some((impact) => impact.kind === 'subject' && impact.subject === subject)),
    ).toBe(true);
    const tupleLog = await source.readPrivacyReductionPage({
      context: readContext(),
      partition: tupleHome,
      epoch: tupleHead.epoch,
      after: 0n,
      through: tupleHead.position,
      inputLimit: 16,
    });
    expect(tupleLog.status).toBe('complete');
    if (tupleLog.status === 'complete')
      expect(
        tupleLog.entries.some(
          (entry) =>
            entry.cause === 'sourceTuple' &&
            entry.affected.some((key) => key.kind === 'sourceTuple' && key.tuple.external_id === 'privacy') &&
            entry.impacts.some(
              (impact) =>
                impact.kind === 'dependency' &&
                impact.locator.kind === 'sourceTuple' &&
                impact.locator.tuple.external_id === 'privacy',
            ),
        ),
      ).toBe(true);

    expect(entries.some((entry) => entry.cause === 'sourceTuple')).toBe(true);
    expect(entries).toHaveLength(3);
    const stable = await head(source, partition);
    await runCommand(f.db.pool, { partition }, async () => noEffect({ unchanged: true }));
    expect(await head(source, partition)).toEqual(stable);
    const sameHome: string[] = [];
    while (sameHome.length < 2) {
      const candidateKey = randomUUID();
      if (partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, candidateKey).route) === partition)
        sameHome.push(await f.create('schema:Book', {}, candidateKey));
    }
    await Promise.all(
      sameHome.map((id) => f.post(`/v1/subjects/${id}:hide`, { reason: 'Concurrent same-home reduction' })),
    );
    expect((await head(source, partition)).position).toBe(stable.position + 2n);

    // A deferred native DB fault fires at COMMIT, after domain mutation and log append.
    await f.post(`/v1/subjects/${subject}:restore`, { reason: 'Prepare atomic rollback' });
    const rollbackHead = await head(source, partition);
    await f.db.admin.query(
      `CREATE FUNCTION semantic.public_filter_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native privacy commit fault'; END $$`,
    );
    await f.db.admin.query(
      `CREATE CONSTRAINT TRIGGER public_filter_test_fault AFTER UPDATE ON semantic.subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.subject_id = '${subject}'::uuid) EXECUTE FUNCTION semantic.public_filter_test_fault()`,
    );
    try {
      expect(
        (await f.call(`/v1/subjects/${subject}:hide`, { reason: 'Must roll back' })).status,
      ).toBeGreaterThanOrEqual(500);
      expect(await head(source, partition)).toEqual(rollbackHead);
      const row = await f.db.admin.query('SELECT visibility FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        routeOf(subject),
        subject,
      ]);
      expect(row.rows[0].visibility).toBe('visible');
    } finally {
      await f.db.admin.query('DROP TRIGGER public_filter_test_fault ON semantic.subject');
      await f.db.admin.query('DROP FUNCTION semantic.public_filter_test_fault()');
    }
  } finally {
    await f.close();
  }
});

async function genuineHomeHistory(f: Fixture, source: PublicFilterSource) {
  const keys = new Map<number, string>();
  while (keys.size < 4096) {
    const key = randomUUID();
    keys.set(partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, key).route), key);
  }
  const subjects = new Map<number, string>();
  for (const [partition, key] of keys) {
    const id = await f.create('schema:Book', {}, key);
    subjects.set(partition, id);
    expect(home(id)).toBe(partition);
    await f.post(`/v1/subjects/${id}:hide`, { reason: 'Real home privacy history' });
    expect((await head(source, partition)).position > 0n).toBe(true);
  }
  return subjects;
}

test('native home history covers all 4096 genuine homes independently of consumer execution', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const subjects = await genuineHomeHistory(f, source);
    expect(subjects.size).toBe(4096);
    const before = await head(source, 0);
    const subject = subjects.get(0)!;
    await f.post(`/v1/subjects/${subject}:restore`, { reason: 'Prepare changed-home schedule' });
    await f.post(`/v1/subjects/${subject}:hide`, { reason: 'Reduction after native head' });
    const after = await head(source, 0);
    expect(after.position > before.position).toBe(true);
    const page = await capturedStep(f.db, () =>
      source.readPrivacyReductionPage({
        partition: 0,
        epoch: after.epoch,
        after: before.position,
        through: after.position,
        inputLimit: 1,
        context: readContext(),
      }),
    );
    expect(page.status).toBe('complete');
    if (page.status !== 'complete') throw new Error('Missing native changed-home history');
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.head).toEqual(after);
  } finally {
    await f.close();
  }
});

// Real consent/Collection producers, with no ordinary projection or relay running.
test('native consent and Collection reductions invalidate their actual home immediately', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const agent = await ensureAccountAgent(f.db.pool, {
      account: f.accounts.editor,
      kind: 'person',
      name: 'Native consent owner',
    });
    const pen = await f.create('schema:Organization');
    const candidate = (
      await f.post(`/v1/subjects/${pen}/candidates`, {
        statement: { ...statement('rezics:penNameOf', agent.subject.id), references: [] },
      })
    ).candidate as string;
    const orgFixture = { ...f, meaning: { ...f.meaning, type: 'schema:Organization' } };
    expect((await complete(orgFixture, source, pen)).records).toEqual([]);
    const { readStatementAs } = await import('../../src/semantic/statement-disclosure.ts');
    const context = readContext();
    const actor = await f.config.access.authenticate(f.real.bearer('editor'), {
      pool: f.db.pool,
      deadline: context.deadline,
    });
    const publisher = await readStatementAs(f.db.pool, f.config.access, actor, context.deadline, () =>
      complete(orgFixture, source, pen),
    );
    expect(
      publisher.records,
      'Source stays public under the publisher private reader with the SAME bearer/Access',
    ).toEqual([]);
    await f.post(`/v1/statements/${candidate}/disclose`, {});
    const disclosed = await complete(orgFixture, source, pen);
    expect(
      disclosed.records.some(
        (record) =>
          record.candidate === candidate &&
          record.dependencies.some((key) => key.kind === 'consent' && key.account === f.accounts.editor),
      ),
    ).toBe(true);
    const before = await head(source, home(pen));
    await f.post(`/v1/statements/${candidate}/retract`, {});
    expect((await head(source, home(pen))).position > before.position).toBe(true);
    expect((await complete(orgFixture, source, pen)).records).toEqual([]);
    await f.real.grant({ route: routeOf(f.accounts.editor)!, id: f.accounts.editor }, 'editor', 'collection:create');
    const collection = (await f.post('/v1/collections', { title: 'Public population', visibility: 'public' }))
      .collection;
    const collectionHome = home(collection.id);
    const initial = await head(source, collectionHome);
    const changed = await f.call(
      `/v1/collections/${collection.id}`,
      { revision: collection.revision, visibility: 'private' },
      randomUUID(),
      'PATCH',
    );
    expect(changed.status).toBe(200);
    expect((await head(source, collectionHome)).position > initial.position).toBe(true);
  } finally {
    await f.close();
  }
});

const idPlan = {
  filterDocument: undefined,
  text: undefined,
  sort: 'id' as const,
  size: 20,
};

type Consumer = Awaited<ReturnType<typeof consumerFixture>>;

/** Controller work runs OUTSIDE the inclusive capture's async scope; it is genuine concurrent native work. */
async function observedPage(
  f: Fixture,
  consumer: Consumer,
  observation: Awaited<ReturnType<typeof capturedConsumer>>,
  during: (
    query: Extract<Awaited<ReturnType<Consumer['operations']['query']>>, { status: 'queried' }>,
    context: ReturnType<typeof readContext>,
  ) => Promise<void>,
) {
  type Query = Extract<Awaited<ReturnType<Consumer['operations']['query']>>, { status: 'queried' }>;
  const started = Promise.withResolvers<Query>();
  const finished = Promise.withResolvers<void>();
  const context = readContext();
  const timer = setTimeout(() => {
    const error = new Error('Native Source query/final fixture barrier timed out');
    started.reject(error);
    finished.reject(error);
  }, 60_000);
  void started.promise.catch(() => {});
  void finished.promise.catch(() => {});
  const measured = capture(
    f.db,
    async () => {
      const query = await consumer.operations.query(observation.queried, context);
      expect(query.status).toBe('queried');
      if (query.status !== 'queried') throw new Error(`Native query ${query.status}`);
      started.resolve(query);
      await finished.promise;
      const final = await consumer.operations.readStatus(
        { queried: query.queried, execution: query.execution },
        context,
      );
      expect(final.status).toBe('observed');
      if (final.status !== 'observed') throw new Error(`Native final ${final.status}`);
      return { query, final, context };
    },
    { includeBackends: true },
  );
  void measured.catch((error: unknown) => started.reject(error));
  try {
    await during(await started.promise, context);
    finished.resolve();
    return await measured;
  } finally {
    finished.resolve();
    clearTimeout(timer);
    await Promise.allSettled([measured, started.promise, finished.promise]);
  }
}

async function independentFinal(source: PublicFilterSource, page: Awaited<ReturnType<typeof observedPage>>) {
  const { query, final, context } = page.value;
  // Source independently resolves persisted identity/cut/definition/execution, never accepts diagnostic verdicts.
  const own = await source.readPrivacyReductionHeads({
    kind: 'population',
    queried: query.queried,
    start: query.start,
    execution: query.execution,
    context,
  });
  expect(own.status).toBe('observed');
  if (own.status !== 'observed') throw new Error(`Native Source final ${own.status}`);
  expect(own.coverage).toBe('all_native_homes');
  expect(own.routingComplete).toBe(true);
  expect(own.unacknowledged).toEqual(final.pending);
  expect(own.changed).toEqual(final.changed);
  expect(own.blocking).toEqual(final.blocking);
  return own;
}

test('native caught-up 4096-home observation shares two tagged statements and at most 64 coverage rows in the whole page', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Consumer | undefined;
  try {
    const source = publicFilterSource(f.config);
    consumer = await consumerFixture(f, source);
    const old = await capturedConsumer(f, consumer, idPlan);
    const subjects = await genuineHomeHistory(f, source);
    // The immutable registered observation predates every reduction: no null-consumer clean shortcut.
    const behind = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried: old.queried,
      start: null,
      context: readContext(),
    });
    expect(behind.status).toBe('observed');
    if (behind.status !== 'observed') throw new Error('Missing registered all-home behind observation');
    expect(behind.coverage).toBe('all_native_homes');
    expect(new Set(behind.unacknowledged.map((entry) => entry.partition)).size).toBe(4096);
    expect(behind.unacknowledged.every((entry) => entry.position > 0n)).toBe(true);
    expect(behind.changed).toEqual([]);
    await settleConsumer(consumer, old.repair);
    const current = await capturedConsumer(f, consumer, idPlan);
    const page = await observedPage(f, consumer, current, async (query) => {
      expect(query.result.hits).toEqual([]);
    });
    expect(page.value.final.pending).toEqual([]);
    expect(page.value.final.changed).toEqual([]);
    expect(page.value.final.blocking).toEqual([]);
    await assertPageCapture('caught-up-all-homes', page.capture, page.value.query, page.value.final, 20);
    await independentFinal(source, page);
    // Preserve the exact changed-home schedule after caught-up admission; excluded rows still matter.
    const changed = await observedPage(f, consumer, current, async () => {
      const subject = subjects.get(0)!;
      await f.post(`/v1/subjects/${subject}:restore`, { reason: 'Prepare changed-home schedule' });
      await f.post(`/v1/subjects/${subject}:hide`, { reason: 'Reduction after native start cut' });
    });
    expect(changed.value.final.changed.map((entry) => entry.partition)).toEqual([0]);
    expect(changed.value.final.pending.map((entry) => entry.partition)).toEqual([0]);
    expect(
      changed.value.final.changed[0]!.position > behind.unacknowledged.find((entry) => entry.partition === 0)!.position,
    ).toBe(true);
    await assertPageCapture('changed-excluded-home', changed.capture, changed.value.query, changed.value.final, 20);
    await independentFinal(source, changed);
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
}, 600_000);

test('narrowed privacy observations retain every changed reduction even when acknowledged during query', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Consumer | undefined;
  try {
    const source = publicFilterSource(f.config);
    const author = await f.create();
    const subject = await f.create('schema:Book', {
      'schema:author': [statement('schema:author', author)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    });
    const projected = await complete(f, source, subject);
    const authorRecord = projected.records.find((record) => record.statement.property.id === 'schema:author')!;
    const language = projected.records.find((record) => record.statement.property.id === 'schema:inLanguage')!;
    consumer = await consumerFixture(f, source);
    const plan = {
      ...idPlan,
      sort: 'name' as const,
      filterDocument: {
        and: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:author', in: [author] } } }],
      },
    };
    for (const snapshot of ['pit', 'prepared'] as const) {
      // Genuine source restoration and new capture, never editing registration/ACK/definition rows.
      if (snapshot === 'prepared') {
        await f.post(`/v1/subjects/${subject}/candidates/${authorRecord.candidate}:restore`, {
          reason: 'Native next observation',
        });
        await f.post(`/v1/subjects/${subject}/candidates/${language.candidate}:restore`, {
          reason: 'Native next observation',
        });
      }
      const initial = await capturedConsumer(f, consumer, plan, snapshot);
      const irrelevant = await observedPage(f, consumer, initial, async (query) => {
        expect(query.result.hits).toEqual([]);
        await f.post(`/v1/subjects/${subject}/candidates/${language.candidate}:hide`, {
          reason: 'Unrelated excluded key',
        });
      });
      expect(irrelevant.value.final.pending).toEqual([]);
      expect(irrelevant.value.final.changed).toEqual([]);
      expect(irrelevant.value.final.blocking).toEqual([]);
      await assertPageCapture(
        `irrelevant-${snapshot}`,
        irrelevant.capture,
        irrelevant.value.query,
        irrelevant.value.final,
        20,
      );
      await independentFinal(source, irrelevant);
      const relevant = await observedPage(f, consumer, initial, async (query) => {
        expect(query.result.hits).toEqual([]);
        const before = await head(source, home(subject));
        await f.post(`/v1/subjects/${subject}/candidates/${authorRecord.candidate}:hide`, {
          reason: 'Excluded NOT key removed during query',
        });
        expect((await head(source, home(subject))).position > before.position).toBe(true);
        await settleConsumer(consumer!, initial.repair);
        const fresh = await capturedConsumer(f, consumer!, plan, snapshot);
        const now = await consumer!.operations.query(fresh.queried, readContext());
        expect(now.status).toBe('queried');
        if (now.status !== 'queried') throw new Error('Missing repaired native execution');
        expect(now.result.hits.map((hit) => hit.id)).toEqual([subject]);
        const ready = await consumer!.operations.readStatus(
          { queried: now.queried, execution: now.execution },
          readContext(),
        );
        expect(ready.status).toBe('observed');
        if (ready.status === 'observed') expect(ready.pending).toEqual([]);
      });
      expect(relevant.value.final.pending).toEqual([]);
      expect(relevant.value.final.changed.map((entry) => entry.partition)).toEqual([home(subject)]);
      expect(relevant.value.final.blocking).toContainEqual({
        head: relevant.value.final.changed[0]!,
        scope: 'filter_or_order',
        phase: 'changed',
      });
      expect(relevant.value.final.queried.snapshot.observation).toBe(initial.queried.snapshot.observation);
      await assertPageCapture(
        `reduce-ack-${snapshot}`,
        relevant.capture,
        relevant.value.query,
        relevant.value.final,
        20,
      );
      await independentFinal(source, relevant);
      // Starting AGAIN on that old immutable observation cannot borrow the repaired live ACK.
      expect((await consumer.operations.query(initial.queried, readContext())).status).not.toBe('queried');
    }
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
}, 600_000);

test('native returned subject checks all own-row keys beyond the admitted filter and order even after ACK', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Consumer | undefined;
  try {
    const source = publicFilterSource(f.config);
    const author = await f.create();
    const subject = await f.create('schema:Book', {
      'schema:author': [statement('schema:author', author)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    });
    const language = (await complete(f, source, subject)).records.find(
      (record) => record.statement.property.id === 'schema:inLanguage',
    )!;
    consumer = await consumerFixture(f, source);
    const initial = await capturedConsumer(f, consumer, {
      ...idPlan,
      filterDocument: { statement: { property: 'schema:author', in: [author] } },
    });
    const page = await observedPage(f, consumer, initial, async (query, context) => {
      expect(query.result.hits.map((hit) => hit.id)).toEqual([subject]);
      await f.post(`/v1/subjects/${subject}/candidates/${language.candidate}:hide`, {
        reason: 'Own-row unrelated property removed',
      });
      const pending = await source.readPrivacyReductionHeads({
        kind: 'population',
        queried: query.queried,
        start: query.start,
        execution: query.execution,
        context,
      });
      expect(pending.status).toBe('observed');
      if (pending.status !== 'observed') throw new Error('Missing native pending own-row observation');
      expect(
        pending.blocking.some(
          (entry) =>
            entry.scope === 'returned_subject' && entry.phase === 'pending' && entry.head.partition === home(subject),
        ),
      ).toBe(true);
      await settleConsumer(consumer!, initial.repair);
    });
    expect(page.value.final.pending).toEqual([]);
    expect(
      page.value.final.blocking.some(
        (entry) =>
          entry.scope === 'returned_subject' && entry.phase === 'changed' && entry.head.partition === home(subject),
      ),
    ).toBe(true);
    expect(page.value.final.changed.some((entry) => entry.partition === home(subject))).toBe(true);
    await assertPageCapture('own-row-reduction', page.capture, page.value.query, page.value.final, 20);
    await independentFinal(source, page);
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
});

test('native Source rejects unknown observation and execution bindings independently of consumer diagnostic status', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Consumer | undefined;
  try {
    const source = publicFilterSource(f.config);
    await f.create('schema:Book');
    consumer = await consumerFixture(f, source);
    const initial = await capturedConsumer(f, consumer, idPlan);
    const query = await consumer.operations.query(initial.queried, readContext());
    expect(query.status).toBe('queried');
    if (query.status !== 'queried') throw new Error('Missing retained native query');
    const wrongExecution = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried: query.queried,
      start: query.start,
      execution: randomUUID(),
      context: readContext(),
    });
    expect(['unready', 'unavailable']).toContain(wrongExecution.status);
    const wrongDefinition = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried: {
        ...query.queried,
        consumer: { ...query.queried.consumer, readDefinition: randomUUID() },
      },
      start: query.start,
      execution: query.execution,
      context: readContext(),
    });
    expect(['unready', 'unavailable']).toContain(wrongDefinition.status);
    await consumer.operations.closeObservation(query.queried, readContext());
    const closed = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried: query.queried,
      start: query.start,
      execution: query.execution,
      context: readContext(),
    });
    expect(['unready', 'unavailable']).toContain(closed.status);
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
});
