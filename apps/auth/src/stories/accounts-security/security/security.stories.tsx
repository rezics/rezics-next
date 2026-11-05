import { useRef } from 'react';
import { SecurityPage } from '../../../routes/security';
import { PasskeyEnrollmentView } from '../../../passkey-enrollment-view';
import { m } from '../../../paraglide/messages.js';
import type { SecurityLoadResult } from '../../../security';
import type { AccountIdentitySource } from '../../../account-identity';
import type { SecuritySource } from '../../../security-reconciliation';
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
  fill,
  waitFor,
} from '../../accounts-operations/story';

export default { title: 'Pages/Account/Account security', parameters: reviewParameters, decorators: [authLocale] };
export const initial: SecurityLoadResult = {
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
      revoke: 'allowed',
    },
  ],
  passkeys: {
    kind: 'ready',
    passkeys: [
      {
        id: 'passkey',
        name: 'Security key',
        created_at: '2026-10-29T09:00:00Z',
        last_used_at: null,
        remove: 'allowed',
      },
    ],
  },
};
if (initial.kind === 'ready')
  initial.page = {
    viewer: { account_id: storyAccount, session_id: 'current', client_id: 'login' },
    actions: { change_password: 'allowed', register_passkey: 'allowed' },
    sessions: {
      kind: 'ready',
      rows: initial.sessions.map((row) => ({ ...row, client_display_name: null, revoke: 'allowed' })),
      limit: 64,
      truncated: false,
    },
    passkeys: {
      kind: 'ready',
      rows:
        initial.passkeys.kind === 'ready'
          ? initial.passkeys.passkeys.map((row) => ({ ...row, remove: 'allowed' }))
          : [],
      limit: 32,
      truncated: false,
    },
  };
// Presentation of the closed native email projection; no verification claim.
const identitySource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: storyAccount,
  email: '读者.長いメールアドレス.reading-companion@example.test',
});
const unavailableIdentity: AccountIdentitySource = async () => ({ kind: 'unavailable' });
export const Owner = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={populatedInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const next = await waitFor(() => button(canvasElement, m.auth_inventory_next()));
    next.click();
    await waitFor(() => button(canvasElement, m.auth_inventory_previous()));
  },
};
export const PasswordReview = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={populatedInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const next = canvasElement.querySelector<HTMLInputElement>('#security-new-password');
    const confirmation = canvasElement.querySelector<HTMLInputElement>('#security-confirm-password');
    if (!next || !confirmation) throw new Error('Password review fields are unavailable');
    fill(next, 'story-review-only-secret');
    fill(confirmation, 'story-review-only-secret');
    button(canvasElement, m.auth_security_password_review())!.click();
    await waitFor(() => button(canvasElement, m.auth_security_password_confirm()));
    if (canvasElement.textContent?.includes('story-review-only-secret'))
      throw new Error('Password review must not show the entered password');
  },
};
export const Empty = {
  render: () => (
    <AuthStory>
      <SecurityPage
        identitySource={identitySource}
        initial={{ ...initial, sessions: [], passkeys: { kind: 'ready', passkeys: [] } }}
        inventorySource={emptyInventory}
      />
    </AuthStory>
  ),
};
export const Unavailable = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={unavailableInventory} />
    </AuthStory>
  ),
};
export const Preparing = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={preparingInventory} />
    </AuthStory>
  ),
};
export const SignedOut = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={{ kind: 'signed-out' }} />
    </AuthStory>
  ),
};
export const ConsentReduced = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={populatedInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const control = await waitFor(() =>
      button(canvasElement, m.auth_inventory_remove_named({ name: 'Reading companion' })),
    );
    control.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_remove()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_connected_operation_acknowledged()));
  },
};
export const Denied = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={deniedInventory} />
    </AuthStory>
  ),
};
export const LastCredential = {
  render: () => (
    <AuthStory mode="last-credential">
      <SecurityPage
        identitySource={identitySource}
        initial={initial}
        inventorySource={emptyInventory}
        securitySource={{ act: async () => ({ kind: 'last-credential' }), read: async () => ({ kind: 'unavailable' }) }}
      />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const remove = await waitFor(() =>
      canvasElement.querySelector<HTMLButtonElement>(
        `button[aria-label="${m.auth_security_passkey_remove_named({ name: 'Security key' })}"]`,
      ),
    );
    remove.click();
    (await waitFor(() => button(canvasElement, m.auth_security_confirm_passkey()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_last_credential()));
    if (!canvasElement.textContent?.includes('Security key')) throw new Error('Last credential must remain available');
  },
};

// Presentation fixtures only; native recovery proof belongs to owner acceptance.
function recoveryStory(unavailable: boolean) {
  const source: SecuritySource = {
    act: async () => ({ kind: 'unknown' }),
    read: async () =>
      unavailable
        ? { kind: 'unavailable' }
        : {
            kind: 'ready',
            sessions: initial.kind === 'ready' ? initial.sessions : [],
            passkeys: [],
            presence: 'absent',
          },
  };
  return {
    render: () => (
      <AuthStory>
        <SecurityPage
          identitySource={identitySource}
          initial={initial}
          inventorySource={emptyInventory}
          securitySource={source}
        />
      </AuthStory>
    ),
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const remove = await waitFor(() =>
        canvasElement.querySelector<HTMLButtonElement>(
          `button[aria-label="${m.auth_security_passkey_remove_named({ name: 'Security key' })}"]`,
        ),
      );
      remove.click();
      (await waitFor(() => button(canvasElement, m.auth_security_confirm_passkey()))).click();
      await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_unknown()));
      (await waitFor(() => button(canvasElement, m.auth_security_check_current()))).click();
      await waitFor(() =>
        canvasElement.textContent?.includes(
          unavailable ? m.auth_security_readback_unavailable() : m.auth_security_passkey_absent(),
        ),
      );
    },
  };
}
export const LostResponseReadback = recoveryStory(false);
export const LostResponseUnavailable = recoveryStory(true);

export const IdentityUnavailable = {
  render: () => (
    <AuthStory>
      <SecurityPage initial={initial} inventorySource={populatedInventory} identitySource={unavailableIdentity} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => button(canvasElement, m.auth_account_identity_retry()));
    await waitFor(() => canvasElement.textContent?.includes(m.auth_security_change_password()));
  },
};

function targetState(phase: 'review' | 'busy' | 'unknown' | 'present' | 'truncated') {
  const source: SecuritySource = {
    act: () => (phase === 'busy' ? new Promise(() => {}) : Promise.resolve({ kind: 'unknown' })),
    read: async () => ({
      kind: 'ready',
      sessions: initial.kind === 'ready' ? initial.sessions : [],
      passkeys: initial.kind === 'ready' && initial.passkeys.kind === 'ready' ? initial.passkeys.passkeys : [],
      presence: phase === 'truncated' ? 'unknown' : 'present',
    }),
  };
  return {
    render: () => (
      <AuthStory>
        <SecurityPage
          identitySource={identitySource}
          initial={initial}
          inventorySource={emptyInventory}
          securitySource={source}
        />
      </AuthStory>
    ),
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      (await waitFor(() => button(canvasElement, m.auth_security_passkey_remove()))).click();
      if (phase === 'review') {
        await waitFor(() => canvasElement.querySelector('[role="dialog"]'));
        return;
      }
      (await waitFor(() => button(canvasElement, m.auth_security_confirm_passkey()))).click();
      if (phase === 'busy') return;
      await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_unknown()));
      if (phase === 'unknown') return;
      (await waitFor(() => button(canvasElement, m.auth_security_check_current()))).click();
      await waitFor(() =>
        canvasElement.textContent?.includes(
          phase === 'present' ? m.auth_security_passkey_present() : m.auth_security_target_incomplete(),
        ),
      );
    },
  };
}
export const PasskeyReview = targetState('review');
export const RemovalBusy = targetState('busy');
export const RemovalUnknown = targetState('unknown');
export const CurrentTargetPresent = targetState('present');
export const TruncatedTargetMissing = targetState('truncated');

function TruncatedRegistrationReviewStory() {
  const statusRef = useRef<HTMLDivElement>(null);
  return (
    <AuthStory>
      <section aria-labelledby="registration-review-heading" className="auth-login-form">
        <h2 id="registration-review-heading">{m.auth_security_passkeys_heading()}</h2>
        <PasskeyEnrollmentView
          state={{
            attemptId: 1,
            accountId: storyAccount,
            phase: 'reviewed',
            possibleEffect: true,
            reviewRequired: true,
          }}
          reading={false}
          truncated
          canReview
          statusRef={statusRef}
          check={() => {}}
          finish={() => {}}
        />
      </section>
    </AuthStory>
  );
}

export const TruncatedRegistrationReview = { render: () => <TruncatedRegistrationReviewStory /> };
export const CurrentSessionReview = {
  render: () => (
    <AuthStory>
      <SecurityPage identitySource={identitySource} initial={initial} inventorySource={emptyInventory} />
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_security_sign_out()))).click();
    await waitFor(() => canvasElement.querySelector('[role="dialog"]'));
  },
};
