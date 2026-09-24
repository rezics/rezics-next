import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { ClassificationResolutionUnavailable, ClassificationTargetUnavailable,
  resolveClassification } from '../classification/resolve.ts';

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

async function assertClassificationQueryScope(env: WorkActivationEnvironment,
  sense: string, realm: string | undefined,
  position: { dataEpoch: string; sequence: string }) {
  if (!nativeId.test(sense)) throw new InvalidPublicQuery('invalid classification Sense');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?context WHERE {
    GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ?senseRevision .
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
        rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
      ${realm ? `?contextRevision a rv:RevisionAnchor ; rv:component ?context .` : ''}
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
    || rows[0]?.sequence?.value !== position.sequence || !rows[0]?.context) {
    throw new PublicQueryUnavailable('classification scope is unavailable at query position');
  }
}

/** Bounded complete phrase results filtered by current direct classification. */
async function qualifyPublicPhrase<T extends { results: Array<{ work: string; mainVersion: string }>;
  sourcePosition: { dataEpoch: string; sequence: string }; total: number }>(
  env: WorkActivationEnvironment, base: T, sense: string, realm?: string,
) {
  await assertClassificationQueryScope(env, sense, realm, base.sourcePosition);
  const decisions = new Map<string, Awaited<ReturnType<typeof resolveClassification>>>();
  const results = [];
  for (const match of base.results) {
    let effective = decisions.get(match.mainVersion);
    if (!effective) {
      try {
        effective = await resolveClassification(env, { work: match.work,
          mainVersion: match.mainVersion, sense,
          context: realm ? { kind: 'realm-classification', id: realm } : { kind: 'global' } });
      } catch (error) {
        if (error instanceof ClassificationResolutionUnavailable
          || error instanceof ClassificationTargetUnavailable) {
          throw new PublicQueryUnavailable('classification decision is unavailable');
        }
        throw error;
      }
      if (effective.sourcePosition.dataEpoch !== base.sourcePosition.dataEpoch
        || effective.sourcePosition.sequence !== base.sourcePosition.sequence) {
        throw new PublicQueryUnavailable('classification changed during public query');
      }
      decisions.set(match.mainVersion, effective);
    }
    if (effective.state === 'accepted') {
      results.push({ ...match, classification: { sense, decision: effective.decision,
        application: effective.application, source: effective.source,
        sourceContext: effective.sourceContext } });
    }
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
