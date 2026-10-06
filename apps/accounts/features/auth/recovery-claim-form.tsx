'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useFormValue } from '@rezics/ui/form-value';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { useAccountClient } from '../api/account-client.tsx';
import type { RecoveryClaim } from '../api/client.ts';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from '../account/failure-text.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { EmailField, PasswordField, emailPattern, passwordLength } from './fields.tsx';

/** Proof stays in memory, never in a URL or browser storage. Keep request and
 * activation identities unchanged when the service's response may have been lost. */
export function RecoveryClaimForm({
  email: initialEmail = '',
  claimId: initialId = '',
  carry = '',
}: {
  email?: string;
  claimId?: string;
  carry?: string;
}) {
  const { t } = useTranslation('auth');
  const locale = useLocale().current;
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [resumeId, setResumeId] = useState(initialId);
  const codeInput = useFormValue(code, setCode);
  const resumeInput = useFormValue(resumeId, setResumeId);
  // Code claims use the Account API. An early native POST would reload the
  // page before that handler is ready, discarding the owner's recovery proof.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  const [claim, setClaim] = useState<RecoveryClaim>();
  const request = useRef<{ claimId: string; targetEmail: string; recoveryCode: string } | null>(
    null,
  );
  const activation = useRef<{ recoveryCode: string; newPassword: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);
  const [done, setDone] = useState(false);
  const failed = (kind: FailureKind) =>
    setError(
      kind === 'conflict' || kind === 'failed' || kind === 'denied'
        ? t.recoveryProofFailed
        : failureText(kind, common),
    );
  const signIn = `/sign-in${carry ? `?${carry}` : '?next=%2Fsecurity'}`;
  function restart() {
    request.current = null;
    activation.current = null;
    setClaim(undefined);
    setResumeId('');
    setPassword('');
    setConfirm('');
    setRetry(false);
    setError('');
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!resumeId && !emailPattern.test(email.trim())) return setError(t.emailInvalid);
    if (!/^[A-Za-z0-9_-]{43}$/.test(code.trim())) return setError(t.recoveryProofFailed);
    setBusy(true);
    request.current ??= {
      claimId: resumeId || crypto.randomUUID(),
      targetEmail: email.trim(),
      recoveryCode: code.trim(),
    };
    const result = resumeId
      ? await api.readRecovery(request.current.claimId, request.current.recoveryCode)
      : await api.requestRecovery(request.current);
    setBusy(false);
    if (result.ok) {
      setClaim(result.data);
      setDone(result.data.activated);
    } else {
      if (result.kind !== 'unavailable') request.current = null;
      failed(result.kind);
    }
  }

  async function refresh() {
    if (!claim || !request.current) return;
    setBusy(true);
    setError('');
    const result = await api.readRecovery(claim.claimId, request.current.recoveryCode);
    setBusy(false);
    if (result.ok) {
      setClaim(result.data);
      setDone(result.data.activated);
    } else failed(result.kind);
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!claim || !request.current) return;
    if (!activation.current) {
      if (password.length < passwordLength.min) return setError(t.passwordTooShort);
      if (password.length > passwordLength.max) return setError(t.passwordTooLong);
      if (password !== confirm) return setError(t.passwordMismatch);
      activation.current = { recoveryCode: request.current.recoveryCode, newPassword: password };
    }
    setBusy(true);
    setError('');
    const result = await api.activateRecovery(claim.claimId, activation.current);
    setBusy(false);
    if (result.ok) {
      setPassword('');
      setConfirm('');
      setCode('');
      activation.current = null;
      request.current = null;
      setDone(true);
    } else {
      setRetry(true);
      failed(result.kind);
    }
  }

  if (done)
    return (
      <AuthOutcome
        icon="done"
        title={t.recoveryDoneTitle}
        body={t.recoveryDoneBody}
        action={
          <Button size="lg" asChild>
            <a href={signIn}>{t.signInNow}</a>
          </Button>
        }
      />
    );
  const ready =
    claim?.approved &&
    Date.parse(claim.notBefore) <= Date.now() &&
    Date.parse(claim.expiresAt) > Date.now();
  if (claim && Date.parse(claim.expiresAt) <= Date.now())
    return (
      <AuthOutcome
        icon="problem"
        title={t.recoveryExpired}
        body={t.recoveryExpiredBody}
        action={<Button onClick={restart}>{t.recoveryStartOver}</Button>}
      />
    );
  return (
    <>
      <AuthHeading
        title={claim ? t.recoveryRebindTitle : t.recoveryCodeTitle}
        subtitle={claim ? t.recoveryRebindBody : t.recoveryCodeBody}
      />
      <noscript>
        <p role="alert" className="mb-6 text-sm">
          {t.recoveryBrowserRequired}
        </p>
      </noscript>
      {error ? (
        <Alert role="alert" variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!claim ? (
        <form method="post" onSubmit={(event) => void start(event)} className="flex flex-col gap-5">
          <EmailField
            label={t.emailLabel}
            value={email}
            onChange={setEmail}
            disabled={busy || !!request.current}
          />
          <Field>
            <FieldLabel>{t.recoveryCodeLabel}</FieldLabel>
            <Input
              name="recoveryCode"
              {...codeInput}
              onChange={(event) => setCode(event.currentTarget.value)}
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={43}
              disabled={busy || !!request.current}
            />
          </Field>
          <details open={!!initialId}>
            <summary className="cursor-pointer text-sm text-primary">{t.recoveryResume}</summary>
            <Field className="mt-3">
              <FieldLabel>{t.recoveryRequestLabel}</FieldLabel>
              <Input
                name="claimId"
                {...resumeInput}
                onChange={(event) => setResumeId(event.currentTarget.value)}
                autoComplete="off"
                disabled={busy || !!request.current}
              />
            </Field>
          </details>
          <Button type="submit" size="lg" isLoading={busy} disabled={!interactive}>
            {t.next}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-5">
          <details open={!ready} className="rounded-xl border p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              {claim.approved ? t.recoveryApproved : t.recoveryWaiting}
            </summary>
            <p className="mt-2">
              {t.recoveryAvailableAt}:{' '}
              <time dateTime={claim.notBefore}>
                {new Date(claim.notBefore).toLocaleString(locale)}
              </time>
            </p>
            <p className="mt-2">
              {t.recoveryExpiresAt}:{' '}
              <time dateTime={claim.expiresAt}>
                {new Date(claim.expiresAt).toLocaleString(locale)}
              </time>
            </p>
            {!claim.approved ? <p className="mt-3">{t.recoveryShare}</p> : null}
            <p className="mt-3">{t.recoveryRequestLabel}</p>
            <a
              className="mt-2 block break-all font-mono text-primary underline underline-offset-4"
              href={`/recover-account/approve?claimId=${encodeURIComponent(claim.claimId)}`}
            >
              {claim.claimId}
            </a>
            <Button
              className="mt-3"
              variant="outline"
              isLoading={busy}
              onClick={() => void refresh()}
            >
              {t.recoveryCheckStatus}
            </Button>
          </details>
          {ready ? (
            <form
              method="post"
              onSubmit={(event) => void activate(event)}
              className="flex flex-col gap-5"
            >
              <p className="text-sm text-muted-foreground">{t.recoveryRemovedBody}</p>
              {retry ? (
                <p role="status" className="text-sm">
                  {t.recoveryRetry}
                </p>
              ) : null}
              <PasswordField
                label={t.newPasswordLabel}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                visibilityLabel={t.showPassword}
                disabled={busy || retry}
                description={t.passwordHint}
              />
              <PasswordField
                label={t.confirmPasswordLabel}
                name="confirm"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                visibilityLabel={t.showPassword}
                disabled={busy || retry}
              />
              <Button type="submit" size="lg" isLoading={busy}>
                {t.recoverySubmit}
              </Button>
            </form>
          ) : null}
        </div>
      )}
      <p className="mt-6 text-sm">
        <a className="text-primary underline underline-offset-4" href={signIn}>
          {t.backToSignIn}
        </a>
      </p>
      {error && claim ? (
        <Button variant="link" onClick={restart} className="px-0">
          {t.recoveryStartOver}
        </Button>
      ) : null}
    </>
  );
}

export function RecoveryApproval({ claimId }: { claimId: string }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [failure, setFailure] = useState<FailureKind>();
  async function approve() {
    setBusy(true);
    const result = await api.approveRecovery(claimId);
    setBusy(false);
    if (result.ok) setApproved(true);
    else setFailure(result.kind);
  }
  return (
    <>
      <AuthHeading
        title={approved ? t.recoveryApproved : t.recoveryApprovalTitle}
        subtitle={approved ? t.recoveryApprovalDone : t.recoveryApprovalBody}
      />
      <p className="mb-5 break-all text-sm">
        {t.recoveryRequestLabel}: {claimId}
      </p>
      {failure ? (
        <Alert role="alert" variant="destructive" className="mb-5">
          <AlertDescription>
            {failure === 'failed' || failure === 'conflict'
              ? t.recoveryProofFailed
              : failureText(failure, common)}
          </AlertDescription>
        </Alert>
      ) : null}
      {failure === 'unauthenticated' ? (
        <Button asChild>
          <a
            href={`/sign-in?next=${encodeURIComponent(`/recover-account/approve?claimId=${claimId}`)}`}
          >
            {t.signInNow}
          </a>
        </Button>
      ) : !approved ? (
        <Button isLoading={busy} onClick={() => void approve()}>
          {t.recoveryApprove}
        </Button>
      ) : null}
    </>
  );
}
