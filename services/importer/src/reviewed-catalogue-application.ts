import type { Database } from 'bun:sqlite';
import type { BatchCommand, BatchStatement, BatchWriteRequest } from '@rezics/definitions/bulk';
import { bangumiPublicTagScheme, reviewedReferenceKey, sourceDigest } from '@rezics/conversion/support';
import { ImportTransportError, type ReviewedCandidatePage } from './import-client.ts';
import { ImportSession } from './import-session.ts';
import type { ImportIdentifierLookup } from './importer.ts';
import type { RecordBindings } from './record-bindings.ts';
import { RunStore, type Run } from './run-store.ts';
import { sameStatementProvenance } from './statement-provenance.ts';
import {
  assertReviewedCatalogue,
  currentReviewedCatalogueSource,
  preflightReviewedCatalogue,
  reviewedCatalogueEnvelope,
  reviewedCatalogueKey,
  reviewedCatalogueMetadata,
  reviewedCatalogueOwner,
  reviewedCatalogueRevision,
  reviewedCatalogueSeedOwner,
  reviewedCatalogueSlot,
  reviewedCatalogueSource,
  reviewedCatalogueStatement,
  sameReviewedCatalogueJson,
  type ReviewedBangumiBindingEvidence,
  type ReviewedBangumiBindingStatus,
  type ReviewedCatalogueLedger,
  type ReviewedCataloguePort,
  type ReviewedCatalogueReceipt,
  type ReviewedCatalogueResult,
  type ReviewedCatalogueSeed,
  type ReviewedCatalogueSeedInput,
} from './reviewed-catalogue.ts';
import type { ReviewedVocabularyPort } from './reviewed-vocabulary-port.ts';

type CurrentReviewedCandidate = Extract<ReviewedCandidatePage['candidates'][number], { statement: unknown }>;

export type ReviewedCatalogueApplication = Readonly<{
  seed(input: ReviewedCatalogueSeedInput): Promise<ReviewedCatalogueResult>;
  inspect(
    bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
    port: ReviewedCataloguePort,
    signal?: AbortSignal,
  ): Promise<ReviewedBangumiBindingStatus>;
  readBinding(
    bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
    port: ReviewedCataloguePort,
    signal?: AbortSignal,
  ): Promise<{ sourceConcept: string; canonicalConcept: string } | null>;
  lookup(
    bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
    port: ReviewedCataloguePort,
    options?: { preserveKeywordOnUnavailable?: boolean },
  ): ImportIdentifierLookup;
}>;

class ReviewedBindingFencedError extends Error {
  constructor() {
    super('Reviewed catalogue source facts are fenced');
    this.name = 'ReviewedBindingFencedError';
  }
}

async function openFence(
  port: ReviewedCataloguePort,
  seed: { schemeURI: string; literalMember: string },
  signal?: AbortSignal,
): Promise<void> {
  const o = reviewedCatalogueOwner(seed.schemeURI, seed.literalMember);
  if ((await port.fence({ source: o.source, externalId: o.external_id, fieldGroup: 'facts' }, signal)).fenced)
    throw new ReviewedBindingFencedError();
}

function openLedger(path: string | Database): ReviewedCatalogueLedger {
  const session = new ImportSession(path);
  return { session, store: new RunStore<BatchStatement[]>(session.store.database) };
}

async function select(
  port: ReviewedCataloguePort,
  seed: ReviewedCatalogueSeed,
  subject: string,
  candidate: string,
  proposed: BatchStatement,
  revision: string,
  signal?: AbortSignal,
): Promise<ReviewedCatalogueReceipt> {
  assertReviewedCatalogue(proposed.value.type === 'value' && typeof proposed.value.content === 'string');
  const query = reviewedCatalogueSlot(proposed.property.id);
  let page = await port.reviewedCandidates(subject, query, signal);
  assertReviewedCatalogue(page.next === null, 'Reviewed catalogue candidate page exceeds its bound');
  const row = page.candidates.find((c) => c.id === candidate);
  assertReviewedCatalogue(
    row &&
      'statement' in row &&
      currentReviewedCatalogueSource(row.source, seed, revision) &&
      row.retracted === null &&
      row.retraction === null,
  );
  assertReviewedCatalogue(row.decision !== 'rejected' && row.rank !== 'deprecated');
  assertReviewedCatalogue(
    !page.candidates.some((c) => 'statement' in c && c.id !== candidate && c.rank !== null),
    'Existing editorial selection must not be replaced',
  );
  assertReviewedCatalogue(
    !page.adoption || (page.adoption.mode === 'replace' && row.rank !== null),
    'Existing editorial head requires an explicit operator decision',
  );
  const acceptance = await port.acceptReviewedCandidate(
    subject,
    candidate,
    {
      context: reviewedCatalogueSlot(proposed.property.id).context,
      expected_head: row.head,
    },
    reviewedCatalogueKey(reviewedCatalogueSeedOwner(seed), `accept:${candidate}:${row.head}`),
    signal,
  );
  assertReviewedCatalogue(acceptance.acceptance.candidate === candidate && acceptance.acceptance.decision === 'accept');
  page = await port.reviewedCandidates(subject, query, signal);
  assertReviewedCatalogue(
    page.next === null && !page.candidates.some((c) => 'statement' in c && c.id !== candidate && c.rank !== null),
  );
  assertReviewedCatalogue(
    !page.adoption ||
      (page.adoption.mode === 'replace' &&
        page.candidates.some((c) => 'statement' in c && c.id === candidate && c.rank !== null)),
  );
  const adoption = await port.adoptReviewedCandidates(
    subject,
    {
      context: query.context,
      property: query.property,
      mode: 'replace',
      selection: [{ candidate, rank: 'preferred' }],
      expected_head: page.adoption?.head ?? null,
    },
    reviewedCatalogueKey(reviewedCatalogueSeedOwner(seed), `adopt:${candidate}:${page.adoption?.head ?? null}`),
    signal,
  );
  assertReviewedCatalogue(adoption.adoption.selection.some((c) => c.candidate === candidate));
  return { subject, candidate, statement: proposed, acceptance, adoption };
}

async function seedReviewedCatalogueWith(
  vocabulary: ReviewedVocabularyPort,
  input: ReviewedCatalogueSeedInput,
): Promise<ReviewedCatalogueResult> {
  const rows = preflightReviewedCatalogue(
    vocabulary,
    Object.hasOwn(input, 'seeds') ? input.seeds : vocabulary.inventory,
  );
  const owned = input.ledger ? { ledger: input.ledger, close: false } : { ledger: openLedger(input.path), close: true };
  const { session, store } = owned.ledger;
  const ownership = session.acquire(reviewedCatalogueSource);
  if (ownership === 'busy') {
    if (owned.close) session.close();
    throw new Error('Reviewed catalogue source is busy');
  }
  let run: Run | null = null;
  try {
    const prior = store.activeRun(reviewedCatalogueSource);
    if (prior) {
      run = store.reopen(prior);
      try {
        store.seal(run, { complete: false, reason: 'truncated' });
        run = null;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Run is already sealed') throw error;
      }
    }
    if (!run) {
      const begun = store.begin(reviewedCatalogueSource);
      assertReviewedCatalogue(begun !== 'busy');
      run = begun;
      for (const seed of rows)
        store.stage(run, {
          row: {
            source: reviewedCatalogueSource,
            recordKey: reviewedCatalogueSeedOwner(seed).external_id,
            recordRevision: 'unversioned',
            converter_revision: vocabulary.revision,
            digest: sourceDigest(seed),
            state: 'present',
          },
          projection: seed.facts.map((f) => reviewedCatalogueStatement(f)),
        });
      assertReviewedCatalogue(store.seal(run, { complete: true }).status === 'ready');
    }
    const admitted = store.pageStaged(run, { limit: 100 });
    assertReviewedCatalogue(
      admitted.length === rows.length &&
        rows.every((seed) =>
          admitted.some(
            (entry) =>
              entry.row.recordKey === reviewedCatalogueSeedOwner(seed).external_id &&
              entry.row.digest === sourceDigest(seed) &&
              entry.row.converter_revision === vocabulary.revision &&
              entry.row.recordRevision === 'unversioned' &&
              sameReviewedCatalogueJson(
                entry.projection,
                seed.facts.map((f) => reviewedCatalogueStatement(f)),
              ),
          ),
        ),
      'Sealed reviewed inventory differs; explicit correction required',
    );
    const subjects: Record<string, string> = {};
    for (const seed of rows) {
      input.signal?.throwIfAborted();
      await openFence(input.port, seed, input.signal);
      const o = reviewedCatalogueSeedOwner(seed);
      const meta = reviewedCatalogueMetadata(seed);
      const ack = await input.port.setSourceRecordMetadata(
        { command: meta.command, idempotencyKey: meta.key },
        input.signal,
      );
      assertReviewedCatalogue(sameReviewedCatalogueJson(ack.record, seed.metadata));
      const create: BatchCommand = {
        op: 'create',
        source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
        key: reviewedCatalogueKey(o, 'bootstrap'),
        subject: { type: seed.type, labels: seed.labels },
      };
      const pending = session.bindings.prepare(o, sourceDigest(create), { commands: [create] });
      const result = await input.port.batch(JSON.parse(pending.bytes), input.signal);
      const bootstrap = result.results[0]!;
      if ('problem' in bootstrap)
        throw new Error(`Reviewed catalogue bootstrap ${seed.key}: ${JSON.stringify(bootstrap.problem)}`);
      session.bindings.acknowledge(o, pending.key, result);
      const claim = session.bindings.claim(o);
      assertReviewedCatalogue(claim?.state === 'bound');
      subjects[seed.key] = claim.subject;
      const recorded = session.bindings.metadata(o);
      if (!recorded) session.bindings.prepareMetadata(o, meta.key, sourceDigest(meta.command), meta.command);
      assertReviewedCatalogue(
        session.bindings.metadata(o)?.key === meta.key,
        'Metadata intent changed; explicit correction required',
      );
      session.bindings.acknowledgeMetadata(o, meta.key, ack);
    }
    const facts: ReviewedCatalogueReceipt[] = [];
    for (const seed of rows) {
      const o = reviewedCatalogueSeedOwner(seed);
      const commands: Extract<BatchCommand, { op: 'propose' }>[] = seed.facts.map((fact) => ({
        op: 'propose',
        source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
        subject: subjects[seed.key]!,
        statement: reviewedCatalogueStatement(fact, subjects),
        key: reviewedCatalogueKey(o, `propose:${sourceDigest(fact)}`),
      }));
      for (const command of commands) session.bindings.prepare(o, sourceDigest(command), { commands: [command] });
      store.prepare(run, o.external_id, { commands });
      for (const command of commands) {
        await openFence(input.port, seed, input.signal);
        const journal = session.bindings.journal(o, command.key);
        assertReviewedCatalogue(journal);
        const result = await input.port.batch(JSON.parse(journal.bytes), input.signal);
        const proposal = result.results[0]!;
        if ('problem' in proposal)
          throw new Error(`Reviewed catalogue proposal ${seed.key}: ${JSON.stringify(proposal.problem)}`);
        session.bindings.acknowledge(o, command.key, result);
        store.acknowledge(run, result, { recordKey: o.external_id });
        const entry = result.results[0]!;
        assertReviewedCatalogue('value' in entry && 'candidate' in entry.value);
        facts.push(
          await select(
            input.port,
            seed,
            subjects[seed.key]!,
            entry.value.candidate,
            command.statement,
            vocabulary.revision,
            input.signal,
          ),
        );
      }
    }
    assertReviewedCatalogue(await readBinding(vocabulary, session.bindings, input.port, input.signal));
    let final = store.finalize(run, 100);
    while (final === 'more') final = store.finalize(run, 100);
    assertReviewedCatalogue(final === 'complete');
    return { subjects, facts };
  } finally {
    session.release(ownership);
    if (owned.close) session.close();
  }
}

async function inspect(
  vocabulary: ReviewedVocabularyPort,
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  signal?: AbortSignal,
): Promise<ReviewedBangumiBindingStatus> {
  try {
    const subjects: Record<string, string> = {};
    const items: Record<
      string,
      Extract<Awaited<ReturnType<ReviewedCataloguePort['readReviewedSubject']>>, { subject: unknown }>['subject']
    > = {};
    for (const seed of vocabulary.inventory) {
      const claim = bindings.claim(reviewedCatalogueSeedOwner(seed));
      if (claim?.state !== 'bound') return { state: 'withdrawn' };
      await openFence(port, seed, signal);
      const read = await port.readReviewedSubject(claim.subject, signal);
      if (
        !('subject' in read) ||
        read.subject.id !== claim.subject ||
        read.subject.type !== seed.type ||
        read.subject.context !== reviewedCatalogueSlot('schema:url').context
      )
        return { state: 'withdrawn' };
      subjects[seed.key] = claim.subject;
      items[seed.key] = read.subject;
    }
    if (subjects['source-harem'] === subjects['canonical-harem']) return { state: 'withdrawn' };
    if ((items['source-harem']!.statements['schema:sameAs'] ?? []).length) return { state: 'withdrawn' };
    const vocabularyRows = new Map<
      string,
      {
        key: string;
        owner: ReturnType<typeof reviewedCatalogueSeedOwner>;
        subjectId: string;
        nativeType: 'skos:ConceptScheme' | 'skos:Concept';
        schemeURI: string;
        sourceUri: string;
        schemeKey?: string;
        facts: { candidateId: string; command: Extract<BatchCommand, { op: 'propose' }> }[];
      }
    >();
    for (const seed of vocabulary.inventory)
      for (const fact of seed.facts) {
        const expected = reviewedCatalogueStatement(fact, subjects);
        assertReviewedCatalogue(expected.value.type === 'value' && typeof expected.value.content === 'string');
        const page = await port.reviewedCandidates(subjects[seed.key]!, reviewedCatalogueSlot(fact.property), signal);
        if (page.next !== null) return { state: 'unavailable' };
        if (page.adoption?.mode !== 'replace') return { state: 'withdrawn' };
        const content = expected.value.content;
        const currentCandidates = page.candidates.filter(
          (candidate): candidate is CurrentReviewedCandidate => 'statement' in candidate,
        );
        const selected = currentCandidates.filter(
          (c) =>
            c.decision === 'accepted' &&
            (c.rank === 'preferred' || c.rank === 'normal') &&
            c.retracted === null &&
            c.retraction === null &&
            currentReviewedCatalogueSource(c.source, seed, vocabulary.revision) &&
            c.statement.value.type === 'value' &&
            c.statement.value.content === content,
        );
        if (
          selected.length !== 1 ||
          !sameStatementProvenance(selected[0]!.statement, expected) ||
          currentCandidates.some((c) => c.id !== selected[0]!.id && c.rank !== null) ||
          !items[seed.key]!.statements[fact.property]?.some((s) => s.id === selected[0]!.id)
        )
          return { state: 'withdrawn' };
        const local = bindings.candidates(reviewedCatalogueSeedOwner(seed), 'facts', { limit: 100 });
        const owned = local.find((c) => c.candidate === selected[0]!.id && c.subject === subjects[seed.key]);
        if (!owned) return { state: 'withdrawn' };
        let command: BatchCommand;
        try {
          command = (JSON.parse(owned.bytes) as BatchWriteRequest).commands[0]!;
        } catch {
          return { state: 'withdrawn' };
        }
        if (
          command.op !== 'propose' ||
          command.key !== owned.key ||
          command.subject !== subjects[seed.key] ||
          !currentReviewedCatalogueSource(command.source, seed, vocabulary.revision) ||
          !sameStatementProvenance(command.statement, expected)
        )
          return { state: 'withdrawn' };
        let entry = vocabularyRows.get(seed.key);
        if (!entry) {
          const sourceUri = seed.metadata.url;
          if (typeof sourceUri !== 'string' || !sourceUri.startsWith('https://')) return { state: 'withdrawn' };
          const nativeType: ReviewedBangumiBindingEvidence['vocabulary'][number]['nativeType'] | null =
            seed.type === 'skos:Concept' ? seed.type : seed.type === 'skos:ConceptScheme' ? seed.type : null;
          if (!nativeType) return { state: 'withdrawn' };
          const schemeKey =
            seed.type === 'skos:Concept'
              ? vocabulary.inventory.find(
                  (row) => row.type === 'skos:ConceptScheme' && row.schemeURI === seed.schemeURI,
                )?.key
              : undefined;
          const created: {
            key: string;
            owner: ReturnType<typeof reviewedCatalogueSeedOwner>;
            subjectId: string;
            nativeType: ReviewedBangumiBindingEvidence['vocabulary'][number]['nativeType'];
            schemeURI: string;
            sourceUri: string;
            schemeKey?: string;
            facts: { candidateId: string; command: Extract<BatchCommand, { op: 'propose' }> }[];
          } = {
            key: seed.key,
            owner: reviewedCatalogueSeedOwner(seed),
            subjectId: subjects[seed.key]!,
            nativeType,
            schemeURI: seed.schemeURI,
            sourceUri,
            ...(schemeKey ? { schemeKey } : {}),
            facts: [],
          };
          vocabularyRows.set(seed.key, created);
          created.facts.push({ candidateId: selected[0]!.id, command });
        } else {
          entry.facts.push({ candidateId: selected[0]!.id, command });
        }
      }
    return {
      state: 'bound',
      evidence: {
        binding: { sourceConcept: subjects['source-harem']!, canonicalConcept: subjects['canonical-harem']! },
        vocabulary: [...vocabularyRows.values()],
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ReviewedBindingFencedError) return { state: 'withdrawn' };
    if (error instanceof ImportTransportError)
      return error.retryable || error.status === undefined || error.status >= 500
        ? { state: 'unavailable' }
        : { state: 'withdrawn' };
    if (error instanceof TypeError) return { state: 'unavailable' };
    throw error;
  }
}

async function readBinding(
  vocabulary: ReviewedVocabularyPort,
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  signal?: AbortSignal,
): Promise<{ sourceConcept: string; canonicalConcept: string } | null> {
  const result = await inspect(vocabulary, bindings, port, signal);
  return result.state === 'bound' ? result.evidence.binding : null;
}

export function createReviewedCatalogueApplication(input: {
  vocabulary: ReviewedVocabularyPort;
}): ReviewedCatalogueApplication {
  const { vocabulary } = input;
  assertReviewedCatalogue(
    vocabulary.revision === reviewedCatalogueRevision,
    'Reviewed catalogue revision must match the released vocabulary',
  );
  return {
    seed(request) {
      return seedReviewedCatalogueWith(request.vocabulary ?? vocabulary, request);
    },
    inspect(bindings, port, signal) {
      return inspect(vocabulary, bindings, port, signal);
    },
    readBinding(bindings, port, signal) {
      return readBinding(vocabulary, bindings, port, signal);
    },
    lookup(bindings, port, options = {}) {
      return {
        async resolve({ conversion, signal }) {
          if (conversion.source !== 'bangumi' || !('normalized' in conversion)) return {};
          const record = conversion.normalized as { meta_tags?: string[] };
          if (!record.meta_tags?.includes('后宫')) return {};
          const result = await inspect(vocabulary, bindings, port, signal);
          if (result.state === 'unavailable' && options.preserveKeywordOnUnavailable)
            return { status: 'unavailable', preserveProperties: ['schema:keywords'] };
          return result.state === 'bound'
            ? { [reviewedReferenceKey(bangumiPublicTagScheme, '后宫')]: result.evidence.binding.sourceConcept }
            : {};
        },
      };
    },
  };
}

export function openReviewedCatalogueLedger(path: string | Database): ReviewedCatalogueLedger {
  return openLedger(path);
}
