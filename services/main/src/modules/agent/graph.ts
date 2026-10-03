import { createHash } from 'node:crypto';
import { FusekiClient } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, PROFILE as MODEL_HEAD, RV, hash, iri, lit,
  prepareComponent, prepareWorkComponent, type WorkActivationEnvironment }
  from '../work/activate.ts';

export type AgentKind = 'person' | 'organization' | 'service';
export interface AgentGraphIntent { id: string; agent: string; kind: AgentKind;
  displayName: string; digest: string }
export interface AgentGraphReceipt { dataEpoch: string; sequence: string }
export class AgentGraphInvalid extends Error {}
export class AgentGraphPending extends Error {}

const AGENT_PROFILE = 'https://rezics.com/definition/agent-provision-v1';
const AGENT_SHAPE = `${AGENT_PROFILE}/agent-shape`;
const TOMBSTONE_SHAPE = `${AGENT_PROFILE}/tombstone-shape`;
const RECEIPT_PREFIX = 'urn:rezics:receipt:agent-provision:';
const kindIri: Record<AgentKind, string> = {
  person: 'PersonAgent', organization: 'OrganizationAgent', service: 'ServiceAgent',
};
export const agentCreateReceipt = (id: string) => `${RECEIPT_PREFIX}${id}`;
export const agentCompensationReceipt = (id: string) => `urn:rezics:receipt:agent-compensation:${id}`;

async function readReceipt(fuseki: FusekiClient, receipt: string,
  digest: string): Promise<AgentGraphReceipt | null> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ?digest ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  }`, 8192);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new AgentGraphPending('Agent receipt cardinality is invalid');
  const row = rows[0];
  if (!row) return null;
  if (row.digest?.value !== digest || !row.epoch || !row.sequence) {
    throw new AgentGraphInvalid('Agent graph receipt binds a different intent');
  }
  return { dataEpoch: row.epoch.value, sequence: row.sequence.value };
}

/** One indexed receipt read, one profile lookup, one bounded graph command and
 * one reconciliation read. Work and bytes are O(1 + displayName bytes),
 * independent of the number of Agents or principals. */
export async function createAgentGraph(env: WorkActivationEnvironment,
  intent: AgentGraphIntent): Promise<AgentGraphReceipt> {
  const receipt = agentCreateReceipt(intent.id);
  const prior = await readReceipt(env.fuseki, receipt, intent.digest);
  if (prior) return prior;
  const revision = `${ID}${intent.id}-agent-revision`;
  const operation = `urn:rezics:operation:agent-provision:${intent.id}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const validations = await profileValidations(env.fuseki, 'agent-provision-v1', [
    { shape: AGENT_SHAPE, focus: [intent.agent], graphs: [GRAPHS.current] },
  ]);
  validations.push(...await profileValidations(env.fuseki, 'agent-profile-address-v1', [
    { shape: 'https://rezics.com/definition/agent-profile-address-v1/profile-shape',
      focus: [intent.agent], graphs: [GRAPHS.current] },
  ]));
  const state = { kind: intent.kind, displayName: intent.displayName, disclosure: 'public' };
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, intent.agent, state, AGENT_PROFILE)
    : prepareComponent(env.objectDirectory, intent.agent, state, AGENT_PROFILE);
  const update = `PREFIX rv: <${RV}>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n` +
    `DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }\n` +
    `INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }\n` +
    ` GRAPH ${iri(GRAPHS.current)} { ${iri(intent.agent)} a rv:Agent ;
       rv:agentKind rv:${kindIri[intent.kind]} ; rdfs:label ${lit(intent.displayName)} ;
       rv:profileStateFormat rv:AddressedAgentProfileV1 ; rv:profileNameFormat rv:PlainNameAddressV1 ;
       rv:profileDisclosure rv:Public ;
       rv:head ${iri(revision)} . }\n` +
    ` GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
       rv:component ${iri(intent.agent)} ; rv:operation ${iri(operation)} ;
       rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
       rv:modelRevision ${iri(AGENT_PROFILE)} ; rv:shapeRevision ${iri(AGENT_PROFILE)} ;
       rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
       rv:sequence ?next . }\n` +
    ` GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
       rv:operation ${iri(operation)} ; rv:requestDigest ${lit(intent.digest)} ;
       rv:outcome rv:Succeeded ; rv:agent ${iri(intent.agent)} ;
       rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
       rv:sequence ?next . }\n` +
    ` GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
       rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
       rv:eventCount 1 ; rv:event ${iri(event)} .
       ${iri(event)} a rv:AgentCreatedEvent ; rv:ordinal 0 ;
       rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ;
       rv:agent ${iri(intent.agent)} . } } WHERE {
       GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
         rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ;
         rv:modelHead ${iri(MODEL_HEAD)} ; rv:shapeHead ${iri(MODEL_HEAD)} . }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(intent.agent)} ?p ?o } }
       BIND(?n + 1 AS ?next) }`;
  let result;
  try {
    result = await env.fuseki.commandWithReceipt({ receipt, digest: intent.digest, update,
      validations, deadlineMs: 10_000 });
  } catch {
    const recovered = await readReceipt(env.fuseki, receipt, intent.digest);
    if (recovered) return recovered;
    throw new AgentGraphPending('Agent graph outcome is unknown');
  }
  if (result.status === 'invalid' || result.status === 'unknown-profile') {
    throw new AgentGraphInvalid(`Agent profile rejected: ${result.status}`);
  }
  const committed = await readReceipt(env.fuseki, receipt, intent.digest);
  if (committed) return committed;
  throw new AgentGraphPending(`Agent graph receipt is absent after ${result.status}`);
}

/** Compensation is a second receipted operation. It replaces this Agent's
 * public current state with a tombstone; the creation revision remains. */
export async function compensateAgentGraph(env: WorkActivationEnvironment,
  intent: AgentGraphIntent): Promise<AgentGraphReceipt | null> {
  const created = await readReceipt(env.fuseki, agentCreateReceipt(intent.id), intent.digest);
  if (!created) return null;
  const receipt = agentCompensationReceipt(intent.id);
  const digest = createHash('sha256').update(`agent-compensate-v1\0${intent.digest}`).digest('hex');
  const prior = await readReceipt(env.fuseki, receipt, digest);
  if (prior) return prior;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}>\nDELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.agent)} ?p ?o }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.agent)} a rv:AgentTombstone ;
      rv:compensatedFrom ${iri(agentCreateReceipt(intent.id))} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:AgentCompensatedEvent ; rv:ordinal 0 ;
      rv:receipt ${iri(receipt)} ; rv:agent ${iri(intent.agent)} . }
  } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.agent)} a rv:Agent ; ?p ?o . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?x ?y } }
    BIND(?n + 1 AS ?next) }`;
  const validations = await profileValidations(env.fuseki, 'agent-provision-v1', [
    { shape: TOMBSTONE_SHAPE, focus: [intent.agent], graphs: [GRAPHS.current] },
  ]);
  try { await env.fuseki.commandWithReceipt({ receipt, digest, update,
    validations, deadlineMs: 10_000 }); } catch { /* receipt decides */ }
  const committed = await readReceipt(env.fuseki, receipt, digest);
  if (!committed) throw new AgentGraphPending('Agent compensation receipt is absent');
  return committed;
}
