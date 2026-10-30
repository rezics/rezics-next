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
    await waitFor(() => canvasElement.textContent?.includes(m.auth_account_operation_unknown()));
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
