import { createResourcePublicEligibility, type ResourceEligibility } from '../access/index.ts';
import contextPublicExists from './context-public-exists.sql';
import contextPublicEvidence from './context-public-evidence.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import subjectPublicEvidence from './subject-public-evidence.sql';

export type GlobalReadAction = 'subject:read' | 'definitions:read' | 'presentation:read';

const globalReadActions: ReadonlySet<string> = new Set(['subject:read', 'definitions:read', 'presentation:read']);

export function globalReadEligibility(action: GlobalReadAction): ResourceEligibility {
  if (!globalReadActions.has(action)) throw new TypeError('Unsupported global read action');

  const resource = { route: 0, id: GLOBAL_CONTEXT };
  return createResourcePublicEligibility({
    resource,
    action,
    async prepare({ pool, resource: identity }) {
      const row = await contextPublicEvidence.run(pool, { route: identity.route, context_id: identity.id });
      return row ?? null;
    },
    async verify({ client, resource: identity }) {
      return (await contextPublicExists.run(client, { route: identity.route, context_id: identity.id })) !== null;
    },
  });
}

export function subjectReadEligibility(resource: { route: number; id: string }): ResourceEligibility {
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    async prepare({ pool, resource: identity }) {
      const row = await subjectPublicEvidence.run(pool, { route: identity.route, subject_id: identity.id });
      return row ?? null;
    },
    async verify({ client, evidence }) {
      if (evidence.visibility !== 'visible') return false;
      const current = await subjectPublicEvidence.run(client, { route: resource.route, subject_id: resource.id });
      return current?.visibility === 'visible' && current.security_revision === evidence.security_revision;
    },
  });
}
