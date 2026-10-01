'use client';

import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { PasswordInput, PasswordInputGroup, PasswordInputInput,
  PasswordInputTrigger } from '@rezics/ui/password-input';
import type { ReactNode } from 'react';

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** React's `autoFocus` leaves no attribute, so a dialog's focus trap would move
 * focus to its first tabbable element mid-typing; `data-autofocus` tells it. */
export const autofocus = (on?: boolean) => on ? { autoFocus: true, 'data-autofocus': '' } : {};
/** The Account service's password bounds (auth.ts `minPasswordLength`), checked
 * again there. Length is the only rule: no composition rules (NIST 800-63B). */
export const passwordLength = { min: 12, max: 128 };

interface TextFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  description?: ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
}

export function EmailField({ autoComplete = 'username', ...props }: TextFieldProps & {
  autoComplete?: string }) {
  return <Field invalid={!!props.error} disabled={props.disabled}>
    <FieldLabel>{props.label}</FieldLabel>
    <Input size="lg" type="email" name="email" inputMode="email" autoComplete={autoComplete}
      spellCheck={false} autoCapitalize="none" {...autofocus(props.autoFocus)} value={props.value}
      onChange={event => props.onChange(event.currentTarget.value)} />
    {props.description ? <FieldDescription>{props.description}</FieldDescription> : null}
    <FieldError>{props.error}</FieldError>
  </Field>;
}

export function NameField(props: TextFieldProps & { name?: string }) {
  return <Field invalid={!!props.error} disabled={props.disabled}>
    <FieldLabel>{props.label}</FieldLabel>
    <Input size="lg" name={props.name ?? 'name'} autoComplete="nickname" {...autofocus(props.autoFocus)}
      maxLength={120} value={props.value} onChange={event => props.onChange(event.currentTarget.value)} />
    <FieldError>{props.error}</FieldError>
  </Field>;
}

export function PasswordField({ autoComplete, visibilityLabel, name = 'password', ...props }:
TextFieldProps & { autoComplete: 'current-password' | 'new-password'; visibilityLabel: string;
  name?: string }) {
  return <Field invalid={!!props.error} disabled={props.disabled}>
    <FieldLabel>{props.label}</FieldLabel>
    <PasswordInput size="lg" autoComplete={autoComplete} translations={{
      visibilityTrigger: () => visibilityLabel }}>
      <PasswordInputGroup>
        <PasswordInputInput name={name} {...autofocus(props.autoFocus)} maxLength={passwordLength.max}
          value={props.value} onChange={event => props.onChange(event.currentTarget.value)} />
        <PasswordInputTrigger />
      </PasswordInputGroup>
    </PasswordInput>
    {props.description ? <FieldDescription>{props.description}</FieldDescription> : null}
    <FieldError>{props.error}</FieldError>
  </Field>;
}

/** A six-digit code from an authenticator app; browsers may offer it from SMS
 * or a password manager (`one-time-code`). */
export function CodeField({ label, ...props }: TextFieldProps) {
  return <Field invalid={!!props.error} disabled={props.disabled}>
    <FieldLabel>{label}</FieldLabel>
    <Input size="lg" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6}
      spellCheck={false} {...autofocus(props.autoFocus)} className="font-medium tracking-[0.3em] tabular-nums"
      value={props.value} onChange={event => props.onChange(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))} />
    {props.description ? <FieldDescription>{props.description}</FieldDescription> : null}
    <FieldError>{props.error}</FieldError>
  </Field>;
}
