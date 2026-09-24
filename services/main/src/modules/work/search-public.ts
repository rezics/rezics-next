import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { SELECTION_POLICY } from '../space/create.ts';

export class InvalidPublicQuery extends Error {}
export class PublicQueryBudgetExceeded extends Error {}
export class PublicQueryUnavailable extends Error {}
export class PublicRealmUnavailable extends Error {}

export interface PublicMainPhraseQuery {
  phrase: string;
  language: string | null;
}

const MAX_UNITS = 100;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** One complete, bounded public Main Version phrase relation at a query snapshot. */
export async function queryPublicMainPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid public text query');
  }
  // Quotes force a literal phrase; backslashes and quotes cannot add Lucene operators.
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?population ?epoch ?sequence ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?candidate a rv:MatchUnit }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${MAX_UNITS + 1}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?contribution ;
            rv:context ?main ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection }
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0 || !rows[0]?.population || !rows[0]?.epoch || !rows[0]?.sequence) {
    throw new PublicQueryUnavailable('public query snapshot is unavailable');
  }
  const population = Number(rows[0].population.value);
  if (!Number.isSafeInteger(population) || population < 0) {
    throw new PublicQueryUnavailable('public query population is invalid');
  }
  if (population > MAX_UNITS) throw new PublicQueryBudgetExceeded('public query population exceeds admitted bound');
  const matches = rows.filter(row => row.unit).map(row => {
    if (!row.unit || !row.score || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language) {
      throw new PublicQueryUnavailable('public query result is incomplete');
    }
    const score = Number(row.score.value);
    if (!Number.isFinite(score)) throw new PublicQueryUnavailable('public query score is invalid');
    return { matchUnit: row.unit.value, work: row.work.value, mainVersion: row.main.value,
      contribution: row.contribution.value, revision: row.revision.value,
      selection: row.selection.value, language: row.language.value, score };
  });
  const unique = new Set(matches.map(match => match.matchUnit));
  if (unique.size !== matches.length) throw new PublicQueryUnavailable('public query has duplicate units');
  matches.sort((left, right) => right.score - left.score
    || left.mainVersion.localeCompare(right.mainVersion));
  return { contractVersion: '1', resultGrain: 'mainVersion',
    context: 'main-version-default', complete: true, population,
    total: matches.length, results: matches,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}

/** One complete Realm-effective phrase relation within the whole public index bound. */
export async function queryPublicRealmPhrase(env: WorkActivationEnvironment,
  input: PublicMainPhraseQuery & { context: { kind: 'realm-local'; id: string } }) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (input.context?.kind !== 'realm-local' || !nativeId.test(input.context.id)
    || phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid Realm text query');
  }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const realm = input.context.id;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?population ?epoch ?sequence ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language ?reason WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} .
      }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?candidate a rv:MatchUnit }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${MAX_UNITS + 1}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:context ?unitContext ;
            rv:contribution ?contribution ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
          OPTIONAL { ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ?main ; rv:selectionHead ?local }
          OPTIONAL { ?main rv:selectionHead ?fallback }
        }
        BIND(COALESCE(?local, ?fallback) AS ?effectiveSelection)
        BIND(IF(BOUND(?local), ${iri(realm)}, ?main) AS ?effectiveContext)
        BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
        FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext)
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new PublicRealmUnavailable('Realm is unavailable');
  if (!rows[0]?.population || !rows[0]?.epoch || !rows[0]?.sequence) {
    throw new PublicQueryUnavailable('Realm query snapshot is unavailable');
  }
  const population = Number(rows[0].population.value);
  if (!Number.isSafeInteger(population) || population < 0) {
    throw new PublicQueryUnavailable('Realm query population is invalid');
  }
  if (population > MAX_UNITS) {
    throw new PublicQueryBudgetExceeded('public query population exceeds admitted bound');
  }
  const matches = rows.filter(row => row.unit).map(row => {
    if (!row.unit || !row.score || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language || !row.reason) {
      throw new PublicQueryUnavailable('Realm query result is incomplete');
    }
    const score = Number(row.score.value);
    if (!Number.isFinite(score)
      || !['realm-adoption', 'main-fallback'].includes(row.reason.value)) {
      throw new PublicQueryUnavailable('Realm query score or selection is invalid');
    }
    return { matchUnit: row.unit.value, work: row.work.value,
      mainVersion: row.main.value, contribution: row.contribution.value,
      revision: row.revision.value, selection: row.selection.value,
      language: row.language.value, reason: row.reason.value, score };
  });
  const unique = new Set(matches.map(match => match.matchUnit));
  if (unique.size !== matches.length || (matches.length === 0 && rows.length !== 1)) {
    throw new PublicQueryUnavailable('Realm query has ambiguous results');
  }
  matches.sort((left, right) => right.score - left.score
    || left.mainVersion.localeCompare(right.mainVersion));
  return { contractVersion: '1', resultGrain: 'mainVersion',
    context: { kind: 'realm-local' as const, id: realm },
    complete: true, population, total: matches.length, results: matches,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}
