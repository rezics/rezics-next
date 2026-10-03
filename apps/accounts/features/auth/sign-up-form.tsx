'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { type FormEvent, useActionState, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from '../account/failure-text.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { EmailField, emailPattern, NameField, PasswordField, passwordLength } from './fields.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import type { AccountLocale } from '../api/account-data.ts';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { Turnstile } from './turnstile.tsx';
import { PolicyLinks } from './policy-links.tsx';
import { acceptances, regionName, type PolicyVersion } from './policies.ts';
import { formText, unchangedForm, type AuthFormAction } from './form-state.ts';
import { useFormResponse } from './form-response.ts';

const refusals = new Set<FailureKind>([
  'minimum-age-confirmation-required',
  'market-unavailable',
  'policy-acceptance-required',
]);

type Errors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'accept', string>>;

/** `policies`: the current versions Account will record an acceptance of; without them sign-up is paused.
 * `country`: the region the edge detected, named when registration is unavailable. */
export function SignUpForm({
  next,
  oauthQuery,
  carry = '',
  appName,
  turnstileSiteKey,
  policies,
  aboutOrigin = '',
  country,
  action,
}: {
  next: string;
  oauthQuery?: string;
  carry?: string;
  appName?: string | null;
  turnstileSiteKey?: string;
  policies?: PolicyVersion[];
  aboutOrigin?: string;
  country?: string | null;
  action?: AuthFormAction;
}) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  // The account keeps the language it was created in, for its pages and emails.
  const locale = useLocale().current as AccountLocale;
  const { api, navigate } = useAccountClient();
  const [native, submitNative] = useActionState(action ?? unchangedForm, {});
  const [values, setValues] = useState({
    name: native.name ?? '',
    email: native.email ?? '',
    password: '',
    confirm: '',
  });
  const [accepted, setAccepted] = useState(native.accepted ?? false);
  const [refusal, setRefusal] = useState<FailureKind | undefined>(
    native.failure && native.failure !== 'challenge-unavailable' && refusals.has(native.failure)
      ? native.failure
      : undefined,
  );
  const region = regionName(country, locale);
  const [errors, setErrors] = useState<Errors>(
    Object.fromEntries(
      Object.entries(native.errors ?? {}).map(([field, error]) => [field, t[error]]),
    ),
  );
  const [failure, setFailure] = useState<FailureKind | undefined>(
    native.failure === 'challenge-unavailable' ? undefined : native.failure,
  );
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | undefined>(
    native.outcome === 'sent' ? native.email : undefined,
  );
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [captchaFailed, setCaptchaFailed] = useState(native.failure === 'challenge-unavailable');
  useFormResponse(native, (state) => {
    setValues({ name: state.name ?? '', email: state.email ?? '', password: '', confirm: '' });
    setAccepted(state.accepted ?? false);
    setErrors(
      Object.fromEntries(
        Object.entries(state.errors ?? {}).map(([field, error]) => [field, t[error]]),
      ),
    );
    setFailure(state.failure === 'challenge-unavailable' ? undefined : state.failure);
    setRefusal(
      state.failure && state.failure !== 'challenge-unavailable' && refusals.has(state.failure)
        ? state.failure
        : undefined,
    );
    setCaptchaFailed(state.failure === 'challenge-unavailable');
    if (state.outcome === 'sent') setSentTo(state.email);
  });
  const signInQuery = new URLSearchParams(carry);
  if (carry) signInQuery.set('sign_in', '1');
  const signInHref = `/sign-in${signInQuery.size ? `?${signInQuery}` : ''}`;
  const change = (field: keyof typeof values) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = {
      name: formText(data, 'name'),
      email: formText(data, 'email'),
      password: formText(data, 'password'),
      confirm: formText(data, 'confirm'),
    };
    const accepted = data.has('accept-policies');
    const email = values.email.trim();
    const found: Errors = {
      name: values.name.trim() ? undefined : t.nameRequired,
      email: !email ? t.emailRequired : emailPattern.test(email) ? undefined : t.emailInvalid,
      password: values.password.length < passwordLength.min ? t.passwordTooShort : undefined,
      confirm:
        values.password && values.confirm !== values.password ? t.passwordMismatch : undefined,
      accept: accepted ? undefined : t.acceptRequired,
    };
    setErrors(found);
    setFailure(undefined);
    setRefusal(undefined);
    if (Object.values(found).some(Boolean)) return;
    if (!captchaToken && turnstileSiteKey !== 'local') return setCaptchaFailed(true);
    if (!policies) return;
    setBusy(true);
    const result = await api.signUp({
      name: values.name.trim(),
      email,
      password: values.password,
      locale,
      oauthQuery,
      carry,
      captchaToken,
      minimumAgeConfirmed: accepted,
      acceptedPolicies: acceptances(policies),
    });
    setCaptchaToken(undefined);
    setAttempt((current) => current + 1);
    if (result.ok) {
      if (result.data.verify) {
        setBusy(false);
        return setSentTo(email);
      }
      return navigate(result.data.redirect ?? next);
    }
    setBusy(false);
    if (result.kind === 'password-too-short') setErrors({ password: t.passwordTooShort });
    else if (result.kind === 'password-too-long') setErrors({ password: t.passwordTooLong });
    else if (refusals.has(result.kind)) setRefusal(result.kind);
    else setFailure(result.kind);
  }

  if (sentTo) {
    return (
      <AuthOutcome
        title={t.checkEmailTitle}
        body={t.checkEmailBody({ email: sentTo })}
        action={
          <Button asChild variant="outline" size="lg">
            <a href={signInHref}>{t.backToSignIn}</a>
          </Button>
        }
      />
    );
  }
  const refusalMessage = !refusal
    ? undefined
    : refusal === 'market-unavailable'
      ? t.refusedMarket({ region: region ?? t.yourRegion })
      : refusal === 'minimum-age-confirmation-required'
        ? t.acceptRequired
        : refusal === 'policy-acceptance-required'
          ? t.policiesChanged
          : failureText(refusal, common);
  const failureMessage = captchaFailed
    ? t.challengeUnavailable
    : failure === 'failed'
      ? t.signUpFailed
      : failure
        ? failureText(failure, common)
        : undefined;
  return (
    <>
      <AuthHeading
        title={t.signUpTitle}
        subtitle={
          appName && appName !== 'REZICS' ? t.signUpForApp({ app: appName }) : t.signUpSubtitle
        }
      />
      {failure || captchaFailed || refusalMessage ? (
        <Alert role="alert" variant="destructive" className="mb-6">
          <AlertDescription>{refusalMessage ?? failureMessage}</AlertDescription>
        </Alert>
      ) : null}
      {!policies ? (
        <Alert role="alert" variant="destructive" className="mb-6">
          <AlertDescription>{t.policiesUnavailable}</AlertDescription>
        </Alert>
      ) : null}
      <form
        action={action ? submitNative : undefined}
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-5"
      >
        <input type="hidden" name="operation" value="sign-up" />
        <NameField
          label={t.nameLabel}
          value={values.name}
          error={errors.name}
          autoFocus
          disabled={busy}
          onChange={change('name')}
        />
        <EmailField
          label={t.emailLabel}
          value={values.email}
          error={errors.email}
          autoComplete="email"
          disabled={busy}
          onChange={change('email')}
        />
        <div className="flex flex-col gap-5">
          <PasswordField
            label={t.newPasswordLabel}
            value={values.password}
            error={errors.password}
            autoComplete="new-password"
            visibilityLabel={t.showPassword}
            disabled={busy}
            onChange={change('password')}
          />
          <PasswordField
            label={t.confirmPasswordLabel}
            name="confirm"
            value={values.confirm}
            error={errors.confirm}
            autoComplete="new-password"
            visibilityLabel={t.showPassword}
            disabled={busy}
            onChange={change('confirm')}
          />
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">{t.passwordHint}</p>
        {policies ? (
          <Field orientation="horizontal" invalid={!!errors.accept} disabled={busy}>
            <Checkbox
              name="accept-policies"
              checked={accepted}
              onCheckedChange={({ checked }) => {
                setAccepted(checked === true);
                setErrors((current) => ({ ...current, accept: undefined }));
              }}
            />
            <FieldContent>
              <FieldLabel>{t.acceptLead}</FieldLabel>
              <FieldDescription>
                <PolicyLinks policies={policies} aboutOrigin={aboutOrigin} />
              </FieldDescription>
              <FieldError>{errors.accept}</FieldError>
            </FieldContent>
          </Field>
        ) : null}
        <Turnstile
          siteKey={turnstileSiteKey}
          attempt={attempt}
          onToken={(token) => {
            setCaptchaToken(token);
            if (token) setCaptchaFailed(false);
          }}
          onError={() => setCaptchaFailed(true)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="link" className="px-0" asChild>
            <a href={signInHref}>{t.signInInstead}</a>
          </Button>
          <Button
            type="submit"
            size="lg"
            isLoading={busy}
            disabled={(!captchaToken && turnstileSiteKey !== 'local') || !policies}
          >
            {busy ? t.creatingAccount : t.next}
          </Button>
        </div>
      </form>
    </>
  );
}
