import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { SaveDraftCommand } from '../../../services/content/src/core.ts';
import { startHomeStack } from './feed-read-support.ts';
import { arrange, local, threeWriteDebits, type Page, type Posted } from './zone-realm-discussion-support.ts';

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
    expect(first).toMatchObject({ realm: a.realm.realm, about: page.about, author: a.author });
    expect(Object.keys(first).sort()).toEqual(['about', 'author', 'placement', 'profile', 'realm', 'reply', 'revisionId']);
    expect(await home.json(await threeWriteDebits(home,
      () => a.post(page, a.author, 'First post', home.author.token, firstKey)), 200)).toEqual(first);
    const conflict = await a.post(page, a.author, 'Different intent', home.author.token, firstKey);
    expect(conflict.status).toBe(409);
    expect((await a.post(page, a.reader, 'First post', home.author.token, firstKey)).status).toBe(409);
    const secondKey = randomUUID();
    const second = await home.json<Posted>(await a.post(page, a.reader, 'Second person post', home.reader.token, secondKey), 201);
    expect(second.reply).not.toBe(first.reply);
    expect(second.author).toBe(a.reader);
    expect(await home.json(await a.post(page, a.reader, 'Second person post', home.reader.token, secondKey), 200)).toEqual(second);
    const persisted = await a.rows(page.about);
    expect(persisted).toHaveLength(2);
    expect(persisted.find(row => row.reply === first.reply)).toMatchObject({ author: a.author,
      parent_reply: null, root_target: page.about, root_revision: page.targetRevision,
      origin_realm: a.realm.realm, body: { body: 'First post' } });
    expect(persisted.find(row => row.reply === second.reply)).toMatchObject({ author: a.reader,
      parent_reply: first.reply, root_target: page.about, root_revision: page.targetRevision,
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
      expect(winner.author).toBe(a.author);
      expect(child.author).toBe(a.reader);
      expect(await home.json(await a.post(concurrent, a.author, 'Concurrent opener', home.author.token, winnerKey), 200)).toEqual(winner);
      expect(await home.json(await a.post(concurrent, a.reader, 'Concurrent child', home.reader.token, childKey), 200)).toEqual(child);
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
