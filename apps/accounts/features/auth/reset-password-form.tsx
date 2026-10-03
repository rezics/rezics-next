'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { type FormEvent, useActionState, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from '../account/failure-text.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { PasswordField, passwordLength } from './fields.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { formText, unchangedForm, type AuthFormAction } from './form-state.ts';
import { useFormResponse } from './form-response.ts';

/** The page a reset email links to: Better Auth appends `token`, or `error`
 * when the link is invalid or expired. */
export function ResetPasswordForm({ token, action }: { token?: string; action?: AuthFormAction }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [native, submitNative] = useActionState(action ?? unchangedForm, {});
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({
    password: native.errors?.password ? t[native.errors.password] : undefined,
    confirm: native.errors?.confirm ? t[native.errors.confirm] : undefined,
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'done' | FailureKind | undefined>(
    !token
      ? 'invalid-token'
      : native.outcome === 'done'
        ? 'done'
        : native.failure === 'challenge-unavailable'
          ? undefined
          : native.failure,
  );
  useFormResponse(native, (state) => {
    setPassword('');
    setConfirm('');
    setErrors({
      password: state.errors?.password ? t[state.errors.password] : undefined,
      confirm: state.errors?.confirm ? t[state.errors.confirm] : undefined,
    });
    setOutcome(
      state.outcome === 'done'
        ? 'done'
        : state.failure === 'challenge-unavailable'
          ? undefined
          : state.failure,
    );
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = formText(data, 'password');
    const confirm = formText(data, 'confirm');
    const found = {
      password: password.length < passwordLength.min ? t.passwordTooShort : undefined,
      confirm: confirm !== password ? t.passwordMismatch : undefined,
    };
    setErrors(found);
    if (found.password || found.confirm || !token) return;
    setBusy(true);
    const result = await api.resetPassword(token, password);
    setBusy(false);
    if (result.ok) return setOutcome('done');
    if (result.kind === 'password-too-short') return setErrors({ password: t.passwordTooShort });
    if (result.kind === 'password-too-long') return setErrors({ password: t.passwordTooLong });
    setOutcome(result.kind);
  }

  if (outcome === 'done') {
    return (
      <AuthOutcome
        icon="done"
        title={t.resetDoneTitle}
        body={t.resetDoneBody}
        action={
          <Button asChild size="lg">
            <a href="/sign-in">{t.backToSignIn}</a>
          </Button>
        }
      />
    );
  }
  if (outcome === 'invalid-token') {
    return (
      <AuthOutcome
        icon="problem"
        title={t.resetInvalidTitle}
        body={t.resetInvalidBody}
        action={
          <Button asChild size="lg">
            <a href="/forgot-password">{t.requestNewLink}</a>
          </Button>
        }
      />
    );
  }
  return (
    <>
      <AuthHeading title={t.resetTitle} subtitle={t.resetBody} />
      {outcome ? (
        <Alert role="alert" variant="destructive" className="mb-6">
          <AlertDescription>{failureText(outcome, common)}</AlertDescription>
        </Alert>
      ) : null}
      <form
        action={action ? submitNative : undefined}
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-5"
      >
        <input type="hidden" name="operation" value="reset" />
        <PasswordField
          label={t.newPasswordLabel}
          value={password}
          error={errors.password}
          autoFocus
          autoComplete="new-password"
          visibilityLabel={t.showPassword}
          disabled={busy}
          description={t.passwordHint}
          onChange={(value) => {
            setPassword(value);
            setErrors({});
          }}
        />
        <PasswordField
          label={t.confirmPasswordLabel}
          name="confirm"
          value={confirm}
          error={errors.confirm}
          autoComplete="new-password"
          visibilityLabel={t.showPassword}
          disabled={busy}
          onChange={(value) => {
            setConfirm(value);
            setErrors({});
          }}
        />
        <div className="flex justify-end">
          <Button type="submit" size="lg" isLoading={busy}>
            {busy ? t.resetting : t.resetSubmit}
          </Button>
        </div>
      </form>
    </>
  );
}
