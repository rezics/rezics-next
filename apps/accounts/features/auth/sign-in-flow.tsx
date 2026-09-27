'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { ChevronDownIcon, CircleCheckIcon, UserRoundIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { EmailField, emailPattern, PasswordField } from './fields.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface SignInFlowProps {
  /** Where to go after a plain sign-in; an OAuth request decides its own next step. */
  next: string;
  /** The signed pending authorization request, when an app sent the visitor here. */
  oauthQuery?: string;
  /** The query to carry to sign-up and recovery so an OAuth request survives. */
  carry?: string;
  /** Re-authentication of the signed-in account before a sensitive page. */
  reauthEmail?: string;
  notice?: 'deleted';
}

type Notice = FailureKind | 'verification-sent';

/** Identifier first, then password, as Google does. Neither step reveals
 * whether an account exists: every failure after the password is the same. */
export function SignInFlow({ next, oauthQuery, carry = '', reauthEmail, notice: initial }: SignInFlowProps) {
  const { t } = useTranslation('auth');
  const { api, navigate } = useAccountClient();
  const [step, setStep] = useState<'email' | 'password'>(reauthEmail ? 'password' : 'email');
  const [email, setEmail] = useState(reauthEmail ?? '');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const suffix = carry ? `?${carry}` : '';

  function submitEmail(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!value) return setEmailError(t.emailRequired);
    if (!emailPattern.test(value)) return setEmailError(t.emailInvalid);
    setEmail(value);
    setEmailError('');
    setNotice(undefined);
    setStep('password');
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!password) return setPasswordError(t.passwordRequired);
    setBusy(true);
    setNotice(undefined);
    const result = await api.signIn({ email, password, oauthQuery });
    if (result.ok) return navigate(result.data.redirect ?? next);
    setBusy(false);
    setPassword('');
    if (result.kind === 'invalid-credentials') setPasswordError(t.wrongPassword);
    else setNotice(result.kind);
  }

  async function resendVerification() {
    setBusy(true);
    await api.sendVerificationEmail(email);
    setBusy(false);
    setNotice('verification-sent');
  }

  const message = (kind: Notice) => kind === 'verification-sent'
    ? t.verificationSent({ email })
    : kind === 'email-not-verified' ? t.emailNotVerified
      : kind === 'rate-limited' ? t.tooManyAttempts
        : kind === 'expired-request' ? t.requestExpired : t.unavailable;

  return <>
    <AuthHeading title={reauthEmail ? t.reauthTitle : step === 'email' ? t.signInTitle : t.welcome}
      subtitle={step === 'email' ? oauthQuery ? t.signInForApp : t.signInSubtitle
        : reauthEmail ? t.reauthSubtitle : undefined}>
      {step === 'password' ? <button type="button" disabled={!!reauthEmail}
        className="mt-4 inline-flex max-w-full items-center gap-2 rounded-full border border-border/80 py-1 ps-1 pe-3 text-sm
          outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/32 disabled:pointer-events-none"
        aria-label={reauthEmail ? email : `${email} · ${t.differentEmail}`}
        onClick={() => { setStep('email'); setPassword(''); setPasswordError(''); setNotice(undefined); }}>
        <span className="grid size-6 place-items-center rounded-full bg-accent text-accent-foreground">
          <UserRoundIcon className="size-3.5" aria-hidden="true" /></span>
        <span className="truncate font-medium">{email}</span>
        {reauthEmail ? null : <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
      </button> : null}
    </AuthHeading>
    {initial === 'deleted' && step === 'email' ? <Alert variant="success" className="mb-6">
      <CircleCheckIcon aria-hidden="true" /><AlertDescription>{t.deletedNotice}</AlertDescription></Alert> : null}
    {notice ? <Alert role="alert" variant={notice === 'verification-sent' ? 'success' : 'destructive'}
      className="mb-6">
      <AlertDescription>{message(notice)}
        {notice === 'email-not-verified' ? <Button variant="outline" size="sm" className="w-fit"
          disabled={busy} onClick={resendVerification}>{t.sendVerification}</Button> : null}
      </AlertDescription></Alert> : null}
    {step === 'email'
      ? <form noValidate onSubmit={submitEmail} className="flex flex-col gap-6">
        <EmailField label={t.emailLabel} value={email} error={emailError} autoFocus
          onChange={value => { setEmail(value); setEmailError(''); }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="link" className="px-0" asChild><a href={`/sign-up${suffix}`}>{t.createAccount}</a></Button>
          <Button type="submit" size="lg">{t.next}</Button>
        </div>
      </form>
      : <form method="post" noValidate onSubmit={submitPassword} className="flex flex-col gap-6">
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <PasswordField label={t.passwordLabel} value={password} autoComplete="current-password" autoFocus
          visibilityLabel={t.showPassword} error={passwordError} disabled={busy}
          onChange={value => { setPassword(value); setPasswordError(''); }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="link" className="px-0" asChild>
            <a href={`/forgot-password?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(carry)), email })}`}>
              {t.forgotPassword}</a></Button>
          <Button type="submit" size="lg" isLoading={busy}>{busy ? t.signingIn : t.next}</Button>
        </div>
      </form>}
  </>;
}
