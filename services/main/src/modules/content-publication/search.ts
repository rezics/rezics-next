import { publicWork } from '../work/public-patterns.ts';
import { searchablePlacement } from '../structure/searchable-placements.ts';
import { canonicalContentLanguage, type ContentCore } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { assertPublicTextReady, assertQuerySnapshotMoved, assertSameTextInstance,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE,
  SearchSnapshotMoved } from '../work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { assertContentProjectionProfiles, ContentProjectionUnavailable } from './relay.ts';
import type { RightsStore } from '../rights/store.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';
import { observeSearchPhase } from '../search/operation-evidence.ts';

export class InvalidContentPhrase extends Error {}
export class ContentSearchBudgetExceeded extends Error {}

/** Main's chapter search and direct Content search apply the same live, batched Rights check. */
export async function visibleContentSearchRights<T extends {
  resource: string; rightsBasis: string | undefined; assessment: string | undefined;
}>(matches: readonly T[], rights?: Pick<RightsStore, 'currentPublicDomainAssessments'>): Promise<T[]> {
  const publicDomain = matches.filter(match => match.rightsBasis === `${RV}PublicDomain`);
  if (publicDomain.length && !rights) {
    throw new ContentProjectionUnavailable('public-domain rights owner is unavailable');
  }
  const refs = publicDomain.map(match => {
    const assessment = /^urn:rezics:rights:assessment:([0-9a-f-]{36})$/i.exec(match.assessment ?? '');
    if (!assessment) throw new ContentProjectionUnavailable('public-domain assessment is missing');
    return { work: match.resource, assessmentId: assessment[1]! };
  });
  let accepted = new Set<string>();
  if (rights && refs.length) {
    try { accepted = await rights.currentPublicDomainAssessments(refs); }
    catch { throw new ContentProjectionUnavailable('current public-domain search rights are unavailable'); }
  }
  return matches.filter(match => {
    if (match.rightsBasis === `${RV}OriginalContribution`) return !match.assessment;
    if (match.rightsBasis !== `${RV}PublicDomain`) {
      throw new ContentProjectionUnavailable('Content search rights basis is unknown');
    }
    const assessmentId = match.assessment!.slice('urn:rezics:rights:assessment:'.length);
    return accepted.has(`${match.resource}\0${assessmentId}`);
  });
}

async function prepareContentSearch(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string) {
  const [source, checkpoint] = await observeSearchPhase('content-readiness-source-checkpoint', () => Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]));
  if (source.dataEpoch !== checkpoint.dataEpoch || source.sequence !== checkpoint.sequence) {
    throw new ContentProjectionUnavailable('Content projection is behind its source');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const witness = index.contentQualification;
  // The generation owner audits all publication/approval receipts and complete
  // projection coverage in maintenance. Never let a reader synthesize a missing
  // witness, including an empty relation, or reuse one from another owner epoch.
  const proof = await observeSearchPhase('content-readiness-qualified-checkpoint', async () => {
    if (!witness || witness.population > index.population
      || !/^(0|[1-9][0-9]*)$/.test(source.sequence)
      || witness.ownerDataEpoch !== undefined && witness.ownerDataEpoch !== source.dataEpoch
      || BigInt(witness.ownerSequence) > BigInt(source.sequence)) {
      throw new ContentProjectionUnavailable('Content generation qualification is unavailable at its source');
    }
    await assertContentProjectionProfiles(env, witness.publicDomain ? ['content-search-eligibility-v2'] : []);
    return { population: witness.population };
  });
  await assertSameTextInstance(env.fuseki, index);
  const [sourceAfter, checkpointAfter] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (sourceAfter.dataEpoch !== source.dataEpoch || sourceAfter.sequence !== source.sequence
    || checkpointAfter.dataEpoch !== checkpoint.dataEpoch
    || checkpointAfter.sequence !== checkpoint.sequence) {
    throw new SearchSnapshotMoved('Content source moved during readiness');
  }
  return { source, index, proof };
}

export async function queryPublicContentPhrase(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string,
  input: { phrase: string; language: string | null },
  rights?: Pick<RightsStore, 'currentPublicDomainAssessments'>) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)) {
    throw new InvalidContentPhrase('invalid public Content phrase');
  }
  let language: string | null = null;
  try { language = input.language === null ? null : canonicalContentLanguage(input.language); }
  catch { throw new InvalidContentPhrase('invalid public Content language'); }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const { source, index, proof } = await prepareContentSearch(env, content, cursor, consumer);
  const placements = await searchablePlacement(env, lucene, '?resource', '?parentWork', '?parentMain', '?revision');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    PREFIX schema: <https://schema.org/>
    SELECT DISTINCT ?epoch ?sequence ?generation ?candidateCount ?unit ?score
      ?resource ?variant ?revision ?decision ?eligibility ?language ?rightsBasis ?assessment ?parentWork ?searchOccurrence ?searchProfile ?searchTitle ?searchPosition WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:sequence ?sequence ; rv:textIndexGeneration ?generation . }
      FILTER(?epoch = ${lit(index.dataEpoch)} && ?sequence = ${index.sequence}
        && ?generation = ${iri(index.generation)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
        { SELECT ?rawUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:field rv:Body ;
            rv:resource ?resource ; rv:variant ?variant ; rv:revision ?revision ;
            rv:publicationDecision ?decision ; rv:eligibility ?eligibility ;
            rv:projection ?unitProjection ; rv:language ?language .
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
        }
        GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
          rv:resource ?resource ; rv:contentPublicationHead ?decision ;
          rv:publicSearchEligibilityHead ?eligibility . }
        OPTIONAL { ${placements}
          GRAPH ${iri(GRAPHS.current)} { ?resource <http://www.w3.org/2000/01/rdf-schema#label> ?searchTitle }
          FILTER(LCASE(LANG(?searchTitle)) = LCASE(?language)) }
        # Keep every placing Work bound for disclosure; unreadable ancestry cannot
        # turn a placed hit into an unparented Content hit.
        FILTER(!BOUND(?parentWork) || EXISTS { ${publicWork('?parentWork', '?parentMain')} })
        GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?variant ; rv:publicationDecision ?decision ;
          rv:disclosure rv:Public ; rv:rightsBasis ?rightsBasis .
          OPTIONAL { ?eligibility rv:rightsAssessment ?assessment } }
        ${language ? `FILTER(?language = ${lit(language)})` : ''}
      }
    } ORDER BY ?searchPosition ?searchOccurrence LIMIT 513`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
  if (rows.length >= 513) throw new ContentSearchBudgetExceeded('Content placements exceed their complete result budget');
  const first = rows[0];
  const value = (row: typeof first, key: string) => row?.[key]?.value;
  await assertQuerySnapshotMoved(env.fuseki, index, rows, 'generation');
  if (!first || rows.some(row => value(row, 'epoch') !== index.dataEpoch
    || value(row, 'sequence') !== index.sequence
    || value(row, 'generation') !== index.generation
    || value(row, 'candidateCount') !== value(first, 'candidateCount'))) {
    throw new ContentProjectionUnavailable('Content phrase graph position changed');
  }
  const candidateCount = Number(value(first, 'candidateCount'));
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new ContentProjectionUnavailable('Content phrase candidate count is invalid');
  }
  if (candidateCount >= PHRASE_HIT_PROBE) {
    throw new ContentSearchBudgetExceeded('Content phrase exceeds complete candidate budget');
  }
  const matches = rows.filter(row => row.unit).map(row => {
    const score = Number(value(row, 'score'));
    if (!Number.isFinite(score) || !row.unit || !row.resource || !row.variant
      || !row.revision || !row.decision || !row.language) {
      throw new ContentProjectionUnavailable('Content phrase result is incomplete');
    }
    return { matchUnit: row.unit.value, resource: row.resource.value,
      variant: row.variant.value, revision: row.revision.value,
      publicationDecision: row.decision.value, language: row.language.value, score,
      parentWork: value(row, 'parentWork'),
      ...(row.parentWork && row.searchOccurrence && row.searchProfile && row.searchTitle ? {
        matchedPlacements: [{ resource: row.resource.value, work: row.parentWork.value,
          occurrence: row.searchOccurrence.value, profile: row.searchProfile.value, title: row.searchTitle.value }],
      } : {}),
      rightsBasis: value(row, 'rightsBasis'), assessment: value(row, 'assessment') };
  });
  if (new Set(matches.map(match => `${match.matchUnit}\0${match.parentWork ?? ''}\0${match.matchedPlacements?.[0]?.occurrence ?? ''}`)).size !== matches.length) {
    throw new ContentProjectionUnavailable('Content phrase result has duplicate units');
  }
  const disclosed = await discloseSearchMatches(env, matches.map(match => ({ ...match,
    work: match.parentWork ?? match.resource,
  })));
  const eligible = (await visibleContentSearchRights(disclosed, rights))
    .map(({ rightsBasis: _rightsBasis, assessment: _assessment, work: _work,
      ...match }) => match);
  // Preserve one Content hit per placing Work; combine repeated uses within that Work.
  const byUnit = new Map<string, (typeof eligible)[number]>();
  for (const match of eligible) {
    const key = `${match.matchUnit}\0${match.parentWork ?? ''}`;
    const prior = byUnit.get(key);
    if (!prior) byUnit.set(key, match);
    else if (match.matchedPlacements) prior.matchedPlacements = [
      ...(prior.matchedPlacements ?? []), ...match.matchedPlacements];
  }
  const visible = [...byUnit.values()].map(({ parentWork: _parentWork, ...match }) => match);
  const [sourceAfter, checkpointAfter] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (sourceAfter.dataEpoch !== source.dataEpoch || sourceAfter.sequence !== source.sequence
    || checkpointAfter.dataEpoch !== source.dataEpoch
    || checkpointAfter.sequence !== source.sequence) {
    throw new SearchSnapshotMoved('Content source moved during search');
  }
  visible.sort((left, right) => right.score - left.score
    || left.resource.localeCompare(right.resource) || left.variant.localeCompare(right.variant));
  return { contractVersion: '1' as const, profile: 'public-content-phrase-v1' as const,
    resultGrain: 'content-variant' as const, complete: true as const,
    total: visible.length, population: proof.population, results: visible,
    graphPosition: { dataEpoch: index.dataEpoch, sequence: index.sequence },
    contentPosition: source, indexGeneration: index.generation };
}

export async function assertPublicContentSearchReady(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string) {
  const { source, index } = await prepareContentSearch(env, content, cursor, consumer);
  return { graphPosition: { dataEpoch: index.dataEpoch, sequence: index.sequence },
    contentPosition: source, indexGeneration: index.generation, index };
}
