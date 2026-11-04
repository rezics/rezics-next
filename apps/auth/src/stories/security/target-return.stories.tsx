import { useRef, useState } from 'react';
import { SecurityPage } from '../../routes/security';
import { SecurityTargetReturnView } from '../../security-target-return-view';
import { m } from '../../paraglide/messages.js';
import type { SecurityLoadResult } from '../../security';
import type { SecurityActionResult, SecuritySource } from '../../security-reconciliation';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  populatedInventory,
  button,
  waitFor,
} from '../accounts-operations/story';
import { initial } from '../accounts-security/security/security.stories';

export default {
  title: 'Pages/Account/Security request return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

function replacementAccount() {
  const data = structuredClone(initial) as Extract<SecurityLoadResult, { kind: 'ready' }>;
  data.accountId = 'replacement-account';
  data.sessions = [
    {
      ...data.sessions[0]!,
      id: 'replacement-session',
      current: true,
      client_display_name: 'New viewer device',
      revoke: 'allowed',
    },
  ];
  data.passkeys = {
    kind: 'ready',
    passkeys: [
      {
        id: 'replacement-passkey',
        name: 'New viewer key',
        created_at: '2026-10-31T09:00:00Z',
        last_used_at: null,
        remove: 'allowed',
      },
    ],
  };
  if (data.page) {
    data.page.viewer.account_id = data.accountId;
    data.page.viewer.session_id = 'replacement-session';
    data.page.sessions = {
      kind: 'ready',
      rows: data.sessions.map((row) => ({ ...row, client_display_name: 'New viewer device', revoke: 'allowed' })),
      limit: 64,
      truncated: false,
    };
    data.page.passkeys = {
      kind: 'ready',
      rows: data.passkeys.passkeys.map((row) => ({ ...row, remove: 'allowed' })),
      limit: 32,
      truncated: false,
    };
  }
  return data;
}

function retiredAttemptStory(returned: SecurityLoadResult) {
  const source: SecuritySource = {
    load: async () => returned,
    act: () => new Promise<SecurityActionResult>(() => {}),
    read: async () => ({ kind: 'unavailable' }),
  };
  return {
    render: () => (
      <AuthStory>
        <SecurityPage
          initial={initial}
          identitySource={async () => ({ kind: 'unavailable' })}
          inventorySource={populatedInventory}
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
      await waitFor(() => canvasElement.querySelector('[role="dialog"]') === null);
      window.dispatchEvent(new Event('pagehide'));
      await waitFor(() => !canvasElement.querySelector('#security-passkeys-heading'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await waitFor(() => canvasElement.textContent?.includes(m.auth_security_target_return_unknown()));
    },
  };
}

export const UnknownAfterSignOut = retiredAttemptStory({ kind: 'signed-out' });
export const UnknownWithReadFailure = retiredAttemptStory({
  kind: 'failure',
  message: 'Security status is unavailable.',
});
export const ReplacementViewer = retiredAttemptStory(replacementAccount());

export const TruncatedCurrentInventory = {
  render: () => {
    const source: SecuritySource = {
      act: async () => ({ kind: 'unknown' }),
      read: async () => ({
        kind: 'ready',
        presence: 'unknown',
        sessions: initial.kind === 'ready' ? initial.sessions : [],
        passkeys: initial.kind === 'ready' && initial.passkeys.kind === 'ready' ? initial.passkeys.passkeys : [],
      }),
    };
    return (
      <AuthStory>
        <SecurityPage
          initial={initial}
          identitySource={async () => ({ kind: 'unavailable' })}
          inventorySource={populatedInventory}
          securitySource={source}
        />
      </AuthStory>
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_security_passkey_remove()))).click();
    (await waitFor(() => button(canvasElement, m.auth_security_confirm_passkey()))).click();
    await waitFor(() => button(canvasElement, m.auth_security_check_current()));
    (await waitFor(() => button(canvasElement, m.auth_security_check_current()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_security_target_incomplete()));
  },
};

function CurrentDeviceExitView() {
  const status = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  return (
    <AuthStory>
      <section className="auth-login-form">
        {visible ? (
          <SecurityTargetReturnView outcome="acknowledged" statusRef={status} dismiss={() => setVisible(false)} />
        ) : null}
        <p>{m.auth_security_current_consequence()}</p>
        <a href="/login">{m.auth_security_sign_in()}</a>
      </section>
    </AuthStory>
  );
}

export const AcknowledgedCurrentDeviceExit = { render: () => <CurrentDeviceExitView /> };
