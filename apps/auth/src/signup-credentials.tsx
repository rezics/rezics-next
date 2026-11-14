import type { ReactNode, Ref } from 'react';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { PasswordInput } from './password-input';
import { m } from './paraglide/messages.js';
import type { RegistrationPageRequirements } from './registration-page';
import type { SignupDraft } from './signup-attempt';

export type SignupCredentialErrors = {
  handle: string;
  email: string;
  password: string;
  confirmation: string;
};

const ids = {
  handle: 'signup-handle',
  handleError: 'signup-handle-error',
  handleHint: 'signup-handle-hint',
  email: 'signup-email',
  emailError: 'signup-email-error',
  emailHint: 'signup-email-hint',
  password: 'signup-password',
  passwordError: 'signup-password-error',
  passwordHint: 'signup-password-hint',
  confirmation: 'signup-confirm-password',
  confirmationError: 'signup-confirm-password-error',
};

export function SignupCredentials({
  values,
  requirements,
  errors,
  readOnly,
  emailRef,
  onChange,
  handleNotice,
}: {
  values: SignupDraft;
  requirements: RegistrationPageRequirements;
  errors: SignupCredentialErrors;
  readOnly: boolean;
  emailRef: Ref<HTMLInputElement>;
  onChange: (field: keyof SignupDraft, value: string) => void;
  handleNotice?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
      <section
        aria-label={m.auth_signup_handle()}
        className="grid min-w-0 gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3 sm:p-4"
      >
        <Field
          className="min-w-0 gap-2 rounded-md border border-border bg-background p-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 sm:p-4"
          data-invalid={Boolean(errors.handle)}
        >
          <FieldLabel htmlFor={ids.handle}>{m.auth_signup_handle()}</FieldLabel>
          <Input
            id={ids.handle}
            name="handle"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={requirements.handle.minLength}
            maxLength={requirements.handle.maxLength}
            value={values.handle}
            onChange={(event) => onChange('handle', event.target.value)}
            aria-invalid={errors.handle ? true : undefined}
            aria-describedby={[ids.handleHint, errors.handle ? ids.handleError : null].filter(Boolean).join(' ')}
            readOnly={readOnly}
            required
          />
          {errors.handle ? <FieldError id={ids.handleError}>{errors.handle}</FieldError> : null}
          <p id={ids.handleHint} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.auth_signup_handle_requirement({
              minimum: String(requirements.handle.minLength),
              maximum: String(requirements.handle.maxLength),
            })}
          </p>
          {handleNotice}
        </Field>
      </section>
      <section
        aria-label={`${m.auth_signup_email()}, ${m.auth_signup_password()}, ${m.auth_signup_confirm_password()}`}
        className="grid min-w-0 gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:p-4"
      >
        <p className="max-w-prose text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {m.auth_signup_email()} · {m.auth_signup_password()}
        </p>
        <Field
          className="min-w-0 gap-2 rounded-md border border-border bg-background p-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 sm:p-4"
          data-invalid={Boolean(errors.email)}
        >
          <FieldLabel htmlFor={ids.email}>{m.auth_signup_email()}</FieldLabel>
          <Input
            ref={emailRef}
            id={ids.email}
            name="email"
            type="email"
            autoComplete="email"
            maxLength={requirements.email.maxLength}
            value={values.email}
            onChange={(event) => onChange('email', event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={[ids.emailHint, errors.email ? ids.emailError : null].filter(Boolean).join(' ')}
            readOnly={readOnly}
            required
          />
          {errors.email ? <FieldError id={ids.emailError}>{errors.email}</FieldError> : null}
          <p id={ids.emailHint} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.auth_signup_email_requirement({ maximum: String(requirements.email.maxLength) })}
          </p>
        </Field>
        <Field
          className="min-w-0 gap-2 rounded-md border border-border bg-background p-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 sm:p-4"
          data-invalid={Boolean(errors.password)}
        >
          <FieldLabel htmlFor={ids.password}>{m.auth_signup_password()}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            required
            readOnly={readOnly}
            id={ids.password}
            minLength={requirements.password.minLength}
            maxLength={requirements.password.maxLength}
            value={values.password}
            onChange={(event) => onChange('password', event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={[ids.passwordHint, errors.password ? ids.passwordError : null].filter(Boolean).join(' ')}
          />
          {errors.password ? <FieldError id={ids.passwordError}>{errors.password}</FieldError> : null}
          <p id={ids.passwordHint} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.auth_signup_password_requirement({
              minimum: String(requirements.password.minLength),
              maximum: String(requirements.password.maxLength),
            })}
          </p>
        </Field>
        <Field
          className="min-w-0 gap-2 rounded-md border border-border bg-background p-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 sm:p-4"
          data-invalid={Boolean(errors.confirmation)}
        >
          <FieldLabel htmlFor={ids.confirmation}>{m.auth_signup_confirm_password()}</FieldLabel>
          <PasswordInput
            name="confirm"
            autoComplete="new-password"
            required
            readOnly={readOnly}
            id={ids.confirmation}
            minLength={requirements.password.minLength}
            maxLength={requirements.password.maxLength}
            value={values.confirmation}
            onChange={(event) => onChange('confirmation', event.target.value)}
            aria-invalid={errors.confirmation ? true : undefined}
            aria-describedby={errors.confirmation ? ids.confirmationError : undefined}
          />
          {errors.confirmation ? <FieldError id={ids.confirmationError}>{errors.confirmation}</FieldError> : null}
        </Field>
      </section>
    </div>
  );
}

export const signupCredentialFieldIds = ids;
