import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { principalCommandIdentity, type CommandTransaction, runCommand } from '../../src/command/command.ts';
import {
  beginCollectionSourceOutput,
  appendCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { cookies, password } from '../access/native-account-bindings-fixture.ts';
import { registerTestClient } from '../support/test-kernel.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';

let f: Awaited<ReturnType<typeof createOwnedErasureFixture>>;
beforeAll(async () => {
  f = await createOwnedErasureFixture();
  const clientId = crypto.randomUUID();
  const scopes = [
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
    'library_entry:read',
    'library_entry:update',
    'progress_session:read',
    'copy:read',
    'account:manage',
  ];
  await registerTestClient(f.auth.host.service, { clientId, firstParty: true, scopes });
  for (const person of [f.people.alice, f.people.bob]) {
    const signed = await f.auth.request('/signin', {
      account_id: person.accountId,
      password,
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const issued = await f.auth.request('/token', {}, cookies(signed));
    expect(issued.status).toBe(200);
    person.bearer = (await issued.json()).access_token;
  }
}, 360000);
afterAll(async () => {
  await f?.close();
});
const rule = { filter: { owner: { presence: true } }, sort: 'id' };
async function saved(as = f.people.bob) {
  return (
    await f.json(as, 'POST', '/v1/collections', 201, {
      title: 'Saved historic meaning',
      membershipKind: 'dynamic',
      visibility: 'private',
      rule,
    })
  ).collection;
}

test('ordinary saved Collection Undo keeps its actual identity and exact stored meaning under CAS and the record window', async () => {
  const as = f.people.bob,
    collection = await saved(as);
  const path = `/v1/collections/${collection.id}`;
  const before = await f.json(as, 'GET', `${path}/rule`, 200);
  const deleted = await f.request(as, 'DELETE', `${path}?revision=${collection.revision}`);
  expect(deleted.status).toBe(204);
  const undo = {
    deletionId: deleted.headers.get('Library-Collection-Deletion-Id'),
    revision: Number(deleted.headers.get('Library-Collection-Deletion-Revision')),
  };
  expect((await f.request(as, 'GET', path)).status).toBe(404);
  expect((await f.request(as, 'POST', `${path}:restore`, { ...undo, revision: undo.revision + 1 })).status).toBe(409);
  expect((await f.json(as, 'POST', `${path}:restore`, 200, undo)).collection.id).toBe(collection.id);
  const after = await f.json(as, 'GET', `${path}/rule`, 200);
  expect(after.rule).toEqual({ ...before.rule, collectionRevision: 3, sourceGeneration: '3' });
  const again = await f.request(as, 'DELETE', `${path}?revision=${undo.revision + 1}`);
  expect(again.status).toBe(204);
  expect((await f.request(as, 'POST', `${path}:restore`, undo)).status).toBe(409);
  await f.db.admin.query(
    `UPDATE library.collection SET deleted_at=now()-interval '720 hours',
    purge_after=now() WHERE route=$1 AND collection_id=$2`,
    [routeOf(collection.id), collection.id],
  );
  expect(
    (
      await f.request(as, 'POST', `${path}:restore`, {
        deletionId: again.headers.get('Library-Collection-Deletion-Id'),
        revision: Number(again.headers.get('Library-Collection-Deletion-Revision')),
      })
    ).status,
  ).toBe(409);
}, 120000);

test('terminal saved views retain only completed public A; pending B, private and unpublished views cannot resurrect', async () => {
  const as = f.people.alice,
    collection = await saved(as),
    privateView = await saved(as);
  const subjectId = await f.subject();
  const route = routeOf(collection.id)!,
    a = { route, collectionId: collection.id, generation: newId(route) };
  const actor = await f.kernel.testAccess.authenticate(as.bearer, { pool: f.db.pool, deadline: Date.now() + 30000 });
  const output = async (body: (tx: CommandTransaction) => Promise<void>, input: unknown, key = crypto.randomUUID()) => {
    const deadline = Date.now() + 30000;
    const authorization = resourceAuthorization({
      access: f.kernel.testAccess,
      actor,
      action: 'collection:update',
      anchor: {
        resource: { route, id: collection.id },
        async validate(client) {
          return (
            (
              await client.query(
                "SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active'",
                [route, collection.id],
              )
            ).rows.length === 1
          );
        },
      },
      context: { pool: f.db.pool, partition: partitionOf(route), deadline },
    });
    return runCommand(
      f.db.pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(route),
        deadline,
        authorization,
        receipt: {
          kind: 'library.collection.explicit-output',
          key,
          digest: createHash('sha256').update(JSON.stringify(input)).digest(),
        },
      },
      async (tx) => {
        await body(tx);
        return {
          value: null,
          events: [{ type: 'com.rezics.library.collection.updated.v1', data: { collectionId: collection.id } }],
        };
      },
    );
  };
  // The native producer commits actual A and its Core publication proof. Private
  // evaluation/preparation is a different owner and is not fabricated at erasure T.
  await output(async (tx) => {
    await tx.query(
      `UPDATE library.collection SET visibility='public',revision=revision+1 WHERE route=$1 AND collection_id=$2`,
      [route, collection.id],
    );
    await beginCollectionSourceOutput(tx, { ...a, expectedMembers: 1 });
    await appendCollectionSourceOutput(tx, { ...a, after: null, subjectIds: [subjectId] });
    await completeCollectionSourceOutput(tx, a);
  }, a);
  const generation = newId(route);
  const b = { route, collectionId: collection.id, generation, expectedMembers: 1 };
  const bKey = crypto.randomUUID();
  const writeB = () => output((tx) => beginCollectionSourceOutput(tx, b), b, bKey);
  await writeB();
  await deletePersona(f.options, as);
  expect((await f.request(null, 'GET', `/v1/collections/${privateView.id}`)).status).toBe(404);
  expect((await f.json(null, 'GET', `/v1/collections/${collection.id}`, 200)).collection.curatorAccountId).toBeNull();
  await expect(writeB()).rejects.toThrow();
  for (const id of [collection.id, privateView.id]) {
    let done = false;
    for (let ordinal = 0; ordinal < 50; ordinal++) {
      const page = await purgeOwnedGraphPage(f.db.pool, {
        accountId: as.accountId,
        kind: 'collectionLocal',
        parent: id,
        after: null,
        ordinal,
        segment: id === collection.id ? 0 : 1,
      });
      expect(page.blocked).toBe(false);
      expect(page.removed).toBeLessThanOrEqual(100);
      if (page.collectionDone) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
  }
  expect(
    (
      await f.db.admin.query(
        `SELECT generation::text,account_id FROM library.collection_source_output
    WHERE route=$1 AND collection_id=$2`,
        [route, collection.id],
      )
    ).rows,
  ).toEqual([{ generation: a.generation, account_id: null }]);
  expect(
    (
      await f.db.admin.query(
        `SELECT subject_id FROM library.collection_source_output_member
    WHERE route=$1 AND collection_id=$2`,
        [route, collection.id],
      )
    ).rows,
  ).toEqual([{ subject_id: subjectId }]);
  expect(
    (
      await f.db.admin.query(
        `SELECT curator_account_id,rule_filter FROM library.collection
    WHERE route=$1 AND collection_id=$2`,
        [route, collection.id],
      )
    ).rows,
  ).toEqual([{ curator_account_id: null, rule_filter: null }]);
  expect((await f.request(null, 'GET', `/v1/collections/${privateView.id}`)).status).toBe(404);
  await expect(writeB()).rejects.toThrow();
  expect((await f.json(null, 'GET', `/v1/collections/${collection.id}`, 200)).collection.id).toBe(collection.id);
}, 120000);
