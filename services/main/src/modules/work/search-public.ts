import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';

export class InvalidPublicQuery extends Error {}
export class PublicQueryBudgetExceeded extends Error {}
export class PublicQueryUnavailable extends Error {}

export interface PublicMainPhraseQuery {
  phrase: string;
  language: string | null;
}

const MAX_UNITS = 100;

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
            rv:revision ?revision ; rv:selection ?selection ; rv:language ?language .
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
