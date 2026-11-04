import type { ReactNode } from 'react';
import { SecurityPage } from '../../../routes/security';
import { m } from '../../../paraglide/messages.js';
import type { AccountIdentitySource } from '../../../account-identity';
import type { SecurityLoadResult } from '../../../security';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  storyAccount,
  populatedInventory,
  button,
  waitFor,
} from '../../accounts-operations/story';

export default {
  title: 'Pages/Account/Connected application return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const initial: SecurityLoadResult = {
  kind: 'ready',
  accountId: storyAccount,
  sessions: [],
  passkeys: { kind: 'ready', passkeys: [] },
  page: {
    viewer: { account_id: storyAccount, session_id: 'current', client_id: 'login' },
    actions: { change_password: 'allowed', register_passkey: 'allowed' },
    sessions: { kind: 'ready', rows: [], limit: 64, truncated: false },
    passkeys: { kind: 'ready', rows: [], limit: 32, truncated: false },
  },
};
const identitySource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: storyAccount,
  email: 'reader@example.test',
});

function canvas(theme: 'light' | 'dark', children: ReactNode) {
  return (
    <div className={`${theme === 'dark' ? 'dark' : ''} min-h-screen bg-background text-foreground`}>{children}</div>
  );
}

export const PhoneCurrentReview = {
  parameters: { viewport: { defaultViewport: 'phone390' } },
  render: () => (
    <AuthStory>
      {canvas(
        'light',
        <SecurityPage initial={initial} identitySource={identitySource} inventorySource={populatedInventory} />,
      )}
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const review = await waitFor(() =>
      button(canvasElement, m.auth_inventory_review_named({ name: 'Reading companion' })),
    );
    review.click();
    await waitFor(() => button(canvasElement, m.auth_inventory_review_removal()));
  },
};

export const DesktopUnknownReturn = {
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  render: () => (
    <AuthStory mode="unknown">
      {canvas(
        'dark',
        <SecurityPage initial={initial} identitySource={identitySource} inventorySource={populatedInventory} />,
      )}
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const remove = await waitFor(() =>
      button(canvasElement, m.auth_inventory_remove_named({ name: 'Reading companion' })),
    );
    remove.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_remove())))!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_connected_operation_unknown()));
  },
};
