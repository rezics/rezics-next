import { randomUUID } from 'node:crypto';
import type { ContentCore, ContentPosition } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, TEXT_INDEX_PROBE,
  TEXT_INDEX_PROBE_BODY, TEXT_INDEX_PROBE_GRAPH, TEXT_INDEX_PROFILE, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { relayContentProjectionOnce } from './relay.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CLEAR_BATCH = 64;
const MAX_CLEAR_BATCHES = 2_000;
const MAX_REPLAY_EVENTS = 100_000;
const MAX_REBUILD_UNITS = 50_000;

export class ContentRebuildUnavailable extends Error {}

export interface ContentRebuildJob {
  id: string;
  cut: ContentPosition;
  consumer: string;
}

type Phase = 'quarantine' | 'clear' | 'cleared' | 'activate';

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
    receiptFacts?: string; controlDeletion?: string; controlInsertion?: string }): Promise<void> {
  const operation = receipt(phase, identity);
  const digest = hash(JSON.stringify(digestInput));
  const batch = `urn:rezics:outbox:${hash(`${operation}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${operation}\0event`)}`;
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
  const result = await env.fuseki.commandWithReceipt({ receipt: operation, digest,
    update, validations: [], deadlineMs: 10_000 });
  if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
    throw new ContentRebuildUnavailable(`Content rebuild ${phase} command ${result.status}`);
  }
}

async function readQuarantine(env: WorkActivationEnvironment, id: string): Promise<ContentPosition | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?sourceEpoch ?sourceSequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt('quarantine', id))} a rv:OperationReceipt ;
      rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
      rv:ownerDataEpoch ?sourceEpoch ; rv:ownerSequence ?sourceSequence . }
  }`);
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

async function isReceiptCommitted(env: WorkActivationEnvironment, phase: Phase, id: string): Promise<boolean> {
  const answer = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt(phase, id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} . } }`);
  return answer.boolean === true;
}

/** Complete a committed activation whose process died before SQL checkpoint promotion. */
export async function resumeActivatedContentRebuild(env: WorkActivationEnvironment,
  cursor: ContentProjectionCursor, id: string, publicConsumer: string): Promise<string | null> {
  rebuildId(id);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sourceEpoch
    ?sourceSequence ?generation WHERE { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt('activate', id))} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ?epoch ; rv:ownerDataEpoch ?sourceEpoch ;
      rv:ownerSequence ?sourceSequence ; rv:textIndexGeneration ?generation . } }`);
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
  const confirmed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:textIndexGeneration ${iri(generation)} . }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
  }`);
  if (confirmed.boolean !== true) throw new ContentRebuildUnavailable('activated index control differs from receipt');
  await cursor.adoptRebuildCheckpoint(publicConsumer, `content-rebuild.${id}`,
    { owner: 'content', dataEpoch: value(row!, 'sourceEpoch')!, sequence: value(row!, 'sourceSequence')! });
  return generation;
}

async function assertQuarantined(env: WorkActivationEnvironment): Promise<void> {
  const answer = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`);
  if (answer.boolean !== false) throw new ContentRebuildUnavailable('public search is not quarantined');
}

/** Persistently remove the public-search anchor before any replacement work. */
export async function quarantinePublicContentSearch(env: WorkActivationEnvironment,
  content: ContentCore, id: string): Promise<ContentRebuildJob> {
  rebuildId(id);
  const consumer = `content-rebuild.${id}`;
  let cut = await readQuarantine(env, id);
  if (!cut) {
    cut = await content.ownerPosition();
    sourceCut(cut);
    await command(env, 'quarantine', id, { family: 'content-rebuild-quarantine-v1', id, cut }, {
      deletion: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }`,
      condition: `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }`,
      receiptFacts: `; rv:ownerDataEpoch ${lit(cut.dataEpoch)} ; rv:ownerSequence ${lit(cut.sequence)}`,
    });
    cut = await readQuarantine(env, id);
    if (!cut) throw new ContentRebuildUnavailable('quarantine receipt is absent');
  }
  await assertQuarantined(env);
  return { id, cut, consumer };
}

async function listContentUnits(env: WorkActivationEnvironment): Promise<string[]> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?unit WHERE {
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:projection ?projection .
      FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
        && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) }
  } LIMIT ${CLEAR_BATCH}`);
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
  if (await isReceiptCommitted(env, 'cleared', job.id)) return 0;
  let removed = 0;
  for (let batch = 0; batch < MAX_CLEAR_BATCHES; batch++) {
    const units = await listContentUnits(env);
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

/** Replays the retained source cut into fresh, job-scoped receipt/unit identities. */
export async function replayQuarantinedContentCut(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, job: ContentRebuildJob): Promise<number> {
  await assertQuarantined(env);
  if (!await isReceiptCommitted(env, 'cleared', job.id)) {
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

/** Compare the whole bounded RDF projection, current public heads, exact Content bytes,
 * and the restarted Lucene reader. Outbox replay alone cannot certify this inventory. */
export async function verifyQuarantinedContentIndex(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, job: ContentRebuildJob): Promise<RebuildGraphSnapshot> {
  await assertQuarantined(env);
  if (!await isReceiptCommitted(env, 'cleared', job.id)) {
    throw new ContentRebuildUnavailable('Content cleanup receipt is absent');
  }
  const [owner, replay] = await Promise.all([content.ownerPosition(), cursor.read(job.consumer)]);
  if (owner.dataEpoch !== job.cut.dataEpoch || owner.sequence !== job.cut.sequence
    || replay.dataEpoch !== job.cut.dataEpoch || replay.sequence !== job.cut.sequence) {
    throw new ContentRebuildUnavailable('Content replay does not cover exact owner cut');
  }
  const control = async () => {
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:routingEpoch ?routing ; rv:sequence ?sequence ;
        rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    }`);
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
  const [declaredResult, headsResult, rdfResult, indexResult, probeResult] = await Promise.all([
    env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?variant WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
        rv:publicSearchEligibilityHead ?eligibility . }
    } LIMIT ${MAX_REBUILD_UNITS + 1}`),
    env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?variant ?resource ?decision ?eligibility
      ?revision ?digest WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?resource ;
        rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
      GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
        rv:variant ?variant ; rv:resource ?resource ; rv:publicationDecision ?decision ;
        rv:disclosure rv:Public .
        ?decision a rv:ContentPublicationDecision ; rv:contentRevision ?revision ;
          rv:byteDigest ?digest . }
    } LIMIT ${MAX_REBUILD_UNITS + 1}`),
    env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?body ?variant ?revision
      ?decision ?eligibility WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit a rv:MatchUnit .
      OPTIONAL { ?unit rv:searchBody ?body . }
      OPTIONAL { ?unit rv:projection ?projection ; rv:variant ?variant ;
        rv:revision ?revision ; rv:publicationDecision ?decision ;
        rv:eligibility ?eligibility . }
    } } LIMIT ${MAX_REBUILD_UNITS + 1}`),
    env.fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
      SELECT ?unit ?literal ?graph WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      (?unit ?score ?literal ?graph) text:query (rv:searchBody "body:*" ${MAX_REBUILD_UNITS + 1}) .
    } }`),
    env.fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
      ASK { GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
      ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh .
      (${iri(TEXT_INDEX_PROBE)} ?score ?literal ?graph)
        text:query (rv:searchBody ${lit('"中文检索"')} 2) .
      FILTER(?literal = ${lit(TEXT_INDEX_PROBE_BODY)}@zh
        && ?graph = ${iri(TEXT_INDEX_PROBE_GRAPH)}) } }`),
  ]);
  if (probeResult.boolean !== true) throw new ContentRebuildUnavailable('rebuilt CJK index probe is absent');
  const declared = declaredResult.results?.bindings ?? [];
  const heads = headsResult.results?.bindings ?? [];
  const rdf = rdfResult.results?.bindings ?? [];
  const indexed = indexResult.results?.bindings ?? [];
  if ([declared.length, heads.length, rdf.length, indexed.length].some(size => size > MAX_REBUILD_UNITS)) {
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
  const indexKeys = new Set<string>();
  for (const entry of indexed) {
    const unit = value(entry, 'unit');
    const literal = value(entry, 'literal');
    const language = entry.literal?.['xml:lang'] ?? '';
    if (!unit || literal === undefined || !language
      || value(entry, 'graph') !== PUBLIC_SEARCH_GRAPH) {
      throw new ContentRebuildUnavailable('Lucene indexed unit is incomplete or in another graph');
    }
    const key = textKey(unit, literal, language);
    if (indexKeys.has(key)) throw new ContentRebuildUnavailable('Lucene has duplicate units');
    indexKeys.add(key);
  }
  if (indexKeys.size !== rdfKeys.size || [...rdfKeys].some(key => !indexKeys.has(key))) {
    throw new ContentRebuildUnavailable('Lucene membership differs from exact RDF MatchUnits');
  }
  if (contentUnits.size !== byVariant.size) {
    throw new ContentRebuildUnavailable('eligible Content publication has missing MatchUnit');
  }
  const expected = [...byVariant.entries()];
  for (let offset = 0; offset < expected.length; offset += CLEAR_BATCH) {
    const batch = expected.slice(offset, offset + CLEAR_BATCH);
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
      if (!unit || body?.status !== 'available'
        || body.reference.variantId !== variant
        || body.reference.resourceId !== value(head, 'resource')
        || body.reference.byteDigest !== value(head, 'digest')
        || value(unit, 'revision') !== value(head, 'revision')
        || value(unit, 'decision') !== value(head, 'decision')
        || value(unit, 'eligibility') !== value(head, 'eligibility')
        || value(unit, 'body') !== body.body.body
        || unit.body?.['xml:lang'] !== (body.reference.language.kind === 'tag'
          ? body.reference.language.tag : undefined)) {
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
          rv:ownerSequence ${lit(job.cut.sequence)} ;
          rv:priorIndexGeneration ${iri(snapshot.generation)} ;
          rv:textIndexGeneration ${iri(nextGeneration)} ;
          rv:indexRebuildDigest ${lit(offlineIndexDigest)}`,
      });
  });
  await cursor.adoptRebuildCheckpoint(publicConsumer, job.consumer, job.cut);
  return nextGeneration;
}
