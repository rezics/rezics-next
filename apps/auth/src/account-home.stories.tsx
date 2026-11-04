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

const LocalizedPage = observeLocaleComponent(function LocalizedPage({ state }: { state: AccountIdentityState }) {
  return page(state);
});

export const Loading = { render: () => <LocalizedPage state={{ kind: 'loading' }} /> };
export const ReadyWithoutEmail = { render: () => <LocalizedPage state={current} /> };
export const SignedOut = { render: () => <LocalizedPage state={{ kind: 'signed-out' }} /> };
export const Denied = { render: () => <LocalizedPage state={{ kind: 'denied' }} /> };
export const Unavailable = { render: () => <LocalizedPage state={{ kind: 'unavailable' }} /> };
