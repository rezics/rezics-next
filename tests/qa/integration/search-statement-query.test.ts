import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, iri, lit,
  type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { queryPublicRealmClassifiedRatedPhrase }
  from '../../../services/main/src/modules/work/search-joined.ts';
import { pageCompletePublicRelation, SearchContinuationRestart }
  from '../../../services/main/src/modules/work/search-continuation.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { SELECTION_POLICY } from '../../../services/main/src/modules/space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT }
  from '../../../services/main/src/modules/classification/context.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE }
  from '../../../services/main/src/modules/statement/schema.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE } from '../../../services/main/src/modules/rating/context.ts';
import { STANDING_RATING_OBSERVATION_PROFILE }
  from '../../../services/main/src/modules/rating/observation.ts';

const id = (number: number) => `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const binding = (value: string) => ({ type: 'literal', value });

test('SEARCH01/SEARCH04: one native graph/text read preserves scores across three rating paths', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const native = new FusekiClient(Bun.env.FUSEKI_URL);
  const suffix = [...randomUUID().replaceAll('-', '').slice(0, 8)]
    .map(digit => String.fromCodePoint(0x4e00 + Number.parseInt(digit, 16) * 17))
    .join('');
  const phrase = `星海远航${suffix}`;
  const realm = id(7), sense = id(8), ratingContext = id(9);
  const context = id(10), contextHead = id(11), senseHead = id(12), expression = id(13);
  const concept = id(14), ratingHead = id(15), space = id(16);
  const works = [id(21), id(22)];
  const mains = [id(31), id(32)];
  const units = ['urn:rezics:match:statement-a', 'urn:rezics:match:statement-b'];
  const keys = [`urn:rezics:meaning:${'a'.repeat(64)}`,
    `urn:rezics:meaning:${'b'.repeat(64)}`];
  const definitions = works.map((work, index) => {
    const main = mains[index]!;
    const statement = id(41 + index), slot = `urn:rezics:decision-slot:statement-${index}`;
    const additionalSupport = index === 0 ? id(43) : null;
    const statementHead = id(121 + index), additionalHead = additionalSupport ? id(123) : null;
    const decision = id(51 + index), selection = id(61 + index);
    return `GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a schema:CreativeWork ; rv:mainVersion ${iri(main)} .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} ; rv:selectionHead ${iri(selection)} .
      ${iri(statement)} a rdf:Statement ; rv:statementState rv:Active ;
        rdf:subject ${iri(main)} ; rdf:predicate <${CLASSIFIED_AS}> ;
        rdf:object ${iri(concept)} ;
        rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
        rv:interpretationDefinition ${iri(senseHead)} ; rv:meaningKey ${iri(keys[index]!)} ;
        rv:speaker ${iri(id(1))} ; rv:head ${iri(statementHead)} .
      ${additionalSupport ? `${iri(additionalSupport)} a rdf:Statement ; rv:statementState rv:Active ;
        rdf:subject ${iri(main)} ; rdf:predicate <${CLASSIFIED_AS}> ;
        rdf:object ${iri(concept)} ; rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
        rv:interpretationDefinition ${iri(senseHead)} ; rv:meaningKey ${iri(keys[index]!)} ;
        rv:speaker ${iri(id(1))} ; rv:head ${iri(additionalHead!)} .` : ''}
      ${iri(slot)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
        rv:decisionTarget ${iri(keys[index]!)} ;
        rv:acceptanceContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
        rv:decisionHead ${iri(decision)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(selection)} a rv:PublicationSelection ; rv:mainVersion ${iri(main)} ; rv:language "zh" .
      ${iri(statementHead)} a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${iri(statement)} .
      ${additionalSupport ? `${iri(additionalHead!)} a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(additionalSupport)} .` : ''}
      ${iri(decision)} a rv:StatementDecision, rv:RevisionAnchor ;
        rv:component ${iri(slot)} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
        rv:outcome rv:Accepted ; rv:support ${iri(statement)}
          ${additionalSupport ? `, ${iri(additionalSupport)}` : ''} .
    }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ${iri(units[index]!)} a rv:MatchUnit ; rv:disclosure rv:Public ;
        rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ; rv:context ${iri(main)} ;
        rv:contribution ${iri(id(71 + index))} ; rv:revision ${iri(id(81 + index))} ;
        rv:selection ${iri(selection)} ; rv:language "zh" ;
        rv:searchBody ${lit(`${phrase} 中文词组`)}@zh .
    }`;
  }).join('\n');
  const observations = [
    { observation: id(91), main: mains[0]!, value: 9, slot: 'a' },
    { observation: id(92), main: mains[0]!, value: 7, slot: 'b' },
    { observation: id(93), main: mains[1]!, value: 8, slot: 'c' },
  ].map((item, index) => `GRAPH ${iri(GRAPHS.current)} {
    ${iri(item.observation)} a rv:RatingObservation ;
      rv:ratingContext ${iri(ratingContext)} ; rv:targetMainVersion ${iri(item.main)} ;
      rv:ratingSlot <urn:rezics:rating-slot:${item.slot.repeat(64)}> ;
      rv:observationHead ${iri(id(101 + index))} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(id(101 + index))} a rv:RatingObservationRevision, rv:RevisionAnchor ;
        rv:component ${iri(item.observation)} ; rv:observation ${iri(item.observation)} ;
        rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
        rv:ratingAvailability rv:Available ; rv:ratingValue ${item.value} ;
        rv:manifest <urn:rezics:sha256:${item.slot.repeat(64)}> .
    }`).join('\n');
  await native.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} ?predicate ?object . } }`);
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX schema: <https://schema.org/>
    INSERT DATA {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch "epoch" ;
        rv:sequence 7 ; rv:textIndexGeneration ${iri(generation)} . }
      GRAPH ${iri(GRAPHS.receipts)} {
        <urn:rezics:receipt:statement-search-fixture> a rv:OperationReceipt ;
          rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ;
          rv:decisionModel <https://rezics.com/vocab/StatementDecisions> . }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(space)} a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:classificationContext ${iri(context)} ; rv:ratingContext ${iri(ratingContext)} .
        ${iri(context)} a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ${iri(contextHead)} .
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ${iri(senseHead)} ; rv:expression ${iri(expression)} .
        ${iri(expression)} a rv:ClassificationExpression ; rv:expressionState rv:Active ;
          rv:assertedConcept ${iri(concept)} .
        ${iri(ratingContext)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ${iri(ratingHead)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(contextHead)} a rv:RevisionAnchor ; rv:component ${iri(context)} .
        ${iri(senseHead)} a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
        ${iri(ratingHead)} a rv:RevisionAnchor ; rv:component ${iri(ratingContext)} .
      }
      ${definitions}
      ${observations}
    }`);
  const indexed = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?unit ?score WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      (?unit ?score) text:query (rv:searchBody ${lit(`"${phrase}"`)} 513) .
    } }`);
  expect(indexed.results?.bindings).toHaveLength(2);
  const decisionBindings = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?unit ?main ?decision WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        (?unit ?score) text:query (rv:searchBody ${lit(`"${phrase}"`)} 513) .
        ?unit a rv:MatchUnit ; rv:mainVersion ?main . }
      GRAPH ${iri(GRAPHS.current)} {
        ?statement a rdf:Statement ; rv:statementState rv:Active ;
          rdf:subject ?main ; rdf:predicate <${CLASSIFIED_AS}> ;
          rv:interpretationDefinition ${iri(senseHead)} ; rv:meaningKey ?key .
        ?slot a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
          rv:decisionTarget ?key ; rv:acceptanceContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:decisionHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:StatementDecision, rv:RevisionAnchor ; rv:component ?slot ;
          rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
          rv:support ?statement ; rv:outcome rv:Accepted . }
    }`);
  expect(decisionBindings.results?.bindings).toHaveLength(3);
  const ratingBindings = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?observation ?main ?value WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?observation a rv:RatingObservation ; rv:ratingContext ${iri(ratingContext)} ;
          rv:targetMainVersion ?main ; rv:observationHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?head a rv:RatingObservationRevision, rv:RevisionAnchor ;
          rv:component ?observation ; rv:observation ?observation ;
          rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
          rv:ratingAvailability rv:Available ; rv:ratingValue ?value . }
    }`);
  expect(ratingBindings.results?.bindings).toHaveLength(3);
  const selectedBindings = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?unit ?main WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        (?unit ?score) text:query (rv:searchBody ${lit(`"${phrase}"`)} 513) .
        ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:work ?work ;
          rv:mainVersion ?main ; rv:context ?main ; rv:selection ?selection ;
          rv:language "zh" . }
      GRAPH ${iri(GRAPHS.current)} {
        ?work a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ?work ; rv:selectionHead ?selection . }
    }`);
  expect(selectedBindings.results?.bindings).toHaveLength(2);
  const scopeBindings = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?classificationContext ?senseRevision WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:classificationContext ?classificationContext ;
          rv:ratingContext ${iri(ratingContext)} .
        ?classificationContext a rv:ClassificationContext ;
          rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ?classificationContextRevision .
        ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ?senseRevision .
        ${iri(ratingContext)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ?ratingContextRevision . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?classificationContextRevision a rv:RevisionAnchor ; rv:component ?classificationContext .
        ?senseRevision a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
        ?ratingContextRevision a rv:RevisionAnchor ; rv:component ${iri(ratingContext)} . }
    }`);
  expect(scopeBindings.results?.bindings).toHaveLength(1);
  const groupedRatings = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?main (COUNT(?observation) AS ?count) (SUM(?value) AS ?sum) WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:RatingObservation ;
        rv:ratingContext ${iri(ratingContext)} ; rv:targetMainVersion ?main ;
        rv:observationHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head rv:ratingAvailability rv:Available ;
        rv:ratingValue ?value . }
    } GROUP BY ?main`);
  expect(groupedRatings.results?.bindings).toHaveLength(2);
  let joinedReads = 0;
  const fuseki = { commandHealth: async () => ({ moduleVersion: COMMAND_MODULE_VERSION,
    profiles: {}, instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    publicSearchDeltaAvailable: false }),
  query: async (sparql: string): Promise<SparqlResult> => {
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) return { results: { bindings: [{
      epoch: binding('epoch'), sequence: binding('7'), generation: binding(generation), population: binding('2') }] } };
    if (sparql.includes('rv:publicTextInventory()')) return { results: { bindings: [{
      population: binding('2') }] } };
    if (sparql.includes('?ratingPopulation') && sparql.includes('text:query')) {
      joinedReads++;
      const answer = await native.query(sparql);
      return answer;
    }
    if (sparql.includes('VALUES (?main ?key ?decision ?context)')
      || sparql.includes('VALUES ?statement')) return native.query(sparql);
    return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding('7'),
      generation: binding(generation) }] } };
  } } as FusekiClient;
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  const result = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(result.complete).toBe(true);
  expect(result.total).toBe(2);
  expect(new Set(result.results.map(row => row.mainVersion))).toEqual(new Set(mains));
  expect(result.results.find(row => row.mainVersion === mains[0])?.rating)
    .toMatchObject({ count: 2, sum: 16 });
  expect(result.results.find(row => row.mainVersion === mains[0])?.classification)
    .toMatchObject({ supportingStatementCount: 2,
      supportingStatements: [id(41), id(43)] });
  expect(result.results.find(row => row.mainVersion === mains[1])?.rating)
    .toMatchObject({ count: 1, sum: 8 });
  expect(result.results.find(row => row.mainVersion === mains[1])?.classification)
    .toMatchObject({ supportingStatementCount: 1, supportingStatements: [id(42)] });
  expect(result.results.every(row => row.classification.application === null)).toBe(true);
  const rawScores = new Map(indexed.results!.bindings.map(row =>
    [row.unit!.value, Number(row.score!.value)]));
  expect(result.results.every(row => row.score === rawScores.get(row.matchUnit))).toBe(true);
  expect(joinedReads).toBe(1);

  const replacementDefinition = id(112);
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(senseHead)} . } }
    INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(sense)} rv:head ${iri(replacementDefinition)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(replacementDefinition)} a rv:RevisionAnchor ; rv:component ${iri(sense)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} . } }
    WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(senseHead)} . } }`);
  const changedDefinition = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(changedDefinition.total).toBe(0);
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(sense)} rv:head ${iri(replacementDefinition)} . } }
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} rv:head ${iri(senseHead)} . } }
    WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(sense)} rv:head ${iri(replacementDefinition)} . } }`);

  const pageInput = { profile: 'public-realm-classified-rated-phrase-page-v1' as const,
    context: { kind: 'realm-local' as const, id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80, pageSize: 1 };
  const firstPage = pageCompletePublicRelation(pageInput, result);
  expect(firstPage.next).not.toBeNull();
  const localSlot = 'urn:rezics:decision-slot:statement-local-a';
  const localDecision = id(111);
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(localSlot)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
          rv:decisionTarget ${iri(keys[0]!)} ; rv:acceptanceContext ${iri(context)} ;
          rv:decisionHead ${iri(localDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(localDecision)} a rv:StatementDecision, rv:RevisionAnchor ;
          rv:component ${iri(localSlot)} ;
          rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
          rv:outcome rv:Rejected ; rv:support ${iri(id(41))} . }
    }`);
  const readsBeforeDenial = joinedReads;
  const denied = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(joinedReads).toBe(readsBeforeDenial + 1);
  expect(denied.results.map(row => row.mainVersion)).toEqual([mains[1]]);
  expect(() => pageCompletePublicRelation({ ...pageInput, continuation: firstPage.next! },
    denied)).toThrow(SearchContinuationRestart);
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Rejected . } }
    INSERT { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Accepted . } }
    WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Rejected . } }`);
  const locallyAccepted = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(locallyAccepted.results.find(row => row.mainVersion === mains[0])?.classification)
    .toMatchObject({ decision: localDecision, source: 'local', sourceContext: context });
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Accepted . } }
    INSERT { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Withdrawn . } }
    WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(localDecision)} rv:outcome rv:Accepted . } }`);
  const localWithdrawn = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(localWithdrawn.results.find(row => row.mainVersion === mains[0])?.classification)
    .toMatchObject({ decision: id(51), source: 'inherited-global' });
  await native.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(id(42))} rv:statementState rv:Active . } }
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(id(42))} rv:statementState rv:Withdrawn . } }
    WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(id(42))} rv:statementState rv:Active . } }`);
  const withdrawn = await queryPublicRealmClassifiedRatedPhrase(env, {
    context: { kind: 'realm-local', id: realm }, phrase, language: 'zh',
    sense, ratingContext, minimumMeanTimes10: 80,
  });
  expect(withdrawn.results.map(row => row.mainVersion)).toEqual([mains[0]]);
});
