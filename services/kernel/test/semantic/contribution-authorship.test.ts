import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createPool } from '../../src/database/pool.ts';
import { readAuthoredField } from '../../src/content/authored-fields.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { revisionResource } from '../../src/semantic/authorship.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);

const { admin, accounts, real, call, status, person, proposal, path } = fixture;

test('proposal author grant belongs to its original revision and survives candidate expansion by another editor', async () => {
  const subject = await person();
  const original = await proposal(subject);
  const anchor = revisionResource(subject, 2);
  const initialized = await admin.query(
    `SELECT i.resource_type, i.creator_id::text, g.subject_id::text, g.grant_role
     FROM access.resource_initialization i
     JOIN access.resource_role_grant g USING (route, resource_id)
     WHERE i.route=$1 AND i.resource_id=$2`,
    [routeOf(subject), anchor.id],
  );
  expect(initialized.rows).toEqual([
    {
      resource_type: 'semantic.revision',
      creator_id: accounts.owner,
      subject_id: accounts.owner,
      grant_role: 'semantic.revision.author',
    },
  ]);

  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  const expansion = await call('POST', `/v1/subjects/${subject}/candidates`, 'editor', {
    statement: fixture.cited('schema:url', `https://example.test/expansion/${randomUUID()}`),
  });
  status(expansion, 201);
  const authoringRevision = await admin.query(
    `SELECT revision, recorded_transaction_id::text FROM semantic.revision
     WHERE route=$1 AND subject_id=$2 ORDER BY revision`,
    [routeOf(subject), subject],
  );
  expect(authoringRevision.rows.map((row) => row.revision)).toEqual([1, 2, 3]);
  const expandedAnchor = revisionResource(subject, 3);
  const editorGrant = await admin.query(
    `SELECT creator_id::text, subject_id::text, grant_role FROM access.resource_initialization i
     JOIN access.resource_role_grant g USING (route, resource_id)
     WHERE i.route=$1 AND i.resource_id=$2`,
    [routeOf(subject), expandedAnchor.id],
  );
  expect(editorGrant.rows).toEqual([
    {
      creator_id: accounts.editor,
      subject_id: accounts.editor,
      grant_role: 'semantic.revision.author',
    },
  ]);
  expect(path(original)).toContain(original.candidate);
});

test('revoked native author role denies delete and receipt replay while proposal denial blocks restore only', async () => {
  const subject = await person();
  const record = await proposal(subject);
  const anchor = revisionResource(subject, 2);
  const receiptKey = `"${randomUUID()}"`;
  status(await call('DELETE', path(record), 'owner', undefined, receiptKey), 200);
  const restoreKey = `"${randomUUID()}"`;
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}, restoreKey), 200);
  await real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}, restoreKey), 403);
  const secondDeleteKey = `"${randomUUID()}"`;
  status(await call('DELETE', path(record), 'owner', undefined, secondDeleteKey), 200);
  await real.grant(anchor, 'owner', 'access:grant');
  const grants = await admin.query(
    `SELECT valid::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND grant_role='semantic.revision.author'`,
    [anchor.route, anchor.id, accounts.owner],
  );
  expect(grants.rows).toHaveLength(1);
  status(
    await call('POST', '/v1/roleGrants:revoke', 'owner', {
      resource: anchor,
      subject: { kind: 'account', id: accounts.owner },
      role: 'semantic.revision.author',
      valid: grants.rows[0]!.valid,
    }),
    200,
  );
  status(await call('DELETE', path(record), 'owner'), 403);
  status(await call('DELETE', path(record), 'owner', undefined, receiptKey), 403);
  status(await call('DELETE', path(record), 'owner', undefined, secondDeleteKey), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}, restoreKey), 403);
  expect(partitionOf(routeOf(subject)!)).toBe(partitionOf(routeOf(record.candidate)!));
});

test('native proposal receipt replay initializes neither a second revision nor a duplicate grant', async () => {
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  const subject = await person();
  const key = `"${randomUUID()}"`;
  const body = { statement: fixture.cited('schema:url', `https://example.test/replay/${randomUUID()}`) };
  const created = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', body, key);
  status(created, 201);
  const replay = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', body, key);
  status(replay, 201);
  expect(replay.body).toEqual(created.body);
  expect(await fixture.revisions(subject)).toEqual([
    { revision: 1, kind: 'create' },
    { revision: 2, kind: 'propose' },
  ]);
  const anchor = revisionResource(subject, 2);
  const initialized = await admin.query(
    `SELECT i.resource_id::text, i.creator_id::text, g.subject_id::text, g.grant_role
     FROM access.resource_initialization i JOIN access.resource_role_grant g USING(route,resource_id)
     WHERE i.route=$1 AND i.resource_id=ANY($2::uuid[])`,
    [anchor.route, [anchor.id, revisionResource(subject, 3).id]],
  );
  expect(initialized.rows).toEqual([
    {
      resource_id: anchor.id,
      creator_id: accounts.owner,
      subject_id: accounts.owner,
      grant_role: 'semantic.revision.author',
    },
  ]);
});

test('concurrent native proposals rebuild the exact revision manifest without orphan author resources', async () => {
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  const subject = await person();
  let readers = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Synchronize actual indexed preflight reads; query results and all Access/body calls remain native.
  const originals = new Map<import('pg').PoolClient, import('pg').PoolClient['query']>();
  function acquire(client: import('pg').PoolClient) {
    if (originals.has(client)) return;
    originals.set(client, client.query);
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        const pending: unknown = Reflect.apply(target, receiver, args);
        if (
          typeof args[0] !== 'string' ||
          !args[0].startsWith('SELECT revision FROM semantic.revision WHERE route=') ||
          !Array.isArray(args[1]) ||
          args[1][1] !== subject ||
          readers >= 2
        )
          return pending;
        if (!(pending instanceof Promise)) throw new Error('Native preflight must return a promise');
        return pending.then(async (result) => {
          readers++;
          if (readers === 2) release();
          await bothRead;
          return result;
        });
      },
    });
  }
  fixture.pool.on('acquire', acquire);
  try {
    const answers = await Promise.all(
      (['owner', 'editor'] as const).map((actor) =>
        call('POST', `/v1/subjects/${subject}/candidates`, actor, {
          statement: fixture.cited('schema:url', `https://example.test/collision/${actor}/${randomUUID()}`),
        }),
      ),
    );
    for (const answer of answers) status(answer, 201);
    expect(readers).toBe(2);
    expect(answers.map((answer) => answer.body.revision).sort()).toEqual([2, 3]);
    expect(await fixture.revisions(subject)).toEqual([
      { revision: 1, kind: 'create' },
      { revision: 2, kind: 'propose' },
      { revision: 3, kind: 'propose' },
    ]);
    for (const [index, actor] of (['owner', 'editor'] as const).entries()) {
      const anchor = revisionResource(subject, answers[index]!.body.revision);
      const rows = await admin.query(
        `SELECT i.creator_id::text,g.subject_id::text,g.grant_role
         FROM access.resource_initialization i JOIN access.resource_role_grant g USING(route,resource_id)
         WHERE i.route=$1 AND i.resource_id=$2`,
        [anchor.route, anchor.id],
      );
      expect(rows.rows).toEqual([
        {
          creator_id: accounts[actor],
          subject_id: accounts[actor],
          grant_role: 'semantic.revision.author',
        },
      ]);
    }
    const orphan = revisionResource(subject, 4);
    expect(
      (
        await admin.query('SELECT resource_id FROM access.resource_initialization WHERE route=$1 AND resource_id=$2', [
          orphan.route,
          orphan.id,
        ])
      ).rows,
    ).toEqual([]);
  } finally {
    release();
    fixture.pool.off('acquire', acquire);
    for (const [client, query] of originals) client.query = query;
  }
});

test('failure during native grant initialization rolls back the proposal, resources, outbox and receipt', async () => {
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  const subject = await person();
  const anchor = revisionResource(subject, 2);
  const name = `authorship_fault_${randomUUID().replaceAll('-', '')}`;
  const before = (
    await admin.query('SELECT type,data FROM core.outbox WHERE subject=$1 ORDER BY type,data::text', [subject])
  ).rows;
  const key = `"${randomUUID()}"`;
  const body = { statement: fixture.cited('schema:url', `https://example.test/rollback/${randomUUID()}`) };
  // Fault injection writes no owner or lifecycle evidence; the real API must roll everything back.
  await admin.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'authorship body fault'; END $$`);
  try {
    await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON access.resource_initialization
      FOR EACH ROW WHEN (NEW.resource_id='${anchor.id}'::uuid) EXECUTE FUNCTION public.${name}()`);
    try {
      status(await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', body, key), 500);
      expect(await fixture.revisions(subject)).toEqual([{ revision: 1, kind: 'create' }]);
      expect(
        (
          await admin.query(
            'SELECT resource_id FROM access.resource_initialization WHERE route=$1 AND resource_id=$2',
            [anchor.route, anchor.id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query('SELECT resource_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
            anchor.route,
            anchor.id,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query('SELECT candidate_id FROM semantic.candidate WHERE route=$1 AND subject_id=$2', [
            anchor.route,
            subject,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (await admin.query('SELECT type,data FROM core.outbox WHERE subject=$1 ORDER BY type,data::text', [subject]))
          .rows,
      ).toEqual(before);
    } finally {
      await admin.query(`DROP TRIGGER ${name} ON access.resource_initialization`);
    }
  } finally {
    await admin.query(`DROP FUNCTION public.${name}()`);
  }
  const retry = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', body, key);
  status(retry, 201);
  expect(retry.body.revision).toBe(2);
  const replay = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', body, key);
  status(replay, 201);
  expect(replay.body).toEqual(retry.body);
});

test('delete replay and a fresh delete after restoration preserve the first exclusive thirty-day window', async () => {
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  const savedTime = fixture.clock();
  const record = await proposal(await person());
  const key = `"${randomUUID()}"`;
  const state = async () =>
    (
      await admin.query(
        `SELECT state,version::text,deletion_generation::text,deleted_at::text,purge_after::text,held
     FROM semantic.record_lifecycle WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
        [routeOf(record.subject), record.subject, record.candidate],
      )
    ).rows[0];
  try {
    status(await call('DELETE', path(record), 'owner', undefined, key), 200);
    const first = await state();
    expect(first.state).toBe('deleted');
    const eventCount = async () =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM core.outbox WHERE subject=$1 AND type='com.rezics.semantic.record.deleted.v1'`,
          [record.subject],
        )
      ).rows;
    const events = await eventCount();
    status(await call('DELETE', path(record), 'owner', undefined, key), 200);
    status(await call('DELETE', path(record), 'owner'), 200);
    expect(await state()).toEqual(first);
    expect(await eventCount()).toEqual(events);
    fixture.setNow(new Date(savedTime.getTime() + 29 * 86_400_000));
    status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
    status(await call('DELETE', path(record), 'owner'), 200);
    expect(await state()).toEqual({ ...first, version: String(BigInt(first.version) + 2n) });
    fixture.setNow(new Date(savedTime.getTime() + 30 * 86_400_000));
    status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 409);
    expect(await state()).toEqual({ ...first, version: String(BigInt(first.version) + 2n) });
  } finally {
    fixture.setNow(savedTime);
  }
});

test('authored Content keeps the declared revision anchor and retained body while current disclosure is deleted', async () => {
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  const created = await call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Authored contribution' },
  });
  status(created, 201);
  const subject: string = created.body.subject.id;
  const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: fixture.cited('schema:abstract', {
      document: fromPlainText('A retained original account-authored description.'),
      licence: 'CC-BY-4.0',
      language: 'en',
    }),
  });
  status(proposed, 201);
  const candidate: string = proposed.body.candidate;
  const rows = await admin.query<{ document: string }>(
    `SELECT statement#>>'{value,content,document}' AS document FROM semantic.candidate
     WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
    [routeOf(subject), subject, candidate],
  );
  const stored = await readAuthoredField(fixture.pool, routeOf(subject)!, rows.rows[0]!.document);
  expect(stored?.anchor).toBe(revisionResource(subject, proposed.body.revision).id);
  expect(stored?.authorAccountId).toBe(accounts.owner);
  const record = { subject, candidate };
  status(await call('DELETE', path(record), 'owner'), 200);
  expect((await readCandidateDisclosure(admin, record))?.disclosed).toBe(false);
  expect(await readAuthoredField(fixture.pool, routeOf(subject)!, rows.rows[0]!.document)).toEqual(stored);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
  expect((await readCandidateDisclosure(admin, record))?.disclosed).toBe(true);
});

test('restore prepares Global authority before Subject checkout with one native pooled connection, including replay', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  pool.options.max = 1;
  const single = await createDeletionFixture({ pool, admin });
  try {
    await single.setup();
    const record = await single.proposal(await single.person());
    single.status(await single.call('DELETE', single.path(record), 'owner'), 200);
    const key = `"${randomUUID()}"`;
    single.status(await single.call('POST', `${single.path(record)}:restoreDeleted`, 'owner', {}, key), 200);
    single.status(await single.call('POST', `${single.path(record)}:restoreDeleted`, 'owner', {}, key), 200);
    await single.real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
    single.status(await single.call('POST', `${single.path(record)}:restoreDeleted`, 'owner', {}, key), 403);
    single.status(await single.call('DELETE', single.path(record), 'owner'), 200);
    single.status(await single.call('POST', `${single.path(record)}:restoreDeleted`, 'owner', {}), 403);
  } finally {
    await pool.end();
  }
});
