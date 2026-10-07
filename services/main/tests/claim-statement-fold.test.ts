import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import type { Pool, PoolClient } from 'pg';
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
  readReceipt,
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
  assessmentDigest,
  createAdmittedClaim,
  PendingVerification,
  reconcileAssessmentProducerEffects,
  readClaimQuality,
  type AssessClaimInput,
  type VerificationDependencies,
} from '../src/modules/verification/operations.ts';
import {
  VerificationInvalid,
  VerificationMissing,
  VerificationStale,
  VerificationStore,
  type AnalysisSnapshot,
  type ActivationInput,
  type AssessmentProducerAuditFrontier,
  type AssessmentProducerPermit,
  type AssessmentProducerRecord,
  type AssessmentProducerStage,
  type AssessmentProducerTerminal,
  type SummaryState,
} from '../src/modules/verification/store.ts';
import {
  GRAPHS,
  CancelledActivation,
  IdempotencyConflict,
  hash,
  prepareComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { SUPPORT_METHOD, SUMMARY_POLICY } from '../src/modules/verification/analysis.ts';

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

function definitionBytes(
  f: ReturnType<typeof definitionFixture>,
  revision: string,
  payload?: string,
) {
  const definition = f.definitions.get(revision)!;
  const descriptor = JSON.parse(
    readFileSync(join(f.env.objectDirectory, definition.manifest.slice(-64)), 'utf8'),
  );
  const original = readFileSync(join(f.env.objectDirectory, descriptor.payload.slice(-64)), 'utf8');
  const payloadBytes = payload ?? `\n${JSON.stringify(JSON.parse(original), null, 2)}\n`;
  const payloadDigest = hash(payloadBytes);
  descriptor.payload = `sha256:${payloadDigest}`;
  descriptor.payloadBytes = Buffer.byteLength(payloadBytes);
  const manifestBytes = `\n${JSON.stringify(descriptor, null, 2)}\n`;
  const manifestDigest = hash(manifestBytes);
  const manifestPath = join(f.env.objectDirectory, manifestDigest);
  const payloadPath = join(f.env.objectDirectory, payloadDigest);
  writeFileSync(payloadPath, payloadBytes);
  writeFileSync(manifestPath, manifestBytes);
  definition.manifest = `urn:rezics:sha256:${manifestDigest}`;
  return { manifestBytes, payloadBytes, manifestPath, payloadPath };
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
  let producer: AssessmentProducerRecord | undefined;
  const producerPermit = { mode: 'ordinary' as const, job: null, generation: '0', restoreEpoch: '1' };
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
    expect(producer?.intent.claimRevision).toBe(f.revision);
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
    store: {
      analysisSnapshot: async () => snapshot,
      stageAssessmentProducer: async (input: AssessmentProducerStage) => {
        expect(commands).toHaveLength(0);
        producer = { ...input, stageGeneration: '0', restoreEpoch: '1', terminal: null };
        return { row: producer, permit: producerPermit };
      },
      readAssessmentProducer: async () => producer ?? null,
      withAssessmentProducerEffects: async (_admission: string, _digest: string,
        _permit: unknown, work: Parameters<VerificationStore['withAssessmentProducerEffects']>[3]) => {
        if (!producer) throw new Error('Missing original producer intent');
        producer = { ...producer, terminal: await work({} as PoolClient, producer) };
        return producer;
      },
    } as unknown as VerificationStore,
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
  expect(producer?.terminal?.status).toBe('cancelled');
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
    pendingAfterClose?: boolean;
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
    if (text.includes('FROM access.admission'))
      return {
        rows: state.pendingAfterClose && !state.accessOpen ? [{ pending: 1 }] : [],
        rowCount: state.pendingAfterClose && !state.accessOpen ? 1 : 0,
      };
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

test('the native fold wire carries the job and six original custody byte strings without reserialization', async () => {
  const f = retainedRootFixture();
  const relation = definitionBytes(f, f.target.relationDefinition);
  const qualification = definitionBytes(f, f.target.qualificationDefinition);
  const before = structuredClone({
    source: f.source,
    current: f.current,
    receipt: f.originalReceipt,
  });
  const prepared = await prepareClaimStatementFold(f.env, f.target);
  if (prepared.status !== 'eligible') throw new Error(prepared.reason);
  const bytes = prepared.prepared.sealedBytes;
  expect(bytes).toMatchObject({
    relationManifest: relation.manifestBytes,
    relationPayload: relation.payloadBytes,
    qualificationManifest: qualification.manifestBytes,
    qualificationPayload: qualification.payloadBytes,
  });
  expect(bytes.relationPayload).not.toBe(JSON.stringify(JSON.parse(bytes.relationPayload)));
  const manifest = prepared.prepared.revisions.match(
    /rv:manifest <urn:rezics:sha256:([0-9a-f]{64})>/,
  )![1]!;
  expect(bytes.statementManifest).toBe(readFileSync(join(f.env.objectDirectory, manifest), 'utf8'));
  const statement = JSON.parse(bytes.statementManifest);
  expect(bytes.statementPayload).toBe(
    readFileSync(join(f.env.objectDirectory, statement.payload.slice(-64)), 'utf8'),
  );
  expect(statement.payload).toBe(`sha256:${hash(bytes.statementPayload)}`);
  expect(statement.payloadBytes).toBe(Buffer.byteLength(bytes.statementPayload));
  await executeClaimStatementFold(f.env, prepared.prepared, f.fence, f.pool);
  const insert = f.commands[0]!.update.match(/INSERT\s*\{([\s\S]*?)\}\s*WHERE\s*\{/)![1]!;
  const quads = new Parser({ format: 'TriG' }).parse(`@prefix rv: <${RV}> .
    ${insert.replaceAll('?sequence', '41')}`);
  const receipt = f.commands[0]!.receipt;
  expect(
    quads
      .filter(
        (quad) => quad.subject.value === receipt && quad.predicate.value === `${RV}claimFoldJob`,
      )
      .map((quad) => quad.object.value),
  ).toEqual([f.fence.job]);
  for (const [name, value] of Object.entries(bytes)) {
    const field = `claimFold${name[0]!.toUpperCase()}${name.slice(1)}`;
    const found = quads.filter(
      (quad) => quad.subject.value === receipt && quad.predicate.value === `${RV}${field}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.graph.value).toBe(GRAPHS.receipts);
    expect(found[0]!.object.value).toBe(value);
    expect(found[0]!.object.termType).toBe('Literal');
  }
  expect({ source: f.source, current: f.current, receipt: f.originalReceipt }).toEqual(before);
});

test('missing, mutated, oversized and over-deep pinned definition bytes refuse before Claim dispatch', async () => {
  for (const defect of [
    'missing-manifest',
    'missing-payload',
    'mutated-payload',
    'oversized-payload',
    'deep-payload',
    'duplicate-key',
  ]) {
    const f = retainedRootFixture();
    let bytes = definitionBytes(f, f.target.relationDefinition);
    if (defect === 'missing-manifest') rmSync(bytes.manifestPath);
    if (defect === 'missing-payload') rmSync(bytes.payloadPath);
    if (defect === 'mutated-payload') writeFileSync(bytes.payloadPath, `${bytes.payloadBytes} `);
    if (defect === 'oversized-payload')
      bytes = definitionBytes(
        f,
        f.target.relationDefinition,
        `${bytes.payloadBytes}${' '.repeat(16_385)}`,
      );
    if (defect === 'deep-payload') {
      const payload = JSON.parse(bytes.payloadBytes);
      payload.state.roles = Array.from({ length: 17 }).reduce<object>((value) => [value], {});
      bytes = definitionBytes(f, f.target.relationDefinition, JSON.stringify(payload));
    }
    if (defect === 'duplicate-key')
      bytes = definitionBytes(
        f,
        f.target.relationDefinition,
        bytes.payloadBytes.replace('"format":', '"\\u0066ormat":"unreviewed","format":'),
      );
    const before = structuredClone({ current: f.current, source: f.source });
    const prepared = await prepareClaimStatementFold(f.env, f.target);
    expect(prepared.status).toBe('retained');
    expect(f.commands).toHaveLength(0);
    expect({ current: f.current, source: f.source }).toEqual(before);
  }
});

test('an admission registered between the initial check and Access closure stops preparation and conversion', async () => {
  const f = retainedRootFixture();
  f.state.held = false;
  f.state.owned = false;
  f.state.accessOpen = true;
  f.state.pendingAfterClose = true;
  const files = readdirSync(f.env.objectDirectory).sort();
  await expect(
    convertEligibleClaimsTurn(f.env, f.pool, {
      ...f.target,
      job: f.fence.job,
      claims: [{ claim: f.claim, claimRevision: f.revision }],
    }),
  ).rejects.toThrow(/admissions|effects/iu);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]!.receipt).toContain(':acquire:');
  expect(f.state).toMatchObject({ held: true, owned: true, accessOpen: false });
  expect(readdirSync(f.env.objectDirectory).sort()).toEqual(files);
  const checks = f.sql
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.text.includes('FROM access.admission'));
  expect(checks).toHaveLength(2);
  const close = f.sql.findIndex((entry) => entry.text.startsWith('UPDATE access.recovery_fence'));
  expect(checks[0]!.index).toBeLessThan(close);
  expect(checks[1]!.index).toBeGreaterThan(close);
  expect(f.sql.some((entry) => entry.text.startsWith('INSERT INTO access.statement_seek'))).toBe(
    false,
  );
});

/** Exercises the actual admitted control flow; PostgreSQL transaction behavior has separate owner tests. */
function assessmentProducerOperationsFixture() {
  const f = foldedVerificationFixture();
  const metadata = f.env.fuseki.query.bind(f.env.fuseki);
  const admissionId = '00000000-0000-4000-8000-000000000207';
  const principal = '00000000-0000-4000-8000-000000000205';
  const permit: AssessmentProducerPermit = { mode: 'ordinary', job: null, generation: '0', restoreEpoch: '1' };
  const events: string[] = [];
  const commands: CommandEnvelope[] = [];
  const resolutions: string[][] = [];
  const activations: ActivationInput[] = [];
  const state: { registered?: RegisteredAdmission; producer?: AssessmentProducerRecord; assessment?: string;
    failStage: boolean; failEffects: boolean; analysisUnavailable: boolean; effectCallbacks: number; position: string;
    representation: 'statement' | 'claim' } = {
      failStage: false, failEffects: true, analysisUnavailable: false, effectCallbacks: 0, position: '42', representation: 'statement',
    };
  const intent: AssessClaimInput & { idempotencyKey: string } = {
    claimRevision: f.revision, evidenceSetRevision: id(210), sourceAssessments: [], method: 'automated',
    judgment: null, evaluationContext: qualification().interpretationContext, adoptedRevision: null,
    scorePerMillion: null, calibration: null, limitations: 'Original exact assessment producer intent.',
    expectedSummary: id(211), resolvesChallenges: [
      '00000000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-000000000209',
    ], actingSubject: f.speaker, idempotencyKey: 'assessment-producer-operations',
  };
  const snapshot: AnalysisSnapshot = {
    revision: { revision: id(210), claim: f.claim, claimRevision: f.revision, purpose: 'claim-head',
      predecessor: null, itemCount: 0, manifestDigest: 'a'.repeat(64), createdAt: '2026-10-01T00:00:00.000Z', items: [] },
    evidenceHead: id(210), links: [], truncated: false, visited: [], lineageHeads: new Map(),
    dispositionHeads: new Map(), recordOf: new Map(), observedAt: new Map(),
    challenge: { revision: null, open: 2, resolved: 0 }, walk: id(212), complete: true, lineageNodes: 0,
    continuation: null, stepReplayed: false, work: { expansions: 0, links: 0 }, totalWork: { expansions: 0, links: 0 },
    lineageProof: { dependence: 'unknown', independentOrigins: null, origins: [] },
  };
  const uri = (value: string) => ({ type: 'uri', value });
  const literal = (value: string) => ({ type: 'literal', value });
  f.env.fuseki.commandHealth = async () => ({
    moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256])),
  });
  f.env.fuseki.query = async text => {
    if (text.includes('ASK')) return { boolean: !text.includes('rv:rejectionKind rv:InvalidProfile') };
    if (text.includes('SELECT ?outcome ?digest ?id ?epoch ?scope')) {
      const admission = state.registered;
      return { results: { bindings: state.assessment && admission ? [{ outcome: uri(`${RV}Succeeded`),
        digest: literal(admission.requestDigest), id: literal(admission.id), epoch: literal(admission.authorityEpoch),
        scope: literal(admission.scope), dataEpoch: literal(f.env.lineage.dataEpoch), sequence: literal('42'),
        key: uri(`${RV}assessment`), value: uri(state.assessment) }] : [] } };
    }
    if (text.includes('SELECT ?claim ?claimRevision ?statementRevision ?evidence')) {
      return { results: { bindings: state.assessment ? [{ claim: uri(f.claim),
        [state.representation === 'statement' ? 'statementRevision' : 'claimRevision']: uri(f.revision),
        evidence: uri(intent.evidenceSetRevision), method: uri(SUPPORT_METHOD), methodRevision: uri(SUPPORT_METHOD),
        policy: uri(SUMMARY_POLICY), context: uri(intent.evaluationContext), coverage: uri(`${RV}CompleteCoverage`),
        support: uri(`${RV}InsufficientSupport`), dependence: uri(`${RV}DependenceUnknown`),
        limitations: literal(intent.limitations), assessor: uri(f.speaker), kind: uri(`${RV}AutomatedAssessor`),
        assessedAt: literal('2026-10-01T00:00:00.000Z'), epoch: literal(f.env.lineage.dataEpoch), sequence: literal(state.position) }] : [] } };
    }
    return metadata(text);
  };
  f.env.fuseki.commandWithReceipt = async envelope => {
    expect(state.producer?.intent.claimRevision).toBe(f.revision);
    expect(state.producer?.intent.resolvesChallenges).toEqual(intent.resolvesChallenges);
    expect(envelope.update).toContain(`rv:statementRevision <${f.revision}>`);
    state.assessment = envelope.update.match(/<([^>]+)> a rv:ClaimAssessment, rv:RevisionAnchor/u)?.[1];
    if (!state.assessment) throw new Error('Assessment command did not identify its result');
    events.push('graph-dispatch');
    commands.push(envelope);
    return { status: 'committed', position: { datasetId: 'product', dataEpoch: f.env.lineage.dataEpoch, sequence: '42' } };
  };
  const store = {
    challengeSubmitter: async () => '00000000-0000-4000-8000-000000000206',
    stageAssessmentProducer: async (input: AssessmentProducerStage) => {
      events.push('stage');
      if (!state.registered) throw new Error('Producer stage has no registered admission');
      expect(input.admission).toBe(state.registered.id);
      if (state.failStage) throw new Error('Producer stage unavailable');
      if (state.producer) {
        expect(state.producer.requestDigest).toBe(input.requestDigest);
        expect(state.producer.intent).toEqual(input.intent);
        return { row: state.producer, permit };
      }
      state.producer = { ...structuredClone(input), stageGeneration: '0', restoreEpoch: '1', terminal: null };
      return { row: state.producer, permit };
    },
    readAssessmentProducer: async () => state.producer ?? null,
    analysisSnapshot: async () => {
      events.push('basis');
      if (state.analysisUnavailable) throw new VerificationMissing('Historical analysis is unavailable');
      return snapshot;
    },
    reassessmentDemand: async () => null,
    withAssessmentProducerEffects: async (admission: string, digest: string, supplied: AssessmentProducerPermit,
      work: (client: PoolClient, row: AssessmentProducerRecord) => Promise<AssessmentProducerTerminal>) => {
      expect(admission).toBe(admissionId);
      if (!state.producer) throw new Error('No original intent');
      expect(digest).toBe(state.producer.requestDigest);
      expect(supplied).toEqual(permit);
      if (state.producer.terminal) return state.producer;
      if (state.failEffects) { events.push('effect-interruption'); throw new Error('Interrupted after Access acknowledgement'); }
      state.effectCallbacks++;
      const client = { query: async (sql: string) => { events.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as PoolClient;
      const terminal = await work(client, state.producer);
      state.producer = { ...state.producer, terminal };
      events.push('terminal');
      return state.producer;
    },
    resolveChallenges: async (_principal: string, _admission: string, _claim: string, assessment: string, requested: readonly string[]) => {
      if (!state.assessment) throw new Error('Challenge resolution has no exact recorded assessment');
      expect(assessment).toBe(state.assessment);
      resolutions.push([...requested]); events.push('resolve-requested');
    },
    challengeState: async () => ({ revision: '00000000-0000-4000-8000-000000000213', open: 0, resolved: 2 }),
    activateSummary: async (input: ActivationInput) => {
      activations.push(input); events.push('activate');
      return { status: 'activated' as const, generation: id(214), number: '1', dispute: 'resolved' };
    },
  } as unknown as VerificationStore;
  const deps: VerificationDependencies = {
    env: f.env, store,
    account: { verify: async () => { events.push('account'); return { issuer: 'https://account.example', subject: 'reviewer' }; } },
    access: {
      activePrincipalId: async () => principal,
      register: async request => {
        events.push('register');
        if (state.registered) {
          expect(request.requestDigest).toBe(state.registered.requestDigest);
          expect(request.idempotencyKey).toBe(state.registered.idempotencyKey);
          return { ...state.registered, replayed: true };
        }
        state.registered = { id: admissionId, principalId: principal, actingSubject: request.actingSubject,
          scope: request.scope, action: request.action, requestDigest: request.requestDigest,
          idempotencyKey: request.idempotencyKey, authorityEpoch: '1', expiresAt: '2099-01-01T00:00:00.000Z',
          state: 'registered', dispatchEligible: true, replayed: false };
        return state.registered;
      },
      claim: async () => {
        events.push('access-claim');
        expect(state.producer).toBeDefined();
        if (!state.registered) throw new Error('No registered admission');
        return { ...state.registered, state: 'claimed' as const, claimedAt: '2026-10-01T00:00:00.000Z' };
      },
      recordGraphOutcome: async (_admission, receipt) => {
        if (!state.producer || !state.registered) throw new Error('Acknowledgement has no staged original admission');
        expect(state.assessment).toBeDefined();
        expect(receipt).toMatchObject({ admissionId, outcome: 'succeeded',
          receipt: receiptIri(admissionId, 'claim-assess'), requestDigest: state.producer.requestDigest });
        state.registered = { ...state.registered, state: 'sealed' };
        events.push('access-ack');
      },
    },
  };
  return { ...f, deps, permit, state, intent, admissionId, events, commands, resolutions, activations };
}

test('original intent stages before actual dispatch and Access acknowledgement; interrupted effects resume without readmission', async () => {
  const f = assessmentProducerOperationsFixture();
  await expect(assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent))
    .rejects.toThrow('Interrupted after Access acknowledgement');
  const ordered = ['register', 'stage', 'access-claim', 'graph-dispatch', 'access-ack', 'effect-interruption'];
  for (let index = 1; index < ordered.length; index++) {
    expect(f.events.indexOf(ordered[index - 1]!)).toBeLessThan(f.events.indexOf(ordered[index]!));
  }
  const { idempotencyKey: _key, ...intent } = f.intent;
  expect(f.state.producer?.intent).toEqual(intent);
  expect(f.state.producer?.requestDigest).toBe(assessmentDigest(f.claim, intent));
  expect(f.state.producer?.terminal).toBeNull();
  expect(f.resolutions).toEqual([]);
  const before = [...f.events];
  f.state.failEffects = false;
  const forbidden = async () => { throw new Error('Effect recovery attempted Account/Access or graph redispatch'); };
  f.deps.account.verify = forbidden;
  f.deps.access.register = forbidden;
  f.deps.access.claim = forbidden;
  f.deps.access.recordGraphOutcome = forbidden;
  f.env.fuseki.commandWithReceipt = forbidden;
  const recovered = await reconcileAssessmentProducerEffects({ env: f.env, store: f.deps.store }, f.admissionId, f.permit);
  expect(recovered.terminal).toMatchObject({ status: 'activated', assessment: f.state.assessment,
    receipt: receiptIri(f.admissionId, 'claim-assess') });
  expect(f.resolutions).toEqual([[...f.intent.resolvesChallenges]]);
  expect(f.activations).toHaveLength(1);
  expect(f.activations[0]).toMatchObject({ claim: f.claim, claimRevision: f.revision,
    assessment: f.state.assessment, operationKey: `assessment:${f.admissionId}`, expectedActive: f.intent.expectedSummary });
  expect(f.events.slice(before.length)).not.toContain('register');
  expect(f.commands).toHaveLength(1);
  const callbacks = f.state.effectCallbacks;
  expect(await reconcileAssessmentProducerEffects({ env: f.env, store: f.deps.store }, f.admissionId, f.permit)).toEqual(recovered);
  expect(f.state.effectCallbacks).toBe(callbacks);
  expect(f.resolutions).toHaveLength(1);
  expect(f.activations).toHaveLength(1);
});

test('a failed original intent stage cannot claim, dispatch, cancel or acknowledge the registered assessment', async () => {
  const f = assessmentProducerOperationsFixture();
  f.state.failStage = true;
  await expect(assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent))
    .rejects.toBeInstanceOf(PendingVerification);
  expect(f.events).toContain('register');
  expect(f.events).toContain('stage');
  expect(f.events).not.toContain('access-claim');
  expect(f.events).not.toContain('graph-dispatch');
  expect(f.events).not.toContain('access-ack');
  expect(f.commands).toEqual([]);
  expect(f.state.producer).toBeUndefined();
  const beforeRetry = [...f.events];
  f.state.failStage = false;
  f.state.failEffects = false;
  const recovered = await assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent);
  expect(recovered.activation.status).toBe('activated');
  expect(recovered.replayed).toBe(true);
  expect(f.state.producer?.admission).toBe(f.admissionId);
  expect(f.events.slice(beforeRetry.length)).toContain('stage');
  expect(f.events.slice(beforeRetry.length)).toContain('graph-dispatch');
  expect(f.events.slice(beforeRetry.length)).toContain('access-ack');
  expect(f.commands).toHaveLength(1);
});

test('effect reconciliation refuses mismatched native assessment position, representation and stored terminal result', async () => {
  const f = assessmentProducerOperationsFixture();
  await expect(assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent))
    .rejects.toThrow('Interrupted after Access acknowledgement');
  f.state.failEffects = false;
  f.state.position = '43';
  await expect(reconcileAssessmentProducerEffects({ env: f.env, store: f.deps.store }, f.admissionId, f.permit))
    .rejects.toBeInstanceOf(IdempotencyConflict);
  f.state.position = '42';
  f.state.representation = 'claim';
  await expect(reconcileAssessmentProducerEffects({ env: f.env, store: f.deps.store }, f.admissionId, f.permit))
    .rejects.toBeInstanceOf(IdempotencyConflict);
  f.state.representation = 'statement';
  if (!f.state.producer) throw new Error('Original intent was not staged');
  f.state.producer.terminal = { status: 'activated', receipt: receiptIri(f.admissionId, 'claim-assess'),
    assessment: id(999), activation: { status: 'activated', generation: id(214), number: '1', dispute: 'resolved' } };
  await expect(reconcileAssessmentProducerEffects({ env: f.env, store: f.deps.store }, f.admissionId, f.permit))
    .rejects.toBeInstanceOf(IdempotencyConflict);
  expect(f.state.effectCallbacks).toBe(0);
  expect(f.resolutions).toEqual([]);
  expect(f.activations).toEqual([]);
  expect(f.commands).toHaveLength(1);
});

test('a sealed public assessment replay preserves its terminal when historical analysis is unavailable', async () => {
  const f = assessmentProducerOperationsFixture();
  f.state.failEffects = false;
  const request = new Request('https://main.example/assessments');
  const first = await assessAdmittedClaim(f.deps, request, f.claim, f.intent);
  expect(first.analysis).not.toBeNull();
  expect(f.state.registered?.state).toBe('sealed');
  expect(f.state.producer?.terminal?.status).toBe('activated');
  const terminal = structuredClone(f.state.producer?.terminal);
  const callbacks = f.state.effectCallbacks;
  const before = [...f.events];
  f.state.analysisUnavailable = true;
  f.env.fuseki.commandWithReceipt = async () => { throw new Error('Sealed replay attempted graph redispatch'); };
  const replayed = await assessAdmittedClaim(f.deps, request, f.claim, f.intent);
  if (!first.assessment || !replayed.assessment) throw new Error('Expected exact recorded assessments');
  expect(replayed.analysis).toBeNull();
  expect(replayed.replayed).toBe(true);
  expect(replayed.assessment.assessment).toBe(first.assessment.assessment);
  expect(replayed.activation).toEqual(first.activation);
  expect(replayed.receipt).toBe(first.receipt);
  expect(f.state.producer?.terminal).toEqual(terminal);
  expect(f.state.effectCallbacks).toBe(callbacks);
  expect(f.events.slice(before.length)).not.toContain('basis');
  expect(f.events.slice(before.length)).not.toContain('access-claim');
  expect(f.resolutions).toHaveLength(1);
  expect(f.activations).toHaveLength(1);
  expect(f.commands).toHaveLength(1);
});

test('a sealed historical assessment cannot backfill missing original producer intent from its terminal', async () => {
  const f = assessmentProducerOperationsFixture();
  f.state.failEffects = false;
  await assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent);
  // Model the older custody boundary: graph terminal retained, original producer absent.
  f.state.producer = undefined;
  const before = [...f.events];
  const callbacks = f.state.effectCallbacks;
  await expect(assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent))
    .rejects.toBeInstanceOf(VerificationMissing);
  expect(f.state.producer).toBeUndefined();
  expect(f.events.slice(before.length)).toContain('register');
  expect(f.events.slice(before.length)).not.toContain('stage');
  expect(f.events.slice(before.length)).not.toContain('access-ack');
  expect(f.events.slice(before.length)).not.toContain('graph-dispatch');
  expect(f.state.effectCallbacks).toBe(callbacks);
  expect(f.commands).toHaveLength(1);
  expect(f.resolutions).toHaveLength(1);
  expect(f.activations).toHaveLength(1);
});

test('a claimed historical admission with a committed graph assessment cannot recreate missing original custody', async () => {
  const f = assessmentProducerOperationsFixture();
  const { idempotencyKey, ...intent } = f.intent;
  const retained: RegisteredAdmission = {
    id: f.admissionId, principalId: '00000000-0000-4000-8000-000000000205',
    actingSubject: intent.actingSubject, scope: ADMISSIONS['claim-assess'].scope,
    action: ADMISSIONS['claim-assess'].action, requestDigest: assessmentDigest(f.claim, intent),
    idempotencyKey, authorityEpoch: '1', expiresAt: '2099-01-01T00:00:00.000Z',
    state: 'claimed', dispatchEligible: true, replayed: true,
  };
  // Pre-producer custody: the graph committed, but Access never received its acknowledgement.
  f.state.registered = retained;
  f.state.assessment = id(216);
  const graphTerminal = await readReceipt(f.env, f.admissionId, 'claim-assess', ['assessment']);
  expect(graphTerminal).toMatchObject({ outcome: 'succeeded', admissionId: f.admissionId,
    requestDigest: retained.requestDigest, result: { assessment: id(216) } });
  expect(f.state.producer).toBeUndefined();
  const forbidden = (event: string) => async (): Promise<never> => {
    f.events.push(event);
    throw new Error(`Missing original custody reached ${event}`);
  };
  f.deps.access.register = async request => {
    expect(request.requestDigest).toBe(retained.requestDigest);
    expect(request.idempotencyKey).toBe(retained.idempotencyKey);
    f.events.push('register');
    return retained;
  };
  f.deps.access.claim = forbidden('access-claim');
  f.deps.access.recordGraphOutcome = forbidden('access-ack');
  f.deps.store.stageAssessmentProducer = forbidden('stage');
  f.deps.store.withAssessmentProducerEffects = forbidden('effects');
  f.deps.store.analysisSnapshot = forbidden('basis');
  f.env.fuseki.commandWithReceipt = forbidden('graph-dispatch');
  await expect(assessAdmittedClaim(f.deps, new Request('https://main.example/assessments'), f.claim, f.intent))
    .rejects.toBeInstanceOf(VerificationMissing);
  expect(f.events).toContain('register');
  for (const event of ['stage', 'access-claim', 'access-ack', 'effects', 'basis', 'graph-dispatch']) {
    expect(f.events).not.toContain(event);
  }
  expect(f.state.producer).toBeUndefined();
  expect(f.state.registered).toEqual(retained);
  expect(f.commands).toEqual([]);
  expect(f.resolutions).toEqual([]);
  expect(f.activations).toEqual([]);
  expect(await readReceipt(f.env, f.admissionId, 'claim-assess', ['assessment'])).toEqual(graphTerminal);
});

const auditAdmission = (ordinal: number) => id(3000 + ordinal).slice('https://rezics.com/id/'.length);
const auditPermit = (): AssessmentProducerPermit => ({
  mode: 'maintenance', job: 'assessment-producer-audit', generation: '8', restoreEpoch: '3',
});

function assessmentAuditRow(ordinal: number, status: AssessmentProducerTerminal['status'] | null) {
  const admission = auditAdmission(ordinal);
  const intent: AssessClaimInput = {
    limitations: 'Preserve the original source pins and order during a bounded audit.',
    claimRevision: id(540), evidenceSetRevision: id(541), sourceAssessments: [id(543), id(542)],
    method: 'human-review', judgment: 'supported', evaluationContext: 'urn:assessment:audit:context',
    adoptedRevision: null, scorePerMillion: null, calibration: null, evaluationReference: null,
    expectedSummary: null, resolvesChallenges: [auditAdmission(543), auditAdmission(542)],
    actingSubject: id(544),
  };
  const terminal: AssessmentProducerTerminal | null = status === null ? null : {
    status, receipt: receiptIri(admission, 'claim-assess'), assessment: status === 'cancelled' ? null : id(545),
    activation: status === 'activated'
      ? { status: 'activated', generation: id(546), number: '2', dispute: 'resolved' }
      : status === 'refused' ? { status: 'stale-summary', active: null }
        : status === 'no-activation' ? { status: 'not-reproduced' } : { status: 'cancelled' },
  };
  const producer: AssessmentProducerRecord = {
    admission, requestDigest: assessmentDigest(id(539), intent), principal: auditAdmission(544),
    actingSubject: intent.actingSubject, scope: ADMISSIONS['claim-assess'].scope, authorityEpoch: '1',
    idempotencyKey: `audit:${ordinal}`, claim: id(539), claimRevision: intent.claimRevision, intent,
    stageGeneration: '7', restoreEpoch: '3', terminal,
  };
  return { producer, row: {
    admission_id: producer.admission, request_digest: producer.requestDigest, principal_id: producer.principal,
    acting_subject: producer.actingSubject, scope: producer.scope, authority_epoch: producer.authorityEpoch,
    idempotency_key: producer.idempotencyKey, claim: producer.claim, claim_revision: producer.claimRevision,
    intent_json: JSON.stringify(intent), stage_generation: producer.stageGeneration,
    restore_epoch: producer.restoreEpoch, terminal,
  } };
}

/** A fixed SQL owner seam: it supplies a raw window and known control reads.
 * It does not evaluate WHERE/ORDER BY/LIMIT, joins, locks, or any SQL mutation. */
function assessmentAuditSqlWindow(rows: Record<string, unknown>[]) {
  const permit = auditPermit();
  const queries: { sql: string; values: unknown[] }[] = [];
  const state = { connections: 0, gateReads: 0, driftAfterWindow: false };
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (/\bFROM reading_position\.generation\b/.test(sql)) return { rows: [{ epoch: permit.restoreEpoch }], rowCount: 1 };
    if (/\bFROM verification\.assessment_producer_gate\b/.test(sql)) {
      state.gateReads++;
      return { rows: [{ mode: permit.mode, job: permit.job,
        generation: state.driftAfterWindow && state.gateReads > 1 ? '9' : permit.generation,
        restore_epoch: permit.restoreEpoch }], rowCount: 1 };
    }
    if (/\bFROM verification\.assessment_producer\b/.test(sql)) return { rows, rowCount: rows.length };
    if (/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)\b/.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error(`Audit attempted unexpected SQL: ${sql}`);
  };
  const pool = { query, connect: async () => {
    state.connections++;
    return { query, release: () => {} };
  } } as unknown as Pool;
  return { store: new VerificationStore(pool), permit, queries, state };
}

test('assessment audit refuses malformed or mismatched cursors and permits before contacting Content', async () => {
  const f = assessmentAuditSqlWindow([]);
  const frontier: AssessmentProducerAuditFrontier = {
    after: auditAdmission(1), job: f.permit.job!, generation: f.permit.generation, restoreEpoch: f.permit.restoreEpoch,
  };
  const cases: { permit?: AssessmentProducerPermit; frontier?: AssessmentProducerAuditFrontier; limit?: number }[] = [
    { permit: { ...f.permit, mode: 'ordinary', job: null } },
    { permit: { ...f.permit, job: null } },
    { permit: { ...f.permit, job: 'invalid audit job' } },
    { permit: { ...f.permit, generation: '-1' } },
    { permit: { ...f.permit, generation: '08' } },
    { permit: { ...f.permit, generation: 8 as unknown as string } },
    { permit: { ...f.permit, restoreEpoch: 'not-an-epoch' } },
    { permit: { ...f.permit, restoreEpoch: 3 as unknown as string } },
    { frontier: { ...frontier, after: id(1) } },
    { frontier: { ...frontier, job: 'another-maintenance-job' } },
    { frontier: { ...frontier, generation: '7' } },
    { frontier: { ...frontier, restoreEpoch: '2' } },
    { limit: 0 }, { limit: 33 }, { limit: 1.5 },
  ];
  for (const invalid of cases) {
    await expect(f.store.auditAssessmentProducers(invalid.permit ?? f.permit,
      invalid.frontier ?? null, invalid.limit ?? 32)).rejects.toBeInstanceOf(VerificationInvalid);
    expect(f.state.connections).toBe(0);
    expect(f.queries).toEqual([]);
  }
});

test('assessment audit consumes malformed originals within the raw 32-row window and preserves every terminal and source order', async () => {
  const statuses = ['activated', 'refused', 'no-activation', 'cancelled'] as const;
  const original = Array.from({ length: 33 }, (_, index) => assessmentAuditRow(index + 1,
    index >= 1 && index <= statuses.length ? statuses[index - 1]! : null));
  const rows: Record<string, unknown>[] = original.map(item => ({ ...item.row }));
  // This is valid JSON with bounded fixed keys, but its original native source
  // pin is invalid. The real Store parser must report it rather than skip it.
  rows[0]!.intent_json = JSON.stringify({ ...original[0]!.producer.intent,
    sourceAssessments: ['urn:not-an-exact-native-assessment'] });
  const before = structuredClone(rows);
  const f = assessmentAuditSqlWindow(rows);
  const page = await f.store.auditAssessmentProducers(f.permit);
  expect(page.scope).toBe('content-assessment-producer');
  expect(page.entries).toHaveLength(32);
  expect(page.entries[0]).toEqual({ status: 'unresolved', reason: 'invalid-original', admission: auditAdmission(1) });
  for (let index = 1; index <= statuses.length; index++) {
    const producer = original[index]!.producer;
    if (producer.terminal === null) throw new Error('Expected an original typed terminal');
    expect(page.entries[index]).toEqual({ status: 'terminal', producer: { ...producer, terminal: producer.terminal } });
  }
  expect(page.entries[5]).toEqual({ status: 'unresolved', reason: 'pending', producer: original[5]!.producer });
  for (const entry of page.entries) {
    if (!('producer' in entry)) continue;
    expect(entry.producer.intent.sourceAssessments).toEqual([id(543), id(542)]);
    expect(entry.producer.intent.resolvesChallenges).toEqual([auditAdmission(543), auditAdmission(542)]);
    expect(JSON.stringify(entry.producer.intent)).toBe(original.find(item =>
      item.producer.admission === entry.producer.admission)!.row.intent_json);
  }
  expect(page.eof).toBe(false);
  expect(page.frontier).toEqual({ after: auditAdmission(32), job: f.permit.job!,
    generation: f.permit.generation, restoreEpoch: f.permit.restoreEpoch });
  expect(page.entries.some(entry => ('producer' in entry ? entry.producer.admission : entry.admission) === auditAdmission(33))).toBe(false);
  const windows = f.queries.filter(query => /\bFROM verification\.assessment_producer\b/.test(query.sql));
  expect(windows).toHaveLength(1);
  expect(windows[0]!.values).toEqual(['00000000-0000-0000-0000-000000000000', 33]);
  expect(windows[0]!.sql).toMatch(/ORDER BY admission_id LIMIT \$2/);
  expect(windows[0]!.sql).not.toMatch(/terminal IS NULL|SKIP LOCKED|COUNT\s*\(/i);
  expect(rows).toEqual(before);
});

test('assessment audit EOF retains unknown entries and resumes strictly after the consumed frontier', async () => {
  const pending = assessmentAuditRow(33, null);
  const malformed = assessmentAuditRow(34, 'cancelled');
  const falseTerminal = assessmentAuditRow(35, null);
  const rows: Record<string, unknown>[] = [{ ...pending.row }, { ...malformed.row,
    terminal: { ...malformed.row.terminal!, receipt: 'urn:forged:terminal-receipt' } },
    { ...falseTerminal.row, terminal: false }];
  const f = assessmentAuditSqlWindow(rows);
  const frontier: AssessmentProducerAuditFrontier = {
    after: auditAdmission(32), job: f.permit.job!, generation: f.permit.generation, restoreEpoch: f.permit.restoreEpoch,
  };
  const page = await f.store.auditAssessmentProducers(f.permit, frontier);
  expect(page.eof).toBe(true);
  expect(page.frontier).toBeNull();
  expect(page.entries).toEqual([
    { status: 'unresolved', reason: 'pending', producer: pending.producer },
    { status: 'unresolved', reason: 'invalid-original', admission: malformed.producer.admission },
    { status: 'unresolved', reason: 'invalid-original', admission: falseTerminal.producer.admission },
  ]);
  expect(page).not.toHaveProperty('complete');
  const window = f.queries.find(query => /\bFROM verification\.assessment_producer\b/.test(query.sql))!;
  expect(window.values).toEqual([frontier.after, 33]);
  expect(window.sql).toMatch(/admission_id > \$1::uuid/);
});

test('assessment audit refuses a live permit change before reading or returning a raw window', async () => {
  const invalidAtStart = assessmentAuditSqlWindow([]);
  await expect(invalidAtStart.store.auditAssessmentProducers({ ...invalidAtStart.permit, generation: '7' }))
    .rejects.toBeInstanceOf(VerificationStale);
  expect(invalidAtStart.queries.some(query => /\bFROM verification\.assessment_producer\b/.test(query.sql))).toBe(false);
  const changedAfterRead = assessmentAuditSqlWindow([assessmentAuditRow(1, null).row]);
  changedAfterRead.state.driftAfterWindow = true;
  await expect(changedAfterRead.store.auditAssessmentProducers(changedAfterRead.permit))
    .rejects.toBeInstanceOf(VerificationStale);
  expect(changedAfterRead.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  expect(changedAfterRead.queries.some(query => query.sql === 'COMMIT')).toBe(false);
});
