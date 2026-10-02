'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { failureText } from '../account/failure-text.ts';
import type { FailureKind } from '../api/errors.ts';
import { PolicyLinks } from './policy-links.tsx';
import { acceptances, type PolicyVersion } from './policies.ts';

/** Asks a signed-in person to accept policies that changed since they last did, then resumes `next`. */
export function AcceptPolicies({ policies, aboutOrigin, next, signIn = '/sign-in?policy_declined=1' }: { policies: PolicyVersion[]; aboutOrigin: string;
  next: string; signIn?: string }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState<'accept' | 'decline'>();
  const [failed, setFailed] = useState<FailureKind>();

  async function accept() {
    setBusy('accept');
    setFailed(undefined);
    const result = await api.acceptPolicies(acceptances(policies));
    if (result.ok) return navigate(next);
    setBusy(undefined);
    setFailed(result.kind);
  }

  async function decline() {
    setBusy('decline');
    setFailed(undefined);
    const result = await api.signOut();
    if (result.ok || result.kind === 'unauthenticated') return navigate(signIn);
    setBusy(undefined);
    setFailed(result.kind);
  }

  return <>
    <AuthHeading title={t.acceptTitle} subtitle={t.acceptBody} />
    {failed ? <Alert role="alert" variant="destructive" className="mb-6">
      <AlertDescription>{failureText(failed, common)}</AlertDescription></Alert> : null}
    <p className="mb-6 text-base"><PolicyLinks policies={policies} aboutOrigin={aboutOrigin} /></p>
    <div className="flex flex-col gap-3">
      <Button size="lg" disabled={!!busy} isLoading={busy === 'accept'} onClick={() => void accept()}>
        {busy === 'accept' ? t.accepting : t.acceptButton}</Button>
      <Button variant="outline" size="lg" disabled={!!busy} isLoading={busy === 'decline'}
        onClick={() => void decline()}>{common.declinePolicies}</Button>
    </div>
  </>;
}

/** The current versions could not be read, so nothing is shown that could be accepted. */
export function PoliciesUnavailable() {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return <AuthOutcome icon="problem" title={t.acceptTitle} body={common.policyReviewUnavailable}
    action={<Button variant="outline" onClick={refresh}>{common.retry}</Button>} />;
}
