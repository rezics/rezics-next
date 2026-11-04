import type { Database } from 'bun:sqlite';
import type { BatchCommand, BatchStatement, Source } from '@rezics/definitions/bulk';
import seeds from '../../../packages/definitions/src/reviewed-vocabulary.json';
import {
  bangumiPublicTagScheme,
  commandKey,
  reviewedReferenceKey,
  sourceDigest,
  sourceEnvelope,
} from '../../../packages/conversion/src/support.ts';
import { checkBatch } from './accepted-checks.ts';
import {
  createImportTransport,
  ImportTransportError,
  type ReviewedAcceptance,
  type ReviewedAdoption,
} from './import-client.ts';
import { ImportSession } from './import-session.ts';
import type { ImportIdentifierLookup } from './importer.ts';
import { isImportSourceRecord } from './source-record-runtime.ts';
import type { ImportSourceRecordMetadataCommand } from './import-contract.ts';
import type { Owner, RecordBindings } from './record-bindings.ts';
import { RunStore, type Run } from './run-store.ts';

export const reviewedCatalogueSource = 'rezics_reviewed_vocabulary';
export const reviewedCatalogueRevision = 'reviewed-vocabulary@1';
const globalContext = '00000000-0000-8000-8000-000000000000';
type Seed = Omit<(typeof seeds)[number], 'facts'> & {
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

function ensure(value: unknown, message = 'Reviewed catalogue input or current binding is invalid'): asserts value {
  if (!value) throw new TypeError(message);
}
/** Public transport snapshots may use null-prototype records; JSON provenance is unchanged. */
function sameJson(left: unknown, right: unknown): boolean {
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
  ensure(owner.external_id.length <= 255 && Buffer.byteLength(owner.external_id) <= 255);
  // Validate the ACTUAL complete current command framing, not just its external-id component.
  reviewedCatalogueKey(owner, 'preflight');
  return owner;
}
export function reviewedCatalogueKey(owner: Owner, operation: string): string {
  const key = `${owner.source}:${owner.external_id}:${commandKey([operation])}`;
  ensure(
    /^[\x20-\x7e]+$/.test(key) && Buffer.byteLength(key, 'utf8') <= 255,
    'Reviewed catalogue identity cannot form a bounded public operation key',
  );
  return key;
}
function owner(seed: Seed) {
  return reviewedCatalogueOwner(seed.schemeURI, seed.literalMember);
}
function envelope(seed: Seed): Source {
  return sourceEnvelope(
    {
      ...owner(seed),
      record_revision: 'unversioned',
      converter_revision: reviewedCatalogueRevision,
      digest: sourceDigest(seed),
    },
    'facts',
  );
}
function statement(fact: Seed['facts'][number], subjects?: Readonly<Record<string, string>>): BatchStatement {
  const content = fact.target ? (subjects ? subjects[fact.target] : fact.target) : fact.value;
  ensure(typeof content === 'string');
  return {
    property: { id: fact.property },
    value: { type: 'value', content },
    references: fact.citations.map((url) => ({
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }],
    })),
  };
}
function metadata(seed: Seed): { command: ImportSourceRecordMetadataCommand; key: string } {
  const command: ImportSourceRecordMetadataCommand = {
    ...owner(seed),
    metadata: seed.metadata,
    expected_metadata_revision: null,
  };
  return { command, key: reviewedCatalogueKey(owner(seed), `metadata:${sourceDigest(command)}`) };
}
/** This tool admits exactly the finite reviewed inventory. It cannot approve arbitrary new vocabulary. */
function preflight(input: unknown): Seed[] {
  // sourceDigest snapshots descriptors and enforces finite JSON byte/node limits before comparison.
  ensure(sourceDigest(input) === sourceDigest(seeds), 'Complete reviewed inventory required');
  const rows = JSON.parse(JSON.stringify(seeds)) as Seed[];
  const keys = new Set<string>();
  for (const seed of rows) {
    const o = owner(seed);
    ensure(!keys.has(o.external_id));
    keys.add(o.external_id);
    ensure(isImportSourceRecord(seed.metadata));
    const create: BatchCommand = {
      op: 'create',
      key: reviewedCatalogueKey(o, 'bootstrap'),
      source: envelope(seed),
      subject: { type: seed.type, labels: seed.labels },
    };
    ensure(checkBatch({ commands: [create] }).length === 0);
    const meta = metadata(seed);
    ensure(Buffer.byteLength(JSON.stringify(meta.command)) <= 65536);
    for (const fact of seed.facts) {
      ensure(!fact.target || rows.some((row) => row.key === fact.target));
      const proposal: BatchCommand = {
        op: 'propose',
        source: envelope(seed),
        key: reviewedCatalogueKey(o, `propose:${sourceDigest(fact)}`),
        subject: '00000000-0000-4000-8000-000000000001',
        statement: statement(
          fact,
          Object.fromEntries(rows.map((r) => [r.key, '00000000-0000-4000-8000-000000000002'])),
        ),
      };
      ensure(checkBatch({ commands: [proposal] }).length === 0);
    }
  }
  return rows;
}
async function openFence(port: ReviewedCataloguePort, seed: Seed, signal?: AbortSignal) {
  const o = owner(seed);
  ensure(
    !(await port.fence({ source: o.source, externalId: o.external_id, fieldGroup: 'facts' }, signal)).fenced,
    'Reviewed catalogue source facts are fenced',
  );
}
function slot(property: string, content: string) {
  return { property, ...(property === 'schema:sameAs' ? {} : { target: content }), context: globalContext, limit: 100 };
}
function currentSource(source: unknown, seed: Seed): boolean {
  return sameJson(source, envelope(seed));
}
async function select(
  port: ReviewedCataloguePort,
  seed: Seed,
  subject: string,
  candidate: string,
  proposed: BatchStatement,
  signal?: AbortSignal,
): Promise<ReviewedCatalogueReceipt> {
  ensure(proposed.value.type === 'value' && typeof proposed.value.content === 'string');
  const query = slot(proposed.property.id, proposed.value.content);
  let page = await port.reviewedCandidates(subject, query, signal);
  ensure(page.next === null, 'Reviewed catalogue candidate page exceeds its bound');
  const row = page.candidates.find((c) => c.id === candidate);
  ensure(
    row && 'statement' in row && currentSource(row.source, seed) && row.retracted === null && row.retraction === null,
  );
  ensure(row.decision !== 'rejected' && row.rank !== 'deprecated');
  ensure(
    !page.candidates.some((c) => 'statement' in c && c.id !== candidate && c.rank !== null),
    'Existing editorial selection must not be replaced',
  );
  ensure(
    !page.adoption || (page.adoption.mode === 'replace' && row.rank !== null),
    'Existing editorial head requires an explicit operator decision',
  );
  const acceptance = await port.acceptReviewedCandidate(
    subject,
    candidate,
    {
      context: globalContext,
      expected_head: row.head,
    },
    reviewedCatalogueKey(owner(seed), `accept:${candidate}:${row.head}`),
    signal,
  );
  ensure(acceptance.acceptance.candidate === candidate && acceptance.acceptance.decision === 'accept');
  // Read the actual adoption head after acceptance; never derive it from a write revision.
  page = await port.reviewedCandidates(subject, query, signal);
  ensure(page.next === null && !page.candidates.some((c) => 'statement' in c && c.id !== candidate && c.rank !== null));
  ensure(
    !page.adoption ||
      (page.adoption.mode === 'replace' &&
        page.candidates.some((c) => 'statement' in c && c.id === candidate && c.rank !== null)),
  );
  const adoption = await port.adoptReviewedCandidates(
    subject,
    {
      context: globalContext,
      property: query.property,
      ...(query.target ? { target: query.target } : {}),
      mode: 'replace',
      selection: [{ candidate, rank: 'preferred' }],
      expected_head: page.adoption?.head ?? null,
    },
    reviewedCatalogueKey(owner(seed), `adopt:${candidate}:${page.adoption?.head ?? null}`),
    signal,
  );
  ensure(adoption.adoption.selection.some((c) => c.candidate === candidate));
  return { subject, candidate, statement: proposed, acceptance, adoption };
}

/**
 * Explicit trusted operator tool. No grants, SQL business effects, server endpoints or auto-seeding.
 * The unchanged acquisition policy and claim journal share the session's ordinary SQLite handle.
 * Fixed metadata fill bytes/key are reproducible from the sealed inventory before any claim; the
 * native immutable receipt is replayed on reopen, including when its first response was lost.
 */
export async function seedReviewedCatalogue(input: {
  path: string | Database;
  port: ReviewedCataloguePort;
  seeds?: unknown;
  signal?: AbortSignal;
}): Promise<ReviewedCatalogueResult> {
  const rows = preflight(Object.hasOwn(input, 'seeds') ? input.seeds : seeds);
  const session = new ImportSession(input.path);
  const store = new RunStore<BatchStatement[]>(session.store.database);
  const ownership = session.acquire(reviewedCatalogueSource);
  if (ownership === 'busy') {
    session.close();
    throw new Error('Reviewed catalogue source is busy');
  }
  let run: Run | null = null;
  try {
    const prior = store.activeRun(reviewedCatalogueSource);
    if (prior) {
      run = store.reopen(prior);
      // An interrupted staging run has no effects. Discard only that incomplete acquisition.
      try {
        store.seal(run, { complete: false, reason: 'truncated' });
        run = null;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Run is already sealed') throw error;
        // Ready/finalizing work remains sealed and resumes its original bytes.
      }
    }
    if (!run) {
      const begun = store.begin(reviewedCatalogueSource);
      ensure(begun !== 'busy');
      run = begun;
      for (const seed of rows)
        store.stage(run, {
          row: {
            source: reviewedCatalogueSource,
            recordKey: owner(seed).external_id,
            recordRevision: 'unversioned',
            converter_revision: reviewedCatalogueRevision,
            digest: sourceDigest(seed),
            state: 'present',
          },
          projection: seed.facts.map((f) => statement(f)),
        });
      ensure(store.seal(run, { complete: true }).status === 'ready');
    }
    const admitted = store.pageStaged(run, { limit: 100 });
    ensure(
      admitted.length === rows.length &&
        rows.every((seed) =>
          admitted.some(
            (entry) =>
              entry.row.recordKey === owner(seed).external_id &&
              entry.row.digest === sourceDigest(seed) &&
              entry.row.converter_revision === reviewedCatalogueRevision &&
              entry.row.recordRevision === 'unversioned' &&
              sameJson(
                entry.projection,
                seed.facts.map((f) => statement(f)),
              ),
          ),
        ),
      'Sealed reviewed inventory differs; explicit correction required',
    );
    const subjects: Record<string, string> = {};
    for (const seed of rows) {
      input.signal?.throwIfAborted();
      await openFence(input.port, seed, input.signal);
      const o = owner(seed);
      const meta = metadata(seed);
      // A real current-authorized metadata ACK ALWAYS precedes bootstrap, including all replay paths.
      const ack = await input.port.setSourceRecordMetadata(
        { command: meta.command, idempotencyKey: meta.key },
        input.signal,
      );
      ensure(sameJson(ack.record, seed.metadata));
      const create: BatchCommand = {
        op: 'create',
        source: envelope(seed),
        key: reviewedCatalogueKey(o, 'bootstrap'),
        subject: { type: seed.type, labels: seed.labels },
      };
      const pending = session.bindings.prepare(o, sourceDigest(create), { commands: [create] });
      const result = await input.port.batch(JSON.parse(pending.bytes), input.signal);
      session.bindings.acknowledge(o, pending.key, result);
      const claim = session.bindings.claim(o);
      ensure(claim?.state === 'bound');
      subjects[seed.key] = claim.subject;
      // Preserve the genuine metadata observation once the unchanged journal's bound-owner invariant holds.
      const recorded = session.bindings.metadata(o);
      if (!recorded) session.bindings.prepareMetadata(o, meta.key, sourceDigest(meta.command), meta.command);
      ensure(session.bindings.metadata(o)?.key === meta.key, 'Metadata intent changed; explicit correction required');
      session.bindings.acknowledgeMetadata(o, meta.key, ack);
    }
    const facts: ReviewedCatalogueReceipt[] = [];
    for (const seed of rows) {
      const o = owner(seed);
      const commands: Extract<BatchCommand, { op: 'propose' }>[] = seed.facts.map((fact) => ({
        op: 'propose',
        source: envelope(seed),
        subject: subjects[seed.key]!,
        statement: statement(fact, subjects),
        key: reviewedCatalogueKey(o, `propose:${sourceDigest(fact)}`),
      }));
      for (const command of commands) session.bindings.prepare(o, sourceDigest(command), { commands: [command] });
      store.prepare(run, o.external_id, { commands });
      for (const command of commands) {
        await openFence(input.port, seed, input.signal);
        const journal = session.bindings.journal(o, command.key);
        ensure(journal);
        const result = await input.port.batch(JSON.parse(journal.bytes), input.signal);
        session.bindings.acknowledge(o, command.key, result);
        store.acknowledge(run, result, { recordKey: o.external_id });
        const entry = result.results[0]!;
        ensure('value' in entry && 'candidate' in entry.value);
        facts.push(
          await select(input.port, seed, subjects[seed.key]!, entry.value.candidate, command.statement, input.signal),
        );
      }
    }
    ensure(await readReviewedBangumiBinding(session.bindings, input.port, input.signal));
    let final = store.finalize(run, 100);
    while (final === 'more') final = store.finalize(run, 100);
    ensure(final === 'complete');
    return { subjects, facts };
  } finally {
    session.release(ownership);
    session.close();
  }
}

/** Current native proof, using local journal IDs only as read anchors, never as editorial receipts. */
export async function readReviewedBangumiBinding(
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  signal?: AbortSignal,
): Promise<{ sourceConcept: string; canonicalConcept: string } | null> {
  try {
    const subjects: Record<string, string> = {};
    const items: Record<
      string,
      Extract<Awaited<ReturnType<ReviewedCataloguePort['readReviewedSubject']>>, { subject: unknown }>['subject']
    > = {};
    for (const seed of seeds) {
      const claim = bindings.claim(owner(seed));
      if (claim?.state !== 'bound') return null;
      await openFence(port, seed, signal);
      const read = await port.readReviewedSubject(claim.subject, signal);
      if (
        !('subject' in read) ||
        read.subject.id !== claim.subject ||
        read.subject.type !== seed.type ||
        read.subject.context !== globalContext
      )
        return null;
      subjects[seed.key] = claim.subject;
      items[seed.key] = read.subject;
    }
    if (subjects['source-harem'] === subjects['canonical-harem']) return null;
    if ((items['source-harem']!.statements['schema:sameAs'] ?? []).length) return null;
    for (const seed of seeds)
      for (const fact of seed.facts) {
        const expected = statement(fact, subjects);
        ensure(expected.value.type === 'value' && typeof expected.value.content === 'string');
        const page = await port.reviewedCandidates(
          subjects[seed.key]!,
          slot(fact.property, expected.value.content),
          signal,
        );
        if (page.next !== null || page.adoption?.mode !== 'replace') return null;
        const content = expected.value.content;
        const selected = page.candidates.filter(
          (c) =>
            'statement' in c &&
            c.decision === 'accepted' &&
            (c.rank === 'preferred' || c.rank === 'normal') &&
            c.retracted === null &&
            c.retraction === null &&
            currentSource(c.source, seed) &&
            c.statement.value.type === 'value' &&
            c.statement.value.content === content,
        );
        if (selected.length !== 1 || !items[seed.key]!.statements[fact.property]?.some((s) => s.id === selected[0]!.id))
          return null;
        const local = bindings.candidates(owner(seed), 'facts', { limit: 100 });
        if (!local.some((c) => c.candidate === selected[0]!.id && c.subject === subjects[seed.key])) return null;
      }
    return { sourceConcept: subjects['source-harem']!, canonicalConcept: subjects['canonical-harem']! };
  } catch (error) {
    signal?.throwIfAborted();
    // No partial mapping or anonymous retry on undisclosed, moved, fenced or unavailable originals.
    if (error instanceof ImportTransportError || error instanceof TypeError) return null;
    throw error;
  }
}

export function createReviewedCatalogueLookup(
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
): ImportIdentifierLookup {
  return {
    async resolve({ conversion, signal }) {
      if (conversion.source !== 'bangumi' || !('normalized' in conversion)) return {};
      const record = conversion.normalized as { meta_tags?: string[] };
      if (!record.meta_tags?.includes('后宫')) return {};
      const binding = await readReviewedBangumiBinding(bindings, port, signal);
      return binding ? { [reviewedReferenceKey(bangumiPublicTagScheme, '后宫')]: binding.sourceConcept } : {};
    },
  };
}
