import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { SourceIntakeStore } from '../source/intake.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from './evidence.ts';
import { GovernanceRules } from './rules.ts';
import { GovernanceStore } from './store.ts';

/** Main's real owner readers; every evidence lookup stays on the pinned revision. */
export function governanceServices(accessPool: Pool, contentPool: Pool, content: ContentCore,
  source: SourceIntakeStore, registry: AccessAdmissionRegistry, env: WorkActivationEnvironment) {
  const rules = new GovernanceRules(accessPool);
  const store = new GovernanceStore(accessPool, ownerEvidenceCapture({
    content: { core: content, canRead: async (principal, actingSubject, ids) => {
      const disclosed = new Set<string>();
      for (const id of ids) {
        const resource = await content.owningResourceForRevision(id);
        if (resource && await registry.canReadWork(principal, actingSubject, resource)) disclosed.add(id);
      }
      return disclosed;
    } },
    graph: { env, canReadWork: (principal, actingSubject, work) =>
      registry.canReadWork(principal, actingSubject, work) },
    source: async (principal, recordId, observationId) => {
      const principalId = await registry.activePrincipalId(principal);
      const observation = principalId ? await source.read(principalId, observationId) : null;
      return observation?.record === `https://rezics.com/id/${recordId}` ? {
        record: observation.record, retention: observation.retention,
        byteDigest: observation.byteDigest, mediaType: observation.mediaType,
      } : null;
    },
  }), ownerTargetHeads({ graph: env, content: contentPool }), rules);
  return { store, rules };
}
