import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  RankingGenerations,
  RANKING_PROFILE,
  type RankingBasis,
} from '../../../services/main/src/modules/recommendation/ranking.ts';
import {
  MANAGE_ACTION,
  MANAGE_SCOPE,
  RecommendationMissing,
  RecommendationDenied,
} from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import {
  grantAgent,
  nativeId,
  requireQa,
  retainBatch,
  slotOf,
} from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

test('G939: public ranking pages reuse admitted scores and fence generation movement', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'relay'], 'privileged');
  const access = new Pool({ connectionString: owners.urls.access }),
    relay = new Pool({ connectionString: owners.urls.relay });
  try {
    const user = { id: randomUUID(), email: 'g939@example.test', password: '', cookie: '' },
      issuer = `g939-${randomUUID()}`;
    const operator = await grantAgent(access, issuer, user, MANAGE_SCOPE, MANAGE_ACTION);
    const manager = { principal: { issuer, subject: user.id }, actingSubject: operator.agent };
    const dataEpoch = randomUUID(),
      high = nativeId(),
      low = nativeId();
    const store = new RankingGenerations({
      access,
      relay,
      dataEpoch,
      cursorKey: randomBytes(32),
      canReadWork: async () => {
        throw new Error('Public candidates must go through public resource disclosure');
      },
    });
    const basis: RankingBasis = {
      profile: RANKING_PROFILE,
      population: { kind: 'public' },
      candidateGrain: 'work',
      semantic: null,
    };
    const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: '0'.repeat(64) });
    const ready = async () => {
      const generation = (await store.registerBuild(manager, basis, 4, receipt())).generation;
      const epoch = await store.claim(generation);
      for (let batch = 0; batch < 20; batch++)
        if (!(await store.runBatch(generation, epoch)).relayBatches) break;
      expect((await store.finish(generation, epoch)).state).toBe('ready');
      return generation;
    };
    await expect(
      store.page({ public: true, principal: null, actingSubject: null }, basis, 1),
    ).rejects.toBeInstanceOf(RecommendationMissing);
    await retainBatch(
      relay,
      dataEpoch,
      1,
      [
        {
          work: high,
          realm: nativeId(),
          slot: slotOf(randomUUID()),
          observation: nativeId(),
          value: 9,
        },
        {
          work: low,
          realm: nativeId(),
          slot: slotOf(randomUUID()),
          observation: nativeId(),
          value: 3,
        },
      ],
      { access, principalId: operator.principalId, actingSubject: operator.agent },
    );
    const generation = await ready(),
      active = await store.activate(manager, generation, null, receipt());
    const first = await store.page(
      { public: true, principal: null, actingSubject: null },
      basis,
      1,
    );
    expect(first.items).toEqual([{ candidate: high }]);
    expect(first.continuation).not.toBeNull();
    const next = await store.page(
      { public: true, principal: null, actingSubject: null },
      basis,
      1,
      first.continuation!,
    );
    expect(next.items).toEqual([{ candidate: low }]);
    expect(next.continuation).toBeNull();
    await store.activate(manager, await ready(), active.headRevision, receipt());
    // The existing owner retains immutable superseded generations for cursors.
    expect(
      (
        await store.page(
          { public: true, principal: null, actingSubject: null },
          basis,
          1,
          first.continuation!,
        )
      ).items,
    ).toEqual([{ candidate: low }]);
    await expect(
      store.page(
        { public: true, principal: null, actingSubject: null },
        { ...basis, population: { kind: 'personal' } },
        1,
      ),
    ).rejects.toBeInstanceOf(RecommendationDenied);
  } finally {
    await Promise.all([access.end(), relay.end()]);
    await owners.close();
  }
}, 120_000);
