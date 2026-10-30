import { SecurityPage } from '../../../routes/security';
import { m } from '../../../paraglide/messages.js';
import type { SecurityLoadResult } from '../../../security';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  storyAccount,
  populatedInventory,
  emptyInventory,
  unavailableInventory,
  deniedInventory,
  preparingInventory,
  button,
  waitFor,
} from '../../accounts-operations/story';

export default { title: 'Pages/Account/Account security', parameters: reviewParameters, decorators: [authLocale] };
const initial: SecurityLoadResult = {
  kind: 'ready',
  accountId: storyAccount,
  sessions: [
    {
      id: 'current',
      client_id: 'login',
      created_at: '2026-10-30T09:00:00Z',
      expires_at: '2026-11-06T09:00:00Z',
      user_agent: null,
      current: true,
    },
  ],
  passkeys: {
    kind: 'ready',
    passkeys: [{ id: 'passkey', name: 'Security key', created_at: '2026-10-29T09:00:00Z', last_used_at: null }],
  },
};
export const Owner = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={populatedInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const next = await waitFor(() => button(canvasElement, m.auth_inventory_next()));
    next.click();
    await waitFor(() => button(canvasElement, m.auth_inventory_previous()));
  },
};
export const Empty = {
  render: () => (
    <AuthStory>
      <SecurityPage
        initial={{ ...initial, sessions: [], passkeys: { kind: 'ready', passkeys: [] } }}
        inventorySource={emptyInventory}
      />
    </AuthStory>
  ),
};
export const Unavailable = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={unavailableInventory} />
    </AuthStory>
  ),
};
export const Preparing = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={preparingInventory} />
    </AuthStory>
  ),
};
export const SignedOut = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={{ kind: 'signed-out' }} />
    </AuthStory>
  ),
};
export const ConsentReduced = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={populatedInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const control = await waitFor(() =>
      button(canvasElement, m.auth_inventory_remove_named({ name: 'Reading companion' })),
    );
    control.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_remove()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_reduced()));
  },
};
export const Denied = {
  tags: ['!dev'],
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={deniedInventory} />
    </AuthStory>
  ),
};
export const LastCredential = {
  render: () => (
    <AuthStory mode="last-credential">
      <SecurityPage initial={initial} inventorySource={emptyInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const remove = await waitFor(() =>
      canvasElement.querySelector<HTMLButtonElement>(
        `button[aria-label="${m.auth_security_passkey_remove_named({ name: 'Security key' })}"]`,
      ),
    );
    const confirm = window.confirm;
    try {
      window.confirm = () => true;
      remove.click();
      await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_last_credential()));
      if (!canvasElement.textContent?.includes('Security key'))
        throw new Error('Last credential must remain available');
    } finally {
      window.confirm = confirm;
    }
  },
};
