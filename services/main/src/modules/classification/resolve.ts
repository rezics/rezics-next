import { DATASET, GRAPHS, RV, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from './proposition.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from './context.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionSlotIri,
  type ClassificationDecisionContext } from './decision.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export class InvalidClassificationResolution extends Error {}
export class ClassificationResolutionUnavailable extends Error {}
export class ClassificationTargetUnavailable extends Error {}

export interface ClassificationResolutionInput {
  work: string;
  mainVersion: string;
  sense: string;
  context: ClassificationDecisionContext;
}

export async function resolveClassification(env: WorkActivationEnvironment,
  input: ClassificationResolutionInput) {
  if (!nativeId.test(input.work) || !nativeId.test(input.mainVersion)
    || !nativeId.test(input.sense)
    || (input.context.kind !== 'global' && (input.context.kind !== 'realm-classification'
      || !nativeId.test(input.context.id)))) {
    throw new InvalidClassificationResolution('invalid classification resolution request');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const realm = input.context.kind === 'realm-classification' ? input.context.id : undefined;
  const base = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?epoch ?sequence ?context ?contextRevision ?senseRevision WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${iri(input.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ?senseRevision .
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${realm ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
            rv:classificationContext ?context .
          ?context a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
            rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
            rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:head ?contextRevision .`
          : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)`}
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?senseRevision a rv:RevisionAnchor ;
        rv:component ${iri(input.sense)} ;
        rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} . }
    }`);
  const baseRows = base.results?.bindings ?? [];
  if (baseRows.length === 0) throw new ClassificationTargetUnavailable('classification target is unavailable');
  if (baseRows.length !== 1 || !baseRows[0]?.epoch || !baseRows[0].sequence
    || !baseRows[0].context || !baseRows[0].senseRevision
    || (realm && !baseRows[0].contextRevision)) {
    throw new ClassificationResolutionUnavailable('classification target is ambiguous');
  }
  const target = baseRows[0]!;
  const context = target.context!.value;
  const globalSlot = classificationDecisionSlotIri(input.mainVersion, input.sense,
    GLOBAL_CLASSIFICATION_CONTEXT);
  const localSlot = realm ? classificationDecisionSlotIri(input.mainVersion, input.sense, context)
    : undefined;
  const read = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?localApplication ?localDecision ?localOutcome
      ?globalApplication ?globalDecision ?globalOutcome WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(target.epoch!.value)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      ${localSlot ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ?localApplication rv:applicationKey ${iri(localSlot)} .
        OPTIONAL { ?localApplication a rv:ClassificationApplication ;
          rv:targetMainVersion ${iri(input.mainVersion)} ; rv:sense ${iri(input.sense)} ;
          rv:classificationContext ${iri(context)} ;
          rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
          rv:decisionHead ?localDecision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
            ?localDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
              rv:component ?localApplication ; rv:application ?localApplication ;
              rv:outcome ?localOutcome ;
              rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} . }
          }
        }
      } }` : ''}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ?globalApplication rv:applicationKey ${iri(globalSlot)} .
        OPTIONAL { ?globalApplication a rv:ClassificationApplication ;
          rv:targetMainVersion ${iri(input.mainVersion)} ; rv:sense ${iri(input.sense)} ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
          rv:decisionHead ?globalDecision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
            ?globalDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
              rv:component ?globalApplication ; rv:application ?globalApplication ;
              rv:outcome ?globalOutcome ;
              rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} . }
          }
        }
      } }
    }`);
  const rows = read.results?.bindings ?? [];
  if (rows.length !== 1) throw new ClassificationResolutionUnavailable('classification read is ambiguous');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  if (value('epoch') !== target.epoch!.value || value('sequence') !== target.sequence!.value
    || (value('globalApplication') && (!value('globalDecision') || !value('globalOutcome')))
    || (value('localApplication') && (!value('localDecision') || !value('localOutcome')))
    || [value('localOutcome'), value('globalOutcome')].some((outcome) => outcome
      && ![`${RV}Accepted`, `${RV}Rejected`].includes(outcome))) {
    throw new ClassificationResolutionUnavailable('classification resolution is incomplete');
  }
  const local = !!realm && !!value('localDecision');
  const global = !!value('globalDecision');
  const inherited = !!realm && !local && global;
  const decision = local ? value('localDecision') : global ? value('globalDecision') : undefined;
  const application = local ? value('localApplication') : global ? value('globalApplication') : undefined;
  const outcome = local ? value('localOutcome') : global ? value('globalOutcome') : undefined;
  return { work: input.work, mainVersion: input.mainVersion, sense: input.sense,
    requestedContext: input.context, classificationContext: context,
    contextRevision: target.contextRevision?.value ?? null,
    state: outcome === `${RV}Accepted` ? 'accepted' as const
      : outcome === `${RV}Rejected` ? 'rejected' as const : 'absent' as const,
    source: local ? 'local' as const : inherited ? 'inherited-global' as const
      : global ? 'global' as const : 'none' as const,
    sourceContext: decision ? (local ? context : GLOBAL_CLASSIFICATION_CONTEXT) : null,
    application: application ?? null, decision: decision ?? null,
    policy: realm ? CLASSIFICATION_INHERIT_POLICY : CLASSIFICATION_ISOLATE_POLICY,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: target.epoch!.value,
      sequence: target.sequence!.value } };
}
