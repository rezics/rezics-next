import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Static } from 'typebox';
import type { SaveDraftCommand } from '../../../services/content/src/core.ts';
import type { realmAboutThread, realmThread } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import type { TitleControlState } from '../../../services/main/src/modules/work/title-control.ts';
import { startHomeStack } from './feed-read-support.ts';
import { arrange, local, threeWriteDebits, type Page, type Posted } from './zone-realm-discussion-support.ts';

test('a published Zone page opens one canonical discussion and preserves independent concurrent contributions', async () => {
  const home = await startHomeStack('zone-realm-discussion', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    const page = await a.page('first');
    const path = `/v1/realms/${local(a.realm.realm)}/about-posts`;
    const lookup = (about: string) => home.call('GET',
      `/v1/realms/${local(a.realm.realm)}/about-thread?${new URLSearchParams({ about })}`);
    const thread = async (reply: string) => {
      await home.project();
      return home.json<Static<typeof realmThread>>(await home.call('GET',
        `/v1/realms/${local(a.realm.realm)}/threads/${local(reply)}?sort=new`));
    };
    const before = await a.effects(page.about);
    expect(before).toEqual({ threads: 0, operations: 0, replies: 0, revisions: 0 });
    expect(await home.json<Static<typeof realmAboutThread>>(await lookup(page.about)))
      .toEqual({ realm: a.realm.realm, about: page.about, thread: null });
    expect(await a.effects(page.about)).toEqual(before);
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
    const canonical = { realm: a.realm.realm, about: page.about,
      thread: { reply: first.reply, rootRevision: page.targetRevision } };
    expect(await home.json(await lookup(page.about))).toEqual(canonical);
    const originalThread = await thread(first.reply);
    expect(originalThread).toMatchObject({ realm: a.realm.realm, thread: first.reply,
      work: { id: page.about }, rootRevision: page.targetRevision });
    expect(originalThread.items).toHaveLength(2);
    expect(originalThread.items.find(item => item.reply === first.reply)).toMatchObject({
      author: { id: a.author }, parent: null, title: 'First post', body: '', language: 'en' });
    expect(originalThread.items.find(item => item.reply === second.reply)).toMatchObject({
      author: { id: a.reader }, parent: first.reply, title: null, body: 'Second person post', language: 'en' });

    // Editing the routable resource refreshes posting eligibility, but never the
    // canonical discussion's retained root or either person's accepted contribution.
    // The fixture Work is catalogue metadata, so editing uses an explicit
    // represented grant rather than inventing native creator authority.
    const editScope = `work:edit:${page.about}`;
    await home.stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [editScope]);
    await home.stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), home.author.principalId, a.author]);
    await home.stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), a.author, editScope]);
    const titleBasis = await home.json<TitleControlState>(await home.call('GET',
      `/v1/works/${local(page.about)}/title-control?${new URLSearchParams({ actingSubject: a.author })}`,
      undefined, home.author.token));
    const edited = await home.json<{ revision: string }>(await home.call('POST', '/v1/content-edits', {
      profile: 'metadata-only-v1', work: page.about, expectedHead: titleBasis.contentHead,
      titleControl: titleBasis.basis, title: 'Discussion page after an edit', actingSubject: a.author,
    }, home.author.token));
    const editedPage = { ...page, routeRevision: (await a.route(page.path)).revision,
      targetRevision: await a.targetRevision(page.about) };
    expect(editedPage.targetRevision).toBe(edited.revision);
    expect(editedPage.targetRevision).not.toBe(page.targetRevision);
    expect(await home.json(await lookup(page.about))).toEqual(canonical);
    const editedText = '編集後の感想。\n最初の作品版についての話を続けます。';
    const editedIntent = { ...a.input(editedPage, a.reader, editedText), language: 'ja', spoiler: true };
    const editedKey = randomUUID();
    const postEdited = () => home.call('POST', path, editedIntent, home.reader.token, editedKey);
    const afterEdit = await home.json<Posted>(await postEdited(), 201);
    expect(afterEdit).toMatchObject({ realm: a.realm.realm, about: page.about, author: a.reader });
    expect(await home.json(await postEdited(), 200)).toEqual(afterEdit);
    expect(await home.json(await a.post(page, a.author, 'First post', home.author.token, firstKey), 200)).toEqual(first);
    expect(await home.json(await a.post(page, a.reader, 'Second person post', home.reader.token, secondKey), 200)).toEqual(second);
    expect(await home.json(await lookup(page.about))).toEqual(canonical);
    const afterEditRows = await a.rows(page.about);
    expect(afterEditRows).toHaveLength(3);
    for (const original of persisted) expect(afterEditRows.find(row => row.reply === original.reply)).toEqual(original);
    expect(afterEditRows.find(row => row.reply === afterEdit.reply)).toMatchObject({ author: a.reader,
      parent_reply: first.reply, root_target: page.about, root_revision: page.targetRevision,
      origin_realm: a.realm.realm, body: { body: editedText, spoiler: true } });
    const editedThread = await thread(first.reply);
    expect(editedThread).toMatchObject({ thread: first.reply, rootRevision: page.targetRevision,
      work: { id: page.about, title: { value: 'Discussion page after an edit' } } });
    expect(editedThread.items).toHaveLength(3);
    for (const original of originalThread.items) {
      const retained = editedThread.items.find(item => item.reply === original.reply);
      expect(retained).toMatchObject({ author: original.author, revisionId: original.revisionId,
        title: original.title, body: original.body, language: original.language });
    }
    expect(editedThread.items.find(item => item.reply === afterEdit.reply)).toMatchObject({
      author: { id: a.reader }, parent: first.reply, title: null, body: editedText, language: 'ja', spoiler: true });

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
      const concurrentCanonical = await home.stack.contentPool.query(`SELECT opener_reply FROM content.realm_about_thread
        WHERE realm=$1 AND about=$2`, [a.realm.realm, concurrent.about]);
      expect(concurrentCanonical.rows).toEqual([{ opener_reply: winner.reply }]);
      expect(await home.json(await lookup(concurrent.about))).toEqual({ realm: a.realm.realm, about: concurrent.about,
        thread: { reply: winner.reply, rootRevision: concurrent.targetRevision } });
    } finally {
      release();
      content.saveDraft = originalSave;
      await winnerRequest;
    }
    const retainedEffects = await a.effects(page.about);
    await home.json(await home.call('POST', `${a.sitePath}/realm-attachment-withdrawals`, {
      realm: a.realm.realm, actingSubject: a.author,
    }, home.author.token));
    expect((await a.route(page.path)).realm).toBeNull();
    expect(await a.effects(page.about)).toEqual(retainedEffects);
    expect(await home.json(await lookup(page.about))).toEqual(canonical);
    expect((await thread(first.reply)).items.map(item => item.reply).sort())
      .toEqual([first.reply, second.reply, afterEdit.reply].sort());
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
