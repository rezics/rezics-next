import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { SaveDraftCommand } from '../../../services/content/src/core.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { resolveTargets, targetRead } from '../../../services/main/src/modules/target/resolve.ts';
import { startHomeStack, type HomeStack } from './feed-read-support.ts';

const local = (reference: string) => reference.slice(-36);
interface Page {
  zone: string; path: string; routeRevision: string; about: string; targetRevision: string;
}
interface Posted {
  profile: string; realm: string; about: string; thread: { reply: string; rootRevision: string };
  reply: string; revisionId: string; placement: string; opened: boolean;
}
interface ReplyRow {
  reply: string; author: string; parent_reply: string | null; root_target: string;
  root_revision: string; origin_realm: string | null; body: Record<string, unknown>;
}

async function threeWriteDebits(home: HomeStack, request: () => Promise<Response>) {
  const limit = home.deps.rateLimit;
  if (!limit) throw new Error('Discussion fixture requires the real Main rate limiter');
  const original = limit.store.consume;
  const calls: Parameters<typeof original>[] = [];
  limit.store.consume = async (...args) => {
    calls.push(args);
    return original.call(limit.store, ...args);
  };
  try {
    const response = await request();
    expect(calls).toHaveLength(3);
    const identity = JSON.stringify([home.author.principal.issuer, home.author.principal.subject]);
    expect(calls.every(([key, family]) => key === identity && family === 'write')).toBe(true);
    expect(calls[1]![2]).toEqual(calls[0]![2]);
    expect(calls[2]![2]).toEqual(calls[0]![2]);
    return response;
  } finally { limit.store.consume = original; }
}

async function arrange(home: HomeStack) {
  const author = await home.provision('Discussion author', home.author.token);
  const reader = await home.provision('Discussion participant', home.reader.token);
  expect(home.author.principalId).not.toBe(home.reader.principalId);
  const admin = new AccessRealmManagement(home.stack.accessPool);
  const realmFor = async () => {
    const realm = await home.json<{ realm: string; space: string }>(await home.call('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: `Discussion ${randomUUID()}`, topics: [],
      handle: `discussion-${randomUUID().slice(0, 12)}`, capabilities: ['realm'], actingSubject: author,
    }, home.author.token), 201);
    await admin.initialize({ ...home.author.principal, emailVerified: true }, realm.realm, author, home.stack.env);
    return realm;
  };
  const policy = async (realm: string, mode: 'open' | 'mandatory') => {
    const path = `/v1/realms/${local(realm)}/settings`;
    const current = await home.json<{ generation: string; ruleBasis: { revision: string | null } }>(
      await home.call('GET', `${path}?actingSubject=${encodeURIComponent(author)}`, undefined, home.author.token));
    await home.json(await home.call('PUT', path, { actingSubject: author,
      expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
      reason: 'Set discussion admission', settings: { visibility: 'public', reviewMode: mode,
        reviewRequired: mode === 'mandatory', whoMaySubmit: 'granted', rules: [] },
    }, home.author.token), 201);
  };
  const realm = await realmFor();
  await policy(realm.realm, 'open');
  const site = await home.json<{ zone: string; space: string; navigationRevision: string }>(
    await home.call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Discussion site', language: 'en',
      handle: `discussion-site-${randomUUID().slice(0, 12)}`, capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: author }, home.author.token), 201);
  expect(site.space).not.toBe(realm.space);
  const sitePath = `/v1/zones/${local(site.zone)}`;
  const head = async () => (await readZoneConfiguration(home.stack.env, site.zone)).revision;
  const configure = async (patch: object) => home.json<{ revision: string }>(await home.call('PUT',
    `${sitePath}/configuration`, { expectedHead: await head(), actingSubject: author, ...patch }, home.author.token));
  await configure({ defaultRealm: realm.realm });
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await home.json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    await home.call('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: site.zone,
      variantId, expectedHead: null, document: fromPlainText('Discussion site home', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: author }, home.author.token), 201);
  let navigationRevision = site.navigationRevision;
  const publish = async () => home.json(await home.call('POST', `${sitePath}/site-publications`, {
    routesRevision: navigationRevision, navigationRevision, expectedHead: await head(), actingSubject: author,
    pages: [{ page: site.zone, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
      contentEpoch: draft.sourcePosition.dataEpoch }],
  }, home.author.token), 201);
  const targetRevision = async (about: string) => {
    const [target] = await targetRead(home.stack.env, { access: home.stack.access },
      session => resolveTargets(session, [about], 'discussion'));
    return target!.revision;
  };
  const route = async (path: string) => home.json<{ realm: string | null; revision: string; resource: { id: string } }>(
    await home.call('GET', `${sitePath}/routes?${new URLSearchParams({ path })}`));
  const page = async (segment: string): Promise<Page> => {
    const work = await home.stack.publicWork(author, ['en'], `Discussion page ${segment}`);
    const mounted = await home.json<{ revision: string }>(await home.call('POST', `${sitePath}/mounts`, {
      expectedHead: navigationRevision, target: work.work, routeSegment: segment,
      disclosure: 'public', actingSubject: author,
    }, home.author.token));
    navigationRevision = mounted.revision;
    await publish();
    const path = `/${segment}`, resolved = await route(path);
    expect(resolved.realm).toBe(realm.realm);
    expect(resolved.resource.id).toBe(work.work);
    return { zone: site.zone, path, routeRevision: resolved.revision, about: work.work,
      targetRevision: await targetRevision(work.work) };
  };
  const input = (page: Page, actor: string, body: string) => ({ profile: 'realm-about-post-v1' as const,
    ...page, actingSubject: actor, language: 'en', direction: 'ltr' as const, body });
  const post = (page: Page, actor: string, body: string, token: string, key = randomUUID()) =>
    home.call('POST', `/v1/realms/${local(realm.realm)}/about-posts`, input(page, actor, body), token, key);
  const rows = async (about: string) => (await home.stack.contentPool.query<ReplyRow>(`
    SELECT c.id AS reply,c.author,c.parent_reply,c.root_target,c.root_revision,c.origin_realm,r.body
    FROM content.reply c JOIN content.variant v ON v.id=c.variant_id
    JOIN content.revision r ON r.id=v.draft_head WHERE c.root_target=$1 ORDER BY c.id`, [about])).rows;
  const effects = async (about: string) => (await home.stack.contentPool.query(`SELECT
    (SELECT count(*)::int FROM content.realm_about_thread WHERE realm=$1 AND about=$2) AS threads,
    (SELECT count(*)::int FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2) AS operations,
    (SELECT count(*)::int FROM content.reply WHERE root_target=$2) AS replies,
    (SELECT count(*)::int FROM content.revision WHERE body->>'rootTarget'=$2) AS revisions`,
  [realm.realm, about])).rows[0];
  return { author, reader, realm, site, sitePath, page, input, post, rows, effects,
    realmFor, policy, configure, publish, route, targetRevision };
}

test('a published Zone page opens one canonical discussion and preserves independent concurrent contributions', async () => {
  const home = await startHomeStack('zone-realm-discussion', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    const page = await a.page('first');
    const path = `/v1/realms/${local(a.realm.realm)}/about-posts`;
    const before = await a.effects(page.about);
    const missingKey = await home.app.handle(new Request(`http://main.local${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${home.author.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(a.input(page, a.author, 'First post')) }));
    expect(missingKey.status).toBe(400);
    expect(await a.effects(page.about)).toEqual(before);

    const firstKey = randomUUID();
    const first = await home.json<Posted>(await threeWriteDebits(home,
      () => a.post(page, a.author, 'First post', home.author.token, firstKey)), 201);
    expect(first).toMatchObject({ realm: a.realm.realm, about: page.about, opened: true,
      thread: { reply: first.reply, rootRevision: page.targetRevision } });
    expect(await home.json(await threeWriteDebits(home,
      () => a.post(page, a.author, 'First post', home.author.token, firstKey)), 201)).toEqual(first);
    const conflict = await a.post(page, a.author, 'Different intent', home.author.token, firstKey);
    expect(conflict.status).toBe(409);
    expect((await a.post(page, a.reader, 'First post', home.author.token, firstKey)).status).toBe(409);
    const secondKey = randomUUID();
    const second = await home.json<Posted>(await a.post(page, a.reader, 'Second person post', home.reader.token, secondKey), 201);
    expect(second.thread).toEqual(first.thread);
    expect(second.reply).not.toBe(first.reply);
    expect(second.opened).toBe(false);
    expect(await home.json(await a.post(page, a.reader, 'Second person post', home.reader.token, secondKey), 201)).toEqual(second);
    const persisted = await a.rows(page.about);
    expect(persisted).toHaveLength(2);
    expect(persisted.find(row => row.reply === first.reply)).toMatchObject({ author: a.author,
      parent_reply: null, root_target: page.about, root_revision: first.thread.rootRevision,
      origin_realm: a.realm.realm, body: { body: 'First post' } });
    expect(persisted.find(row => row.reply === second.reply)).toMatchObject({ author: a.reader,
      parent_reply: first.reply, root_target: page.about, root_revision: first.thread.rootRevision,
      origin_realm: a.realm.realm, body: { body: 'Second person post' } });

    const concurrent = await a.page('concurrent');
    const content = home.stack.content;
    const originalSave = content.saveDraft;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const atDraft = new Promise<void>(resolve => { entered = resolve; });
    let blocked = false;
    content.saveDraft = async function (command: SaveDraftCommand) {
      if (!blocked && command.model === 'member-reply-v1'
        && JSON.parse(command.serializedJson).rootTarget === concurrent.about) {
        blocked = true;
        entered();
        await held;
      }
      return originalSave.call(this, command);
    };
    const winnerKey = randomUUID(), childKey = randomUUID();
    const winnerRequest = a.post(concurrent, a.author, 'Concurrent opener', home.author.token, winnerKey);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([atDraft, winnerRequest.then(async response => {
          throw new Error(`Command returned before the draft barrier: ${response.status} ${await response.clone().text()}`);
        }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Draft barrier timed out')), 30_000); })]);
      } finally { clearTimeout(timer); }
      const pending = await home.json<{ operationId: string }>(await a.post(concurrent, a.reader,
        'Concurrent child', home.reader.token, childKey), 202);
      expect(Object.keys(pending)).toEqual(['operationId']);
      expect(pending.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await home.json(await a.post(concurrent, a.reader, 'Concurrent child', home.reader.token, childKey), 202)).toEqual(pending);
      release();
      const winner = await home.json<Posted>(await winnerRequest, 201);
      const child = await home.json<Posted>(await a.post(concurrent, a.reader,
        'Concurrent child', home.reader.token, childKey), 201);
      expect(winner.opened).toBe(true);
      expect(child.opened).toBe(false);
      expect(child.thread).toEqual(winner.thread);
      expect(await home.json(await a.post(concurrent, a.author, 'Concurrent opener', home.author.token, winnerKey), 201)).toEqual(winner);
      expect(await home.json(await a.post(concurrent, a.reader, 'Concurrent child', home.reader.token, childKey), 201)).toEqual(child);
      const contributions = await a.rows(concurrent.about);
      expect(contributions).toHaveLength(2);
      expect(contributions.filter(row => row.parent_reply === null)).toHaveLength(1);
      expect(contributions.find(row => row.reply === winner.reply)).toMatchObject({ author: a.author,
        root_revision: concurrent.targetRevision, body: { body: 'Concurrent opener' } });
      expect(contributions.find(row => row.reply === child.reply)).toMatchObject({ author: a.reader,
        parent_reply: winner.reply, root_revision: concurrent.targetRevision, body: { body: 'Concurrent child' } });
      const canonical = await home.stack.contentPool.query(`SELECT opener_reply FROM content.realm_about_thread
        WHERE realm=$1 AND about=$2`, [a.realm.realm, concurrent.about]);
      expect(canonical.rows).toEqual([{ opener_reply: winner.reply }]);
    } finally {
      release();
      content.saveDraft = originalSave;
      await winnerRequest;
    }
  } finally { await home.stop(); }
}, 300_000);

test('stale page bases, policy refusal and ended attachments create no discussion contributions', async () => {
  const home = await startHomeStack('zone-realm-discussion-refused', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    const page = await a.page('refusal');
    const unchanged = await a.effects(page.about);
    const endpoint = `/v1/realms/${local(a.realm.realm)}/about-posts`;
    const { body: _body, ...documentInput } = a.input(page, a.reader, 'Unused text');
    const emptyDocument = await home.call('POST', endpoint,
      { ...documentInput, document: fromPlainText('', 'blocks') }, home.reader.token);
    expect(emptyDocument.status, await emptyDocument.text()).toBe(400);
    expect(await a.effects(page.about)).toEqual(unchanged);
    const organization = await home.json<{ agent: string }>(await home.call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'organization', displayName: 'Discussion organization',
    }, home.author.token), 201);
    const organizationPost = await a.post(page, organization.agent, 'Organization post', home.author.token);
    expect(organizationPost.status, await organizationPost.text()).toBe(403);
    expect(await a.effects(page.about)).toEqual(unchanged);
    const refused = async (input: Page, status: number) => {
      const response = await a.post(input, a.reader, 'Refused contribution', home.reader.token);
      expect(response.status, await response.text()).toBe(status);
      expect(await a.effects(page.about)).toEqual(unchanged);
    };
    await refused({ ...page, routeRevision: `https://rezics.com/id/${randomUUID()}` }, 409);
    await refused({ ...page, targetRevision: `https://rezics.com/id/${randomUUID()}` }, 409);
    const limit = home.deps.rateLimit;
    if (!limit) throw new Error('Discussion fixture requires the real Main rate limiter');
    const originalConsume = limit.store.consume;
    let writeDebits = 0;
    limit.store.consume = async (...args) => args[1] === 'write' && ++writeDebits === 3
      ? { allowed: false, retryAfter: 1 } : originalConsume.call(limit.store, ...args);
    try {
      await refused(page, 429);
      expect(writeDebits).toBe(3);
    } finally { limit.store.consume = originalConsume; }
    await a.policy(a.realm.realm, 'mandatory');
    await refused(page, 403);
    await a.policy(a.realm.realm, 'open');

    const other = await a.realmFor();
    await a.policy(other.realm, 'open');
    await a.configure({ defaultRealm: other.realm });
    await refused(page, 409);
    await a.publish();
    expect((await a.route(page.path)).realm).toBe(other.realm);
    await refused(page, 409);

    await a.configure({ defaultRealm: a.realm.realm });
    await a.publish();
    const current = { ...page, routeRevision: (await a.route(page.path)).revision };
    await home.json(await home.call('POST', `${a.sitePath}/realm-attachment-withdrawals`, {
      realm: a.realm.realm, actingSubject: a.author,
    }, home.author.token));
    expect((await a.route(page.path)).realm).toBeNull();
    await refused(current, 409);
  } finally { await home.stop(); }
}, 300_000);
