import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
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
} from '../../../services/main/src/modules/verification/claim-fold.ts';
import {
  ADMISSIONS,
  claimDigest,
  createClaim,
  readClaimRevisions,
  readReceipt,
  type CreateClaimInput,
  type GraphReceipt,
} from '../../../services/main/src/modules/verification/graph.ts';
import {
  readMainOutboxEnvelope,
  readNextMainOutboxBatch,
} from '../../../services/main/src/modules/outbox/relay.ts';
import {
  DATASET,
  GRAPHS,
  ID,
  RV,
  iri,
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
  ]) {
    const admitted = admission(
      ADMISSIONS['claim-create'].scope,
      ADMISSIONS['claim-create'].action,
      claimDigest(input),
      input.actingSubject,
    );
    sources.push({ input, admission: admitted, receipt: await createClaim(env, admitted, input) });
  }
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
    expect(event).toMatchObject({
      type: 'com.rezics.verification.claim-created.v1',
      data: { receipt: { claim, claimRevision: revision } },
    });
  }
  expect(prepared[0]!.claim).not.toBe(prepared[1]!.claim);
  expect(prepared[0]!.statementRevision).not.toBe(prepared[1]!.statementRevision);
  expect(prepared[0]!.meaningKey).toBe(prepared[1]!.meaningKey);
}, 120_000);

test('unreviewed Claims remain explicit and the missing native fold hook refuses without changing historical custody or fences', async () => {
  for (const source of sources.slice(2)) {
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
  const subjects = sources.flatMap((source) => [
    source.receipt.result.claim!,
    source.receipt.result.claimRevision!,
    source.receipt.receipt,
  ]);
  const before = await facts([GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts], subjects);
  const control = await facts([GRAPHS.control], [DATASET]);
  const fence = (await pool.query('SELECT * FROM access.recovery_fence WHERE id=true')).rows;
  await expect(
    convertEligibleClaimsTurn(env, pool, {
      relationDefinition,
      qualificationDefinition,
      job: 'native-hook-refusal',
      claims: sources.map((source) => ({
        claim: source.receipt.result.claim!,
        claimRevision: source.receipt.result.claimRevision!,
      })),
    }),
  ).rejects.toThrow(/native.*(?:hook|policy)|(?:hook|policy).*native|not supported/iu);
  expect(await facts([GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts], subjects)).toEqual(
    before,
  );
  expect(await facts([GRAPHS.control], [DATASET])).toEqual(control);
  expect((await pool.query('SELECT * FROM access.recovery_fence WHERE id=true')).rows).toEqual(
    fence,
  );
  const exact = await readClaimRevisions(
    env,
    sources.map((source) => source.receipt.result.claimRevision!),
  );
  expect(exact.size).toBe(sources.length);
  for (const source of sources)
    expect(exact.get(source.receipt.result.claimRevision!)?.head).toBe(
      source.receipt.result.claimRevision,
    );
}, 120_000);
