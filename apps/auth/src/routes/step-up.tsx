import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { confirmStepUp } from '../step-up';

export const Route = createFileRoute('/step-up')({
  component: StepUpPage,
});

function StepUpPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true;
    setPending(true);
    setMessage('');
    const outcome = await confirmStepUp(email, password, window.location.search, window.location.origin);
    setPassword('');
    if (outcome.ok) {
      window.location.assign(outcome.target);
      return;
    }
    submitting.current = false;
    setPending(false);
    setMessage(outcome.message);
  }

  return (
    <AuthPage heading={m.auth_step_up_heading()}>
      <form className="auth-login-form" method="post" action="/signin" onSubmit={submit}>
        <p>{m.auth_step_up_explanation()}</p>
        <Field required>
          <FieldLabel>{m.auth_login_email()}</FieldLabel>
          <Input
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={pending}
            required
          />
        </Field>
        <Field required>
          <FieldLabel>{m.auth_login_password()}</FieldLabel>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={pending}
            required
          />
        </Field>
        {message ? (
          <div className="auth-login-alert" role="alert" tabIndex={-1} ref={alert}>
            {message}
          </div>
        ) : null}
        <Button type="submit" disabled={pending || !email.trim() || !password} isLoading={pending}>
          {m.auth_step_up_heading()}
        </Button>
      </form>
    </AuthPage>
  );
}
