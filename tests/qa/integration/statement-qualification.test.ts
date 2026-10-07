import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { Parser } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  changeSemanticComponent,
  semanticChangeDigest,
  type DefinitionState,
  type SemanticChangeResult,
} from '../../../services/main/src/modules/semantic/change.ts';
import { objectTerm } from '../../../services/main/src/modules/statement/graph.ts';
import {
  QUALIFICATION_DEFINITION_NOTATION,
  type StatementQualification,
} from '../../../services/main/src/modules/statement/qualification.ts';
import type { StatementRead } from '../../../services/main/src/modules/statement/read.ts';
import type { StatementValue } from '../../../services/main/src/modules/statement/schema.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { contextFixture, nativeId, shortId, RV, type ContextFixture } from './context-fixture.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const authoredProfileDigest = createHash('sha256')
  .update(readFileSync(new URL('../../../model/definitions/statement-v1.ttl', import.meta.url)))
  .digest('hex');
type Written = { statement: string; revision: string; meaningKey: string; replayed: boolean };
let f: ContextFixture;
let subject: string;
let predicate: SemanticChangeResult;
let qualificationDefinition: SemanticChangeResult;
let interpretationDefinition: SemanticChangeResult;
let retained: Written;
let recordGrant: string;
const propertyState: DefinitionState = {
  component: 'definition',
  kind: 'property',
  lifecycle: 'active',
  successor: null,
  roles: [],
};
const qualificationState: DefinitionState = {
  component: 'definition',
  kind: 'interpretation',
  lifecycle: 'active',
  successor: null,
  roles: [],
  notation: QUALIFICATION_DEFINITION_NOTATION,
};
const interpretationState: DefinitionState = {
  component: 'definition',
  kind: 'interpretation',
  lifecycle: 'active',
  successor: null,
  roles: [],
};

// Fixtures use the existing semantic owner command for setup, with real QA Jena
// validation and sealed manifests. Every tested Statement operation goes through HTTP/Access.
async function define(state: DefinitionState, prior?: SemanticChangeResult) {
  const target = prior?.component;
  const expectedHead = prior?.revision ?? null;
  const result = await changeSemanticComponent(f.env, {
    target,
    expectedHead,
    state,
    admission: f.admission(
      target ? `semantic:edit:${target}` : 'semantic:create:root',
      'semantic.change',
      semanticChangeDigest(target, expectedHead, state),
    ),
  });
  if (!prior) {
    await f.grant(`semantic:read:${result.component}`, 'semantic.read');
    await f.grant(`semantic:read:${result.component}`, 'semantic.read', f.actorB, f.principalB);
  }
  return result;
}
beforeAll(async () => {
  f = await contextFixture(Bun.env as Record<string, string>);
  // Turtle profileSource is copied verbatim into the generated/native profile.
  expect(profileRegistry['statement-v1'].sha256).toBe(authoredProfileDigest);
  expect((await f.env.fuseki.commandHealth()).profiles['statement-v1']).toBe(
    profileRegistry['statement-v1'].sha256,
  );
  subject = (await f.work('Qualified Statement exact literals')).work!;
  await f.grant(`work:read:${subject}`, 'work.read');
  await f.grant(`work:read:${subject}`, 'work.read', f.actorB, f.principalB);
  predicate = await define(propertyState);
  qualificationDefinition = await define(qualificationState);
  interpretationDefinition = await define(interpretationState);
  recordGrant = await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
  await f.grant(`statement:speak:${f.actorB}`, 'statement.record', f.actorB, f.principalB);
  await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw');
}, 120_000);
afterAll(async () => {
  if (f) {
    await f.close();
    rmSync(f.env.objectDirectory, { recursive: true, force: true });
  }
});

const qualification = (): StatementQualification => ({
  definition: qualificationDefinition.revision,
  interpretationContext: 'urn:fixture:statement:proposition-scope',
  valuePrecision: 'approximate',
  valueQualifiers: ['disputed-attribution', 'inferred'],
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z',
  editionScope: 'https://example.test/edition/first',
});
const numericValue = (): StatementValue => ({
  kind: 'literal',
  lexical: '001',
  datatype: `${XSD}integer`,
  language: null,
});
const body = (value: StatementValue = numericValue()) => ({
  profile: 'statement-v1',
  speaker: { kind: 'personal' },
  subject,
  predicate: predicate.component,
  relationDefinition: predicate.revision,
  value,
  applicability: [],
  interpretation: { kind: 'definition', definition: interpretationDefinition.revision },
  qualification: qualification(),
  evidence: ['https://example.test/source/announcement'],
  actingSubject: f.actorA,
});
async function read(statement: string, revision?: string): Promise<StatementRead> {
  const query = new URLSearchParams({ actingSubject: f.actorA, ...(revision ? { revision } : {}) });
  return f.json<StatementRead>(
    await f.call('GET', `/v1/statements/${shortId(statement)}?${query}`),
    200,
  );
}
function assertExactTerm(value: StatementValue) {
  if (value.kind !== 'literal') throw new Error('Literal fixture expected');
  const term = new Parser().parse(`<urn:fixture:s> <urn:fixture:p> ${objectTerm(value)} .`)[0]!
    .object;
  expect(term.termType).toBe('Literal');
  if (term.termType !== 'Literal') throw new Error('N3 did not preserve the RDF literal');
  expect(term.value).toBe(value.lexical);
  expect(term.datatype.value).toBe(value.datatype);
  expect(term.language || null).toBe(value.language);
}

test('qualified literal Statements keep authored terms, speaker identities and exact revisions through native create/read/withdraw', async () => {
  const intent = body();
  const key = randomUUID();
  retained = await f.json<Written>(await f.call('POST', '/v1/statements', intent, key), 201);
  expect(
    await f.json<Written>(await f.call('POST', '/v1/statements', intent, key), 200),
  ).toMatchObject({
    statement: retained.statement,
    revision: retained.revision,
    meaningKey: retained.meaningKey,
    replayed: true,
  });
  const repeated = await f.json<Written>(await f.call('POST', '/v1/statements', intent), 201);
  const other = await f.json<Written>(
    await f.call(
      'POST',
      '/v1/statements',
      {
        ...intent,
        actingSubject: f.actorB,
      },
      randomUUID(),
      f.account.tokenB,
    ),
    201,
  );
  expect(new Set([retained.statement, repeated.statement, other.statement]).size).toBe(3);
  expect(new Set([retained.meaningKey, repeated.meaningKey, other.meaningKey]).size).toBe(1);
  expect((await read(other.statement)).speaker).toBe(f.actorB);
  const active = await read(retained.statement);
  expect(active).toMatchObject({
    state: 'active',
    revision: retained.revision,
    speaker: f.actorA,
    qualification: qualification(),
    value: numericValue(),
    predicate: predicate.component,
    relationDefinition: predicate.revision,
    meaningBasis: {
      state: 'defined',
      interpretationDefinitions: [interpretationDefinition.revision],
    },
  });
  assertExactTerm(numericValue());
  const raw =
    (
      await f.env.fuseki.query(`SELECT ?value WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(retained.statement)} <${RDF}object> ?value } }`)
    ).results?.bindings ?? [];
  expect(raw).toHaveLength(1);
  expect(raw[0]!.value!.datatype).toBe(`${XSD}integer`);
  // TDB may canonicalize 001 to 1; the exact authored manifest is the read authority.
  expect(BigInt(raw[0]!.value!.value)).toBe(1n);
  expect(active.export[`${RDF}object`]).toEqual([{ '@value': '001', '@type': `${XSD}integer` }]);
  expect(active.export[`${RV}qualificationDefinition`]).toEqual([
    { '@id': qualificationDefinition.revision },
  ]);
  expect(active.export[predicate.component]).toBeUndefined();
  expect(
    (
      await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(subject)} ${iri(predicate.component)} ?baseValue } }`)
    ).boolean,
  ).toBe(false);

  for (const value of [
    { kind: 'literal', lexical: '雨\n"quoted"', datatype: `${RDF}langString`, language: 'ja' },
    {
      kind: 'literal',
      lexical: '01.00',
      datatype: 'https://example.test/ExactLexicalDatatype',
      language: null,
    },
  ] as StatementValue[]) {
    assertExactTerm(value);
    const receipt = await f.json<Written>(await f.call('POST', '/v1/statements', body(value)), 201);
    expect(receipt.meaningKey).not.toBe(retained.meaningKey);
    expect((await read(receipt.statement)).value).toEqual(value);
    expect((await read(receipt.statement, receipt.revision)).value).toEqual(value);
  }
  const withdrawn = await f.json<{ revision: string }>(
    await f.call('POST', `/v1/statements/${shortId(retained.statement)}/withdrawals`, {
      profile: 'statement-v1',
      speaker: { kind: 'personal' },
      expectedHead: retained.revision,
      actingSubject: f.actorA,
    }),
    201,
  );
  expect(await read(retained.statement)).toMatchObject({
    state: 'withdrawn',
    revision: withdrawn.revision,
    meaningKey: retained.meaningKey,
    qualification: qualification(),
    value: numericValue(),
  });
  expect(await read(retained.statement, retained.revision)).toMatchObject({
    state: 'active',
    revision: retained.revision,
    qualification: qualification(),
    value: numericValue(),
    meaningKey: retained.meaningKey,
  });
  const evidence =
    (
      await f.env.fuseki.query(`SELECT ?evidence WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(retained.revision)} <${RV}evidence> ?evidence } }`)
    ).results?.bindings ?? [];
  expect(evidence.map((row) => row.evidence!.value)).toEqual(intent.evidence);
}, 120_000);

test('Statement admission rejects unauthorized writers, mismatched meaning and stale exact definition pins', async () => {
  const intent = body();
  expect((await f.call('POST', '/v1/statements', intent, randomUUID(), null)).status).toBe(401);
  expect(
    (await f.call('POST', '/v1/statements', intent, randomUUID(), f.account.noScope)).status,
  ).toBe(401);
  await f.revoke(recordGrant);
  expect((await f.call('POST', '/v1/statements', intent)).status).toBe(403);
  recordGrant = await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
  expect(
    (
      await f.call('POST', '/v1/statements', {
        ...intent,
        predicate: 'https://schema.org/datePublished',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.call('POST', '/v1/statements', {
        ...intent,
        qualification: { ...intent.qualification, definition: interpretationDefinition.revision },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.call('POST', '/v1/statements', {
        ...intent,
        qualification: { ...intent.qualification, arbitraryMeaning: 'ignored' },
      })
    ).status,
  ).toBe(400);

  const hiddenScope = nativeId();
  const scoped = await f.json<Written>(
    await f.call('POST', '/v1/statements', {
      ...intent,
      qualification: { ...intent.qualification, interpretationContext: hiddenScope },
    }),
    201,
  );
  const hiddenRead = await f.call(
    'GET',
    `/v1/statements/${shortId(scoped.statement)}`,
    undefined,
    randomUUID(),
    null,
  );
  expect(hiddenRead.status).toBe(404);
  expect(await hiddenRead.text()).not.toContain(hiddenScope);

  // Advance the predicate after its preparation read, immediately before the
  // Statement command enters Jena. The same native transaction must refuse it.
  const originalGraph = f.env.fuseki;
  const originalWrite = originalGraph.commandWithReceipt.bind(originalGraph);
  let trigger = true;
  const race: { statement?: string; receipt?: string; nextPredicate?: SemanticChangeResult } = {};
  f.env.fuseki = new Proxy(originalGraph, {
    get(target, property) {
      if (property === 'commandWithReceipt')
        return async (envelope: CommandEnvelope) => {
          const statementValidation = envelope.validations.find(
            (validation) =>
              validation.shape === 'https://rezics.com/definition/statement-v1/statement-shape',
          );
          if (trigger && statementValidation && envelope.update.includes('a rdf:Statement')) {
            trigger = false;
            race.statement = statementValidation.focus[0];
            race.receipt = envelope.receipt;
            race.nextPredicate = await define(propertyState, predicate);
          }
          return originalWrite(envelope);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const raced = await f.call('POST', '/v1/statements', intent, randomUUID());
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ code: 'target_unavailable' });
  } finally {
    f.env.fuseki = originalGraph;
  }
  expect(trigger).toBe(false);
  if (!race.statement || !race.receipt || !race.nextPredicate)
    throw new Error('Definition race did not execute');
  const nextPredicate = race.nextPredicate;
  expect(
    (
      await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(race.statement)} ?predicate ?object } }`)
    ).boolean,
  ).toBe(false);
  expect(
    (
      await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.revisions)} {
    ?revision <${RV}component> ${iri(race.statement)} } }`)
    ).boolean,
  ).toBe(false);
  expect(
    (
      await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(race.receipt)} <${RV}outcome> <${RV}Cancelled> ; <${RV}reason> <${RV}Unavailable> .
    FILTER NOT EXISTS { ${iri(race.receipt)} <${RV}component> ?component } } }`)
    ).boolean,
  ).toBe(true);

  const stalePredicate = await f.call('POST', '/v1/statements', intent);
  expect(stalePredicate.status).toBe(409);
  expect(await stalePredicate.json()).toMatchObject({ code: 'target_unavailable' });
  const nextQualification = await define(qualificationState, qualificationDefinition);
  expect(
    (
      await f.call('POST', '/v1/statements', {
        ...intent,
        relationDefinition: nextPredicate.revision,
      })
    ).status,
  ).toBe(409);
  await define(interpretationState, interpretationDefinition);
  expect(
    (
      await f.call('POST', '/v1/statements', {
        ...intent,
        relationDefinition: nextPredicate.revision,
        qualification: { ...intent.qualification, definition: nextQualification.revision },
      })
    ).status,
  ).toBe(409);
  // Current heads may advance without changing the recorded Statement's historical pins.
  expect(await read(retained.statement, retained.revision)).toMatchObject({
    state: 'active',
    revision: retained.revision,
    relationDefinition: predicate.revision,
    qualification: qualification(),
    value: numericValue(),
    meaningKey: retained.meaningKey,
    meaningBasis: {
      state: 'defined',
      interpretationDefinitions: [interpretationDefinition.revision],
    },
  });
}, 120_000);
