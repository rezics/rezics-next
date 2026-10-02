import { GRAPHS, iri, lit } from '../work/activate.ts';
import {
  GLOBAL_CLASSIFICATION_CONTEXT,
  CLASSIFICATION_INHERIT_POLICY,
} from '../classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE } from '../statement/schema.ts';
import type { ClassificationAudience } from '../discovery/audience.ts';

/** Current classification meanings and local precedence follow the same two
 * owner representations as resolveClassification. The cutover is authoritative;
 * retained legacy decisions cannot overrule a later Statement withdrawal. */
export function acceptedClassification(
  main: string,
  concept: string,
  audience: ClassificationAudience,
  realm?: string,
  tag = 'class',
) {
  const v = (name: string) => `?${tag}${name}`;
  const sense = v('Sense'),
    expression = v('Expression'),
    context = v('Context'),
    decision = v('Decision'),
    application = v('Application'),
    key = v('Key'),
    support = v('Support');
  const cutover = `GRAPH ${iri(GRAPHS.receipts)} { ?${tag}Cutover a rv:OperationReceipt ;
    rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ; rv:decisionModel rv:StatementDecisions }`;
  const scope = (statement: boolean) =>
    !realm
      ? `FILTER(${context} = ${iri(GLOBAL_CLASSIFICATION_CONTEXT)})`
      : `FILTER(EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:classificationContext ${context} } }
      || (${context} = ${iri(GLOBAL_CLASSIFICATION_CONTEXT)}
        && NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:classificationContext ?${tag}Local .
          ?${tag}Local rv:inheritancePolicy ?${tag}Policy . FILTER(?${tag}Policy != ${iri(CLASSIFICATION_INHERIT_POLICY)}) } }
        && NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:classificationContext ?${tag}Local .
          ${
            statement
              ? `?${tag}Override a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
            rv:decisionTarget ${key} ; rv:acceptanceContext ?${tag}Local .`
              : `?${tag}Override a rv:ClassificationApplication ; rv:targetMainVersion ${main} ;
            rv:sense ${sense} ; rv:classificationContext ?${tag}Local .`
          } } }))`;
  const protects = audience.protection.map((policy) => {
    const accepted = [
      ...(policy.statements.length
        ? [`${support} IN (${policy.statements.map(iri).join(',')})`]
        : []),
      ...(policy.concepts.length
        ? [
            `(${concept} IN (${policy.concepts.map(iri).join(',')})
        ${policy.judged.length ? `&& ${support} NOT IN (${policy.judged.map(iri).join(',')})` : ''})`,
          ]
        : []),
    ];
    return accepted.length
      ? `(${
          policy.context === 'global'
            ? `${context} = ${iri(GLOBAL_CLASSIFICATION_CONTEXT)}`
            : `EXISTS { GRAPH ${iri(GRAPHS.current)} { ${context} rv:realm ${iri(policy.context)} } }`
        }
      && (${accepted.join(' || ')}))`
      : 'false';
  });
  return `{ { FILTER NOT EXISTS { ${cutover} }
      GRAPH ${iri(GRAPHS.current)} {
        ${sense} a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ${expression} .
        ${expression} rv:expressionState rv:Active ; rv:assertedConcept ${concept} .
        ${application} a rv:ClassificationApplication ; rv:applicationState rv:Active ;
          rv:applicationChannel rv:Curated ; rv:targetMainVersion ${main} ; rv:sense ${sense} ;
          rv:decisionHead ${decision} ; rv:classificationContext ${context} .
        ${context} a rv:ClassificationContext ; rv:contextState rv:Active . }
      GRAPH ${iri(GRAPHS.revisions)} { ${decision} a rv:ClassificationDecision, rv:RevisionAnchor ;
        rv:component ${application} ; rv:outcome rv:Accepted }
      ${scope(false)} }
    UNION { FILTER EXISTS { ${cutover} }
      GRAPH ${iri(GRAPHS.current)} {
        ${sense} a rv:ClassificationSense ; rv:senseState rv:Active ; rv:head ?${tag}SenseHead ; rv:expression ${expression} .
        ${expression} rv:expressionState rv:Active ; rv:assertedConcept ${concept} .
        ${support} a rdf:Statement ; rdf:subject ${main} ; rdf:predicate <${CLASSIFIED_AS}> ; rdf:object ${concept} ;
          rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
          rv:interpretationDefinition ?${tag}SenseHead ; rv:meaningKey ${key} ; rv:statementState rv:Active ; rv:head ?${tag}SupportHead .
        ?${tag}Slot a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ${key} ;
          rv:acceptanceContext ${context} ; rv:decisionHead ${decision} .
        ${context} a rv:ClassificationContext ; rv:contextState rv:Active .
        FILTER NOT EXISTS { ${support} rv:semanticContextRevision ?${tag}Pin .
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?${tag}Pin rv:component ?${tag}Basis }
            ?${tag}Basis rv:disclosure rv:Public } }
        FILTER NOT EXISTS { ${support} rv:speaker ?${tag}Speaker . ?${tag}Speaker a rv:Realm ; rv:space ?${tag}SpeakerSpace .
          FILTER NOT EXISTS { ?${tag}SpeakerSpace rv:disclosure rv:Public } }
        FILTER NOT EXISTS { ${support} rv:protectionHead ?${tag}Protected } }
      GRAPH ${iri(GRAPHS.revisions)} { ${decision} a rv:StatementDecision, rv:RevisionAnchor ;
        rv:component ?${tag}Slot ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ; rv:outcome rv:Accepted ; rv:support ${support} .
        ?${tag}SupportHead a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${support} .
        FILTER NOT EXISTS { ?${tag}SupportHead a rv:ErasedRevision } }
      ${scope(true)} FILTER(${protects.join(' || ') || 'false'}) } }`;
}

/** Exclude only today's enforced revision; suitability exclusions have no
 * revision. This is private policy input, never part of the returned count. */
export function countDisclosure(work: string, audience: ClassificationAudience, tag = 'count') {
  if (!audience.excluded.length) return '';
  return `FILTER NOT EXISTS { VALUES (?${tag}Resource ?${tag}Revision) {
    ${audience.excluded.map((row) => `(${lit(row.resource)} ${row.revision ? lit(row.revision) : 'UNDEF'})`).join(' ')} }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${work} rv:head ?${tag}Head } }
    FILTER(STR(${work}) = ?${tag}Resource && (!BOUND(?${tag}Revision) || STR(?${tag}Head) = ?${tag}Revision)) }`;
}
