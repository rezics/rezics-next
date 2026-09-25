import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { createRatingContext, ratingContextDigest }
  from '../../../services/main/src/modules/rating/context.ts';
import { setStandingRating, standingRatingDigest }
  from '../../../services/main/src/modules/rating/observation.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, iri, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

test('RATE04: a withdrawn latest opinion keeps earlier immutable revisions without resurrecting their values', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `rating-withdrawal-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = {
    fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const actor = ID + randomUUID();
  const raterA = randomUUID(), raterB = randomUUID();
  function admission(scope: string, action: string, digest: string,
    principalId = raterA): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor, scope, action,
      idempotencyKey: `rating-${id}`, requestDigest: digest,
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function aggregate(context: string, work: string, mainVersion: string) {
    const app = createMainApp(fuseki, { environment: env,
      account: { verify: async () => { throw new Error('not an authority request'); } },
      access: {} as never });
    const response = await app.handle(new Request('http://main.local/v1/rating-aggregates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'realm-standing-latest-mean-v1',
        context, work, mainVersion }),
    }));
    expect(response.status).toBe(200);
    return response.json() as Promise<{ population: number; count: number;
      withdrawnCount: number; sum: number; mean: number | null;
      histogram: number[] }>;
  }
  try {
    const workTitle = `Withdrawn rating ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title: workTitle,
      admission: admission('work:create:root', 'work.create',
        metadataWorkRequestDigest(workTitle)) });
    if (!work.work || !work.mainVersion) throw new Error('Work activation failed');
    const spaceInput = { name: `Rating Realm ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(env,
      admission('space:create:root', 'space.create', spaceCreationDigest(spaceInput)),
      spaceInput);
    if (!space.realm) throw new Error('Realm activation failed');
    const contextInput = { realm: space.realm, question: 'Current quality',
      actingSubject: actor };
    const ratingContext = await createRatingContext(env,
      admission(`rating:context:${space.realm}`, 'rating.context.create',
        ratingContextDigest(contextInput)), contextInput);
    if (!ratingContext.context) throw new Error('Rating Context activation failed');
    const context = ratingContext.context;
    async function set(value: number | null, expectedRevisionHead: string | null,
      principalId = raterA) {
      const input = { context, work: work.work!, mainVersion: work.mainVersion!,
        expectedRevisionHead, value, actingSubject: actor };
      return setStandingRating(env,
        admission(`rating:observe:${context}`, 'rating.observation.set',
          standingRatingDigest(input), principalId), input);
    }
    const first = await set(2, null);
    const other = await set(6, null, raterB);
    expect(first.outcome).toBe('succeeded');
    expect(other.outcome).toBe('succeeded');
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 8, mean: 4 });
    const correction = await set(8, first.revision!);
    expect(correction.observation).toBe(first.observation);
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 14, mean: 7 });
    const withdrawn = await set(null, correction.revision!);
    expect(withdrawn).toMatchObject({ outcome: 'succeeded',
      observation: first.observation, predecessor: correction.revision,
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
          ${iri(first.revision!)} rv:ratingValue ?oldValue .
          ${iri(correction.revision!)} rv:ratingValue ?correctedValue . }
      }`);
    expect(previous.results?.bindings).toHaveLength(1);
    expect(previous.results?.bindings[0]?.head?.value).toBe(withdrawn.revision);
    expect(previous.results?.bindings[0]?.oldValue?.value).toBe('2');
    expect(previous.results?.bindings[0]?.correctedValue?.value).toBe('8');
    const restored = await set(9, withdrawn.revision!);
    expect(restored.observation).toBe(first.observation);
    expect(await aggregate(context, work.work, work.mainVersion)).toMatchObject({
      population: 2, count: 2, withdrawnCount: 0, sum: 15, mean: 7.5 });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
