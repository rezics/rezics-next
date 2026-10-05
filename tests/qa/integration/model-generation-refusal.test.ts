import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { modelBootstrapUpdate } from '../../../scripts/datasets/model-bootstrap.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  ACTIVE_GENERATION,
  MODEL_MANIFEST_SHA256,
  ensureModelGeneration,
  readSemanticTerminal,
} from '../../../services/main/src/modules/semantic/command.ts';
import { readActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { MODEL_COMPONENT, PROFILES } from '../../../services/main/src/modules/semantic/schema.ts';
import { term } from '../../../services/main/src/modules/semantic/change.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  prepareComponent,
} from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

interface Write {
  component: string;
  revision: string;
  receipt: string;
}

test('Changed model generations promptly refuse semantic, relation and lexicon admissions, replay and recover after maintenance', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `model-generation-refusal-${randomUUID()}`),
  );
  const native = f.env.fuseki;
  await ensureModelGeneration(f.env);
  const active = await readActiveModelGeneration(native);
  const activeBatch = `urn:rezics:outbox:${hash(active.receipt)}`;
  const saved = (
    await native.query(`SELECT ?graph ?subject ?p ?o WHERE {
    VALUES ?graph { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} ${iri(GRAPHS.receipts)} ${iri(GRAPHS.outbox)} }
    VALUES ?subject { ${iri(MODEL_COMPONENT)} ${iri(ACTIVE_GENERATION)} ${iri(active.receipt)} ${iri(activeBatch)} }
    GRAPH ?graph { ?subject ?p ?o } }`)
  ).results!.bindings;
  const olderHash = hash(`Earlier reviewed generation ${randomUUID()}`);
  const older = `urn:rezics:model-generation:${olderHash}`;
  const olderReceipt = `urn:rezics:receipt:${hash(`${older}\0model-generation`)}`;
  const olderManifest = `urn:rezics:sha256:${prepareComponent(
    f.env.objectDirectory,
    older,
    { modelManifestSha256: olderHash, commandModule: COMMAND_MODULE_VERSION, entailment: 'none' },
    PROFILES.generation,
  )}`;
  const remove = (generation: string, receipt: string) => `
    DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} ?p ?o } };
    DELETE WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} ?p ?o } };
    DELETE WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } };
    DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} ?p ?o } }`;
  const olderOperation = `https://rezics.com/id/${randomUUID()}`;
  const olderFixture = `PREFIX rv: <${RV}>
    DELETE WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(older)} ?p ?o } };
    DELETE WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(olderReceipt)} ?p ?o } };
    ${remove(ACTIVE_GENERATION, active.receipt)};
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ; rv:generationHead ${iri(older)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(older)} a rv:ModelGeneration, rv:RevisionAnchor ;
        rv:component ${iri(MODEL_COMPONENT)} ; rv:generationNumber 1 ; rv:manifest ${iri(olderManifest)} ;
        rv:commandModuleVersion ${lit(COMMAND_MODULE_VERSION)} ; rv:entailmentProfile rv:NoEntailment ;
        rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
        rv:operation ${iri(olderOperation)} ; rv:modelRevision ${iri(PROFILES.generation)} ;
        rv:shapeRevision ${iri(PROFILES.generation)} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ?n }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(olderReceipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(hash(JSON.stringify({ family: 'model-generation-v1', manifest: olderHash })))} ;
        rv:operation ${iri(olderOperation)} ; rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence ?n } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`;
  let bootstrapCommands = 0;
  let writeRace: string | undefined;
  let bootstrapRace: 'changed' | 'same' | undefined;
  let bootstrapOutage = false;
  let loseRefusalResponse = false;
  const refusalCommands: CommandEnvelope[] = [];
  f.env.fuseki = new Proxy(native, {
    get(target, property) {
      if (property === 'commandWithReceipt')
        return async (envelope: CommandEnvelope) => {
          if (envelope.update.includes('ModelGenerationRecordedEvent')) {
            bootstrapCommands++;
            if (bootstrapOutage) {
              bootstrapOutage = false;
              throw new Error('bootstrap transport unavailable');
            }
            const race = bootstrapRace;
            bootstrapRace = undefined;
            if (race === 'changed') await native.update(olderFixture);
            if (race === 'same') await native.commandWithReceipt(envelope);
          }
          if (writeRace && envelope.update.includes(writeRace)) {
            writeRace = undefined;
            await native.update(olderFixture);
          }
          const refusal = envelope.update.includes('rv:reason rv:GenerationChanged');
          if (refusal) refusalCommands.push(envelope);
          const result = await native.commandWithReceipt(envelope);
          if (refusal && loseRefusalResponse) {
            loseRefusalResponse = false;
            throw new Error('lost generation refusal acknowledgement');
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const semanticBody = {
      profile: 'semantic-change-v1',
      actingSubject: f.actor,
      expectedHead: null,
      state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] },
    };
    const definition = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', {
        ...semanticBody,
        state: {
          component: 'definition',
          kind: 'relation',
          roles: [
            { key: 'source', minParticipants: 1, maxParticipants: 1, ordered: false },
            { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
          ],
        },
      }),
      201,
    );
    const source = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', semanticBody),
      201,
    );
    const target = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', semanticBody),
      201,
    );
    for (const component of [definition.component, source.component, target.component]) {
      await f.grant(`semantic:read:${component}`, 'semantic.read');
    }
    await f.grant('relation:create:root', 'relation.change');
    await f.grant(`semantic:edit:${definition.component}`, 'lexicon.presentation.change');
    await f.grant(`semantic:edit:${definition.component}`, 'lexicon.presentation.review');
    const workDefinition = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', {
        ...semanticBody,
        state: {
          component: 'definition',
          kind: 'relation',
          workSubjectRole: 'source',
          roles: [
            { key: 'source', minParticipants: 1, maxParticipants: 1, ordered: false },
            { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
          ],
        },
      }),
      201,
    );
    await f.grant(`semantic:read:${workDefinition.component}`, 'semantic.read');
    const work = await f.json<{ work: string }>(
      await f.call(
        'POST',
        '/v1/works',
        await f.catalogueBody({
          profile: 'metadata-only-v1',
          title: `Generation refusal Work ${randomUUID()}`,
          language: 'en',
          actingSubject: f.actor,
        }),
      ),
      201,
    );
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const relationBody = {
      profile: 'relation-change-v1',
      actingSubject: f.actor,
      expectedHead: null,
      definition: definition.revision,
      participations: [
        { role: 'source', participant: { kind: 'resource', ref: source.component } },
        { role: 'target', participant: { kind: 'resource', ref: target.component } },
      ],
    };
    const presentationBody = {
      profile: 'definition-presentation-v1',
      actingSubject: f.actor,
      expectedHead: null,
      state: {
        definition: definition.component,
        meaningRevision: definition.revision,
        fromRole: 'source',
        toRole: 'target',
        language: 'en',
        noun: 'Connection',
        heading: 'Connections',
        plurals: { other: 'Connections' },
        grammaticalForms: [],
        source: 'https://example.com/vocabulary',
        licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
        reviewStatus: 'draft',
      },
    };
    const calls = [
      { path: '/v1/semantic/changes', body: semanticBody },
      { path: '/v1/relations/changes', body: relationBody },
      { path: '/v1/lexicon/presentations', body: presentationBody },
      {
        path: '/v1/lexicon/presentations',
        body: {
          ...presentationBody,
          state: { ...presentationBody.state, language: 'de', reviewStatus: 'reviewed' },
        },
      },
      {
        path: '/v1/relations/changes',
        body: {
          ...relationBody,
          definition: workDefinition.revision,
          participations: [
            { role: 'source', participant: { kind: 'resource', ref: work.work } },
            { role: 'target', participant: { kind: 'resource', ref: target.component } },
          ],
        },
      },
    ].map((call) => ({ ...call, key: randomUUID() }));
    const refused = async (call: (typeof calls)[number]) => {
      const start = Date.now();
      expect(await f.json(await f.call('POST', call.path, call.body, call.key), 409)).toMatchObject(
        { code: 'generation_changed' },
      );
      expect(Date.now() - start).toBeLessThan(10_000);
      const rows = (
        await f.accessPool.query<{ id: string; state: string; graph_outcome: string }>(
          `SELECT id,state,graph_outcome FROM access.admission WHERE principal_id=$1 AND idempotency_key=$2`,
          [f.principalId, call.key],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
      const receipt = (
        await native.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:admissionId ${lit(rows[0]!.id)} } }`)
      ).results!.bindings;
      expect(receipt).toHaveLength(1);
      const terminal = await readSemanticTerminal(f.env, receipt[0]!.receipt!.value);
      expect(terminal).toMatchObject({ outcome: 'cancelled', reason: 'generation-changed' });
      return terminal;
    };
    const align = async () => {
      const predecessor = await readActiveModelGeneration(native);
      const sequence = (
        await native.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`)
      ).results!.bindings[0]!.n!.value;
      await native.update(
        modelBootstrapUpdate({
          format: 'rezics-local-dataset-model-bootstrap-v1',
          predecessor,
          generation: ACTIVE_GENERATION,
          modelManifestSha256: MODEL_MANIFEST_SHA256,
          manifest: active.manifest,
          operation: `https://rezics.com/id/${randomUUID()}`,
          receipt: active.receipt,
          digest: hash(
            JSON.stringify({ family: 'model-generation-v1', manifest: MODEL_MANIFEST_SHA256 }),
          ),
          lineage: f.env.lineage,
          observedSequence: sequence,
          generationNumber: `${BigInt(predecessor.generationNumber) + 1n}`,
          commandModuleVersion: COMMAND_MODULE_VERSION,
        }),
      );
      expect((await readActiveModelGeneration(native)).generation).toBe(ACTIVE_GENERATION);
      expect(
        (
          await native.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(older)} a rv:ModelGeneration } }`)
        ).boolean,
      ).toBe(true);
    };
    await native.update(olderFixture);
    loseRefusalResponse = true;
    const terminals = [];
    for (const call of calls) {
      const before = refusalCommands.length;
      terminals.push(await refused(call));
      expect(refusalCommands.length - before).toBe(1);
      expect(await refused(call)).toEqual(terminals.at(-1));
      expect(refusalCommands.length - before).toBe(1);
    }
    expect(bootstrapCommands).toBe(0);
    // The operator's maintenance advances the generation without rewriting product revisions.
    await align();
    for (const [index, call] of calls.entries()) {
      expect(await refused(call)).toEqual(terminals[index]);
      await f.json(await f.call('POST', call.path, call.body), 201);
    }
    // Relation dispatch can lose the generation after preparation rather than at bootstrap.
    writeRace = 'RelationChangedEvent';
    const racedRelation = { ...calls[1]!, key: randomUUID() };
    const racedTerminal = await refused(racedRelation);
    expect(writeRace).toBeUndefined();
    await align();
    expect(await refused(racedRelation)).toEqual(racedTerminal);
    await f.json(await f.call('POST', racedRelation.path, racedRelation.body), 201);

    // Reserved immutable slots and a concurrent different bootstrap winner also terminate.
    await native.update(`PREFIX rv: <${RV}> ${remove(ACTIVE_GENERATION, active.receipt)}`);
    for (const [graph, subject] of [
      [GRAPHS.revisions, ACTIVE_GENERATION],
      [GRAPHS.receipts, active.receipt],
    ]) {
      await native.update(
        `INSERT DATA { GRAPH ${iri(graph!)} { ${iri(subject!)} <${RV}reservedGeneration> true } }`,
      );
      await refused({ ...calls[0]!, key: randomUUID() });
      await native.update(`DELETE WHERE { GRAPH ${iri(graph!)} { ${iri(subject!)} ?p ?o } }`);
    }
    expect(bootstrapCommands).toBe(0);
    bootstrapRace = 'changed';
    await refused({ ...calls[0]!, key: randomUUID() });
    expect(bootstrapCommands).toBe(1);
    await native.update(`PREFIX rv: <${RV}> ${remove(older, olderReceipt)}`);
    // An empty model with a failed transport can bootstrap on retry; it is not a changed generation.
    bootstrapOutage = true;
    const pendingKey = randomUUID();
    expect((await f.call('POST', calls[0]!.path, calls[0]!.body, pendingKey)).status).toBe(202);
    expect(
      (
        await f.accessPool.query(
          `SELECT state,graph_outcome FROM access.admission
      WHERE principal_id=$1 AND idempotency_key=$2`,
          [f.principalId, pendingKey],
        )
      ).rows,
    ).toEqual([{ state: 'claimed', graph_outcome: null }]);
    // A same-generation bootstrap winner still allows the original business command.
    bootstrapRace = 'same';
    await f.json(await f.call('POST', calls[0]!.path, calls[0]!.body, pendingKey), 201);
    expect(bootstrapCommands).toBe(3);
    expect(refusalCommands.every((command) => command.validations.length === 0)).toBe(true);
    expect(refusalCommands.every((command) => Buffer.byteLength(command.update) < 8_192)).toBe(
      true,
    );
  } finally {
    f.env.fuseki = native;
    await native.update(`PREFIX rv: <${RV}> ${remove(older, olderReceipt)};
      ${remove(ACTIVE_GENERATION, active.receipt)};
      INSERT DATA { ${saved
        .map(
          (row) => `GRAPH ${iri(row.graph!.value)} {
        ${iri(row.subject!.value)} <${row.p!.value}> ${term(row.o!)} . }`,
        )
        .join('\n')} }`);
    await f.close();
  }
}, 180_000);
