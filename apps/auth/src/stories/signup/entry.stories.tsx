import { useRef, useState } from 'react';
import { AuthPage, AuthShell } from '../../frame';
import { AuthActions, AuthHelp, AuthNotice, AuthTask } from '../../auth-task-view';
import { AuthButton } from '../../button';
import { ErrorAlert } from '../../alert';
import { SignupCredentials, type SignupCredentialErrors } from '../../signup-credentials';
import { requirements } from './fixtures';
import type { SignupDraft } from '../../signup-attempt';
import { m } from '../../paraglide/messages.js';
import { authLocale, fill, reviewParameters, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Account/Sign up',
  id: 'pages-account-sign-up',
  parameters: reviewParameters,
  decorators: [authLocale],
};

// Approved presentation states reuse the route's credential fields. They run no registration or verification.
function Credentials({ mode = 'ready' }: { mode?: 'ready' | 'errors' | 'pending' | 'verification-failed' }) {
  const email = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<SignupDraft>({
    handle: mode === 'ready' ? '' : 'reader_1',
    email: mode === 'ready' ? '' : 'international-reading-community@shared-library.example.test',
    password: mode === 'pending' ? 'story-password' : '',
    confirmation: mode === 'pending' ? 'story-password' : '',
  });
  const [errors, setErrors] = useState<SignupCredentialErrors>(() => ({
    handle: mode === 'errors' ? m.auth_signup_handle_invalid() : '',
    email: mode === 'errors' ? m.auth_form_email_invalid() : '',
    password: mode === 'errors' ? m.auth_form_required() : '',
    confirmation: mode === 'errors' ? m.auth_signup_password_mismatch() : '',
  }));
  const pending = mode === 'pending';
  const [verificationFailed, setVerificationFailed] = useState(mode === 'verification-failed');
  return (
    <AuthShell>
      <AuthPage heading={m.auth_signup_heading()}>
        <AuthTask>
          <form
            className="grid min-w-0 gap-5"
            aria-busy={pending}
            noValidate
            onSubmit={(event) => event.preventDefault()}
          >
            <SignupCredentials
              values={values}
              requirements={requirements}
              errors={errors}
              readOnly={pending}
              emailRef={email}
              onChange={(field, value) => {
                setValues((current) => ({ ...current, [field]: value }));
                setErrors((current) => ({ ...current, [field]: '' }));
              }}
            />
            <div className="grid gap-3 rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground">{m.auth_signup_turnstile_required()}</p>
              {verificationFailed ? (
                <>
                  <ErrorAlert>{m.auth_signup_turnstile_failed()}</ErrorAlert>
                  <AuthButton variant="outline" onClick={() => setVerificationFailed(false)}>
                    {m.auth_signup_turnstile_retry()}
                  </AuthButton>
                </>
              ) : !pending ? (
                <p role="status">{m.auth_signup_turnstile_loading()}</p>
              ) : null}
            </div>
            {pending ? (
              <AuthNotice role="status">{m.auth_signup_creating()}</AuthNotice>
            ) : (
              <AuthActions>
                <AuthButton type="submit">{m.auth_signup_heading()}</AuthButton>
              </AuthActions>
            )}
          </form>
          <AuthHelp aria-label={m.auth_signup_sign_in()}>
            <a href="/login">{m.auth_signup_sign_in()}</a>
          </AuthHelp>
        </AuthTask>
      </AuthPage>
    </AuthShell>
  );
}

export const Ready = { render: () => <Credentials /> };
export const LongLocaleRequirements = { globals: { locale: 'de' }, render: () => <Credentials /> };
export const FieldErrors = {
  render: () => <Credentials mode="errors" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const email = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#signup-email'));
    const descriptions = email.getAttribute('aria-describedby')?.split(' ') ?? [];
    if (!descriptions.includes('signup-email-hint') || !descriptions.includes('signup-email-error'))
      throw new Error('Email needs both its limit and error description');
    fill(email, 'reader@example.test');
    await waitFor(() => !canvasElement.querySelector('#signup-email-error'));
    if (!email.getAttribute('aria-describedby')?.includes('signup-email-hint'))
      throw new Error('Correcting an error must keep the field requirement');
  },
};
export const CreationPending = { render: () => <Credentials mode="pending" /> };

export const VerificationFailure = {
  render: () => <Credentials mode="verification-failed" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const email = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#signup-email'));
    const previousEmail = email.value;
    const retry = [...canvasElement.querySelectorAll('button')].find(
      (item) => item.textContent === m.auth_signup_turnstile_retry(),
    )!;
    retry.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_signup_turnstile_loading()));
    if (email.value !== previousEmail) throw new Error('Verification retry must preserve entered credentials');
  },
};
