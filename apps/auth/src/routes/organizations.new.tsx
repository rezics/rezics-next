import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { NewOrganizationPage } from '../organization-create-page';

export const Route = createFileRoute('/organizations/new')({
  head: () => ({ meta: [{ title: `${m.auth_organization_heading()} · REZICS` }] }),
  component: NewOrganizationPage,
});

export { NewOrganizationPage } from '../organization-create-page';
