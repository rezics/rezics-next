import { fn } from 'storybook/test';
import type { AccountClient } from '../features/api/account-client.tsx';
import type { AccountApi } from '../features/api/client.ts';

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

/** Story parameter `account`: API outcomes to fake and spies to assert on. */
export interface FakeAccount { api?: Partial<AccountApi>; navigate?: (url: string) => void;
  refresh?: () => void }

export function fakeAccountClient(fake: FakeAccount = {}): AccountClient {
  const api: AccountApi = {
    signIn: () => ok({}), signUp: () => ok({}), requestPasswordReset: () => ok(undefined),
    resetPassword: () => ok(undefined), sendVerificationEmail: () => ok(undefined),
    signOut: () => ok(undefined), consent: () => ok({ redirect: 'https://app.example/callback?code=c' }),
    updateName: () => ok(undefined), changeEmail: () => ok(undefined),
    changePassword: () => ok(undefined), revokeSession: () => ok(undefined),
    revokeOtherSessions: () => ok(undefined), removeAppAccess: () => ok(undefined),
    deleteAccount: () => ok(undefined), ...fake.api,
  };
  return { api, navigate: fake.navigate ?? fn(), refresh: fake.refresh ?? fn() };
}
