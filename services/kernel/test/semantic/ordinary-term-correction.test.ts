import { revisionResource } from '../../src/semantic/authorship.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createDeletionFixture } from './support/deletion-fixture.ts';
import { accountAgentId, ensureAccountAgent } from '../../src/semantic/index.ts';
import { newId } from '../../src/route/route.ts';
import { patchTerms, termRevision } from '../../src/semantic/terms.ts';
import { readSemanticRecordSourceSet } from '../../src/semantic/record-source-set.ts';

const f = await createDeletionFixture();
beforeAll(f.setup);
afterAll(f.close);

async function patch(
  subject: string,
  revision: number,
  body: unknown,
  key = `"${randomUUID()}"`,
  persona: 'owner' | 'stranger' = 'owner',
) {
  const response = await f.kernel.handle(
    new Request(`http://kernel.test/v1/subjects/${subject}/terms`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await f.bearer(f.accounts[persona], f.actions)}`,
        'content-type': 'application/json',
        'idempotency-key': key,
        'if-match': `"${revision}"`,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('term patch omission, null and alias replacement reuse native validation and strong revision syntax', () => {
  const current = { labels: { en: 'Book', ja: '本' }, descriptions: { en: 'Description' }, aliases: { en: ['Old'] } };
  const result = patchTerms(current, { labels: { ja: null, fr: 'Livre' }, aliases: { en: ['New'] } });
  expect(result.terms).toEqual({
    labels: { en: 'Book', fr: 'Livre' },
    descriptions: current.descriptions,
    aliases: { en: ['New'] },
  });
  expect(current.labels.ja).toBe('本');
  expect(() => patchTerms(current, { labels: { en: null, ja: null } })).toThrow();
  expect(() => patchTerms(current, { descriptions: { INVALID: null } })).toThrow();
  expect(() => patchTerms(current, { aliases: { en: ['Duplicate', 'Duplicate'] } })).toThrow();
  expect(() => patchTerms(current, { type: 'schema:Person' })).toThrow();
  for (const tag of [undefined, '*', '1', 'W/"1"', '"1", "2"', '"0"', '"2147483648"'])
    expect(() => termRevision(tag)).toThrow();
  expect(termRevision('"12"')).toBe(12);
});

test('Ordinary multilingual term correction and safe change explanation connect the catalogue editor back to the real reader', async () => {
  const created = await f.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Book', ja: '本' },
    descriptions: { en: 'Description' },
    aliases: { en: ['Old'] },
  });
  f.status(created, 201);
  const subject = created.body.subject.id as string;
  const key = `"${randomUUID()}"`;
  const body = { labels: { ja: null, fr: 'Livre' }, aliases: { en: ['New', 'Another'] } };
  const changed = await patch(subject, 1, body, key);
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body).toEqual({ subject, revision: 2 });
  expect(changed.headers.get('etag')).toBe('"2"');
  expect(changed.headers.get('rezics-session-token')).toBeTruthy();
  await f.caughtUp(subject);
  const current = await f.current(subject);
  expect(current).toMatchObject({
    revision: 2,
    type: 'schema:Book',
    labels: { en: 'Book', fr: 'Livre' },
    descriptions: { en: 'Description' },
    aliases: { en: ['New', 'Another'] },
  });
  expect(current.labels).not.toHaveProperty('ja');
  expect((await patch(subject, 1, { descriptions: { en: null } })).status).toBe(412);
  expect((await patch(subject, 2, {})).body).toEqual({ subject, revision: 2 });
  expect((await patch(subject, 2, { descriptions: { en: null } })).body).toEqual({ subject, revision: 3 });
  const replay = await patch(subject, 1, body, key);
  expect([replay.status, replay.body]).toEqual([200, { subject, revision: 2 }]);
  expect((await patch(subject, 1, { labels: { en: 'Conflict' } }, key)).status).toBe(422);
  await f.caughtUp(subject);
  expect((await f.current(subject)).revision).toBe(3);
  const detail = await f.call('GET', `/v1/subjects/${subject}/revisions/2`, 'owner');
  f.status(detail, 200);
  expect(detail.body.change).toEqual({
    kind: 'terms',
    fields: [
      { field: 'labels', languages: ['fr', 'ja'] },
      { field: 'aliases', languages: ['en'] },
    ],
  });
});

test('term correction conceals nonvisible subjects, rejects derived Account terms and reauthorizes replay', async () => {
  const subject = await f.person();
  const key = `"${randomUUID()}"`;
  const body = { labels: { en: 'Corrected' } };
  expect((await patch(subject, 1, body, key)).status).toBe(200);
  expect((await patch(subject, 2, body, undefined, 'stranger')).status).toBe(403);
  await ensureAccountAgent(f.pool, { account: f.accounts.owner, kind: 'person', name: 'Account name' });
  expect(
    (await patch(accountAgentId(f.accounts.owner), 1, { descriptions: { en: 'Not ordinary terms' } })).status,
  ).toBe(403);
  const hidden = await f.call('POST', `/v1/subjects/${subject}:takedown`, 'platform', {
    notice: { complaint: 'Subject removal', received_at: f.clock().toISOString(), scope: '/' },
  });
  f.status(hidden, 200);
  expect((await patch(subject, 1, body, key)).status).toBe(404);
  expect((await patch(newId(21000), 1, body)).status).toBe(404);
});

test('The real terms PATCH command updates multilingual current terms and safe revision explanation atomically with native authorship and publication while preserving current permission provenance and replay', async () => {
  const subject = await f.person();
  const key = `"${randomUUID()}"`;
  const body = {
    labels: { en: 'A correction', fr: 'Correction' },
    descriptions: { fr: 'Description' },
    aliases: { fr: ['Alias'] },
  };
  const changed = await patch(subject, 1, body, key);
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body).toEqual({ subject, revision: 2 });
  const route = routeOf(subject)!;
  const anchor = revisionResource(subject, 2);
  const authorship = await f.admin.query(
    `SELECT i.creator_id::text,g.subject_id::text,g.grant_role FROM access.resource_initialization i
     JOIN access.resource_role_grant g USING(route,resource_id) WHERE i.route=$1 AND i.resource_id=$2`,
    [route, anchor.id],
  );
  expect(authorship.rows).toEqual([
    { creator_id: f.accounts.owner, subject_id: f.accounts.owner, grant_role: 'semantic.revision.author' },
  ]);
  const points = () =>
    f.admin.query(
      `SELECT r.revision,r.kind,r.term_changes,
       (SELECT count(*)::int FROM semantic.subject_page_change c WHERE c.route=r.route AND c.subject_id=r.subject_id
        AND c.change_id=r.recorded_transaction_id::text) AS published
     FROM semantic.revision r WHERE r.route=$1 AND r.subject_id=$2 ORDER BY revision`,
      [route, subject],
    );
  const before = (await points()).rows;
  expect(before[1]).toMatchObject({ revision: 2, kind: 'terms', published: 2 });
  const detail = await f.call('GET', `/v1/subjects/${subject}/revisions/2`, 'owner');
  f.status(detail, 200);
  expect(detail.body.change).toEqual({ kind: 'terms', fields: before[1]!.term_changes });
  expect(JSON.stringify(detail.body)).not.toContain('A correction');
  await f.caughtUp(subject);
  expect(await f.current(subject)).toMatchObject({
    revision: 2,
    labels: { en: 'A correction', fr: 'Correction' },
    aliases: { fr: ['Alias'] },
  });
  expect((await patch(subject, 2, { aliases: { de: [] } })).body).toEqual({ subject, revision: 2 });
  expect((await patch(subject, 2, { labels: { en: null, fr: null } })).status).toBe(400);
  expect((await points()).rows).toEqual(before);
  expect((await patch(subject, 1, body, key)).body).toEqual(changed.body);
  expect((await points()).rows).toEqual(before);
  await f.real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  try {
    expect((await patch(subject, 1, body, key)).status).toBe(403);
    expect((await patch(subject, 2, body)).status).toBe(403);
    expect((await points()).rows).toEqual(before);
  } finally {
    await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'statement:propose');
  }
});

async function termSourceSets(subject: string) {
  return (
    await f.admin.query(
      `SELECT r.revision AS subject_revision,r.recorded_transaction_id::text,
        s.partition_no,s.transaction_id::text,s.revision,s.sealed,s.digest,s.members
       FROM semantic.revision r JOIN semantic.record_source_set s
         ON s.partition_no=r.route/16 AND s.transaction_id=r.recorded_transaction_id
       WHERE r.route=$1 AND r.subject_id=$2 ORDER BY r.revision`,
      [routeOf(subject), subject],
    )
  ).rows;
}

async function termSourceMembers(subject: string, revision: number) {
  const sets = (await termSourceSets(subject)).filter((row) => row.subject_revision === revision);
  expect(sets).toHaveLength(1);
  const set = sets[0]!;
  expect(set.transaction_id).toBe(set.recorded_transaction_id);
  expect(set.sealed).toBe(true);
  const members = (
    await f.admin.query(
      `SELECT kind,subject_id::text,candidate_id::text,document_id::text,source_revision,field,language,source_key
       FROM semantic.record_source_set_member WHERE partition_no=$1 AND transaction_id=$2 ORDER BY source_key`,
      [set.partition_no, set.transaction_id],
    )
  ).rows;
  expect(set.digest).toBe(
    createHash('sha256')
      .update(members.map((row) => row.source_key).join('\n'))
      .digest('hex'),
  );
  for (const row of members) {
    expect(row).toMatchObject({ kind: 'terms', subject_id: subject, candidate_id: null, document_id: null });
    expect(row.source_key).toBe(JSON.stringify(['terms', subject, row.source_revision, row.field, row.language]));
  }
  const locator = { partition: set.partition_no, transactionId: set.transaction_id, revision: set.revision };
  expect(await readSemanticRecordSourceSet({ pool: f.pool }, locator, { deadline: Date.now() + 30_000 })).toEqual({
    locator,
    digest: set.digest,
    members: set.members,
  });
  return { set, members: members.map(({ source_revision, field, language }) => [source_revision, field, language]) };
}

test('The mounted native terms write enrolls exact old and current field-language original sources in its one sealed command SourceSet before History serialization without changing CAS replay no-op or publication', async () => {
  const created = await f.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Original', ja: '元' },
    descriptions: { en: 'Unchanged' },
    aliases: { en: ['First', 'Second'] },
  });
  f.status(created, 201);
  const subject = created.body.subject.id as string;
  const key = `"${randomUUID()}"`;
  const body = { labels: { en: 'Corrected', fr: 'Livre', ja: null }, aliases: { en: ['Third', 'Fourth'] } };
  expect((await patch(subject, 1, body, key)).status).toBe(200);
  const enrolled = await termSourceMembers(subject, 2);
  expect(enrolled.set.members).toBe(4);
  // An alias array is one unit. Deletion keeps only the actual original support.
  expect(enrolled.members).toEqual([
    [1, 'aliases', 'en'],
    [1, 'labels', 'en'],
    [1, 'labels', 'ja'],
    [2, 'aliases', 'en'],
    [2, 'labels', 'en'],
    [2, 'labels', 'fr'],
  ]);
  const before = await termSourceSets(subject);
  expect((await patch(subject, 1, body, key)).body).toEqual({ subject, revision: 2 });
  expect((await patch(subject, 2, body)).body).toEqual({ subject, revision: 2 });
  expect((await patch(subject, 1, { labels: { en: 'Stale' } })).status).toBe(412);
  expect(await termSourceSets(subject)).toEqual(before);
  expect(await termSourceMembers(subject, 2)).toEqual(enrolled);
  await expect(
    f.admin.query('UPDATE semantic.record_source_set SET digest=$3 WHERE partition_no=$1 AND transaction_id=$2', [
      enrolled.set.partition_no,
      enrolled.set.transaction_id,
      '0'.repeat(64),
    ]),
  ).rejects.toThrow('Immutable Semantic record source set');
  await f.caughtUp(subject);
  expect(await f.current(subject)).toMatchObject({ revision: 2, labels: { en: 'Corrected', fr: 'Livre' } });
  const published = await f.admin.query(
    'SELECT count(*)::int n FROM semantic.subject_page_change WHERE route=$1 AND subject_id=$2 AND change_id=$3',
    [routeOf(subject), subject, enrolled.set.transaction_id],
  );
  expect(published.rows).toEqual([{ n: 3 }]);
});

test('native terms deletion and restoration retain the real original imported field support without inventing a deleted payload', async () => {
  await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:batch_write');
  const source = {
    source: 'openlibrary',
    external_id: `OL${randomUUID()}W`,
    record_revision: '1',
    digest: 'c'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  const response = await f.kernel.handle(
    new Request('http://kernel.test/v1/subjects:batchWrite', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await f.bearer(f.accounts.owner, [...f.actions, 'subject:batch_write'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commands: [
          {
            op: 'create',
            key: randomUUID(),
            source,
            subject: {
              type: 'schema:Book',
              labels: { en: 'Imported' },
              aliases: { fr: ['Import alias', 'Other alias'] },
            },
          },
        ],
      }),
    }),
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.results[0].status, JSON.stringify(result)).toBe(201);
  const subject = result.results[0].value.id as string;
  expect((await patch(subject, 1, { aliases: { fr: ['Correction'] } })).status).toBe(200);
  expect((await termSourceMembers(subject, 2)).members).toEqual([
    [1, 'aliases', 'fr'],
    [2, 'aliases', 'fr'],
  ]);
  expect((await patch(subject, 2, { aliases: { fr: null } })).status).toBe(200);
  expect((await termSourceMembers(subject, 3)).members).toEqual([[1, 'aliases', 'fr']]);
  expect((await patch(subject, 3, { aliases: { fr: ['Restored'] } })).status).toBe(200);
  expect((await termSourceMembers(subject, 4)).members).toEqual([
    [1, 'aliases', 'fr'],
    [4, 'aliases', 'fr'],
  ]);
  expect(
    (
      await f.admin.query(
        'SELECT term_support FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=4',
        [routeOf(subject), subject],
      )
    ).rows,
  ).toEqual([{ term_support: [1] }]);
});

test('a native term fact-bound failure rolls back the command SourceSet allocation with its revision and publication', async () => {
  const languages = ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'zh', 'pt', 'ru', 'ar', 'nl', 'sv', 'pl', 'fi', 'da'];
  const aliases = Object.fromEntries(
    languages.map((language, index) => [
      language,
      Array.from({ length: index === 15 ? 30 : 32 }, (_, n) => `Alias ${language} ${n}`),
    ]),
  );
  const created = await f.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Full' },
    aliases,
    statements: { 'schema:url': [f.cited('schema:url', 'https://example.test/full')] },
  });
  f.status(created, 201);
  const subject = created.body.subject.id as string;
  const before = await termSourceSets(subject);
  expect((await patch(subject, 1, { descriptions: { en: 'Exceeds the native fact cap' } })).status).toBe(400);
  expect(await termSourceSets(subject)).toEqual(before);
  expect(await f.revisions(subject)).toEqual([{ revision: 1, kind: 'create' }]);
  expect(
    (
      await f.admin.query(
        `SELECT count(*)::int n FROM semantic.record_source_set s
     WHERE s.partition_no=$1 AND NOT EXISTS (
       SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=s.partition_no AND b.transaction_id=s.transaction_id)`,
        [Math.floor(routeOf(subject)! / 16)],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
