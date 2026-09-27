import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

function agentEvent(kind: 'AgentCreatedEvent' | 'AgentCompensatedEvent',
  action: 'agent.provision' | 'agent.compensate', type: string): OwnerOutboxEventHandler {
  return { kind: `${RV}${kind}`, action, type, authority: 'system',
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const digest = value('digest');
      if (!receipt || !digest || value('outcome') !== `${RV}Succeeded`
        || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
        || eventId !== `urn:rezics:event:${hash(receipt)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Agent event differs from its source position');
      }
      const id = receipt.match(/^urn:rezics:receipt:agent-(?:provision|compensation):([0-9a-f-]{36})$/)?.[1];
      if (!id || receipt !== `urn:rezics:receipt:agent-${kind === 'AgentCreatedEvent'
        ? 'provision' : 'compensation'}:${id}`) {
        throw new Error('Agent event receipt identity is invalid');
      }
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?agent ?operation ?revision ?manifest WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ; rv:ordinal 0 ;
          rv:receipt ${iri(receipt)} ; rv:agent ?agent .
          ${kind === 'AgentCreatedEvent' ? `${iri(eventId)} rv:operation ?operation .` : ''} }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
            rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
            rv:sequence ${batch.sequence} .
          ${kind === 'AgentCreatedEvent'
            ? `${iri(receipt)} rv:agent ?agent ; rv:operation ?operation .`
            : `${iri(`urn:rezics:receipt:agent-provision:${id}`)} rv:agent ?agent ; rv:outcome rv:Succeeded .`}
        }
        ${kind === 'AgentCreatedEvent' ? `GRAPH ${iri(GRAPHS.revisions)} {
          ?revision rv:component ?agent ; rv:operation ?operation ; rv:manifest ?manifest ;
            rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }` : ''}
      } LIMIT 2`);
      const rows = result.results?.bindings ?? [];
      const agent = rows[0]?.agent?.value;
      if (rows.length !== 1 || !agent || (kind === 'AgentCreatedEvent'
        && (!rows[0]?.operation || !rows[0]?.revision
          || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(rows[0]?.manifest?.value ?? '')))) {
        throw new Error('Agent event has no unique terminal graph proof');
      }
      iri(agent);
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type, datacontenttype: 'application/json', data: { batchId: batch.batchId,
          routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
            sequence: batch.sequence },
          receipt: { id: receipt, action, outcome: 'succeeded', requestDigest: digest,
            systemProof: { kind: kind === 'AgentCreatedEvent' ? 'agent-created' : 'agent-compensated',
              agent, ...(rows[0]?.revision ? { revision: rows[0].revision.value,
                manifest: rows[0].manifest!.value } : {}) } } } };
    } };
}

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  agentEvent('AgentCreatedEvent', 'agent.provision', 'com.rezics.agent.created.v1'),
  agentEvent('AgentCompensatedEvent', 'agent.compensate', 'com.rezics.agent.compensated.v1'),
  { kind: `${RV}AgentPublicProfileChangedEvent`, action: 'agent.profile.change',
    type: 'com.rezics.agent.profile-changed.v1', authority: 'system',
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const digest = value('digest');
      if (!receipt || !/^urn:rezics:receipt:agent-profile:[0-9a-f]{64}$/.test(receipt)
        || !digest || value('outcome') !== `${RV}Succeeded`
        || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
        || eventId !== `urn:rezics:event:${hash(receipt)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Agent profile event differs from its source position');
      }
      const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?agent ?revision WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:AgentPublicProfileChangedEvent ;
          rv:ordinal 0 ; rv:receipt ${iri(receipt)} ; rv:agent ?agent ; rv:operation ?operation . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:agent ?agent ; rv:profileRevision ?revision ; rv:operation ?operation ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AgentPublicProfileRevision ;
          rv:component ?agent ; rv:operation ?operation ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      } LIMIT 2`)).results?.bindings ?? [];
      if (rows.length !== 1 || !rows[0]?.agent || !rows[0].revision) {
        throw new Error('Agent profile event has no unique terminal graph proof');
      }
      const agent = rows[0].agent.value;
      iri(agent);
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type: 'com.rezics.agent.profile-changed.v1', datacontenttype: 'application/json',
        data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          receipt: { id: receipt, action: 'agent.profile.change', outcome: 'succeeded',
            requestDigest: digest, systemProof: { kind: 'agent-profile-changed',
              agent, revision: rows[0].revision.value } } } };
    } },
];
