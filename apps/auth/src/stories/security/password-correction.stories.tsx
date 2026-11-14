import type { AccountIdentitySource } from '../../account-identity';
import { m } from '../../paraglide/messages.js';
import { SecurityPage } from '../../routes/security';
import { initial } from '../accounts-security/security/security.stories';
import {
  AuthStory,
  authLocale,
  button,
  emptyInventory,
  fill,
  reviewParameters,
  waitFor,
} from '../accounts-operations/story';

export default {
  title: 'Account/Account security',
  id: 'pages-account-account-security-password-correction',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const unavailableIdentity: AccountIdentitySource = async () => ({
  kind: 'unavailable',
});

export const PasswordCorrection = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={unavailableIdentity} initial={initial} inventorySource={emptyInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const password = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#security-new-password'));
    const confirmation = canvasElement.querySelector<HTMLInputElement>('#security-confirm-password');
    if (!confirmation) throw new Error('Password confirmation field is unavailable');

    const review = await waitFor(() => button(canvasElement, m.auth_security_password_review()));
    review.click();
    await waitFor(() => password.getAttribute('aria-invalid') === 'true');
    if (document.activeElement !== password) throw new Error('Empty review must focus the new password field');

    fill(password, 'password correction story secret');
    if (document.activeElement !== password) throw new Error('Typing must keep focus in the new password field');
    if (confirmation.getAttribute('aria-invalid') !== 'true')
      throw new Error('The empty confirmation must remain invalid during password correction');

    review.click();
    await waitFor(() => document.activeElement === confirmation);
    fill(confirmation, 'password correction story secret');
    if (document.activeElement !== confirmation) throw new Error('Typing must keep focus in the confirmation field');

    review.click();
    await waitFor(() => button(canvasElement, m.auth_security_password_confirm()));
    const heading = canvasElement.querySelector<HTMLHeadingElement>('#security-password-review-heading');
    if (!heading || document.activeElement !== heading) throw new Error('Entering review must focus its heading');
    if (canvasElement.textContent?.includes('password correction story secret'))
      throw new Error('Password review must not show the entered password');

    button(canvasElement, m.auth_inventory_cancel())!.click();
    await waitFor(() => document.activeElement === password);
    if (password.value || confirmation.value) throw new Error('Cancel must clear the password draft');
    if (canvasElement.textContent?.includes('password correction story secret'))
      throw new Error('Cancel must not expose the password draft');
  },
};
