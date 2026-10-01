import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

interface Opinion {
  observation: string;
  observationRevision: string;
  predecessor: string | null;
  availability: 'available' | 'withdrawn';
  value: number | null;
}

test('RATE04: a withdrawn latest opinion keeps earlier immutable revisions without resurrecting their values', async () => {
  const stack = await startMediaStack('rating-withdrawal');
  const { fuseki, env } = stack;
  async function aggregate(context: string, work: string, mainVersion: string) {
    const response = await stack.call('POST', '/v1/rating-aggregates', {
      body: { profile: 'realm-standing-latest-mean-v1', context, work, mainVersion },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ population: number; count: number;
      withdrawnCount: number; sum: number; mean: number | null;
      histogram: number[] }>;
  }
  try {
    const raterA = await stack.member('rating-withdrawal-a');
    const raterB = await stack.member('rating-withdrawal-b');
    const work = await stack.publicWork(raterA.actor);
    const spaceInput = { name: `Rating Realm ${randomUUID()}`, actingSubject: raterA.actor };
    const space = await createRealmSpace(env,
      stack.admission(raterA.actor, 'space:create:root', 'space.create',
        spaceCreationDigest(spaceInput)), spaceInput);
    if (!space.realm) throw new Error('Realm activation failed');
    await raterA.grant(`rating:context:${space.realm}`, 'rating.context.create');
    const contextResponse = await raterA.send('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: space.realm,
      question: 'Current quality', actingSubject: raterA.actor,
    });
    expect(contextResponse.status, await contextResponse.clone().text()).toBe(201);
    const { context } = await contextResponse.json() as { context: string };
    await raterA.grant(`rating:observe:${context}`, 'rating.observation.set');
    await raterB.grant(`rating:observe:${context}`, 'rating.observation.set');
    async function set(value: number | null, expectedRevisionHead: string | null,
      rater = raterA): Promise<Opinion> {
      const key = `rating-withdrawal-${randomUUID()}`;
      const response = await rater.send('POST', '/v1/rating-observations', {
        profile: 'realm-standing-rating-observation-v1', context,
        work: work.work, mainVersion: work.mainVersion, expectedRevisionHead,
        value, actingSubject: rater.actor,
      }, key);
      expect(response.status, await response.clone().text()).toBe(201);
      // The API seals the native receipt and the exact inventory before reads.
      const sealed = await stack.accessPool.query(`SELECT state, graph_outcome
        FROM access.admission WHERE principal_id = $1 AND action = $2
          AND idempotency_key = $3`, [rater.principalId, 'rating.observation.set', key]);
      expect(sealed.rows).toEqual([{ state: 'sealed', graph_outcome: 'succeeded' }]);
      return response.json() as Promise<Opinion>;
    }
    const first = await set(2, null);
    const other = await set(6, null, raterB);
    expect(other.observation).not.toBe(first.observation);
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 8, mean: 4 });
    const correction = await set(8, first.observationRevision);
    expect(correction.observation).toBe(first.observation);
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 14, mean: 7 });
    const withdrawn = await set(null, correction.observationRevision);
    expect(withdrawn).toMatchObject({
      observation: first.observation, predecessor: correction.observationRevision,
      availability: 'withdrawn', value: null });
    const current = await aggregate(context, work.work, work.mainVersion);
    expect(current).toMatchObject({ population: 2, count: 1,
      withdrawnCount: 1, sum: 6, mean: 6 });
    expect(current.histogram).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const previous = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head ?oldValue ?correctedValue WHERE {
        GRAPH <urn:rezics:graph:current> {
          ${iri(first.observation!)} rv:observationHead ?head . }
        GRAPH <urn:rezics:graph:revisions> {
          ${iri(first.observationRevision)} rv:ratingValue ?oldValue .
          ${iri(correction.observationRevision)} rv:ratingValue ?correctedValue . }
      }`);
    expect(previous.results?.bindings).toHaveLength(1);
    expect(previous.results?.bindings[0]?.head?.value).toBe(withdrawn.observationRevision);
    expect(previous.results?.bindings[0]?.oldValue?.value).toBe('2');
    expect(previous.results?.bindings[0]?.correctedValue?.value).toBe('8');
    const restored = await set(9, withdrawn.observationRevision);
    expect(restored.observation).toBe(first.observation);
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 15, mean: 7.5 });
  } finally {
    await stack.stop();
  }
}, 120_000);
