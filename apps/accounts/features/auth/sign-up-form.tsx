'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldSet, FieldLegend } from '@rezics/ui/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { type FormEvent, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { EmailField, emailPattern, NameField, PasswordField, passwordLength } from './fields.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import type { AccountLocale } from '../api/account-data.ts';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { Turnstile } from './turnstile.tsx';
import { PolicyLinks } from './policy-links.tsx';
import { acceptances, birthMonthValue, birthYears, regionName, type PolicyVersion } from './policies.ts';

const refusals = new Set<FailureKind>(['birth-month-required', 'invalid-birth-month', 'market-unavailable',
  'market-minimum-age', 'policy-acceptance-required']);

type Errors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'birth' | 'accept', string>>;

/** `policies`: the current versions Account will record an acceptance of; without them sign-up is paused.
 * `country`: the region the edge detected, shown so the minimum age that applies is no surprise. */
export function SignUpForm({ next, oauthQuery, carry = '', appName, turnstileSiteKey, policies, aboutOrigin = '',
  country }: { next: string; oauthQuery?: string; carry?: string; appName?: string | null;
  turnstileSiteKey?: string; policies?: PolicyVersion[]; aboutOrigin?: string; country?: string | null }) {
  const { t } = useTranslation('auth');
  // The account keeps the language it was created in, for its pages and emails.
  const locale = useLocale().current as AccountLocale;
  const { api, navigate } = useAccountClient();
  const [values, setValues] = useState({ name: '', email: '', password: '', confirm: '' });
  const [birth, setBirth] = useState({ month: '', year: '' });
  const [accepted, setAccepted] = useState(false);
  const [refusal, setRefusal] = useState<{ kind: FailureKind; minimumAge?: number }>();
  const region = regionName(country, locale);
  const years = birthYears();
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, index, 1))));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<FailureKind>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const signInQuery = new URLSearchParams(carry);
  if (carry) signInQuery.set('sign_in', '1');
  const signInHref = `/sign-in${signInQuery.size ? `?${signInQuery}` : ''}`;
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
      birth: birthMonthValue(birth.year, birth.month) ? undefined : t.birthMonthRequired,
      accept: accepted ? undefined : t.acceptRequired,
    };
    setErrors(found);
    setFailure(undefined);
    setRefusal(undefined);
    if (Object.values(found).some(Boolean)) return;
    if (!captchaToken || !policies) return setFailure('unavailable');
    setBusy(true);
    const result = await api.signUp({ name: values.name.trim(), email, password: values.password, locale, oauthQuery,
      carry, captchaToken, birthMonth: birthMonthValue(birth.year, birth.month),
      acceptedPolicies: acceptances(policies) });
    setCaptchaToken(undefined);
    setAttempt(current => current + 1);
    if (result.ok) {
      if (result.data.verify) { setBusy(false); return setSentTo(email); }
      return navigate(result.data.redirect ?? next);
    }
    setBusy(false);
    if (result.kind === 'password-too-short') setErrors({ password: t.passwordTooShort });
    else if (result.kind === 'password-too-long') setErrors({ password: t.passwordTooLong });
    else if (refusals.has(result.kind)) setRefusal({ kind: result.kind, minimumAge: result.minimumAge });
    else setFailure(result.kind);
  }

  if (sentTo) {
    return <AuthOutcome title={t.checkEmailTitle} body={t.checkEmailBody({ email: sentTo })}
      action={<Button asChild variant="outline" size="lg"><a href={signInHref}>
        {t.backToSignIn}</a></Button>} />;
  }
  const refusalMessage = !refusal ? undefined
    : refusal.kind === 'market-minimum-age' && refusal.minimumAge
      ? t.refusedAge({ region: region ?? t.yourRegion, age: String(refusal.minimumAge) })
      : refusal.kind === 'market-unavailable' ? t.refusedMarket({ region: region ?? t.yourRegion })
        : refusal.kind === 'invalid-birth-month' || refusal.kind === 'birth-month-required' ? t.birthMonthInvalid
          : refusal.kind === 'policy-acceptance-required' ? t.policiesChanged : t.signUpFailed;
  const failureMessage = captchaFailed ? t.challengeUnavailable : failure === 'rate-limited' ? t.tooManyAttempts
    : failure === 'expired-request' ? t.requestExpired
      : failure === 'unavailable' || failure === 'not-enabled' ? t.unavailable : t.signUpFailed;
  return <>
    <AuthHeading title={t.signUpTitle} subtitle={appName && appName !== 'REZICS'
      ? t.signUpForApp({ app: appName }) : t.signUpSubtitle} />
    {failure || captchaFailed || refusalMessage ? <Alert role="alert" variant="destructive" className="mb-6">
      <AlertDescription>{refusalMessage ?? failureMessage}</AlertDescription></Alert> : null}
    {!policies ? <Alert role="alert" variant="destructive" className="mb-6">
      <AlertDescription>{t.policiesUnavailable}</AlertDescription></Alert> : null}
    <form method="post" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-5">
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
      <FieldSet disabled={busy}>
        <FieldLegend variant="label">{t.birthMonthLegend}</FieldLegend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field invalid={!!errors.birth}>
            <NativeSelect size="lg" name="birth-month" aria-label={t.birthMonthLabel} className="w-full" value={birth.month}
              onChange={event => { const { value } = event.currentTarget; setBirth(current => ({ ...current, month: value }));
                setErrors(current => ({ ...current, birth: undefined })); }}>
              <NativeSelectOption value="">{t.birthMonthLabel}</NativeSelectOption>
              {monthNames.map((name, index) => <NativeSelectOption key={name} value={String(index + 1).padStart(2, '0')}>
                {name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field invalid={!!errors.birth}>
            <NativeSelect size="lg" name="birth-year" aria-label={t.birthYearLabel} className="w-full" value={birth.year}
              onChange={event => { const { value } = event.currentTarget; setBirth(current => ({ ...current, year: value }));
                setErrors(current => ({ ...current, birth: undefined })); }}>
              <NativeSelectOption value="">{t.birthYearLabel}</NativeSelectOption>
              {years.map(year => <NativeSelectOption key={year} value={String(year)}>{year}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        {errors.birth ? <p role="alert" className="mt-2 text-sm text-destructive-foreground">{errors.birth}</p> : null}
        <p className="mt-2 text-sm text-muted-foreground">{t.birthMonthHint}</p>
        <p className="mt-1 text-sm font-medium" data-region={country ?? 'unknown'}>
          {region ? t.regionDetected({ region }) : t.regionUnknown}</p>
      </FieldSet>
      {policies ? <Field orientation="horizontal" invalid={!!errors.accept} disabled={busy}>
        <Checkbox name="accept-policies" checked={accepted}
          onCheckedChange={({ checked }) => { setAccepted(checked === true);
            setErrors(current => ({ ...current, accept: undefined })); }} />
        <FieldContent>
          <FieldLabel>{t.acceptLead}</FieldLabel>
          <FieldDescription><PolicyLinks policies={policies} aboutOrigin={aboutOrigin} /></FieldDescription>
          <FieldError>{errors.accept}</FieldError>
        </FieldContent>
      </Field> : null}
      <Turnstile siteKey={turnstileSiteKey} attempt={attempt} onToken={token => {
        setCaptchaToken(token); if (token) setCaptchaFailed(false);
      }} onError={() => setCaptchaFailed(true)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="link" className="px-0" asChild>
          <a href={signInHref}>{t.signInInstead}</a></Button>
        <Button type="submit" size="lg" isLoading={busy} disabled={!captchaToken || !policies}>{busy ? t.creatingAccount : t.next}</Button>
      </div>
    </form>
  </>;
}
