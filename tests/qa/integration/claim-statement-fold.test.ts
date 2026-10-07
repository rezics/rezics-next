import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import { Pool } from 'pg';
import {
  CommandOutcomeUnknown,
  FusekiClient,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import {
  changeSemanticComponent,
  semanticChangeDigest,
  type DefinitionState,
} from '../../../services/main/src/modules/semantic/change.ts';
import {
  DATE_PUBLISHED_PREDICATE,
  DATE_PUBLISHED_DEFINITION_NOTATION,
  QUALIFICATION_DEFINITION_NOTATION,
} from '../../../services/main/src/modules/statement/qualification.ts';
import { objectTerm } from '../../../services/main/src/modules/statement/graph.ts';
import {
  prepareClaimStatementFold,
  convertEligibleClaimsTurn,
  type PreparedClaimStatementFold,
} from '../../../services/main/src/modules/verification/claim-fold.ts';
import {
  readStatement,
  readStatementRevisionSnapshot,
} from '../../../services/main/src/modules/statement/read.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import {
  ADMISSIONS,
  claimDigest,
  createClaim,
  readClaimRevisions,
  readClaimHead,
  graphHeads,
  readReceipt,
  type CreateClaimInput,
  type GraphReceipt,
} from '../../../services/main/src/modules/verification/graph.ts';
import {
  readMainOutboxEnvelope,
  readNextMainOutboxBatch,
  type MainOutboxBatch,
} from '../../../services/main/src/modules/outbox/relay.ts';
import {
  DATASET,
  GRAPHS,
  ID,
  RV,
  iri,
  lit,
  hash,
  type WorkActivationEnvironment,
} from '../../../services/main/src/modules/work/activate.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
let pool: Pool;
let env: WorkActivationEnvironment;
let directory: string;
let relationDefinition: string;
let qualificationDefinition: string;
let sources: { receipt: GraphReceipt; admission: RegisteredAdmission; input: CreateClaimInput }[];
const preparedRoots: PreparedClaimStatementFold[] = [];
const originalEvents: {
  batch: MainOutboxBatch;
  event: Awaited<ReturnType<typeof readMainOutboxEnvelope>>;
}[] = [];
let folded: Awaited<ReturnType<typeof convertEligibleClaimsTurn>>;
const native = () => `${ID}${Bun.randomUUIDv7()}`;
function admission(
  scope: string,
  action: string,
  digest: string,
  actor: string,
): RegisteredAdmission {
  return {
    id: randomUUID(),
    principalId: randomUUID(),
    actingSubject: actor,
    scope,
    action,
    requestDigest: digest,
    idempotencyKey: randomUUID(),
    authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    state: 'claimed',
    dispatchEligible: true,
    replayed: false,
  };
}
async function definition(state: DefinitionState, actor: string) {
  return changeSemanticComponent(env, {
    expectedHead: null,
    state,
    admission: admission(
      'semantic:create:root',
      'semantic.change',
      semanticChangeDigest(undefined, null, state),
      actor,
    ),
  });
}
async function facts(graphs: string[], subjects: string[]) {
  return (
    (
      await env.fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    VALUES ?graph { ${graphs.map(iri).join(' ')} }
    VALUES ?subject { ${subjects.map(iri).join(' ')} }
    GRAPH ?graph { ?subject ?predicate ?object }
  } ORDER BY ?graph ?subject ?predicate ?object`)
    ).results?.bindings ?? []
  );
}
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected isolated QA integration');
  mkdirSync('.temp', { recursive: true });
  directory = mkdtempSync(join('.temp', 'claim-fold-native-'));
  env = {
    fuseki: new FusekiClient(
      Bun.env.FUSEKI_URL!,
      Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      Bun.env.FUSEKI_COMMAND_TOKEN!,
    ),
    objectDirectory: directory,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
  };
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const actors = [native(), native()];
  relationDefinition = (
    await definition(
      {
        component: 'definition',
        kind: 'property',
        roles: [],
        lifecycle: 'active',
        successor: null,
        notation: DATE_PUBLISHED_DEFINITION_NOTATION,
      },
      actors[0]!,
    )
  ).revision;
  qualificationDefinition = (
    await definition(
      {
        component: 'definition',
        kind: 'interpretation',
        roles: [],
        lifecycle: 'active',
        successor: null,
        notation: QUALIFICATION_DEFINITION_NOTATION,
      },
      actors[0]!,
    )
  ).revision;
  const base: CreateClaimInput = {
    referent: 'urn:retained:original-work',
    interpretationContext: 'urn:retained:publication-scope',
    propositionPredicate: DATE_PUBLISHED_PREDICATE,
    value: { kind: 'literal', lexical: '0001-01-01', datatype: 'date' },
    valuePrecision: 'approximate',
    valueQualifiers: ['disputed-attribution', 'inferred'],
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    editionScope: 'https://publisher.example/first-edition',
    actingSubject: actors[0]!,
  };
  sources = [];
  for (const input of [
    base,
    { ...base, actingSubject: actors[1]! },
    { ...base, propositionPredicate: 'https://schema.org/dateCreated' },
    {
      ...base,
      value: { kind: 'literal' as const, lexical: '2026-01-01', datatype: 'string' as const },
    },
    {
      ...base,
      value: {
        kind: 'literal' as const,
        lexical: '2026-01-01T00:00:00.000Z',
        datatype: 'dateTime' as const,
      },
    },
  ]) {
    const admitted = admission(
      ADMISSIONS['claim-create'].scope,
      ADMISSIONS['claim-create'].action,
      claimDigest(input),
      input.actingSubject,
    );
    sources.push({ input, admission: admitted, receipt: await createClaim(env, admitted, input) });
  }
  const seek = new StatementSeek(pool, env);
  while (await seek.projectOnce()) {
    /* owning bounded projector establishes the exact empty-Statement cut */
  }
  expect((await seek.coverage())?.complete).toBe(true);
  expect(
    (await pool.query('SELECT open FROM access.recovery_fence WHERE id=true')).rows[0]?.open,
  ).toBe(true);
}, 120_000);
afterAll(async () => {
  await pool?.end();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('native retained Claim preparation preserves C/R custody, reviewed meaning and independent speakers without writing a base triple', async () => {
  const prepared = [];
  for (const source of sources.slice(0, 2)) {
    const claim = source.receipt.result.claim!,
      revision = source.receipt.result.claimRevision!;
    const before = await facts(
      [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts],
      [claim, revision, source.receipt.receipt],
    );
    const original = (await readClaimRevisions(env, [revision])).get(revision);
    if (!original) throw new Error('Original Claim root is unavailable');
    const raw =
      (
        await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
      (STR(?value) AS ?lexical) (STR(?from) AS ?fromLexical) (STR(?until) AS ?untilLexical)
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:propositionValue ?value ;
        rv:validFrom ?from ; rv:validUntil ?until } } LIMIT 2`)
      ).results?.bindings ?? [];
    expect(raw).toHaveLength(1);
    const result = await prepareClaimStatementFold(env, {
      claim,
      claimRevision: revision,
      relationDefinition,
      qualificationDefinition,
    });
    expect(result.status).toBe('eligible');
    if (result.status !== 'eligible')
      throw new Error(`Eligible datePublished Claim retained: ${result.reason}`);
    const converted = result.prepared;
    preparedRoots.push(converted);
    expect(converted.meaning.value.kind === 'literal' && converted.meaning.value.lexical).toBe(
      raw[0]!.lexical!.value,
    );
    expect(converted.meaning.qualification!.validFrom).toBe(raw[0]!.fromLexical!.value);
    expect(converted.meaning.qualification!.validUntil).toBe(raw[0]!.untilLexical!.value);
    prepared.push(converted);
    expect(converted.claim).toBe(claim);
    expect(converted.claimRevision).toBe(revision);
    expect(converted.statementRevision).not.toBe(revision);
    expect(converted.meaning).toMatchObject({
      subject: source.input.referent,
      predicate: DATE_PUBLISHED_PREDICATE,
      relationDefinition,
      value: { kind: 'literal', lexical: '0001-01-01', datatype: `${XSD}date`, language: null },
      qualification: {
        definition: qualificationDefinition,
        interpretationContext: source.input.interpretationContext,
        valuePrecision: source.input.valuePrecision,
        valueQualifiers: [...source.input.valueQualifiers].sort(),
        validFrom: original.validFrom,
        validUntil: original.validUntil,
        editionScope: source.input.editionScope,
      },
    });
    const graph = new Parser({ format: 'TriG' })
      .parse(`@prefix rv: <${RV}> . @prefix rdf: <${RDF}> .
      GRAPH <${GRAPHS.current}> { ${converted.current} }
      GRAPH <${GRAPHS.revisions}> { ${converted.revisions} }`);
    expect(
      graph.some(
        (quad) =>
          quad.subject.value === converted.statementRevision &&
          quad.predicate.value === `${RV}retainedSourceRevision` &&
          quad.object.value === revision,
      ),
    ).toBe(true);
    expect(
      graph.some(
        (quad) =>
          quad.subject.value === converted.statementRevision &&
          quad.predicate.value === `${RV}predecessor`,
      ),
    ).toBe(false);
    expect(
      graph.some(
        (quad) =>
          quad.subject.value === claim &&
          quad.predicate.value === `${RV}speaker` &&
          quad.object.value === source.input.actingSubject,
      ),
    ).toBe(true);
    expect(
      graph.some(
        (quad) =>
          quad.subject.value === source.input.referent &&
          quad.predicate.value === DATE_PUBLISHED_PREDICATE,
      ),
    ).toBe(false);
    expect(graph.some((quad) => quad.subject.value === revision)).toBe(false);
    const exactTerm = new Parser().parse(
      `<urn:test:s> <urn:test:p> ${objectTerm(converted.meaning.value)} .`,
    )[0]!.object;
    expect(exactTerm.termType).toBe('Literal');
    if (exactTerm.termType !== 'Literal') throw new Error('Date literal expected');
    expect(exactTerm.value).toBe('0001-01-01');
    expect(exactTerm.datatype.value).toBe(`${XSD}date`);
    expect(
      await facts(
        [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts],
        [claim, revision, source.receipt.receipt],
      ),
    ).toEqual(before);
    expect(
      await readReceipt(env, source.admission.id, 'claim-create', ['claim', 'claimRevision']),
    ).toEqual(source.receipt);
    const batch = await readNextMainOutboxBatch(
      env.fuseki,
      source.receipt.dataEpoch,
      (BigInt(source.receipt.sequence) - 1n).toString(),
    );
    expect(batch?.sequence).toBe(source.receipt.sequence);
    const event = await readMainOutboxEnvelope(env.fuseki, batch!, batch!.eventIds[0]!);
    originalEvents.push({ batch: batch!, event });
    expect(event).toMatchObject({
      type: 'com.rezics.verification.claim-created.v1',
      data: { receipt: { claim, claimRevision: revision } },
    });
  }
  expect(prepared[0]!.claim).not.toBe(prepared[1]!.claim);
  expect(prepared[0]!.statementRevision).not.toBe(prepared[1]!.statementRevision);
  expect(prepared[0]!.meaningKey).toBe(prepared[1]!.meaningKey);
}, 120_000);

test('authenticated CommandService acquire and convert preserve exact C/R custody and replay lost acknowledgements without merging speakers', async () => {
  for (const source of sources.slice(2, 4)) {
    const result = await prepareClaimStatementFold(env, {
      claim: source.receipt.result.claim!,
      claimRevision: source.receipt.result.claimRevision!,
      relationDefinition,
      qualificationDefinition,
    });
    expect(result.status).toBe('retained');
    if (result.status !== 'retained')
      throw new Error('Unreviewed meaning became an eligible publication Claim');
    expect(result.reason).toBeTruthy();
  }
  expect(preparedRoots).toHaveLength(2);
  const targets = sources.slice(0, 4).map((source) => ({
    claim: source.receipt.result.claim!,
    claimRevision: source.receipt.result.claimRevision!,
  }));
  const plan = {
    relationDefinition,
    qualificationDefinition,
    job: 'native-acquire-convert',
    claims: targets,
  };
  const old = await Promise.all(
    sources.map((source) =>
      facts(
        [GRAPHS.revisions, GRAPHS.receipts],
        [source.receipt.result.claimRevision!, source.receipt.receipt],
      ),
    ),
  );
  const descriptors = await Promise.all(
    sources.slice(0, 2).map((source) => facts([GRAPHS.current], [source.receipt.result.claim!])),
  );
  const position = (
    await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence } }`)
  ).results!.bindings;
  const transport = env.fuseki.commandWithReceipt.bind(env.fuseki);
  let acquireLost = false,
    convertLost = false,
    writes = 0;
  env.fuseki.commandWithReceipt = async (envelope) => {
    writes++;
    if (envelope.receipt.includes(':acquire:')) {
      const denied = await fetch(new URL('command', Bun.env.FUSEKI_URL!), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN!}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(15_000),
      });
      expect(denied.status).toBe(403);
      expect(await facts([GRAPHS.receipts], [envelope.receipt])).toEqual([]);
    }
    const response = await transport(envelope);
    if (response.status === 'invalid')
      console.error('native Claim fold rejection', envelope.receipt, response.report);
    if (response.status === 'committed' && !acquireLost && envelope.receipt.includes(':acquire:')) {
      acquireLost = true;
      throw new CommandOutcomeUnknown('Lost durable native acquire acknowledgement');
    }
    if (response.status === 'committed' && !convertLost && envelope.receipt.includes(':convert:')) {
      convertLost = true;
      throw new CommandOutcomeUnknown('Lost durable native convert acknowledgement');
    }
    return response;
  };
  try {
    folded = await convertEligibleClaimsTurn(env, pool, plan);
  } finally {
    env.fuseki.commandWithReceipt = transport;
  }
  expect([acquireLost, convertLost]).toEqual([true, true]);
  expect(writes).toBe(3);
  expect(folded).toMatchObject({
    status: 'partial',
    complete: false,
    scope: 'explicit-targets',
    remaining: [],
  });
  expect(folded.converted).toHaveLength(2);
  expect(folded.retained.map((item) => item.claim).sort()).toEqual(
    targets
      .slice(2)
      .map((item) => item.claim)
      .sort(),
  );
  const replayed = await convertEligibleClaimsTurn(env, pool, plan);
  expect(replayed.converted.map((item) => item.status)).toEqual(['replayed', 'replayed']);
  expect(replayed).toMatchObject({ complete: false, remaining: [], retained: folded.retained });
  for (const [index, source] of sources.entries()) {
    expect(
      await facts(
        [GRAPHS.revisions, GRAPHS.receipts],
        [source.receipt.result.claimRevision!, source.receipt.receipt],
      ),
    ).toEqual(old[index]);
    expect(
      await readReceipt(env, source.admission.id, 'claim-create', ['claim', 'claimRevision']),
    ).toEqual(source.receipt);
  }
  for (const [index, conversion] of folded.converted.entries()) {
    const source = sources[index]!,
      prepared = preparedRoots[index]!;
    expect(conversion).toMatchObject({
      claim: source.receipt.result.claim,
      claimRevision: source.receipt.result.claimRevision,
      statementRevision: prepared.statementRevision,
      status: 'converted',
    });
    const archived = await facts([GRAPHS.revisions], [conversion.claim]);
    expect(
      archived.map((row) => ({ ...row, graph: { ...row.graph!, value: GRAPHS.current } })),
    ).toEqual(descriptors[index]);
    const records = await readClaimRevisions(env, [
      conversion.claimRevision,
      conversion.statementRevision,
    ]);
    expect(records.get(conversion.claimRevision)).toMatchObject({
      representation: 'claim',
      revision: conversion.claimRevision,
      head: conversion.statementRevision,
      statedBy: source.input.actingSubject,
    });
    expect(records.get(conversion.statementRevision)).toMatchObject({
      representation: 'statement',
      revision: conversion.statementRevision,
      retainedSourceRevision: conversion.claimRevision,
      statedBy: source.input.actingSubject,
      rdfValue: prepared.meaning.value,
    });
    expect(await readClaimHead(env, conversion.claim)).toEqual(
      records.get(conversion.statementRevision)!,
    );
    expect(
      (await graphHeads(env, [{ kind: 'claim', reference: conversion.claim }])).heads.get(
        conversion.claim,
      ),
    ).toBe(conversion.statementRevision);
    expect(
      await readStatementRevisionSnapshot(env, conversion.claim, conversion.statementRevision),
    ).toMatchObject({
      meaningKey: prepared.meaningKey,
      meaning: prepared.meaning,
      speaker: source.input.actingSubject,
      retainedProvenance: prepared.provenance,
    });
    await expect(
      readStatement(env, conversion.claim, async () => false, conversion.statementRevision),
    ).rejects.toThrow(/held|lineage/iu);
    expect(
      (
        await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(conversion.statementRevision)} <${RV}predecessor> ${iri(conversion.claimRevision)} } }`)
      ).boolean,
    ).toBe(false);
    expect(
      (
        await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      <${source.input.referent}> <${DATE_PUBLISHED_PREDICATE}> ?object } }`)
      ).boolean,
    ).toBe(false);
    const sealed = JSON.parse(prepared.sealedBytes.statementManifest);
    expect(
      readFileSync(join(directory, hash(prepared.sealedBytes.statementManifest)), 'utf8'),
    ).toBe(prepared.sealedBytes.statementManifest);
    expect(readFileSync(join(directory, sealed.payload.slice(-64)), 'utf8')).toBe(
      prepared.sealedBytes.statementPayload,
    );
    const custody = (
      await env.fuseki.query(`SELECT ?predicate ?object WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(conversion.receipt)} ?predicate ?object . VALUES ?predicate {
        <${RV}claimFoldJob> ${Object.keys(prepared.sealedBytes)
          .map((name) => `<${RV}claimFold${name[0]!.toUpperCase()}${name.slice(1)}>`)
          .join(' ')} } } }`)
    ).results!.bindings;
    expect(custody).toHaveLength(7);
    expect(custody.find((row) => row.predicate!.value === `${RV}claimFoldJob`)!.object!.value).toBe(
      folded.fence.job,
    );
    for (const [name, bytes] of Object.entries(prepared.sealedBytes)) {
      const key = `${RV}claimFold${name[0]!.toUpperCase()}${name.slice(1)}`;
      expect(custody.find((row) => row.predicate!.value === key)!.object!.value).toBe(bytes);
    }
    expect(
      await readMainOutboxEnvelope(
        env.fuseki,
        originalEvents[index]!.batch,
        originalEvents[index]!.event.id,
      ),
    ).toEqual(originalEvents[index]!.event);
  }
  expect(folded.converted[0]!.claim).not.toBe(folded.converted[1]!.claim);
  expect(
    (await pool.query('SELECT open FROM access.recovery_fence WHERE id=true')).rows[0]?.open,
  ).toBe(false);
  expect(
    (
      await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence } }`)
    ).results!.bindings,
  ).toEqual(position);
}, 120_000);

test('native complete/release remain refused and pending admissions stop an untouched eligible Claim behind the owned fences', async () => {
  expect(folded.complete).toBe(false);
  const beforeControl = await facts([GRAPHS.control], [DATASET, folded.fence.marker]);
  for (const phase of ['complete', 'release']) {
    const digest = hash(
      JSON.stringify([
        'claim-statement-fold-v1',
        phase,
        env.lineage.dataEpoch,
        env.lineage.routingEpoch,
        folded.fence,
      ]),
    );
    const receipt = `urn:rezics:name-migration:claim-statement-fold:${phase}:${digest}`;
    const update = `PREFIX rv: <${RV}>
      ${
        phase === 'release'
          ? `DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true .
        ${iri(folded.fence.marker)} rv:claimStatementFoldFence true } }`
          : ''
      }
      INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:commandFamily ${lit(`claim-statement-fold-${phase}-v1`)} ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence ;
        rv:claimStatementFold ${iri(folded.fence.marker)} ; rv:foldMapDigest ${lit(folded.fence.mapDigest)} ; rv:claimFoldJob ${lit(folded.fence.job)} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence ; rv:restoreHold true .
        ${iri(folded.fence.marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(folded.fence.mapDigest)} } }`;
    const response = await fetch(new URL('command', Bun.env.FUSEKI_URL!), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Bun.env.FUSEKI_MAINTENANCE_TOKEN!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ receipt, digest, update, validations: [], deadlineMs: 10_000 }),
      signal: AbortSignal.timeout(15_000),
    });
    expect([400, 422]).toContain(response.status);
    expect(await response.text()).toMatch(/inventory|completion|release/iu);
    expect(await facts([GRAPHS.receipts], [receipt])).toEqual([]);
  }
  expect(await facts([GRAPHS.control], [DATASET, folded.fence.marker])).toEqual(beforeControl);
  const reserved = sources[4]!;
  const claim = reserved.receipt.result.claim!,
    revision = reserved.receipt.result.claimRevision!;
  const before = await facts([GRAPHS.current, GRAPHS.revisions], [claim, revision]);
  const principal = randomUUID(),
    pending = randomUUID();
  await pool.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principal, 'https://fixture.example', pending],
  );
  await pool.query(
    "INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent') ON CONFLICT DO NOTHING",
    [reserved.input.actingSubject],
  );
  await pool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [
    ADMISSIONS['claim-create'].scope,
  ]);
  await pool.query(
    `INSERT INTO access.admission(id,principal_id,acting_subject,scope_id,action,idempotency_key,
    request_digest,authority_epoch,expires_at,state) VALUES ($1,$2,$3,$4,$5,$6,$7,0,now()+interval '1 hour','registered')`,
    [
      pending,
      principal,
      reserved.input.actingSubject,
      ADMISSIONS['claim-create'].scope,
      ADMISSIONS['claim-create'].action,
      pending,
      'a'.repeat(64),
    ],
  );
  await expect(
    convertEligibleClaimsTurn(env, pool, {
      relationDefinition,
      qualificationDefinition,
      job: folded.fence.job,
      claims: [{ claim, claimRevision: revision }],
    }),
  ).rejects.toThrow(/pending.*after closure/iu);
  expect(await facts([GRAPHS.current, GRAPHS.revisions], [claim, revision])).toEqual(before);
  expect(await facts([GRAPHS.control], [DATASET, folded.fence.marker])).toEqual(beforeControl);
  expect(
    (await pool.query('SELECT open FROM access.recovery_fence WHERE id=true')).rows[0]?.open,
  ).toBe(false);
}, 120_000);
