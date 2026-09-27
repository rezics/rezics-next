import type { ReactNode } from 'react';
import { AccountShell, type AccountSection } from '../features/account/account-shell.tsx';

export const ada = { name: 'Ada Lovelace', email: 'ada@example.test', image: null, emailVerified: true };

/** An account section inside its shell, as the page renders it. */
export function AccountFrame({ section, signedIn = true, children }: { section: AccountSection;
  signedIn?: boolean; children: ReactNode }) {
  return <AccountShell section={section} user={signedIn ? ada : undefined} webOrigin="https://rezics.test">
    {children}</AccountShell>;
}
