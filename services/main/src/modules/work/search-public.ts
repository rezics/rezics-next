import { searchText, type SearchMatchMode } from '../search/text.ts';
import { searchablePlacement } from '../structure/searchable-placements.ts';
import { phraseMatchPattern } from './search-phrase-pattern.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSnapshotMoved,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE, SearchSnapshotMoved } from './search-readiness.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { classificationModelRevisions } from '../classification/vocabulary.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE, decisionSlotIri,
  statementMeaningKey } from '../statement/schema.ts';
import { exactDecisionSupports, readSearchDecisionSupports } from './search-supports.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
import { querySearchFields, rankedSearchMatches, type SearchFieldOwners } from '../search/fields.ts';
import { assertPublicContentSearchReady, visibleContentSearchRights }
  from '../content-publication/search.ts';
import type { RightsStore } from '../rights/store.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';

export class InvalidPublicQuery extends Error {}
export { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
export class PublicRealmUnavailable extends Error {}

export interface PublicMainPhraseQuery {
  phrase: string;
  matchMode?: SearchMatchMode;
  language: string | null;
  /** Exact author of the currently selected public Contribution. */
  author?: string;
  /** API discovery also matches current titles, taglines and credited names. */
  publicFields?: SearchFieldOwners;
  /** A joined Content placement must cover the current owner cut before a complete result is returned. */
  contentProjection?: { content: ContentCore; cursor: ContentProjectionCursor; consumer: string };
  rights?: Pick<RightsStore, 'currentPublicDomainAssessments'>;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_CLASSIFICATION_CANDIDATES = 256;

/** One complete, bounded public Main Version phrase relation at a query snapshot. */
async function queryPublicPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { context?: { kind: 'realm-local'; id: string } }) {
  const { lucene } = searchText(input.phrase, input.matchMode, InvalidPublicQuery);
  if ((input.context !== undefined && (input.context.kind !== 'realm-local' || !nativeId.test(input.context.id)))
    || (input.author !== undefined && !nativeId.test(input.author))
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid public text query');
  }
  const realm = input.context?.id;
  const content = input.contentProjection;
  const contentReadiness = content
    ? await assertPublicContentSearchReady(env, content.content, content.cursor, content.consumer) : null;
  // Content readiness already qualified the native index at this same graph cut.
  const index = contentReadiness?.index ?? await assertPublicTextReady(env.fuseki, env.lineage);
  const placements = content ? await searchablePlacement(env, lucene,
    '?phraseWork', '?resultWork', '?resultMain', '?contentRevision') : undefined;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?phraseWork ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language ?resultWork ?resultMain ?chapterTitle ?contentProjection ?rightsBasis ?assessment
      ?variant ?contentDecision ?contentEligibility ?searchOccurrence ?searchProfile ?searchPosition ?reason WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexGeneration ?indexGeneration .
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      ${realm ? `GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} .
      }` : ''}
      { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
        { SELECT ?rawUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      OPTIONAL {
        ${phraseMatchPattern(input, lucene, undefined, placements)}
      }
    } ORDER BY ?searchPosition ?searchOccurrence LIMIT 513`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
  if (rows.length >= 513) throw new PublicQueryBudgetExceeded('Search placements exceed their complete result budget');
  if (!rows.length) {
    await assertSnapshotMoved(env.fuseki, index);
    if (realm) throw new PublicRealmUnavailable('Realm is unavailable');
  }
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
    if (!row.phraseWork) throw new PublicQueryUnavailable('Content placement resource is missing');
    return { row, resource: row.phraseWork.value, rightsBasis: row.rightsBasis?.value,
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
      throw new PublicQueryUnavailable('Content placement identity is incomplete');
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
      selection: row.selection.value, language: row.language.value, score, reason: row.reason?.value ?? 'main-fallback',
      ...(row.searchOccurrence && row.searchProfile && row.resultWork ? {
        matchedPlacements: [{ resource: row.phraseWork.value, work: row.resultWork.value,
          occurrence: row.searchOccurrence.value, profile: row.searchProfile.value, title: row.chapterTitle!.value,
          revision: row.revision.value }],
      } : {}),
      ...(row.resultWork && (!row.searchProfile || row.searchProfile.value === 'book-composition')
        ? { matchedChapter: { post: row.phraseWork.value, book: row.resultWork.value,
          title: row.chapterTitle!.value } } : {}) };
  });
  const unique = new Set(matches.map(match => `${match.matchUnit}\0${match.work}\0${match.matchedPlacements?.[0]?.occurrence ?? ''}`));
  if (unique.size !== matches.length) throw new PublicQueryUnavailable('public query has duplicate units');
  const fields = input.publicFields ? await querySearchFields(env, input,
    { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value }, input.publicFields) : [];
  const disclosed = await discloseSearchMatches(env, matches);
  // The qualified census counts MatchUnits, but one Content unit can reach
  // several placing mains. Replace only disclosed matching Content units with
  // their distinct placing mains; fences therefore gate the expansion too.
  // O(512) identities from this relation, with no additional owner or graph read.
  const contentUnits = new Set([...visibleContent].flatMap(row => row.unit ? [row.unit.value] : []));
  const chapterUnits = new Set<string>(), chapterMains = new Set<string>();
  for (const match of disclosed) {
    if (!match.matchedPlacements || !contentUnits.has(match.matchUnit)) continue;
    chapterUnits.add(match.matchUnit);
    chapterMains.add(match.mainVersion);
  }
  const population = index.population - chapterUnits.size + chapterMains.size;
  const results = rankedSearchMatches([...disclosed, ...fields]);
  if (results.length > 512) throw new PublicQueryBudgetExceeded('Combined search candidates exceed their bound');
  if (content && contentReadiness) {
    const [sourceAfter, checkpointAfter] = await Promise.all([
      content.content.ownerPosition(), content.cursor.read(content.consumer),
    ]);
    if (sourceAfter.dataEpoch !== contentReadiness.contentPosition.dataEpoch
      || sourceAfter.sequence !== contentReadiness.contentPosition.sequence
      || checkpointAfter.dataEpoch !== contentReadiness.contentPosition.dataEpoch
      || checkpointAfter.sequence !== contentReadiness.contentPosition.sequence) {
      throw new SearchSnapshotMoved('Content source moved during combined search');
    }
  }
  return { contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: 'main-version-default' as const, complete: true as const, population,
    indexGeneration: index.generation,
    total: results.length, results,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}

/** Main and Realm readers share one bounded candidate relation and Content ancestry. */
export async function queryPublicMainPhrase(env: WorkActivationEnvironment, input: PublicMainPhraseQuery) {
  return queryPublicPhrase(env, input);
}

export async function queryPublicRealmPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { context: { kind: 'realm-local'; id: string } }) {
  const result = await queryPublicPhrase(env, input);
  return { ...result, context: input.context };
}

async function assertClassificationQueryScope(env: WorkActivationEnvironment,
  sense: string, realm: string | undefined,
  position: { dataEpoch: string; sequence: string; generation: string }) {
  if (!nativeId.test(sense)) throw new InvalidPublicQuery('invalid classification Sense');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?context
    ?senseRevision ?concept WHERE {
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
  }`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
    || rows[0]?.sequence?.value !== position.sequence || !rows[0]?.context
    || !rows[0]?.senseRevision || !rows[0]?.concept) {
    if (rows.length === 0) await assertSnapshotMoved(env.fuseki, position);
    if (rows.length === 1 && rows[0]?.epoch?.value === position.dataEpoch
      && rows[0]?.sequence?.value !== position.sequence) {
      throw new SearchSnapshotMoved('classification scope crossed graph positions');
    }
    throw new PublicQueryUnavailable('classification scope is unavailable at query position');
  }
  return { context: rows[0].context.value, senseRevision: rows[0].senseRevision.value,
    concept: rows[0].concept.value };
}

/** Bounded complete phrase results filtered by current direct classification. */
async function qualifyPublicPhrase<T extends { results: Array<{ work: string; mainVersion: string }>;
  sourcePosition: { dataEpoch: string; sequence: string };
  indexGeneration: string; total: number }>(
  env: WorkActivationEnvironment, base: T, sense: string, realm?: string,
) {
  const scope = await assertClassificationQueryScope(env, sense, realm,
    { ...base.sourcePosition, generation: base.indexGeneration });
  return qualifyStatementPhrase(env, base, sense, realm, scope);
}

/** Search reads only Statement qualified-fact decisions. */
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
      GRAPH ${iri(GRAPHS.current)} {
        VALUES (?work ?main ?key ?globalSlot ${realm ? '?localSlot' : ''}) { ${values} }
        FILTER EXISTS { ${slot} ?presentProperty ?presentValue }
        BIND(${slot} AS ?${name}Found)
        OPTIONAL { ${slot} rv:decisionHead ?${name}Decision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
            VALUES (?work ?main ?key ?globalSlot ${realm ? '?localSlot' : ''}) { ${values} }
            ?${name}Decision a rv:StatementDecision, rv:RevisionAnchor ;
              rv:component ${slot} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
              rv:outcome ?${name}Outcome .
            FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${slot} a rv:DecisionSlot ;
              rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ?key ;
              rv:acceptanceContext ${iri(name === 'local' ? scope.context : GLOBAL_CLASSIFICATION_CONTEXT)} } }
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
