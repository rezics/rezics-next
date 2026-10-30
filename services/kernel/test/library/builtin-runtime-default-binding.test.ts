import { expect, test } from 'bun:test';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { createReleasedLibraryPopulation } from './support/released-library-population.ts';
import { discoveryKey } from '../support/released-discovery.ts';

// Positive nonempty, session-only and reaction-only outcomes remain in the existing frozen user-case suites.
// This native fault case exercises the real default API with its current Source deliberately unavailable.
test('default owner readers fail explicitly when current canonical execution is unavailable and GET materializes no source', async () => {
  const world = await createReleasedLibraryPopulation();
  try {
    const state = await world.state();
    await world.sessions();
    const liked = await world.request(
      'alice',
      'PUT',
      `/v1/subjects/${state.subject.id}/reaction`,
      { kind: 'like' },
      discoveryKey(),
    );
    expect(liked.status).toBe(200);
    const account = world.base.personas.alice.accountId;
    const everything = builtinCollectionId(account, { kind: 'everything' });
    const likedId = builtinCollectionId(account, { kind: 'liked' });
    const stateId = builtinCollectionId(account, {
      kind: 'state',
      profileId: state.accepted.pin.profileId,
      stateSetId: state.accepted.profile.entryStateSet!.id,
      stateId: state.entry.state,
    });
    // Remove only the derived ready head, never native facts, permissions, identity or accepted meaning.
    await world.base.inspect('DELETE FROM library.canonical_source_head WHERE collection_id=ANY($1::uuid[])', [
      [everything, likedId, stateId],
    ]);
    const snapshot = () =>
      world.base.inspect(
        `SELECT 'collection' AS kind,to_jsonb(c) AS value FROM library.collection c WHERE curator_account_id=$1
      UNION ALL SELECT 'canonical_head',to_jsonb(h) FROM library.canonical_source_head h WHERE collection_id=ANY($2::uuid[])
      ORDER BY kind,value`,
        [account, [everything, likedId, stateId]],
      );
    const before = await snapshot();
    for (const path of [
      `/v1/collections/${everything}/members`,
      `/v1/collections/${stateId}/members`,
      `/v1/collections/${likedId}/members`,
      '/v1/libraryContinue',
    ]) {
      const response = await world.request('alice', 'GET', path);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(['dependency_unavailable', 'semantic_not_ready']).toContain(String(response.body.code));
      expect(response.body).not.toHaveProperty('members');
      expect(response.body).not.toHaveProperty('subjects');
      expect(response.body).not.toHaveProperty('next');
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect((await snapshot()).rows).toEqual(before.rows);
  } finally {
    await world.close();
  }
}, 180_000);
