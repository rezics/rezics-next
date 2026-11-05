import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { PasswordInput } from './password-input';
import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { m } from './paraglide/messages.js';
import type { SecurityAdvice } from './security-inventory';
import {
  passwordLengthValid,
  type PasswordChangeAttempt,
  type PasswordChangePhase,
  type PasswordChangeLimits,
} from './password-change-attempt';

export type PasswordReviewBinding = {
  accountId: string;
  authorityGeneration: number;
  adviceGeneration: number;
  advice: 'allowed';
};

export type PasswordChangeOperation = {
  kind: 'password';
  attempt: PasswordChangeAttempt;
  status: 'sending' | 'unknown' | 'paused';
};

type Props = {
  accountId: string;
  accountLabel: string;
  passwordLimits: PasswordChangeLimits | null;
  advice: SecurityAdvice | undefined;
  review: PasswordReviewBinding | null;
  operation: PasswordChangeOperation | null;
  blocked: boolean;
  error: string;
  newPasswordRef: RefObject<HTMLInputElement | null>;
  errorRef: RefObject<HTMLDivElement | null>;
  onDraftPresenceChange: (present: boolean) => void;
  onRequestReview: () => PasswordReviewBinding | null;
  onRetireReview: (binding: PasswordReviewBinding) => void;
  onConfirm: (password: string, binding: PasswordReviewBinding) => boolean;
  onRetry: () => void;
  onDismissError: () => void;
};

function AdviceHint({ advice }: { advice: SecurityAdvice | undefined }) {
  if (advice === 'allowed') return null;
  return (
    <p className="auth-security-hint">
      {advice === 'step-up-required' ? m.auth_security_step_up_advice() : m.auth_inventory_unavailable()}
    </p>
  );
}

function phaseMessage(phase: PasswordChangePhase) {
  if (phase === 'stage') return m.auth_security_password_stage_unknown();
  if (phase === 'approve') return m.auth_security_password_approval_unknown();
  return m.auth_security_password_apply_unknown();
}

export function PasswordChangeForm({
  accountId,
  accountLabel,
  passwordLimits,
  advice,
  review,
  operation,
  blocked,
  error,
  newPasswordRef,
  errorRef,
  onDraftPresenceChange,
  onRequestReview,
  onRetireReview,
  onConfirm,
  onRetry,
  onDismissError,
}: Props) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmationError, setConfirmationError] = useState('');
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const passwordConfirmation = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const recoveryStatus = useRef<HTMLDivElement>(null);
  const draftVersion = useRef(0);
  const editable = !blocked && !operation;
  const canReview = passwordLimits !== null && (advice === 'allowed' || advice === 'step-up-required');
  const currentReview = review && review.accountId === accountId && reviewVersion === draftVersion.current;

  useLayoutEffect(() => {
    if (passwordError) newPasswordRef.current?.focus();
    else if (confirmationError) passwordConfirmation.current?.focus();
  }, [passwordError, confirmationError, newPasswordRef]);

  useLayoutEffect(() => {
    if (operation) recoveryStatus.current?.focus();
    else if (currentReview) reviewHeading.current?.focus();
  }, [operation?.attempt.key, operation?.attempt.phase, operation?.status, currentReview]);

  function retireReview() {
    if (review) onRetireReview(review);
    setReviewVersion(null);
  }

  function updateDraft(nextPassword: string, nextConfirmation: string) {
    setPassword(nextPassword);
    setConfirmation(nextConfirmation);
    onDraftPresenceChange(Boolean(nextPassword || nextConfirmation));
  }

  function edit(field: 'password' | 'confirmation', value: string) {
    draftVersion.current++;
    retireReview();
    if (field === 'password') {
      setPassword(value);
      setPasswordError('');
    } else {
      setConfirmation(value);
      setConfirmationError('');
    }
    onDraftPresenceChange(Boolean(field === 'password' ? value || confirmation : password || value));
    if (error) onDismissError();
  }

  function validate(): boolean {
    let valid = true;
    if (!passwordLimits) {
      setPasswordError(m.auth_inventory_unavailable());
      return false;
    }
    if (!password) {
      setPasswordError(m.auth_form_required());
      valid = false;
    } else if (!passwordLengthValid(password, passwordLimits)) {
      setPasswordError(
        m.auth_signup_password_invalid({
          minimum: String(passwordLimits.minLength),
          maximum: String(passwordLimits.maxLength),
        }),
      );
      valid = false;
    }
    if (!confirmation) {
      setConfirmationError(m.auth_form_required());
      valid = false;
    } else if (password && confirmation !== password) {
      setConfirmationError(m.auth_signup_password_mismatch());
      valid = false;
    }
    return valid;
  }

  function requestReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || review || !validate()) return;
    const binding = onRequestReview();
    if (binding) setReviewVersion(draftVersion.current);
  }

  function cancel() {
    retireReview();
    draftVersion.current++;
    updateDraft('', '');
    setPasswordError('');
    setConfirmationError('');
    newPasswordRef.current?.focus();
  }

  function confirm() {
    if (!currentReview || !review || !editable || !validate()) return;
    const started = onConfirm(password, review);
    if (!started) {
      retireReview();
      return;
    }
    setReviewVersion(null);
    draftVersion.current++;
    updateDraft('', '');
    setPasswordError('');
    setConfirmationError('');
  }

  if (operation) {
    const expired = operation.attempt.approval ? Date.parse(operation.attempt.approval.expiresAt) <= Date.now() : false;
    return (
      <section aria-labelledby="security-password-heading">
        <h2 id="security-password-heading">{m.auth_security_change_password()}</h2>
        <div className="auth-login-form" aria-busy={operation.status === 'sending'}>
          <div id="security-password-recovery" ref={recoveryStatus} tabIndex={-1} role="status">
            {operation.status === 'sending'
              ? m.auth_security_password_pending()
              : operation.status === 'paused'
                ? m.auth_security_password_paused()
                : phaseMessage(operation.attempt.phase)}
          </div>
          {expired && operation.attempt.phase === 'apply' ? (
            <p className="auth-security-hint">{m.auth_security_password_retry_expired()}</p>
          ) : null}
          <AdviceHint advice={advice} />
          {operation.status !== 'sending' && advice !== 'allowed' ? (
            <p className="auth-security-hint">{m.auth_security_password_retry_unavailable()}</p>
          ) : null}
          {operation.status !== 'sending' ? (
            <Button type="button" variant="outline" disabled={blocked || advice !== 'allowed'} onClick={onRetry}>
              {m.auth_signup_retry_original()}
            </Button>
          ) : null}
          <p className="auth-security-hint">{m.auth_security_password_recovery_handoff()}</p>
          <div className="flex flex-wrap gap-3">
            <a href="/login">{m.auth_security_sign_in()}</a>
            <a href="/recovery">{m.auth_signup_recovery()}</a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="security-password-heading">
      <h2 id="security-password-heading">{m.auth_security_change_password()}</h2>
      <form
        className="auth-login-form"
        method="post"
        action="/credential-effects/stage"
        noValidate
        onSubmit={requestReview}
      >
        <Field data-invalid={Boolean(passwordError)}>
          <FieldLabel htmlFor="security-new-password">{m.auth_security_new_password()}</FieldLabel>
          <p id="security-password-help" className="auth-security-hint">
            {passwordLimits
              ? m.auth_signup_password_requirement({
                  minimum: String(passwordLimits.minLength),
                  maximum: String(passwordLimits.maxLength),
                })
              : m.auth_inventory_unavailable()}
          </p>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            required
            minLength={passwordLimits?.minLength}
            maxLength={passwordLimits?.maxLength}
            readOnly={!editable}
            ref={newPasswordRef}
            id="security-new-password"
            value={password}
            onChange={(event) => edit('password', event.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={
              passwordError ? 'security-password-help security-password-error' : 'security-password-help'
            }
          />
          {passwordError ? <FieldError id="security-password-error">{passwordError}</FieldError> : null}
        </Field>
        <Field data-invalid={Boolean(confirmationError)}>
          <FieldLabel htmlFor="security-confirm-password">{m.auth_signup_confirm_password()}</FieldLabel>
          <PasswordInput
            autoComplete="new-password"
            required
            minLength={passwordLimits?.minLength}
            maxLength={passwordLimits?.maxLength}
            readOnly={!editable}
            ref={passwordConfirmation}
            id="security-confirm-password"
            value={confirmation}
            onChange={(event) => edit('confirmation', event.target.value)}
            aria-invalid={confirmationError ? true : undefined}
            aria-describedby={confirmationError ? 'security-confirm-password-error' : undefined}
          />
          {confirmationError ? <FieldError id="security-confirm-password-error">{confirmationError}</FieldError> : null}
        </Field>
        {error ? (
          <ErrorAlert ref={errorRef} tabIndex={-1}>
            {error}
          </ErrorAlert>
        ) : null}
        <AdviceHint advice={advice} />
        {currentReview ? (
          <div className="auth-login-form" aria-labelledby="security-password-review-heading">
            <h3 id="security-password-review-heading" ref={reviewHeading} tabIndex={-1}>
              {m.auth_security_password_review_heading()}
            </h3>
            <p>{m.auth_security_password_review_target({ account: accountLabel || accountId })}</p>
            <p>{m.auth_security_password_consequences()}</p>
            <Button type="button" onClick={confirm} disabled={!editable} className="w-full">
              {m.auth_security_password_confirm()}
            </Button>
            <Button type="button" variant="outline" onClick={cancel} disabled={!editable} className="w-full">
              {m.auth_inventory_cancel()}
            </Button>
          </div>
        ) : null}
        {!currentReview ? (
          <Button type="submit" disabled={!canReview || blocked} className="w-full">
            {m.auth_security_password_review()}
          </Button>
        ) : null}
        {(password || confirmation) && !currentReview ? (
          <Button type="button" variant="outline" onClick={cancel} disabled={!editable} className="w-full">
            {m.auth_inventory_cancel()}
          </Button>
        ) : null}
      </form>
    </section>
  );
}
