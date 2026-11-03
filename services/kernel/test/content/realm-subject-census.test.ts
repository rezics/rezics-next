import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createRealmSubjectCensus } from '../../src/content/realm-subject-census.ts';
import {
  createRealmSubjectCandidates,
  type RealmSubjectCandidate,
} from '../../src/content/realm-subject-candidates.ts';
import { createRealmSubjectSource } from '../../src/content/realm-subject-source.ts';
import { ScopeWork, scopeAllowance } from '../../src/search/scope-execution.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { realmBoardWorld } from './realm-board-create-support.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;
beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);
afterAll(async () => {
  await world?.close();
});
const deadline = () => Date.now() + 60_000;

async function drain(route: number) {
  const census = createRealmSubjectCensus(world.db.pool);
  for (let step = 0; step < 520; step++) if ((await census.step(route, deadline())) === 'exhausted') return;
  throw new Error('Finite native census did not exhaust');
}

test.serial(
  'native discussion and review openings export exact originals; replies and post-cut threads do not enter the cut',
  async () => {
    const board = (await world.board()).value.board;
    const reviewConcept = await world.subject('skos:Concept', world.schemeId);
    const reviews = await world.checked('POST', `/v1/realms/${world.realm.realmId}/boards`, {
      conceptId: reviewConcept,
      title: 'Reviews',
      visibility: 'published',
      purpose: 'reviews',
    });
    const first = await world.subject('schema:CreativeWork');
    const second = await world.subject('schema:CreativeWork');
    const replyOnly = await world.subject('schema:CreativeWork');
    async function thread(boardId: string, kind: 'discussion' | 'review', subjectIds: string[]) {
      return world.checked('POST', '/v1/threads', {
        boardId,
        kind,
        title: 'Native structural provenance',
        body: fromPlainText('An opening.'),
        licence: 'MIT',
        visibility: 'published',
        subjectIds,
      });
    }
    const discussion = await thread(board.id, 'discussion', [first, second]);
    const review = await thread(reviews.board.id, 'review', [first]);
    await world.checked('POST', `/v1/threads/${discussion.thread.id}/posts`, {
      body: fromPlainText('A reply is not an opening.'),
      licence: 'MIT',
      subjectIds: [replyOnly],
    });
    const census = createRealmSubjectCensus(world.db.pool);
    const routes = [...new Set([routeOf(discussion.thread.id)!, routeOf(review.thread.id)!])];
    const cuts = await Promise.all(routes.map((route) => census.capture(route, deadline())));
    const later = await thread(reviews.board.id, 'review', [second]);
    for (const route of routes) await drain(route);
    const rows = (
      await world.db.admin.query(
        `SELECT original_id,thread_id,opening_id,revision_id,kind
    FROM content.realm_subject_candidate WHERE route=$1 AND realm_id=$2 ORDER BY thread_id,original_id`,
        [routeOf(world.realm.realmId), world.realm.realmId],
      )
    ).rows;
    expect(
      rows
        .filter((r) => r.thread_id === discussion.thread.id)
        .map((r) => r.original_id)
        .sort(),
    ).toEqual([first, second].sort());
    expect(rows.filter((r) => r.thread_id === review.thread.id).map((r) => r.original_id)).toEqual([first]);
    expect(rows.some((r) => r.original_id === replyOnly || r.thread_id === later.thread.id)).toBe(false);
    expect(rows.every((r) => r.opening_id && r.revision_id)).toBe(true);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['discussion', 'review']));
    for (const cut of cuts) {
      expect((await census.observe(cut.route, deadline()))?.exhausted).toBe(true);
      expect(await census.capture(cut.route, deadline())).toEqual(cut);
    }
    const store = createRealmSubjectCandidates(world.db.pool);
    const actual = await store.thread(world.realm.realmId, discussion.thread.id, null, deadline());
    expect(actual).toHaveLength(2);
    expect(actual.every((c) => c.opening === rows.find((r) => r.thread_id === c.thread)!.opening_id)).toBe(true);
    // A completed structural cut cannot fabricate the separately owned capabilities.
    const reader = {
      actor: { kind: 'anonymous' as const },
      access: world.kernel.testAccess,
      routeKey: world.routeKey,
      deadline: deadline(),
    };
    expect(
      await createRealmSubjectSource({ pool: world.db.pool }).resolve(
        world.realm.realmId,
        reader,
        new ScopeWork(scopeAllowance(32, 'structural-only')),
      ),
    ).toEqual({ state: 'unavailable' });
  },
);

test.serial(
  'live removal fences defeat delayed census, preserve bigint positions and replay without changing coverage',
  async () => {
    const store = createRealmSubjectCandidates(world.db.pool);
    const realm = world.realm.realmId;
    const thread = newId(0x1234),
      original = newId(0x2345);
    const candidate: RealmSubjectCandidate = {
      realm,
      thread,
      original,
      terminal: original,
      identityEpoch: '9007199254740993',
      opening: newId(0x1234),
      revision: newId(0x1234),
      board: newId(routeOf(realm)!),
      kind: 'review',
      active: false,
    };
    const version = { epoch: 1, position: '9007199254740997' };
    expect(await store.fence(realm, thread, version, deadline())).toBe(true);
    expect(await store.write(candidate, version, 'live', deadline())).toBe(true);
    const coverage = await store.observe(realm, deadline());
    expect(await store.write({ ...candidate, active: true }, { epoch: 1, position: '2' }, 'baseline', deadline())).toBe(
      false,
    );
    expect(await store.fence(realm, thread, { epoch: 1, position: '9007199254740996' }, deadline())).toBe(false);
    expect(await store.write(candidate, version, 'live', deadline())).toBe(false);
    expect(await store.observe(realm, deadline())).toEqual(coverage);
    expect((await store.thread(realm, thread, null, deadline()))[0]).toEqual(candidate);
    const row = (
      await world.db.admin.query(
        `SELECT source_position::text AS position FROM content.realm_subject_candidate
    WHERE route=$1 AND realm_id=$2 AND original_id=$3 AND thread_id=$4`,
        [routeOf(realm), realm, original, thread],
      )
    ).rows[0];
    expect(row.position).toBe(version.position);
  },
);
