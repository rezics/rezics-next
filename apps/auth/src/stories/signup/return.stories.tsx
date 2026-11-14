import { useState } from 'react';
import { AuthShell } from '../../frame';
import { SignupReturnView } from '../../signup-return-view';
import type { RegistrationPage } from '../../registration-page';
import type { SignupReturnState } from '../../signup-return';
import { m } from '../../paraglide/messages.js';
import { authLocale, button, reviewParameters, waitFor } from '../accounts-operations/story';
import { registrationPage, requirements } from './fixtures';
import '../../styles.css';

export default {
  title: 'Account/Sign up/Return',
  id: 'pages-account-sign-up-return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

type Mode = 'unknown' | 'created' | 'unavailable' | 'checking' | 'current' | 'changed';
const query = '?return_to=%2Fsecurity';
function Returned({ mode }: { mode: Mode }) {
  const [page, setPage] = useState<RegistrationPage>(() =>
    mode === 'unavailable'
      ? { kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } }
      : mode === 'current' || mode === 'changed'
        ? {
            kind: 'already-signed-in',
            viewer: { account_id: 'story-current-viewer' },
            requirements,
            verification: { configured: true },
            actions: { register: false, continue: true },
          }
        : registrationPage,
  );
  const [state, setState] = useState<SignupReturnState>({
    summary: { kind: mode === 'created' ? 'created' : 'unresolved' },
    status: mode === 'unavailable' ? 'unavailable' : mode === 'checking' ? 'restoring' : 'ready',
    restorationRequired: true,
    currentViewerChanged: mode === 'changed',
  });
  return (
    <AuthShell>
      <SignupReturnView
        state={state}
        page={page}
        query={query}
        follow={(event) => event.preventDefault()}
        retry={() => {
          // Current advice can recover independently of the earlier registration outcome.
          setPage(registrationPage);
          setState((current) => ({ ...current, status: 'ready' }));
        }}
        acknowledge={() => {}}
      />
    </AuthShell>
  );
}

export const UnknownOutcome = { render: () => <Returned mode="unknown" /> };
export const CreationAcknowledged = { render: () => <Returned mode="created" /> };
export const AdviceUnavailable = { render: () => <Returned mode="unavailable" /> };
export const ReviewingCurrentAdvice = { render: () => <Returned mode="checking" /> };
export const CurrentSession = { render: () => <Returned mode="current" /> };
export const ChangedViewer = { render: () => <Returned mode="changed" /> };
export const LongLocaleUnknown = { globals: { locale: 'de' }, render: () => <Returned mode="unknown" /> };
export const IndependentReadRecovery = {
  render: () => <Returned mode="unavailable" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_signup_return_retry_read()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_signup_return_unknown_heading()));
    if (!canvasElement.textContent?.includes(m.auth_signup_return_unknown_body()))
      throw new Error('Recovered advice must preserve the earlier unknown outcome');
    if (canvasElement.querySelector('form')) throw new Error('Read Retry must not create a new registration');
    if (!canvasElement.querySelector('a[href="/login?return_to=%2Fsecurity"]'))
      throw new Error('Return recovery must preserve the login query');
  },
};
