'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { type FormEvent, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { EmailField, emailPattern, NameField, PasswordField, passwordLength } from './fields.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { useTranslation } from '../../i18n/client.ts';

type Errors = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>;

export function SignUpForm({ next, oauthQuery, carry = '' }: { next: string; oauthQuery?: string;
  carry?: string }) {
  const { t } = useTranslation('auth');
  const { api, navigate } = useAccountClient();
  const [values, setValues] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<FailureKind>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const change = (field: keyof typeof values) => (value: string) => {
    setValues(current => ({ ...current, [field]: value }));
    setErrors(current => ({ ...current, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const email = values.email.trim();
    const found: Errors = {
      name: values.name.trim() ? undefined : t.nameRequired,
      email: !email ? t.emailRequired : emailPattern.test(email) ? undefined : t.emailInvalid,
      password: values.password.length < passwordLength.min ? t.passwordTooShort : undefined,
      confirm: values.password && values.confirm !== values.password ? t.passwordMismatch : undefined,
    };
    setErrors(found);
    setFailure(undefined);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    const result = await api.signUp({ name: values.name.trim(), email, password: values.password, oauthQuery });
    if (result.ok) {
      if (result.data.verify) { setBusy(false); return setSentTo(email); }
      return navigate(result.data.redirect ?? next);
    }
    setBusy(false);
    if (result.kind === 'password-too-short') setErrors({ password: t.passwordTooShort });
    else if (result.kind === 'password-too-long') setErrors({ password: t.passwordTooLong });
    else setFailure(result.kind);
  }

  if (sentTo) {
    return <AuthOutcome title={t.checkEmailTitle} body={t.checkEmailBody({ email: sentTo })}
      action={<Button asChild variant="outline" size="lg"><a href={`/sign-in${carry ? `?${carry}` : ''}`}>
        {t.backToSignIn}</a></Button>} />;
  }
  const failureMessage = failure === 'rate-limited' ? t.tooManyAttempts
    : failure === 'expired-request' ? t.requestExpired
      : failure === 'unavailable' || failure === 'not-enabled' ? t.unavailable : t.signUpFailed;
  return <>
    <AuthHeading title={t.signUpTitle} subtitle={t.signUpSubtitle} />
    {failure ? <Alert role="alert" variant="destructive" className="mb-6">
      <AlertDescription>{failureMessage}</AlertDescription></Alert> : null}
    <form method="post" noValidate onSubmit={submit} className="flex flex-col gap-5">
      <NameField label={t.nameLabel} value={values.name} error={errors.name} autoFocus disabled={busy}
        onChange={change('name')} />
      <EmailField label={t.emailLabel} value={values.email} error={errors.email} autoComplete="email"
        disabled={busy} onChange={change('email')} />
      <div className="grid gap-5 sm:grid-cols-2">
        <PasswordField label={t.newPasswordLabel} value={values.password} error={errors.password}
          autoComplete="new-password" visibilityLabel={t.showPassword} disabled={busy}
          onChange={change('password')} />
        <PasswordField label={t.confirmPasswordLabel} name="confirm" value={values.confirm}
          error={errors.confirm} autoComplete="new-password" visibilityLabel={t.showPassword}
          disabled={busy} onChange={change('confirm')} />
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">{t.passwordHint}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="link" className="px-0" asChild>
          <a href={`/sign-in${carry ? `?${carry}` : ''}`}>{t.signInInstead}</a></Button>
        <Button type="submit" size="lg" isLoading={busy}>{busy ? t.creatingAccount : t.next}</Button>
      </div>
    </form>
  </>;
}
