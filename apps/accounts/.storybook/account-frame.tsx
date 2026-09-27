import type { ReactNode } from 'react';
import { AccountShell } from '../features/account/account-shell.tsx';
import type { AccountSection } from '../features/account/sections.ts';
import type { StepUpMethods } from '../features/account/step-up.tsx';

export const ada = { name: 'Ada Lovelace', email: 'ada@example.test', image: null, emailVerified: true,
  locale: null };

/** An account section inside its shell, as the page renders it; `stepUp` is
 * how the signed-in person confirms sensitive changes. */
export function AccountFrame({ section, signedIn = true, stepUp, children }: { section: AccountSection;
  signedIn?: boolean; stepUp?: StepUpMethods; children: ReactNode }) {
  return <AccountShell section={section} user={signedIn ? ada : undefined} webOrigin="https://rezics.test"
    stepUp={stepUp}>{children}</AccountShell>;
}
