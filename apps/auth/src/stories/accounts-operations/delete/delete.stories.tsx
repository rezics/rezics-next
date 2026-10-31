import type { AccountIdentitySource } from '../../../account-identity';
import { DeleteAccountContent } from '../../../routes/account.delete';
import { m } from '../../../paraglide/messages.js';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  session,
  storyAccount,
  populatedInventory,
  unavailableInventory,
  button,
  fill,
  waitFor,
} from '../story';

export default { title: 'Pages/Account/Delete account', parameters: reviewParameters, decorators: [authLocale] };
const initial = session('delete');
// Same closed display shape as the native exact-self projection.
const identitySource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: storyAccount,
  email: '读者.長いメールアドレス.reading-companion@example.test',
});
const unavailableIdentity: AccountIdentitySource = async () => ({ kind: 'unavailable' });
const page = (mode: 'success' | 'refused' | 'unknown' | 'unavailable' = 'success', returning = false) => (
  <AuthStory mode={mode} {...(returning ? { returning: 'delete' as const } : {})}>
    <DeleteAccountContent
      identitySource={identitySource}
      privacyContact="mailto:privacy@example.test"
      initial={initial}
      inventorySource={populatedInventory}
    />
  </AuthStory>
);

async function submit(canvas: HTMLElement) {
  const input = await waitFor(() => canvas.querySelector<HTMLInputElement>('#account-delete-input'));
  fill(input, m.auth_account_delete_confirmation_phrase());
  const control = await waitFor(() => {
    const target = button(canvas, m.auth_account_delete_submit());
    return target && !target.disabled ? target : null;
  });
  control.click();
}

export const Ready = { render: () => page() };
export const ReturnedForConfirmation = {
  render: () => page('success', true),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const input = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#account-delete-input'));
    if (input.value || !button(canvasElement, m.auth_account_delete_submit())?.disabled)
      throw new Error('Deletion must require retyping after step-up');
  },
};
export const Refused = {
  render: () => page('refused'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_account_delete_denied()));
  },
};
export const CleanupPending = {
  render: () => page(),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_account_delete_cleanup_pending()));
  },
};
export const UnknownOutcome = {
  render: () => page('unknown'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_account_operation_unknown()));
  },
};
export const DependencyUnavailable = {
  render: () => (
    <AuthStory mode="unavailable">
      <DeleteAccountContent
        identitySource={identitySource}
        privacyContact={null}
        initial={initial}
        inventorySource={unavailableInventory}
      />
    </AuthStory>
  ),
};
export const SignedOut = {
  tags: ['!dev'],
  render: () => (
    <AuthStory>
      <DeleteAccountContent
        identitySource={identitySource}
        privacyContact="mailto:privacy@example.test"
        initial={{ kind: 'signed-out' }}
      />
    </AuthStory>
  ),
};

export const IdentityUnavailable = {
  render: () => (
    <AuthStory>
      <DeleteAccountContent
        privacyContact="mailto:privacy@example.test"
        initial={initial}
        inventorySource={populatedInventory}
        identitySource={unavailableIdentity}
      />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => button(canvasElement, m.auth_account_identity_retry()));
    const input = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#account-delete-input'));
    if (input.value || !button(canvasElement, m.auth_account_delete_submit())?.disabled)
      throw new Error('Identity context cannot supply deletion confirmation');
  },
};
