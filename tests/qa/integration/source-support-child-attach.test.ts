import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { sourceFieldOccurrence } from '../../../services/main/src/modules/source/support-attach.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';

const iri = (id: string) => `https://rezics.com/id/${id}`;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('LIVE04/RECIPE06: a child occurrence has exact source support that withdraws independently', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration tier');
  const directory = resolve('.temp', `source-child-attach-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (h.env as typeof h.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await h.json<{ work: string; mainVersion: string }>(await h.call('POST', '/v1/works', { language: 'en',
      profile: 'metadata-only-v1', title: 'Source child support Work',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: h.actor }), 201);
    await h.grant(`work:edit:${work.work}`, 'recipe.edit');
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const structure = await h.json<{ structure: string; revision: string }>(await h.call('POST',
      '/v1/recipes', { owner: work.work, mainVersion: work.mainVersion,
        actingSubject: h.actor }), 201);
    const ingredients = ['2 tbsp olive oil', 'salt'];
    const changed = await h.json<{ revision: string; occurrences: string[] }>(await h.call('POST',
      `/v1/recipes/${shortId(structure.structure)}/changes`, {
        expectedHead: structure.revision, actingSubject: h.actor,
        operations: ingredients.map((value, index) => ({ op: 'insert',
          parent: structure.structure, position: 'last', role: 'ingredient',
          sourceKey: `human-confirmed-${index}`,
          qualifier: { type: 'ingredient-line', originalText: { value, language: 'en' },
            optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'unparsed' } })) }), 200);
    expect(changed.occurrences).toHaveLength(2);
    const mapping = `fixture-${randomUUID().replaceAll('-', '')}-v1`;
    const record = randomUUID(), observation = randomUUID(), conversion = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ recipeIngredient: ingredients }));
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO source.field_mapping
        (mapping_revision, provider, namespace, root_grain, field_count)
        VALUES ($1,'fixture','recipe','recipe',1)`, [mapping]);
      await client.query(`INSERT INTO source.field_disposition
        (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
        VALUES ($1,'recipe','recipeIngredient','native','text','verified occurrence value',
          'structure-occurrence-v1#qualifier.originalText.value')`, [mapping]);
      await client.query(`INSERT INTO source.record (id,provider,namespace,external_id)
        VALUES ($1,'fixture','recipe',$2)`, [record, `recipe-${randomUUID()}`]);
      await client.query(`INSERT INTO source.observation
        (id,record_id,principal_id,media_type,retention,raw_bytes,byte_digest,coverage,rights_evidence)
        VALUES ($1,$2,$3,'application/json','retained',$4,$5,'{"complete":true}','{}')`,
      [observation, record, h.principalId, bytes, sha(bytes)]);
      await client.query(`INSERT INTO source.conversion
        (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
        VALUES ($1,$2,$3,$4,$5,'{}',$6)`, [conversion, observation, h.principalId,
        mapping, sha(bytes), JSON.stringify([{ grain: 'recipe', field: 'recipeIngredient',
          disposition: 'native' }])]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const request = (index: number) => ({ profile: 'source-field-support-attachment-v1',
      target: work.work, slot: 'structure-occurrence-v1#qualifier.originalText.value',
      occurrence: changed.occurrences[index]!, context: structure.structure,
      sourceRecord: iri(record), conversion: iri(conversion), grain: 'recipe',
      sourceField: 'recipeIngredient', sourcePointer: `/recipeIngredient/${index}`,
      sourceOccurrence: sourceFieldOccurrence(iri(observation), 'recipe',
        'recipeIngredient', `/recipeIngredient/${index}`), expectedHead: changed.revision,
      actingSubject: h.actor });
    const path = '/v1/sources/field-supports';
    expect((await h.call('POST', path, request(0), randomUUID(), h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', path, { ...request(0),
      sourceOccurrence: request(1).sourceOccurrence })).status).toBe(409);
    expect((await h.call('POST', path, { ...request(0),
      occurrence: changed.occurrences[1] })).status).toBe(409);
    const key = randomUUID();
    const first = await h.json<{ support: { support: string; supportIdentity: string;
      occurrence: string; sourceOccurrence: string; nativeRevision: string } }>(
      await h.call('POST', path, request(0), key), 201);
    expect(first.support).toMatchObject({ occurrence: changed.occurrences[0],
      sourceOccurrence: request(0).sourceOccurrence, nativeRevision: changed.revision });
    expect((await h.call('POST', path, request(0), key)).status).toBe(200);
    expect((await h.call('POST', path, request(1), key)).status).toBe(409);
    const second = await h.json<typeof first>(await h.call('POST', path, request(1)), 201);
    expect(second.support.support).not.toBe(first.support.support);
    const indexed = await readCompositionPage(h.env, { structure: structure.structure,
      revision: changed.revision, occurrence: changed.occurrences[1], limit: 1,
      canReadTarget: async () => true });
    expect(indexed.occurrences).toHaveLength(1);
    expect(indexed.cost.pagesRead).toBeLessThanOrEqual(8);
    const withdrawal = { profile: 'source-support-withdrawal-v1',
      support: first.support.support, expectedSupport: first.support.supportIdentity,
      reason: 'Source ingredient observation withdrawn' };
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...withdrawal,
      expectedSupport: second.support.supportIdentity })).status).toBe(409);
    const removed = await h.json<{ support: { state: string; occurrence: string;
      nativeRevision: string } }>(await h.call('POST', '/v1/sources/withdrawals', withdrawal), 201);
    expect(removed.support).toMatchObject({ state: 'withdrawn',
      occurrence: changed.occurrences[0], nativeRevision: changed.revision });
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    const independent = await h.json<{ state: string }>(await fusekiReadBudget.run(budget,
      () => h.call('GET', `/v1/sources/field-supports/${shortId(second.support.support)}`)), 200);
    expect(independent.state).toBe('recorded');
    expect(64 - budget.callsLeft).toBeLessThanOrEqual(24);
    expect(262_144 - budget.bytesLeft).toBeLessThan(96_000);
    const graph = await h.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      <${changed.occurrences[0]}> a <https://schema.org/ListItem> .
      <${changed.occurrences[1]}> a <https://schema.org/ListItem> . } }`);
    expect(graph.boolean).toBe(true);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
