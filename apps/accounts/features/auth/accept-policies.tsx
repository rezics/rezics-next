'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { PolicyLinks } from './policy-links.tsx';
import { acceptances, type PolicyVersion } from './policies.ts';

/** Asks a signed-in person to accept policies that changed since they last did, then resumes `next`. */
export function AcceptPolicies({ policies, aboutOrigin, next }: { policies: PolicyVersion[]; aboutOrigin: string;
  next: string }) {
  const { t } = useTranslation('auth');
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function accept() {
    setBusy(true);
    setFailed(false);
    const result = await api.acceptPolicies(acceptances(policies));
    if (result.ok) return navigate(next);
    setBusy(false);
    setFailed(true);
  }

  return <>
    <AuthHeading title={t.acceptTitle} subtitle={t.acceptBody} />
    {failed ? <Alert role="alert" variant="destructive" className="mb-6">
      <AlertDescription>{t.acceptFailed}</AlertDescription></Alert> : null}
    <p className="mb-6 text-base"><PolicyLinks policies={policies} aboutOrigin={aboutOrigin} /></p>
    <div className="flex justify-end">
      <Button size="lg" isLoading={busy} onClick={() => void accept()}>{busy ? t.accepting : t.acceptButton}</Button>
    </div>
  </>;
}

/** The current versions could not be read, so nothing is shown that could be accepted. */
export function PoliciesUnavailable() {
  const { t } = useTranslation('auth');
  return <AuthOutcome icon="problem" title={t.acceptTitle} body={t.policiesUnavailable} />;
}
