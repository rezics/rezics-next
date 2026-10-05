import { postBookPlacement } from '../post/patterns.ts';
import { fallbackLanguage, realmLanguage } from './selection-heads.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSnapshotMoved,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE, SearchSnapshotMoved } from './search-readiness.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { classificationModelRevisions } from '../classification/vocabulary.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionSlotIri }
  from '../classification/decision.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE, decisionSlotIri,
  statementMeaningKey } from '../statement/schema.ts';
import { exactDecisionSupports, readSearchDecisionSupports } from './search-supports.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
import { querySearchFields, rankedSearchMatches, type SearchFieldOwners } from '../search/fields.ts';
import { publicWork } from './public-patterns.ts';
import { visibleContentSearchRights } from '../content-publication/search.ts';
import type { RightsStore } from '../rights/store.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';

export class InvalidPublicQuery extends Error {}
export { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
export class PublicRealmUnavailable extends Error {}

export interface PublicMainPhraseQuery {
  phrase: string;
  language: string | null;
  /** Exact author of the currently selected public Contribution. */
  author?: string;
  /** API discovery also matches current titles, taglines and credited names. */
  publicFields?: SearchFieldOwners;
  /** A joined Content chapter must cover the current owner cut before a complete result is returned. */
  contentProjection?: { content: ContentCore; cursor: ContentProjectionCursor; consumer: string };
  rights?: Pick<RightsStore, 'currentPublicDomainAssessments'>;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_CLASSIFICATION_CANDIDATES = 256;

/** One complete, bounded public Main Version phrase relation at a query snapshot. */
export async function queryPublicMainPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.author !== undefined && !nativeId.test(input.author))
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid public text query');
  }
  // Quotes force a literal phrase; backslashes and quotes cannot add Lucene operators.
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const content = input.contentProjection;
  const contentPosition = content ? await Promise.all([
    content.content.ownerPosition(), content.cursor.read(content.consumer) ]) : null;
  if (contentPosition && (contentPosition[0].dataEpoch !== contentPosition[1].dataEpoch
    || contentPosition[0].sequence !== contentPosition[1].sequence)) {
    throw new PublicQueryUnavailable('Content chapter projection is behind its source');
  }
  // Readiness also fences this lineage and the recovery hold in its control read.
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language ?resultWork ?resultMain ?chapterTitle ?contentProjection ?rightsBasis ?assessment WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexGeneration ?indexGeneration .
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
        { SELECT ?rawUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      OPTIONAL {
        { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?contribution ;
            rv:context ?main ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
          OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
            rv:searchChapterTitle ?chapterTitle . }
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?main rv:selectionHead ?selection .
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
        }
        ${content ? `UNION {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
            ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:field rv:Body ;
              rv:resource ?work ; rv:variant ?variant ; rv:revision ?contentRevision ;
              rv:publicationDecision ?contentDecision ; rv:eligibility ?contentEligibility ;
              rv:projection ?contentProjection ; rv:language ?language .
          }
          GRAPH ${iri(GRAPHS.current)} {
            ?variant a rv:ContentVariant ; rv:resource ?work ;
              rv:contentPublicationHead ?contentDecision ;
              rv:publicSearchEligibilityHead ?contentEligibility .
            ?work a rv:Post ; <http://www.w3.org/2000/01/rdf-schema#label> ?chapterTitle .
          }
          FILTER(LCASE(LANG(?chapterTitle)) = LCASE(?language))
          GRAPH ${iri(GRAPHS.revisions)} {
            ?contentEligibility a rv:ContentSearchEligibilityDecision ;
              rv:variant ?variant ; rv:publicationDecision ?contentDecision ;
              rv:rightsBasis ?rightsBasis ; rv:disclosure rv:Public .
            OPTIONAL { ?contentEligibility rv:rightsAssessment ?assessment }
            FILTER NOT EXISTS { ?contentRevision a rv:ErasedRevision }
          }
          ${postBookPlacement('?work', '?resultWork', '?resultMain')}
          ${publicWork('?resultWork', '?resultMain')}
          ${input.author ? `GRAPH ${iri(GRAPHS.current)} {
            ?bookCredit a rv:NativeAgentCredit ; rv:work ?resultWork ; rv:agent ${iri(input.author)} ;
              <https://schema.org/roleName> "author" . }` : ''}
          BIND(?resultMain AS ?main)
          BIND(?work AS ?contribution)
          BIND(?contentRevision AS ?revision)
          BIND(?contentDecision AS ?selection)
          ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
        }` : ''}
      }
    }`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) await assertSnapshotMoved(env.fuseki, index);
  // Metadata commands can advance graph sequence without touching MatchUnits.
  // The relation is one later TDB2 snapshot, and the native write epoch stayed fixed.
  const relationSequence = rows[0]?.sequence?.value;
  if (rows.length === 0 || !rows[0]?.candidateCount || !rows[0]?.epoch || !rows[0]?.sequence
    || rows[0].epoch.value !== index.dataEpoch
    || !relationSequence || !/^(0|[1-9][0-9]*)$/.test(relationSequence)
    || BigInt(relationSequence) < BigInt(index.sequence)
    || rows.some(row => row.epoch?.value !== index.dataEpoch
      || row.sequence?.value !== relationSequence
      || row.indexGeneration?.value !== index.generation
      || row.candidateCount?.value !== rows[0]!.candidateCount!.value)) {
    throw new PublicQueryUnavailable('public query snapshot is unavailable');
  }
  const candidateCount = Number(rows[0].candidateCount.value);
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new PublicQueryUnavailable('public query candidate count is invalid');
  }
  if (candidateCount >= PHRASE_HIT_PROBE) {
    throw new PublicQueryBudgetExceeded('public phrase exceeds complete candidate budget');
  }
  const contentRows = rows.filter(row => row.contentProjection).map(row => {
    if (!row.work) throw new PublicQueryUnavailable('Content chapter resource is missing');
    return { row, resource: row.work.value, rightsBasis: row.rightsBasis?.value,
      assessment: row.assessment?.value };
  });
  const visibleContent = new Set((await visibleContentSearchRights(contentRows, input.rights)).map(item => item.row));
  const sourceHeads = new Set<string>();
  const matches = rows.filter(row => row.unit && (!row.contentProjection || visibleContent.has(row))).map(row => {
    if (!row.unit || !row.score || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language) {
      throw new PublicQueryUnavailable('public query result is incomplete');
    }
    if (row.resultWork && (!row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('chapter search identity is incomplete');
    }
    const score = Number(row.score.value);
    if (!Number.isFinite(score)) throw new PublicQueryUnavailable('public query score is invalid');
    const head = `${row.main.value}\0${row.language.value.toLowerCase()}`;
    if (!row.contentProjection) {
      if (sourceHeads.has(head)) throw new PublicQueryUnavailable('Main language search heads are ambiguous');
      sourceHeads.add(head);
    }
    return { matchUnit: row.unit.value, work: row.resultWork?.value ?? row.work.value,
      mainVersion: row.resultMain?.value ?? row.main.value,
      contribution: row.contribution.value, revision: row.revision.value,
      selection: row.selection.value, language: row.language.value, score,
      ...(row.resultWork ? { matchedChapter: { post: row.work.value, book: row.resultWork.value,
        title: row.chapterTitle!.value } } : {}) };
  });
  const unique = new Set(matches.map(match => `${match.matchUnit}\0${match.work}`));
  if (unique.size !== matches.length) throw new PublicQueryUnavailable('public query has duplicate units');
  const fields = input.publicFields ? await querySearchFields(env, input,
    { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value }, input.publicFields) : [];
  const disclosed = await discloseSearchMatches(env, matches);
  // The qualified census counts MatchUnits, but one Content unit can reach
  // several Book mains. Replace only disclosed matching Content units with
  // their distinct Book mains; fences therefore gate the expansion too.
  // O(512) identities from this relation, with no additional owner or graph read.
  const contentUnits = new Set([...visibleContent].flatMap(row => row.unit ? [row.unit.value] : []));
  const chapterUnits = new Set<string>(), chapterMains = new Set<string>();
  for (const match of disclosed) {
    if (!match.matchedChapter || !contentUnits.has(match.matchUnit)) continue;
    chapterUnits.add(match.matchUnit);
    chapterMains.add(match.mainVersion);
  }
  const population = index.population - chapterUnits.size + chapterMains.size;
  const results = rankedSearchMatches([...disclosed, ...fields]);
  if (results.length > 512) throw new PublicQueryBudgetExceeded('Combined search candidates exceed their bound');
  if (contentPosition && content) {
    const [sourceAfter, checkpointAfter] = await Promise.all([
      content.content.ownerPosition(), content.cursor.read(content.consumer) ]);
    if (sourceAfter.dataEpoch !== contentPosition[0].dataEpoch
      || sourceAfter.sequence !== contentPosition[0].sequence
      || checkpointAfter.dataEpoch !== contentPosition[1].dataEpoch
      || checkpointAfter.sequence !== contentPosition[1].sequence) {
      throw new SearchSnapshotMoved('Content chapter source moved during public search');
    }
  }
  return { contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: 'main-version-default' as const, complete: true as const, population,
    indexGeneration: index.generation,
    total: results.length, results,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}

/** One complete Realm-effective phrase relation within the whole public index bound. */
export async function queryPublicRealmPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { context: { kind: 'realm-local'; id: string } }) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (input.context?.kind !== 'realm-local' || !nativeId.test(input.context.id)
    || phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.author !== undefined && !nativeId.test(input.author))
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid Realm text query');
  }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const realm = input.context.id;
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language ?reason ?resultWork ?resultMain ?chapterTitle WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexGeneration ?indexGeneration .
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} .
      }
      { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
        { SELECT ?rawUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:context ?unitContext ;
            rv:contribution ?contribution ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
          OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
            rv:searchChapterTitle ?chapterTitle . }
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ?main ; rv:selectionHead ?local . }
          ${realmLanguage('?local', '?language')} }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?fallback }
          ${fallbackLanguage('?fallback', '?language')} }
        BIND(COALESCE(?local, ?fallback) AS ?effectiveSelection)
        BIND(IF(BOUND(?local), ${iri(realm)}, ?main) AS ?effectiveContext)
        BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
        FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext)
        FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) await assertSnapshotMoved(env.fuseki, index);
  if (rows.length === 0) throw new PublicRealmUnavailable('Realm is unavailable');
  // Realm policy/selection is read with the phrase relation at this graph cut.
  // A stable native write epoch certifies the earlier index population proof.
  const relationSequence = rows[0]?.sequence?.value;
  if (!rows[0]?.candidateCount || !rows[0]?.epoch || !rows[0]?.sequence
    || rows[0].epoch.value !== index.dataEpoch
    || !relationSequence || !/^(0|[1-9][0-9]*)$/.test(relationSequence)
    || BigInt(relationSequence) < BigInt(index.sequence)
    || rows.some(row => row.epoch?.value !== index.dataEpoch
      || row.sequence?.value !== relationSequence
      || row.indexGeneration?.value !== index.generation
      || row.candidateCount?.value !== rows[0]!.candidateCount!.value)) {
    throw new PublicQueryUnavailable('Realm query snapshot is unavailable');
  }
  const candidateCount = Number(rows[0].candidateCount.value);
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new PublicQueryUnavailable('Realm query candidate count is invalid');
  }
  if (candidateCount >= PHRASE_HIT_PROBE) {
    throw new PublicQueryBudgetExceeded('Realm phrase exceeds complete candidate budget');
  }
  const sourceHeads = new Set<string>();
  const matches = rows.filter(row => row.unit).map(row => {
    if (!row.unit || !row.score || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language || !row.reason) {
      throw new PublicQueryUnavailable('Realm query result is incomplete');
    }
    if (row.resultWork && (!row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('chapter search identity is incomplete');
    }
    const score = Number(row.score.value);
    if (!Number.isFinite(score)
      || !['realm-adoption', 'main-fallback'].includes(row.reason.value)) {
      throw new PublicQueryUnavailable('Realm query score or selection is invalid');
    }
    const head = `${row.main.value}\0${row.language.value.toLowerCase()}`;
    if (sourceHeads.has(head)) throw new PublicQueryUnavailable('Realm language search heads are ambiguous');
    sourceHeads.add(head);
    return { matchUnit: row.unit.value, work: row.resultWork?.value ?? row.work.value,
      mainVersion: row.resultMain?.value ?? row.main.value, contribution: row.contribution.value,
      revision: row.revision.value, selection: row.selection.value,
      language: row.language.value, reason: row.reason.value, score,
      ...(row.resultWork ? { matchedChapter: { post: row.work.value, book: row.resultWork.value,
        title: row.chapterTitle!.value } } : {}) };
  });
  const unique = new Set(matches.map(match => match.matchUnit));
  if (unique.size !== matches.length || (matches.length === 0 && rows.length !== 1)) {
    throw new PublicQueryUnavailable('Realm query has ambiguous results');
  }
  const fields = input.publicFields ? await querySearchFields(env, input,
    { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value }, input.publicFields) : [];
  const results = rankedSearchMatches([...await discloseSearchMatches(env, matches), ...fields]);
  if (results.length > 512) throw new PublicQueryBudgetExceeded('Combined search candidates exceed their bound');
  return { contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: { kind: 'realm-local' as const, id: realm },
    complete: true as const, population: index.population, total: results.length, results,
    indexGeneration: index.generation,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}

async function assertClassificationQueryScope(env: WorkActivationEnvironment,
  sense: string, realm: string | undefined,
  position: { dataEpoch: string; sequence: string; generation: string }) {
  if (!nativeId.test(sense)) throw new InvalidPublicQuery('invalid classification Sense');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?context
    ?senseRevision ?concept ?cutover WHERE {
    GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ?senseRevision ;
        rv:expression ?expression .
      ?expression a rv:ClassificationExpression ; rv:expressionState rv:Active ;
        rv:assertedConcept ?concept .
      ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
        rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
        rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
      ${realm ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:classificationContext ?context .
        ?context a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ?contextRevision .`
        : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)`}
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?senseRevision a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
        rv:modelRevision ?senseModel . ${classificationModelRevisions('?senseModel')}
      ${realm ? `?contextRevision a rv:RevisionAnchor ; rv:component ?context .` : ''}
    }
    BIND(EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?cutoverReceipt a rv:OperationReceipt ;
      rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ;
      rv:decisionModel <https://rezics.com/vocab/StatementDecisions> . } } AS ?cutover)
  }`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
    || rows[0]?.sequence?.value !== position.sequence || !rows[0]?.context
    || !rows[0]?.senseRevision || !rows[0]?.concept || !rows[0]?.cutover) {
    if (rows.length === 0) await assertSnapshotMoved(env.fuseki, position);
    if (rows.length === 1 && rows[0]?.epoch?.value === position.dataEpoch
      && rows[0]?.sequence?.value !== position.sequence) {
      throw new SearchSnapshotMoved('classification scope crossed graph positions');
    }
    throw new PublicQueryUnavailable('classification scope is unavailable at query position');
  }
  return { context: rows[0].context.value, senseRevision: rows[0].senseRevision.value,
    concept: rows[0].concept.value, cutover: rows[0].cutover.value === 'true' };
}

/** Bounded complete phrase results filtered by current direct classification. */
async function qualifyPublicPhrase<T extends { results: Array<{ work: string; mainVersion: string }>;
  sourcePosition: { dataEpoch: string; sequence: string };
  indexGeneration: string; total: number }>(
  env: WorkActivationEnvironment, base: T, sense: string, realm?: string,
) {
  const scope = await assertClassificationQueryScope(env, sense, realm,
    { ...base.sourcePosition, generation: base.indexGeneration });
  if (scope.cutover) return qualifyStatementPhrase(env, base, sense, realm, scope);
  const context = scope.context;
  const unique = new Map(base.results.map(match => [match.mainVersion, match.work]));
  if (unique.size > MAX_CLASSIFICATION_CANDIDATES) {
    throw new PublicQueryBudgetExceeded('classification candidates exceed batched decision budget');
  }
  const decisions = new Map<string, { state: 'accepted' | 'rejected' | 'absent';
    decision: string | null; application: string | null;
    source: 'local' | 'inherited-global' | 'global' | 'none'; sourceContext: string | null }>();
  if (unique.size > 0) {
    const values = Array.from(unique, ([main, work]) => {
      const global = classificationDecisionSlotIri(main, sense, GLOBAL_CLASSIFICATION_CONTEXT);
      const local = realm ? ` ${iri(classificationDecisionSlotIri(main, sense, context))}` : '';
      return `(${iri(work)} ${iri(main)} ${iri(global)}${local})`;
    }).join('\n');
    const result = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?epoch ?sequence ?main ?localApplication ?localDecision ?localOutcome
        ?globalApplication ?globalDecision ?globalOutcome WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
        FILTER(?epoch = ${lit(base.sourcePosition.dataEpoch)})
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        VALUES (?work ?main ?globalSlot ${realm ? '?localSlot' : ''}) { ${values} }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
        }
        ${realm ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ?localApplication rv:applicationKey ?localSlot .
          OPTIONAL { ?localApplication a rv:ClassificationApplication ;
            rv:targetMainVersion ?main ; rv:sense ${iri(sense)} ;
            rv:classificationContext ${iri(context)} ; rv:applicationChannel rv:Curated ;
            rv:applicationState rv:Active ; rv:decisionHead ?localDecision .
            OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
              ?localDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
                rv:component ?localApplication ; rv:application ?localApplication ;
                rv:outcome ?localOutcome ;
                rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
            } }
          }
        } }` : ''}
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ?globalApplication rv:applicationKey ?globalSlot .
          OPTIONAL { ?globalApplication a rv:ClassificationApplication ;
            rv:targetMainVersion ?main ; rv:sense ${iri(sense)} ;
            rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
            rv:decisionHead ?globalDecision .
            OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
              ?globalDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
                rv:component ?globalApplication ; rv:application ?globalApplication ;
                rv:outcome ?globalOutcome ;
                rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
            } }
          }
        } }
      }`, MAX_SEARCH_RESPONSE_BYTES);
    const rows = result.results?.bindings ?? [];
    if (rows.length > 0 && rows.every(row => row.epoch?.value === base.sourcePosition.dataEpoch
      && row.sequence?.value === rows[0]?.sequence?.value)
      && rows[0]?.sequence?.value !== base.sourcePosition.sequence) {
      throw new SearchSnapshotMoved('classification batch crossed graph positions');
    }
    if (rows.length !== unique.size) {
      throw new PublicQueryUnavailable('classification batch is incomplete or ambiguous');
    }
    for (const row of rows) {
      const value = (key: string) => row[key]?.value;
      const main = value('main');
      if (!main || !unique.has(main) || decisions.has(main)
        || value('epoch') !== base.sourcePosition.dataEpoch
        || value('sequence') !== base.sourcePosition.sequence
        || (value('globalApplication') && (!value('globalDecision') || !value('globalOutcome')))
        || (value('localApplication') && (!value('localDecision') || !value('localOutcome')))
        || [value('localOutcome'), value('globalOutcome')].some(outcome => outcome
          && ![`${RV}Accepted`, `${RV}Rejected`].includes(outcome))) {
        throw new PublicQueryUnavailable('classification batch changed or is incomplete');
      }
      const local = !!realm && !!value('localDecision');
      const global = !!value('globalDecision');
      const outcome = local ? value('localOutcome') : value('globalOutcome');
      decisions.set(main, { state: outcome === `${RV}Accepted` ? 'accepted'
        : outcome === `${RV}Rejected` ? 'rejected' : 'absent',
      decision: local ? value('localDecision')! : value('globalDecision') ?? null,
      application: local ? value('localApplication')! : value('globalApplication') ?? null,
      source: local ? 'local' : realm && global ? 'inherited-global' : global ? 'global' : 'none',
      sourceContext: local ? context : global ? GLOBAL_CLASSIFICATION_CONTEXT : null });
    }
  }
  const results = base.results.flatMap(match => {
    const effective = decisions.get(match.mainVersion);
    if (!effective) throw new PublicQueryUnavailable('classification decision is missing');
    return effective.state === 'accepted' ? [{ ...match, classification: {
      sense, decision: effective.decision, application: effective.application,
      source: effective.source, sourceContext: effective.sourceContext } }] : [];
  });
  const after = await assertPublicTextReady(env.fuseki, env.lineage);
  if (after.dataEpoch !== base.sourcePosition.dataEpoch
    || after.sequence !== base.sourcePosition.sequence
    || after.generation !== base.indexGeneration) {
    throw new SearchSnapshotMoved('classification changed during public query');
  }
  return { ...base, profile: realm ? 'public-realm-classified-phrase-v1' as const
    : 'public-main-classified-phrase-v1' as const,
    classificationSense: sense, total: results.length, results };
}

/** After the receipt fence, search reads only Statement qualified-fact decisions. */
async function qualifyStatementPhrase<T extends { results: Array<{ work: string; mainVersion: string }>;
  sourcePosition: { dataEpoch: string; sequence: string };
  indexGeneration: string; total: number }>(env: WorkActivationEnvironment, base: T,
  sense: string, realm: string | undefined,
  scope: { context: string; senseRevision: string; concept: string }) {
  const unique = new Map(base.results.map(match => [match.mainVersion, match.work]));
  if (unique.size > MAX_CLASSIFICATION_CANDIDATES) {
    throw new PublicQueryBudgetExceeded('classification candidates exceed batched decision budget');
  }
  const decisions = new Map<string, { state: 'accepted' | 'rejected' | 'absent';
    decision: string | null; source: 'local' | 'inherited-global' | 'global' | 'none';
    sourceContext: string | null; meaningKey: string }>();
  if (unique.size > 0) {
    const values = Array.from(unique, ([main, work]) => {
      const key = statementMeaningKey({ subject: main, predicate: CLASSIFIED_AS,
        relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
        interpretationDefinitions: [scope.senseRevision], value: { kind: 'resource', iri: scope.concept },
        applicability: [] });
      const target = { kind: 'qualified-fact' as const, meaningKey: key };
      const global = decisionSlotIri(target, GLOBAL_CLASSIFICATION_CONTEXT);
      const local = realm ? ` ${iri(decisionSlotIri(target, scope.context))}` : '';
      return `(${iri(work)} ${iri(main)} ${iri(key)} ${iri(global)}${local})`;
    }).join('\n');
    const decisionRead = (name: 'local' | 'global', slot: string) => `OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ${slot} a rv:DecisionSlot ;
        rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ?key .
        BIND(${slot} AS ?${name}Found)
        OPTIONAL { ${slot} rv:decisionHead ?${name}Decision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
            ?${name}Decision a rv:StatementDecision, rv:RevisionAnchor ;
              rv:component ${slot} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
              rv:outcome ?${name}Outcome .
            FILTER(?${name}Outcome = rv:Withdrawn || EXISTS {
              ?${name}Decision rv:support ?support . GRAPH ${iri(GRAPHS.current)} {
                ?support a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
                  rv:statementState rv:Active ; rv:meaningKey ?key ;
                  <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ?main . } })
          } } }
      } }`;
    const result = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?epoch ?sequence ?main ?key ?localFound ?localDecision ?localOutcome
        ?globalFound ?globalDecision ?globalOutcome WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
        FILTER(?epoch = ${lit(base.sourcePosition.dataEpoch)})
        GRAPH ${iri(GRAPHS.receipts)} { ?cutover a rv:OperationReceipt ;
          rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ;
          rv:decisionModel <https://rezics.com/vocab/StatementDecisions> . }
        VALUES (?work ?main ?key ?globalSlot ${realm ? '?localSlot' : ''}) { ${values} }
        GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work . }
        ${realm ? decisionRead('local', '?localSlot') : ''}
        ${decisionRead('global', '?globalSlot')}
      }`, MAX_SEARCH_RESPONSE_BYTES);
    const rows = result.results?.bindings ?? [];
    if (rows.length > 0 && rows.every(row => row.epoch?.value === base.sourcePosition.dataEpoch
      && row.sequence?.value === rows[0]?.sequence?.value)
      && rows[0]?.sequence?.value !== base.sourcePosition.sequence) {
      throw new SearchSnapshotMoved('Statement decision batch crossed graph positions');
    }
    if (rows.length !== unique.size) {
      throw new PublicQueryUnavailable('Statement decision batch is incomplete or ambiguous');
    }
    for (const row of rows) {
      const value = (key: string) => row[key]?.value;
      const main = value('main');
      if (!main || !unique.has(main) || decisions.has(main)
        || value('epoch') !== base.sourcePosition.dataEpoch
        || value('sequence') !== base.sourcePosition.sequence
        || (value('globalFound') && (!value('globalDecision') || !value('globalOutcome')))
        || (value('localFound') && (!value('localDecision') || !value('localOutcome')))
        || [value('localOutcome'), value('globalOutcome')].some(outcome => outcome
          && ![`${RV}Accepted`, `${RV}Rejected`, `${RV}Withdrawn`].includes(outcome))) {
        throw new PublicQueryUnavailable('Statement decision batch changed or is incomplete');
      }
      const local = !!realm && !!value('localDecision') && value('localOutcome') !== `${RV}Withdrawn`;
      const global = !!value('globalDecision') && value('globalOutcome') !== `${RV}Withdrawn`;
      const outcome = local ? value('localOutcome') : value('globalOutcome');
      decisions.set(main, { state: outcome === `${RV}Accepted` ? 'accepted'
        : outcome === `${RV}Rejected` ? 'rejected' : 'absent',
      decision: local ? value('localDecision')! : global ? value('globalDecision')! : null,
      source: local ? 'local' : realm && global ? 'inherited-global' : global ? 'global' : 'none',
      sourceContext: local ? scope.context : global ? GLOBAL_CLASSIFICATION_CONTEXT : null,
      meaningKey: value('key')! });
    }
  }
  const supports = await readSearchDecisionSupports(env, base.sourcePosition,
    [...unique.keys()].flatMap(main => {
      const effective = decisions.get(main);
      if (!effective) throw new PublicQueryUnavailable('Statement decision is missing');
      return effective.state === 'accepted' ? [{ mainVersion: main,
        meaningKey: effective.meaningKey, decision: effective.decision!,
        sourceContext: effective.sourceContext! }] : [];
    }));
  const results = base.results.flatMap(match => {
    const effective = decisions.get(match.mainVersion);
    if (!effective) throw new PublicQueryUnavailable('Statement decision is missing');
    return effective.state === 'accepted' ? [{ ...match, classification: {
      sense, decision: effective.decision!, application: null, meaningKey: effective.meaningKey,
      concept: scope.concept,
      supportingStatements: exactDecisionSupports(supports, match.mainVersion, effective.decision!),
      supportingStatementCount: exactDecisionSupports(supports, match.mainVersion,
        effective.decision!).length,
      source: effective.source, sourceContext: effective.sourceContext! } }] : [];
  });
  const after = await assertPublicTextReady(env.fuseki, env.lineage);
  if (after.dataEpoch !== base.sourcePosition.dataEpoch
    || after.sequence !== base.sourcePosition.sequence
    || after.generation !== base.indexGeneration) {
    throw new SearchSnapshotMoved('Statement decisions changed during public query');
  }
  return { ...base, profile: realm ? 'public-realm-classified-phrase-v1' as const
    : 'public-main-classified-phrase-v1' as const,
    classificationSense: sense, total: results.length, results };
}

export async function queryPublicMainClassifiedPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { sense: string }) {
  const base = await queryPublicMainPhrase(env, input);
  return qualifyPublicPhrase(env, base, input.sense);
}

export async function queryPublicRealmClassifiedPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { sense: string;
    context: { kind: 'realm-local'; id: string } }) {
  const base = await queryPublicRealmPhrase(env, input);
  return qualifyPublicPhrase(env, base, input.sense, input.context.id);
}
