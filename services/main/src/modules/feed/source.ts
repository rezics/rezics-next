import type { Pool } from 'pg';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { publicWork, unerased, WorkReadMissing, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { noteUnboundSourceWorks } from '../source/author-name-read.ts';
import { FEED_COST, type FeedKind } from './contract.ts';
import { reviewTarget } from '../review/read.ts';
import type { ReviewRow } from '../review/store.ts';
import { GLOBAL_RATING_POPULATION_OWNER, GLOBAL_RATING_POPULATION } from '../rating/global.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE } from '../rating/context.ts';
import { resolveTargets } from '../target/resolve.ts';
import { compareRelayPositions, MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../outbox/relay-position.ts';

export interface FeedSource { id: string; sequence: string; kind: FeedKind; target: string;
  work: string | null; actor: string; realm: string | null; zone: string | null;
  language: string | null; excerpt: string | null; title: string | null;
  occurrence: string | null; contentTarget: string | null; reply: string | null; contentRevision: string | null; review: string | null;
  readerReview?: ReviewRow;
  /** Request-local exact bytes already admitted for a published card. */
  publishedContent?: Extract<import('../../../../content/src/core.ts').ExactReadResult,{ status: 'available' }> }
export interface FeedReferenceCut { after: RelayHandoffPosition; through: RelayHandoffPosition; afterId: string }
/** `sequence` is the Main stream position persisted with a Feed item. */
export interface FeedReference { id: string; sequence: string; kind: FeedKind; work?: string | null;
  realm?: string | null; target?: string; actor?: string; occurrence?: string;
  contentRevision?: string; groupKind?: 'chapter' | 'hub' }

export const reviewActivityId = (review: string) => `https://rezics.com/id/${review}`;

/** Review events are Access references. Recheck the current public review and
 * Work on each read; an edit, deletion or restriction cannot expose a stale card. */
export async function feedReviewSources(session: WorkReadSession, ids: readonly string[]): Promise<FeedSource[]> {
  if (ids.length > FEED_COST.refreshItems) throw new WorkReadUnavailable('Review source budget exceeded');
  if (!ids.length) return [];
  if (!session.deps.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
  const reviews = session.deps.reviews;
  const rows = await reviews.byIds(ids.map(id => id.slice('https://rezics.com/id/'.length)),null);
  const native = rows.filter(row => row.main_version !== null);
  const requested = [...new Set(native.map(row => row.work))];
  const resolved = native.length ? await resolveTargets(session,requested,'review') : [];
  const canonical = new Map(resolved.map((target,index) => [requested[index]!,target.resource]));
  // Same Work/Context proof as reviewTarget, across the whole reference set.
  const targets = native.length ? await session.query(`SELECT DISTINCT ?review ?main ?realm WHERE {
    VALUES (?review ?work ?context) { ${native.map(row => `(${iri(`https://rezics.com/id/${row.id}`)} ${iri(row.work)} ${iri(row.context)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main a rv:MainVersion ; rv:work ?work . }
    ${publicWork('?work','?main')}
    { GRAPH ${iri(GRAPHS.current)} { ?context a rv:GlobalRatingContext ; rv:contextState rv:Active ;
        rv:targetGrain rv:MainVersion ; rv:ratingScaleMin ?scaleMin ; rv:ratingScaleMax ?scaleMax ;
        rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ; rv:ratingPopulationPolicy ${iri(GLOBAL_RATING_POPULATION)} ;
        rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} . } }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:ratingContext ?context .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?context a rv:RatingContext ; rv:contextState rv:Active ; rv:realm ?realm ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin ?scaleMin ; rv:ratingScaleMax ?scaleMax ;
        rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private } FILTER NOT EXISTS { ?realm rv:protectionHead ?protection }
      FILTER NOT EXISTS { ?context rv:protectionHead ?contextProtection } } }
  } LIMIT ${native.length + 1}`,native.length) : [];
  const result = await Promise.all(ids.map(async (id): Promise<FeedSource | null> => {
    const review = id.slice('https://rezics.com/id/'.length);
    const row = rows.find(row => row.id === review);
    if (!row || !row.body.trim()) return null;
    if (row.main_version !== null && canonical.get(row.work) !== row.work) return null;
    let target: Awaited<ReturnType<typeof reviewTarget>>;
    try { target = row.main_version !== null ? (() => {
      const value = targets.find(value => value.review?.value === id);
      if (!value?.main) throw new WorkReadMissing('Review target unavailable');
      return { mainVersion: value.main.value,realm: value.realm?.value ?? null,generic: false };
    })() : await reviewTarget(session, row.context, row.work); }
    catch (error) { if (error instanceof WorkReadMissing) return null; throw error; }
    if (target.mainVersion !== row.main_version || target.realm !== row.realm) return null;
    return { id, sequence: '0', kind: 'review', target: row.work, work: row.work,
      actor: row.acting_subject, realm: row.realm, zone: null, language: row.language,
      excerpt: row.spoiler ? null : row.body.slice(0, 400), title: null,
      occurrence: null, contentTarget: null, reply: null, contentRevision: null,
      review: null, readerReview: row };
  }));
  return result.filter((source): source is FeedSource => !!source);
}

interface GraphSourcePosition { dataEpoch: string; sequence: string }
interface DeliveredReferencePosition {
  graph_sequence: string;
  stream_sequence: string;
}

const GRAPH_CUT_REPAIR = 'repair with task main:relay -- --repair-graph-cuts --data-epoch <epoch> or task main:relay -- --repair-graph-cut --data-epoch <epoch> --sequence <sequence>';
const GRAPH_CUT_UNAVAILABLE = `Main feed graph reference cut is unavailable; ${GRAPH_CUT_REPAIR}`;

function requireSequence(value: string | undefined): string {
  if (!value || !/^(0|[1-9][0-9]{0,99})$/.test(value))
    throw new WorkReadUnavailable('Feed source position is unavailable');
  return value;
}

/** Every retained header carries the graph cut, including empty batches.
 * Event members must still prove the same binding before the cut is usable. */
async function graphPositionAtRelay(relay: Pick<Pool, 'query'>, position: RelayHandoffPosition): Promise<GraphSourcePosition> {
  if (position.streamScope !== MAIN_RELAY_STREAM_SCOPE) throw new WorkReadUnavailable('Main feed stream position is unavailable');
  if (position.sequence === '0') return { dataEpoch: position.dataEpoch, sequence: '0' };
  const rows = (await relay.query<{
    graph_sequence: string | null; event_count: number; actual_count: string; ordinal_count: string; envelopes_match: boolean;
  }>(`SELECT batch.graph_sequence::text, batch.event_count,
      members.actual_count, members.ordinal_count, members.envelopes_match
    FROM relay.delivered_batch AS batch CROSS JOIN LATERAL (
      SELECT count(*)::text AS actual_count,
        count(DISTINCT envelope #>> '{data,ordinal}')::text AS ordinal_count,
        COALESCE(bool_and(COALESCE(
          envelope #>> '{data,batchId}' = batch.batch_id
          AND envelope #>> '{data,routingEpoch}' = batch.routing_epoch
          AND envelope #>> '{data,sourcePosition,datasetId}' = 'product'
          AND envelope #>> '{data,sourcePosition,dataEpoch}' = batch.data_epoch
          AND envelope #>> '{data,sourcePosition,sequence}' = batch.graph_sequence::text
          AND CASE WHEN NOT (envelope->'data' ? 'relayPosition') THEN
            envelope #>> '{data,sourcePosition,sequence}' = batch.sequence::text
          ELSE envelope #>> '{data,relayPosition,streamScope}' = batch.stream_scope
          AND envelope #>> '{data,relayPosition,dataEpoch}' = batch.data_epoch
          AND envelope #>> '{data,relayPosition,sequence}' = batch.sequence::text END
          AND CASE WHEN envelope #>> '{data,ordinal}' ~ '^(0|[1-9][0-9]?)$'
            THEN (envelope #>> '{data,ordinal}')::integer < batch.event_count ELSE false END,
          false)), true) AS envelopes_match
      FROM relay.delivered_event AS event
      WHERE event.stream_scope = batch.stream_scope AND event.data_epoch = batch.data_epoch AND event.sequence = batch.sequence
    ) AS members
    WHERE batch.stream_scope = $1 AND batch.data_epoch = $2 AND batch.sequence = $3::numeric`,
  [position.streamScope, position.dataEpoch, position.sequence])).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    throw new WorkReadUnavailable(GRAPH_CUT_UNAVAILABLE);
  }
  if (row.graph_sequence === null) throw new WorkReadUnavailable(GRAPH_CUT_UNAVAILABLE);
  if (row.actual_count !== String(row.event_count) || row.ordinal_count !== String(row.event_count)
    || !row.envelopes_match || BigInt(requireSequence(row.graph_sequence)) <= 0n) {
    throw new WorkReadUnavailable('Main feed graph reference cut is unavailable');
  }
  return { dataEpoch: position.dataEpoch, sequence: row.graph_sequence };
}

async function graphPositionAtReference(session: WorkReadSession, epoch: string, id: string): Promise<GraphSourcePosition> {
  const rows = await session.query(`SELECT DISTINCT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(id)} rv:dataEpoch ${lit(epoch)} ; rv:sequence ?sequence }
  } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.sequence) throw new WorkReadUnavailable('Feed reference cursor is unavailable');
  return { dataEpoch: epoch, sequence: requireSequence(rows[0].sequence.value) };
}

async function mainSequencesForGraphReferences(relay: Pick<Pool, 'query'>, epoch: string,
  through: RelayHandoffPosition, sequences: readonly string[]): Promise<Map<string, string>> {
  if (!sequences.length) return new Map();
  // One indexed probe per distinct requested graph position (at most the feed
  // page bound); two headers suffice to prove ambiguity, including beyond through.
  const requested = [...new Set(sequences.map(requireSequence))];
  const rows = (await relay.query<DeliveredReferencePosition>(`SELECT position.graph_sequence::text AS graph_sequence,
      position.stream_sequence FROM unnest($3::numeric[]) AS requested(graph_sequence)
    CROSS JOIN LATERAL (SELECT graph_sequence, sequence::text AS stream_sequence FROM relay.delivered_batch
    WHERE stream_scope = $1 AND data_epoch = $2
      AND graph_sequence = requested.graph_sequence LIMIT 2) AS position`,
  [MAIN_RELAY_STREAM_SCOPE, epoch, requested])).rows;
  const result = new Map<string, string>();
  for (const row of rows) {
    const graphSequence = requireSequence(row.graph_sequence);
    const streamSequence = requireSequence(row.stream_sequence);
    const previous = result.get(graphSequence);
    if (previous !== undefined && previous !== streamSequence)
      throw new WorkReadUnavailable('Ambiguous feed reference relay position');
    result.set(graphSequence, streamSequence);
  }
  for (const sequence of result.values()) {
    if (compareRelayPositions({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: epoch, sequence }, through) > 0)
      throw new WorkReadUnavailable('Feed reference relay position is unavailable');
  }
  if (sequences.some(sequence => !result.has(sequence)))
    throw new WorkReadUnavailable(`Feed reference relay position is unavailable; ${GRAPH_CUT_REPAIR}`);
  return result;
}

/** Ingestion retains only opaque references, including currently hidden ones.
 * Otherwise a later disclosure/review change could never reveal an older
 * activity. Hydration below is always the independent current public gate. */
export async function feedReferences(session: WorkReadSession, relay: Pick<Pool, 'query'>,
  cut: FeedReferenceCut): Promise<FeedReference[]> {
  const after = cut.after;
  const through = cut.through;
  try {
    if (after.streamScope !== MAIN_RELAY_STREAM_SCOPE || after.dataEpoch !== session.position.dataEpoch)
      throw new Error('feed cursor position changed');
    compareRelayPositions(after, through);
  } catch (error) {
    throw new WorkReadUnavailable('Main feed stream position is unavailable', { cause: error });
  }
  const afterRelayGraph = await graphPositionAtRelay(relay, after);
  const afterGraph = cut.afterId && cut.afterId !== '\uffff'
    ? await graphPositionAtReference(session, session.position.dataEpoch, cut.afterId)
    : afterRelayGraph;
  const throughGraph = compareRelayPositions(after, through) === 0
    ? afterRelayGraph : await graphPositionAtRelay(relay, through);
  if (afterGraph.dataEpoch !== session.position.dataEpoch || throughGraph.dataEpoch !== session.position.dataEpoch
    || BigInt(afterGraph.sequence) > BigInt(throughGraph.sequence)
    || BigInt(throughGraph.sequence) > BigInt(requireSequence(session.position.sequence))) {
    throw new WorkReadUnavailable('Feed graph reference cut is unavailable');
  }
  if (cut.afterId && cut.afterId !== '\uffff') {
    if (afterRelayGraph.sequence !== afterGraph.sequence) throw new WorkReadUnavailable('Feed reference cursor moved');
  } else if (cut.afterId === '' && after.sequence !== '0') {
    throw new WorkReadUnavailable('Feed reference cursor is unavailable');
  }
  const rows = await session.query(`SELECT DISTINCT ?id ?sequence ?kind WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ?id rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence ; a ?type .
      VALUES (?type ?kind) { (rv:PublicationSelection "work") (rv:StatementDecision "decision")
        (rv:RealmReplyPlacement "reply") (rv:CollectionRevision "collection") (rv:ContentSearchEligibilityDecision "contribution") }
      FILTER(?sequence <= ${throughGraph.sequence})
      FILTER(?sequence > ${afterGraph.sequence} || (?sequence = ${afterGraph.sequence} && STR(?id) > ${lit(cut.afterId)}))
    } } ORDER BY ?sequence STR(?id) LIMIT ${FEED_COST.refreshItems + 1}`, FEED_COST.refreshItems + 1);
  if (rows.some(row => !row.id || !row.sequence || !row.kind)
    || new Set(rows.map(row => row.id!.value)).size !== rows.length) throw new WorkReadUnavailable('Ambiguous feed reference');
  const graphSequences = rows.map(row => requireSequence(row.sequence!.value));
  const streamSequences = await mainSequencesForGraphReferences(relay, session.position.dataEpoch, through, graphSequences);
  let previous = after;
  const references = rows.map((row, index) => {
    const streamSequence = streamSequences.get(graphSequences[index]!)!;
    const position = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: session.position.dataEpoch, sequence: streamSequence };
    const order = compareRelayPositions(previous, position);
    if (order > 0 || (index === 0 && (cut.afterId === '' || cut.afterId === '\uffff') && order === 0))
      throw new WorkReadUnavailable('Feed reference stream order is unavailable');
    previous = position;
    return { id: row.id!.value, sequence: streamSequence, kind: row.kind!.value as FeedKind };
  });
  return references;
}

const canonicalWork = publicWork('?otherWork', '?otherMain').replace(/\?([A-Za-z]\w*)/g,
  (_, name: string) => ['otherWork', 'otherMain'].includes(name) ? `?${name}` : `?canonical${name}`);
const publicRealm = `GRAPH ${iri(GRAPHS.current)} {
  ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
  ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
  FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
  FILTER NOT EXISTS { ?realm rv:protectionHead ?realmProtection }
  OPTIONAL { ?space rv:zoneCapability ?zone . ?zone a rv:Zone ; rv:zoneState rv:Active .
    FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection } }
}`;

/** Re-admit exact activity references against current public publication,
 * Realm and review heads. A changed Main selection can retain an earlier
 * publication's activity; replacing/erasing that publication cannot. */
export async function feedSources(session: WorkReadSession, selection: { ids: string[] }): Promise<FeedSource[]> {
  if (selection.ids.length === 0) return [];
  const limit = selection.ids.length;
  if (limit > 20) throw new WorkReadUnavailable('Feed source budget exceeded');
  // Each UNION branch starts from the admitted references. Jena evaluates a
  // branch before joining it, so a selection outside the UNION would scan every
  // branch's whole relation (about 1 s per call at 10,000 Works).
  const anchor = `VALUES ?id { ${selection.ids.map(iri).join(' ')} }`;
  const rows = await session.query(`SELECT DISTINCT ?id ?sequence ?kind ?target ?work ?actor ?realm ?zone
    ?language ?excerpt ?title ?reply ?contentRevision ?review ?occurrence ?contentTarget WHERE {
    {
      ${anchor}
      GRAPH ${iri(GRAPHS.revisions)} {
        ?id a rv:PublicationSelection ; rv:context ?main ; rv:work ?work ; rv:contribution ?contribution ;
          rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language ;
          rv:selectionBasis rv:MainMaintainer ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?decision rv:disclosure rv:Public ; rv:selectedDraft ?draft .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision }
        BIND(EXISTS { ?id rv:predecessor ?previous } AS ?successor) }
      GRAPH ${iri(GRAPHS.current)} {
        ?main a rv:MainVersion ; rv:work ?work .
        ?contribution a rv:TextContribution ; rv:work ?work ; rv:author ?actor ; rv:publicationHead ?decision . }
      ${publicWork('?work', '?main')}
      BIND(IF(?successor, "contribution", "work") AS ?kind)
      BIND(IF(?successor, ?contribution, ?work) AS ?target)
      OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:selection ?id ; rv:revision ?draft ; rv:searchBody ?body }
        BIND(SUBSTR(STR(?body),1,400) AS ?excerpt) }
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:realm ?realm ;
        rv:work ?work ; rv:selectionHead ?id .
        ?contribution a rv:TextContribution ; rv:work ?work ; rv:publicationHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:PublicationSelection ; rv:context ?realm ; rv:work ?work ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft ;
        rv:reviewer ?actor ; rv:language ?language ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?decision rv:disclosure rv:Public ; rv:selectedDraft ?draft .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicRealm} ${publicWork('?work', '?main')}
      BIND("adoption" AS ?kind) BIND(?work AS ?target)
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.current)} {
        ?decisionSlot a rv:DecisionSlot ; rv:decisionHead ?id ; rv:acceptanceContext ?context ;
          rv:targetKind ?targetKind ; rv:decisionTarget ?decisionTarget .
        ?context a rv:ClassificationContext ; rv:realm ?realm ; rv:contextState rv:Active .
        ?statement a rdf:Statement ; rv:statementState rv:Active ; rdf:subject ?main ; rv:meaningKey ?key .
        ?main rv:work ?work .
        FILTER(?targetKind = rv:StatementTarget && ?decisionTarget = ?statement
          || ?targetKind = rv:QualifiedFactTarget && ?decisionTarget = ?key)
        FILTER NOT EXISTS { ?statement rv:semanticContextRevision ?pin .
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?pin rv:component ?ctx }
            ?ctx rv:disclosure rv:Public } }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:StatementDecision ; rv:component ?decisionSlot ;
        rv:decidedBy ?actor ; rv:outcome ?outcome ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER(?outcome IN (rv:Accepted, rv:Rejected))
        FILTER(?targetKind = rv:StatementTarget || EXISTS { ?id rv:support ?statement }) }
      ${publicRealm} ${publicWork('?work', '?main')}
      BIND("decision" AS ?kind) BIND(?work AS ?target)
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ?realm ;
        rv:rootTarget ?work ; rv:reply ?reply ; rv:replyPlacementHead ?id . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:rootTarget ?work ; rv:realm ?realm ;
        rv:reply ?reply ; rv:author ?actor ; rv:contentRevision ?contentRevision ; rv:reviewDecision ?review ;
        rv:placementOutcome rv:Accepted ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        BIND(EXISTS { ?id rv:parentReply ?parent } AS ?isReply) }
      ${publicRealm} ${publicWork('?work', '?main')}
      BIND(IF(?isReply, "reply", "discussion") AS ?kind) BIND(?reply AS ?target)
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:ContentSearchEligibilityDecision ;
        rv:publicationDecision ?contentPublication ; rv:disclosure rv:Public ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?contentPublication a rv:ContentPublicationDecision ; rv:component ?variant ;
        rv:resource ?contentTarget ; rv:contentRevision ?contentRevision ; rv:contentLanguage ?language .
        FILTER NOT EXISTS { ?contentRevision a rv:ErasedRevision } }
      GRAPH ${iri(GRAPHS.current)} { ?variant rv:resource ?contentTarget ; rv:contentPublicationHead ?contentPublication ;
          rv:publicSearchEligibilityHead ?id .
        ?structure a rv:Structure ; rv:structureProfile rv:BookComposition ; rv:structureOf ?main ;
          rv:selectedGeneration ?generation .
        ?main a rv:MainVersion ; rv:work ?work .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?contentTarget .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
        FILTER NOT EXISTS { ?placement rv:selectionMode rv:FixedRevision ; rv:pinnedRevision ?pinned .
          FILTER(?pinned != ?contentRevision) } }
      ${publicWork('?work', '?main')} ${unerased('?contentTarget')}
      # One public placement represents a reused Content publication. Choose
      # by Work/occurrence identity, so repeated placements cannot break a page.
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?otherStructure a rv:Structure ; rv:structureProfile rv:BookComposition ; rv:structureOf ?otherMain ;
          rv:selectedGeneration ?otherGeneration . ?otherMain rv:work ?otherWork .
        ?otherPlacement a rv:OccurrencePlacement ; rv:generation ?otherGeneration ; rv:occurrence ?otherOccurrence ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?contentTarget .
        FILTER NOT EXISTS { ?otherPlacement rv:removedBy ?otherRemoved }
        FILTER NOT EXISTS { ?otherPlacement rv:selectionMode rv:FixedRevision ; rv:pinnedRevision ?otherPinned .
          FILTER(?otherPinned != ?contentRevision) }
        FILTER(CONCAT(STR(?otherWork), STR(?otherOccurrence)) < CONCAT(STR(?work), STR(?occurrence)))
      } ${canonicalWork} }
      BIND("contribution" AS ?kind) BIND(?contentTarget AS ?target)
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:ContentSearchEligibilityDecision ;
        rv:publicationDecision ?contentPublication ; rv:disclosure rv:Public ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?contentPublication a rv:ContentPublicationDecision ; rv:component ?variant ; rv:resource ?work ;
          rv:contentRevision ?contentRevision ; rv:contentLanguage ?language .
        FILTER NOT EXISTS { ?contentRevision a rv:ErasedRevision } }
      GRAPH ${iri(GRAPHS.current)} { ?variant rv:resource ?work ; rv:contentPublicationHead ?contentPublication ;
          rv:publicSearchEligibilityHead ?id .
        ?work a ?hubKind . VALUES ?hubKind { rv:PromptTemplate rv:SkillPackage } }
      ${publicWork('?work', '?main')}
      BIND(?work AS ?contentTarget) BIND(?work AS ?target) BIND("contribution" AS ?kind)
    } UNION {
      ${anchor}
      GRAPH ${iri(GRAPHS.current)} { ?target a rv:Collection ; rv:collectionHead ?id ; rv:curator ?actor ;
        rv:disclosure rv:Public ; rv:collectionState rv:Active ; rv:structure ?structure ; schema:name ?title .
        FILTER NOT EXISTS { ?target rv:disclosure rv:Private }
        FILTER NOT EXISTS { ?target rv:protectionHead ?collectionProtection } }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:CollectionRevision ; rv:component ?target ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      BIND("collection" AS ?kind)
    }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:ErasedRevision } }
  } ORDER BY ?sequence STR(?id) LIMIT ${limit + 1}`, limit + 1);
  if ('ids' in selection && rows.length > limit) throw new WorkReadUnavailable('Feed source is ambiguous');
  const required = (row: ReadRow, name: string) => {
    if (!row[name]) throw new WorkReadUnavailable('Feed source is incomplete');
    return row[name]!.value;
  };
  if (new Set(rows.map(row => row.id?.value)).size !== rows.length) throw new WorkReadUnavailable('Feed source is ambiguous');
  const revisionOf = (row: ReadRow) => row.contentRevision!.value.slice('urn:rezics:content:revision:'.length);
  const published = rows.filter(row => row.contentTarget);
  if (published.some(row => !row.contentRevision) || published.length && !session.deps.content) {
    throw new WorkReadUnavailable('Published Content owner unavailable');
  }
  // Four 1 MiB bodies fit Content's 4 MiB batch. The page's eight references
  // therefore use at most two exact owner reads, not one per card.
  const revisions = [...new Set(published.map(revisionOf))];
  const workIds = rows.flatMap(row => row.kind?.value === 'work' && row.work ? [row.work.value] : []);
  const [sourceBound, exacts] = await Promise.all([
    session.deps.sourceAdoptions?.boundWorks(workIds) ?? new Set<string>(),
    Promise.all(Array.from({ length: Math.ceil(revisions.length / 4) }, (_, batch) =>
      session.deps.content!.readExactBatch(revisions.slice(batch * 4, batch * 4 + 4), async ids => new Set(ids))))
      .then(batches => batches.flat())]);
  noteUnboundSourceWorks(session, workIds.filter(work => !sourceBound.has(work)));
  const exactById = new Map(revisions.map((id, index) => [id, exacts[index]]));
  const mapped: FeedSource[] = [];
  for (const row of rows) {
    let actor = row.actor?.value;
    let excerpt: string | null = row.excerpt?.value ?? null;
    if (row.contentTarget) {
      const exact = exactById.get(revisionOf(row));
      if (!exact || ['missing', 'erased', 'denied'].includes(exact.status)) continue;
      if (exact.status !== 'available' || exact.reference.resourceId !== row.contentTarget?.value) {
        throw new WorkReadUnavailable('Published Content differs');
      }
      const author = exact.reference.provenance.author;
      if (exact.reference.provenance.kind !== 'admitted-original-contribution-v1'
        || typeof author !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(author)) continue;
      actor = author; excerpt = typeof exact.body.body === 'string' ? exact.body.body.slice(0, 400) : null;
    }
    if (!actor) throw new WorkReadUnavailable('Feed actor unavailable');
    mapped.push({ id: required(row, 'id'), sequence: required(row, 'sequence'),
    kind: required(row, 'kind') === 'work' && row.work && sourceBound.has(row.work.value)
      ? 'added' : required(row, 'kind') as FeedKind, target: required(row, 'target'), actor,
    work: row.work?.value ?? null, realm: row.realm?.value ?? null, zone: row.zone?.value ?? null,
    language: row.language?.value ?? null, excerpt, title: row.title?.value ?? null,
    occurrence: row.occurrence?.value ?? null, contentTarget: row.contentTarget?.value ?? null, reply: row.reply?.value ?? null, contentRevision: row.contentRevision?.value ?? null, review: row.review?.value ?? null,
    ...(row.contentTarget && exactById.get(revisionOf(row))?.status === 'available'
      ? { publishedContent: exactById.get(revisionOf(row)) as Extract<import('../../../../content/src/core.ts').ExactReadResult,{ status: 'available' }> } : {}) });
  }
  return mapped;
}
