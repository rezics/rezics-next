import { jsonParameter } from '../database/json.ts';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import { readAuthoredFieldHistorySource } from '../content/authored-fields-history.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { FactRow } from './item.ts';
import begin from './record-source-set-begin.sql';
import append from './record-source-set-append.sql';
import seal from './record-source-set-seal.sql';
import read from './record-source-set-read.sql';
import page from './record-source-set-page.sql';
import guard from './record-source-set-guard.sql';
import candidate from './record-source-set-candidate.sql';
import term from './record-source-set-term.sql';
import { declareCommandRecordSourceSet } from '../history/application/index.ts';
import { type RecordHistorySourceReference, recordHistorySourceKey } from '../history/contract/index.ts';

declare const semanticSourceSet: unique symbol;
export type SemanticRecordSourceSet = Readonly<{ [semanticSourceSet]: true }>;
export type SemanticRecordSourceSetLocator = Readonly<{
  partition: number;
  transactionId: string;
  revision: number;
}>;
export type SemanticRecordSourceSetSnapshot = Readonly<{
  locator: SemanticRecordSourceSetLocator;
  digest: string;
  members: number;
}>;
type Terms = Readonly<{
  subjectId: string;
  originalRevision: number | null;
  currentRevision: number;
  field: 'labels' | 'descriptions' | 'aliases';
  language: string;
}>;
type Dependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
type TermReference = Readonly<{
  kind: 'terms';
  subjectId: string;
  revision: number;
  field: 'labels' | 'descriptions' | 'aliases';
  language: string;
}>;

type Building = {
  tx: CommandTransaction;
  locator: SemanticRecordSourceSetLocator;
  sealed: boolean;
  // Only document identities returned by an actual Content append in this command.
  documents: Set<string>;
};
const issued = new WeakMap<SemanticRecordSourceSet, Building>();
const commands = new WeakMap<CommandTransaction, SemanticRecordSourceSet>();

function building(tx: CommandTransaction, set: SemanticRecordSourceSet): Building {
  const command = currentCommand(tx);
  const state = issued.get(set);
  if (
    !state ||
    state.tx !== tx ||
    commands.get(tx) !== set ||
    state.locator.partition !== command.partition ||
    state.locator.transactionId !== command.transactionId
  )
    throw new TypeError('Semantic source set is not from this live native command');
  return state;
}
function locatorInput(locator: SemanticRecordSourceSetLocator) {
  if (
    !Number.isInteger(locator.partition) ||
    locator.partition < 0 ||
    locator.partition > 4095 ||
    routeOf(locator.transactionId) === null ||
    !Number.isInteger(locator.revision) ||
    locator.revision < 1 ||
    locator.revision > 2147483647
  )
    throw new TypeError('Invalid Semantic source set locator');
  return { partition: locator.partition, transaction: locator.transactionId, revision: locator.revision };
}
function sourceHome(subject: string): number {
  const route = routeOf(subject);
  if (route === null) throw new TypeError('Invalid native Semantic source id');
  return partitionOf(route);
}
function termKey(reference: TermReference): string {
  sourceHome(reference.subjectId);
  if (
    !Number.isInteger(reference.revision) ||
    reference.revision < 1 ||
    reference.revision > 2147483647 ||
    !['labels', 'descriptions', 'aliases'].includes(reference.field) ||
    typeof reference.language !== 'string' ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(reference.language)
  )
    throw new TypeError('Invalid native Semantic term source');
  return JSON.stringify(['terms', reference.subjectId, reference.revision, reference.field, reference.language]);
}

/** One issuer per original command attempt, before Content/work/history serialization. */
export async function beginSemanticRecordSourceSet(tx: CommandTransaction): Promise<SemanticRecordSourceSet> {
  const command = currentCommand(tx);
  if (commands.has(tx)) throw new TypeError('Repeated Semantic command source set');
  const row = await begin.run(tx, { partition: command.partition, transaction: command.transactionId });
  if (!row) throw new Error('Native Semantic source set allocation unavailable');
  const set = Object.freeze({}) as SemanticRecordSourceSet;
  const state: Building = {
    tx,
    locator: Object.freeze({
      partition: command.partition,
      transactionId: command.transactionId,
      revision: row.revision,
    }),
    sealed: false,
    documents: new Set(),
  };
  issued.set(set, state);
  commands.set(tx, set);
  declareCommandRecordSourceSet(tx, set);
  // This runs in the real executor after body/finalizer success, before receipt/outbox serialization.
  // The deferred database constraint independently checks the actual native fence at COMMIT.
  registerCommandCallback(tx, async (transactionId) => {
    building(tx, set);
    if (
      !state.sealed ||
      transactionId !== state.locator.transactionId ||
      !(await guard.run(tx, locatorInput(state.locator)))
    )
      throw new TypeError('Unsealed or mismatched native Semantic source set');
  });
  return set;
}

export async function appendSemanticRecordSourceSet(
  tx: CommandTransaction,
  set: SemanticRecordSourceSet,
  input: Readonly<{ sources: readonly RecordHistorySourceReference[]; terms: readonly Terms[] }>,
): Promise<void> {
  const state = building(tx, set);
  if (state.sealed) throw new TypeError('Semantic source set is sealed');
  if (input.sources.length + input.terms.length > 512)
    throw new RangeError('Semantic source append exceeds the existing 512 input bound');
  const members: Record<string, unknown>[] = [];
  for (const source of input.sources) {
    if (source.kind !== 'contribution' || sourceHome(source.subjectId) !== state.locator.partition)
      throw new TypeError('Semantic sets accept native contribution and term sources only');
    const key = recordHistorySourceKey(source);
    members.push({
      unit: JSON.stringify(['contribution', source.subjectId, source.candidateId, source.documentId]),
      key,
      kind: source.kind,
      subject: source.subjectId,
      candidate: source.candidateId,
      revision: source.revision,
      document: source.documentId,
    });
  }
  for (const source of input.terms) {
    if (sourceHome(source.subjectId) !== state.locator.partition)
      throw new TypeError('Semantic term source is outside the native command home');
    for (const revision of new Set([source.originalRevision, source.currentRevision])) {
      if (revision === null) continue;
      const reference: TermReference = {
        kind: 'terms',
        subjectId: source.subjectId,
        revision,
        field: source.field,
        language: source.language,
      };
      members.push({
        unit: JSON.stringify(['terms', source.subjectId, source.field, source.language]),
        key: termKey(reference),
        kind: 'terms',
        subject: source.subjectId,
        revision,
        field: source.field,
        language: source.language,
      });
    }
  }
  // An old/current term pair is two indexed versions of one native unit, never two declarations.
  for (let offset = 0; offset < members.length; offset += 512)
    await append.run(tx, {
      ...locatorInput(state.locator),
      members: jsonParameter(members.slice(offset, offset + 512)),
    });
}

export async function sealSemanticRecordSourceSet(tx: CommandTransaction, set: SemanticRecordSourceSet): Promise<void> {
  const state = building(tx, set);
  if (state.sealed) throw new TypeError('Semantic source set is already sealed');
  await seal.run(tx, locatorInput(state.locator));
  state.sealed = true;
  state.documents.clear();
}

/** A building locator is transaction-local data. Only sealed native rows are externally readable. */
export function semanticRecordSourceSetLocator(
  tx: CommandTransaction,
  set: SemanticRecordSourceSet,
): SemanticRecordSourceSetLocator {
  return building(tx, set).locator;
}

async function readAt<T>(
  deps: Dependencies,
  partition: number,
  deadline: number,
  work: (tx: CommandTransaction) => Promise<T>,
): Promise<T> {
  const now = () => deps.clock?.().getTime() ?? Date.now();
  if (!Number.isFinite(deadline) || now() >= deadline) throw new AccessUnavailableError('deadline');
  return withConnection(deps.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new AccessUnavailableError('deadline');
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      const home = await client.query<{ write_state: string }>(
        'SELECT write_state FROM core.partition WHERE partition_no=$1',
        [partition],
      );
      if (home.rows[0]?.write_state !== 'active') throw new AccessUnavailableError('contention');
      const value = await work(client);
      if (now() >= deadline) throw new AccessUnavailableError('deadline');
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

export async function readSemanticRecordSourceSet(
  deps: Dependencies,
  locator: SemanticRecordSourceSetLocator,
  context: Readonly<{ deadline: number }>,
): Promise<SemanticRecordSourceSetSnapshot | null> {
  const input = locatorInput(locator);
  return readAt(deps, locator.partition, context.deadline, async (tx) => {
    const row = await read.run(tx, input);
    return row?.digest
      ? Object.freeze({ locator: Object.freeze({ ...locator }), digest: row.digest, members: row.members })
      : null;
  });
}

/** Same-home verification uses the actual live native transaction; never check out history's pool here. */
export async function verifySemanticRecordSourceSet(
  tx: CommandTransaction,
  locator: SemanticRecordSourceSetLocator,
  digest: string,
): Promise<boolean> {
  const command = currentCommand(tx);
  const input = locatorInput(locator);
  if (command.partition !== locator.partition)
    throw new TypeError('Semantic source set verification requires its native home');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('Invalid Semantic source set digest');
  const row = await read.run(tx, input);
  return row?.digest === digest;
}

export async function pageSemanticRecordSourceSets(
  deps: Dependencies,
  reference: RecordHistorySourceReference | TermReference,
  options: Readonly<{ frontier: string | null; limit: number; deadline: number }>,
): Promise<
  Readonly<{
    state: 'progress' | 'complete';
    sets: readonly SemanticRecordSourceSetSnapshot[];
    frontier: string | null;
    examined: number;
  }>
> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new RangeError('Semantic source set page limit must be 1..100');
  if (reference.kind !== 'contribution' && reference.kind !== 'terms')
    throw new TypeError('Semantic source set lookup requires a contribution or term');
  const key = reference.kind === 'terms' ? termKey(reference) : recordHistorySourceKey(reference);
  const partition = sourceHome(reference.subjectId);
  const binding = createHash('sha256').update(key).digest('hex');
  let after = '00000000-0000-0000-0000-000000000000';
  if (options.frontier !== null) {
    if (options.frontier.length > 2048) throw new TypeError('Invalid Semantic source set frontier');
    const decoded: unknown = JSON.parse(Buffer.from(options.frontier, 'base64url').toString());
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== 1 ||
      decoded[1] !== binding ||
      typeof decoded[2] !== 'string' ||
      routeOf(decoded[2]) === null
    )
      throw new TypeError('Semantic source set frontier does not match this source');
    after = decoded[2];
  }
  return readAt(deps, partition, options.deadline, async (tx) => {
    // Exactly limit indexed members are examined. A full final page completes on its next empty probe.
    const rows = await page.run(tx, { partition, key, after, limit: options.limit });
    const sets = rows.map((row) =>
      Object.freeze({
        locator: Object.freeze({ partition, transactionId: row.transaction_id, revision: row.revision }),
        digest: row.digest!,
        members: row.members,
      }),
    );
    const complete = rows.length < options.limit;
    return Object.freeze({
      state: complete ? 'complete' : 'progress',
      sets: Object.freeze(sets),
      frontier: complete
        ? null
        : Buffer.from(JSON.stringify([1, binding, rows.at(-1)!.transaction_id])).toString('base64url'),
      examined: rows.length,
    });
  });
}

/** Native writers share their outer command's one set; low-level fixture reads do not mint authority. */
export function currentSemanticRecordSourceSet(tx: CommandTransaction): SemanticRecordSourceSet | undefined {
  const set = commands.get(tx);
  if (set) building(tx, set);
  return set;
}

/** Called immediately after an actual Content append returns its immutable document id. */
export async function recordSemanticDocumentSource(
  tx: CommandTransaction,
  source: Extract<RecordHistorySourceReference, { kind: 'contribution' }>,
): Promise<void> {
  const set = currentSemanticRecordSourceSet(tx);
  if (!set || source.documentId === null) throw new TypeError('Content append requires the outer Semantic source set');
  await appendSemanticRecordSourceSet(tx, set, { sources: [source], terms: [] });
  building(tx, set).documents.add(source.documentId);
}

/** Enroll exact native snapshots, including original document provenance, without copying bodies into metadata. */
export async function collectSemanticRecordFacts(
  tx: CommandTransaction,
  subject: string,
  facts: readonly FactRow[],
  revision?: number,
): Promise<void> {
  const set = currentSemanticRecordSourceSet(tx);
  if (!set) return;
  // A term snapshot folds the native log. Superseded term versions in a read are not copied values.
  const latestTerms = new Map<string, FactRow>();
  for (const fact of facts) {
    if (fact.kind !== 'statement') {
      const key = `${fact.kind}\n${fact.language}`;
      const previous = latestTerms.get(key);
      if (!previous || (fact.fact_revision ?? revision ?? 0) >= (previous.fact_revision ?? revision ?? 0))
        latestTerms.set(key, fact);
    }
  }
  const sources: RecordHistorySourceReference[] = [];
  const terms: Terms[] = [];
  const documents: {
    source: Extract<RecordHistorySourceReference, { kind: 'contribution' }>;
    body: FactRow['body'];
  }[] = [];
  for (const fact of facts) {
    if (fact.kind !== 'statement' && latestTerms.get(`${fact.kind}\n${fact.language}`) !== fact) continue;
    if (fact.kind === 'statement' && fact.statement_id) {
      let sourceRevision = fact.fact_revision ?? revision;
      if (sourceRevision === undefined) {
        const row = await candidate.run(tx, { route: routeOf(subject)!, subject, candidate: fact.statement_id });
        if (!row) throw new Error('Native Semantic snapshot provenance unavailable');
        sourceRevision = row.revision;
      }
      const source = {
        kind: 'contribution' as const,
        subjectId: subject,
        candidateId: fact.statement_id,
        revision: sourceRevision,
        documentId: null,
      };
      sources.push(source);
      documents.push({ source, body: fact.body });
    } else if (fact.kind !== 'statement' && fact.language) {
      const field = fact.kind === 'label' ? 'labels' : fact.kind === 'description' ? 'descriptions' : 'aliases';
      let sourceRevision = fact.fact_revision ?? revision;
      if (sourceRevision === undefined) {
        const row = await term.run(tx, { route: routeOf(subject)!, subject, kind: fact.kind, language: fact.language });
        if (!row) throw new Error('Native Semantic term provenance unavailable');
        sourceRevision = row.revision;
      }
      terms.push({
        subjectId: subject,
        originalRevision: null,
        currentRevision: sourceRevision,
        field,
        language: fact.language,
      });
    }
  }
  // The existing bound applies to actual snapshot units, after folding term history.
  // Alias values in a language share the native term key, without manufacturing candidates.
  await appendSemanticRecordSourceSet(tx, set, { sources, terms });
  for (const { source, body: rawBody } of documents) {
    const body = rawBody as {
      value?: { content?: unknown };
      qualifiers?: { value?: { content?: unknown } }[];
      references?: { parts: { value?: { content?: unknown } }[] }[];
    };
    const snaks = [body, ...(body.qualifiers ?? []), ...(body.references ?? []).flatMap((ref) => ref.parts)];
    if (snaks.length > 1 + 16 + 16 * 16) throw new RangeError('Semantic statement exceeds existing snak bounds');
    for (const snak of snaks) {
      const content = snak.value?.content;
      if (
        typeof content !== 'object' ||
        content === null ||
        !('document' in content) ||
        typeof content.document !== 'string' ||
        routeOf(content.document) === null
      )
        continue;
      if (!building(tx, set).documents.has(content.document)) {
        const original = await readAuthoredFieldHistorySource(tx, content.document);
        // Missing native metadata is unknown prior coverage, never evidence of source absence.
        if (!original)
          throw Object.assign(new AccessUnavailableError('contention'), {
            message: 'Native authored field history source unavailable',
          });
        await appendSemanticRecordSourceSet(tx, set, { sources: [original], terms: [] });
      }
      await appendSemanticRecordSourceSet(tx, set, {
        sources: [{ ...source, documentId: content.document }],
        terms: [],
      });
    }
  }
}

/** Point resolution of the original immutable candidate, including virtual compact candidates. */
export async function collectSemanticCandidateSource(
  tx: CommandTransaction,
  subject: string,
  id: string,
): Promise<void> {
  if (!currentSemanticRecordSourceSet(tx)) return;
  const row = await candidate.run(tx, { route: routeOf(subject)!, subject, candidate: id });
  if (!row) throw new Error('Native Semantic candidate provenance unavailable');
  await collectSemanticRecordFacts(tx, subject, [
    {
      kind: 'statement',
      language: null,
      property: null,
      statement_id: id,
      operation: 'assert',
      body: row.body,
      fact_revision: row.revision,
    },
  ]);
}
