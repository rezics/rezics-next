import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContentModeration, ContentModerationConflict, ContentModerationStale }
  from '../../../../content/src/moderation.ts';
import type { DecisionOutcome, DecisionTargetInput } from './store.ts';
import { GovernanceConflict, GovernanceStale, GovernanceUnavailable } from './store.ts';
import type { Pool } from 'pg';
import { MediaStore, MediaStale, copySuppressionId,
  type CopySuppression, type CopySuppressionLift } from '../media/store.ts';
import type { ContentCore } from '../../../../content/src/core.ts';

export interface EffectPlan {
  participant?: string;
  media?: { source: string; state: string; digest: string };
  ncii?: boolean;
  suppression?: CopySuppression;
  lift?: CopySuppressionLift;
  outcome?: DecisionOutcome;
}
export interface EffectReceipt {
  receipt: string;
  continuation?: string | null;
}
export class KnownEffectFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Every restriction label has an owner, including Access-local fences. */
export const restrictionOwners = {
  disclosure: 'target',
  publication: 'target',
  participation: 'access',
  capability: 'access',
  search: 'access',
  raw_delivery: 'target',
  media_delivery: 'media',
  export: 'access',
  source_apply: 'access',
} as const;

export interface ModerationEffects {
  plan?(target: DecisionTargetInput, outcome: DecisionOutcome, context?: {
    caseId: string; decisionId: string; reversesDecisionId: string | null;
    ncii: boolean; appealUpheld: boolean;
  }): Promise<EffectPlan>;
  apply(operationId: string, ordinal: number, target: DecisionTargetInput,
    plan?: EffectPlan,
    continuation?: string | null,
  ): Promise<void | EffectReceipt>;
}

const receiptIri = (operationId: string, ordinal: number) =>
  `urn:rezics:receipt:moderation:${hash(`${operationId}:${ordinal}`)}`;
const effectIri = (operationId: string, ordinal: number) =>
  `urn:rezics:moderation:${hash(`${operationId}:${ordinal}`)}`;
const typed = (value: number) => `${lit(String(value))}^^<http://www.w3.org/2001/XMLSchema#integer>`;

/** Owner CAS is the last mutable-head gate before Access writes its fence. */
export function ownerModerationEffects(content: ContentModeration, env: WorkActivationEnvironment,
  media?: { pool: Pool; core: ContentCore },
): ModerationEffects {
  const store = media ? new MediaStore(media.pool, media.core) : undefined;
  return {
    async plan(target, outcome, context) {
      const plan: EffectPlan = {};
      if (media && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target.resource)) {
        const original = (
          await media.pool.query<{
            owner: string;
            state_head: string;
            id: string;
            byte_digest: string;
          }>(
            `SELECT a.owner,a.state_head,p.id,p.byte_digest FROM media.asset a
           JOIN media.representation p ON p.asset_id = a.id AND p.kind = 'original'
           LEFT JOIN content.revision r ON r.id = $2::uuid
                      WHERE a.id = $1 AND (p.id = $2::uuid OR (r.variant_id = a.variant_id AND r.body @> jsonb_build_object(
             'representations',jsonb_build_array(jsonb_build_object('id',p.id::text))))) LIMIT 1`,
            [
              target.resource.slice(-36),
              target.revision && /^[0-9a-f-]{36}$/.test(target.revision.slice(-36))
                ? target.revision.slice(-36)
                : null,
            ],
          )
        ).rows[0];
        if (original) {
          plan.participant = original.owner;
          plan.media = {
            source: original.id,
            state: original.state_head,
            digest: original.byte_digest,
          };
          if (context?.ncii) {
            if (['restore', 'reverse'].includes(outcome)) {
              if (!context.appealUpheld || !context.reversesDecisionId)
                throw new GovernanceStale('identical-copy restoration requires an upheld appeal');
              const suppression = (await media.pool.query<{ id: string }>(
                `SELECT id FROM media.suppressed_digest d WHERE digest = $1
                  AND case_id = $2 AND decision_id = $3 AND NOT EXISTS (
                    SELECT 1 FROM media.suppression_lift l WHERE l.suppression_id = d.id)`,
                [original.byte_digest, context.caseId, context.reversesDecisionId])).rows[0];
              if (!suppression) throw new GovernanceStale('appealed copy suppression is unavailable');
              plan.lift = { id: suppression.id, caseId: context.caseId, decisionId: context.decisionId,
                reversesDecisionId: context.reversesDecisionId };
            } else {
              plan.suppression = { id: copySuppressionId(context.decisionId, original.byte_digest),
                caseId: context.caseId, decisionId: context.decisionId };
            }
          }
        }
        const reply = (
          await media.pool.query<{ author: string }>(
            'SELECT author FROM content.reply_author WHERE reply = $1',
            [target.resource],
          )
        ).rows[0];
        if (reply) plan.participant = reply.author;
        if (!plan.participant && target.owner === 'content' && target.revision) {
          const row = (
            await media.pool.query<{ author: string | null }>(
              "SELECT provenance->>'author' AS author FROM content.revision WHERE id = $1",
              [target.revision],
            )
          ).rows[0];
          if (row?.author) plan.participant = row.author;
        }
      }
      if (!plan.participant && target.owner === 'graph') {
        const rows =
          (
            await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?author WHERE {
          GRAPH ${iri(GRAPHS.current)} {
            { ${iri(target.resource)} rv:author ?author }
            UNION { ?credit a rv:NativeAgentCredit ; rv:work ${iri(target.resource)} ; rv:agent ?author }
            UNION { ${iri(target.resource)} a rv:Agent . BIND(${iri(target.resource)} AS ?author) }
          } } ORDER BY ?author LIMIT 1`)
          ).results?.bindings ?? [];
        plan.participant = rows[0]?.author?.value;
      }
      return plan;
    },
    async apply(operationId, ordinal, target, plan, continuation) {
      if (restrictionOwners[target.effect] === 'access')
        return { receipt: `access:governance-enforcement:${operationId}:${ordinal}` };
      if (plan?.media && store) {
        const receipt = `${operationId}:${ordinal}`;
        const restricted = !['restore', 'reverse'].includes(plan.outcome ?? 'restrict');
        try {
          // The original state receipt precedes digest closure. Replays reconcile
          // it before advancing a bounded copy batch.
          if (plan.ncii && !(restricted ? plan.suppression : plan.lift))
            throw new GovernanceStale('NCII decision has no saved suppression basis');
          await store.moderateOriginal(receipt, plan.media.source, plan.media.state, restricted, plan.lift);
          if (restricted && plan.ncii) {
            const result = await store.suppressIdenticalCopies(
              plan.media.digest,
              continuation ?? null,
              100,
              plan.suppression,
            );
            return { receipt, continuation: result.continuation };
          }
          if (!restricted && plan.lift) {
            const result = await store.restoreIdenticalCopies(plan.lift, continuation ?? null);
            return { receipt, continuation: result.continuation };
          }
          return { receipt };
        } catch (error) {
          if (error instanceof MediaStale) throw new GovernanceStale(error.message);
          throw error;
        }
      }
      if (target.owner === 'media')
        throw new GovernanceUnavailable('media original plan is unavailable');
      if (target.owner === 'review' || target.owner === 'source') {
        return { receipt: `access:governance-enforcement:${operationId}:${ordinal}` };
      }
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
        return { receipt: `content:receipt:${operationId}:${ordinal}` };
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
      if (await observed()) return { receipt };
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
      if (await observed()) return { receipt };
      if (result.status === 'guard-unmatched') throw new GovernanceStale('graph head changed');
      throw new GovernanceUnavailable('moderation graph outcome requires retry');
    },
  };
}
