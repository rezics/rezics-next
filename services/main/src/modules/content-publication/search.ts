import type { ContentCore } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { assertPublicTextReady, assertQuerySnapshotMoved, assertSameTextInstance, MAX_PUBLIC_UNITS,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE,
  SearchSnapshotMoved, type PublicTextPosition } from '../work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { assertContentProjectionProfiles, ContentProjectionUnavailable } from './relay.ts';

export class InvalidContentPhrase extends Error {}
export class ContentSearchBudgetExceeded extends Error {}

type SourcePosition = Awaited<ReturnType<ContentCore['ownerPosition']>>;
interface ContentQualification { population: number }
const qualified = new WeakMap<FusekiClient, Map<string, Promise<ContentQualification>>>();

async function qualifyContent(env: WorkActivationEnvironment, index: PublicTextPosition,
  source: SourcePosition): Promise<ContentQualification> {
  const key = `${index.serverInstanceId}\0${index.publicSearchWriteEpoch}\0${index.dataEpoch}\0${index.sequence}\0${index.generation}\0${source.dataEpoch}\0${source.sequence}`;
  let entries = qualified.get(env.fuseki);
  if (!entries) { entries = new Map(); qualified.set(env.fuseki, entries); }
  const existing = entries.get(key);
  if (existing) return existing;
  const proof = auditContent(env, index);
  entries.clear();
  entries.set(key, proof);
  try { return await proof; }
  catch (error) { if (entries.get(key) === proof) entries.delete(key); throw error; }
}

/** Full source/projection inventory is read once per joint graph/Content position. */
async function auditContent(env: WorkActivationEnvironment,
  index: PublicTextPosition): Promise<ContentQualification> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?generation ?declared ?heads ?missing ?eligible ?contentUnits WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:sequence ?sequence ; rv:textIndexGeneration ?generation . }
      FILTER(?epoch = ${lit(index.dataEpoch)} && ?sequence = ${index.sequence}
        && ?generation = ${iri(index.generation)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      { SELECT (COUNT(DISTINCT ?declaredVariant) AS ?declared) WHERE {
        { SELECT DISTINCT ?declaredVariant WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?declaredVariant a rv:ContentVariant ;
            rv:publicSearchEligibilityHead ?declaredEligibility .
        } } LIMIT ${MAX_PUBLIC_UNITS + 1} }
      } }
      { SELECT (COUNT(DISTINCT ?headVariant) AS ?heads) WHERE {
        { SELECT DISTINCT ?headVariant WHERE {
          GRAPH ${iri(GRAPHS.current)} { ?headVariant a rv:ContentVariant ;
            rv:contentPublicationHead ?headDecision ;
            rv:publicSearchEligibilityHead ?headEligibility . }
          GRAPH ${iri(GRAPHS.revisions)} { ?headEligibility a rv:ContentSearchEligibilityDecision ;
            rv:variant ?headVariant ; rv:publicationDecision ?headDecision ;
            rv:disclosure rv:Public . }
        } LIMIT ${MAX_PUBLIC_UNITS + 1} }
      } }
      { SELECT (COUNT(DISTINCT ?missingVariant) AS ?missing) WHERE {
        { SELECT DISTINCT ?missingVariant WHERE {
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
        } LIMIT 1 }
      } }
      { SELECT (COUNT(DISTINCT ?eligibleUnit) AS ?eligible) WHERE {
        { SELECT DISTINCT ?eligibleUnit WHERE {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?eligibleUnit a rv:MatchUnit ;
            rv:variant ?eligibleVariant ; rv:publicationDecision ?eligibleDecision ;
            rv:eligibility ?eligibleEligibility ; rv:projection ?projection . }
          GRAPH ${iri(GRAPHS.current)} { ?eligibleVariant a rv:ContentVariant ;
            rv:contentPublicationHead ?eligibleDecision ;
            rv:publicSearchEligibilityHead ?eligibleEligibility . }
          GRAPH ${iri(GRAPHS.revisions)} { ?eligibleEligibility a rv:ContentSearchEligibilityDecision ;
            rv:variant ?eligibleVariant ; rv:publicationDecision ?eligibleDecision ;
            rv:disclosure rv:Public . }
        } LIMIT ${MAX_PUBLIC_UNITS + 1} }
      } }
      { SELECT (COUNT(DISTINCT ?contentUnit) AS ?contentUnits) WHERE {
        { SELECT DISTINCT ?contentUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?contentUnit a rv:MatchUnit ; rv:projection ?contentProjection .
        } } LIMIT ${MAX_PUBLIC_UNITS + 1} }
      } }
    }`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  await assertQuerySnapshotMoved(env.fuseki, index, rows, 'generation');
  if (rows.length !== 1 || row?.epoch?.value !== index.dataEpoch
    || row.sequence?.value !== index.sequence || row.generation?.value !== index.generation) {
    throw new ContentProjectionUnavailable('Content search graph snapshot is unavailable');
  }
  const counts = ['declared', 'heads', 'missing', 'eligible', 'contentUnits']
    .map(key => Number(row[key]?.value));
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new ContentProjectionUnavailable('Content search population is invalid');
  }
  const [declared, heads, missing, eligible, contentUnits] = counts;
  if (declared! > MAX_PUBLIC_UNITS || contentUnits! > MAX_PUBLIC_UNITS) {
    throw new ContentSearchBudgetExceeded('Content search population exceeds admitted bound');
  }
  if (declared !== heads || missing !== 0 || heads !== eligible || eligible !== contentUnits) {
    throw new ContentProjectionUnavailable('Content publication has unprojected or stale search units');
  }
  return { population: heads! };
}

async function prepareContentSearch(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string) {
  const [source, checkpoint] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (source.dataEpoch !== checkpoint.dataEpoch || source.sequence !== checkpoint.sequence) {
    throw new ContentProjectionUnavailable('Content projection is behind its source');
  }
  await assertContentProjectionProfiles(env);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const proof = await qualifyContent(env, index, source);
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
  input: { phrase: string; language: string | null }) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidContentPhrase('invalid public Content phrase');
  }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const { source, index, proof } = await prepareContentSearch(env, content, cursor, consumer);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation ?candidateCount ?unit ?score
      ?resource ?variant ?revision ?decision ?eligibility ?language WHERE {
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
        }
        GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
          rv:resource ?resource ; rv:contentPublicationHead ?decision ;
          rv:publicSearchEligibilityHead ?eligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ?variant ; rv:publicationDecision ?decision ;
          rv:disclosure rv:Public . }
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
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
      publicationDecision: row.decision.value, language: row.language.value, score };
  });
  if (new Set(matches.map(match => match.matchUnit)).size !== matches.length) {
    throw new ContentProjectionUnavailable('Content phrase result has duplicate units');
  }
  const [sourceAfter, checkpointAfter] = await Promise.all([
    content.ownerPosition(), cursor.read(consumer),
  ]);
  if (sourceAfter.dataEpoch !== source.dataEpoch || sourceAfter.sequence !== source.sequence
    || checkpointAfter.dataEpoch !== source.dataEpoch
    || checkpointAfter.sequence !== source.sequence) {
    throw new SearchSnapshotMoved('Content source moved during search');
  }
  matches.sort((left, right) => right.score - left.score
    || left.resource.localeCompare(right.resource) || left.variant.localeCompare(right.variant));
  return { contractVersion: '1' as const, profile: 'public-content-phrase-v1' as const,
    resultGrain: 'content-variant' as const, complete: true as const,
    total: matches.length, population: proof.population, results: matches,
    graphPosition: { dataEpoch: index.dataEpoch, sequence: index.sequence },
    contentPosition: source, indexGeneration: index.generation };
}

export async function assertPublicContentSearchReady(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string) {
  const { source, index } = await prepareContentSearch(env, content, cursor, consumer);
  return { graphPosition: { dataEpoch: index.dataEpoch, sequence: index.sequence },
    contentPosition: source, indexGeneration: index.generation };
}
