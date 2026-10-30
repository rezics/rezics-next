import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorkClient } from '../../src/work/client.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { syncSubjectListing, subjectCollections } from '../../src/library/listing.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let time = Date.now();
const scopes = ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete'];
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(time) });
  owner = await f.identity(scopes);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill('SIGKILL');
    await child.process.exited;
  }
  await workClient?.close();
  await f?.close();
});
async function make(visibility = 'private') {
  const subjectId = await f.createSubject('game');
  const response = await f.send(owner.bearer, 'POST', '/v1/collections', { title: 'Occurrence lifecycle', visibility });
  expect(response.status).toBe(201);
  const collection = (await response.json()).collection;
  const root = `/v1/collections/${collection.id}`;
  const add = async (note = 'original note', after?: string | null) => {
    const response = await f.send(owner.bearer, 'POST', root + '/members', {
      subjectId,
      note,
      ...(after === undefined ? {} : { after }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).member;
  };
  const first = await add();
  const path = `${root}/members/${first.id}`;
  const parent = async () => {
    const response = await f.send(owner.bearer, 'GET', root);
    expect(response.status).toBe(200);
    return (await response.json()).collection;
  };
  const remove = async (bearer = owner.bearer, key = entryKey()) => {
    const revision = (await parent()).revision;
    const response = await f.send(bearer, 'DELETE', `${path}?revision=${revision}`, undefined, key);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    return {
      deletionId: response.headers.get('Library-Collection-Member-Deletion-Id')!,
      revision: Number(response.headers.get('Library-Collection-Member-Deletion-Revision')),
    };
  };
  const snapshot = async () =>
    (
      await f.pool.query(
        'SELECT to_jsonb(m) AS row FROM library.collection_member m WHERE route=$1 AND collection_id=$2 AND member_id=$3',
        [routeOf(collection.id), collection.id, first.id],
      )
    ).rows;
  return { collection, subjectId, root, path, add, first, parent, remove, snapshot };
}
async function code(response: Response, expected: string) {
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe(expected);
}
test('parent CAS precedes fresh removal; exact episode Undo tolerates unrelated sibling writes and replay never moves source generation', async () => {
  const m = await make();
  const parent = await m.parent();
  const receiptKey = entryKey();
  const removed = await m.remove(owner.bearer, receiptKey);
  const sibling = await m.add('independent sibling');
  const before = await m.snapshot();
  await code(
    await f.send(owner.bearer, 'POST', m.path + ':restore', { ...removed, revision: removed.revision + 1 }),
    'member_restore_stale',
  );
  expect(await m.snapshot()).toEqual(before);
  const key = entryKey();
  const restored = await f.send(owner.bearer, 'POST', m.path + ':restore', removed, key);
  expect(restored.status).toBe(200);
  expect((await restored.json()).member).toEqual(m.first);
  const observed = await f.pool.query(
    'SELECT source_generation,revision,member_count FROM library.collection WHERE route=$1 AND collection_id=$2',
    [routeOf(m.collection.id), m.collection.id],
  );
  const replay = await f.send(owner.bearer, 'POST', m.path + ':restore', removed, key);
  expect(replay.status).toBe(200);
  expect((await replay.json()).member).toEqual(m.first);
  const deletedReplay = await f.send(
    owner.bearer,
    'DELETE',
    `${m.path}?revision=${parent.revision}`,
    undefined,
    receiptKey,
  );
  expect(deletedReplay.status).toBe(204);
  expect(deletedReplay.headers.get('Library-Collection-Member-Deletion-Id')).toBe(removed.deletionId);
  expect(
    (
      await f.pool.query(
        'SELECT source_generation,revision,member_count FROM library.collection WHERE route=$1 AND collection_id=$2',
        [routeOf(m.collection.id), m.collection.id],
      )
    ).rows,
  ).toEqual(observed.rows);
  const page = await f.send(owner.bearer, 'GET', m.root + '/members');
  expect((await page.json()).members.map((member: { id: string }) => member.id)).toEqual([m.first.id, sibling.id]);
  await code(await f.send(owner.bearer, 'DELETE', `${m.path}?revision=${parent.revision}`), 'conflict');
});
test('native delegated editor can Undo a private occurrence; revoked authority cannot replay a retained receipt', async () => {
  const m = await make();
  const editor = await f.identity(scopes);
  const grants = createGrantCommands({
    pool: f.pool,
    access: f.access,
    managementAction: 'access:grant',
    clock: () => new Date(time),
  });
  const input = {
    resource: { route: routeOf(m.collection.id)!, id: m.collection.id },
    subject: { kind: 'account' as const, id: editor.actor.accountId },
    actions: ['collection:read', 'collection:update'],
    valid: '(,)',
  };
  const context = () => ({ actor: f.steward.actor, deadline: deadlineFor(30000) });
  await grants.create(context(), { ...input, key: entryKey() });
  const removed = await m.remove(editor.bearer);
  const key = entryKey();
  const response = await f.send(editor.bearer, 'POST', m.path + ':restore', removed, key);
  expect(response.status).toBe(200);
  expect((await response.json()).member).toEqual(m.first);
  await grants.revoke(context(), { ...input, key: entryKey() });
  const denied = await f.send(editor.bearer, 'POST', m.path + ':restore', removed, key);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('original note');
});
test('unscoped anonymous revoked and actual pre-suspension bearers cannot restore or replay', async () => {
  const m = await make('public');
  const removed = await m.remove();
  const unscoped = await f.identity(['subject:read', 'collection:read']);
  expect((await f.send(unscoped.bearer, 'POST', m.path + ':restore', removed)).status).toBe(403);
  expect((await f.send('anonymous', 'POST', m.path + ':restore', removed)).status).toBe(401);
  const suspended = await f.identity(scopes);
  await f.suspend(suspended.actor.accountId);
  const denied = await f.send(suspended.bearer, 'POST', m.path + ':restore', removed);
  expect(denied.status).toBe(401);
  expect((await denied.json()).code).toBe('invalid_credentials');
  expect(denied.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  const revoked = await f.identity(scopes);
  await f.revokeIdentity(revoked.actor.accountId);
  expect((await f.send(revoked.bearer, 'POST', m.path + ':restore', removed)).status).toBe(401);
});
test('original placement collision rolls back; deleted parents never revive through a member and the 720-hour cutoff is strict', async () => {
  const m = await make();
  const removed = await m.remove();
  const collision = await m.add('new occupant', null);
  const before = await m.snapshot();
  await code(await f.send(owner.bearer, 'POST', m.path + ':restore', removed), 'member_restore_occupied');
  expect(await m.snapshot()).toEqual(before);
  const p = await m.parent();
  expect(
    (await f.send(owner.bearer, 'DELETE', `${m.root}/members/${collision.id}?revision=${p.revision}`)).status,
  ).toBe(204);
  const deadline = (
    await f.pool.query(
      'SELECT purge_after::text AS deadline FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(m.collection.id), m.collection.id, m.first.id],
    )
  ).rows[0].deadline;
  const originalTime = time;
  time = Date.parse(deadline);
  await code(await f.send(owner.bearer, 'POST', m.path + ':restore', removed), 'member_restore_expired');
  time = originalTime;
  const parent = await m.parent();
  expect((await f.send(owner.bearer, 'DELETE', `${m.root}?revision=${parent.revision}`)).status).toBe(204);
  expect((await f.send(owner.bearer, 'POST', m.path + ':restore', removed)).status).toBe(404);
});

test('deleted parent stays deleted when an otherwise valid member episode is restored', async () => {
  const m = await make();
  const removed = await m.remove();
  const parent = await m.parent();
  expect((await f.send(owner.bearer, 'DELETE', `${m.root}?revision=${parent.revision}`)).status).toBe(204);
  const before = await m.snapshot();
  expect((await f.send(owner.bearer, 'POST', m.path + ':restore', removed)).status).toBe(404);
  expect(await m.snapshot()).toEqual(before);
});

test('restore respects the live 5000 member cap while preserving the retained episode', async () => {
  const m = await make();
  for (let n = 1; n < 5000; n++) {
    if (n % 16 === 0) {
      owner.bearer = await accountToken(owner.actor);
      owner.actor = await f.access.authenticate(owner.bearer, { pool: f.pool, deadline: deadlineFor(30000) });
    }
    await f.commands.addMember(owner.actor, m.collection.id, { subjectId: m.subjectId, note: `filler ${n}` }, entryKey());
  }
  const removed = await m.remove();
  await f.commands.addMember(owner.actor, m.collection.id, { subjectId: m.subjectId, note: 'replacement at cap' }, entryKey());
  const before = await m.snapshot();
  const response = await f.send(owner.bearer, 'POST', m.path + ':restore', removed);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('collection_full');
  expect(await m.snapshot()).toEqual(before);
}, 300000);

test('fresh Undo rechecks current native subject concealment without exposing the retained note', async () => {
  const m = await make();
  const removed = await m.remove();
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${m.subjectId}:hide`, {
    reason: 'Current occurrence subject disclosure',
  });
  expect(hidden.status).toBe(200);
  const before = await m.snapshot();
  const response = await f.send(owner.bearer, 'POST', m.path + ':restore', removed);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('original note');
  expect(await m.snapshot()).toEqual(before);
});

let workClient: Awaited<ReturnType<typeof createWorkClient>> | undefined;
const executorId = `member-retention-${crypto.randomUUID()}`;
const directory = resolve(import.meta.dir, '../../../../.temp/member-retention', executorId);
const clockPath = resolve(directory, 'clock');
const children: ReturnType<typeof runtime>[] = [];
function runtime(mode: string) {
  const process = Bun.spawn(
    [Bun.which('bun')!, `${import.meta.dir}/support/member-retention-runtime.ts`, mode, executorId, clockPath],
    { env: globalThis.process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  let output = '';
  const streams = [process.stdout, process.stderr].map(async (stream) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  });
  const child = {
    process,
    async until(marker: string) {
      const deadline = Date.now() + 120000;
      while (!output.includes(marker)) {
        if (process.exitCode !== null || Date.now() >= deadline) throw new Error(`Missing ${marker}: ${output}`);
        await Bun.sleep(20);
      }
    },
    async stop(signal: 'SIGKILL' | 'SIGTERM') {
      process.kill(signal);
      await process.exited;
      await Promise.all(streams);
    },
  };
  children.push(child);
  return child;
}
async function workerClient() {
  mkdirSync(directory, { recursive: true });
  return (workClient ??= await createWorkClient(process.env.DATABASE_URL!));
}
async function trigger() {
  const client = await workerClient();
  const schedule = await client.getSchedule('library.memberRetention.every-10-minutes');
  expect(schedule?.workflowName).toBe('library.memberRetentionSweep');
  expect(schedule?.schedule).toBe('*/10 * * * *');
  expect(schedule?.cronTimezone).toBe('UTC');
  return client.triggerSchedule('library.memberRetention.every-10-minutes');
}
async function nativeDeadline(m: Awaited<ReturnType<typeof make>>) {
  return (
    await f.pool.query(
      'SELECT purge_after::text AS deadline FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(m.collection.id), m.collection.id, m.first.id],
    )
  ).rows[0].deadline as string;
}
async function gone(m: Awaited<ReturnType<typeof make>>) {
  const deadline = Date.now() + 120000;
  while ((await m.snapshot()).length) {
    if (Date.now() >= deadline) throw new Error('Default member worker did not erase the private occurrence');
    await Bun.sleep(20);
  }
}
test('native member purge is exact episode bounded and never decrements public listing or visible counts twice', async () => {
  const m = await make();
  await m.add('surviving sibling');
  const d1 = await m.remove();
  const firstDeadline = await nativeDeadline(m);
  await workerClient();
  writeFileSync(clockPath, String(Date.parse(firstDeadline)));
  const parked = runtime('park');
  await parked.until('worker-ready');
  const sweep = await trigger();
  await parked.until('source-parked');
  // Only discovery saw the due clock. The ordinary command remains strictly before the original deadline.
  time += 1000;
  expect((await f.send(owner.bearer, 'POST', m.path + ':restore', d1)).status).toBe(200);
  const d3 = await m.remove();
  expect(d3.deletionId).not.toBe(d1.deletionId);
  const secondDeadline = await nativeDeadline(m);
  parked.process.stdin.write('deliver\n');
  await sweep.getResult({ pollingIntervalMs: 20 });
  expect((await m.snapshot())[0].row.deletion_id).toBe(d3.deletionId);
  expect((await m.parent()).memberCount).toBe(1);
  writeFileSync(clockPath, String(Date.parse(secondDeadline)));
  await (await trigger()).getResult({ pollingIntervalMs: 20 });
  await gone(m);
  expect((await m.parent()).memberCount).toBe(1);
  await parked.stop('SIGTERM');

  // Active public parents retain only structural identity when an independent child
  // expires. The surviving duplicate keeps its Collection in the public listing once.
  const publicCollection = await make('public');
  const publicSibling = await publicCollection.add('public sibling');
  const listing = { pool: f.pool, clock: () => new Date(time) };
  await syncSubjectListing(listing, {
    subjectId: publicCollection.subjectId,
    collectionId: publicCollection.collection.id,
  });
  expect(await subjectCollections(f.pool, publicCollection.subjectId, null, 10)).toEqual([
    expect.objectContaining({ collectionId: publicCollection.collection.id }),
  ]);
  const publicDeletion = await publicCollection.remove();
  const publicDeadline = await nativeDeadline(publicCollection);
  await syncSubjectListing(listing, {
    subjectId: publicCollection.subjectId,
    collectionId: publicCollection.collection.id,
  });
  expect(await subjectCollections(f.pool, publicCollection.subjectId, null, 10)).toEqual([
    expect.objectContaining({ collectionId: publicCollection.collection.id }),
  ]);
  writeFileSync(clockPath, String(Date.parse(publicDeadline)));
  await (await trigger()).getResult({ pollingIntervalMs: 20 });
  const retained = await f.pool.query(
    `SELECT route,collection_id,member_id,subject_id,note,ordinal_key,added_at,deletion_id,
            deletion_revision,deleted_at,purge_after,deleted_ordinal_key
       FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
    [routeOf(publicCollection.collection.id), publicCollection.collection.id, publicCollection.first.id],
  );
  expect(retained.rows).toHaveLength(1);
  expect(retained.rows[0]).toMatchObject({
    route: routeOf(publicCollection.collection.id),
    collection_id: publicCollection.collection.id,
    member_id: publicCollection.first.id,
    subject_id: publicCollection.subjectId,
    note: null,
    added_at: null,
    deletion_id: publicDeletion.deletionId,
    deletion_revision: null,
    deleted_at: null,
    purge_after: null,
    deleted_ordinal_key: null,
  });
  expect(retained.rows[0].ordinal_key).toBe(`~${publicCollection.first.id}`);
  expect((await publicCollection.snapshot()).find((row) => row.row.member_id === publicSibling.id)?.row.note).toBe(
    'public sibling',
  );
  expect((await publicCollection.parent()).memberCount).toBe(1);
  expect(await subjectCollections(f.pool, publicCollection.subjectId, null, 10)).toEqual([
    expect.objectContaining({ collectionId: publicCollection.collection.id }),
  ]);
}, 300000);
test('native commit before durable checkpoint recovers on the same default worker without a second mutation', async () => {
  const m = await make();
  const deletion = await m.remove();
  const deadline = await nativeDeadline(m);
  await workerClient();
  writeFileSync(clockPath, String(Date.parse(deadline)));
  const crashed = runtime('crash');
  await crashed.until('worker-ready');
  const sweep = await trigger();
  await crashed.until('native-committed');
  expect(await m.snapshot()).toEqual([]);
  const parent = await m.parent();
  const receipt = await f.pool.query(
    'SELECT response FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 AND idempotency_key=$3',
    [routeOf(m.collection.id)! >>> 4, 'library.collection.member.retention.purge', deletion.deletionId],
  );
  expect(receipt.rows).toEqual([{ response: { purged: true } }]);
  await crashed.stop('SIGKILL');
  const recovered = runtime('recover');
  await recovered.until('worker-ready');
  await sweep.getResult({ pollingIntervalMs: 20 });
  expect(await m.snapshot()).toEqual([]);
  expect(await m.parent()).toEqual(parent);
  await recovered.stop('SIGTERM');
}, 300000);
