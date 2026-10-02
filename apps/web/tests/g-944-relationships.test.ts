import { expect, test } from 'bun:test';
import { mainRelationships, RelationshipError } from '../features/relationships/api.ts';
import { fixtureFollow, memoryRelationships, target, actor } from '../features/relationships/fixtures.ts';
import { relationshipSource } from '../features/relationships/list.ts';
import { messages } from '../features/relationships/messages.ts';
import { followedCommunity, pinnedCommunities, spaceCommunities } from '../features/shell/communities-relationships.ts';
import { uiLocales } from '../i18n/define.ts';

function fakeMain() {
  const requests: { path: string; query: URLSearchParams; method: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  let status = 200;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input), 'http://main.test');
    requests.push({ path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') });
    return Response.json({ items: [], nextCursor: null, complete: true, watch: null }, { status });
  }) as typeof fetch;
  return { requests, api: mainRelationships(actor, { fetch: fetcher }), fail: () => { status = 409; } };
}

test('G-944: the pending Main adapter preserves cursor, search, arbitrary kinds, order and omitted fields', async () => {
  const main = fakeMain();
  await main.api.follows({ q: '小說', kind: 'https://example.org/Novel', order: 'pinned', cursor: 'next+page/2=', include: 'newSince' });
  expect(main.requests[0]!.query.get('cursor')).toBe('next+page/2=');
  expect(main.requests[0]!.query.get('q')).toBe('小說');
  expect(main.requests[0]!.query.get('kind')).toBe('https://example.org/Novel');
  await main.api.set({ target: target(10), following: true, expectedRevision: 'r10', level: 'off' }, 'retry-key');
  const command = main.requests[1]!;
  expect(command.path).toBe('/api/main/v1/follows');
  expect(command.key).toBe('retry-key');
  expect(command.body).toEqual({ profile: 'follow-command-v1', actingSubject: actor, target: target(10), following: true,
    expectedRevision: 'r10', level: 'off' });
  expect(command.body).not.toHaveProperty('pinPosition');
  await main.api.batch([{ target: target(10), expectedRevision: 'r10', level: 'off', pinPosition: null }], 'metadata-key');
  expect(main.requests[2]!.body?.targets).toEqual([{ target: target(10), expectedRevision: 'r10', level: 'off', pinPosition: null }]);
});

test('G-944: Join is one command; missing recipient Leave is explicit; Watch and negative relationships stay separate', async () => {
  const main = fakeMain();
  const policy = { policyRevision: '3', membershipGeneration: '0', termsRevision: 'rules-7', selfJoin: true, open: true, state: 'absent' as const };
  await main.api.join(target(10), policy, false, 'join-key');
  expect(main.requests).toHaveLength(1);
  expect(main.requests[0]!.path).toEndWith('/join');
  expect(main.requests[0]!.body).toEqual({ actingSubject: actor, expectedMembershipGeneration: '0', expectedPolicyRevision: '3', termsRevision: 'rules-7', listed: false });
  expect(main.api.canLeave).toBe(false);
  await expect(main.api.leave(target(10), '1')).rejects.toBeInstanceOf(RelationshipError);
  expect(main.requests).toHaveLength(1);
  await main.api.setWatch('urn:rezics:proposal:00000000-0000-4000-8000-000000000002', 'proposal', 'participating', null);
  expect(main.requests[1]!.body?.level).toBe('participating');
  await main.api.mute(target(10), 'realm', true);
  await main.api.block(target(11), true);
  expect(main.requests.slice(2).map(item => item.path)).toEqual(['/api/main/v1/me/mutes', '/api/main/v1/me/blocked-people']);
  main.fail();
  await expect(main.api.memberships()).rejects.toBeInstanceOf(RelationshipError);
});

test('G-944: thousands of relationships are traversable; a failed continuation retains its cursor and retry recovers it', async () => {
  const memory = memoryRelationships(Array.from({ length: 1203 }, (_, i) => fixtureFollow(i + 10)));
  let fail = false;
  const source = relationshipSource(async query => { if (fail) throw new Error('Offline'); return memory.api.follows(query); }, item => item.id, item => item.name!.value);
  await source.search('');
  expect(source.getSnapshot().items).toHaveLength(20);
  expect(source.getSnapshot().complete).toBe(false);
  fail = true; await source.more();
  expect(source.getSnapshot().error).toBe(true);
  expect(source.getSnapshot().nextCursor).toBe('20');
  expect(source.getSnapshot().items).toHaveLength(20);
  fail = false; await source.retry();
  while (!source.getSnapshot().complete) await source.more();
  expect(source.getSnapshot().items).toHaveLength(1203);
  await source.search('Community 1212');
  expect(source.getSnapshot().items.map(item => item.id)).toEqual([target(1212)]);
});

test('G-944: cancelled and superseded queries cannot publish old inventory results', async () => {
  let finish!: (value: { items: { id: string }[]; nextCursor: null; complete: true }) => void;
  const source = relationshipSource<{ id: string }>(async ({ q }) => q === 'old' ? new Promise<{ items: { id: string }[]; nextCursor: null; complete: true }>(resolve => { finish = resolve; })
    : { items: [{ id: 'new' }], nextCursor: null, complete: true }, item => item.id, item => item.id);
  const old = source.search('old');
  await source.search('new'); finish({ items: [{ id: 'old' }], nextCursor: null, complete: true }); await old;
  expect(source.getSnapshot().items.map(item => item.id)).toEqual(['new']);
});

test('G-944: pinned traversal stops at the first unpinned row, and Spaces coalesce Realm/Zone membership without losing continuation', async () => {
  const projecting = fixtureFollow(10);
  projecting.newSince!.state = 'projecting';
  expect(followedCommunity(projecting)?.activity).toBe('unknown');
  const rows = Array.from({ length: 45 }, (_, i) => ({ ...fixtureFollow(i + 10), pinPosition: i < 25 ? i : null }));
  const memory = memoryRelationships(rows);
  const pinned = await pinnedCommunities(memory.api, '', null);
  expect(pinned.items).toHaveLength(20); expect(pinned.complete).toBe(false);
  const tail = await pinnedCommunities(memory.api, '', pinned.nextCursor);
  expect(tail.items).toHaveLength(5); expect(tail.complete).toBe(true);
  const realm = rows[0]!.realm!;
  await memory.api.join(realm, await memory.api.joining(realm), false);
  // Older membership episodes can name only the Realm; the Space follow must still be shown once.
  memory.member.get(realm)!.space = null;
  const spaces = await spaceCommunities(memory.api, '', null);
  expect(spaces.items.filter(item => item.id === rows[0]!.id)).toHaveLength(1);
  expect(spaces.complete).toBe(false);
  const next = await spaceCommunities(memory.api, '', spaces.nextCursor);
  expect(next.items).toHaveLength(20);
  expect(JSON.parse(next.nextCursor!).memberships).toBeNull();
});

test('G-944: every locale has complete relationship copy with distinct notification levels', () => {
  for (const locale of uiLocales) {
    expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(messages.en).sort());
    expect(new Set([messages[locale].all, messages[locale].highlights, messages[locale].off]).size).toBe(3);
  }
});

test('G-944: a moved continuation restarts the inventory instead of mixing snapshots or retrying a dead cursor', async () => {
  let revision = 1;
  const source = relationshipSource<{ id: string }>(async ({ cursor }) => {
    if (cursor) { revision++; throw new RelationshipError(409); }
    return { items: [{ id: `revision-${revision}` }], nextCursor: 'continue', complete: false };
  }, item => item.id, item => item.id);
  await source.search(''); await source.more();
  expect(source.getSnapshot().items[0]!.id).toBe('revision-1');
  await source.retry();
  expect(source.getSnapshot().items.map(item => item.id)).toEqual(['revision-2']);
});
