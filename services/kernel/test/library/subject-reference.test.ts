import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { runCommand } from '../../src/command/command.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readableSubjects, resolveSubject } from '../../src/library/subject-anchor.ts';
import { accessCommandAuthorization, type Access, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase, access: Access, actor: AccountActor;
let real: Awaited<ReturnType<typeof createRealAccess<{ reader: string }>>>;
const parent = { route: 0, id: GLOBAL_CONTEXT };
const release = { digest: bundledDigest, release: bundledRelease };
const route = 0x6d10;
const deps = () => ({ pool: db.pool, access });
const context = () => ({ pool: db.pool, deadline: Date.now() + 5_000 });
const command = () => ({ actor, release, idempotencyKey: randomUUID(), digest: new Uint8Array(32) });
const resolve = (id: string) => withRequestDeadline(context().deadline, () => resolveSubject(deps(), actor, id));
const authorization = (action: string) =>
  accessCommandAuthorization(access, actor, action, parent, context(), () => new Error('Fixture denied'));
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const actions = ['subject:create', 'subject:merge', 'subject:read'];
  real = await createRealAccess(db.admin, { reader: newId(route) }, actions);
  const app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(31),
    access: (config) => (access = real.access(config)),
  });
  const headers = { authorization: `Bearer ${real.bearer('reader')}` };
  const response = await app.handle(new Request(`https://kernel.test/v1/subjects/${newId(route)}`, { headers }));
  expect(response.status).toBe(404);
  actor = await access.authenticate(real.bearer('reader'), context());
  await real.grant(parent, 'reader', 'subject:create');
  await real.grant(parent, 'reader', 'subject:merge');
});
afterAll(() => db?.close());
async function subject(atRoute = route) {
  const id = newId(atRoute);
  await createSubject(db.pool, {
    ...command(),
    target: { route: atRoute, id },
    item: { type: 'schema:Book', labels: { en: 'Reference' } },
    authorization: await authorization('subject:create'),
  });
  return id;
}
async function pair() {
  const source = await subject(),
    survivor = await subject(route + 16);
  await mergeSubjects(db.pool, {
    subjects: [source, survivor],
    survivor,
    ...command(),
    deadline: Date.now() + 5_000,
    authorization: await authorization('subject:merge'),
  });
  return { source, survivor };
}
async function deny(id: string, until: Date | null = null) {
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'subject:read','resource',tstzrange(NULL,$4,'[)'),$3)`,
    [routeOf(id), id, actor.accountId, until],
  );
}
const clearDenial = (id: string) => db.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1', [id]);
async function observed<T>(operation: () => Promise<T>) {
  const observer = observeSql(db.pool);
  try {
    return { value: await operation(), records: observer.records };
  } finally {
    await observer.close();
    expect(observer.records.map(({ statement }) => statement).join('\n')).not.toMatch(
      /consumer_checkpoint|projection_pending|semantic\.(?:fact|definition\w*|release\w*|summary\w*|merge_member|outbound_link\w*|inbound_link\w*|revision|candidate|adoption|acceptance)\b/i,
    );
  }
}
test('Library reference resolution stays source-authorized and bounded without display or projection hydration', async () => {
  const { source, survivor } = await pair();
  const result = await observed(() => resolve(source));
  expect(result.value).toEqual({ subjectId: survivor, requestedSubjectId: source });
  expect(await resolve(survivor)).toEqual({ subjectId: survivor, requestedSubjectId: null });
  const transactions = result.records.filter(({ statement }) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement));
  expect(
    transactions.filter(({ statement }) => statement === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
  ).toHaveLength(2);
  const boundaries = transactions.map(({ statement }) => statement.split(' ')[0]);
  expect(boundaries).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  // Each source snapshot contains its own identity, partition and ordinary Access query.
  for (let i = 0; i < 2; i++) {
    const start = result.records.indexOf(transactions[i * 2]!),
      end = result.records.indexOf(transactions[i * 2 + 1]!);
    const anchor = result.records.slice(start, end + 1);
    expect(new Set(anchor.map(({ connectionId }) => connectionId)).size).toBe(1);
    expect(anchor.some(({ statement }) => /access\.resource_denial/.test(statement))).toBe(true);
    const id = [source, survivor][i]!;
    expect(anchor.some(({ parameters }) => parameters.includes(partitionOf(routeOf(id)!)))).toBe(true);
    expect(anchor.some(({ parameters }) => parameters.includes([source, survivor][i]!))).toBe(true);
  }
  await deny(source);
  real.readChecks.length = 0;
  expect((await observed(() => resolve(source))).value).toBeNull();
  expect(real.readChecks.map(({ resource }) => resource.id)).toEqual([source]);
  await clearDenial(source);
  await deny(survivor);
  expect((await observed(() => resolve(source))).value).toBeNull();
  await clearDenial(survivor);
  for (const visibility of ['hidden', 'taken_down', 'visible']) {
    await db.admin.query(
      'UPDATE semantic.subject SET visibility=$2, security_revision=security_revision+1 WHERE subject_id=$1',
      [survivor, visibility],
    );
    expect((await observed(() => resolve(source))).value === null).toBe(visibility !== 'visible');
  }
  for (const id of ['invalid', newId(route)]) expect((await observed(() => resolve(id))).value).toBeNull();
  // Corrupt history must fail closed rather than recurse indefinitely.
  await db.admin.query(
    `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
    VALUES ($1,$2,1,$3,$4)`,
    [routeOf(survivor), survivor, source, randomUUID()],
  );
  real.readChecks.length = 0;
  expect((await observed(() => resolve(source))).value).toBeNull();
  expect(real.readChecks.map(({ resource }) => resource.id)).toEqual([source, survivor]);
  // A live command's acceptance time also applies on the separate reference snapshot.
  const id = await subject();
  const now = (await db.admin.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const ahead = new Date(now.getTime() + 30_000);
  await deny(id, ahead);
  expect(await resolve(id)).toBeNull();
  await runCommand(
    db.admin,
    { partition: partitionOf(route), deadline: Date.now() + 5_000, clock: () => ahead },
    async (_, command) => {
      const actual = await observed(() => resolveSubject(deps(), actor, id, command.time));
      expect(actual.value).toEqual({ subjectId: id, requestedSubjectId: null });
      return { value: null, events: [{ type: 'com.rezics.access.time-probe.v1', data: {} }] };
    },
  );
  await expect(withRequestDeadline(Date.now() - 1, () => resolveSubject(deps(), actor, id))).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
  const unavailable = new AccessUnavailableError('overloaded');
  const failing = deriveAccess(access, {
    async authorize(...args) {
      await access.authorize(...args);
      throw unavailable;
    },
  });
  await expect(observed(() => resolveSubject({ pool: db.pool, access: failing }, actor, id))).rejects.toBe(unavailable);
});
test('reference work is fixed under unrelated subject and statement growth and bounded by the input page', async () => {
  const { source, survivor } = await pair();
  const page: string[] = [];
  const label = { log_seq: 1, operation: 'assert', kind: 'label', language: 'en', body: 'Background' };
  const population = {
    name: 'library-reference-background',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: () => {
      const id = newId(route),
        transaction = randomUUID();
      const row = { route, subject_id: id, recorded_transaction_id: transaction };
      return {
        'semantic.subject': [{ ...row, type: 'schema:Book' }],
        'semantic.fact': [{ ...row, ...label, slot_id: newId(route) }],
      };
    },
  };
  await seed(db, population, { from: 0, to: 2048 });
  for (const axis of ['unrelated', 'page'] as const) {
    await checkGrowth(db, {
      name: `Library references ${axis}`,
      scales: axis === 'unrelated' ? [64, 512, 4096] : [4, 16, 64],
      bounds:
        axis === 'page'
          ? { rows: 'linear', statements: 'linear', blocks: 'linear' }
          : { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_, scale, previous) => {
        if (axis === 'unrelated') await seed(db, population, { from: 2048 + previous, to: 2048 + scale });
        else while (page.length < scale) page.push(await subject());
      },
      operation: async () => {
        if (axis === 'unrelated') {
          expect(await resolve(source)).toEqual({ subjectId: survivor, requestedSubjectId: source });
          const ids = [source, survivor];
          expect(await readableSubjects(deps(), actor, [...ids, source, 'invalid'])).toEqual(ids);
        } else expect(await readableSubjects(deps(), actor, page)).toEqual(page);
      },
    });
  }
  const measured = await observed(() => readableSubjects(deps(), actor, [...page, ...page.slice(0, 36)]));
  expect(measured.value).toEqual(page);
  let active = 0,
    maximum = 0;
  for (const { statement } of measured.records) {
    if (statement.startsWith('BEGIN')) maximum = Math.max(maximum, ++active);
    if (/^(COMMIT|ROLLBACK)/.test(statement)) active--;
  }
  expect(active).toBe(0);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(measured.records.filter(({ statement }) => statement.startsWith('BEGIN'))).toHaveLength(64);
  await expect(readableSubjects(deps(), actor, Array(101).fill(source))).rejects.toBeInstanceOf(RangeError);
});
