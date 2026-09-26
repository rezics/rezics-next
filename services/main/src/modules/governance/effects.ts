import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContentModeration, ContentModerationConflict, ContentModerationStale }
  from '../../../../content/src/moderation.ts';
import type { DecisionTargetInput } from './store.ts';
import { GovernanceConflict, GovernanceStale, GovernanceUnavailable } from './store.ts';

export interface ModerationEffects {
  apply(operationId: string, ordinal: number, target: DecisionTargetInput): Promise<void>;
}

const receiptIri = (operationId: string, ordinal: number) =>
  `urn:rezics:receipt:moderation:${hash(`${operationId}:${ordinal}`)}`;
const effectIri = (operationId: string, ordinal: number) =>
  `urn:rezics:moderation:${hash(`${operationId}:${ordinal}`)}`;
const typed = (value: number) => `${lit(String(value))}^^<http://www.w3.org/2001/XMLSchema#integer>`;

/** Owner CAS is the last mutable-head gate before Access writes its fence. */
export function ownerModerationEffects(content: ContentModeration, env: WorkActivationEnvironment): ModerationEffects {
  return {
    async apply(operationId, ordinal, target) {
      if (target.owner === 'content') {
        if (!target.revision || !target.expectedHead || target.component !== 'body') {
          throw new GovernanceStale('Content moderation needs an exact draft head');
        }
        try {
          await content.apply({ operationId, ordinal, resource: target.resource, revision: target.revision,
            locator: target.locator, expectedHead: target.expectedHead, effect: target.effect });
        } catch (error) {
          if (error instanceof ContentModerationStale) throw new GovernanceStale('Content draft head changed');
          if (error instanceof ContentModerationConflict) throw new GovernanceConflict(error.message);
          throw error;
        }
        return;
      }
      if (target.owner !== 'graph' || !target.expectedHead) {
        throw new GovernanceUnavailable('moderation owner CAS is unavailable for this target');
      }
      const receipt = receiptIri(operationId, ordinal);
      const effect = effectIri(operationId, ordinal);
      const event = `urn:rezics:event:${hash(effect)}`;
      const operation = `urn:rezics:operation:${hash(operationId)}`;
      const requestDigest = hash(JSON.stringify({ operationId, ordinal, target }));
      const observed = async () => {
        const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?target ?head WHERE {
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ?digest ;
            rv:moderationTarget ?target ; rv:expectedHead ?head ;
            rv:application ${iri(effect)} ; rv:outcome rv:Succeeded . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(effect)} a rv:ModerationEffect ;
            rv:moderationTarget ?target ; rv:expectedHead ?head ;
            rv:moderationOperation ${lit(operationId)} ; rv:moderationEffect ${lit(target.effect)} . }
        }`);
        const rows = result.results?.bindings ?? [];
        if (!rows.length) return false;
        if (rows.length !== 1 || rows[0]?.digest?.value !== requestDigest
          || rows[0]?.target?.value !== target.resource || rows[0]?.head?.value !== target.expectedHead) {
          throw new GovernanceConflict('moderation graph operation differs');
        }
        return true;
      };
      if (await observed()) return;
      const profile = target.component === 'structure' ? 'structure-composition-v1'
        : 'work-metadata-v1';
      const shape = target.component === 'structure'
        ? 'https://rezics.com/definition/structure-composition-v1/structure-shape'
        : target.component === 'body'
          ? 'https://rezics.com/definition/work-metadata-v1/main-version-shape'
          : 'https://rezics.com/definition/work-metadata-v1/work-shape';
      const validations = await profileValidations(env.fuseki, profile, [{
        shape, focus: [target.resource], graphs: [GRAPHS.current, GRAPHS.revisions],
      }]);
      const headPredicate = target.component === 'structure' ? 'rv:structureHead' : 'rv:head';
      const result = await env.fuseki.commandWithReceipt({ receipt, digest: requestDigest,
        validations, deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
          PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
          DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
          INSERT {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
            GRAPH ${iri(GRAPHS.revisions)} { ${iri(effect)} a rv:ModerationEffect ;
              rv:moderationTarget ${iri(target.resource)} ; rv:expectedHead ${iri(target.expectedHead)} ;
              rv:moderationOperation ${lit(operationId)} ; rv:moderationEffect ${lit(target.effect)} ;
              rv:moderationOrdinal ${typed(ordinal)} . }
            GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
              rv:requestDigest ${lit(requestDigest)} ; rv:outcome rv:Succeeded ;
              rv:moderationTarget ${iri(target.resource)} ; rv:expectedHead ${iri(target.expectedHead)} ;
              rv:work ${iri(target.resource)} ; rv:application ${iri(effect)} ;
              rv:operation ${iri(operation)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next . }
            GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)}
              a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
              ${iri(event)} a rv:ModerationEffectAcceptedEvent ; rv:ordinal 0 ;
                rv:action ${lit('governance.moderation.apply')} ; rv:receipt ${iri(receipt)} ;
                rv:application ${iri(effect)} . }
          } WHERE {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
            GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} ${headPredicate} ${iri(target.expectedHead)} }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
            BIND(?n + 1 AS ?next)
          }` });
      if (result.status === 'invalid' || result.status === 'unknown-profile') {
        throw new GovernanceUnavailable('moderation graph profile is unavailable');
      }
      if (await observed()) return;
      if (result.status === 'guard-unmatched') throw new GovernanceStale('graph head changed');
      throw new GovernanceUnavailable('moderation graph outcome requires retry');
    },
  };
}
