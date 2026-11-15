import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { membershipId } from '../organization-membership';
import { OrganizationMembersPage } from '../organization-members-page';

export const Route = createFileRoute('/organizations/members')({
  validateSearch: (search: Record<string, unknown>) => ({
    organizationId: membershipId(search.organizationId) ? search.organizationId : '',
  }),
  head: () => ({ meta: [{ title: `${m.auth_members_heading()} · REZICS` }] }),
  component: MembershipRoute,
});
function MembershipRoute() {
  const { organizationId } = Route.useSearch();
  return <OrganizationMembersPage organizationId={organizationId} />;
}

export { OrganizationMembershipRoster } from '../organization-membership-roster-view';

export { OrganizationMembersPage };
