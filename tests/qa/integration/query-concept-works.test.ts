import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { startHomeStack } from './feed-read-support.ts';

const short = (id: string) => id.slice(-36);

test('Query Concept Works and Concept page read the same all, any and exclusion selection', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('query-concept-works');
  try {
    const { stack, author } = home;
    const app = createMainApp(stack.fuseki, { ...home.deps, discovery: new DiscoveryProjection(stack.accessPool) });
    const call = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`,
      { method, headers: { ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
        'accept-language': 'zh-Hans', authorization: `Bearer ${author.token}` },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = home.json;
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('classification:decide:global', 'classification.decision.set');
    const works = [];
    for (const index of [1, 2, 3]) works.push(await stack.publicWork(author.actor, ['en'],
      `Query Concept Work ${index} ${randomUUID()}`));
    const define = async (label: string) => json<{ concept: string; sense: string }>(await call('POST',
      '/v1/classification-propositions', { profile: 'classification-proposition-v1', label,
        actingSubject: author.actor }), 201);
    const fantasy = await define('Fantasy'), magic = await define('Magic'), romance = await define('Romance');
    const accept = async (work: typeof works[number], sense: string) => json(await call('POST',
      '/v1/classification-decisions', { profile: 'classification-direct-decision-v1', work: work.work,
        mainVersion: work.mainVersion, sense, context: { kind: 'global' }, outcome: 'accepted',
        expectedDecisionHead: null, actingSubject: author.actor }), 201);
    await accept(works[0]!, fantasy.sense);
    await accept(works[0]!, magic.sense);
    await accept(works[1]!, fantasy.sense);
    await accept(works[1]!, romance.sense);
    await accept(works[2]!, magic.sense);
    type Generation = { generation: string; checkpoint: string; complete: boolean; state: string };
    let row = await json<Generation>(await call('POST', '/v1/discovery/generation-builds', {
      profile: 'discovery-generation-build-v1', actingSubject: author.actor,
      basis: { scope: 'global', realm: null, context: null } }));
    for (let steps = 0; !row.complete && steps < 20; steps++) row = await json<Generation>(await call('POST',
      `/v1/discovery/generations/${row.generation}/advance`, { actingSubject: author.actor,
        expectedCheckpoint: row.checkpoint }));
    expect(row).toMatchObject({ complete: true, state: 'ready' });
    const head = await json<{ activeHeadRevision: string | null }>(await call('GET',
      `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(author.actor)}`));
    await json(await call('POST', '/v1/discovery/generation-activations', {
      profile: 'discovery-generation-activation-v1', actingSubject: author.actor, generation: row.generation,
      expectedHeadRevision: head.activeHeadRevision }));
    const query = (match: 'all' | 'any', exclude: boolean) => ({ context: 'global', scope: { kind: 'all' },
      sort: 'newest', page: { size: 20 }, filter: { all: [
        { facet: 'concept', [match]: [fantasy.concept, magic.concept] },
        ...(exclude ? [{ facet: 'concept', none: [romance.concept] }] : []),
      ] } });
    const run = async (match: 'all' | 'any', exclude: boolean) => {
      const response = await call('POST', '/v1/query', query(match, exclude));
      expect(response.status).toBe(200);
      return json<{ template: string; result: { items: { id: string }[]; values: { id: string }[] } }>(response);
    };
    const all = await run('all', false);
    expect(all.template).toBe('concept-works-v1');
    expect(all.result.items.map(item => item.id)).toEqual([works[0]!.work]);
    const any = await run('any', true);
    expect(any.result.items.map(item => item.id).sort()).toEqual([works[0]!.work, works[2]!.work].sort());
    const legacy = await json<{ items: { id: string }[] }>(await call('GET',
      `/v1/concepts/${short(fantasy.concept)}/works?include=${encodeURIComponent(magic.concept)}`
      + `&match=any&exclude=${encodeURIComponent(romance.concept)}`));
    expect(any.result.items.map(item => item.id)).toEqual(legacy.items.map(item => item.id));
    const excludedResponse = await call('POST', '/v1/query', { context: 'global', scope: { kind: 'all' },
      sort: 'newest', page: { size: 20 }, filter: { all: [{ facet: 'concept', none: [romance.concept] }] } });
    expect(excludedResponse.status).toBe(200);
    const excludedOnly = await json<{ result: { items: { id: string }[] } }>(excludedResponse);
    const excludedIds = new Set(excludedOnly.result.items.map(item => item.id));
    expect(excludedIds.has(works[0]!.work)).toBe(true);
    expect(excludedIds.has(works[2]!.work)).toBe(true);
    expect(excludedIds.has(works[1]!.work)).toBe(false);
  } finally { await home.stop(); }
}, 120_000);
