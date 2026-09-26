import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { MANAGE_ACTION, MANAGE_SCOPE, RecommendationMissing }
  from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RANKING_PROFILE, RankingGenerations, type RankingBasis }
  from '../../../services/main/src/modules/recommendation/ranking.ts';
import { verifyRankingSemanticBasis } from '../../../services/main/src/modules/recommendation/semantic-basis.ts';
import { graphZeroCandidates, graphZeroSnapshot }
  from '../../../services/main/src/modules/recommendation/zero-candidates.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

test('REC01/REC05: current private Context selection gates an eligible zero-score Work', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const work = await f.work('Recommendation zero-score candidate');
    const object = work.work;
    await f.grant('context:create:root', 'context.create');
    const create = { profile: 'context-v1', role: 'shared', disclosure: 'private', base: null,
      entries: [{ target: object, relation: `${RV}classifiedAs`, state: 'defined',
        definition: nativeId(), applicability: [] }], actingSubject: f.actorA };
    const key = randomUUID();
    let response = await f.call('POST', '/v1/contexts', create, key);
    for (let attempt = 0; response.status === 202 && attempt < 4; attempt++) {
      response = await f.call('POST', '/v1/contexts', create, key);
    }
    const context = await f.json<{ context: string; semanticRevision: string }>(response,
      response.status === 200 ? 200 : 201);
    const readGrant = await f.grant(`context:read:${context.context}`, 'context.read');
    await f.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await f.grant(`work:read:${object}`, 'work.read');
    const selected = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: context.context, semanticRevision: context.semanticRevision },
      expectedRevision: null, actingSubject: f.actorA }), 201);
    const principal = { issuer: f.account.issuer, subject: f.account.a.id };
    const viewer = { principal, actingSubject: f.actorA };
    const basis: RankingBasis = { profile: RANKING_PROFILE, population: { kind: 'personal' },
      candidateGrain: 'work', semantic: { context: context.context,
        contextRevision: context.semanticRevision, selectionRevision: selected.revision,
        preferenceRevision: null } };
    const registry = new AccessAdmissionRegistry(f.accessPool);
    const ranking = new RankingGenerations({ access: f.accessPool, relay,
      dataEpoch: f.env.lineage.dataEpoch, cursorKey: randomBytes(32),
      canReadWork: (identity, actor, candidate) => registry.canReadWork(identity, actor, candidate),
      verifySemantic: (identity, criterion) => verifyRankingSemanticBasis(
        f.env, f.accessPool, f.selections, identity, criterion),
      zeroSnapshot: () => graphZeroSnapshot(f.env), zeroCandidates: graphZeroCandidates(f.env) });
    const generation = await ranking.registerBuild(viewer, basis, 4,
      { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const lease = await ranking.claim(generation.generation);
    expect((await ranking.finish(generation.generation, lease)).state).toBe('ready');
    await ranking.activate(viewer, generation.generation, null,
      { idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    expect((await ranking.page(viewer, basis, 1)).items).toEqual([{ candidate: object }]);
    await expect(ranking.page({ principal: { issuer: f.account.issuer, subject: f.account.b.id },
      actingSubject: f.actorB }, basis, 1)).rejects.toBeInstanceOf(RecommendationMissing);
    await f.revoke(readGrant);
    await expect(ranking.page(viewer, basis, 1)).rejects.toBeInstanceOf(RecommendationMissing);
    await f.grant(`context:read:${context.context}`, 'context.read');
    expect((await ranking.page(viewer, basis, 1)).items).toEqual([{ candidate: object }]);
    await f.json(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: null, expectedRevision: selected.revision, actingSubject: f.actorA }), 201);
    await expect(ranking.page(viewer, basis, 1)).rejects.toBeInstanceOf(RecommendationMissing);
  } finally { await relay.end(); await f.close(); }
}, 120_000);
