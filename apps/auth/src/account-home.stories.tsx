import { useState } from 'react';
import { AuthButton } from './button';
import { AuthShell } from './frame';
import { initializeDocumentLocale, observeLocaleComponent } from './locale-observation';
import { AccountHome, AccountHomeView } from './account-home-view';
import type { AccountIdentitySource, AccountIdentityState, AccountIdentityResult } from './account-identity';
import { reviewParameters } from './stories/accounts-operations/story';
import './styles.css';

export default {
  title: 'Pages/Auth/Account home',
  parameters: reviewParameters,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  decorators: [
    (Story: () => React.ReactNode, context: { globals: Record<string, unknown> }) => {
      initializeDocumentLocale(String(context.globals.locale ?? 'en'));
      return <Story />;
    },
  ],
};

const current: AccountIdentityState = {
  kind: 'ready',
  accountId: 'sample-account',
  email: 'reader@example.test',
};

function localized(state: AccountIdentityState) {
  return observeLocaleComponent(function LocalizedPage() {
    const [retrying, setRetrying] = useState(false);
    return (
      <AuthShell>
        <AccountHomeView
          state={retrying ? { kind: 'loading' } : state}
          retry={() => {
            setRetrying(true);
            window.setTimeout(() => setRetrying(false), 650);
          }}
          retryFocusVersion={retrying ? 1 : 0}
        />
      </AuthShell>
    );
  });
}

const LoadingPage = localized({ kind: 'loading' });
const ReadyPage = localized(current);
const MissingEmailPage = localized({ kind: 'ready', accountId: 'sample-account', email: null });
const SignedOutPage = localized({ kind: 'signed-out' });
const DeniedPage = localized({ kind: 'denied' });
const UnavailablePage = localized({ kind: 'unavailable' });

const initialSource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: 'first-account',
  email: 'first@example.test',
});
const ReplacementPage = observeLocaleComponent(function ReplacementPage() {
  const [source, setSource] = useState(() => initialSource);
  const [finish, setFinish] = useState<(() => void) | null>(null);
  return (
    <AuthShell>
      <div className="auth-login-links">
        <AuthButton
          onClick={() => {
            let complete!: (result: AccountIdentityResult) => void;
            const pending = new Promise<AccountIdentityResult>((resolve) => {
              complete = resolve;
            });
            setSource(() => () => pending);
            setFinish(() => () => {
              complete({ kind: 'ready', accountId: 'replacement-account', email: 'replacement@example.test' });
              setFinish(null);
            });
          }}
        >
          Replace current read
        </AuthButton>
        {finish ? <AuthButton onClick={finish}>Complete replacement read</AuthButton> : null}
      </div>
      <AccountHome source={source} />
    </AuthShell>
  );
});

// Every state supports the eight-locale, theme and 390/1280 viewport toolbar controls.
export const Ready = { render: () => <ReadyPage /> };
export const ReadyWithoutEmail = { render: () => <MissingEmailPage /> };
export const Loading = { render: () => <LoadingPage /> };
export const SignedOut = { render: () => <SignedOutPage /> };
export const Denied = { render: () => <DeniedPage /> };
export const Unavailable = { render: () => <UnavailablePage /> };
export const CurrentReadReplacement = { render: () => <ReplacementPage /> };

const phoneDark = { theme: 'dark', viewport: { value: 'phone390', isRotated: false } };
export const ReadyPhoneDark = { ...Ready, globals: phoneDark };
export const MissingEmailPhoneDark = { ...ReadyWithoutEmail, globals: phoneDark };
export const LoadingPhoneDark = { ...Loading, globals: phoneDark };
export const SignedOutPhoneDark = { ...SignedOut, globals: phoneDark };
export const DeniedPhoneDark = { ...Denied, globals: phoneDark };
export const UnavailablePhoneDark = { ...Unavailable, globals: phoneDark };
export const ReplacementPhoneDark = { ...CurrentReadReplacement, globals: phoneDark };
