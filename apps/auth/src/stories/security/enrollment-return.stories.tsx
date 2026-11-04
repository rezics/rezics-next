import { useLayoutEffect, useState } from 'react';
import { SecurityPage } from '../../routes/security';
import { m } from '../../paraglide/messages.js';
import type { PasskeyRegistrationReview, SecurityLoadResult } from '../../security';
import type { SecuritySource, SecurityActionResult } from '../../security-reconciliation';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  emptyInventory,
  button,
  fill,
  waitFor,
} from '../accounts-operations/story';
import { initial } from '../accounts-security/security/security.stories';

export default {
  title: 'Pages/Account/Security enrollment return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const optionBody = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'auth.test', name: 'REZICS' },
  user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
  pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
};
const createdBody = { id: 'native-passkey-row', name: 'Security key', created_at: '2026-11-01T09:00:00Z' };
const credential = {
  id: 'browser-credential',
  rawId: new Uint8Array([1]).buffer,
  type: 'public-key' as const,
  getClientExtensionResults: () => ({}),
  response: { attestationObject: new Uint8Array([1]).buffer, clientDataJSON: new Uint8Array([1]).buffer },
} as unknown as Credential;
const identitySource = async () => ({ kind: 'unavailable' as const });

type StoryConfig = {
  registration: 'confirmed' | 'unknown' | 'cancelled';
  afterRegistration?: SecurityLoadResult;
  review?: PasskeyRegistrationReview;
  next?: 'return' | 'review' | 'dismiss' | 'finish';
};

function ready(accountId?: string): Extract<SecurityLoadResult, { kind: 'ready' }> {
  const value = structuredClone(initial);
  if (value.kind !== 'ready') throw new Error('Security story fixture is not ready');
  if (accountId && value.accountId !== accountId) {
    value.accountId = accountId;
    if (value.page) value.page.viewer.account_id = accountId;
    if (value.passkeys.kind === 'ready')
      value.passkeys = {
        kind: 'ready',
        passkeys: [{ ...value.passkeys.passkeys[0]!, id: 'replacement-row', name: 'Replacement key' }],
      };
    if (value.page?.passkeys.kind === 'ready')
      value.page.passkeys.rows = [{ ...value.page.passkeys.rows[0]!, id: 'replacement-row', name: 'Replacement key' }];
  }
  return value;
}

function BrowserStory({ source, cancelled }: {
  source: SecuritySource & {
    reviewRegistration: (accountId: string) => Promise<PasskeyRegistrationReview>;
  };
  cancelled: boolean;
}) {
  const [readyToMount, setReadyToMount] = useState(false);
  useLayoutEffect(() => {
    const oldCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
    const oldPublicKey = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      configurable: true,
      value: class PublicKeyCredentialFixture {},
    });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => {
          if (cancelled) throw new DOMException('Dismissed', 'NotAllowedError');
          return credential;
        },
      },
    });
    setReadyToMount(true);
    return () => {
      if (oldCredentials) Object.defineProperty(navigator, 'credentials', oldCredentials);
      else Reflect.deleteProperty(navigator, 'credentials');
      if (oldPublicKey) Object.defineProperty(globalThis, 'PublicKeyCredential', oldPublicKey);
      else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
    };
  }, [cancelled]);
  if (!readyToMount) return null;
  return (
    <AuthStory>
      <SecurityPage
        initial={initial}
        identitySource={identitySource}
        inventorySource={emptyInventory}
        securitySource={source}
      />
    </AuthStory>
  );
}

function enrollmentStory(config: StoryConfig) {
  let reads = 0;
  const source: SecuritySource & {
    reviewRegistration: (accountId: string) => Promise<PasskeyRegistrationReview>;
  } = {
    load: async () => {
      reads++;
      return config.afterRegistration ?? ready();
    },
    act: async (): Promise<SecurityActionResult> => ({ kind: 'denied' }),
    read: async () => ({ kind: 'unavailable' }),
    reviewRegistration: async () => config.review ?? { kind: 'ready', passkeys: [], truncated: false },
  };
  return {
    render: () => <BrowserStory source={source} cancelled={config.registration === 'cancelled'} />,
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const previousFetch = globalThis.fetch;
      let releaseRegistration: ((response: Response) => void) | undefined;
      let optionsCalls = 0;
      let registrationCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.pathname === '/passkeys/register/options') {
          optionsCalls++;
          return Response.json(optionBody);
        }
        if (url.pathname === '/passkeys/register') {
          registrationCalls++;
          if (config.registration === 'unknown')
            return new Promise<Response>((resolve) => {
              releaseRegistration = resolve;
            });
          return Response.json(createdBody, { status: 201 });
        }
        return previousFetch(input, init);
      }) as typeof fetch;
      try {
        const add = await waitFor(() => button(canvasElement, m.auth_security_passkey_add()));
        fill(canvasElement.querySelector<HTMLInputElement>('#security-passkey-name')!, 'Security key');
        add.click();
        if (config.registration === 'cancelled') {
          await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_registration_cancelled()));
          if (registrationCalls !== 0) throw new Error('Cancellation dispatched registration');
          return;
        }
        if (config.registration === 'unknown') {
          await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_registration_saving()));
          window.dispatchEvent(new PageTransitionEvent('pagehide'));
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_history_unknown()));
          releaseRegistration?.(Response.json(createdBody, { status: 201 }));
          if (config.next === 'review' || config.next === 'finish') {
            (await waitFor(() => button(canvasElement, m.auth_security_passkey_check_current()))).click();
            await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_registration_reviewed()));
            if (config.next === 'finish') {
              (await waitFor(() => button(canvasElement, m.auth_security_passkey_registration_continue()))).click();
              await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_registration_review_finished()));
            }
          }
          return;
        }
        await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_history_acknowledged()));
        if (config.next === 'return') {
          window.dispatchEvent(new PageTransitionEvent('pagehide'));
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          await waitFor(() => canvasElement.textContent?.includes(m.auth_security_passkey_history_acknowledged()));
          if (optionsCalls !== 1 || registrationCalls !== 1 || reads !== 2)
            throw new Error('Cached return repeated registration or readback');
        } else if (config.next === 'dismiss') {
          (await waitFor(() => button(canvasElement, m.auth_security_passkey_dismiss_history()))).click();
          await waitFor(() => !canvasElement.querySelector('[data-passkey-enrollment-history]'));
        }
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
}

export const AcknowledgedButInventoryUnavailable = enrollmentStory({
  registration: 'confirmed',
  afterRegistration: { kind: 'failure', message: 'Current Security inventory is unavailable.' },
});
export const AcknowledgedThenSignOut = enrollmentStory({
  registration: 'confirmed',
  afterRegistration: { kind: 'signed-out' },
});
export const UnknownThenReplacementAccount = enrollmentStory({
  registration: 'unknown',
  afterRegistration: ready('replacement-account'),
});
export const CancelledBeforeDispatch = enrollmentStory({ registration: 'cancelled' });
export const CompleteCurrentReview = enrollmentStory({
  registration: 'unknown',
  review: { kind: 'ready', passkeys: [], truncated: false },
  next: 'review',
});
export const CappedCurrentReview = enrollmentStory({
  registration: 'unknown',
  review: {
    kind: 'ready',
    passkeys: [
      {
        id: 'native-row',
        name: 'Security key',
        created_at: '2026-11-01T09:00:00Z',
        last_used_at: null,
        remove: 'allowed',
      },
    ],
    truncated: true,
  },
  next: 'review',
});
export const DismissedHistory = enrollmentStory({ registration: 'confirmed', next: 'dismiss' });
export const FinishedCurrentReview = enrollmentStory({
  registration: 'unknown',
  review: { kind: 'ready', passkeys: [], truncated: false },
  next: 'finish',
});
export const AcknowledgedCachedReturn = enrollmentStory({ registration: 'confirmed', next: 'return' });
