import { createResourcePublicEligibility, type ResourceEligibility } from '../access/index.ts';
import contextPublicExists from './context-public-exists.sql';
import contextPublicEvidence from './context-public-evidence.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { loadRelated } from './subject.ts';
import { readSubjectPublicStates } from './viewer-actions.ts';

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

/** Related ids share one read. Prepare stores the batch; verify loads it once per client. */
export function relatedReadEligibility(
  resource: { route: number; id: string },
  ids: readonly string[],
): ResourceEligibility {
  const batch = [...ids];
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    async prepare() {
      return { ids: batch };
    },
    async verify({ client, resource: identity }) {
      const states = await loadRelated(client, batch);
      return states.get(identity.id)?.visibility === 'visible';
    },
  });
}

export function subjectReadEligibility(resource: { route: number; id: string }): ResourceEligibility {
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    async prepare({ pool, resource: identity }) {
      const [row] = await readSubjectPublicStates(pool, [identity.id]);
      return row ?? null;
    },
    async verify({ client, evidence }) {
      if (evidence.visibility !== 'visible') return false;
      const [current] = await readSubjectPublicStates(client, [resource.id]);
      return current?.visibility === 'visible' && current.security_revision === evidence.security_revision;
    },
  });
}
