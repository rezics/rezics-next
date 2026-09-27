'use client';

import { Button } from '@rezics/ui/button';
import { AuthOutcome } from './auth-outcome.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** Where a verification link lands: Better Auth adds `error` when it failed. */
export function VerifyEmailResult({ failed }: { failed: boolean }) {
  const { t } = useTranslation('auth');
  return failed
    ? <AuthOutcome icon="problem" title={t.verifyFailedTitle} body={t.verifyFailedBody}
      action={<Button asChild size="lg"><a href="/sign-in">{t.backToSignIn}</a></Button>} />
    : <AuthOutcome icon="done" title={t.verifyDoneTitle} body={t.verifyDoneBody}
      action={<Button asChild size="lg"><a href="/">{t.continueToAccount}</a></Button>} />;
}
