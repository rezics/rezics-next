import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { DATASET, GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { ACTIVE_GENERATION } from '../../../services/main/src/modules/semantic/command.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import { MODEL_COMPONENT, PROFILES } from '../../../services/main/src/modules/semantic/schema.ts';
import { ModelGenerationUnavailable, readActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { checkedStageActivationBasis, prepareSemanticStagePage } from '../../../services/main/src/modules/semantic/staging.ts';
import { STAGE_LIMITS } from '../../../services/main/src/modules/semantic/stage-schema.ts';

const RV = 'https://rezics.com/vocab/';

function sha(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }

test('MODEL21/MODEL22: staging pins the exact model head and a prepared write cannot commit across a generation change', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `semantic-generation-${randomUUID()}`));
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const write = (state: object, target?: string, expectedHead: string | null = null, key = randomUUID()) => f.call(
      'POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor,
        ...(target ? { target } : {}), expectedHead, state }, key);
    const createdResponse = await write({ component: 'resource', types: ['https://schema.org/Person'], properties: [] });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { component: string; revision: string };
    const active = await readActiveModelGeneration(f.env.fuseki);
    expect(active.generation).toBe(ACTIVE_GENERATION);
    expect(active.receipt).toBe(`urn:rezics:receipt:${sha(`${active.generation}\0model-generation`)}`);

    const nextHash = sha(`MODEL22 generation race ${randomUUID()}`);
    const nextGeneration = `urn:rezics:model-generation:${nextHash}`;
    const nextManifest = `urn:rezics:sha256:${sha(`manifest ${nextHash}`)}`;
    const item = { target: created.component, expectedHead: created.revision,
      state: { component: 'resource', types: ['https://schema.org/Person', 'https://schema.org/Patient'], properties: [] } };
    const page = prepareSemanticStagePage(0, [item]);
    expect(() => prepareSemanticStagePage(0, Array.from({ length: STAGE_LIMITS.itemsPerPage + 1 }, () => item)))
      .toThrow(/too-large/);
    expect(() => prepareSemanticStagePage(0, [{ ...item, validationPosture: 'warn' } as never])).toThrow(/nonconforming/);
    const stageId = randomUUID();
    const principal = f.principalId;
    const idempotencyKey = `semantic-stage-${randomUUID()}`;
    const requestDigest = sha(JSON.stringify({ profile: 'semantic-change-bulk-v1', pages: [page.digest] }));
    const manifestDigest = sha(JSON.stringify({ profile: 'semantic-change-bulk-v1', pages: [page.digest] }));
    await f.pool.query(`INSERT INTO semantic.change_stage
      (id, admission_id, principal_id, acting_subject, idempotency_key, request_digest, profile,
       model_generation, validation_posture, manifest_digest, page_count, item_count, byte_count)
      VALUES ($1, $2, $3, $4, $5, $6, 'semantic-change-bulk-v1', $7, 'reject', $8, 1, $9, $10)`,
    [stageId, randomUUID(), principal, f.actor, idempotencyKey, requestDigest, active.generation,
      manifestDigest, page.itemCount, page.bytes.byteLength]);
    await f.pool.query(`INSERT INTO semantic.change_stage_page
      (stage_id, ordinal, page_digest, item_count, byte_size) VALUES ($1, 0, $2, $3, $4)`,
    [stageId, page.digest, page.itemCount, page.bytes.byteLength]);
    await f.pool.query(`INSERT INTO semantic.change_stage_validation
      (stage_id, ordinal, model_generation, outcome) VALUES ($1, 0, $2, 'conforming')`,
    [stageId, active.generation]);
    await f.pool.query(`INSERT INTO semantic.change_stage_validation
      (stage_id, ordinal, model_generation, outcome) VALUES ($1, 0, $2, 'conforming')`,
    [stageId, nextGeneration]);
    const stage = (await f.pool.query('SELECT * FROM semantic.change_stage WHERE id = $1', [stageId])).rows[0]!;
    const pages = (await f.pool.query('SELECT * FROM semantic.change_stage_page WHERE stage_id = $1 ORDER BY ordinal', [stageId])).rows;
    const validations = (await f.pool.query('SELECT * FROM semantic.change_stage_validation WHERE stage_id = $1', [stageId])).rows;
    expect(checkedStageActivationBasis(stage, pages, validations, active.generation)).toMatchObject({
      generation: active.generation, headGuard: expect.stringContaining(active.generation),
    });
    expect(() => checkedStageActivationBasis(stage, pages, validations, nextGeneration)).toThrow(/generation-changed/);

    // A caller cannot switch the stored validation posture or finalize the stage under another head.
    await expect(f.pool.query(`INSERT INTO semantic.change_stage_outcome
      (stage_id, outcome, model_generation, graph_receipt, data_epoch, sequence)
      VALUES ($1, 'activated', $2, $3, $4, 9)`,
    [stageId, nextGeneration, `urn:rezics:receipt:${sha('wrong-generation')}`, f.env.lineage.dataEpoch]))
      .rejects.toMatchObject({ constraint: 'semantic_stage_generation' });
    await expect(f.pool.query(`UPDATE semantic.change_stage SET validation_posture = 'warn' WHERE id = $1`, [stageId]))
      .rejects.toBeDefined();
    expect((await f.pool.query('SELECT 1 FROM semantic.change_stage_pending WHERE stage_id = $1', [stageId])).rowCount).toBe(1);

    const admissionsBeforeOverride = Number((await f.accessPool.query(
      "SELECT count(*) FROM access.admission WHERE action = 'semantic.change'")).rows[0]!.count);
    const postureOverride = await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, target: created.component,
      expectedHead: created.revision, state: item.state, validationPosture: 'warn' }, randomUUID());
    expect(postureOverride.status).toBeGreaterThanOrEqual(400);
    expect(postureOverride.status).toBeLessThan(500);
    const rawBulk = await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-bulk-v1', actingSubject: f.actor, pages: [page.bytes.toString()],
      validationPosture: 'skip' }, randomUUID());
    expect(rawBulk.status).toBeGreaterThanOrEqual(400);
    expect(rawBulk.status).toBeLessThan(500);
    expect(Number((await f.accessPool.query("SELECT count(*) FROM access.admission WHERE action = 'semantic.change'"))
      .rows[0]!.count)).toBe(admissionsBeforeOverride);
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.component)} rv:semanticHead ${iri(created.revision)} } }`)).boolean).toBe(true);

    await f.grant(`semantic:edit:${created.component}`, 'semantic.change');
    await f.grant(`semantic:read:${created.component}`, 'semantic.read');
    const nativeFuseki = f.env.fuseki;
    let advanced = false;
    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
        if (!advanced && envelope.update.includes('rv:SemanticRevision')) {
          advanced = true;
          await f.nativeFuseki.update(`PREFIX rv: <${RV}>
            DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
              GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(active.generation)} } }
            INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
              GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(nextGeneration)} }
              GRAPH ${iri(GRAPHS.revisions)} { ${iri(nextGeneration)} a rv:ModelGeneration, rv:RevisionAnchor ;
                rv:component ${iri(MODEL_COMPONENT)} ; rv:generationNumber ${BigInt(active.generationNumber) + 1n} ;
                rv:predecessor ${iri(active.generation)} ; rv:manifest ${iri(nextManifest)} ;
                rv:commandModuleVersion ${lit(COMMAND_MODULE_VERSION)} ; rv:entailmentProfile rv:NoEntailment ;
                rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
                rv:operation ${iri(`https://rezics.com/id/${Bun.randomUUIDv7()}`)} ;
                rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ;
                rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ?next . } }
            WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ;
                rv:routingEpoch ${lit(f.env.lineage.routingEpoch)} ; rv:sequence ?n . }
              GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(active.generation)} }
              BIND(?n + 1 AS ?next) }`);
        }
        return target.commandWithReceipt(envelope);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof nativeFuseki;
    const rejected = await write(item.state, created.component, created.revision);
    expect(advanced).toBe(true);
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as { code: string }).code).toBe('generation_changed');
    await expect(readActiveModelGeneration(f.env.fuseki)).rejects.toBeInstanceOf(ModelGenerationUnavailable);

    const query = (suffix = '') => f.call('GET',
      `/v1/semantic/resources/${shortId(created.component)}${suffix}?actingSubject=${encodeURIComponent(f.actor)}`);
    const current = await query();
    expect(current.status).toBe(200);
    expect((await current.json() as { revision: string }).revision).toBe(created.revision);
    const historical = await query(`/revisions/${shortId(created.revision)}`);
    expect(historical.status).toBe(200);
    expect(await historical.json()).toMatchObject({ revision: created.revision, modelGeneration: active.generation });

    await f.pool.query(`INSERT INTO semantic.change_stage_outcome
      (stage_id, outcome, reason, model_generation) VALUES ($1, 'rejected', 'generation-changed', $2)`,
    [stageId, nextGeneration]);
    expect((await f.pool.query('SELECT 1 FROM semantic.change_stage_pending WHERE stage_id = $1', [stageId])).rowCount).toBe(0);
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.component)} rv:semanticHead ${iri(created.revision)} } }`)).boolean).toBe(true);
  } finally { await f.close(); }
});
