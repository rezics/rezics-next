import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';

const {
  admin,
  pool,
  accounts,
  clock,
  real,
  routeKey,
  call,
  status,
  cited,
  person,
  proposal,
  path,
  accept,
  adopt,
  current,
  revisions,
  setNow,
} = fixture;
const day = 86_400_000;

test('user-owned semantic records soft-delete and restore without resurrecting superseded decisions', async () => {
  const subject = await person();
  const old = await proposal(subject);
  await accept(old);
  const head = await adopt(old, null);
  const before = await revisions(subject);
  status(await call('DELETE', path(old), 'stranger'), 403);
  const deletedAt = clock().getTime();
  status(await call('DELETE', path(old), 'owner'), 200);
  expect(JSON.stringify(await current(subject))).not.toContain(old.payload);
  const candidates = await call('GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl`, 'owner');
  status(candidates, 200);
  expect(candidates.body.candidates).toContainEqual(expect.objectContaining({ id: old.candidate, deleted: true }));
  expect(JSON.stringify(candidates.body)).not.toContain(old.payload);
  expect(await readCandidateDisclosure(admin, old)).toEqual(expect.objectContaining({ disclosed: false }));
  const source = await subjectSource(pool, routeKey).read(partitionOf(routeOf(subject)!), [subject]);
  expect(JSON.stringify(source.subjects)).not.toContain(old.payload);
  const replacement = await proposal(subject);
  await accept(replacement);
  await adopt(replacement, head);
  setNow(new Date(deletedAt + 29 * day));
  status(await call('POST', `${path(old)}:restoreDeleted`, 'stranger', {}), 403);
  status(await call('POST', `${path(old)}:restoreDeleted`, 'owner', {}), 200);
  const shown = JSON.stringify(await current(subject));
  expect(shown).toContain(replacement.payload);
  expect(shown).not.toContain(old.payload);
  const after = await revisions(subject);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(new Set(after.map((row) => row.revision)).size).toBe(after.length);
});

test('owner restore expires at thirty days and cannot reverse current moderation', async () => {
  const record = await proposal(await person());
  const deletedAt = clock().getTime();
  status(await call('DELETE', path(record), 'owner'), 200);
  status(
    await call('POST', `${path(record)}:takedown`, 'platform', {
      notice: { complaint: 'One field', received_at: clock().toISOString(), scope: '/value' },
    }),
    200,
  );
  setNow(new Date(deletedAt + 29 * day));
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
  expect((await readCandidateDisclosure(admin, record))?.disclosed).toBe(false);
  const expired = await proposal(await person());
  status(await call('DELETE', path(expired), 'owner'), 200);
  setNow(new Date(clock().getTime() + 30 * day));
  status(await call('POST', `${path(expired)}:restoreDeleted`, 'owner', {}), 409);
});

const initializedAnchors = new Map<string, string[]>();
async function compact(count = 1) {
  const before = new Set(
    (
      await admin.query('SELECT resource_id::text FROM access.resource_initialization WHERE creator_id=$1', [
        accounts.owner,
      ])
    ).rows.map((row) => row.resource_id as string),
  );
  const payload = `https://example.test/compact/${randomUUID()}`;
  // The native limit is 32 selections per slot and 512 total compact facts.
  // One label, one statement and 510 aliases across legal language slots reach 512.
  const languages = ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'zh', 'pt', 'ru', 'ar', 'nl', 'sv', 'pl', 'fi', 'da'];
  const aliases = Object.fromEntries(
    languages.map((language, index) => [
      language,
      Array.from({ length: index === 15 ? 30 : 32 }, (_, n) => `Alias ${language} ${n}`),
    ]),
  );
  const created = await call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Person',
    labels: { en: 'Compact lifecycle' },
    ...(count === 512 ? { aliases } : {}),
    statements: { 'schema:url': [cited('schema:url', payload)] },
  });
  status(created, 201);
  const subject = created.body.subject.id as string;
  const after = (
    await admin.query('SELECT resource_id::text FROM access.resource_initialization WHERE route=$1 AND creator_id=$2', [
      routeOf(subject),
      accounts.owner,
    ])
  ).rows
    .map((row) => row.resource_id as string)
    .filter((id) => !before.has(id));
  initializedAnchors.set(subject, after);
  return { subject, candidate: created.body.subject.statements['schema:url'][0].id as string, payload };
}

async function authorRoles(subject: string) {
  // Evidence only: initialization and role writes must have come from the real producer.
  return (
    await admin.query(
      `SELECT i.resource_id::text, i.resource_type, i.creator_id::text, g.grant_role, g.valid::text
     FROM access.resource_initialization i JOIN access.resource_role_grant g
       ON g.route=i.route AND g.resource_id=i.resource_id
     WHERE i.route=$1 AND i.creator_id=$2 AND i.resource_type='semantic.revision'
       AND g.subject_id=$2 AND g.grant_role='semantic.revision.author'
       AND i.resource_id=ANY($3::uuid[])
     ORDER BY i.resource_id`,
      [routeOf(subject), accounts.owner, initializedAnchors.get(subject) ?? []],
    )
  ).rows;
}

test('native compact contribution permits only its original writer through later expansion and adoption', async () => {
  const record = await compact();
  status(await call('DELETE', path(record), 'stranger'), 403);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  const expanded = await call('POST', `/v1/subjects/${record.subject}/candidates`, 'editor', {
    statement: cited('schema:url', `https://example.test/editor/${randomUUID()}`),
  });
  status(expanded, 201);
  await accept(record);
  await adopt(record, null);
  // An expansion editor and current adopter is still not the original author.
  status(await call('DELETE', path(record), 'editor'), 403);
  status(await call('DELETE', path(record), 'owner'), 200);
  expect(JSON.stringify(await current(record.subject))).not.toContain(record.payload);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'stranger', {}), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'editor', {}), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
  expect(JSON.stringify(await current(record.subject))).toContain(record.payload);
});

test('512 compact facts create one author grant per write revision and preserve the original anchor on expansion', async () => {
  // A legal 512-fact create must fit the unchanged sixteen-resource manifest.
  const record = await compact(512);
  const facts = await admin.query(
    "SELECT count(*)::int AS n FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND operation='assert'",
    [routeOf(record.subject), record.subject],
  );
  expect(facts.rows).toEqual([{ n: 512 }]);
  expect(initializedAnchors.get(record.subject)).toHaveLength(2);
  const grants = await authorRoles(record.subject);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    resource_type: 'semantic.revision',
    creator_id: accounts.owner,
    grant_role: 'semantic.revision.author',
  });
  const anchor = grants[0]!.resource_id;
  expect(anchor).not.toBe(record.subject);
  expect(anchor).not.toBe(record.candidate);
  const count = await admin.query(
    `SELECT count(*)::int AS n FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2`,
    [routeOf(record.subject), anchor],
  );
  expect(count.rows).toEqual([{ n: 1 }]);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  const beforeExpansion = new Set(
    (
      await admin.query('SELECT resource_id::text FROM access.resource_initialization WHERE route=$1', [
        routeOf(record.subject),
      ])
    ).rows.map((row) => row.resource_id as string),
  );
  const expansion = await call('POST', `/v1/subjects/${record.subject}/candidates`, 'editor', {
    statement: cited('schema:url', `https://example.test/expand/${randomUUID()}`),
  });
  status(expansion, 201);
  const initialized = (
    await admin.query(
      'SELECT resource_id::text, resource_type, creator_id::text FROM access.resource_initialization WHERE route=$1',
      [routeOf(record.subject)],
    )
  ).rows.filter((row) => !beforeExpansion.has(row.resource_id));
  expect(initialized).toHaveLength(1);
  expect(initialized[0]).toMatchObject({ resource_type: 'semantic.revision', creator_id: accounts.editor });
  const proposalGrants = await admin.query(
    `SELECT subject_id::text, grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2`,
    [routeOf(record.subject), initialized[0]!.resource_id],
  );
  expect(proposalGrants.rows).toEqual([{ subject_id: accounts.editor, grant_role: 'semantic.revision.author' }]);
  const writeBasis = await admin.query(
    `SELECT b.principal_kind, b.principal_id::text FROM semantic.revision r
     JOIN editorial.write_basis b ON b.partition_no=$3 AND b.transaction_id=r.recorded_transaction_id
     WHERE r.route=$1 AND r.subject_id=$2 AND r.revision=2`,
    [routeOf(record.subject), record.subject, partitionOf(routeOf(record.subject)!)],
  );
  expect(writeBasis.rows).toEqual([{ principal_kind: 'account', principal_id: accounts.editor }]);
  expect(await authorRoles(record.subject)).toEqual(grants);
  const wronglyGranted = await admin.query(
    `SELECT subject_id::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND grant_role='semantic.revision.author'`,
    [routeOf(record.subject), anchor],
  );
  expect(wronglyGranted.rows).toEqual([{ subject_id: accounts.owner }]);
  status(await call('DELETE', path(record), 'editor'), 403);
  status(await call('DELETE', path(record), 'owner'), 200);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
});

test('real author role revocation denies fresh deletion and restoration and both receipt replays', async () => {
  const record = await compact();
  const grants = await authorRoles(record.subject);
  expect(grants).toHaveLength(1);
  const grant = grants[0]!;
  const resource = { route: routeOf(record.subject)!, id: grant.resource_id as string };
  // This grants only administration of the real initialized anchor; never an author role.
  await real.grant(resource, 'owner', 'access:grant');
  const deletion = `"${randomUUID()}"`;
  const restoration = `"${randomUUID()}"`;
  status(await call('DELETE', path(record), 'owner', undefined, deletion), 200);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}, restoration), 200);
  status(
    await call('POST', '/v1/roleGrants:revoke', 'owner', {
      resource,
      subject: { kind: 'account', id: accounts.owner },
      role: 'semantic.revision.author',
      valid: grant.valid,
    }),
    200,
  );
  status(await call('DELETE', path(record), 'owner'), 403);
  status(await call('DELETE', path(record), 'owner', undefined, deletion), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 403);
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}, restoration), 403);
});

test('restoration additionally requires current Global proposal permission while removal remains available', async () => {
  const record = await compact();
  const global = { route: 0, id: GLOBAL_CONTEXT };
  await real.grant(global, 'platform', 'access:grant');
  // Grant administration requires holding the action being granted or revoked.
  await real.grant(global, 'platform', 'statement:propose');
  status(
    await call('POST', '/v1/grants:revoke', 'platform', {
      resource: global,
      subjectId: accounts.owner,
      subjectRole: '',
      actions: ['statement:propose'],
      valid: '(,)',
    }),
    200,
  );
  try {
    status(await call('DELETE', path(record), 'owner'), 200);
    status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 403);
    expect(JSON.stringify(await current(record.subject))).not.toContain(record.payload);
  } finally {
    status(
      await call('POST', '/v1/grants', 'platform', {
        resource: global,
        subjectId: accounts.owner,
        subjectRole: '',
        actions: ['statement:propose'],
        valid: '(,)',
      }),
      201,
    );
  }
  status(await call('POST', `${path(record)}:restoreDeleted`, 'owner', {}), 200);
});
