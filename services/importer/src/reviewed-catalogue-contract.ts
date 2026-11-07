import type { Database } from 'bun:sqlite';
import type { BatchCommand, BatchStatement, Source } from '@rezics/definitions/bulk';
import { commandKey, reviewedReferenceKey, sourceDigest, sourceEnvelope } from '@rezics/conversion/support';
import { checkBatch } from './accepted-checks.ts';
import type { createImportTransport, ReviewedAcceptance, ReviewedAdoption } from './import-client.ts';
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
