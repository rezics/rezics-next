import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startHomeStack, type HomeStack } from './feed-read-support.ts';
import { seedSavedView } from './g-984-saved-view-support.ts';
import { acceptClassifiedWork, discloseConcept, shareClassifiedConcepts,
  type ClassifiedConcept, type ConceptContext } from './work-classification.ts';
import { SavedViewNotifications } from '../../../services/main/src/modules/notification-producers/saved-views.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { discloseNotifications } from '../../../services/main/src/modules/disclosure/notifications.ts';

// Each test is a bounded stage of one owner journey. Each operation group keeps
// Bun's default deadline. The fixture hook is longer: accepting a Concept is
// several commands.
describe('G-965 Concept and saved-view owner journey', () => {
  let home: HomeStack;
  let seeded: Awaited<ReturnType<typeof seedSavedView>>;
  let service: SavedViewNotifications;
  let term: ClassifiedConcept;
  let concepts: ConceptContext;
  let conceptFollow: { revision: string; level: string };
  let conceptView: string;
  let postPlacement: string;
  let postEvent: { id: string; type: string; data: { receipt: { placement: string } } };
  let saved: { id: string };
  let savedFollow: { revision: string; level: string };
  const follow = async (target: string, expectedRevision: string | null, extra = {}) => home.json<{ revision: string; level: string }>(
    await home.call('POST', '/v1/follows', { profile: 'follow-command-v1', target,
      actingSubject: seeded.reader, following: true, expectedRevision, ...extra }, home.reader.token));
  const items = async (view: string, ref: string) => (await home.stack.accessPool.query<{ id: string }>(`
    SELECT id FROM access.notification_item WHERE principal_id=$1 AND subject_ref=$2 AND subject_revision=$3`,
  [home.reader.principalId, view, ref])).rows;
  const workEvent = (work: string) => ({ id: `urn:rezics:event:${randomUUID()}`,
    type: 'com.rezics.work.created.v1', data: { receipt: { work } } });
  const input = () => ({ principalId: home.reader.principalId, owner: 'access', ref: saved.id,
    revision: postPlacement, disclosureBasis: 'saved-view-post-v1' });
  const send = (method: string, path: string, body?: unknown) => home.call(method, path, body, home.author.token);
  const accept = (work: string, mainVersion: string) => acceptClassifiedWork(
    send, home.json, home.author.actor, { mainVersion }, term, concepts);

  // Recording the Concept is a context, a statement and a decision. That fixture
  // no longer fits the default five-second hook; each test keeps that deadline.
  beforeAll(async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
    home = await startHomeStack('g-965-saved-views');
    await grantRecordedPlatformUse(home.stack.accessPool, home.reader.principalId, ['saved-views']);
    seeded = await seedSavedView(home);
    const { stack, call, json } = home;
    const store = new NotificationStore(stack.accessPool);
    service = new SavedViewNotifications(stack.accessPool,
      { ...home.deps, judgments: new AccessJudgments(stack.accessPool) }, store);
    await home.author.grant('classification:define:global', 'classification.proposition.define');
    await home.author.grant('context:create:root', 'context.create');
    await home.author.grant(`statement:speak:${home.author.actor}`, 'statement.record');
    await home.author.grant('classification:decide:global', 'statement.decide');
    term = await json<ClassifiedConcept>(await call('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label: 'G965 followed topic', actingSubject: home.author.actor }, home.author.token), 201);
    concepts = await shareClassifiedConcepts(send, json, home.author.actor, [term]);
    await discloseConcept(stack.accessPool, home.author.principal, home.author.actor, term.concept);
    await accept(seeded.work.work, seeded.work.mainVersion);
    postPlacement = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?placement WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?slot rv:reply ${iri(seeded.discussion.reply)} ; rv:replyPlacementHead ?placement }
    } LIMIT 2`)).results!.bindings[0]!.placement!.value;
    postEvent = { id: `urn:rezics:event:${randomUUID()}`, type: 'com.rezics.realm.reply-placed.v1',
      data: { receipt: { placement: postPlacement } } };
  }, 20_000);
  afterAll(async () => { if (home) await home.stop(); });

  test('Concept follows default to Off', async () => {
    conceptFollow = await follow(term.concept, null);
    expect(conceptFollow.level).toBe('off');
    conceptView = (await home.stack.accessPool.query<{ id: string }>(`
      SELECT id FROM access.saved_filter WHERE principal_id=$1 AND concept=$2`,
    [home.reader.principalId, term.concept])).rows[0]!.id;
  });
  test.each(['off', 'highlights', 'all'] as const)('Concept level %s admits current sources and replays once', async (level) => {
    if (level !== 'off') conceptFollow = await follow(term.concept, conceptFollow.revision, { level });
    const work = await home.stack.publicWork(seeded.author, ['en'], `G965 ${level}`);
    await accept(work.work, work.mainVersion);
    const envelope = workEvent(work.work);
    await service.run(envelope);
    expect((await items(conceptView, work.work)).length).toBe(level === 'off' ? 0 : 1);
    await service.run(envelope);
    expect((await items(conceptView, work.work)).length).toBe(level === 'off' ? 0 : 1);
    // One source per level exercises the current follow SQL without reusing
    // a completed matching page after the recipient's choice changes.
    await service.run({ ...postEvent, id: `${postEvent.id}:${level}` });
    expect((await items(conceptView, postPlacement)).length).toBe(level === 'all' ? 1 : 0);
  });

  test('Saved views default to Off, All admits posts, and disclosure retains the native recipient', async () => {
    const { stack, call, json } = home;
    saved = await json<{ id: string }>(await call('POST', '/v1/me/saved-filters', {
      profile: 'saved-filter-create-v1', actingSubject: seeded.reader, context: 'global',
      name: 'G965 English topic', pinned: true,
      filter: { all: [{ facet: 'concept', any: [term.concept] }, { facet: 'language', any: ['en'] }] },
    }, home.reader.token), 201);
    savedFollow = await follow(`urn:rezics:saved-view:${saved.id}`, null);
    expect(savedFollow.level).toBe('off');
    await service.run({ ...postEvent, id: `${postEvent.id}:saved-off` });
    expect(await items(saved.id, postPlacement)).toHaveLength(0);
    savedFollow = await follow(`urn:rezics:saved-view:${saved.id}`, savedFollow.revision, { level: 'all' });
    await service.run({ ...postEvent, id: `${postEvent.id}:saved-all` });
    expect(await items(saved.id, postPlacement)).toHaveLength(1);
    const resolved = await service.resolve(input());
    expect(resolved).toMatchObject({ status: 'available', subject: { fields: { linkTarget: seeded.discussion.reply } } });
    expect(await discloseNotifications(stack.accessPool, [{ input: input(), result: resolved }], 'inbox')).toMatchObject([{ status: 'available' }]);
    expect(await service.resolve({ ...input(), principalId: home.author.principalId })).toEqual({ status: 'undisclosed' });
  });

  test('Saved-view Conditions are conjunctive: a matching Concept cannot admit another language', async () => {
    const { call, json } = home;
    // A matching Concept alone cannot admit a different language.
    const japanese = await json<{ id: string }>(await call('POST', '/v1/me/saved-filters', {
      profile: 'saved-filter-create-v1', actingSubject: seeded.reader, context: 'global',
      name: 'G965 Japanese topic', pinned: false,
      filter: { all: [{ facet: 'concept', any: [term.concept] }, { facet: 'language', any: ['ja'] }] },
    }, home.reader.token), 201);
    await follow(`urn:rezics:saved-view:${japanese.id}`, null, { level: 'all' });
    await service.run({ ...postEvent, id: `${postEvent.id}:two-conditions` });
    expect(await items(japanese.id, postPlacement)).toHaveLength(0);
  });

  test('Matching crosses every saved-view page and completed replay creates no extra intent', async () => {
    const { stack, call, json } = home;
    // The same native follower can exceed one raw matching page. Every saved
    // view is reached; replaying a completed source creates no extra intent.
    const many: string[] = [];
    for (let n = 0; n < 10; n++) {
      const view = await json<{ id: string }>(await call('POST', '/v1/me/saved-filters', {
        profile: 'saved-filter-create-v1', actingSubject: seeded.reader, context: 'global',
        name: `G965 catalogue ${n}`, pinned: false,
        filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] },
          { facet: 'language', any: ['en'] }] },
      }, home.reader.token), 201);
      many.push(view.id);
      await follow(`urn:rezics:saved-view:${view.id}`, null, { level: 'all' });
    }
    const pagedWork = await stack.publicWork(seeded.author, ['en'], 'G965 matching pages');
    const pagedEvent = workEvent(pagedWork.work);
    const first = await service.run(pagedEvent);
    expect(first.complete).toBe(false);
    expect(first.produced).toBeLessThanOrEqual(8);
    expect((await service.run(pagedEvent)).complete).toBe(true);
    for (const view of many) expect(await items(view, pagedWork.work)).toHaveLength(1);
    expect(await service.run(pagedEvent)).toEqual({ complete: true, produced: 0 });
  });

  test('Current Off choices and private Realms revoke queued post disclosure', async () => {
    const { stack } = home;
    savedFollow = await follow(`urn:rezics:saved-view:${saved.id}`, savedFollow.revision, { level: 'off' });
    expect(await service.resolve(input())).toEqual({ status: 'undisclosed' });
    await follow(`urn:rezics:saved-view:${saved.id}`, savedFollow.revision, { level: 'all' });
    // Content still exists, but a private Realm no longer discloses this post.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(seeded.realm.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(seeded.realm.space)} rv:disclosure rv:Private } } WHERE {}`);
    expect(await service.resolve(input())).toEqual({ status: 'undisclosed' });
  });
});
