import { rankedSearchMatches } from '../search/fields.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';
import { publicWork } from './public-patterns.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { assertPublicTitleReady, assertQuerySnapshotMoved, assertSameTextInstance,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE } from './search-readiness.ts';
import { InvalidPublicQuery } from './search-public.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface PublicMainTitleBodyQuery {
  titleTerm: string;
  bodyTerm: string;
  language: string | null;
  author?: string;
}

function exactPhrase(value: string): string {
  const phrase = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)) {
    throw new InvalidPublicQuery('invalid public title/body term');
  }
  return `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
}

/** Two field bindings on one admitted public MatchUnit. Each field contributes
 * one score; graph paths and unrelated rdfs:label resources contribute none. */
export async function queryPublicMainTitleBody(env: WorkActivationEnvironment,
  input: PublicMainTitleBodyQuery) {
  const title = exactPhrase(input.titleTerm);
  const body = exactPhrase(input.bodyTerm);
  if ((input.author !== undefined && !nativeId.test(input.author))
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid public title/body selector');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTitleReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?indexGeneration ?titleCount ?bodyCount
      ?unit ?titleScore ?bodyScore ?work ?main ?contribution ?revision ?selection ?language
      ?resultWork ?resultMain ?chapterTitle WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:sequence ?sequence ; rv:textIndexGeneration ?indexGeneration .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      { SELECT (COUNT(?rawTitle) AS ?titleCount) WHERE {
        { SELECT ?rawTitle WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawTitle ?rawTitleScore) text:query (rv:publicTitle ${lit(title)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      { SELECT (COUNT(?rawBody) AS ?bodyCount) WHERE {
        { SELECT ?rawBody WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawBody ?rawBodyScore) text:query (rv:searchBody ${lit(body)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?titleScore) text:query (rv:publicTitle ${lit(title)} ${PHRASE_HIT_PROBE}) .
          (?unit ?bodyScore) text:query (rv:searchBody ${lit(body)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:context ?main ;
            rv:contribution ?contribution ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language ;
            rv:publicTitle ?publicTitle ; rv:searchBody ?publicBody .
          OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
            rv:searchChapterTitle ?chapterTitle . }
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?main rv:selectionHead ?selection .
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })
        FILTER(BOUND(?resultWork) || NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?work schema:isPartOf ?parentWork } })
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
      }
    }`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = result.results?.bindings ?? [];
  await assertQuerySnapshotMoved(env.fuseki, index, rows, 'indexGeneration');
  const first = rows[0];
  if (!first?.epoch || !first.sequence || !first.indexGeneration
    || first.epoch.value !== index.dataEpoch || first.sequence.value !== index.sequence
    || first.indexGeneration.value !== index.generation
    || rows.some(row => row.epoch?.value !== first.epoch!.value
      || row.sequence?.value !== first.sequence!.value
      || row.indexGeneration?.value !== index.generation
      || row.titleCount?.value !== first.titleCount?.value
      || row.bodyCount?.value !== first.bodyCount?.value)) {
    throw new PublicQueryUnavailable('title/body search snapshot is unavailable');
  }
  const titleCount = Number(first.titleCount?.value);
  const bodyCount = Number(first.bodyCount?.value);
  if (![titleCount, bodyCount].every(count => Number.isSafeInteger(count) && count >= 0)) {
    throw new PublicQueryUnavailable('title/body candidate count is invalid');
  }
  if (titleCount >= PHRASE_HIT_PROBE || bodyCount >= PHRASE_HIT_PROBE) {
    throw new PublicQueryBudgetExceeded('title/body candidate budget exceeded');
  }
  const matches = rows.filter(row => row.unit).map(row => {
    if (!row.unit || !row.titleScore || !row.bodyScore || !row.work || !row.main
      || !row.contribution || !row.revision || !row.selection || !row.language) {
      throw new PublicQueryUnavailable('title/body result is incomplete');
    }
    if (row.resultWork && (!row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('chapter search identity is incomplete');
    }
    const titleScore = Number(row.titleScore.value), bodyScore = Number(row.bodyScore.value);
    if (!Number.isFinite(titleScore) || !Number.isFinite(bodyScore)) {
      throw new PublicQueryUnavailable('title/body score is invalid');
    }
    return { matchUnit: row.unit.value, work: row.resultWork?.value ?? row.work.value,
      mainVersion: row.resultMain?.value ?? row.main.value,
      contribution: row.contribution.value, revision: row.revision.value,
      selection: row.selection.value, language: row.language.value,
      score: titleScore + bodyScore,
      ...(row.resultWork ? { matchedChapter: { work: row.work.value,
        title: row.chapterTitle!.value } } : {}) };
  });
  if (new Set(matches.map(match => match.matchUnit)).size !== matches.length) {
    throw new PublicQueryUnavailable('title/body relation has duplicate units');
  }
  const results = rankedSearchMatches(await discloseSearchMatches(env, matches));
  return { profile: 'public-main-title-body-v1' as const, contractVersion: '1' as const,
    resultGrain: 'mainVersion' as const, context: 'main-version-default' as const,
    complete: true as const, population: index.population, indexGeneration: index.generation,
    total: results.length, results,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: first.epoch.value,
      sequence: first.sequence.value } };
}
