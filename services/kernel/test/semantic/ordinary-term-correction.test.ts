import { revisionResource } from '../../src/semantic/authorship.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDeletionFixture } from './support/deletion-fixture.ts';
import { accountAgentId, ensureAccountAgent } from '../../src/semantic/index.ts';
import { newId } from '../../src/route/route.ts';
import { patchTerms, termRevision } from '../../src/semantic/terms.ts';

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
