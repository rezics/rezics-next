import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { moderateStatement } from '../../src/semantic/moderation.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

// Integration acceptance: intentionally red until the owning proposal is implemented.
// No alternate DTO, mocked moderation, SQL lifecycle seed, relay or fabricated Source.
let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof createDeletionFixture>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createDeletionFixture(db);
  await f.setup();
});
afterAll(async () => {
  await db?.close();
});
type RecordKey = { subject: string; candidate: string; payload: string };
const day = 86_400_000;
const notice = () => ({ complaint: 'Only the addressed field', received_at: f.clock().toISOString() });
const fieldsBody = (fields = ['/value']) => ({ notice: notice(), fields });
const take = (record: RecordKey, body: unknown = fieldsBody(), key?: string) =>
  f.call('POST', `${f.path(record)}:takedown`, 'platform', body, key);
const restore = (record: RecordKey, fields?: string[], key?: string) =>
  f.call(
    'POST',
    `${f.path(record)}:restore`,
    'platform',
    {
      reason: 'Counter-notice accepted',
      ...(fields ? { fields } : {}),
    },
    key,
  );
async function selected() {
  const record = await f.proposal(await f.person('Uncovered title'));
  await f.accept(record);
  await f.adopt(record, null);
  return record;
}
async function detail(record: RecordKey) {
  const answer = await f.call('GET', `/v1/subjects/${record.subject}`);
  f.status(answer, 200);
  return answer.body.subject;
}
async function candidates(record: RecordKey, property = 'schema:url') {
  const answer = await f.call(
    'GET',
    `/v1/subjects/${record.subject}/candidates?property=${encodeURIComponent(property)}`,
  );
  f.status(answer, 200);
  return answer.body.candidates as { id: string; statement: Record<string, any> }[];
}
const candidate = async (record: RecordKey) => (await candidates(record)).find((row) => row.id === record.candidate);
async function source(record: RecordKey) {
  const snapshot = await subjectSource(db.pool, f.routeKey).read(partitionOf(routeOf(record.subject)!), [
    record.subject,
  ]);
  return snapshot.subjects;
}
async function disclosure(record: RecordKey) {
  // Structural input remains callable on the base; its real reader currently ignores the proposed key.
  const ref = { subject: record.subject, candidate: record.candidate, routeKey: f.routeKey };
  return readCandidateDisclosure(db.pool, ref);
}
async function assertPartial(record: RecordKey, original: Record<string, any>) {
  const expected: Record<string, any> = { ...original, availability: { state: 'partial', withheld: ['/value'] } };
  delete expected.value;
  const item = await detail(record);
  expect(item.labels).toEqual({ en: 'Uncovered title' });
  expect(item.statements['schema:url']).toEqual([expected]);
  expect((await candidate(record))?.statement).toEqual(expected);
  expect(JSON.stringify(item)).not.toContain(record.payload);
  expect(expected.references[0].parts[0].value.content).toBe('https://example.test/evidence');
  expect((await source(record))[0]!.statements).toEqual([]);
  expect(await disclosure(record)).toEqual({ disclosed: false, security_revision: 1 });
}

for (const spelling of ['fields', 'frozen scope'] as const) {
  test(`${spelling}: /value keeps the exact uncovered citation and selected partial Statement`, async () => {
    const record = await selected();
    const original = (await candidate(record))!.statement;
    expect((await source(record))[0]!.statements).toContainEqual({ property: 'schema:url', value: record.payload });
    expect(await disclosure(record)).toEqual({ disclosed: true, security_revision: 0 });
    const body = spelling === 'fields' ? fieldsBody() : { notice: { ...notice(), scope: '/value' } };
    const key = `"${randomUUID()}"`;
    const first = await take(record, body, key);
    f.status(first, 200);
    expect(first.body).toEqual({
      subject: record.subject,
      candidate: record.candidate,
      visibility: 'taken_down',
      security_revision: 1,
    });
    await assertPartial(record, original);
    expect(await take(record, body, key)).toEqual(first);
    const conflict = await take(record, { ...body, fields: ['/references/0'] }, key);
    f.status(conflict, 422);
    f.status(await restore(record), 200);
    expect((await candidate(record))!.statement).toEqual(original);
    expect((await source(record))[0]!.statements).toContainEqual({ property: 'schema:url', value: record.payload });
    expect(await disclosure(record)).toEqual({ disclosed: true, security_revision: 2 });
  });
}

test('reference masks preserve stable array positions, remove hashes and restore independently of the value', async () => {
  const record = await selected();
  const original = (await candidate(record))!.statement;
  f.status(await take(record, fieldsBody(['/references/0'])), 200);
  const referenceOnly = {
    ...original,
    references: [null],
    availability: { state: 'partial', withheld: ['/references/0'] },
  };
  expect((await candidate(record))!.statement).toEqual(referenceOnly);
  expect((await detail(record)).statements['schema:url']).toEqual([referenceOnly]);
  expect(JSON.stringify(await candidate(record))).not.toContain(original.references[0].hash);
  expect((await source(record))[0]!.statements).toContainEqual({ property: 'schema:url', value: record.payload });
  expect((await disclosure(record))!.disclosed).toBe(false);
  f.status(await take(record), 200);
  f.status(await restore(record, ['/value']), 200);
  expect((await candidate(record))!.statement).toEqual(referenceOnly);
  f.status(await restore(record, ['/value']), 409);
  f.status(await restore(record, ['/references/0']), 200);
  expect((await candidate(record))!.statement).toEqual(original);
});

test('compact field masks preserve uncovered qualifiers and revoke only the covered relation with relays paused', async () => {
  const covered = await f.person();
  const uncovered = await f.person();
  const created = await f.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Two credits' },
    statements: {
      'schema:author': [
        {
          ...f.cited('schema:author', covered),
          qualifiers: [f.snak('wdt:P1932', 'Covered credit'), f.snak('schema:position', '1')],
        },
        f.cited('schema:author', uncovered),
      ],
    },
  });
  f.status(created, 201);
  const original = created.body.subject.statements['schema:author'][0];
  const survivor = created.body.subject.statements['schema:author'][1];
  const record = { subject: created.body.subject.id as string, candidate: original.id as string, payload: covered };
  const links = async (target: string) => {
    const answer = await f.call('GET', `/v1/subjects/${target}/links?property=schema%3Aauthor`);
    f.status(answer, 200);
    return answer.body;
  };
  await f.caughtUp(record.subject);
  expect((await links(covered)).links).toHaveLength(1);
  expect((await links(uncovered)).links).toHaveLength(1);
  f.status(await take(record, fieldsBody(['/qualifiers/0'])), 200);
  const qualifierMasked = (await detail(record)).statements['schema:author'].find(
    (row: { id: string }) => row.id === original.id,
  );
  expect(qualifierMasked).toEqual({
    ...original,
    qualifiers: [null, original.qualifiers[1]],
    availability: { state: 'partial', withheld: ['/qualifiers/0'] },
  });
  expect(JSON.stringify(await source(record))).not.toContain('Covered credit');
  f.status(await restore(record, ['/qualifiers/0']), 200);
  f.status(await take(record), 200);
  // No projection, relay or receiving job runs between authoritative mask and these reads.
  const gone = await links(covered);
  expect(gone.links).toEqual([]);
  expect(Object.hasOwn(gone, 'count')).toBe(false);
  expect((await links(uncovered)).links).toHaveLength(1);
  const statements = (await detail(record)).statements['schema:author'];
  expect(statements).toContainEqual(survivor);
  const shown = statements.find((row: { id: string }) => row.id === original.id);
  expect(Object.hasOwn(shown, 'value')).toBe(false);
  expect(shown.references).toEqual(original.references);
  f.status(await restore(record, ['/value']), 200);
  expect((await links(covered)).links).toHaveLength(1);
});

for (const scope of [undefined, 'one disputed passage', '/references/0', ' /value']) {
  test(`old notice scope ${JSON.stringify(scope)} still hides the whole candidate`, async () => {
    const record = await selected();
    const original = (await candidate(record))!.statement;
    f.status(await take(record, { notice: { ...notice(), ...(scope === undefined ? {} : { scope }) } }), 200);
    expect(await candidates(record)).toEqual([]);
    expect((await detail(record)).statements['schema:url'] ?? []).toEqual([]);
    expect((await source(record))[0]!.statements).toEqual([]);
    f.status(await restore(record, ['/value']), 409);
    f.status(await restore(record), 200);
    expect((await candidate(record))!.statement).toEqual(original);
  });
}

test('selectors reject missing fields and unsupported syntax without writing or broadening a notice', async () => {
  const record = await selected();
  const before = await detail(record);
  for (const fields of [
    [],
    ['/unknown'],
    ['/value/content'],
    ['/references/1'],
    ['/qualifiers/0'],
    ['/references/00'],
    ['/references/-'],
    ['/references/*'],
    ['/value', '/value'],
    Array(33).fill('/value'),
  ]) {
    const answer = await take(record, fieldsBody(fields));
    f.status(answer, 400);
    expect(answer.body.code).toBe('invalid_request');
    expect(answer.body.errors.some((error: { pointer: string }) => error.pointer.startsWith('/fields'))).toBe(true);
  }
  f.status(await take(record, { notice: { ...notice(), scope: '/value' }, fields: ['/references/0'] }), 400);
  expect(await detail(record)).toEqual(before);
  expect(await disclosure(record)).toEqual({ disclosed: true, security_revision: 0 });
});

test('unknown candidate paths stay indistinguishable; scope without a current grant never authorizes a mask or replay', async () => {
  const record = await selected();
  const other = await f.person();
  const comparable = ({ status, body }: { status: number; body: Record<string, unknown> }) => {
    const { instance: _instance, ...problem } = body;
    return { status, problem };
  };
  const unknown = await take({ ...record, candidate: newId(routeOf(record.subject)!) });
  f.status(unknown, 404);
  for (const target of [
    { ...record, subject: other },
    { ...record, candidate: 'unknown' },
  ])
    expect(comparable(await take(target))).toEqual(comparable(unknown));
  expect(await disclosure({ ...record, candidate: newId(routeOf(record.subject)!) })).toBeNull();
  for (const as of ['owner', 'editor', 'stranger'] as const) {
    f.status(await f.call('POST', `${f.path(record)}:takedown`, as, fieldsBody()), 403);
    f.status(
      await f.call('POST', `${f.path(record)}:restore`, as, { reason: 'No authority', fields: ['/value'] }),
      403,
    );
  }
  const body = fieldsBody();
  const key = `"${randomUUID()}"`;
  f.status(await take(record, body, key), 200);
  await f.real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'platform', 'moderation:takedown');
  try {
    f.status(await take(record, body, key), 403);
  } finally {
    await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'platform', 'moderation:takedown');
  }
  expect((await disclosure(record))!.security_revision).toBe(1);
});

test('field takedown has no destructive deadline and cannot be changed into early purge by its owner', async () => {
  const record = await selected();
  const original = (await candidate(record))!.statement;
  f.status(await take(record), 200);
  for (const days of [30, 30]) {
    f.setNow(new Date(f.clock().getTime() + days * day));
    await f.drain(record.subject);
    const stored = await db.admin.query(
      'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(record.subject), record.subject, record.candidate],
    );
    expect(stored.rows[0].statement.value.content).toBe(record.payload);
    await assertPartial(record, original);
  }
  f.status(await f.call('POST', `${f.path(record)}:purge`, 'owner', { reason: 'early' }), 403);
  f.status(await f.call('POST', `${f.path(record)}:purge`, 'platform', { reason: 'early' }), 409);
  f.status(await restore(record, ['/value']), 200);
  expect((await candidate(record))!.statement).toEqual(original);
});

test('field restore clears only moderation and rechecks current owner deletion and adoption', async () => {
  const record = await selected();
  f.status(await take(record), 200);
  f.status(await f.call('DELETE', f.path(record), 'owner'), 200);
  f.status(await restore(record, ['/value']), 200);
  expect(await candidates(record)).toEqual([]);
  expect((await source(record))[0]!.statements).toEqual([]);
  expect((await disclosure(record))!.disclosed).toBe(false);
  f.status(await f.call('POST', `${f.path(record)}:restoreDeleted`, 'owner'), 200);
  const replacement = await f.proposal(record.subject);
  await f.accept(replacement);
  await f.adopt(replacement, 1);
  f.status(await take(record), 200);
  f.status(await restore(record, ['/value']), 200);
  const shown = JSON.stringify(await detail(record));
  expect(shown).not.toContain(record.payload);
  expect(shown).toContain(replacement.payload);
  expect((await candidate(record))!.statement.value.content).toBe(record.payload);
});

test('field restore cannot bypass a current whole-subject takedown', async () => {
  const record = await selected();
  f.status(await take(record), 200);
  f.status(await f.call('POST', `/v1/subjects/${record.subject}:takedown`, 'platform', { notice: notice() }), 200);
  f.status(await restore(record, ['/value']), 200);
  f.status(await f.call('GET', `/v1/subjects/${record.subject}`), 404);
  expect(await source(record)).toEqual([]);
  expect((await disclosure(record))!.disclosed).toBe(false);
  f.status(
    await f.call('POST', `/v1/subjects/${record.subject}:restore`, 'platform', { reason: 'Subject cleared' }),
    200,
  );
  expect(JSON.stringify(await detail(record))).toContain(record.payload);
});

test('field restore cannot clear the real current provider source fence while consumers pause', async () => {
  const subject = await f.person();
  const origin = {
    source: 'openlibrary',
    external_id: randomUUID(),
    field_group: 'facts',
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: '1',
  };
  const payload = `https://example.test/provider/${randomUUID()}`;
  const batch = await f.call('POST', '/v1/subjects:batchWrite', 'owner', {
    commands: [
      {
        op: 'propose',
        key: randomUUID(),
        subject,
        source: origin,
        statement: f.cited('schema:url', payload),
      },
    ],
  });
  f.status(batch, 200);
  expect(batch.body.results[0].status).toBe(201);
  const record = { subject, candidate: batch.body.results[0].value.candidate as string, payload };
  await f.accept(record);
  await f.adopt(record, null);
  expect(JSON.stringify(await source(record))).toContain(payload);
  f.status(await take(record), 200);
  await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'platform', 'source_fence:takedown');
  f.status(
    await f.call('POST', '/v1/sourceFences:takedown', 'platform', {
      source: origin.source,
      externalId: origin.external_id,
      fieldGroup: 'facts',
      reason: 'Provider revoked',
    }),
    200,
  );
  f.status(await restore(record, ['/value']), 200);
  expect(await candidates(record)).toEqual([]);
  expect(JSON.stringify(await detail(record))).not.toContain(payload);
  expect((await source(record))[0]!.statements).toEqual([]);
  expect((await disclosure(record))!.disclosed).toBe(false);
});

test('native expired command deadline leaves the current mask and statement unchanged', async () => {
  const record = await selected();
  const original = (await candidate(record))!.statement;
  const access = createAccess({ actions: actionCatalogue(f.kernel), auth: f.auth, clock: f.clock });
  const actor = await access.authenticate(await f.bearer(f.accounts.platform, f.actions), {
    pool: db.pool,
    deadline: Date.now() + 5000,
  });
  const deadline = Date.now() - 1;
  await expect(
    moderateStatement(db.pool, {
      actor,
      subject: record.subject,
      candidate: record.candidate,
      action: 'take_down',
      body: fieldsBody(),
      idempotencyKey: randomUUID(),
      digest: new Uint8Array(32),
      deadline,
      clock: f.clock,
      authorization: resourceAuthorization({
        access,
        actor,
        action: 'moderation:takedown',
        anchor: globalContextAnchor,
        context: { pool: db.pool, deadline, partition: partitionOf(routeOf(record.subject)!) },
      }),
    }),
  ).rejects.toMatchObject({ reason: 'deadline' });
  expect((await candidate(record))!.statement).toEqual(original);
  expect(await disclosure(record)).toEqual({ disclosed: true, security_revision: 0 });
});

test('receipt failure rolls mask and security state back before the same native request retries', async () => {
  const record = await selected();
  const original = (await candidate(record))!.statement;
  const body = fieldsBody();
  const key = `"${randomUUID()}"`;
  await db.admin.query(`CREATE FUNCTION public.reject_field_mask_receipt() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'field mask receipt fault'; END $$`);
  await db.admin.query(`CREATE TRIGGER reject_field_mask_receipt BEFORE INSERT ON core.receipt
    FOR EACH ROW EXECUTE FUNCTION public.reject_field_mask_receipt()`);
  try {
    f.status(await take(record, body, key), 500);
    expect((await candidate(record))!.statement).toEqual(original);
    expect(await disclosure(record)).toEqual({ disclosed: true, security_revision: 0 });
  } finally {
    await db.admin.query('DROP TRIGGER reject_field_mask_receipt ON core.receipt');
    await db.admin.query('DROP FUNCTION public.reject_field_mask_receipt()');
  }
  f.status(await take(record, body, key), 200);
  await assertPartial(record, original);
});

test('native mask/read/restore/denial/replay costs stay bounded as unrelated data and own decision history grow', async () => {
  const record = await selected();
  const unrelated = await f.person();
  const original = (await candidate(record))!.statement;
  const report = await checkGrowth(db, {
    name: 'field-scoped native disclosure and command history',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      for (let i = previous; i < scale; i++) {
        await f.proposal(unrelated);
        f.status(await take(record), 200);
        f.status(await restore(record), 200);
      }
    },
    async operation() {
      const body = fieldsBody();
      const key = `"${randomUUID()}"`;
      const first = await take(record, body, key);
      f.status(first, 200);
      expect(await take(record, body, key)).toEqual(first);
      expect((await candidate(record))!.statement.references).toEqual(original.references);
      expect(JSON.stringify(await detail(record))).not.toContain(record.payload);
      expect((await source(record))[0]!.statements).toEqual([]);
      expect((await disclosure(record))!.disclosed).toBe(false);
      f.status(await f.call('POST', `${f.path(record)}:takedown`, 'owner', body), 403);
      f.status(await restore(record, ['/value']), 200);
      expect((await candidate(record))!.statement).toEqual(original);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});

test('field restore never publishes a private account assertion or reverses its terminal account fence', async () => {
  await ensureAccountAgent(db.pool, { account: f.accounts.owner, kind: 'person', name: 'Private target identity' });
  const subject = await f.person();
  const payload = accountAgentId(f.accounts.owner);
  const proposed = await f.call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: f.snak('rezics:penNameOf', payload),
  });
  f.status(proposed, 201);
  const record = { subject, candidate: proposed.body.candidate as string, payload };
  expect(await candidates(record, 'rezics:penNameOf')).toEqual([]);
  f.status(await take(record), 200);
  f.status(await restore(record, ['/value']), 200);
  expect(await candidates(record, 'rezics:penNameOf')).toEqual([]);
  expect((await disclosure(record))!.disclosed).toBe(false);
  f.status(await take(record), 200);
  const access = createAccess({ actions: LIFECYCLE_ACTIONS, auth: f.auth, clock: f.clock });
  await f.real.grant({ route: routeOf(f.accounts.owner)!, id: f.accounts.owner }, 'owner', 'account:delete');
  const actor = await access.authenticate(await f.bearer(f.accounts.owner, f.actions), {
    pool: db.pool,
    deadline: Date.now() + 5000,
  });
  await createLifecycleCommands({ pool: db.pool, access, clock: f.clock }).tombstone(
    { actor, deadline: Date.now() + 5000 },
    { accountId: f.accounts.owner, key: randomUUID() },
  );
  f.status(await restore(record, ['/value']), 200);
  expect(await candidates(record, 'rezics:penNameOf')).toEqual([]);
  expect(JSON.stringify(await detail(record))).not.toContain(payload);
  expect((await disclosure(record))!.disclosed).toBe(false);
});
