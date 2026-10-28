import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EXTENSION_FORMAT, termPrefix } from '@rezics/definitions/extension';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);

const { admin, accounts, clock, real, call, status, person, proposal, path, setNow } = fixture;
const day = 86_400_000;

test('community Context deletion uses its real owner and restores the same identity', async () => {
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Owned editorial context' } });
  status(created, 201);
  const id = created.body.context.id;
  status(await call('DELETE', `/v1/contexts/${id}`, 'stranger'), 403);
  status(await call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  status(await call('GET', `/v1/contexts/${id}`), 404);
  status(await call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 200);
  expect((await call('GET', `/v1/contexts/${id}`)).body.context.id).toBe(id);
  // Neither the seeded authority nor a communal subject becomes creator-private data.
  status(await call('DELETE', `/v1/contexts/${GLOBAL_CONTEXT}`, 'owner'), 403);
});

test('deleted community Context cannot disclose its adopted overlay while consumers pause', async () => {
  const record = await proposal(await person());
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Overlay lifecycle' } });
  status(created, 201);
  const context = created.body.context.id;
  status(await call('POST', `${path(record)}:accept`, 'owner', { context, expected_head: null }), 200);
  status(
    await call('POST', `/v1/subjects/${record.subject}:adopt`, 'owner', {
      context,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: record.candidate, rank: 'normal' }],
      expected_head: null,
    }),
    200,
  );
  const read = () => call('GET', `/v1/subjects/${record.subject}?context=${context}`, 'owner');
  expect(JSON.stringify((await read()).body)).toContain(record.payload);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  const withheld = await read();
  status(withheld, 404);
  expect(JSON.stringify(withheld.body)).not.toContain(record.payload);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  expect(JSON.stringify((await read()).body)).toContain(record.payload);
});

async function ownerRole(context: string) {
  const rows = await admin.query(
    `SELECT valid::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='semantic.context.owner'`,
    [routeOf(context), context, accounts.owner],
  );
  expect(rows.rows).toHaveLength(1);
  return {
    resource: { route: routeOf(context)!, id: context },
    subject: { kind: 'account', id: accounts.owner },
    role: 'semantic.context.owner',
    valid: rows.rows[0].valid as string,
  };
}

test('current Context owner role controls fresh commands and replay after transfer and revocation', async () => {
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Transferable lifecycle' } });
  status(created, 201);
  const context = created.body.context.id;
  const role = await ownerRole(context);
  const deletionKey = `"${randomUUID()}"`;
  const restorationKey = `"${randomUUID()}"`;
  status(await call('DELETE', `/v1/contexts/${context}`, 'stranger'), 403);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, deletionKey), 200);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}, restorationKey), 200);
  // Transfer the real existing owner role before removing the creator's grant.
  const transferred = { ...role, subject: { kind: 'account', id: accounts.editor } };
  status(await call('POST', '/v1/roleGrants', 'owner', transferred), 201);
  status(await call('POST', '/v1/roleGrants:revoke', 'owner', role), 200);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 403);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, deletionKey), 403);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 403);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}, restorationKey), 403);
  status(await call('DELETE', `/v1/contexts/${context}`, 'editor'), 200);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'editor', {}), 200);
  status(await call('POST', '/v1/roleGrants:revoke', 'editor', transferred), 200);
  status(await call('DELETE', `/v1/contexts/${context}`, 'editor'), 403);
  // The creator still holds the real Global context:create parent grant.
  status(await call('DELETE', `/v1/contexts/${GLOBAL_CONTEXT}`, 'owner'), 403);
});

// Every normal Context-sensitive point is checked after warming both extension and composed caches.
function readPaths(context: string, subject: string) {
  return [
    `/v1/contexts/${context}`,
    `/v1/contexts/${context}/definitions`,
    `/v1/subjects/${subject}?context=${context}`,
    `/v1/subjects/${subject}/candidates?property=schema%3Aurl&context=${context}`,
    `/v1/subjects/${subject}/relations?property=schema%3Aauthor&context=${context}`,
    `/v1/subjects/${subject}/links?property=schema%3Aauthor&context=${context}`,
  ];
}

async function configuredContext() {
  for (const action of ['definitions:publish', 'definitions:activate', 'definitions:read'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
  const active = await call('GET', '/v1/definitions/active', 'owner');
  status(active, 200);
  const loaded = await call('GET', `/v1/definitions/releases/${active.body.digest}`, 'owner');
  status(loaded, 200);
  const release = structuredClone(loaded.body.release);
  release.contexts = { lifecycle: { labels: { en: 'Lifecycle defaults' }, defaults: { 'schema:url': 'suppress' } } };
  const published = await call('POST', '/v1/definitions/releases', 'owner', { release });
  expect([200, 201]).toContain(published.status);
  status(
    await call('POST', `/v1/definitions/releases/${published.body.digest}:activate`, 'owner', {
      expected_head: active.body.head,
    }),
    200,
  );
  const created = await call('POST', '/v1/contexts', 'owner', {
    labels: { en: 'Settings and extensions' },
    settings: 'lifecycle',
  });
  status(created, 201);
  const context = created.body.context.id as string;
  const resource = { route: routeOf(context)!, id: context };
  for (const action of ['definitions:publish', 'definitions:activate']) await real.grant(resource, 'owner', action);
  const extension = {
    format: EXTENSION_FORMAT,
    context,
    terms: {
      [`${termPrefix(context)}:related`]: {
        description: { en: 'A lifecycle relation' },
        labels: { en: 'related to' },
        domain: ['schema:Person'],
        targets: ['schema:Person'],
        multivalued: true,
        relation: { group: 'association', inverse: 'none' },
      },
    },
  };
  const added = await call('POST', `/v1/contexts/${context}/definitions/extensions`, 'owner', { extension });
  status(added, 201);
  status(
    await call('POST', `/v1/contexts/${context}/definitions/extensions/${added.body.digest}:activate`, 'owner', {
      expected_head: null,
    }),
    200,
  );
  return { context, snapshot: created.body.context, extension, digest: added.body.digest };
}

test('Context settings and extension reads and writes respect deletion, restoration and the strict deadline', async () => {
  const { context, snapshot, extension, digest } = await configuredContext();
  const subject = await person();
  const selected = await proposal(subject);
  await fixture.accept(selected);
  await fixture.adopt(selected, null);
  const paths = readPaths(context, subject);
  for (const path of paths) status(await call('GET', path, 'owner'), 200);
  expect(snapshot.defaults).toEqual({ 'schema:url': 'suppress' });
  const suppressed = await call('GET', `/v1/subjects/${subject}?context=${context}`, 'owner');
  expect(suppressed.body.subject.resolution).toEqual({ 'schema:url': 'suppressed' });
  expect(JSON.stringify(suppressed.body)).not.toContain(selected.payload);
  const definitions = (await call('GET', `/v1/contexts/${context}/definitions`, 'owner')).body;
  expect(definitions).toMatchObject({ context, digest, head: 1, extension });
  // Neither the warmed composed release nor the extension is a published Global release.
  const privateReleases = [digest, suppressed.body.subject.release].map((id) => `/v1/definitions/releases/${id}`);
  expect(suppressed.body.subject.release).not.toBe(snapshot.settings.release);
  for (const path of privateReleases) status(await call('GET', path, 'owner'), 404);
  const deletedAt = clock().getTime();
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  for (const path of paths) status(await call('GET', path, 'owner'), 404);
  for (const path of privateReleases) status(await call('GET', path, 'owner'), 404);
  status(await call('POST', `/v1/contexts/${context}/definitions/extensions`, 'owner', { extension }), 404);
  status(
    await call('POST', `/v1/contexts/${context}/definitions/extensions/${digest}:activate`, 'owner', {
      expected_head: 1,
    }),
    404,
  );
  setNow(new Date(deletedAt + 30 * day - 1));
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  for (const path of paths) status(await call('GET', path, 'owner'), 200);
  for (const path of privateReleases) status(await call('GET', path, 'owner'), 404);
  expect((await call('GET', `/v1/contexts/${context}`, 'owner')).body.context).toEqual(snapshot);
  expect((await call('GET', `/v1/subjects/${subject}?context=${context}`, 'owner')).body).toEqual(suppressed.body);
  expect((await call('GET', `/v1/contexts/${context}/definitions`, 'owner')).body).toEqual(definitions);
  status(await call('POST', `/v1/contexts/${context}/definitions/extensions`, 'owner', { extension }), 200);
  status(
    await call('POST', `/v1/contexts/${context}/definitions/extensions/${digest}:activate`, 'owner', {
      expected_head: 1,
    }),
    200,
  );
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  setNow(new Date(clock().getTime() + 30 * day));
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 409);
  for (const path of paths) status(await call('GET', path, 'owner'), 404);
  for (const path of privateReleases) status(await call('GET', path, 'owner'), 404);
  status(await call('POST', `/v1/contexts/${context}/definitions/extensions`, 'owner', { extension }), 404);
  status(
    await call('POST', `/v1/contexts/${context}/definitions/extensions/${digest}:activate`, 'owner', {
      expected_head: 2,
    }),
    404,
  );
});

test('Context restoration preserves current adoption, subject visibility and candidate moderation', async () => {
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Current withholding' } });
  status(created, 201);
  const context = created.body.context.id;
  const record = await proposal(await person());
  status(await call('POST', `${path(record)}:accept`, 'owner', { context, expected_head: null }), 200);
  const adoption = await call('POST', `/v1/subjects/${record.subject}:adopt`, 'owner', {
    context,
    property: 'schema:url',
    mode: 'replace',
    selection: [{ candidate: record.candidate, rank: 'normal' }],
    expected_head: null,
  });
  status(adoption, 200);
  const replaced = await proposal(record.subject);
  status(await call('POST', `${path(replaced)}:accept`, 'owner', { context, expected_head: null }), 200);
  status(
    await call('POST', `/v1/subjects/${record.subject}:adopt`, 'owner', {
      context,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: replaced.candidate, rank: 'normal' }],
      expected_head: adoption.body.adoption.head,
    }),
    200,
  );
  const decisions = async () =>
    (
      await admin.query(
        `SELECT head, mode, selection, revision FROM semantic.adoption
     WHERE route=$1 AND subject_id=$2 AND context_id=$3 ORDER BY head`,
        [routeOf(record.subject), record.subject, context],
      )
    ).rows;
  const priorDecisions = await decisions();
  const before = await fixture.revisions(record.subject);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  status(
    await call('POST', `${path(replaced)}:takedown`, 'platform', {
      notice: { complaint: 'Retain current moderation', received_at: clock().toISOString() },
    }),
    200,
  );
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  const view = await call('GET', `/v1/subjects/${record.subject}?context=${context}`, 'owner');
  status(view, 200);
  expect(JSON.stringify(view.body)).not.toContain(record.payload);
  expect(JSON.stringify(view.body)).not.toContain(replaced.payload);
  expect(await decisions()).toEqual(priorDecisions);
  const after = await fixture.revisions(record.subject);
  expect(after.slice(0, before.length)).toEqual(before);
  // Restoring the Context cannot restore a taken-down subject either.
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  status(
    await call('POST', `/v1/subjects/${record.subject}:takedown`, 'platform', {
      notice: { complaint: 'Subject remains unavailable', received_at: clock().toISOString() },
    }),
    200,
  );
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  status(await call('GET', `/v1/subjects/${record.subject}?context=${context}`, 'owner'), 404);
  expect(await decisions()).toEqual(priorDecisions);
});
