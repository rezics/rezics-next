import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { seed, type Population } from '../support/growth.ts';
import { axes, containerGrowthFixture, type Community, type ContainerGrowthFixture } from './growth-container-fixture.ts';

let f: ContainerGrowthFixture;
beforeAll(async () => {
  f = await containerGrowthFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function subject(type: string, scheme?: string) {
  const result = await f.call<{ subject: { id: string } }>('POST', '/v1/subjects', 201, f.owner, {
    type, labels: { en: 'Fixed board classification' },
    ...(scheme ? { statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }],
    } } : {}),
  });
  return result.subject.id;
}
async function adopt(selected: Community, scheme: string) {
  const { realm } = await f.call<{ realm: Community['realm'] & { boardSchemeId: string } }>(
    'PUT', `/v1/realms/${selected.realm.realmId}/boardScheme`, 200, f.owner,
    { schemeId: scheme }, selected.realm.headRevisionId,
  );
  expect(realm.boardSchemeId).toBe(scheme);
  selected.realm.headRevisionId = realm.headRevisionId;
}
async function create(selected: Community, concept: string) {
  const { board } = await f.call<{ board: { id: string; realmId: string } }>(
    'POST', `/v1/realms/${selected.realm.realmId}/boards`, 201, f.owner,
    { conceptId: concept, title: 'Fixed classified board', visibility: 'published' },
  );
  expect(board.realmId).toBe(selected.realm.realmId);
  return board.id;
}

for (const axis of axes) {
  test(`board scheme adoption, authority, creation and listing stay bounded with independent ${axis} growth`, async () => {
    const selected = await f.community('protected');
    const scheme = await subject('skos:ConceptScheme');
    await adopt(selected, scheme);
    const concepts = await Promise.all(Array.from({ length: 3 }, () => subject('skos:Concept', scheme)));
    const boards: string[] = [];
    for (const concept of concepts) boards.push(await create(selected, concept));
    boards.sort();
    // Each creation consumes an identical empty Realm. Allocate warm-up and measured
    // targets up front so the selected board neighborhood never grows with scale.
    const creationTargets: Community[] = [];
    for (let index = 0; index < 18; index++) {
      const target = await f.community('protected');
      await adopt(target, scheme);
      creationTargets.push(target);
    }
    const concept = await subject('skos:Concept', scheme);
    const schemeRoute = routeOf(scheme)!;
    const selectedRoute = routeOf(selected.realm.realmId)!;
    let revisionBase = 0;
    let series = 0;
    const grow = async (scale: number, previous: number) => {
      if (previous === 0) {
        series++;
        revisionBase = Number((await f.db.admin.query(
          'SELECT max(revision) AS revision FROM semantic.revision WHERE route=$1 AND subject_id=$2',
          [schemeRoute, scheme],
        )).rows[0].revision);
      }
      const population: Population = {
        name: `community-board-${selected.realm.realmId}-${axis}-${series}`,
        hotPartition: partitionOf(selectedRoute), hotShare: 1,
        rows({ route, ordinal }) {
          const transaction = crypto.randomUUID();
          const at = '2020-01-01T00:00:00.000Z';
          if (axis === 'history') return {
            'community.realm_revision': creationTargets.map(({ realm }) => ({
              route: routeOf(realm.realmId)!, realm_id: realm.realmId, revision_id: newId(routeOf(realm.realmId)!),
              predecessor: null, title: 'Retained scheme adoption', summary: '', visibility: 'protected',
              context_id: realm.contextId, board_scheme_id: scheme, created_at: at, author: f.owner.actor.accountId,
            })),
            'semantic.revision': [{
              route: schemeRoute, subject_id: scheme, revision: revisionBase + ordinal + 1,
              kind: 'identity', release: bundledDigest, recorded_transaction_id: transaction,
            }],
          };
          const space = newId(route), realm = newId(route), revision = newId(route), neighbour = newId(schemeRoute);
          return {
            'community.space': [{ route, space_id: space, state: 'active', head_revision_id: revision,
              created_at: at, creator: f.owner.actor.accountId }],
            'community.space_revision': [{ route, space_id: space, revision_id: revision, predecessor: null,
              title: 'Unrelated board host', summary: '', created_at: at, author: f.owner.actor.accountId }],
            'community.realm': [{ route, realm_id: realm, space_id: space, state: 'active', visibility: 'protected',
              context_id: GLOBAL_CONTEXT, head_revision_id: revision, created_at: at, creator: f.owner.actor.accountId }],
            'community.realm_revision': [{ route, realm_id: realm, revision_id: revision, predecessor: null,
              title: 'Unrelated board Realm', summary: '', visibility: 'protected', context_id: GLOBAL_CONTEXT,
              created_at: at, author: f.owner.actor.accountId }],
            'semantic.subject': [{ route: schemeRoute, subject_id: neighbour,
              type: 'skos:ConceptScheme', recorded_transaction_id: transaction }],
            'semantic.revision': [{ route: schemeRoute, subject_id: neighbour, revision: 1,
              kind: 'create', release: bundledDigest, recorded_transaction_id: transaction }],
            'content.board': [{ route, board_id: newId(route), subject_id: neighbour, realm_id: realm,
              title: 'Unrelated board', visibility: 'published', security_revision: 1,
              recorded_transaction_id: transaction, created_at: at }],
          };
        },
      };
      await seed(f.db, population, { from: previous, to: scale });
      const count = await f.db.admin.query<{ count: number }>(axis === 'history'
        ? 'SELECT count(*)::integer AS count FROM semantic.revision WHERE route=$1 AND subject_id=$2'
        : 'SELECT count(*)::integer AS count FROM content.board WHERE route BETWEEN $1 AND $1+15 AND realm_id<>$2',
      [axis === 'history' ? schemeRoute : partitionOf(selectedRoute) * 16,
        axis === 'history' ? scheme : selected.realm.realmId]);
      expect(count.rows[0]!.count).toBeGreaterThanOrEqual(scale);
    };
    await f.measure('community board scheme adoption and current read', selected, axis, async () => {
      const previous = selected.realm.headRevisionId;
      await adopt(selected, scheme);
      expect(selected.realm.headRevisionId).not.toBe(previous);
      const { realm } = await f.call<{ realm: Community['realm'] & { boardSchemeId: string } }>(
        'GET', `/v1/realms/${selected.realm.realmId}`, 200,
      );
      expect(realm).toMatchObject({ boardSchemeId: scheme, headRevisionId: selected.realm.headRevisionId });
    }, grow);
    let targetIndex = 0;
    await f.measure('community board creation and native read', selected, axis, async () => {
      const target = creationTargets[targetIndex++];
      if (!target) throw new Error('Missing prepared board creation target');
      const board = await create(target, concept);
      const { items, next } = await f.call<{ items: { id: string }[]; next: string | null }>(
        'GET', `/v1/realms/${target.realm.realmId}/boards?limit=2`, 200,
      );
      expect(items.map(({ id }) => id)).toEqual([board]);
      expect(next).toBeNull();
    }, grow);
    expect(targetIndex).toBe(18);
    await f.measure('community current board scheme authority and fixed board page', selected, axis, async () => {
      const before = selected.realm.headRevisionId;
      for (const [method, path, body] of [
        ['PUT', `/v1/realms/${selected.realm.realmId}/boardScheme`, { schemeId: scheme }],
        ['POST', `/v1/realms/${selected.realm.realmId}/boards`, { conceptId: concept,
          title: 'Refused board', visibility: 'published' }],
      ] as const) {
        const denied = await f.call(method, path, 403, f.outsider, body, method === 'PUT' ? before : undefined);
        expect(denied).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
      }
      await f.call('GET', `/v1/realms/${selected.realm.realmId}/boards?limit=2`, 404, f.outsider);
      const { items, next } = await f.call<{ items: { id: string }[]; next: string | null }>(
        'GET', `/v1/realms/${selected.realm.realmId}/boards?limit=2`, 200,
      );
      expect(items.map(({ id }) => id)).toEqual(boards.slice(0, 2));
      expect(next).toBeString();
      const tail = await f.call<{ items: { id: string }[]; next: string | null }>(
        'GET', `/v1/realms/${selected.realm.realmId}/boards?limit=2&cursor=${encodeURIComponent(next!)}`, 200,
      );
      expect(tail.items.map(({ id }) => id)).toEqual(boards.slice(2));
      expect(tail.next).toBeNull();
      const { realm } = await f.call<{ realm: Community['realm'] }>('GET', `/v1/realms/${selected.realm.realmId}`, 200);
      expect(realm.headRevisionId).toBe(before);
    }, grow);
  }, 600_000);
}
