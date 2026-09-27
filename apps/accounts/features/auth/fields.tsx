'use client';

import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { PasswordInput, PasswordInputGroup, PasswordInputInput,
  PasswordInputTrigger } from '@rezics/ui/password-input';
import type { ReactNode } from 'react';

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Better Auth's default password bounds, checked again by the service. */
export const passwordLength = { min: 8, max: 128 };

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
      spellCheck={false} autoCapitalize="none" autoFocus={props.autoFocus} value={props.value}
      onChange={event => props.onChange(event.currentTarget.value)} />
    {props.description ? <FieldDescription>{props.description}</FieldDescription> : null}
    <FieldError>{props.error}</FieldError>
  </Field>;
}

export function NameField(props: TextFieldProps & { name?: string }) {
  return <Field invalid={!!props.error} disabled={props.disabled}>
    <FieldLabel>{props.label}</FieldLabel>
    <Input size="lg" name={props.name ?? 'name'} autoComplete="name" autoFocus={props.autoFocus}
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
        <PasswordInputInput name={name} autoFocus={props.autoFocus} maxLength={passwordLength.max}
          value={props.value} onChange={event => props.onChange(event.currentTarget.value)} />
        <PasswordInputTrigger />
      </PasswordInputGroup>
    </PasswordInput>
    {props.description ? <FieldDescription>{props.description}</FieldDescription> : null}
    <FieldError>{props.error}</FieldError>
  </Field>;
}
