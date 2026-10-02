'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { type FormEvent, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from '../account/failure-text.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { EmailField, emailPattern } from './fields.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { Turnstile } from './turnstile.tsx';

/** Request a reset link. The answer is the same whether or not the email has
 * an account; a service without email delivery says so plainly. */
export function RecoveryForm({ email: initial = '', carry = '', turnstileSiteKey }: { email?: string; carry?: string;
  turnstileSiteKey?: string }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [email, setEmail] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'sent' | FailureKind>();
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const back = <Button asChild variant="outline" size="lg">
    <a href={`/sign-in${carry ? `?${carry}` : ''}`}>{t.backToSignIn}</a></Button>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!value) return setError(t.emailRequired);
    if (!emailPattern.test(value)) return setError(t.emailInvalid);
    if (!captchaToken) return setCaptchaFailed(true);
    setBusy(true);
    setOutcome(undefined);
    const result = await api.requestPasswordReset(value, captchaToken);
    setCaptchaToken(undefined);
    setAttempt(current => current + 1);
    setBusy(false);
    setEmail(value);
    setOutcome(result.ok ? 'sent' : result.kind);
  }

  if (outcome === 'sent') {
    return <AuthOutcome title={t.checkEmailTitle} body={t.resetSentBody({ email })} action={back} />;
  }
  if (outcome === 'not-enabled') {
    return <AuthOutcome icon="problem" title={t.emailNotAvailableTitle} body={t.emailNotAvailableBody}
      action={back} />;
  }
  return <>
    <AuthHeading title={t.recoveryTitle} subtitle={t.recoveryBody} />
    {outcome || captchaFailed ? <Alert role="alert" variant="destructive" className="mb-6"><AlertDescription>
      {captchaFailed ? t.challengeUnavailable : outcome ? failureText(outcome, common) : t.challengeUnavailable}</AlertDescription></Alert> : null}
    <form noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-6">
      <EmailField label={t.emailLabel} value={email} error={error} autoFocus disabled={busy}
        onChange={value => { setEmail(value); setError(''); }} />
      <Turnstile siteKey={turnstileSiteKey} attempt={attempt} onToken={token => {
        setCaptchaToken(token); if (token) setCaptchaFailed(false);
      }} onError={() => setCaptchaFailed(true)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="link" className="px-0" asChild>
          <a href={`/sign-in${carry ? `?${carry}` : ''}`}>{t.backToSignIn}</a></Button>
        <Button type="submit" size="lg" isLoading={busy} disabled={!captchaToken}>{busy ? t.sending : t.sendResetLink}</Button>
      </div>
    </form>
  </>;
}
