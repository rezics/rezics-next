import { randomUUID } from 'node:crypto';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';

/** Retained private-profile state has no public edit operation. Install this
 * counterexample through the native writer so its name/prefix copies and
 * complete-writer proof change together, as they do for owner commands. */
export async function retainPrivateAgentProfile(env: WorkActivationEnvironment, agent: string) {
  const receipt = `urn:rezics:receipt:${hash(randomUUID())}`;
  const digest = hash(JSON.stringify({ agent, disclosure: 'private' }));
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const validations = await profileValidations(env.fuseki, 'agent-provision-v1', [{
    shape: 'https://rezics.com/definition/agent-provision-v1/agent-shape',
    focus: [agent], graphs: [GRAPHS.current],
  }]);
  const result = await env.fuseki.command({ receipt, digest, validations, deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence }
        GRAPH ${iri(GRAPHS.current)} { ${iri(agent)} rv:profileDisclosure rv:Public }
      } INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(agent)} rv:profileDisclosure rv:Private }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:AgentPublicProfileChangedEvent ; rv:ordinal 0 ;
            rv:receipt ${iri(receipt)} ; rv:agent ${iri(agent)} }
      } WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        GRAPH ${iri(GRAPHS.current)} { ${iri(agent)} a rv:Agent ; rv:profileDisclosure rv:Public }
        BIND(?sequence + 1 AS ?next)
      }` });
  if (result.status !== 'committed') throw new Error(`Private Agent fixture refused: ${JSON.stringify(result)}`);
}
