import { createResourcePublicEligibility, type ResourceEligibility } from '../access/index.ts';
import subjectExists from './subject-exists.sql';

export function subjectReadEligibility(resource: { route: number; id: string }): ResourceEligibility {
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    async prepare() {
      return null;
    },
    async verify({ client }) {
      return (await subjectExists.run(client, { route: resource.route, subject_id: resource.id })) !== null;
    },
  });
}
