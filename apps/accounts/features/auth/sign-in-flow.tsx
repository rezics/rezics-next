'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChevronDownIcon, CircleCheckIcon, FingerprintIcon, UserRoundIcon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { autofocus, CodeField, EmailField, emailPattern, PasswordField } from './fields.tsx';
import { autofillSupported, passkeysSupported } from './webauthn.ts';
import { useTranslation } from '../../i18n/client.ts';
import { authorizationAfterCreate } from './auth-query.ts';

export interface SignInFlowProps {
  /** Where to go after a plain sign-in; an OAuth request decides its own next step. */
  next: string;
  /** The signed pending authorization request, when an app sent the visitor here. */
  oauthQuery?: string;
  /** The requesting app's name, read from its public registration. */
  appName?: string | null;
  /** The query to carry to sign-up and recovery so an OAuth request survives. */
  carry?: string;
  /** Re-authentication of the signed-in account before a sensitive page. */
  reauthEmail?: string;
  notice?: 'deleted';
}

type Step = 'email' | 'password' | 'two-factor';
type Notice = FailureKind | 'verification-sent' | 'passkey-failed' | 'two-factor-expired';

/** Identifier first, then password, as Google does, with passkeys offered in
 * the email field's autofill and as a button. Neither step reveals whether an
 * account exists: every failure after the password is the same. */
export function SignInFlow({ next, oauthQuery, appName, carry = '', reauthEmail, notice: initial }: SignInFlowProps) {
  const { t } = useTranslation('auth');
  const { api, navigate } = useAccountClient();
  const [step, setStep] = useState<Step>(reauthEmail ? 'password' : 'email');
  const [email, setEmail] = useState(reauthEmail ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<'password' | 'passkey' | 'code' | 'resend'>();
  const [passkeys, setPasskeys] = useState(true);
  const autofill = useRef<AbortController>(undefined);
  const suffix = carry ? `?${carry}` : '';

  const finish = (redirect?: string) => navigate(authorizationAfterCreate(oauthQuery) ?? redirect ?? next);
  // Offer this account's passkeys in the email field's autofill while it shows.
  useEffect(() => {
    setPasskeys(passkeysSupported());
    if (step !== 'email') return;
    const controller = new AbortController();
    autofill.current = controller;
    void autofillSupported().then(async supported => {
      if (!supported || controller.signal.aborted) return;
      const result = await api.signInWithPasskey({ oauthQuery, conditional: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) return finish(result.data.redirect);
      if (result.kind !== 'cancelled') setNotice(result.kind === 'invalid-credentials' ? 'passkey-failed' : result.kind);
    });
    return () => controller.abort();
    // Restarted only when the email step shows again, not on every render.
  }, [step]);

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

  async function usePasskey() {
    autofill.current?.abort();
    setBusy('passkey');
    setNotice(undefined);
    const result = await api.signInWithPasskey({ oauthQuery });
    if (result.ok) return finish(result.data.redirect);
    setBusy(undefined);
    if (result.kind !== 'cancelled') setNotice(result.kind === 'invalid-credentials' ? 'passkey-failed' : result.kind);
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!password) return setPasswordError(t.passwordRequired);
    setBusy('password');
    setNotice(undefined);
    const result = await api.signIn({ email, password, oauthQuery });
    setPassword('');
    if (result.ok && result.data.twoFactor) {
      setBusy(undefined);
      setCode('');
      setCodeError('');
      return setStep('two-factor');
    }
    if (result.ok) return finish(result.data.redirect);
    setBusy(undefined);
    if (result.kind === 'invalid-credentials') setPasswordError(t.wrongPassword);
    else setNotice(result.kind);
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!backup && !/^\d{6}$/.test(value)) return setCodeError(t.codeRequired);
    if (backup && !value) return setCodeError(t.backupCodeRequired);
    setBusy('code');
    setNotice(undefined);
    const result = await api.verifyTwoFactor({ code: value, method: backup ? 'backup-code' : 'totp', trustDevice,
      oauthQuery });
    if (result.ok) return finish(result.data.redirect);
    setBusy(undefined);
    setCode('');
    if (result.kind === 'invalid-code' || result.kind === 'invalid-credentials') {
      return setCodeError(backup ? t.backupCodeWrong : t.codeWrong);
    }
    if (result.kind === 'stale') { setStep('password'); return setNotice('two-factor-expired'); }
    setNotice(result.kind);
  }

  async function resendVerification() {
    setBusy('resend');
    await api.sendVerificationEmail(email);
    setBusy(undefined);
    setNotice('verification-sent');
  }

  const message = (kind: Notice) => kind === 'verification-sent' ? t.verificationSent({ email })
    : kind === 'email-not-verified' ? t.emailNotVerified
      : kind === 'rate-limited' ? t.tooManyAttempts
        : kind === 'expired-request' ? t.requestExpired
          : kind === 'passkey-failed' ? t.passkeyFailed
            : kind === 'two-factor-expired' ? t.twoFactorExpired : t.unavailable;
  const subtitle = step === 'two-factor' ? backup ? t.backupCodeSubtitle : t.twoFactorSubtitle
    : step === 'email' ? appName ? t.signInToApp({ app: appName }) : oauthQuery ? t.signInForApp : t.signInSubtitle
      : reauthEmail ? t.reauthSubtitle : undefined;
  const accountChip = step !== 'email' ? <button type="button" disabled={!!reauthEmail}
    className="mt-4 inline-flex max-w-full items-center gap-2 rounded-full border border-border/80 py-1 ps-1 pe-3 text-sm
      outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/32 disabled:pointer-events-none"
    aria-label={reauthEmail ? email : `${email} · ${t.differentEmail}`}
    onClick={() => { setStep('email'); setPassword(''); setPasswordError(''); setNotice(undefined); setBackup(false); }}>
    <span className="grid size-6 place-items-center rounded-full bg-accent text-accent-foreground">
      <UserRoundIcon className="size-3.5" aria-hidden="true" /></span>
    <span className="truncate font-medium">{email}</span>
    {reauthEmail ? null : <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
  </button> : null;
  const passkeyButton = passkeys ? <Button type="button" variant="outline" size="lg" className="w-full"
    isLoading={busy === 'passkey'} disabled={!!busy} onClick={() => void usePasskey()}>
    <FingerprintIcon aria-hidden="true" />{t.signInWithPasskey}</Button> : null;

  return <>
    <AuthHeading title={reauthEmail ? t.reauthTitle : step === 'email' ? t.signInTitle
      : step === 'two-factor' ? t.twoFactorTitle : t.welcome} subtitle={subtitle}>{accountChip}</AuthHeading>
    {initial === 'deleted' && step === 'email' ? <Alert variant="success" className="mb-6">
      <CircleCheckIcon aria-hidden="true" /><AlertDescription>{t.deletedNotice}</AlertDescription></Alert> : null}
    {notice ? <Alert role="alert" variant={notice === 'verification-sent' ? 'success' : 'destructive'}
      className="mb-6">
      <AlertDescription>{message(notice)}
        {notice === 'email-not-verified' ? <Button variant="outline" size="sm" className="w-fit"
          disabled={!!busy} onClick={() => void resendVerification()}>{t.sendVerification}</Button> : null}
      </AlertDescription></Alert> : null}
    {step === 'email'
      ? <div className="flex flex-col gap-6">
        <form noValidate onSubmit={submitEmail} className="flex flex-col gap-6">
          <EmailField label={t.emailLabel} value={email} error={emailError} autoFocus autoComplete="username webauthn"
            onChange={value => { setEmail(value); setEmailError(''); }} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="link" className="px-0" asChild><a href={`/sign-up${suffix}`}>{t.createAccount}</a></Button>
            <Button type="submit" size="lg">{t.next}</Button>
          </div>
        </form>
        {passkeyButton ? <><div className="flex items-center gap-3 text-sm text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />{t.or}<span className="h-px flex-1 bg-border" /></div>
        {passkeyButton}</> : null}
      </div>
      : step === 'password'
        ? <form method="post" noValidate onSubmit={event => void submitPassword(event)} className="flex flex-col gap-6">
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          <PasswordField label={t.passwordLabel} value={password} autoComplete="current-password" autoFocus
            visibilityLabel={t.showPassword} error={passwordError} disabled={!!busy}
            onChange={value => { setPassword(value); setPasswordError(''); }} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="link" className="px-0" asChild>
              <a href={`/forgot-password?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(carry)), email })}`}>
                {t.forgotPassword}</a></Button>
            <Button type="submit" size="lg" isLoading={busy === 'password'} disabled={!!busy}>
              {busy === 'password' ? t.signingIn : t.next}</Button>
          </div>
          {reauthEmail ? passkeyButton : null}
        </form>
        : <form method="post" noValidate onSubmit={event => void submitCode(event)} className="flex flex-col gap-6">
          {backup ? <Field invalid={!!codeError} disabled={!!busy}>
            <FieldLabel>{t.backupCodeLabel}</FieldLabel>
            <Input size="lg" name="backup-code" autoComplete="off" autoCapitalize="none" spellCheck={false} {...autofocus(true)}
              className="font-mono" value={code} onChange={event => { setCode(event.currentTarget.value); setCodeError(''); }} />
            <FieldError>{codeError}</FieldError>
          </Field> : <CodeField label={t.codeLabel} value={code} error={codeError} autoFocus disabled={!!busy}
            onChange={value => { setCode(value); setCodeError(''); }} />}
          <label className="flex w-fit items-center gap-3 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-primary" checked={trustDevice} disabled={!!busy}
              onChange={event => setTrustDevice(event.currentTarget.checked)} />
            {t.trustDevice}</label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="link" className="px-0" disabled={!!busy}
              onClick={() => { setBackup(!backup); setCode(''); setCodeError(''); }}>
              {backup ? t.useAuthenticator : t.useBackupCode}</Button>
            <Button type="submit" size="lg" isLoading={busy === 'code'} disabled={!!busy}>
              {busy === 'code' ? t.signingIn : t.next}</Button>
          </div>
        </form>}
  </>;
}
