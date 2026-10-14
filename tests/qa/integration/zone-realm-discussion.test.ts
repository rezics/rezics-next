import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Static } from 'typebox';
import type { SaveDraftCommand } from '../../../services/content/src/core.ts';
import type { realmAboutThread, realmThread } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import type { TitleControlState } from '../../../services/main/src/modules/work/title-control.ts';
import { relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { startHomeStack } from './feed-read-support.ts';
import { arrange, local, threeWriteDebits, type Page, type Posted } from './zone-realm-discussion-support.ts';
import { personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { RealmAboutThreadStore } from '../../../services/main/src/modules/realm-reply/about-store.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';

test('about-post accepts supported RFC 5646 language extensions and preserves the author language on replay', async () => {
  const home = await startHomeStack('zone-realm-discussion-languages');
  try {
    const a = await arrange(home), page = await a.page('language-tags');
    for (const language of ['en-Latn-US-u-ca-gregory', 'de-CH-1901']) {
      const input = { ...a.input(page, a.author, `Contribution in ${language}`), language };
      const key = randomUUID();
      const posted = await home.json<Posted>(await home.call('POST',
        `/v1/realms/${local(a.realm.realm)}/about-posts`, input, home.author.token, key), 201);
      expect(await home.json(await home.call('POST', `/v1/realms/${local(a.realm.realm)}/about-posts`,
        input, home.author.token, key), 200)).toEqual(posted);
      const variant = await home.stack.contentPool.query(`SELECT v.language_tag,v.original_language_tag
        FROM content.reply r JOIN content.variant v ON v.id=r.variant_id WHERE r.id=$1`, [posted.reply]);
      expect(variant.rows).toEqual([{ language_tag: language, original_language_tag: language }]);
    }
  } finally { await home.stop(); }
}, 180_000);

test('a published Zone page opens one canonical discussion and preserves independent concurrent contributions', async () => {
  // Thread reads exercise the real projector: replay acknowledged envelopes
  // from zero rather than seeding a Main stream checkpoint with a graph cut.
  const home = await startHomeStack('zone-realm-discussion');
  try {
    const a = await arrange(home);
    const page = await a.page('first');
    const path = `/v1/realms/${local(a.realm.realm)}/about-posts`;
    const lookup = (about: string) => home.call('GET',
      `/v1/realms/${local(a.realm.realm)}/about-thread?${new URLSearchParams({ about })}`);
    const thread = async (reply: string) => {
      // Native title edits retain their outbox in receipt custody. Deliver it
      // through the same relay before the shared fixture runs the projector.
      for (let batch = 0; ; batch++) {
        if (batch === 400) throw new Error('Discussion relay exceeded its fixture budget');
        if (!await relayMainOutboxOnce(home.stack.fuseki, home.relay, home.deps.relayPosition.consumer,
          { ownerOutbox: home.stack.env.receiptCustody })) break;
      }
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
    await grantFixtureAuthority(home.stack.accessPool, { scope: editScope, requireDispatch: true,
      representations: [{ principalId: home.author.principalId, actor: a.author, action: 'work.edit', lifetime: '8 hours' }],
      grant: { actor: a.author, action: 'work.edit', lifetime: '8 hours' } });
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
      expect(winner).toMatchObject({ author: a.author, realm: a.realm.realm, about: concurrent.about });
      expect(child).toMatchObject({ author: a.reader, realm: a.realm.realm, about: concurrent.about });
      expect(await home.json(await a.post(concurrent, a.author, 'Concurrent opener', home.author.token, winnerKey), 200)).toEqual(winner);
      expect(await home.json(await a.post(concurrent, a.reader, 'Concurrent child', home.reader.token, childKey), 200)).toEqual(child);
      const contributions = await a.rows(concurrent.about);
      expect(contributions).toHaveLength(2);
      expect(contributions.filter(row => row.parent_reply === null)).toHaveLength(1);
      expect(contributions.find(row => row.reply === winner.reply)).toMatchObject({ author: a.author,
        origin_realm: a.realm.realm, root_revision: concurrent.targetRevision, body: { body: 'Concurrent opener' } });
      expect(contributions.find(row => row.reply === child.reply)).toMatchObject({ author: a.reader,
        origin_realm: a.realm.realm, parent_reply: winner.reply,
        root_revision: concurrent.targetRevision, body: { body: 'Concurrent child' } });
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
  const home = await startHomeStack('zone-realm-discussion-refused');
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
    // An ordinary author refusal creates no intent or stored terminal outcome.
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
    try { await refused(page, 403); }
    finally { await a.policy(a.realm.realm, 'open'); }

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

describe('ordinary fresh discussion refusals with real persona authority', () => {
  type PersonaPage = Page & { realm: string };
  let sessions: PersonaSessions;
  let pool: ReturnType<typeof boundedPool>;
  let graph: FusekiClient;
  let ownerPage: PersonaPage, moderatorPage: PersonaPage, operatorPage: PersonaPage;
  const short = local;
  const acting = (person: PersonaSession) => new URLSearchParams({ actingSubject: person.actingSubject! });
  async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
    const response = await request;
    const raw = await response.text();
    expect(response.status, `${response.status}: ${raw}`).toBe(status);
    return JSON.parse(raw) as T;
  }
  async function answerPage(fixture: PersonaSessions, segment: string): Promise<PersonaPage> {
  const owner = fixture.owner;
  const zoneRoot = `/v1/zones/${short(fixture.zone)}`;
  const work = await answer<{ work: string; mainVersion: string }>(
    owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      title: `Original discussion fixture ${segment}`,
      language: 'en',
      authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const contribution = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: work.work,
      language: 'en',
      body: 'An original fixture essay about attachment and discussion.',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution: contribution.contribution,
      expectedDraftHead: contribution.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  await answer(
    owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      work: work.work,
      contribution: contribution.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: work.mainVersion },
      selectionBasis: 'main-maintainer',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const navigation = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}?${acting(owner)}`),
  );
  const mount = await answer<{ revision: string }>(
    owner.main('POST', `${zoneRoot}/mounts`, {
      expectedHead: navigation.revision,
      target: work.work,
      routeSegment: segment,
      disclosure: 'public',
      actingSubject: owner.actingSubject,
    }),
  );
  // Every page bundle pins an original Zone home draft, credited to this steward.
  const prior = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
  );
  await answer(
    owner.main('PUT', `${zoneRoot}/configuration`, {
      expectedHead: prior.revision,
      prepareHomeDocument: true,
      actingSubject: owner.actingSubject,
    }),
  );
  const homeDocument = (
    await answer<{ configuration: { homeDocument: string } }>(
      owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
    )
  ).configuration.homeDocument;
  expect(homeDocument).toBeString();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{
    revisionId: string;
    byteDigest: string;
    sourcePosition: { dataEpoch: string };
  }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1',
      resourceId: homeDocument,
      variantId,
      expectedHead: null,
      document: fromPlainText('Original steward-authored discussion home.', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const config = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
  );
  await answer(
    owner.main('POST', `${zoneRoot}/site-publications`, {
      expectedHead: config.revision,
      routesRevision: mount.revision,
      navigationRevision: mount.revision,
      pages: [
        {
          page: homeDocument,
          variantId,
          revisionId: draft.revisionId,
          byteDigest: draft.byteDigest,
          contentEpoch: draft.sourcePosition.dataEpoch,
        },
      ],
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const route = await answer<{ revision: string; realm: string; resource: { id: string } }>(
    owner.main('GET', `${zoneRoot}/routes?path=%2F${segment}`),
  );
  expect(route.realm).toBe(fixture.realm);
  expect(route.resource.id).toBe(work.work);
  const header = await answer<{ revision: string }>(
    owner.main('GET', `/v1/works/${short(work.work)}?${acting(owner)}`),
  );
  return {
    realm: fixture.realm,
    zone: fixture.zone,
    about: work.work,
    targetRevision: header.revision,
    routeRevision: route.revision,
    path: `/${segment}`,
  };
}

  beforeAll(async () => {
    sessions = await personaSessions('public');
    pool = boundedPool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 2 });
    graph = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN);
    ownerPage = await answerPage(sessions, 'withdrawal');
    moderatorPage = await answerPage(sessions, 'review');
    operatorPage = await answerPage(sessions, 'operator');
    for (const page of [ownerPage, moderatorPage, operatorPage]) {
      page.routeRevision = (await answer<{ revision: string }>(sessions.visitor.main('GET',
        `/v1/zones/${short(page.zone)}/routes?${new URLSearchParams({ path: page.path })}`))).revision;
    }
  }, 240_000);
  afterAll(async () => { try { await sessions?.close(); } finally { await pool?.end(); } });

  async function state(page: PersonaPage) {
    const operations = (await pool.query(`SELECT id,reply,phase,terminal_refusal,terminal_outcome,
      placement_admission_id,placement_receipt FROM content.realm_about_post_operation
      WHERE realm=$1 AND about=$2 ORDER BY id`, [page.realm, page.about])).rows;
    const replies = (await pool.query(`SELECT r.id,r.author,r.root_target,r.root_revision,r.parent_reply,
      v.draft_head AS revision_id,body.body FROM content.reply r JOIN content.variant v ON v.id=r.variant_id
      JOIN content.revision body ON body.id=v.draft_head WHERE r.root_target=$1 ORDER BY r.id`, [page.about])).rows;
    const canonical = (await pool.query(`SELECT opener_reply,root_revision,state FROM content.realm_about_thread
      WHERE realm=$1 AND about=$2`, [page.realm, page.about])).rows;
    const placements = (await graph.query(`PREFIX rv: <${RV}> SELECT ?reply ?placement WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?placement a rv:RealmReplyPlacement ; rv:realm ${iri(page.realm)} ;
        rv:reply ?reply ; rv:rootTarget ${iri(page.about)} ; rv:placementOutcome rv:Accepted . }
    } LIMIT 16`)).results?.bindings ?? [];
    return { operations, replies, canonical, placements };
  }

  async function postWithState(person: PersonaSession, page: PersonaPage, text: string,
    key = randomUUID(), actor = person.actingSubject!) {
    // Observe the real locked intent decision as well as settled SQL/graph state.
    const refusalOwner = RealmAboutThreadStore.prototype, refuse = refusalOwner.refuseIntent;
    const refusals: { outcome: unknown; result: unknown }[] = [];
    refusalOwner.refuseIntent = async function (...args) {
      const result = await refuse.apply(this, args);
      refusals.push({ outcome: args[3], result });
      return result;
    };
    const { realm, ...coordinates } = page;
    const input = { profile: 'realm-about-post-v1', ...coordinates, actingSubject: actor,
      language: 'en', direction: 'ltr', body: text };
    try {
      const response = await person.main('POST', `/v1/realms/${short(realm)}/about-posts`, input, key, { settle: false });
      const body = await response.json();
      const settled = await state(page);
      return { status: response.status, body, refusals, settled };
    } finally { refusalOwner.refuseIntent = refuse; }
  }

  async function policy(mode: 'open' | 'mandatory') {
    const root = `/v1/realms/${short(sessions.realm)}/settings`;
    const current = await answer<{ generation: string; ruleBasis: { revision: string | null } }>(
      sessions.owner.main('GET', `${root}?${acting(sessions.owner)}`));
    await answer(sessions.owner.main('PUT', root, { expectedGeneration: current.generation,
      expectedRulesRevision: current.ruleBasis.revision, reason: 'Observe ordinary discussion authority boundaries',
      settings: { visibility: 'public', reviewMode: mode, reviewRequired: mode === 'mandatory',
        whoMaySubmit: 'members', selfJoin: true, rules: [] }, actingSubject: sessions.owner.actingSubject }), 201);
  }
  function absentSelection(answered: Awaited<ReturnType<typeof postWithState>>, expected: unknown) {
    expect(answered.refusals).toEqual([{ outcome: expected, result: { kind: 'absent' } }]);
    expect(answered.settled.operations).toHaveLength(0);
    expect(answered.settled.replies).toHaveLength(0);
    expect(answered.settled.canonical).toHaveLength(0);
    expect(answered.settled.placements).toHaveLength(0);
  }

  test('withdrawn attachment answers an ordinary basis refusal and preserves canonical contributions', async () => {
    const first = await postWithState(sessions.owner, ownerPage, 'Normal owner control');
    expect(first.status).toBe(201);
    const second = await postWithState(sessions.member, ownerPage, 'Independent member contribution');
    expect(second.status).toBe(201);
    const before = await state(ownerPage);
    let refused: Awaited<ReturnType<typeof postWithState>>;
    try {
      await answer(sessions.owner.main('POST', `/v1/zones/${short(sessions.zone)}/realm-attachment-withdrawals`, {
        realm: sessions.realm, actingSubject: sessions.owner.actingSubject }));
      refused = await postWithState(sessions.owner, ownerPage, 'After withdrawal');
    } finally {
      // A failed assertion or server response cannot withdraw the next case's basis.
      const config = await answer<{ revision: string }>(sessions.owner.main('GET',
        `/v1/zones/${short(sessions.zone)}/configuration?${acting(sessions.owner)}`));
      await answer(sessions.owner.main('PUT', `/v1/zones/${short(sessions.zone)}/configuration`, {
        expectedHead: config.revision, defaultRealm: sessions.realm, actingSubject: sessions.owner.actingSubject }));
    }
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'read_basis_changed' });
    expect(refused.refusals).toEqual([{ outcome: { kind: 'read-moved', message: 'Zone discussion basis changed' },
      result: { kind: 'absent' } }]);
    expect(refused.settled).toEqual(before);
    const lookup = await answer<{ thread: { reply: string } }>(sessions.visitor.main('GET',
      `/v1/realms/${short(sessions.realm)}/about-thread?${new URLSearchParams({ about: ownerPage.about })}`));
    expect(lookup.thread.reply).toBe(first.body.reply);
    const thread = await answer<{ items: { author: { id: string } }[] }>(sessions.visitor.main('GET',
      `/v1/realms/${short(sessions.realm)}/threads/${short(lookup.thread.reply)}`));
    expect(thread.items.map(item => item.author.id).sort()).toEqual(
      [sessions.owner.actingSubject!, sessions.member.actingSubject!].sort());
  }, 90_000);

  test('mandatory review refuses a joined moderator before selecting an intent', async () => {
    let refused: Awaited<ReturnType<typeof postWithState>>;
    try {
      await policy('mandatory');
      refused = await postWithState(sessions.moderator, moderatorPage, 'Requires review');
    } finally { await policy('open'); }
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'realm_reply_denied' });
    absentSelection(refused, { kind: 'reply-denied', message: 'Realm policy requires moderator approval' });
  }, 90_000);

  test('the operator can post as its own Person after an ordinary refusal without impersonating the owner', async () => {
    const key = randomUUID(), text = 'Operator as its own Person';
    let refused: Awaited<ReturnType<typeof postWithState>>;
    try {
      await policy('mandatory');
      refused = await postWithState(sessions.operator, operatorPage, text, key);
    } finally { await policy('open'); }
    // A fresh refusal is a request answer, not a stored terminal outcome for the key.
    const own = await postWithState(sessions.operator, operatorPage, text, key);
    const forged = await postWithState(sessions.operator, operatorPage,
      'Impersonation attempt', randomUUID(), sessions.owner.actingSubject!);
    expect(own.status).toBe(201);
    expect(own.body.author).toBe(sessions.operator.actingSubject!);
    expect(own.settled.operations).toMatchObject([{ phase: 'posted', terminal_refusal: false, terminal_outcome: null }]);
    expect(own.settled.replies).toMatchObject([{ author: sessions.operator.actingSubject! }]);
    expect(own.settled.placements).toHaveLength(1);
    expect(forged.status).toBe(403);
    expect(forged.settled).toEqual(own.settled);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'realm_reply_denied' });
    absentSelection(refused, { kind: 'reply-denied', message: 'Realm policy requires moderator approval' });
  }, 90_000);
});
