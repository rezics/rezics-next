import { createResourcePublicEligibility, type ResourceEligibility } from '../access/index.ts';
import subjectPublicEvidence from './subject-public-evidence.sql';
import subjectExists from './subject-exists.sql';

export function subjectReadEligibility(resource: { route: number; id: string }): ResourceEligibility {
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    async prepare({ pool, resource: identity }) {
      const row = await subjectPublicEvidence.run(pool, { route: identity.route, subject_id: identity.id });
      return row ?? null;
    },
    async verify({ client }) {
      return (await subjectExists.run(client, { route: resource.route, subject_id: resource.id })) !== null;
    },
  });
}
