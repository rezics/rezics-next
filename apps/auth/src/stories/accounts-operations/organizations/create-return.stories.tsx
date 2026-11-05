import { useState } from 'react';
import { OrganizationCreateReturnView } from '../../../organization-create-return-view';
import { AuthStory, authLocale, reviewParameters } from '../story';
import type { OrganizationCreateReturnViewProps } from '../../../organization-create-return-view';

const phoneViewport = { viewport: { ...reviewParameters.viewport, defaultViewport: 'phone390' } };
const desktopViewport = { viewport: { ...reviewParameters.viewport, defaultViewport: 'desktop1280' } };

export default {
  title: 'Pages/Account/Organization creation return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

function example(props: OrganizationCreateReturnViewProps, theme: 'light' | 'dark' = 'light') {
  return <ReturnExample props={props} theme={theme} />;
}

function ReturnExample({ props, theme }: { props: OrganizationCreateReturnViewProps; theme: 'light' | 'dark' }) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <AuthStory>
      <main className={`auth-login-form mx-auto w-full max-w-2xl p-6 ${theme === 'dark' ? 'dark' : ''}`}>
        <OrganizationCreateReturnView {...props} dismissed={dismissed} dismiss={() => setDismissed(true)} />
      </main>
    </AuthStory>
  );
}

export const PendingApproval = {
  parameters: phoneViewport,
  render: () => example({ phase: 'approval', pending: true, history: 'unconfirmed' }),
};

export const PendingExecution = {
  parameters: phoneViewport,
  render: () => example({ phase: 'execution', history: 'unconfirmed' }, 'dark'),
};

export const UnknownSameAccount = {
  parameters: desktopViewport,
  render: () =>
    example({
      phase: 'unknown',
      history: 'unconfirmed',
      canRetryRead: true,
      canRetryCreation: true,
      readRetry: () => {},
      creationRetry: () => {},
    }),
};

export const SignedOutUnknown = {
  parameters: phoneViewport,
  render: () => example({ phase: 'unknown', history: 'unconfirmed', signedOut: true }, 'dark'),
};

export const AccountChanged = {
  parameters: desktopViewport,
  render: () => example({ phase: 'unresumable', history: 'unconfirmed', canRetryRead: true, readRetry: () => {} }),
};

export const RecoveryStorageReplaced = {
  parameters: phoneViewport,
  render: () =>
    example({ phase: 'unresumable', history: 'unconfirmed', canRetryRead: true, readRetry: () => {} }, 'dark'),
};

export const AcknowledgedReturn = {
  parameters: desktopViewport,
  render: () => example({ phase: 'acknowledged', history: 'acknowledged' }),
};

export const AcknowledgedCreation = {
  parameters: phoneViewport,
  render: () =>
    example(
      {
        phase: 'acknowledged',
        history: 'acknowledged',
        handle: 'reading-group',
        accountId: '20000000-0000-7000-8000-000000000002',
      },
      'dark',
    ),
};

export const AcknowledgedCheckingAdvice = {
  parameters: phoneViewport,
  render: () =>
    example({ phase: 'acknowledged', history: 'acknowledged', pending: true, checkingAdvice: true }, 'dark'),
};

export const AcknowledgedReadFailed = {
  parameters: desktopViewport,
  render: () => example({ phase: 'unavailable', history: 'acknowledged', canRetryRead: true, readRetry: () => {} }),
};

export const AcknowledgedSignedOut = {
  parameters: phoneViewport,
  render: () => example({ phase: 'acknowledged', history: 'acknowledged', signedOut: true }),
};

export const AcknowledgedContextReplaced = {
  parameters: desktopViewport,
  render: () =>
    example({ phase: 'unresumable', history: 'acknowledged', canRetryRead: true, readRetry: () => {} }, 'dark'),
};

export const AcknowledgedAdviceRecovered = {
  parameters: phoneViewport,
  render: () => example({ phase: 'acknowledged', history: 'acknowledged', adviceReady: true }, 'dark'),
};
