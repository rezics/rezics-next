import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { CommandTransaction } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { semanticRetention } from '../../src/semantic/retention.ts';
import {
  lockRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
} from '../../src/semantic/record-purge-authority.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const f = await createDeletionFixture();
beforeAll(f.setup);
afterAll(f.close);
const day = 86_400_000;

test('structural or serialized objects cannot authorize native record purge', async () => {
  let queries = 0;
  const tx = {
    async query() {
      queries++;
      throw new Error('Forged authority reached SQL');
    },
  };
  for (const value of [{}, Object.freeze({}), JSON.parse('{"disposition":"ordinary-deletion"}')]) {
    await expect(
      lockRecordPurgeAuthoritySource(tx as unknown as CommandTransaction, value as RecordPurgeAuthority),
    ).rejects.toThrow('not issued');
  }
  expect(queries).toBe(0);
});

test('Context payload retention rolls back before page receipt commit and replays exactly after restart', async () => {
  const secret = `Context private label ${randomUUID()}`;
  const made = await f.call('POST', '/v1/contexts', 'owner', { labels: { en: secret } });
  f.status(made, 201);
  const id = made.body.context.id as string;
  const route = routeOf(id)!;
  const partition = partitionOf(route);
  f.status(await f.call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  const read = async () =>
    (await f.admin.query('SELECT labels FROM semantic.context WHERE route=$1 AND context_id=$2', [route, id])).rows[0];
  f.setNow(new Date(f.clock().getTime() + 30 * day - 1));
  const heldPage = await semanticRetention(f.pool, { clock: f.clock }).step({ partition, limit: 2, key: randomUUID() });
  expect(heldPage.purged).toBe(0);
  expect(JSON.stringify(await read())).toContain(secret);
  f.setNow(new Date(f.clock().getTime() + 1));
  f.status(await f.call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 409);
  const input = { partition, limit: 2, key: randomUUID() };
  const suffix = randomUUID().replaceAll('-', '');
  const name = `retention_failure_${suffix}`;
  // Test-only, exact-page fault injection. Product commands still create and delete the Context.
  await f.admin.query(`CREATE FUNCTION semantic.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key=TG_ARGV[0] THEN RAISE EXCEPTION 'injected_record_retention_receipt_failure'; END IF; RETURN NEW; END $$`);
  await f.admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON semantic.record_retention_page
    FOR EACH ROW EXECUTE FUNCTION semantic.${name}('${input.key}')`);
  try {
    await expect(semanticRetention(f.pool, { clock: f.clock }).step(input)).rejects.toThrow(
      'injected_record_retention_receipt_failure',
    );
    expect(JSON.stringify(await read())).toContain(secret);
    expect(
      (
        await f.admin.query('SELECT key FROM semantic.record_retention_page WHERE partition_no=$1 AND key=$2', [
          partition,
          input.key,
        ])
      ).rows,
    ).toHaveLength(0);
  } finally {
    await f.admin.query(`DROP TRIGGER ${name} ON semantic.record_retention_page`);
    await f.admin.query(`DROP FUNCTION semantic.${name}()`);
  }
  const page = await semanticRetention(f.pool, { clock: f.clock }).step(input);
  expect(page.examined).toBeLessThanOrEqual(2);
  expect(JSON.stringify(await read())).not.toContain(secret);
  expect(await semanticRetention(f.pool, { clock: f.clock }).step(input)).toEqual(page);
  expect(await read()).toEqual({ labels: {} });
});

test('a held contribution page survives restart and becomes eligible after release', async () => {
  const record = await f.proposal(await f.person());
  f.status(await f.call('DELETE', f.path(record), 'owner'), 200);
  f.status(
    await f.call('POST', `${f.path(record)}:hold`, 'platform', { held: true, reason: 'Preserve evidence' }),
    200,
  );
  f.setNow(new Date(f.clock().getTime() + 31 * day));
  const input = { partition: partitionOf(routeOf(record.subject)!), limit: 2, key: randomUUID() };
  const first = await semanticRetention(f.pool, { clock: f.clock }).step(input);
  expect(first.examined).toBeGreaterThan(0);
  expect(first.purged).toBe(0);
  expect(await semanticRetention(f.pool, { clock: f.clock }).step(input)).toEqual(first);
  const row = await f.admin.query(
    'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
    [routeOf(record.subject), record.subject, record.candidate],
  );
  expect(JSON.stringify(row.rows)).toContain(record.payload);
  f.status(await f.call('POST', `${f.path(record)}:hold`, 'platform', { held: false, reason: 'Released' }), 200);
  await f.drain(record.subject);
  await f.absentPayload(record.payload);
});

test('ordinary expiry removes the exact Content-owned authored body as well as its native source', async () => {
  const created = await f.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Recipe',
    labels: { en: 'Retention recipe' },
  });
  f.status(created, 201);
  const subject = created.body.subject.id as string;
  const secret = `Retained recipe body ${randomUUID()}`;
  const proposed = await f.call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: {
      property: { id: 'schema:abstract' },
      value: {
        type: 'value',
        content: {
          document: fromPlainText(secret),
          licence: 'CC-BY-4.0',
          language: 'en',
        },
      },
      references: [],
    },
  });
  f.status(proposed, 201);
  const candidate = proposed.body.candidate.id as string;
  const bodies = async () =>
    (
      await f.admin.query(
        'SELECT id,body,availability FROM content.authored_field WHERE route=$1 AND subject=$2 AND candidate=$3',
        [routeOf(subject), subject, candidate],
      )
    ).rows;
  expect((await bodies()).some((row) => row.body !== null)).toBe(true);
  f.status(await f.call('DELETE', `/v1/subjects/${subject}/candidates/${candidate}`, 'owner'), 200);
  f.setNow(new Date(f.clock().getTime() + 30 * day));
  await f.drain(subject);
  expect(await bodies()).toContainEqual(expect.objectContaining({ body: null, availability: 'erased' }));
  await f.absentPayload(secret);
});

test('Context native issuer binds committed generation and original source enrollment across restoration', async () => {
  const { prepareRecordPurgeAuthority, readRecordPurgeAuthoritySource } =
    await import('../../src/semantic/record-purge-authority.ts');
  const { sealRecordPurgeSourceInventory, verifyRecordPurgeSourceInventory } =
    await import('../../src/semantic/record-purge-custody.ts');
  const { runCommand, noEffect } = await import('../../src/command/command.ts');
  const made = await f.call('POST', '/v1/contexts', 'owner', { labels: { en: `Native issuer ${randomUUID()}` } });
  f.status(made, 201);
  const contextId = made.body.context.id as string,
    route = routeOf(contextId)!,
    partition = partitionOf(route);
  const path = `/v1/contexts/${contextId}`;
  f.status(await f.call('DELETE', path, 'owner'), 200);
  const native = async () =>
    (
      await f.admin.query(
        'SELECT deletion_generation,security_revision::text AS version FROM semantic.context WHERE route=$1 AND context_id=$2',
        [route, contextId],
      )
    ).rows[0]!;
  const first = await native();
  const deps = { pool: f.pool, clock: f.clock },
    context = { deadline: Date.now() + 10_000 };
  const ref = { kind: 'context' as const, contextId, deletionGeneration: first.deletion_generation as string };
  expect(await prepareRecordPurgeAuthority(deps, ref, context)).toBeNull();
  f.status(await f.call('POST', `${path}:restore`, 'owner', {}), 200);
  f.status(await f.call('DELETE', path, 'owner'), 200);
  const current = await native();
  expect(current.deletion_generation).not.toBe(first.deletion_generation);
  f.setNow(new Date(f.clock().getTime() + 30 * day));
  expect(await prepareRecordPurgeAuthority(deps, ref, context)).toBeNull();
  const authority = await prepareRecordPurgeAuthority(
    deps,
    { ...ref, deletionGeneration: current.deletion_generation },
    context,
  );
  expect(authority).not.toBeNull();
  const source = await readRecordPurgeAuthoritySource(deps, authority!, context);
  expect(source?.reference).toEqual({ ...ref, deletionGeneration: current.deletion_generation });
  expect(source?.sourceVersion).toBe(current.version);
  const enrollment = (
    await f.admin.query(
      `SELECT l.source_key,l.original_position FROM core.record_history_locator l WHERE source_key=$1`,
      [JSON.stringify(['context', contextId])],
    )
  ).rows;
  expect(enrollment.length).toBeGreaterThan(0);
  expect(enrollment.every((row) => row.original_position !== null)).toBe(true);
  let cut = await sealRecordPurgeSourceInventory(deps, authority!, context);
  for (let page = 0; cut.state === 'pending' && page < 3; page++)
    cut = await sealRecordPurgeSourceInventory(deps, authority!, context);
  expect(cut.state).toBe('sealed');
  if (cut.state !== 'sealed') throw new Error('Native enrolled source cut did not seal');
  const proof = cut.cut;
  expect(
    (
      await runCommand(f.pool, { partition, clock: f.clock, deadline: context.deadline }, async (tx) =>
        noEffect(await verifyRecordPurgeSourceInventory(tx, authority!, proof)),
      )
    ).value,
  ).toBe(true);
});
