import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { readPrivacyContact } from '../privacy-contact';
import { isAccountId } from '../organization-delete-step-up';
import { OrganizationDeleteContent } from '../organization-delete-content';

// Trusted issuer entry for Web management: /organizations/delete?organization_id=<immutable UUID>.
// The selection supplies no authority and is never accepted as an own-delete target.
export const Route = createFileRoute('/organizations/delete')({
  validateSearch: (search: Record<string, unknown>) => ({
    organization_id:
      search.organization_id === undefined
        ? undefined
        : isAccountId(search.organization_id)
          ? search.organization_id
          : '',
  }),
  loader: () => readPrivacyContact(),
  head: () => ({ meta: [{ title: `${m.auth_organization_delete_heading()} · REZICS` }] }),
  component: OrganizationDeletePage,
});

function OrganizationDeletePage() {
  return (
    <OrganizationDeleteContent
      privacyContact={Route.useLoaderData()}
      organizationId={Route.useSearch().organization_id}
    />
  );
}

export { OrganizationDeleteContent };
