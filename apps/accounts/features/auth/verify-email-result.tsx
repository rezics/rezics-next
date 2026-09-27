'use client';

import { Button } from '@rezics/ui/button';
import { AuthOutcome } from './auth-outcome.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** Where a verification link lands: verified, the first step of an email
 * change, a changed email, or a link that no longer works. */
export function VerifyEmailResult({ failed, signedIn, change, carry = '' }: { failed: boolean; signedIn: boolean;
  change?: 'requested' | 'verified'; carry?: string }) {
  const { t } = useTranslation('auth');
  const signInQuery = new URLSearchParams(carry);
  if (carry) signInQuery.set('sign_in', '1');
  const signIn = <Button asChild size="lg"><a href={`/sign-in${signInQuery.size ? `?${signInQuery}` : ''}`}>
    {carry ? t.continueSignIn : t.signInNow}</a></Button>;
  const account = <Button asChild size="lg"><a href="/personal-info">{t.continueToAccount}</a></Button>;
  if (failed) {
    return <AuthOutcome icon="problem" title={t.verifyFailedTitle} body={change ? t.changeFailedBody : t.verifyFailedBody}
      action={signedIn ? account : <Button asChild size="lg"><a href="/sign-in">{t.backToSignIn}</a></Button>} />;
  }
  if (change === 'requested') {
    return <AuthOutcome title={t.changeRequestedTitle} body={t.changeRequestedBody}
      action={signedIn ? account : undefined} />;
  }
  if (change === 'verified') {
    return <AuthOutcome icon="done" title={t.changeVerifiedTitle} body={t.changeVerifiedBody}
      action={signedIn ? account : signIn} />;
  }
  return <AuthOutcome icon="done" title={t.verifyDoneTitle} body={signedIn || !carry ? t.verifyDoneBody : t.verifyDoneContinue}
    action={signedIn && !carry ? <Button asChild size="lg"><a href="/">{t.continueToAccount}</a></Button> : signIn} />;
}
