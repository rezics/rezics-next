import { expect } from 'bun:test';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createCollectionCommands } from '../../../src/library/collections.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { accountToken, authenticateAccount } from '../../support/admitted-access.ts';
import { createProfileEntryFixture, entryKey } from './profile-entry-fixture.ts';

export const batchScopes = [
  'subject:read',
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
];
export async function createCollectionBatchFixture(options: Parameters<typeof createProfileEntryFixture>[0] = {}) {
  const f = await createProfileEntryFixture(options);
  const owner = await f.identity(batchScopes);
  const commands = createCollectionCommands({
    pool: f.pool,
    access: f.access,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  const grants = createGrantCommands({
    pool: f.pool,
    access: f.access,
    managementAction: 'access:grant',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  async function merge(a: string, b: string) {
    const claims = { ...f.steward.actor, scopes: [...f.steward.actor.scopes, 'subject:merge'] };
    const actor = await authenticateAccount(f.access, { pool: f.pool, deadline: deadlineFor(30000) }, claims);
    await grants.create(
      { pool: f.pool, actor, deadline: deadlineFor(30000) },
      {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: actor.accountId },
        actions: ['subject:merge'],
        valid: '(,)',
        key: entryKey(),
      },
    );
    const result = await f.send(await accountToken(claims), 'POST', '/v1/subjects:merge', { subjects: [a, b] });
    expect(result.status, await result.clone().text()).toBe(200);
    return (await result.json()) as { survivor: string; redirected: string };
  }
  async function refresh(identity = owner) {
    identity.bearer = await accountToken(identity.actor);
    identity.actor = await f.access.authenticate(identity.bearer, { pool: f.pool, deadline: deadlineFor(30000) });
  }
  async function make(visibility: 'private' | 'public' | 'unlisted' = 'private', identity = owner) {
    const result = await commands.createCollection(
      identity.actor,
      { title: 'Selected occurrences', visibility },
      entryKey(),
    );
    return result.value;
  }
  async function add(collectionId: string, subjectId: string, note = 'occurrence', after?: string | null) {
    return (
      await commands.addMember(
        owner.actor,
        collectionId,
        { subjectId, note, ...(after === undefined ? {} : { after }) },
        entryKey(),
      )
    ).value;
  }
  async function current(id: string) {
    const response = await f.send(owner.bearer, 'GET', `/v1/collections/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()).collection as { id: string; revision: number; memberCount: number };
  }
  async function page(id: string) {
    const result: { id: string; subjectId: string; note: string | null; addedAt: string }[] = [];
    let cursor: string | null = null;
    do {
      const response = await f.send(
        owner.bearer,
        'GET',
        `/v1/collections/${id}/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      result.push(...body.members);
      cursor = body.next;
    } while (cursor);
    return result;
  }
  async function snapshot(ids: string[]) {
    const route = routeOf(ids[0]!)!;
    return {
      parents: (
        await f.pool.query(
          'SELECT to_jsonb(c) AS row FROM library.collection c WHERE route=$1 AND collection_id=ANY($2::uuid[]) ORDER BY collection_id',
          [route, ids],
        )
      ).rows,
      members: (
        await f.pool.query(
          'SELECT to_jsonb(m) AS row FROM library.collection_member m WHERE route=$1 AND collection_id=ANY($2::uuid[]) ORDER BY collection_id,member_id',
          [route, ids],
        )
      ).rows,
      receipts: (
        await f.pool.query(
          'SELECT to_jsonb(r) AS row FROM core.receipt r WHERE partition_no=$1 AND principal_id=$2 ORDER BY command_kind,idempotency_key',
          [partitionOf(route), owner.actor.accountId],
        )
      ).rows,
      events: (
        await f.pool.query(
          'SELECT to_jsonb(e) AS row FROM core.outbox e WHERE partition_no=$1 AND subject=ANY($2::text[]) ORDER BY position,event_seq',
          [partitionOf(route), ids],
        )
      ).rows,
    };
  }
  async function grant(collectionId: string, accountId: string, revoke = false) {
    const input = {
      resource: { route: routeOf(collectionId)!, id: collectionId },
      subject: { kind: 'account' as const, id: accountId },
      actions: ['collection:read', 'collection:update'],
      valid: '(,)',
      key: entryKey(),
    };
    const context = { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30000) };
    return revoke ? grants.revoke(context, input) : grants.create(context, input);
  }
  return { ...f, owner, commands, make, add, current, page, snapshot, grant, refresh, merge };
}
export type CollectionBatchFixture = Awaited<ReturnType<typeof createCollectionBatchFixture>>;
export { entryKey };
