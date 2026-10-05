import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FeedItem } from '../../../services/main/src/modules/feed/contract.ts';
import { READ_BASIS_RETENTION_MS } from '../../../services/main/src/modules/read-basis/retention.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { seedHome, startHomeStack, type HomeStack } from './feed-read-support.ts';

const SETUP_MS = 600_000;
interface Page { items: FeedItem[]; nextCursor: string | null;
  sourcePosition: { dataEpoch: string; sequence: string } }
interface Threads { items: { reply: string; title: string }[]; nextCursor: string | null;
  sourcePosition: { dataEpoch: string; sequence: string } }
let home: HomeStack, seed: Awaited<ReturnType<typeof seedHome>>, realmPath: string;
const sorts = ['new', 'best', 'top'] as const;
const continueAt = (path: string, cursor: string) => `${path}&cursor=${encodeURIComponent(cursor)}`;

beforeAll(async () => {
  home = await startHomeStack('feed-read-stability', { projectionStart: 'current' });
  seed = await seedHome(home);
  await seed.post('Another retained discussion');
  await seed.post('Third retained discussion');
  await home.project();
  realmPath = `/v1/realms/${seed.realm.realm.slice(-36)}/threads`;
}, SETUP_MS);
afterAll(async () => { await home?.stop(); });

test('Home and Realm thread cursors survive an unrelated graph command and its empty refresh', async () => {
  const paths = sorts.flatMap(sort => [`/v1/feed?sort=${sort}&limit=1`, `${realmPath}?sort=${sort}&limit=1`]);
  const following = seed.signed('/v1/feed?scope=following&sort=new&limit=1');
  paths.push(following);
  const pages = new Map<string, Page | Threads>();
  for (const path of paths) {
    const first = await home.json<Page | Threads>(await home.call('GET', path, undefined,
      path === following ? home.reader.token : undefined));
    expect(first.nextCursor, path).toBeTruthy();
    pages.set(path, first);
  }
  const revision = (await home.deps.feed.checkpoint(home.stack.env.lineage.dataEpoch)).revision;
  await home.provision('An unrelated graph command', home.author.token);
  // A retained population stays readable before its empty refresh catches up.
  for (const path of paths) {
    const first = pages.get(path)!;
    const next = await home.json<Page | Threads>(await home.call('GET', continueAt(path, first.nextCursor!),
      undefined, path === following ? home.reader.token : undefined));
    expect(BigInt(next.sourcePosition.sequence)).toBeGreaterThan(BigInt(first.sourcePosition.sequence));
  }
  // Fresh ranked admissions still require a complete projection at their cut.
  expect((await home.call('GET', `${realmPath}?sort=top&limit=1`)).status).toBe(503);
  await home.project();
  expect((await home.deps.feed.checkpoint(home.stack.env.lineage.dataEpoch)).revision).toBe(revision);
  for (const path of paths) {
    const first = pages.get(path)!;
    const next = await home.json<Page | Threads>(await home.call('GET', continueAt(path, first.nextCursor!),
      undefined, path === following ? home.reader.token : undefined));
    expect(BigInt(next.sourcePosition.sequence), path).toBeGreaterThan(BigInt(first.sourcePosition.sequence));
    const replay = await home.json<Page | Threads>(await home.call('GET', continueAt(path, first.nextCursor!),
      undefined, path === following ? home.reader.token : undefined));
    expect(replay.items, path).toEqual(next.items);
  }
}, SETUP_MS);

test('retained Home and Realm pages omit a served candidate after live disclosure revocation', async () => {
  const feedPath = '/v1/feed?sort=new&kinds=work&limit=1';
  const feed = await home.json<Page>(await home.call('GET', feedPath));
  const cursorPath = continueAt(feedPath, feed.nextCursor!);
  const served = await home.json<Page>(await home.call('GET', cursorPath));
  expect(served.items).toHaveLength(1);
  const hiddenWork = served.items[0]!.target.work!;
  // Protection changes current disclosure without changing retained activity rows.
  await home.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} { ${iri(hiddenWork)} rv:protectionHead <urn:rezics:retained-feed-protection> } }`);
  try {
    const next = await home.json<Page>(await home.call('GET', cursorPath));
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeTruthy();
    expect(JSON.stringify(next)).not.toContain(served.items[0]!.target.title.value);
  } finally {
    await home.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(hiddenWork)} rv:protectionHead <urn:rezics:retained-feed-protection> } }`);
  }
  // Every Realm order keeps its selected positions when an indexed placement is
  // revoked before the projector catches up. Its body and identity disappear.
  for (const sort of sorts) {
    const path = `${realmPath}?sort=${sort}&limit=1`;
    const first = await home.json<Threads>(await home.call('GET', path));
    const nextPath = continueAt(path, first.nextCursor!);
    const served = await home.json<Threads>(await home.call('GET', nextPath));
    expect(served.items).toHaveLength(1);
    const reply = served.items[0]!.reply;
    const slot = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?slot ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?slot rv:realm ${iri(seed.realm.realm)} ; rv:reply ${iri(reply)} ;
        rv:replyPlacementHead ?head } } LIMIT 1`)).results!.bindings[0]!;
    await home.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot.slot!.value)} rv:replyPlacementHead ${iri(slot.head!.value)} } }`);
    try {
      const hidden = await home.json<Threads>(await home.call('GET', nextPath));
      expect(hidden.items.map(item => item.reply)).not.toContain(reply);
      expect(JSON.stringify(hidden)).not.toContain(served.items[0]!.title);
    } finally {
      await home.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot.slot!.value)} rv:replyPlacementHead ${iri(slot.head!.value)} } }`);
    }
  }
}, SETUP_MS);

test('Home and Realm continuations expire at their first-page deadline even after successful later pages', async () => {
  const paths = sorts.flatMap(sort => [`/v1/feed?sort=${sort}&limit=1`, `${realmPath}?sort=${sort}&limit=1`]);
  const pages = new Map<string, Page | Threads>();
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (const path of paths) pages.set(path, await home.json<Page | Threads>(await home.call('GET', path)));
    now += READ_BASIS_RETENTION_MS - 1;
    const later = new Map<string, Page | Threads>();
    for (const path of paths) {
      const next = await home.json<Page | Threads>(await home.call('GET', continueAt(path, pages.get(path)!.nextCursor!)));
      expect(next.nextCursor, path).toBeTruthy();
      later.set(path, next);
    }
    now++;
    for (const path of paths) {
      const expired = await home.json<{ code: string }>(await home.call('GET',
        continueAt(path, later.get(path)!.nextCursor!)), 409);
      expect(expired.code).toBe('read_basis_changed');
    }
  } finally { clock.mockRestore(); }
}, SETUP_MS);

test('a changed Home or Realm population still requires a documented cursor restart', async () => {
  const paths = sorts.flatMap(sort => [`/v1/feed?sort=${sort}&limit=1`, `${realmPath}?sort=${sort}&limit=1`]);
  const pages = new Map<string, Page | Threads>();
  for (const path of paths) pages.set(path, await home.json<Page | Threads>(await home.call('GET', path)));
  await seed.post('A new member of the retained population');
  await home.project();
  for (const path of paths) {
    const restart = await home.json<{ code: string }>(await home.call('GET',
      continueAt(path, pages.get(path)!.nextCursor!)), 409);
    expect(restart.code).toBe('read_basis_changed');
  }
}, SETUP_MS);

test('follow, personal and Following target-index revisions continue to fence retained Home cursors', async () => {
  const all = seed.signed('/v1/feed?scope=all&sort=best&limit=1');
  const following = seed.signed('/v1/feed?scope=following&sort=new&limit=1');
  const first = await home.json<Page>(await home.call('GET', all, undefined, home.reader.token));
  await home.json(await home.call('POST', '/v1/follows', { profile: 'follow-command-v1', actingSubject: seed.reader,
    target: seed.works[4]!.work, kind: 'work', following: true, expectedRevision: null }, home.reader.token));
  expect((await home.call('GET', continueAt(all, first.nextCursor!), undefined, home.reader.token)).status).toBe(409);
  const personal = await home.json<Page>(await home.call('GET', all, undefined, home.reader.token));
  await home.json(await home.call('POST', '/v1/me/feed-feedback', { actingSubject: seed.reader,
    kind: 'activity', target: personal.items[0]!.id, strength: 'hide' }, home.reader.token));
  expect((await home.call('GET', continueAt(all, personal.nextCursor!), undefined, home.reader.token)).status).toBe(409);
  const target = await home.json<Page>(await home.call('GET', following, undefined, home.reader.token));
  expect(target.nextCursor).toBeTruthy();
  await home.stack.accessPool.query('UPDATE access.feed_target_checkpoint SET revision=$2 WHERE data_epoch=$1',
    [home.stack.env.lineage.dataEpoch, randomUUID()]);
  expect((await home.call('GET', continueAt(following, target.nextCursor!), undefined, home.reader.token)).status).toBe(409);
}, SETUP_MS);

test('Realm cursors bind the authenticated reader and omit erased bodies before projection catches up', async () => {
  const signed = seed.signed(`${realmPath}?sort=new&limit=1`);
  const personal = await home.json<Threads>(await home.call('GET', signed, undefined, home.reader.token));
  const other = `${realmPath}?sort=new&limit=1&actingSubject=${encodeURIComponent(seed.author)}`;
  expect((await home.call('GET', continueAt(other, personal.nextCursor!), undefined, home.author.token)).status).toBe(400);
  const pages = new Map<string, { cursor: string; reply: string; title: string }>();
  for (const sort of sorts) {
    const path = `${realmPath}?sort=${sort}&limit=1`;
    const first = await home.json<Threads>(await home.call('GET', path));
    const served = await home.json<Threads>(await home.call('GET', continueAt(path, first.nextCursor!)));
    expect(served.items).toHaveLength(1);
    pages.set(path, { cursor: first.nextCursor!, ...served.items[0]! });
  }
  const replies = [...new Set([...pages.values()].map(item => item.reply))];
  const erased = await home.stack.contentPool.query(`UPDATE content.revision SET availability='erased',
    serialized_bytes=NULL,body=NULL WHERE id IN (SELECT v.draft_head FROM content.variant v
      JOIN content.reply p ON p.variant_id=v.id WHERE p.id=ANY($1::text[]))`, [replies]);
  expect(erased.rowCount).toBe(replies.length);
  for (const [path, served] of pages) {
    const hidden = await home.json<Threads>(await home.call('GET', continueAt(path, served.cursor)));
    expect(hidden.items).toEqual([]);
    expect(hidden.nextCursor).toBeTruthy();
    expect(JSON.stringify(hidden)).not.toContain(served.title);
  }
}, SETUP_MS);
