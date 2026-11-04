import { AuthShell } from './frame';
import { observeLocaleComponent } from './locale-observation';
import { AccountHomeView } from './account-home-view';
import type { AccountIdentityState } from './account-identity';
import { reviewParameters } from './stories/accounts-operations/story';
import './styles.css';

export default {
  title: 'Pages/Auth/Account home',
  parameters: reviewParameters,
};

const current: AccountIdentityState = {
  kind: 'ready',
  accountId: 'sample-account',
  email: null,
};

function page(state: AccountIdentityState) {
  return (
    <AuthShell>
      <AccountHomeView state={state} retry={() => {}} retryFocusVersion={0} />
    </AuthShell>
  );
}

function localized(state: AccountIdentityState) {
  return observeLocaleComponent(function LocalizedPage() {
    return page(state);
  });
}

const LoadingPage = localized({ kind: 'loading' });
const ReadyPage = localized(current);
const SignedOutPage = localized({ kind: 'signed-out' });
const DeniedPage = localized({ kind: 'denied' });
const UnavailablePage = localized({ kind: 'unavailable' });

export const Loading = { render: () => <LoadingPage /> };
export const ReadyWithoutEmail = { render: () => <ReadyPage /> };
export const SignedOut = { render: () => <SignedOutPage /> };
export const Denied = { render: () => <DeniedPage /> };
export const Unavailable = { render: () => <UnavailablePage /> };
