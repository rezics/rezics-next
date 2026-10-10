import { randomUUID } from 'node:crypto';
import type { ContentCore, ContentPosition } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, TEXT_INDEX_PROBE,
  TEXT_INDEX_PROBE_BODY, TEXT_INDEX_PROBE_GRAPH, TEXT_INDEX_PROFILE, hash, iri, lit, textIndexProbePattern,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { SEARCH_REBUILD_CRASH_AT, SEARCH_REBUILD_CRASH_FLAG, SEARCH_REBUILD_CRASH_POINTS,
  SearchRebuildCrash, crashSearchRebuild, type SearchRebuildCrashPoint }
  from '../../infrastructure/search-rebuild-crash.ts';
import { relayContentProjectionOnce } from './relay.ts';
import { extractProjectionText, projectionRecipeFor } from './projection-recipes.ts';

export { SEARCH_REBUILD_CRASH_AT, SEARCH_REBUILD_CRASH_FLAG, SEARCH_REBUILD_CRASH_POINTS,
  SearchRebuildCrash, crashSearchRebuild, type SearchRebuildCrashPoint };

/**
 * One public Content rebuild. The anchor is absent from quarantine until
 * activation, and activation writes the new text generation and the anchor in
 * the same command. A rerun reaches activation from any earlier state:
 *
 * - not-started: no quarantine receipt, anchor present. Rerun quarantines and
 *   stores the Content owner cut.
 * - quarantined: anchor absent, quarantine receipt stored. Rerun finishes the
 *   profile receipt if needed, then clears Content units.
 * - cleared: a terminal clear receipt and no Content MatchUnit. Units that
 *   return while readers are closed are cleared again on the same keyed pages
 *   and the clear receipt is re-asserted. Rerun does not treat that as an error.
 * - offline-indexed: a receipt records the indexer pass for this generation and
 *   control sequence. Rerun repeats the indexer when that receipt is absent.
 *   The admitted command is the cleared-family receipt: it advances sequence
 *   and writes no public triple. Its digest family is content-rebuild-offline-v1.
 * - replayed: the rebuild cursor is at the stored quarantine cut. Rerun adopts
 *   that checkpoint idempotently (the cursor does not rewind) and activates.
 * - activated: the activate receipt, control generation, and anchor agree.
 *   Rerun only finishes SQL checkpoint promotion.
 *
 * A content-match-unit subject that is not a MatchUnit with a Content
 * projection still refuses. That subject cannot be cleared, and it must not
 * enter the indexer. A live index (anchor present) is never rebuilt in place.
 */

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
// Four retained revisions at at most 1 MiB each fit Content's 4 MiB read budget.
const SOURCE_READ_BATCH = 4;
const MAX_CLEAR_BATCHES = 2_000;
const MAX_REPLAY_EVENTS = 100_000;
const MAX_REBUILD_UNITS = 50_000;
/** Variants or MatchUnits in one verification read. Measured pages of this size stay far under Fuseki's 10s query timeout. The native clear command admits at most this many subjects. */
export const CONTENT_REBUILD_PAGE = 64;
/** A subject the clear command cannot delete. The indexer must not see it. */
export const CONTENT_REBUILD_NONEMPTY_REFUSAL = 'Content units remain after terminal clear; offline rebuild refused';
/** One verification read must finish inside this budget, leaving margin under Fuseki's 10s query timeout. */
export const CONTENT_REBUILD_READ_BUDGET_MS = 8_000;
/** One native rebuild command (quarantine, clear page, cleared, profile, activate)
 * runs against a stopped-writer stack. Measured on a 22 GiB dataset with nothing else
 * running they take 1.3 to 4.7 s each (a TDB2 commit with its fsync plus the journal
 * bookkeeping), so the 10 s Fuseki-style bound the module used refused the operator's
 * rebuild as soon as the disk was shared. */
export const CONTENT_REBUILD_COMMAND_DEADLINE_MS = 60_000;

export class ContentRebuildUnavailable extends Error {}

/** A Fuseki query abort, the server's 10s 503, or a compose wait that exceeded its clock. */
export function contentRebuildStepTimedOut(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const name = 'name' in current ? String((current as { name: unknown }).name) : '';
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    if ('code' in current && (current as { code?: unknown }).code === 'ETIMEDOUT') return true;
    if (current instanceof Error) {
      if (/the operation timed out|operation was aborted|ETIMEDOUT/i.test(current.message)
        || current.message === 'Fuseki query returned 503') return true;
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

/** The CLI's one line for a rebuild failure. A raw timeout is never printed alone. */
export function contentRebuildFailureLine(error: unknown): string | undefined {
  if (error instanceof ContentRebuildUnavailable) return error.message;
  if (contentRebuildStepTimedOut(error)) return 'rebuild: timed out';
  return undefined;
}

function contentRebuildTimeoutLine(step: string, elapsedMs: number, budgetMs: number): string {
  return `${step}: timed out after ${Math.round(elapsedMs)}ms (budget ${budgetMs}ms)`;
}

/** Name the step when a read aborts or exceeds the per-read budget. */
export async function readContentRebuildStep<T>(step: string, read: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await read();
    const elapsed = performance.now() - started;
    if (elapsed > CONTENT_REBUILD_READ_BUDGET_MS) {
      throw new ContentRebuildUnavailable(
        contentRebuildTimeoutLine(step, elapsed, CONTENT_REBUILD_READ_BUDGET_MS));
    }
    return result;
  } catch (error) {
    if (error instanceof ContentRebuildUnavailable) throw error;
    if (contentRebuildStepTimedOut(error)) {
      throw new ContentRebuildUnavailable(
        contentRebuildTimeoutLine(step, performance.now() - started, CONTENT_REBUILD_READ_BUDGET_MS),
        { cause: error });
    }
    throw error;
  }
}

export interface ContentRebuildJob {
  id: string;
  cut: ContentPosition;
  consumer: string;
}

export interface ContentRebuildProgress {
  anchor: boolean;
  quarantine: boolean;
  clearReceipt: boolean;
  /** Proper Content MatchUnits: typed, with a Content projection. */
  contentUnits: boolean;
  /** A content-match-unit subject the clear command cannot delete. */
  malformedContent: boolean;
  /** The offline record is the latest control command and the graph has no Content units. */
  offlineCovers: boolean;
  /** Latest offline digest for the current generation, including after replay advanced sequence. */
  offlineDigest: string | null;
  replaySequence: string | null;
  cutSequence: string | null;
  sequence: string | null;
  generation: string | null;
  activated: boolean;
}

export type ContentRebuildResume =
  | 'quarantine'
  | 'clear'
  | 'offline'
  | 'replay'
  | 'activate'
  | 'done'
  | { refuse: string };

/** The next command a rerun must run. A rotated generation is not a refusal:
 * activation reads the live generation. Units after a clear are a clear, while
 * the graph stays closed. */
export function nextContentRebuildStep(progress: ContentRebuildProgress): ContentRebuildResume {
  if (progress.activated) {
    if (!progress.anchor) return { refuse: 'activate: anchor is absent after activation' };
    return 'done';
  }
  if (!progress.quarantine) {
    if (!progress.anchor) return { refuse: 'quarantine: anchor is absent and this job has no receipt' };
    return 'quarantine';
  }
  if (progress.anchor) return { refuse: 'quarantine: anchor returned before activation' };
  const atCut = progress.cutSequence !== null && progress.replaySequence === progress.cutSequence;
  // Sequence 0 has not replayed. A non-zero cursor, or a cursor already at the
  // cut, has units whose projection receipts cannot be inserted again.
  const replayStarted = progress.replaySequence !== null && progress.replaySequence !== '0';
  if (!replayStarted && (!progress.clearReceipt || progress.contentUnits)) return 'clear';
  if (progress.malformedContent && !atCut) return { refuse: CONTENT_REBUILD_NONEMPTY_REFUSAL };
  if (!replayStarted && !progress.offlineCovers) return 'offline';
  if (!atCut) return 'replay';
  return 'activate';
}

type Phase = 'quarantine' | 'profile' | 'clear' | 'cleared' | 'activate';

function receipt(phase: Phase, identity: string): string {
  return `urn:rezics:receipt:content-rebuild:${phase}:${hash(identity)}`;
}

function sourceCut(value: ContentPosition): void {
  if (value.owner !== 'content' || !UUID.test(value.dataEpoch) || !DECIMAL.test(value.sequence)) {
    throw new ContentRebuildUnavailable('invalid Content source cut');
  }
}

function rebuildId(value: string): void {
  if (!UUID.test(value)) throw new ContentRebuildUnavailable('invalid rebuild id');
}

async function command(env: WorkActivationEnvironment, phase: Phase, identity: string,
  digestInput: unknown, changes: { deletion?: string; insertion?: string; condition?: string;
    receiptFacts?: string; controlDeletion?: string; controlInsertion?: string },
  step = `${phase}: command`): Promise<void> {
  const operation = receipt(phase, identity);
  const digest = hash(JSON.stringify(digestInput));
  const batch = `urn:rezics:outbox:${hash(`${operation}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${operation}\0event`)}`;
  const deadlineMs = CONTENT_REBUILD_COMMAND_DEADLINE_MS;
  const update = `PREFIX rv: <${RV}> DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n ${changes.controlDeletion ?? ''} }
    ${changes.deletion ?? ''}
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next ${changes.controlInsertion ?? ''} }
    ${changes.insertion ?? ''}
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(operation)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next ${changes.receiptFacts ?? ''} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:ContentRebuildEvent ; rv:ordinal 0 ;
      rv:action ${lit(`content.rebuild.${phase}`)} ; rv:receipt ${iri(operation)} . }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    ${changes.condition ?? ''}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(operation)} ?p ?o } }
    BIND(?n + 1 AS ?next)
  }`;
  let result;
  const started = performance.now();
  try {
    result = await env.fuseki.commandWithReceipt({ receipt: operation, digest,
      update, validations: [], deadlineMs });
  } catch (error) {
    if (contentRebuildStepTimedOut(error)) {
      throw new ContentRebuildUnavailable(
        contentRebuildTimeoutLine(step, performance.now() - started, deadlineMs), { cause: error });
    }
    throw error;
  }
  if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
    throw new ContentRebuildUnavailable(`Content rebuild ${phase} command ${result.status}`
      + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
  }
}

async function readQuarantine(env: WorkActivationEnvironment, id: string): Promise<ContentPosition | null> {
  const result = await readContentRebuildStep('progress: quarantine receipt', () => env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?sourceEpoch ?sourceSequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt('quarantine', id))} a rv:OperationReceipt ;
      rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
      rv:ownerDataEpoch ?sourceEpoch ; rv:ownerSequence ?sourceSequence . }
  }`));
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length !== 1 || row?.epoch?.value !== env.lineage.dataEpoch
    || !DECIMAL.test(row.sequence?.value ?? '') || !UUID.test(row.sourceEpoch?.value ?? '')
    || !DECIMAL.test(row.sourceSequence?.value ?? '')) {
    throw new ContentRebuildUnavailable('Content rebuild quarantine receipt is incomplete');
  }
  return { owner: 'content', dataEpoch: row.sourceEpoch!.value,
    sequence: row.sourceSequence!.value };
}

/** Keyed by the receipt IRI. Callers name the read so a timeout says which one stopped. */
async function receiptIsCommitted(env: WorkActivationEnvironment, phase: Phase, id: string): Promise<boolean> {
  const answer = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt(phase, id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} . } }`);
  return answer.boolean === true;
}

/** Complete a committed activation whose process died before SQL checkpoint promotion. */
export async function resumeActivatedContentRebuild(env: WorkActivationEnvironment,
  cursor: ContentProjectionCursor, id: string, publicConsumer: string): Promise<string | null> {
  rebuildId(id);
  const result = await readContentRebuildStep('activate: receipt', () => env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sourceEpoch
    ?sourceSequence ?generation WHERE { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt('activate', id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ?epoch ; rv:ownerDataEpoch ?sourceEpoch ;
      rv:ownerSequence ?sourceSequence ; rv:textIndexGeneration ?generation . } }`));
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length !== 1 || value(row!, 'epoch') !== env.lineage.dataEpoch
    || !UUID.test(value(row!, 'sourceEpoch') ?? '')
    || !DECIMAL.test(value(row!, 'sourceSequence') ?? '')
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(value(row!, 'generation') ?? '')) {
    throw new ContentRebuildUnavailable('activated rebuild receipt is incomplete');
  }
  const generation = value(row!, 'generation')!;
  const confirmed = await readContentRebuildStep('activate: control', () => env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:textIndexGeneration ${iri(generation)} . }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
  }`));
  if (confirmed.boolean !== true) throw new ContentRebuildUnavailable('activated index control differs from receipt');
  await cursor.adoptRebuildCheckpoint(publicConsumer, `content-rebuild.${id}`,
    { owner: 'content', dataEpoch: value(row!, 'sourceEpoch')!, sequence: value(row!, 'sourceSequence')! });
  return generation;
}

export async function publicSearchAnchorPresent(env: WorkActivationEnvironment): Promise<boolean> {
  const answer = await readContentRebuildStep('progress: anchor', () => env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`));
  if (answer.boolean !== true && answer.boolean !== false) {
    throw new ContentRebuildUnavailable('quarantine: public search anchor is unreadable');
  }
  return answer.boolean === true;
}

async function assertQuarantined(env: WorkActivationEnvironment): Promise<void> {
  if (await publicSearchAnchorPresent(env)) throw new ContentRebuildUnavailable('public search is not quarantined');
}

/** Persistently remove the public-search anchor before any replacement work. */
export async function quarantinePublicContentSearch(env: WorkActivationEnvironment,
  content: ContentCore, id: string): Promise<ContentRebuildJob> {
  rebuildId(id);
  const consumer = `content-rebuild.${id}`;
  let cut = await readQuarantine(env, id);
  if (!cut) {
    if (!await publicSearchAnchorPresent(env)) {
      throw new ContentRebuildUnavailable('quarantine: anchor is absent and this job has no receipt');
    }
    cut = await content.ownerPosition();
    sourceCut(cut);
    await command(env, 'quarantine', id, { family: 'content-rebuild-quarantine-v1', id, cut }, {
      deletion: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }`,
      condition: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }`,
      receiptFacts: `; rv:ownerDataEpoch ${lit(cut.dataEpoch)} ; rv:ownerSequence ${lit(cut.sequence)} ; rv:rebuildJob ${lit(id)}`,
    });
    cut = await readQuarantine(env, id);
    if (!cut) throw new ContentRebuildUnavailable('quarantine receipt is absent');
  }
  await assertQuarantined(env);
  // A separate receipt also upgrades a job quarantined by an older release.
  // Public reads stay closed until the offline rebuild and activation finish.
  // Cost: one bounded receipt read and one constant-size guarded command.
  const profileIdentity = `${id}\0${TEXT_INDEX_PROFILE}`;
  if (!await readContentRebuildStep('quarantine: profile receipt', () => receiptIsCommitted(env, 'profile', profileIdentity))) {
    await command(env, 'profile', profileIdentity, {
      family: 'content-rebuild-profile-v1', id, profile: TEXT_INDEX_PROFILE,
      probe: TEXT_INDEX_PROBE_BODY,
    }, {
      controlDeletion: '; rv:textIndexProfile ?priorProfile',
      controlInsertion: `; rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)}`,
      deletion: `GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
        ${iri(TEXT_INDEX_PROBE)} rv:searchBody ?priorProbe . }`,
      insertion: `GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
        ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh . }`,
      condition: `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexProfile ?priorProfile . }
        OPTIONAL { GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} { ${iri(TEXT_INDEX_PROBE)} rv:searchBody ?priorProbe . } }
        FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`,
    });
  }
  return { id, cut, consumer };
}

/** One ordered page of clearable Content units. The native command admits at most 64 subjects. */
export function contentRebuildClearPageQuery(): string {
  return `PREFIX rv: <${RV}> SELECT DISTINCT ?unit WHERE {
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:projection ?projection .
      FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
        && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) }
  } ORDER BY STR(?unit) LIMIT ${CONTENT_REBUILD_PAGE}`;
}

async function listContentUnits(env: WorkActivationEnvironment, page: number): Promise<string[]> {
  const result = await readContentRebuildStep(`clear: page ${page}`, () => env.fuseki.query(contentRebuildClearPageQuery()));
  const rows = result.results?.bindings ?? [];
  const units = rows.map(row => row.unit?.value);
  if (units.some(unit => !unit || !unit.startsWith('urn:rezics:content:match-unit:'))
    || new Set(units).size !== units.length) {
    throw new ContentRebuildUnavailable('Content unit inventory is invalid');
  }
  return (units as string[]).sort();
}

/** Restartable cleanup. The terminal receipt prevents a restarted job from clearing newly replayed units. */
export async function clearQuarantinedContentUnits(env: WorkActivationEnvironment,
  job: ContentRebuildJob): Promise<number> {
  await assertQuarantined(env);
  if (await readContentRebuildStep('clear: cleared receipt', () => receiptIsCommitted(env, 'cleared', job.id))) return 0;
  let removed = 0;
  for (let batch = 0; batch < MAX_CLEAR_BATCHES; batch++) {
    const units = await listContentUnits(env, batch);
    if (units.length === 0) {
      await command(env, 'cleared', job.id,
        { family: 'content-rebuild-cleared-v1', id: job.id, cut: job.cut }, {});
      return removed;
    }
    const identity = `${job.id}\0${units.join('\0')}`;
    await command(env, 'clear', identity,
      { family: 'content-rebuild-clear-v1', id: job.id, cut: job.cut, units }, {
        deletion: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${units.map(unit => `${iri(unit)} ?oldPredicate ?oldValue .`).join('\n')}
        }`,
        condition: `VALUES ?oldUnit { ${units.map(iri).join(' ')} }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit a rv:MatchUnit ;
            rv:projection ?projection ; ?oldPredicate ?oldValue . }`,
      });
    removed += units.length;
  }
  throw new ContentRebuildUnavailable('Content unit cleanup exceeded bounded batches');
}

/** Delete Content units that returned after the terminal clear, while the anchor
 * stays absent. The original clear receipt is left in place; a new cleared
 * receipt records this cut. Replay that has left sequence 0 is not cleared:
 * those units belong to receipts that cannot be inserted again. */
export async function reclearQuarantinedContentUnits(env: WorkActivationEnvironment,
  job: ContentRebuildJob): Promise<number> {
  await assertQuarantined(env);
  if (!await readContentRebuildStep('reclear: cleared receipt', () => receiptIsCommitted(env, 'cleared', job.id))) {
    return clearQuarantinedContentUnits(env, job);
  }
  let removed = 0;
  for (let batch = 0; batch < MAX_CLEAR_BATCHES; batch++) {
    const units = await listContentUnits(env, batch);
    if (units.length === 0) {
      if (removed > 0) await recordReclear(env, job);
      return removed;
    }
    const control = await readIndexControl(env);
    const identity = `${job.id}\0${control.sequence}\0${units.join('\0')}`;
    await command(env, 'clear', identity,
      { family: 'content-rebuild-clear-v1', id: job.id, cut: job.cut, units, sequence: control.sequence }, {
        deletion: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${units.map(unit => `${iri(unit)} ?oldPredicate ?oldValue .`).join('\n')}
        }`,
        condition: `VALUES ?oldUnit { ${units.map(iri).join(' ')} }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit a rv:MatchUnit ;
            rv:projection ?projection ; ?oldPredicate ?oldValue . }`,
      });
    removed += units.length;
  }
  throw new ContentRebuildUnavailable('clear: Content unit cleanup exceeded bounded batches');
}

async function recordReclear(env: WorkActivationEnvironment, job: ContentRebuildJob): Promise<void> {
  const control = await readIndexControl(env);
  await command(env, 'cleared', `reclear\0${job.id}\0${control.sequence}`,
    { family: 'content-rebuild-reclear-v1', id: job.id, cut: job.cut, sequence: control.sequence }, {
      condition: `FILTER(?n = ${control.sequence})
        FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?unit a rv:MatchUnit ; rv:projection ?projection .
          FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
            && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) } }
        FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`,
      receiptFacts: `; rv:rebuildJob ${lit(job.id)} ; rv:ownerDataEpoch ${lit(job.cut.dataEpoch)}
        ; rv:ownerSequence ${lit(job.cut.sequence)}`,
    }, 'reclear: command');
}

/** The admitted cleared-family command records an indexer pass. It advances
 * sequence and writes no public triple, and it omits priorIndexGeneration so
 * a generation read does not treat it as activation. A later command makes
 * the record stop covering the graph, so the indexer runs again. */
export async function recordOfflineContentRebuild(env: WorkActivationEnvironment, job: ContentRebuildJob,
  generation: string, preSequence: string, digest: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ContentRebuildUnavailable('offline: index evidence digest is required');
  if (!DECIMAL.test(preSequence) || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(generation)) {
    throw new ContentRebuildUnavailable('offline: graph control is unavailable');
  }
  await command(env, 'cleared', `offline\0${job.id}\0${generation}\0${preSequence}`,
    { family: 'content-rebuild-offline-v1', id: job.id, generation, sequence: preSequence, digest }, {
      condition: `FILTER(?n = ${preSequence})
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ${iri(generation)} . }
        FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`,
      receiptFacts: `; rv:rebuildJob ${lit(job.id)} ; rv:textIndexGeneration ${iri(generation)}
        ; rv:indexRebuildDigest ${lit(digest)}`,
    }, 'offline: command');
}

async function readIndexControl(env: WorkActivationEnvironment): Promise<{ sequence: string; generation: string }> {
  const result = await readContentRebuildStep('progress: index control', () => env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?sequence ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    }`));
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !DECIMAL.test(row?.sequence?.value ?? '')
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(row?.generation?.value ?? '')) {
    throw new ContentRebuildUnavailable('control: graph control is unavailable');
  }
  return { sequence: row!.sequence!.value, generation: row!.generation!.value };
}

function contentUnitPattern(kind: 'units' | 'malformed'): string {
  return kind === 'units'
    ? `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:projection ?projection .
        FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
          && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) }`
    : `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit ?predicate ?value .
        FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:"))
        FILTER NOT EXISTS { ?unit a rv:MatchUnit ; rv:projection ?projection .
          FILTER(STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) } }`;
}

/** One row. The clear page is the ordered inventory; this read only asks whether any subject remains. */
async function contentUnitExists(env: WorkActivationEnvironment, kind: 'units' | 'malformed'): Promise<boolean> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit WHERE {
    ${contentUnitPattern(kind)} } LIMIT 1`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new ContentRebuildUnavailable('clear: Content unit inventory is unreadable');
  return rows.length === 1;
}

/** The offline receipt IRI is hash(job, generation, the sequence the command advanced from). */
function offlineReceipt(id: string, generation: string, preSequence: string): string {
  return receipt('cleared', `offline\0${id}\0${generation}\0${preSequence}`);
}

async function readKeyedOffline(env: WorkActivationEnvironment, id: string, generation: string,
  preSequence: string): Promise<{ digest: string; sequence: string } | null> {
  const result = await readContentRebuildStep('progress: offline receipt', () => env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?digest ?sequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(offlineReceipt(id, generation, preSequence))} a rv:OperationReceipt ;
          rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?sequence ; rv:rebuildJob ${lit(id)} ;
          rv:indexRebuildDigest ?digest ; rv:textIndexGeneration ${iri(generation)} .
      }
    }`));
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const digest = rows[0]?.digest?.value ?? '';
  const sequence = rows[0]?.sequence?.value ?? '';
  if (rows.length !== 1 || !/^[0-9a-f]{64}$/.test(digest) || !DECIMAL.test(sequence)) {
    throw new ContentRebuildUnavailable('offline: index evidence is incomplete');
  }
  return { digest, sequence };
}

/** The stored pre-sequence is the receipt the indexer wrote. The prior control
 * sequence is the same receipt when the file has not caught up yet. Both are
 * receipt IRIs, so neither walks the receipts graph. */
async function readLatestOffline(env: WorkActivationEnvironment, id: string,
  generation: string, controlSequence: string, knownPreSequence: string | null):
  Promise<{ digest: string; sequence: string } | null> {
  const keys: string[] = [];
  if (knownPreSequence && DECIMAL.test(knownPreSequence)) keys.push(knownPreSequence);
  if (DECIMAL.test(controlSequence) && controlSequence !== '0') {
    const prior = (BigInt(controlSequence) - 1n).toString();
    if (!keys.includes(prior)) keys.push(prior);
  }
  let best: { digest: string; sequence: string } | null = null;
  for (const key of keys) {
    const found = await readKeyedOffline(env, id, generation, key);
    if (found && (best === null || BigInt(found.sequence) > BigInt(best.sequence))) best = found;
  }
  return best;
}

async function readActivationGeneration(env: WorkActivationEnvironment, id: string): Promise<string | null> {
  const result = await readContentRebuildStep('progress: activation receipt', () => env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?generation WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt('activate', id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:textIndexGeneration ?generation . } }`));
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const generation = rows[0]?.generation?.value ?? '';
  if (rows.length !== 1 || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(generation)) {
    throw new ContentRebuildUnavailable('activate: receipt is incomplete');
  }
  return generation;
}

/** Facts a rerun needs. `replaySequence` is the rebuild cursor, 0 before replay.
 * `offlinePreSequence` is the sequence the indexer command advanced from, stored
 * beside the job id so a later resume can name that receipt. */
export async function readContentRebuildProgress(env: WorkActivationEnvironment, id: string,
  replaySequence: string | null, offlinePreSequence: string | null = null): Promise<ContentRebuildProgress> {
  rebuildId(id);
  if (replaySequence !== null && !DECIMAL.test(replaySequence)) {
    throw new ContentRebuildUnavailable('replay: cursor is invalid');
  }
  if (offlinePreSequence !== null && !DECIMAL.test(offlinePreSequence)) {
    throw new ContentRebuildUnavailable('offline: stored sequence is invalid');
  }
  const anchor = await publicSearchAnchorPresent(env);
  const quarantine = await readQuarantine(env, id);
  const clearReceipt = await readContentRebuildStep('progress: cleared receipt',
    () => receiptIsCommitted(env, 'cleared', id));
  const contentUnits = await readContentRebuildStep('progress: content units',
    () => contentUnitExists(env, 'units'));
  const malformedContent = await readContentRebuildStep('progress: malformed content',
    () => contentUnitExists(env, 'malformed'));
  const control = await readIndexControl(env);
  const offline = await readLatestOffline(env, id, control.generation, control.sequence, offlinePreSequence);
  const activation = await readActivationGeneration(env, id);
  return { anchor, quarantine: quarantine !== null, clearReceipt, contentUnits, malformedContent,
    offlineCovers: Boolean(offline && offline.sequence === control.sequence && !contentUnits),
    offlineDigest: offline?.digest ?? null, replaySequence, cutSequence: quarantine?.sequence ?? null,
    sequence: control.sequence, generation: control.generation,
    activated: activation !== null && activation === control.generation };
}

/** One quarantine job id, with no sort. The job file is the usual key. This
 * read is for a receipt that stored rv:rebuildJob when that file is absent.
 * Sorting every such receipt walks the receipts graph. */
export async function readAdoptedQuarantineJob(env: WorkActivationEnvironment): Promise<string | null> {
  const result = await readContentRebuildStep('adopt: quarantine job', () => env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?job WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:rebuildJob ?job ;
        rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
        FILTER(STRSTARTS(STR(?receipt), "urn:rezics:receipt:content-rebuild:quarantine:")) }
    } LIMIT 1`));
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const job = rows[0]?.job?.value ?? '';
  if (rows.length !== 1 || !UUID.test(job)) {
    throw new ContentRebuildUnavailable('quarantine: receipt job id is invalid');
  }
  return job;
}

/** Replays the retained source cut into fresh, job-scoped receipt/unit identities. */
export async function replayQuarantinedContentCut(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, job: ContentRebuildJob): Promise<number> {
  await assertQuarantined(env);
  if (!await readContentRebuildStep('replay: cleared receipt', () => receiptIsCommitted(env, 'cleared', job.id))) {
    throw new ContentRebuildUnavailable('old Content units were not cleared');
  }
  const at = await cursor.initialize(job.consumer);
  if (at.dataEpoch !== job.cut.dataEpoch || BigInt(at.sequence) > BigInt(job.cut.sequence)) {
    throw new ContentRebuildUnavailable('rebuild cursor differs from retained Content cut');
  }
  let processed = 0;
  while (processed < MAX_REPLAY_EVENTS) {
    const position = await cursor.read(job.consumer);
    if (position.sequence === job.cut.sequence) break;
    const current = await content.ownerPosition();
    if (current.dataEpoch !== job.cut.dataEpoch || current.sequence !== job.cut.sequence) {
      throw new ContentRebuildUnavailable('Content source moved during rebuild');
    }
    const next = await relayContentProjectionOnce(env, content, cursor, job.consumer, job.id);
    if (!next) throw new ContentRebuildUnavailable('Content outbox ended before rebuild cut');
    processed++;
  }
  if ((await cursor.read(job.consumer)).sequence !== job.cut.sequence) {
    throw new ContentRebuildUnavailable('Content replay exceeded bounded event budget');
  }
  const current = await content.ownerPosition();
  if (current.dataEpoch !== job.cut.dataEpoch || current.sequence !== job.cut.sequence) {
    throw new ContentRebuildUnavailable('Content source moved after rebuild replay');
  }
  return processed;
}

interface RebuildGraphSnapshot {
  sequence: string;
  generation: string;
  unitCount: number;
  contentUnitCount: number;
}

function value(row: Record<string, { value: string; 'xml:lang'?: string }>, key: string): string | undefined {
  return row[key]?.value;
}

function textKey(unit: string, body: string, language: string): string {
  return `${unit}\0${language}\0${body}`;
}

type RebuildBinding = Record<string, { value: string; 'xml:lang'?: string }>;

// Jena evaluates `>` on IRIs as a type error, so every row is dropped. The keyset compares the IRI string.
function rebuildKeyset(variable: string, after: string | undefined): string {
  return after ? `FILTER(STR(?${variable}) > ${lit(after)})` : '';
}

/** Declared public-search variants, one ordered keyset page. */
export function contentRebuildDeclaredPageQuery(after: string | undefined): string {
  return `PREFIX rv: <${RV}> SELECT ?variant WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
      rv:publicSearchEligibilityHead ?eligibility .
      ${rebuildKeyset('variant', after)} }
  } ORDER BY STR(?variant) LIMIT ${CONTENT_REBUILD_PAGE}`;
}

/** Heads, decisions and receipts for one page of variants. Receipts are bound by variant, not scanned by predicate. */
export function contentRebuildHeadsPageQuery(variants: readonly string[], dataEpoch: string): string {
  return `PREFIX rv: <${RV}> SELECT ?variant ?resource ?decision ?eligibility
    ?revision ?digest WHERE {
    VALUES ?variant { ${variants.map(variant => iri(variant)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?resource ;
      rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
      rv:variant ?variant ; rv:resource ?resource ; rv:publicationDecision ?decision ;
      rv:rightsBasis ?rightsBasis ; rv:disclosure rv:Public ;
      rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ?eligibilitySequence .
      ?decision a rv:ContentPublicationDecision ; rv:contentRevision ?revision ;
        rv:byteDigest ?digest ; rv:resource ?resource ; rv:component ?variant ;
        rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence ;
        rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ?publicationSequence . }
    GRAPH ${iri(GRAPHS.receipts)} {
      ?publicationReceipt rv:variant ?variant ;
        a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:publicationDecision ?decision ; rv:contentRevision ?revision ;
        rv:byteDigest ?digest ; rv:resource ?resource ;
        rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence ;
        rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ?publicationSequence .
      ?eligibilityReceipt rv:variant ?variant ;
        a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:eligibilityDecision ?eligibility ; rv:publicationDecision ?decision ;
        rv:resource ?resource ;
        rv:rightsBasis ?rightsBasis ; rv:disclosure rv:Public ;
        rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ?eligibilitySequence . }
    FILTER(?rightsBasis IN (rv:OriginalContribution, rv:PublicDomain))
  } LIMIT ${CONTENT_REBUILD_PAGE}`;
}

/** Public MatchUnits, one ordered keyset page, including non-Content units the Lucene audit counts. */
export function contentRebuildUnitsPageQuery(after: string | undefined): string {
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?unit ?body ?variant ?revision ?decision ?eligibility ?resource
      ?resultWork ?resultMain ?chapterTitle ?book ?bookMain ?bookTitle WHERE {
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    ?unit a rv:MatchUnit .
    ${rebuildKeyset('unit', after)}
    OPTIONAL { ?unit rv:searchBody ?body . }
    OPTIONAL { ?unit rv:resource ?resource . }
    OPTIONAL { ?unit rv:projection ?projection ; rv:variant ?variant ;
      rv:revision ?revision ; rv:publicationDecision ?decision ;
      rv:eligibility ?eligibility . }
    OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
      rv:searchChapterTitle ?chapterTitle . }
  }
  } ORDER BY STR(?unit) LIMIT ${CONTENT_REBUILD_PAGE}`;
}

function pageAdvanced(rows: RebuildBinding[], variable: string, after: string | undefined): string | undefined {
  let previous = after;
  for (const row of rows) {
    const current = value(row, variable);
    if (!current || (previous !== undefined && current <= previous)) return undefined;
    previous = current;
  }
  return previous;
}

async function readDeclaredPages(env: WorkActivationEnvironment): Promise<RebuildBinding[]> {
  const declared: RebuildBinding[] = [];
  let after: string | undefined;
  for (let ordinal = 0; ordinal <= MAX_REBUILD_UNITS; ordinal++) {
    const page = (await readContentRebuildStep(`verify: declared page ${ordinal}`, () => env.fuseki.query(
      contentRebuildDeclaredPageQuery(after)))).results?.bindings ?? [];
    if (page.length === 0) return declared;
    const next = pageAdvanced(page, 'variant', after);
    if (!next) throw new ContentRebuildUnavailable('declared eligibility inventory differs from exact public heads');
    declared.push(...page);
    if (declared.length > MAX_REBUILD_UNITS) throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
    after = next;
    if (page.length < CONTENT_REBUILD_PAGE) return declared;
  }
  throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
}

async function readHeadPages(env: WorkActivationEnvironment, declared: readonly RebuildBinding[]): Promise<RebuildBinding[]> {
  const heads: RebuildBinding[] = [];
  const variants = declared.map(row => value(row, 'variant')!);
  for (let ordinal = 0, offset = 0; offset < variants.length; ordinal++, offset += CONTENT_REBUILD_PAGE) {
    const rows = (await readContentRebuildStep(`verify: heads page ${ordinal}`, () => env.fuseki.query(
      contentRebuildHeadsPageQuery(variants.slice(offset, offset + CONTENT_REBUILD_PAGE), env.lineage.dataEpoch),
    ))).results?.bindings ?? [];
    heads.push(...rows);
    if (heads.length > MAX_REBUILD_UNITS) throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
  }
  return heads;
}

async function readUnitPages(env: WorkActivationEnvironment): Promise<RebuildBinding[]> {
  const units: RebuildBinding[] = [];
  let after: string | undefined;
  for (let ordinal = 0; ordinal <= MAX_REBUILD_UNITS; ordinal++) {
    const page = (await readContentRebuildStep(`verify: units page ${ordinal}`, () => env.fuseki.query(
      contentRebuildUnitsPageQuery(after)))).results?.bindings ?? [];
    if (page.length === 0) return units;
    const next = pageAdvanced(page, 'unit', after);
    if (!next) throw new ContentRebuildUnavailable('RDF MatchUnit inventory is ambiguous');
    units.push(...page);
    if (units.length > MAX_REBUILD_UNITS) throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
    after = next;
    if (page.length < CONTENT_REBUILD_PAGE) return units;
  }
  throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
}

/** Compare the bounded RDF projection, current public heads, exact Content bytes,
 * and the restarted Lucene reader, one keyset page at a time. Outbox replay alone
 * cannot certify this inventory. */
export async function verifyQuarantinedContentIndex(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, job: ContentRebuildJob): Promise<RebuildGraphSnapshot> {
  await assertQuarantined(env);
  if (!await readContentRebuildStep('verify: cleared receipt', () => receiptIsCommitted(env, 'cleared', job.id))) {
    throw new ContentRebuildUnavailable('Content cleanup receipt is absent');
  }
  const [owner, replay] = await Promise.all([content.ownerPosition(), cursor.read(job.consumer)]);
  if (owner.dataEpoch !== job.cut.dataEpoch || owner.sequence !== job.cut.sequence
    || replay.dataEpoch !== job.cut.dataEpoch || replay.sequence !== job.cut.sequence) {
    throw new ContentRebuildUnavailable('Content replay does not cover exact owner cut');
  }
  const control = async () => {
    const result = await readContentRebuildStep('verify: index control', () => env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:routingEpoch ?routing ; rv:sequence ?sequence ;
        rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    }`));
    const rows = result.results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || value(row!, 'epoch') !== env.lineage.dataEpoch
      || value(row!, 'routing') !== env.lineage.routingEpoch
      || !DECIMAL.test(value(row!, 'sequence') ?? '')
      || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(value(row!, 'generation') ?? '')) {
      throw new ContentRebuildUnavailable('graph rebuild control is unavailable');
    }
    return { sequence: value(row!, 'sequence')!, generation: value(row!, 'generation')! };
  };
  const before = await control();
  const probeResult = await readContentRebuildStep('verify: probe', () => env.fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
      ASK { ${textIndexProbePattern()} }`));
  if (probeResult.boolean !== true) throw new ContentRebuildUnavailable('rebuilt CJK index probe is absent');
  // The native audit compares graph-scoped identity and stored body/language,
  // including legal bodies for which the analyzer emits no tokens.
  const indexResult = await readContentRebuildStep('verify: inventory', () => env.fuseki.query(
    `PREFIX rv: <${RV}> SELECT (rv:publicTextInventory() AS ?population) WHERE {}`));
  const indexedPopulation = Number(indexResult.results?.bindings?.[0]?.population?.value);
  const declared = await readDeclaredPages(env);
  const heads = await readHeadPages(env, declared);
  const rdf = await readUnitPages(env);
  if ([declared.length, heads.length, rdf.length, indexedPopulation].some(size => size > MAX_REBUILD_UNITS)) {
    throw new ContentRebuildUnavailable('rebuild inventory exceeds fixed bound');
  }
  const declaredVariants = new Set(declared.map(row => value(row, 'variant')));
  if (declaredVariants.has(undefined) || declaredVariants.size !== declared.length
    || declaredVariants.size !== heads.length) {
    throw new ContentRebuildUnavailable('declared eligibility inventory differs from exact public heads');
  }
  const byVariant = new Map<string, typeof heads[number]>();
  for (const head of heads) {
    const variant = value(head, 'variant');
    if (!variant || !value(head, 'resource') || !value(head, 'decision')
      || !value(head, 'eligibility') || !value(head, 'revision') || !value(head, 'digest')
      || byVariant.has(variant)) throw new ContentRebuildUnavailable('eligible head inventory is ambiguous');
    byVariant.set(variant, head);
  }
  if ([...byVariant.keys()].some(variant => !declaredVariants.has(variant))) {
    throw new ContentRebuildUnavailable('public head is absent from eligibility inventory');
  }
  const rdfKeys = new Set<string>();
  const rdfUnits = new Set<string>();
  const contentUnits = new Map<string, typeof rdf[number]>();
  for (const unit of rdf) {
    const id = value(unit, 'unit');
    const body = value(unit, 'body');
    const language = unit.body?.['xml:lang'] ?? '';
    if (!id || body === undefined || !language || rdfUnits.has(id)
      || rdfKeys.has(textKey(id, body, language))) {
      throw new ContentRebuildUnavailable('RDF MatchUnit inventory is ambiguous');
    }
    rdfUnits.add(id);
    rdfKeys.add(textKey(id, body, language));
    const variant = value(unit, 'variant');
    if (variant) {
      if (!id.startsWith('urn:rezics:content:match-unit:') || contentUnits.has(variant)) {
        throw new ContentRebuildUnavailable('Content MatchUnit is duplicated or has foreign identity');
      }
      contentUnits.set(variant, unit);
    } else if (id.startsWith('urn:rezics:content:match-unit:')) {
      throw new ContentRebuildUnavailable('Content MatchUnit has incomplete provenance');
    }
  }
  if (!Number.isSafeInteger(indexedPopulation) || indexedPopulation !== rdfKeys.size) {
    throw new ContentRebuildUnavailable('Lucene membership differs from exact RDF MatchUnits');
  }
  if (contentUnits.size !== byVariant.size) {
    throw new ContentRebuildUnavailable('eligible Content publication has missing MatchUnit');
  }
  const expected = [...byVariant.entries()];
  for (let offset = 0; offset < expected.length; offset += SOURCE_READ_BATCH) {
    const batch = expected.slice(offset, offset + SOURCE_READ_BATCH);
    const ids = batch.map(([, head]) => {
      const revision = value(head, 'revision')!;
      if (!/^urn:rezics:content:revision:[0-9a-f-]{36}$/.test(revision)) {
        throw new ContentRebuildUnavailable('eligible Content revision identity is invalid');
      }
      return revision.slice('urn:rezics:content:revision:'.length);
    });
    if (new Set(ids).size !== ids.length) {
      throw new ContentRebuildUnavailable('multiple eligible variants share one Content revision');
    }
    const exact = await content.readExactBatch(ids, async requested => new Set(requested));
    for (let i = 0; i < batch.length; i++) {
      const [variant, head] = batch[i]!;
      const unit = contentUnits.get(variant);
      const body = exact[i];
      const recipe = body?.status === 'available' ? projectionRecipeFor(body.reference.model) : null;
      if (recipe?.kind === 'skip') {
        throw new ContentRebuildUnavailable('eligible Content model has no text projection');
      }
      const projected = recipe?.kind === 'text' && body?.status === 'available'
        ? extractProjectionText(recipe, body.body, body.reference) : null;
      if (!unit || body?.status !== 'available'
        || body.reference.variantId !== variant
        || body.reference.resourceId !== value(head, 'resource')
        || value(unit, 'resource') !== body.reference.resourceId
        || body.reference.byteDigest !== value(head, 'digest')
        || value(unit, 'revision') !== value(head, 'revision')
        || value(unit, 'decision') !== value(head, 'decision')
        || value(unit, 'eligibility') !== value(head, 'eligibility')
        || value(unit, 'body') !== projected?.text
        || unit.body?.['xml:lang']?.toLowerCase() !== projected?.language.toLowerCase()
) {
        throw new ContentRebuildUnavailable('Content MatchUnit differs from exact approved source');
      }
    }
  }
  const after = await control();
  const sourceAfter = await content.ownerPosition();
  if (after.sequence !== before.sequence || after.generation !== before.generation
    || sourceAfter.dataEpoch !== job.cut.dataEpoch || sourceAfter.sequence !== job.cut.sequence) {
    throw new ContentRebuildUnavailable('graph or Content owner moved during index verification');
  }
  return { sequence: before.sequence, generation: before.generation,
    unitCount: rdf.length, contentUnitCount: contentUnits.size };
}

/** The caller must have stopped Fuseki, run the pinned offline jena.textindexer
 * against this dataset volume, and restarted Fuseki before invoking this method. */
export async function activateRebuiltPublicContentSearch(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, job: ContentRebuildJob,
  publicConsumer: string, offlineIndexDigest: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(offlineIndexDigest)) {
    throw new ContentRebuildUnavailable('offline Lucene rebuild evidence digest is required');
  }
  const snapshot = await verifyQuarantinedContentIndex(env, content, cursor, job);
  crashSearchRebuild('before-activation');
  const nextGeneration = `urn:rezics:text-index-generation:${randomUUID()}`;
  await content.withOwnerPositionLock(job.cut, async () => {
    await command(env, 'activate', job.id,
      { family: 'content-rebuild-activate-v1', id: job.id, cut: job.cut,
        graphSequence: snapshot.sequence, priorGeneration: snapshot.generation,
        nextGeneration, offlineIndexDigest, unitCount: snapshot.unitCount }, {
        controlDeletion: `; rv:textIndexGeneration ${iri(snapshot.generation)}`,
        controlInsertion: `; rv:textIndexGeneration ${iri(nextGeneration)}`,
        insertion: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }`,
        condition: `FILTER(?n = ${snapshot.sequence})
          GRAPH ${iri(GRAPHS.control)} {
            ${iri(DATASET)} rv:textIndexGeneration ${iri(snapshot.generation)} . }
          GRAPH ${iri(GRAPHS.receipts)} {
            ${iri(receipt('quarantine', job.id))} rv:ownerDataEpoch ${lit(job.cut.dataEpoch)} ;
              rv:ownerSequence ${lit(job.cut.sequence)} .
            ${iri(receipt('cleared', job.id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded . }
          FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`,
        receiptFacts: `; rv:ownerDataEpoch ${lit(job.cut.dataEpoch)} ;
          rv:ownerSequence ${job.cut.sequence} ;
          rv:priorIndexGeneration ${iri(snapshot.generation)} ;
          rv:textIndexGeneration ${iri(nextGeneration)} ;
          rv:indexRebuildDigest ${lit(offlineIndexDigest)}`,
      });
  });
  await cursor.adoptRebuildCheckpoint(publicConsumer, job.consumer, job.cut);
  return nextGeneration;
}
