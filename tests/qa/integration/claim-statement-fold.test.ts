import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import {
  CommandOutcomeUnknown,
  FusekiClient,
  fusekiReadBudget,
  type SparqlResult,
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
  ASSESSMENT_PROFILE,
  createClaim,
  readClaimRevisions,
  readClaimHead,
  graphHeads,
  readReceipt,
  recordAssessment,
  sealVerificationAdmission,
  type CreateClaimInput,
  type GraphReceipt,
} from '../../../services/main/src/modules/verification/graph.ts';
import { HUMAN_REVIEW_METHOD, SUMMARY_POLICY } from '../../../services/main/src/modules/verification/analysis.ts';
import { assessmentDigest, reconcileAssessmentProducerEffects,
  PendingVerification, type AssessClaimInput } from '../../../services/main/src/modules/verification/operations.ts';
import { VerificationStore, type StagedAssessmentProducer,
  type AssessmentProducerRecord } from '../../../services/main/src/modules/verification/store.ts';
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
  IdempotencyConflict,
  type WorkActivationEnvironment,
} from '../../../services/main/src/modules/work/activate.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
let pool: Pool;
let contentPool: Pool;
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
const assessmentProducers: {
  staged: StagedAssessmentProducer;
  terminal: AssessmentProducerRecord;
  receipt: GraphReceipt;
}[] = [];
let historicalAssessment: RegisteredAdmission;
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
  contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
  await migrateContent(contentPool);
  const store = new VerificationStore(contentPool);
  const source = sources[0]!;
  const claim = source.receipt.result.claim!, claimRevision = source.receipt.result.claimRevision!;
  const principal = randomUUID();
  const evidence = await store.recordEvidence(principal, randomUUID(), claim,
    { claimRevision, expectedHead: null, items: [] });
  const original: AssessClaimInput = { claimRevision, evidenceSetRevision: evidence.evidence.revision,
    sourceAssessments: [], method: 'human-review', judgment: 'supported',
    evaluationContext: source.input.interpretationContext, adoptedRevision: null,
    scorePerMillion: null, calibration: null, evaluationReference: null,
    limitations: 'An explicit human judgment over the exact retained evidence manifest.',
    expectedSummary: null, resolvesChallenges: [], actingSubject: source.input.actingSubject };
  const digest = assessmentDigest(claim, original);
  async function nativeAssessment(admitted: RegisteredAdmission) {
    return recordAssessment(env, admitted, digest, { claim, claimRevision, representation: 'claim',
      evidenceSetRevision: original.evidenceSetRevision, sourceAssessments: [], method: HUMAN_REVIEW_METHOD,
      methodRevision: HUMAN_REVIEW_METHOD, policyRevision: SUMMARY_POLICY,
      evaluationContext: original.evaluationContext, coverage: 'complete', support: 'supported',
      dependence: 'established', independentOrigins: 0, scorePerMillion: null, calibration: null,
      evaluationReference: null, limitations: original.limitations, assessorKind: 'human', actingSubject: original.actingSubject });
  }
  for (const cancelled of [false, true]) {
    const admitted = { ...admission(ADMISSIONS['claim-assess'].scope, ADMISSIONS['claim-assess'].action,
      digest, original.actingSubject), principalId: principal };
    const staged = await store.stageAssessmentProducer({ admission: admitted.id, requestDigest: digest,
      principal, actingSubject: original.actingSubject, scope: admitted.scope, authorityEpoch: admitted.authorityEpoch,
      idempotencyKey: admitted.idempotencyKey, claim, claimRevision, intent: original });
    const receipt = cancelled ? await sealVerificationAdmission(env, admitted, 'claim-assess', ['assessment'])
      : await nativeAssessment(admitted);
    const terminal = await store.withAssessmentProducerEffects(admitted.id, digest, staged.permit, async client => {
      if (cancelled) return { status: 'cancelled', receipt: receipt.receipt, assessment: null,
        activation: { status: 'cancelled' } };
      const assessment = receipt.result.assessment!;
      const activation = await store.activateSummary({ target: claim, context: original.evaluationContext,
        claim, claimRevision, adoptedRevision: null, assessment, policyRevision: SUMMARY_POLICY,
        support: 'supported', review: 'reviewed', coverage: 'complete', dependence: 'established',
        reasons: ['human-review'], dependencies: [{ owner: 'graph', kind: 'claim', reference: claim, expectedHead: claimRevision },
          { owner: 'content', kind: 'evidence-set', reference: claim, expectedHead: original.evidenceSetRevision }],
        ownerPositions: { graph: { dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } },
        operationKey: `assessment:${admitted.id}`, expectedActive: null, observedDemand: null,
        openChallenges: 0, resolvedChallenges: 0 }, client);
      return { status: 'activated', receipt: receipt.receipt, assessment, activation };
    });
    assessmentProducers.push({ staged, terminal, receipt });
  }
  // This native terminal represents historical custody with no retained Content
  // intent. Recovery must report it missing rather than backfill from a retry.
  historicalAssessment = admission(ADMISSIONS['claim-assess'].scope, ADMISSIONS['claim-assess'].action,
    digest, original.actingSubject);
  await nativeAssessment(historicalAssessment);
  const seek = new StatementSeek(pool, env);
  while (await seek.projectOnce()) {
    /* owning bounded projector establishes the exact empty-Statement cut */
  }
  expect((await seek.coverage())?.complete).toBe(true);
  expect(
    (await pool.query('SELECT open FROM access.recovery_fence WHERE id=true')).rows[0]?.open,
  ).toBe(true);
}, 120_000);

async function replayNativeAssessmentTerminal() {
  const success = assessmentProducers[0]!, cancelled = assessmentProducers[1]!;
  const source = sources[0]!;
  expect((await readClaimHead(env, source.receipt.result.claim!))?.representation).toBe('statement');
  const assessment = success.receipt.result.assessment!;
  const before = await facts([GRAPHS.revisions, GRAPHS.receipts],
    [assessment, success.receipt.receipt, cancelled.receipt.receipt]);
  const content = new VerificationStore(contentPool);
  const forbidden = async (): Promise<never> => { throw new Error('Terminal replay touched unavailable current analysis or dispatch'); };
  content.analysisSnapshot = forbidden;
  content.evidenceHead = forbidden;
  content.resolveChallenges = forbidden;
  content.activateSummary = forbidden;
  let callbacks = 0;
  const effects = content.withAssessmentProducerEffects.bind(content);
  content.withAssessmentProducerEffects = (id, digest, permit, work) => effects(id, digest, permit,
    async (client, row) => { callbacks++; return work(client, row); });
  type RawRow = NonNullable<SparqlResult['results']>['bindings'][number];
  const uri = (value: string) => ({ type: 'uri', value });
  const scalar = (rows: RawRow[], predicate: string) => {
    const row = rows.find(candidate => candidate.p?.value === predicate);
    if (!row?.o) throw new Error(`Native fixture lacks ${predicate}`);
    return row;
  };
  const mutate = (predicate: string, value: string) => (rows: RawRow[]) => {
    scalar(rows, predicate).o = uri(value);
  };
  async function replay(producer: typeof success,
    mutation?: { graph: 'receipt' | 'assessment'; change: (rows: RawRow[]) => void },
    limits = { calls: 2, bytes: 81_920 }) {
    const reader = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
    const transport = reader.query.bind(reader);
    const reads: { graph: 'receipt' | 'assessment'; rows: number; bytes: number; cap: number | undefined }[] = [];
    reader.commandWithReceipt = forbidden;
    reader.update = forbidden;
    reader.query = async (query, cap) => {
      expect(query).toMatch(/SELECT\s+\?p\s+\?o/i);
      expect(query).not.toContain(iri(GRAPHS.current));
      const graph = query.includes(iri(GRAPHS.receipts)) ? 'receipt' : 'assessment';
      expect(query).toContain(iri(graph === 'receipt' ? producer.receipt.receipt : producer.receipt.result.assessment!));
      expect(query).toMatch(new RegExp(`LIMIT\\s+${graph === 'receipt' ? 17 : 65}\\b`, 'i'));
      const response = await transport(query, cap);
      reads.push({ graph, rows: response.results?.bindings.length ?? 0,
        bytes: Buffer.byteLength(JSON.stringify(response)), cap });
      if (mutation?.graph === graph) {
        const projected = structuredClone(response);
        mutation.change(projected.results!.bindings);
        return projected;
      }
      return response;
    };
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: limits.calls, bytesLeft: limits.bytes };
    const deps = { env: { ...env, fuseki: reader }, store: content,
      account: { verify: forbidden }, access: { register: forbidden, claim: forbidden,
        recordGraphOutcome: forbidden, activePrincipalId: forbidden } };
    const outcome = await fusekiReadBudget.run(budget, () => reconcileAssessmentProducerEffects(deps,
      producer.staged.row.admission, producer.staged.permit).then(value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error })));
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(budget.callsLeft).toBeGreaterThanOrEqual(0);
    expect(budget.bytesLeft).toBeGreaterThanOrEqual(0);
    expect(reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(81_920);
    return { outcome, reads, budget };
  }
  const positive = await replay(success);
  expect(positive.outcome.status).toBe('fulfilled');
  if (positive.outcome.status === 'fulfilled') expect(positive.outcome.value).toEqual(success.terminal);
  expect(positive.reads.map(read => read.graph)).toEqual(['receipt', 'assessment']);
  expect(positive.reads.map(read => read.cap)).toEqual([16_384, 65_536]);
  expect(positive.budget.callsLeft).toBe(0);
  const negative = await replay(cancelled);
  expect(negative.outcome.status).toBe('fulfilled');
  if (negative.outcome.status === 'fulfilled') expect(negative.outcome.value).toEqual(cancelled.terminal);
  expect(negative.reads.map(read => read.graph)).toEqual(['receipt']);
  const mutations: { name: string; graph: 'receipt' | 'assessment'; change: (rows: RawRow[]) => void;
    conflict?: boolean }[] = [
    { name: 'C', graph: 'assessment', change: mutate(`${RV}component`, native()), conflict: true },
    { name: 'R', graph: 'assessment', change: mutate(`${RV}claimRevision`, native()), conflict: true },
    { name: 'E', graph: 'assessment', change: mutate(`${RV}evidenceSetRevision`, native()), conflict: true },
    { name: 'model', graph: 'assessment', change: mutate(`${RV}modelRevision`, `${ASSESSMENT_PROFILE}-unknown`) },
    { name: 'shape', graph: 'assessment', change: mutate(`${RV}shapeRevision`, `${ASSESSMENT_PROFILE}-unknown`) },
    { name: 'assessor', graph: 'assessment', change: mutate(`${RV}assessor`, native()), conflict: true },
    { name: 'assessor-kind', graph: 'assessment', change: mutate(`${RV}assessorKind`, `${RV}AutomatedAssessor`), conflict: true },
    { name: 'position', graph: 'assessment', change: rows => { scalar(rows, `${RV}sequence`).o!.value = '999999999999'; }, conflict: true },
    { name: 'scalar-cardinality', graph: 'assessment', change: rows => { const extra = structuredClone(scalar(rows, `${RV}component`));
      extra.o = uri(native()); rows.push(extra); } },
    { name: 'dual-target-predicate', graph: 'assessment', change: rows => rows.push({ p: uri(`${RV}statementRevision`),
      o: structuredClone(scalar(rows, `${RV}claimRevision`).o!) }) },
    { name: 'rdf-type', graph: 'assessment', change: rows => { const row = rows.find(candidate => candidate.p?.value === `${RDF}type`
      && candidate.o?.value === `${RV}RevisionAnchor`); if (!row) throw new Error('Native fixture lacks RevisionAnchor'); row.o = uri(`${RV}ClaimRevision`); } },
    { name: 'sequence-type', graph: 'assessment', change: rows => { scalar(rows, `${RV}sequence`).o!.datatype = `${XSD}string`; } },
    { name: 'assessment-row-cap', graph: 'assessment', change: rows => { while (rows.length < 65) rows.push(structuredClone(rows[0]!)); } },
    { name: 'assessment-byte-cap', graph: 'assessment', change: rows => { scalar(rows, `${RV}limitations`).o!.value = 'x'.repeat(65_537); } },
    { name: 'missing-assessment', graph: 'assessment', change: rows => { rows.length = 0; } },
    { name: 'missing-receipt', graph: 'receipt', change: rows => { rows.length = 0; } },
    { name: 'receipt-row-cap', graph: 'receipt', change: rows => { while (rows.length < 17) rows.push(structuredClone(rows[0]!)); } },
    { name: 'receipt-position-type', graph: 'receipt', change: rows => { scalar(rows, `${RV}sequence`).o!.datatype = `${XSD}string`; } },
  ];
  // Faults change only the authenticated read projection. They do not persist
  // native corruption or claim to exercise an unavailable raw-write fixture.
  for (const mutation of mutations) {
    const failed = await replay(success, mutation);
    expect(failed.outcome.status, mutation.name).toBe('rejected');
    if (failed.outcome.status === 'rejected') expect(failed.outcome.error, mutation.name)
      .toBeInstanceOf(mutation.conflict ? IdempotencyConflict : PendingVerification);
    expect(await content.readAssessmentProducer(success.staged.row.admission)).toEqual(success.terminal);
  }
  const cancelledA = await replay(cancelled, { graph: 'receipt', change: rows => rows.push({ p: uri(`${RV}assessment`), o: uri(assessment) }) });
  expect(cancelledA.outcome.status).toBe('rejected');
  if (cancelledA.outcome.status === 'rejected') expect(cancelledA.outcome.error).toBeInstanceOf(PendingVerification);
  for (const limits of [{ calls: 1, bytes: 81_920 }, { calls: 2, bytes: 1 }]) {
    const bounded = await replay(success, undefined, limits);
    expect(bounded.outcome.status).toBe('rejected');
    if (bounded.outcome.status === 'rejected') expect(bounded.outcome.error).toBeInstanceOf(PendingVerification);
    expect(await content.readAssessmentProducer(success.staged.row.admission)).toEqual(success.terminal);
  }
  expect((await readReceipt(env, historicalAssessment.id, 'claim-assess', ['assessment']))?.outcome).toBe('succeeded');
  expect(await content.readAssessmentProducer(historicalAssessment.id)).toBeNull();
  const missingReader = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
  missingReader.query = forbidden;
  missingReader.commandWithReceipt = forbidden;
  const missing = await reconcileAssessmentProducerEffects({ env: { ...env, fuseki: missingReader }, store: content }, historicalAssessment.id,
    success.staged.permit).then(() => null, error => error);
  expect(missing?.message).toContain('original assessment producer intent is unavailable');
  expect(callbacks).toBe(0);
  expect(await facts([GRAPHS.revisions, GRAPHS.receipts],
    [assessment, success.receipt.receipt, cancelled.receipt.receipt])).toEqual(before);
  console.log(JSON.stringify({ case: 'native-terminal-replay', queries: positive.reads.length,
    rows: positive.reads.map(read => read.rows), bytes: positive.reads.map(read => read.bytes),
    parentCallsLeft: positive.budget.callsLeft, parentBytesLeft: positive.budget.bytesLeft,
    wireBytesCharged: 81_920 - positive.budget.bytesLeft,
    projectionFaults: mutations.length + 1 }));
}
afterAll(async () => {
  await contentPool?.end();
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

test('native assessment and exact Content terminal replay after C becomes B without a current analysis basis',
  replayNativeAssessmentTerminal, 120_000);
