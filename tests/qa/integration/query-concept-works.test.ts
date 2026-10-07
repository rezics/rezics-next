import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conceptQuery } from '../../../apps/web/features/concept/state.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { CONCEPT_FACET } from '../../../services/main/src/modules/concept-page/contract.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startHomeStack } from './feed-read-support.ts';
import { acceptClassifiedWork, discloseConcept, shareClassifiedConcepts,
  type ClassifiedConcept } from './work-classification.ts';

const short = (id: string) => id.slice(-36);

test('Query Concept Works and Concept page read the same all, any and exclusion selection', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('query-concept-works');
  try {
    const { stack, author } = home;
    await grantRecordedPlatformUse(stack.accessPool, author.principalId, ['platform-admin']);
    const app = createMainApp(stack.fuseki, { ...home.deps, discovery: new DiscoveryProjection(stack.accessPool),
      judgments: new AccessJudgments(stack.accessPool) });
    const call = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`,
      { method, headers: { ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
        'accept-language': 'zh-Hans', authorization: `Bearer ${author.token}` },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = home.json;
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('context:create:root', 'context.create');
    await author.grant(`statement:speak:${author.actor}`, 'statement.record');
    await author.grant('classification:decide:global', 'statement.decide');
    const works = [];
    for (const index of [1, 2, 3, 4]) works.push(await stack.publicWork(author.actor, ['en'],
      `Query Concept Work ${index} ${randomUUID()}`));
    const define = async (label: string) => json<ClassifiedConcept>(await call('POST',
      '/v1/classification-propositions', { profile: 'classification-proposition-v1', label,
        actingSubject: author.actor }), 201);
    const fantasy = await define('Fantasy'), magic = await define('Magic'), romance = await define('Romance');
    const interpretation = await shareClassifiedConcepts(call, json, author.actor, [fantasy, magic, romance]);
    for (const term of [fantasy, magic, romance]) {
      await discloseConcept(stack.accessPool, author.principal, author.actor, term.concept);
    }
    const accept = (work: typeof works[number], term: ClassifiedConcept) => acceptClassifiedWork(
      call, json, author.actor, work, term, interpretation);
    await accept(works[0]!, fantasy);
    await accept(works[0]!, magic);
    await accept(works[1]!, fantasy);
    await accept(works[1]!, romance);
    await accept(works[2]!, magic);
    await accept(works[3]!, fantasy);
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
    const ids = (items: { id: string }[]) => items.map(item => item.id).sort();
    const anchored = (additions: string[], exclude: string[] = []) => ({ context: 'global', scope: { kind: 'all' },
      sort: 'newest', page: { size: 20 }, filter: { all: [
        { facet: 'concept', all: [fantasy.concept] },
        ...(additions.length ? [{ facet: 'concept', any: additions }] : []),
        ...(exclude.length ? [{ facet: 'concept', none: exclude }] : []),
      ] } });
    const run = async (body: ReturnType<typeof anchored>) => json<{ template: string; result: {
      items: { id: string }[]; filter: { all: { facet: string }[] } } }>(await call('POST', '/v1/query', body));
    const all = await run({ context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 20 },
      filter: { all: [{ facet: 'concept', all: [fantasy.concept, magic.concept] }] } });
    expect(all.template).toBe('concept-works-v1');
    expect(all.result.items.map(item => item.id)).toEqual([works[0]!.work]);
    // {A}, {B}, {A,B}, {A,C}: additions B,C match any keeps A and returns {A,B} and {A,C}.
    const any = await run(anchored([magic.concept, romance.concept]));
    expect(ids(any.result.items)).toEqual(ids([{ id: works[0]!.work }, { id: works[1]!.work }]));
    const excludedAddition = await run(anchored([magic.concept], [romance.concept]));
    expect(ids(excludedAddition.result.items)).toEqual([works[0]!.work]);
    const legacy = await json<{ items: { id: string }[]; filter: { all: { facet: string }[] } }>(await call('GET',
      `/v1/concepts/${short(fantasy.concept)}/works?include=${encodeURIComponent(magic.concept)}`
      + `&include=${encodeURIComponent(romance.concept)}&match=any`));
    expect(ids(any.result.items)).toEqual(ids(legacy.items));
    const emitted = conceptQuery({ concept: short(fantasy.concept), scope: { kind: 'global' },
      include: [short(magic.concept), short(romance.concept)], exclude: [], match: 'any' }).filter!;
    const canonical = { all: emitted.all.map(condition => 'facet' in condition
      ? { ...condition, facet: CONCEPT_FACET } : condition) };
    expect(any.result.filter).toEqual(canonical);
    expect(legacy.filter).toEqual(canonical);
    // Discover's newest shelf: any of these Concepts, with no page anchor.
    const union = await json<{ template: string; result: { items: { id: string }[] } }>(await call('POST',
      '/v1/query', { context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 20 },
        filter: { all: [{ facet: 'concept', any: [magic.concept, romance.concept] }] } }));
    expect(union.template).toBe('concept-works-v1');
    expect(ids(union.result.items)).toEqual(ids([
      { id: works[0]!.work }, { id: works[1]!.work }, { id: works[2]!.work }]));
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
