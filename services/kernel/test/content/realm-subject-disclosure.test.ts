import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { AccessWorkAccounting } from '../../src/access/work.ts';
import { prepareRealmSubjectDisclosure, type RealmSubjectCandidate } from '../../src/content/realm-subject-disclosure.ts';
import { routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase, type ReactionRelayBase, type CreatedRealmTarget } from './reaction-relay-convergence-fixture.ts';

type World = ReactionRelayBase;
const candidate = (world: World, target: CreatedRealmTarget): RealmSubjectCandidate => ({
  threadId: target.threadId, openingPostId: target.postId, subjectId: world.conceptId,
});
async function prepare(world: World, target: CreatedRealmTarget, bearer?: string, keys = [candidate(world, target)]) {
  const deadline = Date.now() + 30_000;
  const work = new AccessWorkAccounting({ reserve: () => ({ settle() {} }) }, deadline);
  const actor = bearer
    ? await world.system.access.authenticate(bearer, { pool: world.system.database.pool, deadline })
    : { kind: 'anonymous' as const };
  const disclosure = await prepareRealmSubjectDisclosure({
    pool: world.system.database.pool, access: world.system.access,
  }, { realmId: target.realmId, candidates: keys }, { actor, deadline, work });
  return { disclosure, work };
}
async function link(world: World, target: CreatedRealmTarget, ids = [world.conceptId]) {
  const post = await world.call('GET', `/v1/posts/${target.postId}`, { bearer: world.author.bearer });
  expect(post.response.status, post.text).toBe(200);
  await world.command('POST', `/v1/posts/${target.postId}/revisions`, {
    body: fromPlainText('Current opening evidence'), licence: 'CC0-1.0', subjectIds: ids,
  }, { headers: { 'if-match': JSON.stringify(post.value!.post.revisionId) }, expectedStatus: 200 });
}

test('current exact openings disclose aligned discussion and review evidence, never census coverage', async () => {
  const world = await createReactionRelayBase();
  try {
    const target = world.mainTarget;
    await link(world, target);
    const reviews = await world.command('POST', `/v1/realms/${target.realmId}/boards`, {
      conceptId: world.conceptId, title: 'Native reviews', purpose: 'reviews', visibility: 'published',
    });
    const review = await world.command('POST', '/v1/threads', {
      title: 'Native review', kind: 'review', boardId: reviews.board.id, visibility: 'published',
      body: fromPlainText('Review opening'), licence: 'CC0-1.0', subjectIds: [world.conceptId],
    });
    const keys = [candidate(world, target), {
      threadId: review.thread.id, openingPostId: review.thread.firstPost.id, subjectId: world.conceptId,
    }];
    const { disclosure, work } = await prepare(world, target, undefined, keys);
    const evidence = await disclosure.finish();
    expect(evidence.map((entry) => entry.state)).toEqual(['positive', 'positive']);
    expect(await disclosure.finish()).toBe(evidence);
    for (const entry of evidence) if (entry.state === 'positive') {
      expect(entry.freshness.before).toBe(entry.freshness.final);
      expect(entry.freshness.anchors.length).toBeGreaterThan(0);
    }
    expect(work.usage().keys).toBeGreaterThan(0);
    expect(work.usage().points).toBeGreaterThan(0);
    expect(JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? String(value) : value))
      .not.toContain(target.threadId);
    await link(world, target, []);
    expect(await (await prepare(world, target)).disclosure.finish()).toEqual([{ state: 'absent' }]);
    const otherRealm = await world.createRealmTarget('Other native placement', 'public');
    expect(await (await prepare(world, otherRealm, undefined, [candidate(world, target)])).disclosure.finish())
      .toEqual([{ state: 'absent' }]);
  } finally { await world.system.close(); }
}, 180_000);

test('protected grants and public Realm bans apply before and at final disclosure', async () => {
  const world = await createReactionRelayBase();
  try {
    const target = await world.createRealmTarget('Protected evidence', 'public', 'protected');
    await link(world, target);
    expect(await (await prepare(world, target)).disclosure.finish()).toEqual([{ state: 'withheld' }]);
    expect((await (await prepare(world, target, world.author.bearer)).disclosure.finish())[0]?.state).toBe('positive');
    const grant = {
      resource: { route: target.boardRoute, id: target.boardId },
      subject: { kind: 'account', id: world.other.accountId }, actions: ['board:read'], valid: '(,)',
    };
    await world.command('POST', '/v1/grants', grant);
    expect((await (await prepare(world, target, world.other.bearer)).disclosure.finish())[0]?.state).toBe('positive');
    const pending = await prepare(world, target, world.other.bearer);
    await world.command('POST', '/v1/grants:revoke', grant, { expectedStatus: 200 });
    expect(await pending.disclosure.finish()).toEqual([{ state: 'withheld' }]);
    const publicTarget = world.mainTarget;
    await link(world, publicTarget);
    const beforeBan = await prepare(world, publicTarget, world.other.bearer);
    await world.command('PUT', `/v1/realms/${publicTarget.realmId}/bans/${world.other.accountId}`,
      { reason: 'Current native ban' }, { expectedStatus: 200 });
    expect(await beforeBan.disclosure.finish()).toEqual([{ state: 'withheld' }]);
    expect(await (await prepare(world, publicTarget, world.other.bearer)).disclosure.finish())
      .toEqual([{ state: 'withheld' }]);
  } finally { await world.system.close(); }
}, 180_000);

test('final source changes suppress old evidence and unavailable work never becomes absence', async () => {
  const world = await createReactionRelayBase();
  try {
    const target = world.mainTarget;
    await link(world, target);
    const beforeWithdrawal = await prepare(world, target);
    await link(world, target, []);
    expect(await beforeWithdrawal.disclosure.finish()).toEqual([{ state: 'withheld' }]);
    await link(world, target);
    const beforeHide = await prepare(world, target);
    await world.system.database.pool.query(
      "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [target.boardRoute, target.boardId],
    );
    expect(await beforeHide.disclosure.finish()).toEqual([{ state: 'withheld' }]);
    await world.system.database.pool.query(
      "UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [target.boardRoute, target.boardId],
    );
    expect((await (await prepare(world, target)).disclosure.finish())[0]?.state).toBe('positive');
    const beforeSubject = await prepare(world, target);
    await world.system.database.pool.query(
      "UPDATE semantic.subject SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(world.conceptId), world.conceptId],
    );
    expect(await beforeSubject.disclosure.finish()).toEqual([{ state: 'withheld' }]);
    const deadline = Date.now() + 30_000;
    const work = new AccessWorkAccounting({ reserve: () => null }, deadline);
    const refused = await prepareRealmSubjectDisclosure({ pool: world.system.database.pool, access: world.system.access },
      { realmId: target.realmId, candidates: [candidate(world, target)] },
      { actor: { kind: 'anonymous' }, deadline, work });
    expect(await refused.finish()).toEqual([{ state: 'unknown' }]);
    await expect(prepareRealmSubjectDisclosure({ pool: world.system.database.pool, access: world.system.access },
      { realmId: target.realmId, candidates: Array(9).fill(candidate(world, target)) },
      { actor: { kind: 'anonymous' }, deadline, work })).rejects.toBeInstanceOf(RangeError);
  } finally { await world.system.close(); }
}, 180_000);
