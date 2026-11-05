import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import {
  collectionSelectedPublicationPlan,
  nativeReceiptBound,
  nativeWorkDimensions,
} from '../../src/library/collection-selected-publication-bounds.ts';
import { withinCeiling } from '@rezics/bounds';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';
import { COLLECTION_PUBLICATION_STEP_CEILING } from '../../src/library/collection-publication-bounds.ts';
import { NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING } from '../../src/library/native-public-output-work.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const path = (id: string) => `/v1/collections/${id}:publishSelected`;

test('selected publication declares an immutable nine-axis plan, including the full alias closure for each selection', () => {
  const empty = collectionSelectedPublicationPlan(0);
  const full = collectionSelectedPublicationPlan(100);
  expect(Object.isFrozen(empty)).toBe(true);
  expect(Object.isFrozen(full.terms.selectedBranches)).toBe(true);
  expect(empty.terms.selectedBranches.candidateKeys).toBe(0);
  expect(empty.perAttempt.nativeRows).toBeGreaterThan(0);
  expect(full.terms.selectedBranches.candidateKeys).toBeGreaterThan(100);
  expect(full.perAttempt.engineRequests).toBe(0);
  expect(withinCeiling(full.perAttempt, full.ceiling)).toBe(true);
  expect(nativeWorkDimensions(nativeReceiptBound({ reservationId: 'native', used: full.bindingWork }))).toEqual(
    full.bindingWork,
  );
  expect(() => collectionSelectedPublicationPlan(101)).toThrow();
});

async function saved() {
  const response = await f.send('POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'Explicit public selection',
    description: 'Consented public metadata',
    visibility: 'private',
    rule: { filter: { owner: { presence: true } } },
  });
  expect(response.status).toBe(201);
  return (await response.json()).collection as { id: string; revision: number };
}
async function native(id: string) {
  const keys = [routeOf(id), id];
  const collection = (
    await f.database.admin.query(
      `SELECT revision,source_generation::text,visibility FROM library.collection WHERE route=$1 AND collection_id=$2`,
      keys,
    )
  ).rows[0];
  const generations = (
    await f.database.admin.query(
      `SELECT generation::text,state,expected_members::text,written_members::text
     FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2`,
      keys,
    )
  ).rows;
  const selected =
    (
      await f.database.admin.query(
        `SELECT generation::text,source_generation::text FROM library.collection_source_output_head
     WHERE route=$1 AND collection_id=$2`,
        keys,
      )
    ).rows[0] ?? null;
  const members = selected
    ? (
        await f.database.admin.query<{ subjectId: string }>(
          `SELECT subject_id::text AS "subjectId" FROM library.collection_source_output_member
     WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id LIMIT 100`,
          [...keys, selected.generation],
        )
      ).rows.map((row) => row.subjectId)
    : null;
  return { collection, generations, selected, members };
}

test('explicit [] completes a real empty output and public metadata in one revision, never an absent-source empty', async () => {
  const collection = await saved();
  const before = await native(collection.id);
  expect(before.selected).toBeNull();
  const response = await f.send('POST', path(collection.id), { revision: collection.revision, subjectIds: [] });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.publication).toEqual({ generation: expect.any(String), state: 'complete', itemCount: 0 });
  expect(body.collection).toMatchObject({
    id: collection.id,
    membershipKind: 'dynamic',
    visibility: 'public',
    revision: collection.revision + 1,
  });
  for (const key of ['filter', 'rule', 'pins', 'notes', 'memberCount', 'createdAt', 'updatedAt', 'orderEpoch'])
    expect(body.collection).not.toHaveProperty(key);
  const after = await native(collection.id);
  expect(after.members).toEqual([]);
  expect(after.generations).toEqual([
    { generation: body.publication.generation, state: 'complete', expected_members: '0', written_members: '0' },
  ]);
  expect(after.selected).toEqual({
    generation: body.publication.generation,
    source_generation: after.collection.source_generation,
  });
  expect(BigInt(after.collection.source_generation)).toBe(BigInt(before.collection.source_generation) + 1n);
}, 120_000);

test('one selected native member publishes exactly that set and exact replay reauthorizes private leaves before receipt', async () => {
  const a = await f.subject('Selected member');
  const b = await f.subject('Unselected matching member');
  await f.entry(a);
  await f.entry(b);
  const collection = await saved();
  const input = { revision: collection.revision, subjectIds: [a] };
  const key = randomUUID();
  const first = await f.send('POST', path(collection.id), input, f.owner, key);
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  const body = await first.json();
  expect(body.publication.itemCount).toBe(1);
  const published = await native(collection.id);
  expect(published.members).toEqual([a]);
  const replay = await f.send('POST', path(collection.id), input, f.owner, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(body);
  expect(await native(collection.id)).toEqual(published);
  expect((await f.send('POST', path(collection.id), input, f.reduced, key)).status).toBe(403);
  expect((await f.send('POST', path(collection.id), input, f.other, key)).status).toBe(404);
  expect((await f.send('POST', path(collection.id), input, null, key)).status).toBe(401);
  expect((await f.send('POST', path(collection.id), { ...input, subjectIds: [b] }, f.owner, key)).status).toBe(422);
  expect((await f.send('POST', path(collection.id), input)).status).toBe(409);
  expect(await native(collection.id)).toEqual(published);
  expect(
    (await f.send('POST', `/v1/subjects/${a}:hide`, { reason: 'Current selected subject denial' }, f.manager.bearer))
      .status,
  ).toBe(200);
  const deniedReplay = await f.send('POST', path(collection.id), input, f.owner, key);
  expect(deniedReplay.status).toBe(404);
  expect(await deniedReplay.json()).toMatchObject({ code: 'not_found' });
  expect(await native(collection.id)).toEqual(published);
}, 120_000);

test('a selected nonmember denies the entire intent and cannot leak another owner or replace complete A', async () => {
  const a = await f.subject('Actual owner supporter');
  const outsider = await f.subject('Readable but absent from the owner Source');
  await f.entry(a);
  const collection = await saved();
  const first = await f.send('POST', path(collection.id), { revision: collection.revision, subjectIds: [a] });
  expect(first.status).toBe(200);
  const revision = (await first.json()).collection.revision;
  const before = await native(collection.id);
  const denied = await f.send('POST', path(collection.id), { revision, subjectIds: [a, outsider] });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toMatchObject({ code: 'not_found' });
  expect(await native(collection.id)).toEqual(before);
  const other = await f.send('POST', path(collection.id), { revision, subjectIds: [outsider] }, f.other);
  const unknown = await f.send(
    'POST',
    path(newId(routeOf(collection.id)!)),
    { revision, subjectIds: [outsider] },
    f.other,
  );
  expect(other.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect((await other.json()).code).toBe((await unknown.json()).code);
}, 120_000);

test('a real native source fence change after released preparation rolls back visibility, receipt and output', async () => {
  const a = await f.subject('Source race member');
  await f.entry(a);
  const collection = await saved();
  const before = await native(collection.id);
  const client = await f.database.admin.connect();
  const restorers: (() => void)[] = [];
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const onAcquire = (connection: PoolClient) => {
    const original = connection.query;
    connection.query = function (...args: unknown[]) {
      const query = args[0] as string | { text: string };
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.includes('curator_account_id=$3') && sql.includes('FOR UPDATE')) reached();
      return (original as (...values: unknown[]) => unknown).apply(connection, args);
    } as PoolClient['query'];
    restorers.push(() => {
      connection.query = original;
    });
  };
  let request: Promise<Response> | undefined;
  try {
    await client.query('BEGIN');
    // An uncommitted native fence is invisible to preparation but wins before the final parent lock.
    // It supplies no positive membership, identity, readiness or output facts.
    await client.query(
      'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
      [routeOf(collection.id), collection.id],
    );
    f.database.pool.on('acquire', onAcquire);
    request = f.send('POST', path(collection.id), { revision: collection.revision, subjectIds: [a] });
    await Promise.race([
      waiting,
      request.then(() => {
        throw new Error('Publication did not reach its final native source compare');
      }),
    ]);
    await client.query('COMMIT');
    const response = await request;
    expect(response.status).toBe(409);
    const after = await native(collection.id);
    expect(after.collection.visibility).toBe('private');
    expect(after.collection.revision).toBe(before.collection.revision);
    expect(after.generations).toEqual([]);
    expect(after.selected).toBeNull();
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (request) await request;
    f.database.pool.off('acquire', onAcquire);
    for (const restore of restorers.reverse()) restore();
  }
}, 120_000);

test('two completed generations retain exact custody and a third refuses without replacing B', async () => {
  const a = await f.subject('Retained selection A');
  const b = await f.subject('Retained selection B');
  await f.entry(a);
  await f.entry(b);
  const collection = await saved();
  let revision = collection.revision;
  const generations: string[] = [];
  for (const subjectIds of [[a], [b]]) {
    const response = await f.send('POST', path(collection.id), { revision, subjectIds });
    expect(response.status).toBe(200);
    const body = await response.json();
    revision = body.collection.revision;
    generations.push(body.publication.generation);
  }
  const before = await native(collection.id);
  expect(before.generations.map((row) => row.generation).sort()).toEqual(generations.sort());
  expect(before.members).toEqual([b]);
  const third = await f.send('POST', path(collection.id), { revision, subjectIds: [] });
  expect(third.status).toBe(503);
  expect(await third.json()).toMatchObject({ code: 'dependency_unavailable' });
  expect(await native(collection.id)).toEqual(before);
}, 120_000);

test('A real owner prepares and republishes an explicit selection after public activation while existing complete public output remains separately authoritative', async () => {
  const a = await f.subject('Published selection A');
  await f.entry(a);
  const collection = await saved();
  const first = await f.send('POST', path(collection.id), { revision: collection.revision, subjectIds: [a] });
  expect(first.status).toBe(200);
  const outputA = await first.json();
  const before = await native(collection.id);

  // This ordinary private write occurs AFTER activation. A cannot certify its private membership.
  const b = await f.subject('New private working selection B');
  await f.entry(b);
  expect(await native(collection.id)).toEqual(before);
  const query = new URLSearchParams({ filter: JSON.stringify({ owner: { presence: true } }), sort: 'id' });
  const working = await f.send('GET', `/v1/collections/${collection.id}/members?${query}`);
  expect(working.status).toBe(200);
  const page = await working.json();
  expect(page.members.map((row: { subjectId: string }) => row.subjectId)).toContain(b);
  expect(await native(collection.id)).toEqual(before);
  const scopes = await f.database.admin.query<{ scope: string; account: string; generation: string; capture: string }>(
    `SELECT identity->>'scope' AS scope,identity->>'accountId' AS account,
            identity->>'generation' AS generation,capture_id::text AS capture
     FROM library.canonical_source_scope
     WHERE route=$1 AND collection_id=$2 AND identity->>'generation'=$3 AND capture_id IS NOT NULL`,
    [routeOf(collection.id), collection.id, before.collection.source_generation],
  );
  expect(scopes.rows).toEqual([
    {
      scope: 'private_builtin',
      account: f.runtime.identity.ordinary.accountId,
      generation: before.collection.source_generation,
      capture: expect.any(String),
    },
  ]);
  expect((await f.send('GET', `/v1/collections/${collection.id}/members?${query}`, undefined, f.other)).status).toBe(
    422,
  );
  expect(await native(collection.id)).toEqual(before);

  // The CAS is observed from the actual ordinary response, never manufactured from a generation.
  const detail = await f.send('GET', `/v1/collections/${collection.id}`);
  expect(detail.status).toBe(200);
  const revision = (await detail.json()).collection.revision;
  const second = await f.send('POST', path(collection.id), { revision, subjectIds: [b] });
  expect(second.status).toBe(200);
  const outputB = await second.json();
  const after = await native(collection.id);
  expect(after.members).toEqual([b]);
  expect(after.selected.generation).toBe(outputB.publication.generation);
  expect(after.generations).toContainEqual({
    generation: outputA.publication.generation,
    state: 'complete',
    expected_members: '1',
    written_members: '1',
  });
  const retainedA = await f.database.admin.query<{ subject: string }>(
    `SELECT subject_id::text AS subject FROM library.collection_source_output_member
     WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id`,
    [routeOf(collection.id), collection.id, outputA.publication.generation],
  );
  expect(retainedA.rows).toEqual([{ subject: a }]);
}, 120_000);

test('closed explicit intent rejects omission, duplicates and manufactured proof; curated and logical builtins stay unsupported', async () => {
  const collection = await f.collection({}, f.owner);
  const id = await f.subject('Raw native input');
  for (const input of [
    { revision: collection.revision },
    { revision: collection.revision, subjectIds: [id, id] },
    { revision: collection.revision, subjectIds: [], count: 0 },
    { revision: collection.revision, subjectIds: [], epoch: 'known' },
    { revision: collection.revision, subjectIds: [randomUUID()] },
    { revision: collection.revision, subjectIds: Array.from({ length: 101 }, () => newId(1)) },
  ])
    expect((await f.send('POST', path(collection.id), input)).status).toBe(400);
  const input = { revision: 1, subjectIds: [] };
  expect((await f.send('POST', path(collection.id), input)).status).toBe(404);
  const builtin = builtinCollectionId(f.runtime.identity.ordinary.accountId, { kind: 'everything' });
  expect((await f.send('POST', path(builtin), input)).status).toBe(404);
}, 120_000);

test('selected-publication command bounds stay distinct from the activated public output original command', () => {
  expect(NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING().engineRequests).toBe(0);
  expect(NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING().nativeRows).not.toBe(COLLECTION_PUBLICATION_STEP_CEILING().nativeRows);
  expect(NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING().bytes).toBeLessThan(COLLECTION_PUBLICATION_STEP_CEILING().bytes);
});

test('a saved selection retains its accepted release through fresh publication and exact receipt replay after activation changes', async () => {
  const subject = await f.subject('Accepted saved meaning');
  await f.entry(subject);
  const collection = await saved();
  await f.page(collection.id);
  const original = await (await f.send('GET', '/v1/definitions/active')).json();
  const release = structuredClone(bundledRelease);
  release.catalogue.version = '999.0.1';
  const digest = releaseDigest(release);
  await f.grant(f.manager.accountId, ['definitions:publish', 'definitions:activate']);
  expect((await f.send('POST', '/v1/definitions/releases', { release }, f.manager.bearer)).status).toBe(201);
  const activated = await f.send(
    'POST',
    `/v1/definitions/releases/${digest}:activate`,
    {
      expected_head: original.head,
    },
    f.manager.bearer,
  );
  expect(activated.status).toBe(200);
  try {
    const input = { revision: collection.revision, subjectIds: [subject] };
    const key = randomUUID();
    const published = await f.send('POST', path(collection.id), input, f.owner, key);
    expect(published.status).toBe(200);
    const receipt = await published.json();
    const beforeReplay = await native(collection.id);
    const replay = await f.send('POST', path(collection.id), input, f.owner, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(await native(collection.id)).toEqual(beforeReplay);
    expect(beforeReplay.members).toEqual([subject]);
    expect((await f.send('POST', path(collection.id), input, f.reduced, key)).status).toBe(403);
  } finally {
    expect(
      (
        await f.send(
          'POST',
          `/v1/definitions/releases/${original.digest}:activate`,
          {
            expected_head: (await activated.json()).head,
          },
          f.manager.bearer,
        )
      ).status,
    ).toBe(200);
  }
}, 120_000);
