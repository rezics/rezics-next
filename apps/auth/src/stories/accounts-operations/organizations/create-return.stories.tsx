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
  return (
    <AuthStory>
      <main className={`auth-login-form mx-auto w-full max-w-2xl p-6 ${theme === 'dark' ? 'dark' : ''}`}>
        <OrganizationCreateReturnView {...props} />
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
