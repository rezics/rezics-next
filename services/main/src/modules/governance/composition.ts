import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { SourceIntakeStore } from '../source/intake.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from './evidence.ts';
import { graphNoticeParticipants, ownerModerationEffects } from './effects.ts';
import { ContentModeration } from '../../../../content/src/moderation.ts';
import { GovernanceRules } from './rules.ts';
import { GovernanceStore } from './store.ts';
import { ReviewReportOwner } from './report-review.ts';

/** Main's real owner readers; every evidence lookup stays on the pinned revision. */
export function governanceServices(accessPool: Pool, contentPool: Pool, content: ContentCore,
  source: SourceIntakeStore, registry: AccessAdmissionRegistry, env: WorkActivationEnvironment) {
  const rules = new GovernanceRules(accessPool);
  const reviews = new ReviewReportOwner(accessPool, registry, env);
  const evidence = ownerEvidenceCapture({
    content: { core: content, canRead: async (principal, actingSubject, ids) => {
      const disclosed = new Set<string>();
      for (const id of ids) {
        const resource = await content.owningResourceForRevision(id);
        if (resource &&
            ((await registry.canReadWork(principal, actingSubject, resource)) ||
              (
                await contentPool.query(
                  `SELECT 1 FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
            WHERE a.id = $1 AND s.disclosure = 'public' AND s.lifecycle = 'active' AND s.moderation = 'none'`,
                  [resource.slice(-36)],
                )
              ).rowCount)) disclosed.add(id);
      }
      return disclosed;
    } },
    graph: { env, canReadWork: (principal, actingSubject, work) =>
      registry.canReadWork(principal, actingSubject, work) },
    media: { pool: contentPool, canReadWork: (principal, actingSubject, work) =>
      registry.canReadWork(principal, actingSubject, work) },
    source: async (principal, recordId, observationId) => {
      const principalId = await registry.activePrincipalId(principal);
      const observation = principalId ? await source.read(principalId, observationId) : null;
      return observation?.record === `https://rezics.com/id/${recordId}` ? {
        record: observation.record, retention: observation.retention,
        byteDigest: observation.byteDigest, mediaType: observation.mediaType,
      } : null;
    },
  });
  const heads = ownerTargetHeads({ graph: env, content: contentPool });
  const store = new GovernanceStore(accessPool, {
    capture: (principal, actingSubject, target) => target.owner === 'review'
      ? reviews.capture(principal, actingSubject, target)
      : evidence.capture(principal, actingSubject, target),
  }, {
    current: (target) => target.owner === 'review' ? reviews.current(target) : heads.current(target),
  }, rules, ownerModerationEffects(new ContentModeration(contentPool), env, {
      pool: contentPool,
      core: content,
    }), reviews);
  return { store, rules };
}

/** Main correspondence shares the private graph reader used by moderation. */
export function governanceNoticeParticipants(env: WorkActivationEnvironment) {
  return graphNoticeParticipants(env);
}
