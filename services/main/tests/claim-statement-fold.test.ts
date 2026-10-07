import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import {
  CommandOutcomeUnknown,
  FusekiClient,
  type CommandEnvelope,
  type SparqlResult,
} from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import {
  objectTerm,
  prepareRetainedClaimStatementMeaning,
} from '../src/modules/statement/graph.ts';
import {
  DATE_PUBLISHED_PREDICATE,
  DATE_PUBLISHED_DEFINITION_NOTATION,
  QUALIFICATION_DEFINITION_NOTATION,
  statementQualificationExport,
  statementQualificationKeyTuple,
  statementQualificationTriples,
  validateRetainedClaimStatementDefinitions,
  type StatementQualification,
} from '../src/modules/statement/qualification.ts';
import {
  STATEMENT_PROFILE,
  statementMeaningKey,
  type StatementValue,
} from '../src/modules/statement/schema.ts';
import {
  definitionKindIri,
  PROFILES,
  type DefinitionKind,
} from '../src/modules/semantic/schema.ts';
import { outboxEventHandlers } from '../src/modules/verification/outbox-event.ts';
import {
  ADMISSIONS,
  CLAIM_PROFILE,
  claimDigest,
  graphHeads,
  readClaimHead,
  readClaimRevisions,
  receiptIri,
} from '../src/modules/verification/graph.ts';
import {
  claimStatementFoldFence,
  ClaimStatementFoldNativeHookRequired,
  ClaimStatementFoldStale,
  ClaimStatementFoldUnavailable,
  convertEligibleClaimsTurn,
  executeClaimStatementFold,
  prepareClaimStatementFold,
} from '../src/modules/verification/claim-fold.ts';
import {
  assessAdmittedClaim,
  createAdmittedClaim,
  readClaimQuality,
  type AssessClaimInput,
  type VerificationDependencies,
} from '../src/modules/verification/operations.ts';
import {
  VerificationMissing,
  type AnalysisSnapshot,
  type SummaryState,
  type VerificationStore,
} from '../src/modules/verification/store.ts';
import {
  GRAPHS,
  CancelledActivation,
  hash,
  prepareComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
const qualification = (): StatementQualification => ({
  definition: id(3),
  interpretationContext: 'urn:reviewed:proposition:scope',
  valuePrecision: 'approximate',
  valueQualifiers: ['disputed-attribution', 'inferred'],
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z',
  editionScope: 'https://edition.example/first',
});
const input = (
  value: StatementValue = {
    kind: 'literal',
    lexical: '0001-01-01',
    datatype: `${XSD}date`,
    language: null,
  },
) => ({
  subject: 'urn:retained:original-referent',
  predicate: DATE_PUBLISHED_PREDICATE,
  relationDefinition: id(2),
  value,
  qualification: qualification(),
});

test('the reviewed retained Claim adapter preserves original referents and exact Date/DateTime terms', () => {
  for (const subject of ['urn:retained:original-referent', 'https://publisher.example/work']) {
    for (const value of [
      { kind: 'literal', lexical: '0001-01-01', datatype: `${XSD}date`, language: null },
      {
        kind: 'literal',
        lexical: '2026-01-01T00:00:00.000Z',
        datatype: `${XSD}dateTime`,
        language: null,
      },
      {
        kind: 'literal',
        lexical: '2026-01-01T00:00:00Z',
        datatype: `${XSD}dateTime`,
        language: null,
      },
      {
        kind: 'literal',
        lexical: '2026-01-01T08:00:00.123456789+08:00',
        datatype: `${XSD}dateTime`,
        language: null,
      },
      {
        kind: 'literal',
        lexical: '2026-01-01T00:00:00',
        datatype: `${XSD}dateTime`,
        language: null,
      },
    ] as StatementValue[]) {
      const meaning = prepareRetainedClaimStatementMeaning({ ...input(value), subject });
      expect(meaning).toMatchObject({
        subject,
        predicate: 'https://schema.org/datePublished',
        relationDefinition: id(2),
        value,
        qualification: qualification(),
        interpretationDefinitions: [id(3)],
        applicability: [],
      });
      expect(statementMeaningKey(meaning)).toMatch(/^urn:rezics:meaning:[0-9a-f]{64}$/);
      const term = new Parser().parse(`<urn:test:s> <urn:test:p> ${objectTerm(value)} .`)[0]!
        .object;
      expect(term.termType).toBe('Literal');
      if (term.termType !== 'Literal' || value.kind !== 'literal')
        throw new Error('Literal fixture expected');
      expect(term.value).toBe(value.lexical);
      expect(term.datatype.value).toBe(value.datatype);
      expect(term.language).toBe('');
    }
  }
});

test('the eligible adapter cannot relabel another predicate, datatype or language as first publication', () => {
  expect(() =>
    prepareRetainedClaimStatementMeaning({
      ...input(),
      predicate: 'https://schema.org/dateCreated',
    }),
  ).toThrow();
  for (const value of [
    { kind: 'resource', iri: 'https://publisher.example/date' },
    { kind: 'literal', lexical: '2026', datatype: `${XSD}integer`, language: null },
    { kind: 'literal', lexical: '2026-01-01', datatype: `${XSD}string`, language: null },
    { kind: 'literal', lexical: '2026-01-01', datatype: `${RDF}langString`, language: 'en' },
  ] as StatementValue[])
    expect(() => prepareRetainedClaimStatementMeaning(input(value))).toThrow();
  for (const lexical of ['2026-02-30', '2026-02-30T00:00:00Z']) {
    const datatype = lexical.includes('T') ? `${XSD}dateTime` : `${XSD}date`;
    expect(() =>
      prepareRetainedClaimStatementMeaning(
        input({ kind: 'literal', lexical, datatype, language: null }),
      ),
    ).toThrow();
  }
  expect(() =>
    statementMeaningKey({
      subject: 'urn:retained:original-referent',
      predicate: DATE_PUBLISHED_PREDICATE,
      relationDefinition: id(2),
      interpretationDefinitions: [],
      value: input().value,
      applicability: [],
    }),
  ).toThrow();
});

test('eligible Claim qualification dimensions and exact D/Q pins remain separate meanings', () => {
  const original = prepareRetainedClaimStatementMeaning(input());
  const keys = [statementMeaningKey(original)];
  for (const change of [
    { definition: id(4) },
    { interpretationContext: 'urn:reviewed:other-scope' },
    { valuePrecision: 'uncertain' },
    { valueQualifiers: ['inferred'] },
    { validFrom: null },
    { validUntil: null },
    { editionScope: null },
  ] as Partial<StatementQualification>[]) {
    keys.push(
      statementMeaningKey(
        prepareRetainedClaimStatementMeaning({
          ...input(),
          qualification: { ...qualification(), ...change },
        }),
      ),
    );
  }
  keys.push(
    statementMeaningKey(
      prepareRetainedClaimStatementMeaning({ ...input(), relationDefinition: id(5) }),
    ),
  );
  expect(new Set(keys).size).toBe(keys.length);
  expect(
    statementMeaningKey(
      prepareRetainedClaimStatementMeaning({
        ...input(),
        qualification: {
          ...qualification(),
          valueQualifiers: ['inferred', 'disputed-attribution'],
        },
      }),
    ),
  ).toBe(keys[0]);
});

function definitionFixture() {
  mkdirSync('.temp', { recursive: true });
  const objectDirectory = mkdtempSync(join('.temp', 'claim-fold-definition-'));
  temporary.push(objectDirectory);
  const graph = new FusekiClient('http://unused.invalid');
  const env: WorkActivationEnvironment = {
    fuseki: graph,
    objectDirectory,
    lineage: { dataEpoch: '00000000-0000-4000-8000-000000000001', routingEpoch: '1' },
  };
  const definitions = new Map<
    string,
    { definition: string; manifest: string; kind: DefinitionKind; lifecycle: string; head: string }
  >();
  const queries: string[] = [];
  function define(revision: string, definition: string, kind: DefinitionKind, notation: string) {
    const manifest = prepareComponent(
      objectDirectory,
      definition,
      { component: 'definition', kind, roles: [], lifecycle: 'active', successor: null, notation },
      PROFILES.definition,
    );
    definitions.set(revision, {
      definition,
      manifest: `urn:rezics:sha256:${manifest}`,
      kind,
      lifecycle: `${RV}Active`,
      head: revision,
    });
  }
  const uri = (value: string) => ({ type: 'uri', value });
  graph.query = async (text) => {
    queries.push(text);
    if (!text.includes('SELECT ?revision ?definition ?manifest'))
      throw new Error(`Unexpected metadata query: ${text}`);
    const bindings = [...definitions]
      .filter(([revision]) => text.includes(`<${revision}>`))
      .map(([revision, value]) => ({
        revision: uri(revision),
        definition: uri(value.definition),
        manifest: uri(value.manifest),
        kind: uri(definitionKindIri(value.kind)),
        lifecycle: uri(value.lifecycle),
        head: uri(value.head),
      }));
    return { results: { bindings } } as SparqlResult;
  };
  define(id(2), id(10), 'property', DATE_PUBLISHED_DEFINITION_NOTATION);
  define(id(3), id(11), 'interpretation', QUALIFICATION_DEFINITION_NOTATION);
  return { env, definitions, define, queries };
}

test('D binds only the fixed reviewed original publication predicate and Q binds the finite qualification', async () => {
  const f = definitionFixture();
  const pins = { relationDefinition: id(2), qualificationDefinition: id(3) };
  const checked = await validateRetainedClaimStatementDefinitions(f.env, pins);
  expect(checked.guard).toContain(`<${id(2)}>`);
  expect(checked.guard).toContain(`<${id(3)}>`);
  expect(f.queries).toHaveLength(1);
  await expect(
    validateRetainedClaimStatementDefinitions(f.env, pins, async () => false),
  ).rejects.toThrow();
  f.define(id(2), id(10), 'property', 'unreviewed-publication-meaning');
  await expect(validateRetainedClaimStatementDefinitions(f.env, pins)).rejects.toThrow();
  f.define(id(2), id(10), 'property', DATE_PUBLISHED_DEFINITION_NOTATION);
  f.define(id(3), id(11), 'interpretation', 'generic-opaque-bag');
  await expect(validateRetainedClaimStatementDefinitions(f.env, pins)).rejects.toThrow();
  f.define(id(3), id(11), 'interpretation', QUALIFICATION_DEFINITION_NOTATION);
  f.definitions.get(id(2))!.head = id(99);
  await expect(validateRetainedClaimStatementDefinitions(f.env, pins)).rejects.toThrow();
});

test('historical Claim creation replay remains closed over its original R terminal after representation changes', async () => {
  const graph = new FusekiClient('http://unused.invalid');
  const admissionId = '00000000-0000-4000-8000-000000000001';
  const receipt = receiptIri(admissionId, 'claim-create');
  const epoch = '00000000-0000-4000-8000-000000000002';
  const digest = 'a'.repeat(64);
  const operation = id(20),
    claim = id(21),
    revision = id(22);
  const values: Record<string, string> = {
    admissionId,
    receipt,
    digest,
    authorityEpoch: '7',
    scope: ADMISSIONS['claim-create'].scope,
    operation,
    eventOperation: operation,
    epoch,
    sequence: '41',
    outcome: `${RV}Succeeded`,
  };
  const literal = (value: string) => ({ type: 'literal', value });
  const uri = (value: string) => ({ type: 'uri', value });
  const queries: string[] = [];
  graph.query = async (text) => {
    queries.push(text);
    if (!text.includes('SELECT ?outcome ?digest ?id ?epoch ?scope')) {
      throw new Error('Historical event replay attempted to resolve current meaning');
    }
    return {
      results: {
        bindings: [
          ['claim', claim],
          ['claimRevision', revision],
        ].map(([key, value]) => ({
          outcome: uri(`${RV}Succeeded`),
          digest: literal(digest),
          id: literal(admissionId),
          epoch: literal('7'),
          scope: literal(ADMISSIONS['claim-create'].scope),
          dataEpoch: literal(epoch),
          sequence: literal('41'),
          key: uri(`${RV}${key}`),
          value: uri(value!),
        })),
      },
    };
  };
  const handler = outboxEventHandlers.find((item) => item.kind === `${RV}ClaimCreatedEvent`)!;
  const event = await handler.read({
    fuseki: graph,
    batch: {
      batchId: 'urn:retained:batch',
      dataEpoch: epoch,
      sequence: '41',
      routingEpoch: '2',
      eventIds: ['urn:retained:event'],
    },
    eventId: 'urn:retained:event',
    ordinal: 0,
    value: (name) => values[name],
  });
  expect(event.data.receipt).toMatchObject({
    id: receipt,
    claim,
    claimRevision: revision,
    outcome: 'succeeded',
    admissionId,
    requestDigest: digest,
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).not.toContain('rv:claimHead');
  expect(queries[0]).not.toContain('rv:head');
  values.sequence = '42';
  await expect(
    handler.read({
      fuseki: graph,
      batch: {
        batchId: 'urn:retained:batch',
        dataEpoch: epoch,
        sequence: '41',
        routingEpoch: '2',
        eventIds: ['urn:retained:event'],
      },
      eventId: 'urn:retained:event',
      ordinal: 0,
      value: (name) => values[name],
    }),
  ).rejects.toThrow();
});

function foldedVerificationFixture(qualified = qualification()) {
  mkdirSync('.temp', { recursive: true });
  const objectDirectory = mkdtempSync(join('.temp', 'claim-fold-verification-'));
  temporary.push(objectDirectory);
  const graph = new FusekiClient('http://unused.invalid');
  const env: WorkActivationEnvironment = {
    fuseki: graph,
    objectDirectory,
    lineage: { dataEpoch: '00000000-0000-4000-8000-000000000001', routingEpoch: '1' },
  };
  const claim = id(50),
    source = id(51),
    revision = id(52),
    speaker = id(53),
    operation = id(54);
  const meaning = prepareRetainedClaimStatementMeaning({ ...input(), qualification: qualified });
  const manifest = prepareComponent(
    objectDirectory,
    claim,
    {
      revision,
      meaning,
      meaningKey: statementMeaningKey(meaning),
      speaker,
      semanticContextRevision: null,
      state: 'active',
      evidence: [],
      recordedBy: speaker,
      retainedSourceRevision: source,
      retainedSourceReceipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
    STATEMENT_PROFILE,
  );
  const uri = (value: string) => ({ type: 'uri', value });
  const literal = (value: string, datatype = `${XSD}string`) => ({
    type: 'literal',
    value,
    datatype,
  });
  let root = source;
  graph.query = async (text) => {
    if (text.includes('SELECT ?revision ?claim ?head ?referent')) {
      return {
        results: {
          bindings: text.includes(`<${source}>`)
            ? ['DisputedAttribution', 'InferredValue'].map((qualifier) => ({
                revision: uri(source),
                claim: uri(claim),
                head: uri(revision),
                referent: uri(meaning.subject),
                context: uri(qualified.interpretationContext),
                predicate: uri(DATE_PUBLISHED_PREDICATE),
                value: literal('0001-01-01', `${XSD}date`),
                precision: uri(`${RV}ApproximateValue`),
                qualifier: uri(`${RV}${qualifier}`),
                from: literal(qualified.validFrom!, `${XSD}dateTime`),
                until: literal(qualified.validUntil!, `${XSD}dateTime`),
                edition: uri(qualified.editionScope!),
                status: uri(`${RV}Asserted`),
                statedBy: uri(speaker),
                recordedAt: literal('2026-10-01T00:00:00.000Z', `${XSD}dateTime`),
                epoch: literal(env.lineage.dataEpoch),
                sequence: literal('7', `${XSD}integer`),
              }))
            : [],
        },
      };
    }
    if (text.includes('SELECT ?revision ?claim ?head ?source ?root')) {
      return {
        results: {
          bindings: text.includes(`<${revision}>`)
            ? [
                {
                  revision: uri(revision),
                  claim: uri(claim),
                  head: uri(revision),
                  source: uri(root),
                  root: uri(source),
                  sourceReceipt: uri(`urn:rezics:receipt:${'b'.repeat(64)}`),
                  flatRecordedAt: literal('2026-10-01T00:00:00.000Z', `${XSD}dateTime`),
                  statedBy: uri(speaker),
                  recordedAt: literal('2026-10-01T00:00:00.000Z', `${XSD}dateTime`),
                },
              ]
            : [],
        },
      };
    }
    if (text.includes('SELECT ?manifest ?state ?operation ?recordedBy')) {
      return {
        results: {
          bindings: [
            {
              manifest: uri(`urn:rezics:sha256:${manifest}`),
              state: uri(`${RV}Active`),
              operation: uri(operation),
              recordedBy: uri(speaker),
              epoch: literal(env.lineage.dataEpoch),
              sequence: literal('41', `${XSD}integer`),
            },
          ],
        },
      };
    }
    if (text.includes('SELECT ?reference ?head ?epoch ?sequence'))
      return {
        results: {
          bindings: [
            {
              reference: uri(claim),
              head: uri(revision),
              epoch: literal(env.lineage.dataEpoch),
              sequence: literal('41', `${XSD}integer`),
            },
          ],
        },
      };
    if (text.includes('SELECT ?head WHERE'))
      return { results: { bindings: [{ head: uri(revision) }] } };
    throw new Error(`Unexpected bounded verification metadata query: ${text}`);
  };
  return {
    env,
    claim,
    source,
    revision,
    speaker,
    meaning,
    corruptRoot: () => {
      root = id(99);
    },
  };
}

test('verification exact R remains a Claim while current B is a qualified Statement with the original speaker', async () => {
  const f = foldedVerificationFixture();
  const exact = await readClaimRevisions(f.env, [f.source, f.revision]);
  expect(exact.get(f.source)).toMatchObject({
    representation: 'claim',
    revision: f.source,
    head: f.revision,
    statedBy: f.speaker,
    rdfValue: f.meaning.value,
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(exact.get(f.revision)).toMatchObject({
    representation: 'statement',
    revision: f.revision,
    head: f.revision,
    retainedSourceRevision: f.source,
    statedBy: f.speaker,
    rdfValue: f.meaning.value,
    interpretationContext: qualification().interpretationContext,
    valuePrecision: qualification().valuePrecision,
    valueQualifiers: qualification().valueQualifiers,
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(await readClaimHead(f.env, f.claim)).toEqual(exact.get(f.revision)!);
  expect(
    (await graphHeads(f.env, [{ kind: 'claim', reference: f.claim }])).heads.get(f.claim),
  ).toBe(f.revision);
  f.corruptRoot();
  await expect(readClaimRevisions(f.env, [f.revision])).rejects.toThrow();
});

test('a quality summary pinned to R becomes stale against B without relabelling its historical dependency', async () => {
  const f = foldedVerificationFixture();
  const old: SummaryState = {
    generation: id(60),
    number: '1',
    target: f.claim,
    context: 'urn:evaluation:publication',
    claim: f.claim,
    claimRevision: f.source,
    adoptedRevision: null,
    assessment: id(61),
    policyRevision: id(62),
    support: 'supported',
    review: 'reviewed',
    dispute: 'none',
    coverage: 'complete',
    dependence: 'established',
    reasonCodes: ['independent-origins'],
    ownerPositions: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    dependencies: [
      {
        owner: 'graph',
        kind: 'claim',
        reference: f.claim,
        expectedHead: f.source,
        currentHead: f.source,
      },
    ],
    pendingWork: false,
  };
  const before = structuredClone(old);
  let active = old;
  const store = {
    readSummary: async () => active,
    evidenceHead: async () => id(63),
  } as unknown as VerificationStore;
  const stale = await readClaimQuality({ env: f.env, store }, f.claim, old.context);
  expect(stale?.quality).toMatchObject({
    freshness: 'stale',
    claimRevision: f.source,
    staleDependencies: [
      { kind: 'claim', reference: f.claim, expectedHead: f.source, currentHead: f.revision },
    ],
  });
  expect(old).toEqual(before);
  active = {
    ...old,
    generation: id(64),
    number: '2',
    claimRevision: f.revision,
    dependencies: [{ ...old.dependencies[0]!, expectedHead: f.revision }],
  };
  const current = await readClaimQuality({ env: f.env, store }, f.claim, old.context);
  expect(current?.quality).toMatchObject({
    freshness: 'current',
    claimRevision: f.revision,
    staleDependencies: [],
  });
  expect(old).toEqual(before);
});

test('a new assessment of B cannot reuse an evidence manifest pinned to historical R', async () => {
  const f = foldedVerificationFixture();
  const metadata = f.env.fuseki.query.bind(f.env.fuseki);
  const commands: CommandEnvelope[] = [];
  let registered: RegisteredAdmission | undefined;
  let cancelled = false;
  const uri = (value: string) => ({ type: 'uri', value });
  const literal = (value: string) => ({ type: 'literal', value });
  f.env.fuseki.query = async (text) => {
    if (text.includes('ASK'))
      return { boolean: !text.includes('rv:rejectionKind rv:InvalidProfile') };
    if (text.includes('SELECT ?outcome ?digest ?id ?epoch ?scope')) {
      return {
        results: {
          bindings:
            cancelled && registered
              ? [
                  {
                    outcome: uri(`${RV}Cancelled`),
                    digest: literal(registered.requestDigest),
                    id: literal(registered.id),
                    epoch: literal(registered.authorityEpoch),
                    scope: literal(registered.scope),
                    dataEpoch: literal(f.env.lineage.dataEpoch),
                    sequence: literal('42'),
                  },
                ]
              : [],
        },
      };
    }
    return metadata(text);
  };
  f.env.fuseki.commandWithReceipt = async (envelope) => {
    commands.push(envelope);
    expect(envelope.update).toContain('rv:outcome rv:Cancelled');
    expect(envelope.update).not.toMatch(/\ba\s+rv:ClaimAssessment(?:\s|[,;.])/u);
    cancelled = true;
    return {
      status: 'committed',
      position: { datasetId: 'product', dataEpoch: f.env.lineage.dataEpoch, sequence: '42' },
    };
  };
  const snapshot: AnalysisSnapshot = {
    revision: {
      revision: id(70),
      claim: f.claim,
      claimRevision: f.source,
      purpose: 'claim-head',
      predecessor: null,
      itemCount: 0,
      manifestDigest: 'a'.repeat(64),
      createdAt: '2026-10-01T00:00:00.000Z',
      items: [],
    },
    evidenceHead: id(70),
    links: [],
    truncated: false,
    visited: [],
    lineageHeads: new Map(),
    dispositionHeads: new Map(),
    recordOf: new Map(),
    observedAt: new Map(),
    challenge: { revision: null, open: 0, resolved: 0 },
    walk: id(71),
    complete: true,
    lineageNodes: 0,
    continuation: null,
    stepReplayed: false,
    work: { expansions: 0, links: 0 },
    totalWork: { expansions: 0, links: 0 },
    lineageProof: { dependence: 'unknown', independentOrigins: null, origins: [] },
  };
  const dependencies: VerificationDependencies = {
    env: f.env,
    account: { verify: async () => ({ issuer: 'https://account.example', subject: 'reviewer' }) },
    access: {
      activePrincipalId: async () => 'reviewer',
      register: async (request) => {
        registered = {
          id: '00000000-0000-4000-8000-000000000072',
          principalId: 'reviewer',
          actingSubject: request.actingSubject,
          scope: request.scope,
          action: request.action,
          requestDigest: request.requestDigest,
          idempotencyKey: request.idempotencyKey,
          authorityEpoch: '1',
          expiresAt: '2099-01-01T00:00:00.000Z',
          state: 'registered',
          dispatchEligible: true,
          replayed: false,
        };
        return registered;
      },
      claim: async () => {
        if (!registered) throw new Error('Missing test admission');
        return { ...registered, state: 'claimed', claimedAt: '2026-10-01T00:00:00.000Z' };
      },
      recordGraphOutcome: async () => {
        throw new Error('Refused assessment published a successful outcome');
      },
    },
    store: { analysisSnapshot: async () => snapshot } as unknown as VerificationStore,
  };
  const intent: AssessClaimInput & { idempotencyKey: string } = {
    claimRevision: f.revision,
    evidenceSetRevision: id(70),
    sourceAssessments: [],
    method: 'automated',
    judgment: null,
    evaluationContext: qualification().interpretationContext,
    adoptedRevision: null,
    scorePerMillion: null,
    calibration: null,
    limitations: 'An exact Statement assessment requires its own evidence pin.',
    expectedSummary: null,
    resolvesChallenges: [],
    actingSubject: f.speaker,
    idempotencyKey: 'wrong-evidence-pin',
  };
  await expect(
    assessAdmittedClaim(
      dependencies,
      new Request('https://main.example/assessments'),
      f.claim,
      intent,
    ),
  ).rejects.toBeInstanceOf(VerificationMissing);
  expect(commands).toHaveLength(1);
  expect(snapshot.revision.claimRevision).toBe(f.source);
});

/** Exact owner metadata and receipts only; this fixture does not execute SPARQL. */
function retainedRootFixture() {
  const f = definitionFixture();
  const definitionQuery = f.env.fuseki.query.bind(f.env.fuseki);
  const claim = id(80),
    revision = id(81),
    speaker = id(82),
    operation = id(83);
  const admissionId = '00000000-0000-4000-8000-000000000084';
  const sourceReceipt = receiptIri(admissionId, 'claim-create');
  const uri = (value: string) => ({ type: 'uri', value });
  const literal = (value: string, datatype = `${XSD}string`) => ({
    type: 'literal',
    value,
    datatype,
  });
  type Row = NonNullable<SparqlResult['results']>['bindings'][number];
  const property = (predicate: string, object: Row[string]) => ({
    predicate: uri(predicate),
    object,
  });
  const identity = [
    property(`${RV}referent`, uri(input().subject)),
    property(`${RV}interpretationContext`, uri(qualification().interpretationContext)),
    property(`${RV}propositionPredicate`, uri(DATE_PUBLISHED_PREDICATE)),
  ];
  const current: Row[] = [
    property(`${RDF}type`, uri(`${RV}Claim`)),
    ...identity,
    property(`${RV}claimHead`, uri(revision)),
    property(`${RV}claimState`, uri(`${RV}Active`)),
  ];
  const source: Row[] = [
    property(`${RDF}type`, uri(`${RV}ClaimRevision`)),
    property(`${RDF}type`, uri(`${RV}RevisionAnchor`)),
    ...identity,
    property(`${RV}component`, uri(claim)),
    property(`${RV}propositionValue`, literal('0001-01-01', `${XSD}date`)),
    property(`${RV}valuePrecision`, uri(`${RV}ApproximateValue`)),
    property(`${RV}valueQualifier`, uri(`${RV}DisputedAttribution`)),
    property(`${RV}valueQualifier`, uri(`${RV}InferredValue`)),
    property(`${RV}validFrom`, literal(qualification().validFrom!, `${XSD}dateTime`)),
    property(`${RV}validUntil`, literal(qualification().validUntil!, `${XSD}dateTime`)),
    property(`${RV}editionScope`, uri(qualification().editionScope!)),
    property(`${RV}claimStatus`, uri(`${RV}Asserted`)),
    property(`${RV}statedBy`, uri(speaker)),
    property(`${RV}recordedAt`, literal('2026-10-01T00:00:00Z', `${XSD}dateTime`)),
    property(`${RV}modelRevision`, uri(CLAIM_PROFILE)),
    property(`${RV}shapeRevision`, uri(CLAIM_PROFILE)),
    property(`${RV}dataEpoch`, literal(f.env.lineage.dataEpoch)),
    property(`${RV}sequence`, literal('7', `${XSD}integer`)),
  ];
  const originalReceipt: Row = {
    receipt: uri(sourceReceipt),
    operation: uri(operation),
    admission: literal(admissionId),
    digest: literal('c'.repeat(64)),
    epoch: literal('1'),
    scope: literal(ADMISSIONS['claim-create'].scope),
    dataEpoch: literal(f.env.lineage.dataEpoch),
    sequence: literal('7', `${XSD}integer`),
  };
  const state: {
    roots: Row[];
    owned: boolean;
    held: boolean;
    mode: 'commit' | 'lost-ack' | 'crash' | 'stale' | 'invalid';
    terminal?: Row;
    targetReplay?: Row;
    meaningKey?: string;
    coverage: boolean;
    coverageSequence: string;
    afterSeekCommit?: () => void;
    accessOpen: boolean;
    failAccessCloseOnce?: boolean;
    acquired?: Row;
  } = {
    roots: [{ revision: uri(revision) }],
    owned: true,
    held: true,
    mode: 'commit',
    coverage: true,
    coverageSequence: '41',
    accessOpen: false,
  };
  const commands: CommandEnvelope[] = [];
  f.env.fuseki.commandHealth = async () => ({
    moduleVersion: 'fixture',
    instanceId: 'fixture',
    publicSearchWriteEpoch: '0',
    publicSearchWriteActive: false,
    profiles: Object.fromEntries(
      Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256]),
    ),
  });
  f.env.fuseki.query = async (text) => {
    if (text.includes('SELECT ?predicate ?object'))
      return { results: { bindings: text.includes(`<${GRAPHS.current}>`) ? current : source } };
    if (text.includes('SELECT ?revision WHERE')) return { results: { bindings: state.roots } };
    if (text.includes('SELECT ?receipt ?operation ?admission'))
      return { results: { bindings: [originalReceipt] } };
    if (text.includes('SELECT ?digest ?claim ?source ?revision ?template'))
      return {
        results: {
          bindings: text.includes('claim-statement-fold:acquire:')
            ? state.acquired
              ? [state.acquired]
              : []
            : state.terminal
              ? [state.terminal]
              : [],
        },
      };
    if (text.includes('SELECT ?receipt ?revision ?sourceDigest ?digest ?template'))
      return {
        results: {
          bindings: state.targetReplay && text.includes(`<${claim}>`) ? [state.targetReplay] : [],
        },
      };
    if (text.includes('SELECT ?sequence WHERE'))
      return {
        results: {
          bindings:
            state.terminal && state.owned && state.held
              ? [{ sequence: literal('41', `${XSD}integer`) }]
              : [],
        },
      };
    if (text.includes('SELECT ?statement ?subject ?predicate ?key ?app ?type')) {
      return {
        results: {
          bindings:
            state.terminal && state.meaningKey
              ? [
                  {
                    statement: uri(claim),
                    subject: uri(input().subject),
                    predicate: uri(DATE_PUBLISHED_PREDICATE),
                    key: uri(state.meaningKey),
                  },
                ]
              : [],
        },
      };
    }
    if (text.includes('ASK'))
      return { boolean: text.includes('rv:claimStatementFoldFence') ? state.owned : state.held };
    return definitionQuery(text);
  };
  f.env.fuseki.commandWithReceipt = async (envelope) => {
    commands.push(envelope);
    if (state.mode === 'invalid') return { status: 'invalid', report: 'owner hook is unavailable' };
    if (envelope.receipt.includes('claim-statement-fold:acquire:')) {
      state.held = true;
      state.owned = true;
      state.acquired = { digest: literal(envelope.digest) };
      return {
        status: 'committed',
        position: { datasetId: 'product', dataEpoch: f.env.lineage.dataEpoch, sequence: '41' },
      };
    }
    if (state.mode === 'stale') return { status: 'guard-unmatched' };
    if (state.mode === 'crash')
      throw new CommandOutcomeUnknown('interrupted before durable receipt');
    const next = envelope.validations.find((validation) =>
      validation.shape.endsWith('/revision-shape'),
    )!.focus[0]!;
    state.terminal = {
      digest: literal(envelope.digest),
      claim: uri(claim),
      source: uri(revision),
      revision: uri(next),
      template: literal(hash(envelope.update)),
    };
    state.targetReplay = {
      receipt: uri(envelope.receipt),
      revision: uri(next),
      sourceDigest: literal(envelope.update.match(/rv:sourceDigest "([0-9a-f]{64})"/)![1]!),
      digest: literal(envelope.digest),
      template: literal(hash(envelope.update)),
    };
    state.meaningKey = envelope.update.match(/rv:meaningKey <([^>]+)>/)![1]!;
    if (state.mode === 'lost-ack')
      throw new CommandOutcomeUnknown('lost committed acknowledgement');
    return {
      status: 'committed',
      position: { datasetId: 'product', dataEpoch: f.env.lineage.dataEpoch, sequence: '41' },
    };
  };
  const target = {
    claim,
    claimRevision: revision,
    relationDefinition: id(2),
    qualificationDefinition: id(3),
  };
  const sql: { text: string; values: unknown[] }[] = [];
  let seeking = false;
  const query = async (text: string, values: unknown[] = []) => {
    sql.push({ text, values });
    if (text.startsWith('UPDATE access.recovery_fence')) {
      if (state.failAccessCloseOnce) {
        state.failAccessCloseOnce = false;
        throw new Error('Crash at graph/SQL boundary');
      }
      state.accessOpen = false;
      return { rows: [{ generation: '2' }], rowCount: 1 };
    }
    if (text.includes('access.recovery_fence'))
      return { rows: [{ open: state.accessOpen }], rowCount: 1 };
    if (text.includes('SELECT complete,through_sequence'))
      return {
        rows: [{ complete: state.coverage, through_sequence: state.coverageSequence }],
        rowCount: 1,
      };
    if (text.startsWith('INSERT INTO access.statement_seek')) seeking = true;
    if (text === 'COMMIT' && seeking) {
      seeking = false;
      state.afterSeekCommit?.();
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  return {
    ...f,
    claim,
    revision,
    speaker,
    sourceReceipt,
    current,
    source,
    originalReceipt,
    state,
    commands,
    sql,
    target,
    pool,
    fence: claimStatementFoldFence(f.env, target, 'reviewed-first-publication'),
  };
}

test('preparation keeps C, archives its exact descriptor and creates only a fresh B with R provenance', async () => {
  const f = retainedRootFixture();
  const before = structuredClone({
    current: f.current,
    source: f.source,
    receipt: f.originalReceipt,
  });
  const result = await prepareClaimStatementFold(f.env, f.target);
  expect(result.status).toBe('eligible');
  if (result.status !== 'eligible') throw new Error(result.reason);
  const prepared = result.prepared;
  expect(prepared.claim).toBe(f.claim);
  expect(prepared.statementRevision).not.toBe(f.revision);
  expect(prepared.sourceReceipt).toBe(f.sourceReceipt);
  expect(prepared.provenance).toMatchObject({
    retainedSourceRevision: f.revision,
    retainedSourceReceipt: f.sourceReceipt,
    recordedAt: '2026-10-01T00:00:00Z',
  });
  expect(prepared.current).toContain(`<${f.speaker}>`);
  const quads = new Parser({ format: 'TriG' }).parse(`@prefix rv: <${RV}> .
    GRAPH <${GRAPHS.current}> { ${prepared.current} }
    GRAPH <${GRAPHS.revisions}> { ${prepared.historicalCurrent}\n${prepared.revisions} }`);
  expect(quads.some((quad) => quad.subject.value === f.revision)).toBe(false);
  expect(
    quads.some(
      (quad) =>
        quad.subject.value === prepared.statementRevision &&
        quad.predicate.value === `${RV}predecessor`,
    ),
  ).toBe(false);
  expect(
    quads.some(
      (quad) =>
        quad.subject.value === input().subject && quad.predicate.value === DATE_PUBLISHED_PREDICATE,
    ),
  ).toBe(false);
  expect(await prepareClaimStatementFold(f.env, f.target)).toEqual(result);
  expect({ current: f.current, source: f.source, receipt: f.originalReceipt }).toEqual(before);
  expect(f.commands).toHaveLength(0);
  f.state.roots.push({ revision: { type: 'uri', value: id(99) } });
  expect(await prepareClaimStatementFold(f.env, f.target)).toMatchObject({
    status: 'retained',
    reason: 'history-not-one-root',
  });
});

test('a Claim fold refuses an unowned restore fence and a stale local C/R CAS', async () => {
  const f = retainedRootFixture();
  const beforeFiles = readdirSync(f.env.objectDirectory).sort();
  f.state.owned = false;
  await expect(prepareClaimStatementFold(f.env, f.target)).rejects.toThrow(/original restore/);
  expect(readdirSync(f.env.objectDirectory).sort()).toEqual(beforeFiles);
  f.state.owned = true;
  const result = await prepareClaimStatementFold(f.env, f.target);
  if (result.status !== 'eligible') throw new Error(result.reason);
  f.state.owned = false;
  await expect(
    executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool),
  ).rejects.toBeInstanceOf(ClaimStatementFoldUnavailable);
  expect(f.commands).toHaveLength(0);
  const pool = { query: async () => ({ rows: [{ open: false }] }) } as unknown as Pool;
  await expect(
    convertEligibleClaimsTurn(f.env, pool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }],
    }),
  ).rejects.toThrow(/original restore/);
  expect(f.commands).toHaveLength(0);
  f.state.owned = true;
  await expect(executeClaimStatementFold(f.env, result.prepared, f.fence)).rejects.toThrow(
    /closed Access/,
  );
  const openPool = {
    query: async () => ({ rows: [{ open: true }], rowCount: 0 }),
  } as unknown as Pool;
  await expect(
    convertEligibleClaimsTurn(f.env, openPool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }],
    }),
  ).rejects.toThrow(/Access fence is not closed/);
  expect(f.commands).toHaveLength(0);
  f.state.mode = 'stale';
  await expect(
    executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool),
  ).rejects.toBeInstanceOf(ClaimStatementFoldStale);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]!.update).toContain(result.prepared.sourceGuard);
  expect(f.commands[0]!.update).toContain(result.prepared.definitionGuard);
  expect(f.state.terminal).toBeUndefined();
});

test('crash and lost acknowledgement reconcile only the exact same B/receipt/template', async () => {
  const f = retainedRootFixture();
  const result = await prepareClaimStatementFold(f.env, f.target);
  if (result.status !== 'eligible') throw new Error(result.reason);
  f.state.mode = 'crash';
  await expect(
    executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool),
  ).rejects.toBeInstanceOf(ClaimStatementFoldUnavailable);
  f.state.mode = 'lost-ack';
  const converted = await executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool);
  expect(converted).toMatchObject({
    status: 'converted',
    claim: f.claim,
    claimRevision: f.revision,
    statementRevision: result.prepared.statementRevision,
  });
  expect(f.commands[1]!.receipt).toBe(f.commands[0]!.receipt);
  expect(f.commands[1]!.update).toBe(f.commands[0]!.update);
  expect(await executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool)).toEqual({
    ...converted,
    status: 'replayed',
  });
  expect(f.commands).toHaveLength(2);
  f.state.terminal!.template = { type: 'literal', value: '0'.repeat(64) };
  await expect(executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool)).rejects.toThrow(
    /template differs/,
  );
});

test('missing native policy is explicit and an eligible turn never declares population completion', async () => {
  const f = retainedRootFixture();
  const result = await prepareClaimStatementFold(f.env, f.target);
  if (result.status !== 'eligible') throw new Error(result.reason);
  f.state.mode = 'invalid';
  await expect(
    executeClaimStatementFold(f.env, result.prepared, f.fence, f.pool),
  ).rejects.toBeInstanceOf(ClaimStatementFoldNativeHookRequired);
  expect(f.state.terminal).toBeUndefined();
  f.state.mode = 'commit';
  const turn = await convertEligibleClaimsTurn(f.env, f.pool, {
    ...f.target,
    job: f.fence.job,
    claims: [{ claim: f.claim, claimRevision: f.revision }],
  });
  expect(turn).toMatchObject({
    status: 'partial',
    complete: false,
    scope: 'explicit-targets',
    retained: [],
  });
  expect(turn.converted).toHaveLength(1);
  const replaced = f.sql.filter((entry) =>
    entry.text.startsWith('DELETE FROM access.statement_seek'),
  );
  expect(replaced).toHaveLength(1);
  expect(replaced[0]!.values).toEqual([f.env.lineage.dataEpoch, f.claim]);
  expect(f.sql.filter((entry) => entry.text.includes('statement_seek_coverage'))).toHaveLength(1);
  expect(
    f.sql.some((entry) => entry.text.startsWith('UPDATE access.statement_seek_coverage')),
  ).toBe(false);
});

test('unsupported qualifier and validity RDF terms remain retained without staging a relabelled B', async () => {
  type Binding = NonNullable<SparqlResult['results']>['bindings'][number][string];
  const unsupported: [string, Binding][] = [
    ['valueQualifier', { type: 'literal', value: `${RV}InferredValue`, datatype: `${XSD}string` }],
    ['validFrom', { type: 'literal', value: qualification().validFrom!, datatype: `${XSD}string` }],
    [
      'validUntil',
      {
        type: 'literal',
        value: qualification().validUntil!,
        datatype: `${XSD}dateTime`,
        'xml:lang': 'en',
      },
    ],
    [
      'editionScope',
      { type: 'literal', value: qualification().editionScope!, datatype: `${XSD}string` },
    ],
  ];
  for (const [field, object] of unsupported) {
    const f = retainedRootFixture();
    f.source.find((row) => row.predicate!.value === `${RV}${field}`)!.object = object;
    const before = structuredClone(f.source);
    const files = readdirSync(f.env.objectDirectory).sort();
    const result = await prepareClaimStatementFold(f.env, f.target);
    expect(result.status).toBe('retained');
    expect(f.source).toEqual(before);
    expect(readdirSync(f.env.objectDirectory).sort()).toEqual(files);
    expect(f.commands).toHaveLength(0);
  }
});

test('a restarted turn replays converted C before legacy preparation and repairs only its seek reference', async () => {
  const f = retainedRootFixture();
  const prepared = await prepareClaimStatementFold(f.env, f.target);
  if (prepared.status !== 'eligible') throw new Error(prepared.reason);
  const converted = await executeClaimStatementFold(f.env, prepared.prepared, f.fence, f.pool);
  // Only the replay metadata is required after C has changed representation.
  const metadata = f.env.fuseki.query.bind(f.env.fuseki);
  f.env.fuseki.query = async (text) => {
    if (text.includes('SELECT ?predicate ?object') || text.includes('SELECT ?revision WHERE')) {
      throw new Error('Restarted turn tried to prepare an already converted legacy Claim');
    }
    return metadata(text);
  };
  const result = await convertEligibleClaimsTurn(f.env, f.pool, {
    ...f.target,
    job: f.fence.job,
    claims: [{ claim: f.claim, claimRevision: f.revision }],
  });
  expect(result.converted).toEqual([{ ...converted, status: 'replayed' }]);
  expect(result).toMatchObject({ complete: false, retained: [], remaining: [] });
  expect(f.commands).toHaveLength(1);
  const inserted = f.sql.filter((entry) =>
    entry.text.startsWith('INSERT INTO access.statement_seek'),
  );
  expect(inserted).toHaveLength(1);
  expect(inserted[0]!.values.slice(0, 5)).toEqual([
    f.env.lineage.dataEpoch,
    input().subject,
    DATE_PUBLISHED_PREDICATE,
    prepared.prepared.meaningKey,
    f.claim,
  ]);
  f.state.targetReplay!.digest = { type: 'literal', value: '0'.repeat(64) };
  await expect(
    convertEligibleClaimsTurn(f.env, f.pool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }],
    }),
  ).rejects.toThrow(/replay differs/);
  expect(
    f.sql.filter((entry) => entry.text.startsWith('INSERT INTO access.statement_seek')),
  ).toHaveLength(1);
  f.state.targetReplay!.digest = { type: 'literal', value: f.commands[0]!.digest };
  f.state.coverageSequence = '40';
  await expect(
    convertEligibleClaimsTurn(f.env, f.pool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }],
    }),
  ).rejects.toThrow(/complete held Statement seek baseline/);
  expect(f.sql.at(-1)?.text).toBe('ROLLBACK');
  expect(
    f.sql.filter((entry) => entry.text.startsWith('INSERT INTO access.statement_seek')),
  ).toHaveLength(1);
});

test('an acquired job resumes its graph/SQL fence boundary before preparing or dispatching a Claim', async () => {
  const f = retainedRootFixture();
  f.state.owned = false;
  f.state.held = false;
  f.state.accessOpen = true;
  f.state.failAccessCloseOnce = true;
  const targets = {
    ...f.target,
    job: f.fence.job,
    claims: [{ claim: f.claim, claimRevision: f.revision }],
  };
  const before = readdirSync(f.env.objectDirectory).sort();
  await expect(convertEligibleClaimsTurn(f.env, f.pool, targets)).rejects.toThrow(
    /graph\/SQL boundary/,
  );
  expect(f.state).toMatchObject({ held: true, owned: true, accessOpen: true });
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]!.receipt).toContain(':acquire:');
  expect(readdirSync(f.env.objectDirectory).sort()).toEqual(before);
  const result = await convertEligibleClaimsTurn(f.env, f.pool, targets);
  expect(result).toMatchObject({ complete: false, retained: [], remaining: [] });
  expect(result.converted).toHaveLength(1);
  expect(f.state.accessOpen).toBe(false);
  expect(f.commands).toHaveLength(2);
  expect(f.commands[1]!.receipt).toContain(':convert:');
  expect(f.sql.some((entry) => entry.text.startsWith('SET LOCAL statement_timeout ='))).toBe(true);
  expect(
    f.sql.filter((entry) => entry.text.startsWith('INSERT INTO access.statement_seek')),
  ).toHaveLength(1);
});

test('one turn shares a deadline and returns untouched remaining targets after completed work consumes its budget', async () => {
  const f = retainedRootFixture();
  let now = 1000;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const metadata = f.env.fuseki.query.bind(f.env.fuseki);
  let consumedPreparationTime = false;
  f.env.fuseki.query = async (text) => {
    if (!consumedPreparationTime && text.includes('SELECT ?predicate ?object')) {
      consumedPreparationTime = true;
      now += 5000;
    }
    return metadata(text);
  };
  f.state.afterSeekCommit = () => {
    now = 31_001;
  };
  const next = { claim: id(91), claimRevision: id(92) };
  try {
    const result = await convertEligibleClaimsTurn(f.env, f.pool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }, next],
    });
    expect(result).toMatchObject({
      complete: false,
      reason: 'budget-expired',
      remaining: [next],
      retained: [],
    });
    expect(result.converted).toHaveLength(1);
    expect(
      f.sql.filter((entry) => entry.text.startsWith('INSERT INTO access.statement_seek')),
    ).toHaveLength(1);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]!.deadlineMs).toBe(25_000);
  } finally {
    clock.mockRestore();
  }
});

test('retained validity lexical survives preparation, triples, export and current verification while accepted key tuples stay canonical', async () => {
  const raw = {
    ...qualification(),
    validFrom: '2026-01-01T00:00:00.1Z',
    validUntil: '2027-01-01T00:00:00Z',
  };
  const canonical = {
    ...raw,
    validFrom: '2026-01-01T00:00:00.100Z',
    validUntil: '2027-01-01T00:00:00.000Z',
  };
  const authored = prepareRetainedClaimStatementMeaning({ ...input(), qualification: raw });
  expect(authored.qualification).toEqual(raw);
  expect(statementQualificationKeyTuple(raw)).toEqual(statementQualificationKeyTuple(canonical));
  expect(statementMeaningKey(authored)).toBe(
    statementMeaningKey(
      prepareRetainedClaimStatementMeaning({ ...input(), qualification: canonical }),
    ),
  );
  const quads = new Parser()
    .parse(`@prefix rv: <${RV}> . <urn:root> ${statementQualificationTriples(raw, true)}
    rv:meaningKey <urn:meaning> .`);
  for (const [field, value] of [
    ['validFrom', raw.validFrom],
    ['validUntil', raw.validUntil],
  ]) {
    const term = quads.find((quad) => quad.predicate.value === `${RV}${field}`)!.object;
    expect(term.termType).toBe('Literal');
    if (term.termType !== 'Literal') throw new Error('Validity literal expected');
    expect(term.value).toBe(value);
    expect(term.datatype.value).toBe(`${XSD}dateTime`);
    expect(statementQualificationExport(raw)[`${RV}${field}`]).toEqual([
      { '@value': value, '@type': `${XSD}dateTime` },
    ]);
  }
  const f = retainedRootFixture();
  f.source.find((row) => row.predicate!.value === `${RV}validFrom`)!.object!.value = raw.validFrom;
  f.source.find((row) => row.predicate!.value === `${RV}validUntil`)!.object!.value =
    raw.validUntil;
  const prepared = await prepareClaimStatementFold(f.env, f.target);
  if (prepared.status !== 'eligible') throw new Error(prepared.reason);
  expect(prepared.prepared.meaning.qualification).toEqual(raw);
  expect(prepared.prepared.current).toContain(`"${raw.validFrom}"^^<${XSD}dateTime>`);
  expect(prepared.prepared.current).toContain(`"${raw.validUntil}"^^<${XSD}dateTime>`);
  const read = foldedVerificationFixture(raw);
  expect(await readClaimHead(read.env, read.claim)).toMatchObject({
    validFrom: raw.validFrom,
    validUntil: raw.validUntil,
  });
  expect((await readClaimRevisions(read.env, [read.source])).get(read.source)).toMatchObject({
    validFrom: raw.validFrom,
    validUntil: raw.validUntil,
  });
});

test('closed legacy creation seals an unknown key as cancelled and replays the original R terminal independently of current B', async () => {
  const f = foldedVerificationFixture();
  const metadata = f.env.fuseki.query.bind(f.env.fuseki);
  const oldId = '00000000-0000-4000-8000-000000000093';
  const deniedId = '00000000-0000-4000-8000-000000000094';
  const oldReceipt = receiptIri(oldId, 'claim-create');
  const deniedReceipt = receiptIri(deniedId, 'claim-create');
  const body = {
    referent: input().subject,
    interpretationContext: qualification().interpretationContext,
    propositionPredicate: DATE_PUBLISHED_PREDICATE,
    value: { kind: 'literal' as const, lexical: '0001-01-01', datatype: 'date' as const },
    valuePrecision: qualification().valuePrecision,
    valueQualifiers: qualification().valueQualifiers,
    validFrom: qualification().validFrom,
    validUntil: qualification().validUntil,
    editionScope: qualification().editionScope,
    actingSubject: f.speaker,
  };
  const oldDigest = claimDigest({ ...body, idempotencyKey: 'original-key' } as typeof body);
  const commands: CommandEnvelope[] = [];
  const outcomes: { id: string; outcome: string }[] = [];
  let deniedAdmission: RegisteredAdmission | undefined;
  let deniedSealed = false;
  const uri = (value: string) => ({ type: 'uri', value });
  const literal = (value: string) => ({ type: 'literal', value });
  f.env.fuseki.query = async (text) => {
    if (text.includes('ASK'))
      return { boolean: !text.includes('rv:rejectionKind rv:InvalidProfile') };
    if (text.includes('SELECT ?outcome ?digest ?id ?epoch ?scope')) {
      if (text.includes(`<${oldReceipt}>`))
        return {
          results: {
            bindings: [
              ['claim', f.claim],
              ['claimRevision', f.source],
            ].map(([key, value]) => ({
              outcome: uri(`${RV}Succeeded`),
              digest: literal(oldDigest),
              id: literal(oldId),
              epoch: literal('1'),
              scope: literal(ADMISSIONS['claim-create'].scope),
              dataEpoch: literal(f.env.lineage.dataEpoch),
              sequence: literal('7'),
              key: uri(`${RV}${key}`),
              value: uri(value!),
            })),
          },
        };
      return {
        results: {
          bindings:
            deniedAdmission && commands.length
              ? [
                  {
                    outcome: uri(`${RV}Cancelled`),
                    digest: literal(deniedAdmission.requestDigest),
                    id: literal(deniedId),
                    epoch: literal('1'),
                    scope: literal(ADMISSIONS['claim-create'].scope),
                    dataEpoch: literal(f.env.lineage.dataEpoch),
                    sequence: literal('42'),
                  },
                ]
              : [],
        },
      };
    }
    return metadata(text);
  };
  f.env.fuseki.commandWithReceipt = async (command) => {
    commands.push(command);
    expect(command.receipt).toBe(deniedReceipt);
    expect(command.update).toContain('rv:outcome rv:Cancelled');
    expect(command.update).toContain('rv:ClaimCreationCancelledEvent');
    expect(command.update).not.toContain('rv:ClaimCreatedEvent');
    expect(command.update).not.toContain('a rv:Claim ;');
    return {
      status: 'committed',
      position: { datasetId: 'product', dataEpoch: f.env.lineage.dataEpoch, sequence: '42' },
    };
  };
  const deps: VerificationDependencies = {
    env: f.env,
    legacyClaimDispatch: 'terminal-replay-only',
    account: {
      verify: async () => ({ issuer: 'https://account.example', subject: 'original-author' }),
    },
    access: {
      activePrincipalId: async () => 'original-author',
      register: async (request) => {
        const original = request.idempotencyKey === 'original-key';
        const registered: RegisteredAdmission = {
          id: original ? oldId : deniedId,
          principalId: 'original-author',
          actingSubject: request.actingSubject,
          scope: request.scope,
          action: request.action,
          requestDigest: request.requestDigest,
          idempotencyKey: request.idempotencyKey,
          authorityEpoch: '1',
          expiresAt: '2099-01-01T00:00:00.000Z',
          state: original || deniedSealed ? 'sealed' : 'registered',
          dispatchEligible: true,
          replayed: original || deniedSealed,
        };
        if (!original) deniedAdmission = registered;
        return registered;
      },
      claim: async () => {
        throw new Error('Closed legacy key reached dispatch claim');
      },
      recordGraphOutcome: async (id, receipt) => {
        outcomes.push({ id, outcome: receipt.outcome });
        if (id === deniedId) deniedSealed = true;
      },
    },
    store: {} as VerificationStore,
  };
  const request = new Request('https://main.example/v1/claims');
  await expect(
    createAdmittedClaim(deps, request, { ...body, idempotencyKey: 'unknown-key' }),
  ).rejects.toBeInstanceOf(CancelledActivation);
  expect(deniedSealed).toBe(true);
  expect(outcomes).toEqual([{ id: deniedId, outcome: 'cancelled' }]);
  await expect(
    createAdmittedClaim(deps, request, { ...body, idempotencyKey: 'unknown-key' }),
  ).rejects.toBeInstanceOf(CancelledActivation);
  const original = await createAdmittedClaim(deps, request, {
    ...body,
    idempotencyKey: 'original-key',
  });
  expect(original).toMatchObject({
    replayed: true,
    receipt: oldReceipt,
    claim: { claim: f.claim, revision: f.source, head: f.revision, representation: 'claim' },
  });
  expect(commands).toHaveLength(1);
  expect(outcomes.at(-1)).toEqual({ id: oldId, outcome: 'succeeded' });
});
