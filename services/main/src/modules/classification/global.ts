import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, prepareWorkComponent, PendingActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

export const CLASSIFICATION_CONTEXT_PROFILE = 'https://rezics.com/definition/classification-context-v1';
export const GLOBAL_CLASSIFICATION_CONTEXT = 'urn:rezics:classification-context:global';
export const CLASSIFICATION_ISOLATE_POLICY = 'https://rezics.com/definition/classification-isolate-v1';
export const GLOBAL_CLASSIFICATION_PROFILE = 'https://rezics.com/definition/classification-global-context-v1';
export const GLOBAL_CLASSIFICATION_BOOTSTRAP_COST = { graphReads: 2, commands: 1,
  validations: 1, deadlineMs: 10_000 } as const;

export function globalClassificationTerminal(dataEpoch: string) {
  const digest = hash(JSON.stringify(['classification-global-bootstrap-v1', dataEpoch,
    GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY]));
  const receipt = `urn:rezics:receipt:${digest}`;
  return { digest, receipt, event: `urn:rezics:event:${hash(receipt)}`,
    batch: `urn:rezics:outbox:${hash(receipt)}` };
}

/** No process cache: a reset must bootstrap the new dataset, even in the same Main process.
 * Existing valid globals created by the Realm command remain usable. */
export async function ensureGlobalClassificationContext(env: WorkActivationEnvironment): Promise<void> {
  const control = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;
  const present = `PREFIX rv: <${RV}> ASK { ${control} GRAPH ${iri(GRAPHS.current)} {
    ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
      rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
      rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?realm }
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback }
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:contextRole ?role . FILTER(?role != rv:GlobalClassification) }
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:contextState ?state . FILTER(?state != rv:Active) }
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:inheritancePolicy ?policy .
      FILTER(?policy != ${iri(CLASSIFICATION_ISOLATE_POLICY)}) }
  } }`;
  if ((await env.fuseki.query(present)).boolean === true) return;
  const { receipt, digest, event, batch } = globalClassificationTerminal(env.lineage.dataEpoch);
  const revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const state = { role: 'global-classification', state: 'active', inheritancePolicy: CLASSIFICATION_ISOLATE_POLICY };
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, GLOBAL_CLASSIFICATION_CONTEXT, state, GLOBAL_CLASSIFICATION_PROFILE)
    : prepareComponent(env.objectDirectory, GLOBAL_CLASSIFICATION_CONTEXT, state, GLOBAL_CLASSIFICATION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'classification-global-context-v1', [
    { shape: `${GLOBAL_CLASSIFICATION_PROFILE}/global-shape`, focus: [GLOBAL_CLASSIFICATION_CONTEXT],
      graphs: [GRAPHS.current] },
  ]);
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations,
      deadlineMs: GLOBAL_CLASSIFICATION_BOOTSTRAP_COST.deadlineMs,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} ; rv:head ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
          rv:component ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(GLOBAL_CLASSIFICATION_PROFILE)} ; rv:shapeRevision ${iri(GLOBAL_CLASSIFICATION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:contextRevision ${iri(revision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:GlobalClassificationContextCreatedEvent ; rv:ordinal 0 ;
            rv:action "classification.global.bootstrap" ; rv:receipt ${iri(receipt)} . }
      }
      WHERE { ${control}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` });
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  } catch (error) { if (error instanceof CommandRejected) throw error; }
  // Resolve a lost response or another caller's winning command from authoritative state.
  if ((await env.fuseki.query(present)).boolean !== true) {
    throw new PendingActivation('Global classification context is unavailable');
  }
}
