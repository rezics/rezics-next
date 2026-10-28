import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, costOf } from '../support/growth.ts';
import {
  complete,
  capturedStep,
  fixture,
  head,
  home,
  missingSearchDependency,
  nativeProducer,
  statement,
} from './support/public-filter-source.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import type { PrivacyLogEntry } from '../../src/semantic/public-filter-source-contract.ts';

const name =
  'perhome privacy reductions commit monotonic log positions atomically and public query acknowledgement waits actual local and dependent foreign refresh';
test(name, async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const subject = await f.create('schema:Book');
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
    const { tupleRoute } = await import('../../src/content/imported-contract.ts');
    const tupleHome = partitionOf(tupleRoute(f.config.routeKey, 'native', 'privacy'));
    const tupleHead = await head(source, tupleHome);
    expect(tupleHead.position > 0n).toBe(true);
    const last = await head(source, partition);
    expect(last.position > after.position).toBe(true);
    const entries: PrivacyLogEntry[] = [];
    let cursor = before.position;
    for (let step = 0; step < 100; step++) {
      const page = await capturedStep(f.db, () =>
        source.pagePrivacyLog({ partition, epoch: last.epoch, after: cursor, through: last.position, inputLimit: 1 }),
      );
      expect(['progress', 'complete']).toContain(page.status);
      if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native log ${page.status}`);
      expect(page.cost.inputKeys).toBeLessThanOrEqual(1);
      expect(page.entries.length).toBeLessThanOrEqual(1);
      entries.push(...page.entries);
      if (page.status === 'complete') break;
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
      entries.every((entry) => entry.affected.some((key) => key.kind === 'subject' && key.subject === subject)),
    ).toBe(true);
    const tupleLog = await source.pagePrivacyLog({
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
            entry.affected.some((key) => key.kind === 'sourceTuple' && key.tuple.external_id === 'privacy'),
        ),
      ).toBe(true);

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
    // No fake Search acknowledgement is invoked after these producer assertions.
    missingSearchDependency(
      'positive harem, NOT harem and order remain preparing until local AND dependent foreign refresh, including excluded subjects',
    );
  } finally {
    await f.close();
  }
});

for (const scenario of [
  'reduction between execution and disclosure: revalidated current head changes and prepares',
  'late old source snapshot cannot resurrect an indexed or prepared row after ACK',
  'late foreign dependency registration checks already-reduced owner and blocks ACK until repaired',
  'crash after sink effect with ambiguous response cannot ACK before actual winner refresh',
  'pending identity epoch prepares independently; published epoch alone does not acknowledge privacy',
  'missing moved or unavailable owner is not pristine; explicit initialized empty home has head zero',
  'privacy log rejected-key history resumes all keys under bounded pages and lossless positions beyond Number.MAX_SAFE_INTEGER',
])
  test(`native dependency: ${scenario}`, () => missingSearchDependency(scenario));

test('native coarse head capture includes all 4096 genuine homes and privacy history', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const keys = new Map<number, string>();
    while (keys.size < 4096) {
      const key = randomUUID();
      keys.set(partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, key).route), key);
    }
    for (const [partition, key] of keys) {
      const id = await f.create('schema:Book', {}, key);
      expect(home(id)).toBe(partition);
      await f.post(`/v1/subjects/${id}:hide`, { reason: 'Real home privacy history' });
    }
    const measured = await capture(f.db, () => source.readPrivacyHeads([...keys.keys()].sort((a, b) => a - b)), {
      includeBackends: true,
    });
    expect(measured.value.status).toBe('observed');
    if (measured.value.status !== 'observed') throw new Error('No growth evidence from unavailable coarse observation');
    expect(measured.value.heads).toHaveLength(4096);
    expect(measured.value.heads.every((entry) => entry.position > 0n)).toBe(true);
    const physical = costOf(measured.capture);
    // A zero-candidate read still pays for ALL control work. Native capture decides feasibility.
    expect(measured.value.cost.accessPoints + measured.value.cost.dependencyPoints).toBeLessThanOrEqual(16);
    expect(physical.rows).toBeLessThanOrEqual(64);
    expect(physical.blocks).toBeLessThanOrEqual(384);
    expect(physical.statements).toBeLessThanOrEqual(12);
    expect(physical.responseBytes!).toBeLessThanOrEqual(16 * 1024);
    expect(physical.requestBytes!).toBeLessThanOrEqual(64 * 1024);
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
