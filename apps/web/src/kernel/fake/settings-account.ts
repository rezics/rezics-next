import type { AccountSafetyProps } from '../../settings/account-safety';
import { securityHrefFromIssuer } from '../../settings/account-safety-links';
import { settingsSections } from '../../settings/sections-navigation';

export type AccountSafetyExample = 'ready' | 'missing-issuer' | 'signed-out' | 'missing-csrf';

/** Interface examples only: these do not perform or authorize an account operation. */
export type SettingsAccountExampleProps =
  | Extract<AccountSafetyProps, { state: 'signed-in' }>
  | Omit<Extract<AccountSafetyProps, { state: 'signed-out' }>, 'SignInPrompt'>;

export function settingsAccountExample(example: AccountSafetyExample, onReload: () => void): SettingsAccountExampleProps {
  if (example === 'signed-out') return { state: 'signed-out', returnTo: '/settings#account' };
  return {
    state: 'signed-in',
    securityHref: securityHrefFromIssuer(example === 'missing-issuer' ? undefined : 'https://auth.example.test'),
    csrfToken: example === 'missing-csrf' ? null : 'AAAAAAAAAAAAAAAAAAAAAA',
    onReload,
  };
}

export function settingsNavigationExample(state: 'ready' | 'closed' | 'preparing' | 'unavailable' = 'ready') {
  return settingsSections({
    notifications: state === 'ready',
    collections: state === 'ready',
    verification: state === 'ready',
    readingState: state === 'ready' ? undefined : state,
  });
}
