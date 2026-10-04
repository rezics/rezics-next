import { canonicalLanguage } from '../display-language/select.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import { SemanticTargetUnavailable } from '../semantic/command.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionCorrupt } from '../work/history.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';

/** An active Context inherits public disclosure from its actual owner. Global
 * populations never use a Realm role or an invented Realm membership. */
export function questionContextPattern(context: string) {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(context)} rv:contextState rv:Active ; rv:question ?authoredQuestion ; rv:head ?contextHead .
    { ${iri(context)} a ?questionContextKind ; rv:realm ?questionOwner .
      VALUES ?questionContextKind { rv:RatingContext rv:TargetRatingContext rv:ReleaseRatingContext }
      ?questionOwner a rv:Realm ; rv:realmState rv:Active ; rv:space ?questionSpace ; rv:ratingContext ${iri(context)} .
      ?questionSpace a rv:Space ; rv:realmCapability ?questionOwner ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?questionSpace rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?questionOwner rv:protectionHead ?ownerProtection }
    } UNION {
      ${iri(context)} a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .
      BIND(${iri(GLOBAL_RATING_POPULATION_OWNER)} AS ?questionOwner)
    } UNION {
      ${iri(context)} a rv:AcceptedTargetRatingContext ; rv:realm ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
        rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .
      ${iri(GLOBAL_RATING_POPULATION_OWNER)} a rv:GlobalRatingPopulation ; rv:ratingContext ${iri(context)} .
      BIND(${iri(GLOBAL_RATING_POPULATION_OWNER)} AS ?questionOwner)
    }
    FILTER NOT EXISTS { ${iri(context)} rv:protectionHead ?contextProtection }
  }
  GRAPH ${iri(GRAPHS.revisions)} { ?contextHead a rv:RevisionAnchor ; rv:component ${iri(context)} ;
    rv:manifest ?contextManifest ; rv:modelRevision ?contextProfile .
    FILTER NOT EXISTS { ?contextHead a rv:ErasedRevision } }`;
}

export async function readAuthoredRatingQuestion(env: WorkActivationEnvironment, context: string) {
  checkedNativeIri(context);
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?authoredQuestion ?contextHead ?contextManifest ?contextProfile ?questionOwner WHERE {
      ${questionContextPattern(context)} } LIMIT 2`)
    ).results?.bindings ?? [];
  if (!rows.length) throw new SemanticTargetUnavailable('Rating Context is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('Rating question is ambiguous');
  const row = rows[0]!;
  const language = canonicalLanguage(row.authoredQuestion?.['xml:lang'] ?? '');
  if (
    !language ||
    !row.contextHead ||
    !row.contextManifest ||
    !row.contextProfile ||
    !row.questionOwner
  ) {
    throw new RevisionCorrupt('Rating question has incomplete provenance');
  }
  const state = readComponentState(
    env.objectDirectory,
    row.contextManifest.value,
    context,
    row.contextProfile.value,
  );
  if (
    state.context !== context ||
    state.question !== row.authoredQuestion!.value ||
    (state.realm ?? state.populationOwner) !== row.questionOwner.value ||
    (state.language !== undefined && canonicalLanguage(String(state.language)) !== language)
  ) {
    throw new RevisionCorrupt('Authored rating question differs from its manifest');
  }
  return {
    context,
    revision: row.contextHead.value,
    question: row.authoredQuestion!.value,
    language,
    owner: row.questionOwner.value,
  };
}
