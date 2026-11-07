import type { Database } from 'bun:sqlite';
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import { commandKey, reviewedReferenceKey, sourceDigest, sourceEnvelope } from '@rezics/conversion/support';
import { checkBatch } from './accepted-checks.ts';
import {
  formatImportTransportError,
  ImportTransportError,
  type createImportTransport,
  type ReviewedAcceptance,
  type ReviewedAdoption,
} from './import-client.ts';
import type { ImportRequestDiagnostics } from './import-fetch.ts';
import { isImportSourceRecord } from './source-record-runtime.ts';
import type { ImportSourceRecordMetadataCommand } from './import-contract.ts';
import type { Owner, RecordBindings } from './record-bindings.ts';
import type { RunStore } from './run-store.ts';
import type { ImportSession } from './import-session.ts';
import type { ReviewedVocabularyPort, ReviewedVocabularySeed } from './reviewed-vocabulary-port.ts';

export const reviewedCatalogueSource = 'rezics_reviewed_vocabulary';
export const reviewedCatalogueRevision = 'reviewed-vocabulary@1';
const globalContext = '00000000-0000-8000-8000-000000000000';

export type ReviewedCatalogueSeed = Omit<ReviewedVocabularySeed, 'facts'> & {
  facts: { property: string; target?: string; value?: string; citations: string[] }[];
};

export type ReviewedCataloguePort = Pick<
  ReturnType<typeof createImportTransport>,
  | 'batch'
  | 'setSourceRecordMetadata'
  | 'fence'
  | 'readReviewedSubject'
  | 'reviewedCandidates'
  | 'acceptReviewedCandidate'
  | 'adoptReviewedCandidates'
>;

export type ReviewedCatalogueReceipt = {
  subject: string;
  candidate: string;
  statement: BatchStatement;
  acceptance: ReviewedAcceptance;
  adoption: ReviewedAdoption;
};

export type ReviewedCatalogueResult = {
  subjects: Readonly<Record<string, string>>;
  facts: readonly ReviewedCatalogueReceipt[];
};

export type ReviewedBangumiBindingEvidence = Readonly<{
  binding: Readonly<{ sourceConcept: string; canonicalConcept: string }>;
  vocabulary: readonly Readonly<{
    key: string;
    owner: Owner;
    subjectId: string;
    nativeType: 'skos:ConceptScheme' | 'skos:Concept';
    schemeURI: string;
    sourceUri: string;
    schemeKey?: string;
    facts: readonly Readonly<{
      candidateId: string;
      command: Extract<BatchCommand, { op: 'propose' }>;
    }>[];
  }>[];
}>;

export type ReviewedBangumiBindingStatus =
  | Readonly<{ state: 'bound'; evidence: ReviewedBangumiBindingEvidence }>
  | Readonly<{ state: 'withdrawn' | 'unavailable' }>;

export type ReviewedCatalogueLedger = Readonly<{
  session: ImportSession;
  store: RunStore<BatchStatement[]>;
}>;

export type ReviewedCatalogueSeedInput = {
  path: string | Database;
  port: ReviewedCataloguePort;
  seeds?: unknown;
  signal?: AbortSignal;
  vocabulary?: ReviewedVocabularyPort;
  ledger?: ReviewedCatalogueLedger;
};

export type ReviewedCatalogueCommandKind = 'bootstrap' | 'proposal';

const PROBLEM_CODE = /^[a-z0-9_-]{1,80}$/;
const PROBLEM_TYPE = /^https:\/\/rezics\.com\/problems\/[a-z0-9_-]{1,80}$/;
const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION = /^(subject:create|statement:propose)$/;
const TRANSACTION_PHASE =
  /^(?:before_command|command_overhead|time_mint|access_prepare|gate_wait|transaction_pool_wait|transaction_body|commit|writable_wait|contention_pause|request_completion)$/;
const SEED_KEY = /^[A-Za-z0-9._:-]{1,80}$/;

export type ReviewedCatalogueProblem = Readonly<{
  status?: number;
  type?: string;
  code?: string;
  retryable?: boolean;
  request_id?: string;
  operation?: 'subject:create' | 'statement:propose';
  partition?: number;
  phase?: string;
  contention_retries?: number;
}>;

function isPublicRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicString(value: unknown, pattern: RegExp, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : undefined;
}

function publicStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function publicPartition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function publicRetries(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

/** Copy only public RFC9457 classifiers. Detail, errors, bodies and titles stay off the envelope. */
export function reviewedCatalogueProblem(value: unknown): ReviewedCatalogueProblem {
  if (!isPublicRecord(value)) return {};
  const status = publicStatus(value.status);
  const type = publicString(value.type, PROBLEM_TYPE, 128);
  const code = publicString(value.code, PROBLEM_CODE, 80);
  const request_id = publicString(value.request_id, CORRELATION, 128);
  const operation = publicString(value.operation, OPERATION, 32) as ReviewedCatalogueProblem['operation'] | undefined;
  const partition = publicPartition(value.partition);
  const phase = publicString(value.phase, TRANSACTION_PHASE, 32);
  const contention_retries = publicRetries(value.contention_retries);
  return {
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(value.retryable === true ? { retryable: true } : value.retryable === false ? { retryable: false } : {}),
    ...(request_id === undefined ? {} : { request_id }),
    ...(operation === undefined ? {} : { operation }),
    ...(partition === undefined ? {} : { partition }),
    ...(phase === undefined ? {} : { phase }),
    ...(contention_retries === undefined ? {} : { contention_retries }),
  };
}

export class ReviewedCatalogueCommandError extends ImportTransportError {
  readonly seedKey: string;
  readonly commandKind: ReviewedCatalogueCommandKind;
  readonly operationName: string | undefined;
  readonly partition: number | undefined;
  readonly transactionPhase: string | undefined;
  readonly contentionRetries: number | undefined;

  constructor(
    seedKey: string,
    commandKind: ReviewedCatalogueCommandKind,
    problem: ReviewedCatalogueProblem,
    diagnostics: Partial<ImportRequestDiagnostics> = {},
  ) {
    const status = problem.status;
    super(status, problem.type, problem.code, problem.retryable === true, undefined, undefined, {
      method: diagnostics.method ?? 'POST',
      ...(diagnostics.origin === undefined ? {} : { origin: diagnostics.origin }),
      path: diagnostics.path ?? '/v1/subjects:batchWrite',
      phase: diagnostics.phase ?? 'http',
      ...(status === undefined ? {} : { status }),
      ...(problem.code === undefined ? {} : { code: problem.code }),
      ...(problem.request_id === undefined ? {} : { correlationId: problem.request_id }),
    });
    this.name = 'ReviewedCatalogueCommandError';
    this.seedKey = seedKey;
    this.commandKind = commandKind;
    this.operationName = problem.operation;
    this.partition = problem.partition;
    this.transactionPhase = problem.phase;
    this.contentionRetries = problem.contention_retries;
  }
}

export function formatReviewedCatalogueCommandError(error: ReviewedCatalogueCommandError): string {
  const seed = publicString(error.seedKey, SEED_KEY, 80) ?? 'none';
  const operation = publicString(error.operationName, OPERATION, 32) ?? 'none';
  const partition =
    error.partition === undefined ? 'none' : Number.isSafeInteger(error.partition) ? String(error.partition) : 'none';
  const phase = publicString(error.transactionPhase, TRANSACTION_PHASE, 32) ?? 'none';
  return `${formatImportTransportError(error)} seed=${seed} kind=${error.commandKind} operation=${operation} partition=${partition} transaction_phase=${phase}`;
}

export function throwReviewedCatalogueBatchFailure(
  seedKey: string,
  kind: ReviewedCatalogueCommandKind,
  result: BatchWriteResult,
): void {
  const entry = result.results[0];
  if (!entry) throw new TypeError('Reviewed catalogue batch returned no command result');
  if ('problem' in entry)
    throw new ReviewedCatalogueCommandError(seedKey, kind, reviewedCatalogueProblem(entry.problem));
}

export function formatReviewedCatalogueSeedError(error: unknown): string {
  if (error instanceof ReviewedCatalogueCommandError) return formatReviewedCatalogueCommandError(error);
  if (error instanceof ImportTransportError) return formatImportTransportError(error);
  return 'Reviewed vocabulary seeding failed.';
}

export type ReviewedBangumiTagBinding = Readonly<{
  sourceConcept: string;
  canonicalConcept: string;
}>;

export type ReviewedBangumiTagCurrentRead = Readonly<{
  source: Readonly<{ requestedId: string; currentId: string; available: boolean }>;
  canonical: Readonly<{ requestedId: string; currentId: string; available: boolean }>;
}>;

export function assertReviewedCatalogue(
  value: unknown,
  message = 'Reviewed catalogue input or current binding is invalid',
): asserts value {
  if (!value) throw new TypeError(message);
}

/** Public transport snapshots may use null-prototype records; JSON provenance is unchanged. */
export function sameReviewedCatalogueJson(left: unknown, right: unknown): boolean {
  try {
    return sourceDigest(left) === sourceDigest(right);
  } catch {
    return false;
  }
}

/** Reversible exact tuple encoding ONLY for platform-authored seed owners. */
export function reviewedCatalogueOwner(schemeURI: string, literalMember: string): Owner {
  const tuple = reviewedReferenceKey(schemeURI, literalMember).slice(3);
  const owner = {
    source: reviewedCatalogueSource,
    external_id: `v1:${Buffer.from(tuple, 'utf8').toString('base64url')}`,
  };
  assertReviewedCatalogue(owner.external_id.length <= 255 && Buffer.byteLength(owner.external_id) <= 255);
  reviewedCatalogueKey(owner, 'preflight');
  return owner;
}

export function reviewedCatalogueKey(owner: Owner, operation: string): string {
  const key = `${owner.source}:${owner.external_id}:${commandKey([operation])}`;
  assertReviewedCatalogue(
    /^[\x20-\x7e]+$/.test(key) && Buffer.byteLength(key, 'utf8') <= 255,
    'Reviewed catalogue identity cannot form a bounded public operation key',
  );
  return key;
}

export function reviewedCatalogueSeedOwner(seed: ReviewedVocabularySeed): Owner {
  return reviewedCatalogueOwner(seed.schemeURI, seed.literalMember);
}

export function reviewedCatalogueEnvelope(
  seed: ReviewedVocabularySeed,
  revision: string = reviewedCatalogueRevision,
): Source {
  return sourceEnvelope(
    {
      ...reviewedCatalogueSeedOwner(seed),
      record_revision: 'unversioned',
      converter_revision: revision,
      digest: sourceDigest(seed),
    },
    'facts',
  );
}

export function reviewedCatalogueStatement(
  fact: ReviewedVocabularySeed['facts'][number],
  subjects?: Readonly<Record<string, string>>,
): BatchStatement {
  const content = fact.target ? (subjects ? subjects[fact.target] : fact.target) : fact.value;
  assertReviewedCatalogue(typeof content === 'string');
  return {
    property: { id: fact.property },
    value: { type: 'value', content },
    references: fact.citations.map((url) => ({
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }],
    })),
  };
}

export function reviewedCatalogueMetadata(seed: ReviewedVocabularySeed): {
  command: ImportSourceRecordMetadataCommand;
  key: string;
} {
  const command: ImportSourceRecordMetadataCommand = {
    ...reviewedCatalogueSeedOwner(seed),
    metadata: seed.metadata as ImportSourceRecordMetadataCommand['metadata'],
    expected_metadata_revision: null,
  };
  return {
    command,
    key: reviewedCatalogueKey(reviewedCatalogueSeedOwner(seed), `metadata:${sourceDigest(command)}`),
  };
}

/** This tool admits exactly the finite reviewed inventory. It cannot approve arbitrary new vocabulary. */
export function preflightReviewedCatalogue(
  vocabulary: ReviewedVocabularyPort,
  input: unknown,
): ReviewedCatalogueSeed[] {
  assertReviewedCatalogue(
    vocabulary.revision === reviewedCatalogueRevision,
    'Reviewed catalogue revision must match the released vocabulary',
  );
  assertReviewedCatalogue(
    sameReviewedCatalogueJson(input, vocabulary.inventory),
    'Complete reviewed inventory required',
  );
  const rows = JSON.parse(JSON.stringify(vocabulary.inventory)) as ReviewedCatalogueSeed[];
  const keys = new Set<string>();
  for (const seed of rows) {
    const o = reviewedCatalogueSeedOwner(seed);
    assertReviewedCatalogue(!keys.has(o.external_id));
    keys.add(o.external_id);
    assertReviewedCatalogue(isImportSourceRecord(seed.metadata));
    const create: BatchCommand = {
      op: 'create',
      key: reviewedCatalogueKey(o, 'bootstrap'),
      source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
      subject: { type: seed.type, labels: seed.labels },
    };
    assertReviewedCatalogue(checkBatch({ commands: [create] }).length === 0);
    const meta = reviewedCatalogueMetadata(seed);
    assertReviewedCatalogue(Buffer.byteLength(JSON.stringify(meta.command)) <= 65536);
    for (const fact of seed.facts) {
      assertReviewedCatalogue(!fact.target || rows.some((row) => row.key === fact.target));
      const proposal: BatchCommand = {
        op: 'propose',
        source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
        key: reviewedCatalogueKey(o, `propose:${sourceDigest(fact)}`),
        subject: '00000000-0000-4000-8000-000000000001',
        statement: reviewedCatalogueStatement(
          fact,
          Object.fromEntries(rows.map((r) => [r.key, '00000000-0000-4000-8000-000000000002'])),
        ),
      };
      assertReviewedCatalogue(checkBatch({ commands: [proposal] }).length === 0);
    }
  }
  return rows;
}

/** Reviewed scalar and classification facts share the ordinary unkeyed property bucket. */
export function reviewedCatalogueSlot(property: string) {
  return { property, context: globalContext, limit: 100 };
}

export function currentReviewedCatalogueSource(
  source: unknown,
  seed: ReviewedVocabularySeed,
  revision: string,
): boolean {
  return sameReviewedCatalogueJson(source, reviewedCatalogueEnvelope(seed, revision));
}
