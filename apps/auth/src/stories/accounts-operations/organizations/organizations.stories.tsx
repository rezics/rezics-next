import { NewOrganizationPage } from '../../../routes/organizations.new';
import { m } from '../../../paraglide/messages.js';
import { AuthStory, authLocale, reviewParameters, session, button, fill, waitFor } from '../story';

export default { title: 'Pages/Account/Create organization', parameters: reviewParameters, decorators: [authLocale] };
const initial = session('organization');
const page = (mode: 'success' | 'closed' | 'refused' | 'unknown' | 'unavailable' = 'success', returning = false) => (
  <AuthStory mode={mode} {...(returning ? { returning: 'organization' as const } : {})}>
    <NewOrganizationPage initial={initial} />
  </AuthStory>
);
async function submit(canvas: HTMLElement) {
  const input = await waitFor(() => canvas.querySelector<HTMLInputElement>('#organization-handle'));
  fill(input, 'reading-group');
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  button(canvas, m.auth_organization_create())!.click();
}
export const Ready = { render: () => page() };
export const Created = {
  render: () => page(),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_organization_created({ handle: 'reading-group' })));
  },
};
export const PlatformClosed = {
  render: () => page('closed'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_organization_not_open()));
  },
};
export const Refused = {
  render: () => page('refused'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_organization_refused()));
  },
};
export const UnknownOutcome = {
  render: () => page('unknown'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_organization_creation_unknown()));
  },
};
export const ReturnedForConfirmation = { render: () => page('success', true) };
export const DependencyUnavailable = {
  tags: ['!dev'],
  render: () => page('unavailable'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_account_operation_unavailable()));
  },
};
export const SignedOut = {
  tags: ['!dev'],
  render: () => (
    <AuthStory>
      <NewOrganizationPage initial={{ kind: 'signed-out' }} />
    </AuthStory>
  ),
};

// Selected deletion fixtures are private page observations, never action grants.
import { OrganizationDeleteContent } from '../../../routes/organizations.delete';
import type { OrganizationDeletionRead, OrganizationDeletionReader } from '../../../organization-deletion';
const deletionHuman = '10000000-0000-7000-8000-000000000001';
const deletionOrganization = '20000000-0000-7000-8000-000000000002';
const deletionReview: OrganizationDeletionRead = {
  kind: 'ready',
  humanAccountId: deletionHuman,
  action: 'confirm',
  account: {
    id: deletionOrganization,
    kind: 'organization',
    handle: 'reading-group',
    displayName: 'International reading group — 世界の読書会・跨地區閱讀與共同出版組織',
  },
};
const deletionSource =
  (value: OrganizationDeletionRead): OrganizationDeletionReader =>
  async () =>
    value;
const deletionAuthentication = deletionSource({
  kind: 'authentication-required',
  humanAccountId: deletionHuman,
  action: 'authenticate',
});
const deletionAllowed = deletionSource(deletionReview);
const deletionRefused = deletionSource({ kind: 'denied' });
const deletionUnavailable = deletionSource({ kind: 'unavailable' });
const deletionPage = (read: OrganizationDeletionReader, mode: 'success' | 'unknown' = 'success') => (
  <AuthStory mode={mode}>
    <OrganizationDeleteContent
      organizationId={deletionOrganization}
      privacyContact="mailto:privacy@example.test"
      read={read}
    />
  </AuthStory>
);
const deletionParameters = {
  viewport: {
    options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
    },
  },
};
export const DeleteAuthenticationRequired = {
  parameters: deletionParameters,
  render: () => deletionPage(deletionAuthentication),
};
export const DeleteLongIdentityAndConsequences = {
  parameters: deletionParameters,
  render: () => deletionPage(deletionAllowed),
};
export const DeleteRefused = { parameters: deletionParameters, render: () => deletionPage(deletionRefused) };
export const DeleteUnavailable = { parameters: deletionParameters, render: () => deletionPage(deletionUnavailable) };
export const DeleteUnknown = {
  parameters: deletionParameters,
  render: () => deletionPage(deletionAllowed, 'unknown'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const input = await waitFor(() =>
      canvasElement.querySelector<HTMLInputElement>('#organization-delete-confirmation'),
    );
    fill(input, '@reading-group');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    button(canvasElement, m.auth_organization_delete_heading())!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_organization_delete_unknown()));
  },
};
