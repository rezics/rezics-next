import type { ContentCore } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { assertPublicTextReady } from '../work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { assertContentProjectionProfiles, ContentProjectionUnavailable } from './relay.ts';

const MAX_PUBLIC_UNITS = 100;

export class InvalidContentPhrase extends Error {}
export class ContentSearchBudgetExceeded extends Error {}

/** The Content phrase lane needs complete Content and graph frontiers before returning an empty answer. */
export async function queryPublicContentPhrase(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string,
  input: { phrase: string; language: string | null }) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidContentPhrase('invalid public Content phrase');
  }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const [sourceBefore, checkpointBefore] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (sourceBefore.dataEpoch !== checkpointBefore.dataEpoch
    || sourceBefore.sequence !== checkpointBefore.sequence) {
    throw new ContentProjectionUnavailable('Content projection is behind its source');
  }
  await assertContentProjectionProfiles(env);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation ?declared ?heads ?missing ?eligible ?contentUnits
      ?unit ?score ?resource ?variant ?revision ?decision ?eligibility ?language WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:sequence ?sequence ; rv:textIndexGeneration ?generation . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      { SELECT (COUNT(DISTINCT ?declaredVariant) AS ?declared) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?declaredVariant a rv:ContentVariant ;
          rv:publicSearchEligibilityHead ?declaredEligibility . }
      } }
      { SELECT (COUNT(DISTINCT ?headVariant) AS ?heads) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?headVariant a rv:ContentVariant ;
          rv:contentPublicationHead ?headDecision ;
          rv:publicSearchEligibilityHead ?headEligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?headEligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?headVariant ; rv:publicationDecision ?headDecision ;
          rv:disclosure rv:Public . }
      } }
      { SELECT (COUNT(DISTINCT ?missingVariant) AS ?missing) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?missingVariant a rv:ContentVariant ;
          rv:contentPublicationHead ?missingDecision ;
          rv:publicSearchEligibilityHead ?missingEligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?missingEligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?missingVariant ; rv:publicationDecision ?missingDecision ;
          rv:disclosure rv:Public . }
        FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?coveredUnit a rv:MatchUnit ; rv:variant ?missingVariant ;
            rv:publicationDecision ?missingDecision ; rv:eligibility ?missingEligibility ;
            rv:projection ?coveredProjection . } }
      } }
      { SELECT (COUNT(DISTINCT ?eligibleUnit) AS ?eligible) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?eligibleUnit a rv:MatchUnit ;
          rv:variant ?eligibleVariant ; rv:publicationDecision ?eligibleDecision ;
          rv:eligibility ?eligibleEligibility ; rv:projection ?projection . }
        GRAPH ${iri(GRAPHS.current)} { ?eligibleVariant a rv:ContentVariant ;
          rv:contentPublicationHead ?eligibleDecision ;
          rv:publicSearchEligibilityHead ?eligibleEligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?eligibleEligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?eligibleVariant ; rv:publicationDecision ?eligibleDecision ;
          rv:disclosure rv:Public . }
      } }
      { SELECT (COUNT(DISTINCT ?contentUnit) AS ?contentUnits) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?contentUnit a rv:MatchUnit ;
          rv:projection ?contentProjection . }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${MAX_PUBLIC_UNITS + 1}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:field rv:Body ;
            rv:resource ?resource ; rv:variant ?variant ; rv:revision ?revision ;
            rv:publicationDecision ?decision ; rv:eligibility ?eligibility ;
            rv:projection ?unitProjection ;
            rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
          rv:resource ?resource ; rv:contentPublicationHead ?decision ;
          rv:publicSearchEligibilityHead ?eligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?variant ; rv:publicationDecision ?decision ;
          rv:disclosure rv:Public . }
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  const value = (row: typeof first, key: string) => row?.[key]?.value;
  if (!first || value(first, 'epoch') !== index.dataEpoch
    || value(first, 'sequence') !== index.sequence
    || value(first, 'generation') !== index.generation
    || rows.some(row => value(row, 'epoch') !== index.dataEpoch
      || value(row, 'sequence') !== index.sequence
      || value(row, 'generation') !== index.generation
      || value(row, 'declared') !== value(first, 'declared')
      || value(row, 'heads') !== value(first, 'heads')
      || value(row, 'missing') !== value(first, 'missing')
      || value(row, 'eligible') !== value(first, 'eligible')
      || value(row, 'contentUnits') !== value(first, 'contentUnits'))) {
    throw new ContentProjectionUnavailable('Content search graph snapshot is unavailable');
  }
  const declared = Number(value(first, 'declared'));
  const heads = Number(value(first, 'heads'));
  const missing = Number(value(first, 'missing'));
  const eligible = Number(value(first, 'eligible'));
  const contentUnits = Number(value(first, 'contentUnits'));
  if (![declared, heads, missing, eligible, contentUnits].every(Number.isSafeInteger)
    || [declared, heads, missing, eligible, contentUnits].some(count => count < 0)) {
    throw new ContentProjectionUnavailable('Content search population is invalid');
  }
  if (declared > MAX_PUBLIC_UNITS || contentUnits > MAX_PUBLIC_UNITS) {
    throw new ContentSearchBudgetExceeded('Content search population exceeds admitted bound');
  }
  if (declared !== heads || missing !== 0 || heads !== eligible || eligible !== contentUnits) {
    throw new ContentProjectionUnavailable('Content publication has unprojected or stale search units');
  }
  const matches = rows.filter(row => row.unit).map(row => {
    const score = Number(value(row, 'score'));
    if (!Number.isFinite(score) || !row.unit || !row.resource || !row.variant
      || !row.revision || !row.decision || !row.language) {
      throw new ContentProjectionUnavailable('Content phrase result is incomplete');
    }
    return { matchUnit: row.unit.value, resource: row.resource.value,
      variant: row.variant.value, revision: row.revision.value,
      publicationDecision: row.decision.value, language: row.language.value, score };
  });
  if (new Set(matches.map(match => match.matchUnit)).size !== matches.length) {
    throw new ContentProjectionUnavailable('Content phrase result has duplicate units');
  }
  const [sourceAfter, checkpointAfter] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (sourceAfter.dataEpoch !== sourceBefore.dataEpoch
    || sourceAfter.sequence !== sourceBefore.sequence
    || checkpointAfter.sequence !== checkpointBefore.sequence
    || checkpointAfter.dataEpoch !== checkpointBefore.dataEpoch) {
    throw new ContentProjectionUnavailable('Content source moved during search');
  }
  matches.sort((left, right) => right.score - left.score
    || left.resource.localeCompare(right.resource) || left.variant.localeCompare(right.variant));
  return { contractVersion: '1', resultGrain: 'content-variant', complete: true,
    total: matches.length, population: heads, results: matches,
    graphPosition: { dataEpoch: index.dataEpoch, sequence: index.sequence },
    contentPosition: sourceBefore, indexGeneration: index.generation };
}
