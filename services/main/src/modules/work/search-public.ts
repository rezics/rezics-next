import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSnapshotMoved,
  MAX_SEARCH_RESPONSE_BYTES, PHRASE_HIT_PROBE, SearchSnapshotMoved } from './search-readiness.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionSlotIri }
  from '../classification/decision.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';

export class InvalidPublicQuery extends Error {}
export class PublicQueryBudgetExceeded extends Error {}
export class PublicQueryUnavailable extends Error {}
export class PublicRealmUnavailable extends Error {}

export interface PublicMainPhraseQuery {
  phrase: string;
  language: string | null;
  /** Exact author of the currently selected public Contribution. */
  author?: string;
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
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language WHERE {
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
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?contribution ;
            rv:context ?main ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?main rv:selectionHead ?selection .
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
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
    || left.mainVersion.localeCompare(right.mainVersion)
    || left.matchUnit.localeCompare(right.matchUnit));
  return { contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: 'main-version-default' as const, complete: true as const, population: index.population,
    indexGeneration: index.generation,
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
    || (input.author !== undefined && !nativeId.test(input.author))
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))) {
    throw new InvalidPublicQuery('invalid Realm text query');
  }
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const realm = input.context.id;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?unit ?score ?work ?main ?contribution
      ?revision ?selection ?language ?reason WHERE {
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
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
          OPTIONAL { ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ?main ; rv:selectionHead ?local }
          OPTIONAL { ?main rv:selectionHead ?fallback }
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        BIND(COALESCE(?local, ?fallback) AS ?effectiveSelection)
        BIND(IF(BOUND(?local), ${iri(realm)}, ?main) AS ?effectiveContext)
        BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
        FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext)
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
    || left.mainVersion.localeCompare(right.mainVersion)
    || left.matchUnit.localeCompare(right.matchUnit));
  return { contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: { kind: 'realm-local' as const, id: realm },
    complete: true as const, population: index.population, total: matches.length, results: matches,
    indexGeneration: index.generation,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value } };
}

async function assertClassificationQueryScope(env: WorkActivationEnvironment,
  sense: string, realm: string | undefined,
  position: { dataEpoch: string; sequence: string; generation: string }) {
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
  }`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
    || rows[0]?.sequence?.value !== position.sequence || !rows[0]?.context) {
    if (rows.length === 0) await assertSnapshotMoved(env.fuseki, position);
    if (rows.length === 1 && rows[0]?.epoch?.value === position.dataEpoch
      && rows[0]?.sequence?.value !== position.sequence) {
      throw new SearchSnapshotMoved('classification scope crossed graph positions');
    }
    throw new PublicQueryUnavailable('classification scope is unavailable at query position');
  }
  return rows[0].context.value;
}

/** Bounded complete phrase results filtered by current direct classification. */
async function qualifyPublicPhrase<T extends { results: Array<{ work: string; mainVersion: string }>;
  sourcePosition: { dataEpoch: string; sequence: string };
  indexGeneration: string; total: number }>(
  env: WorkActivationEnvironment, base: T, sense: string, realm?: string,
) {
  const context = await assertClassificationQueryScope(env, sense, realm,
    { ...base.sourcePosition, generation: base.indexGeneration });
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
