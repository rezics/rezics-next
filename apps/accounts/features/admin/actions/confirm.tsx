'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { PasswordInput, PasswordInputGroup, PasswordInputInput, PasswordInputTrigger } from '@rezics/ui/password-input';
import { Textarea } from '@rezics/ui/textarea';
import { CircleAlertIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminFailure, AdminResult } from '../api/client.ts';
import type { ReasonCode } from '../api/types.ts';
import { useAdmin } from '../shell/admin-context.tsx';
import { useTranslation } from '../../../i18n/client.ts';

// The parts every staff confirmation shares: the reason, the operator's
// password for the most damaging changes, typing the target's name, and one
// place that turns a service error into words.

export interface Reauth { password: string; totpCode: string }

/** A panel dialog's open/close and first focus. It closes only when the
 * person asks: Escape, a click outside (not for alert dialogs, which want an
 * explicit choice) or its own Cancel or Close button; Ark also closes a
 * dialog whose layer goes down with a closing menu or dialog, which is
 * ignored, and nothing closes it while a change is pending. Focus starts on
 * `[data-autofocus]` or the first form control: left to itself the dialog can
 * pick its scrolling body, which stops being focusable a moment later and
 * drops focus onto the page behind. Spread `root` on Dialog; pass `content`
 * as DialogContent's ref. */
export function useDismiss(onClose: () => void, { enabled = true, outside = true }: { enabled?: boolean; outside?: boolean } = {}) {
  const intent = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const mark = () => { intent.current = true; };
  return { content, root: {
    closeOnEscape: enabled, closeOnInteractOutside: enabled && outside, onEscapeKeyDown: mark, onPointerDownOutside: mark,
    initialFocusEl: () => content.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type="hidden"]):not(:disabled), '
      + 'select:not(:disabled), textarea:not(:disabled), button:not(:disabled)') ?? null,
    onOpenChange: ({ open }: { open: boolean }) => {
      if (!open && intent.current && enabled) onClose();
      intent.current = false;
    },
  } };
}

type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];
export function errorMessage(failure: Pick<AdminFailure, 'code'>, t: AdminText): string {
  const known = t.errors as Record<string, string>;
  return known[failure.code] ?? t.errors.other;
}

export function ErrorAlert({ message }: { message: string | null }) {
  // The live region stays mounted so the message is announced when it appears.
  return <div role="alert" aria-live="assertive">
    {message ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription></Alert> : null}
  </div>;
}

function ReauthFields({ value, onChange, secondFactor, disabled, autoFocus, description }: { value: Reauth;
  onChange(value: Reauth): void; secondFactor: boolean; disabled?: boolean; autoFocus?: boolean; description?: string }) {
  const { t } = useTranslation('admin');
  const id = useId();
  return <>
    <Field id={`reauth-password${id}`} disabled={disabled}>
      <FieldLabel>{t.yourPassword}</FieldLabel>
      <PasswordInput autoComplete="current-password" translations={{ visibilityTrigger: () => t.showPassword }}>
        <PasswordInputGroup>
          <PasswordInputInput name="password" autoFocus={autoFocus} maxLength={128} value={value.password}
            onChange={event => onChange({ ...value, password: event.currentTarget.value })} />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
    {secondFactor ? <Field id={`reauth-totp${id}`} disabled={disabled}>
      <FieldLabel>{t.totpCode}</FieldLabel>
      <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={value.totpCode}
        onChange={event => onChange({ ...value, totpCode: event.currentTarget.value.replace(/\D/g, '') })} />
    </Field> : null}
  </>;
}

/** Re-authentication inside a confirmation dialog: always for the most
 * damaging changes, and after the service answers `step_up_required` for the
 * rest. `run` confirms the password first when asked, then makes the change;
 * a retry keeps the caller's command ID, so it cannot apply twice. */
export function useReauth(always: boolean) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me } = useAdmin();
  const [asked, setAsked] = useState(always);
  const [value, setValue] = useState<Reauth>({ password: '', totpCode: '' });
  async function run<T>(change: () => Promise<AdminResult<T>>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
    if (asked) {
      const confirmed = await api.reauthenticate(value.password, me.secondFactor ? value.totpCode : undefined);
      if (!confirmed.ok) return { ok: false, message: confirmed.code === 'forbidden' ? t.stepUpFailed : errorMessage(confirmed, t) };
    }
    const result = await change();
    if (result.ok) return result;
    if (result.code === 'step_up_required') setAsked(true);
    return { ok: false, message: errorMessage(result, t) };
  }
  const fields = (disabled: boolean) => asked ? <ReauthFields value={value} onChange={setValue} secondFactor={me.secondFactor}
    disabled={disabled} description={always ? t.reauthHelp : t.stepUpBody} autoFocus={!always} /> : null;
  return { run, fields, missing: asked && !value.password };
}

/** Typing the target's identifier: the friction for changes that are hard to undo. */
export function TypedConfirmation({ expected, value, onChange, disabled, showError }: { expected: string; value: string;
  onChange(value: string): void; disabled?: boolean; showError: boolean }) {
  const { t } = useTranslation('admin');
  const mismatch = showError && value.trim() !== expected;
  return <Field id={`typed-confirmation${useId()}`} invalid={mismatch} disabled={disabled}>
    <FieldLabel>{t.typeToConfirm({ value: expected })}</FieldLabel>
    <Input value={value} autoComplete="off" spellCheck={false} autoCapitalize="none"
      onChange={event => onChange(event.currentTarget.value)} className="font-mono" />
    <FieldError>{t.typeMismatch}</FieldError>
  </Field>;
}

export interface Reason { code: ReasonCode | ''; detail: string; message: string }

/** Reason code, audit detail and, for sanctions, a message to the user. */
export function ReasonFields({ codes, value, onChange, required, withMessage, disabled, showErrors }: {
  codes: readonly ReasonCode[]; value: Reason; onChange(value: Reason): void; required: boolean; withMessage: boolean;
  disabled?: boolean; showErrors: boolean }) {
  const { t } = useTranslation('admin');
  // Prefixed IDs: each label names its own control, whatever else on the page uses a bare useId().
  const id = useId();
  const codeMissing = showErrors && required && !value.code;
  const detailShort = showErrors && required && value.detail.trim().length < 3;
  return <>
    <Field id={`reason-code${id}`} invalid={codeMissing} disabled={disabled} required={required}>
      <FieldLabel>{t.reasonCode}</FieldLabel>
      <ChoiceSelect value={value.code} label={t.reasonCode} disabled={disabled} portalled={false}
        onValueChange={code => onChange({ ...value, code: code as ReasonCode | '' })}
        options={[{ value: '', label: t.reasonCodePlaceholder },
          ...codes.map(code => ({ value: code, label: t.reasonCodes[code] }))]} />
      <FieldError>{t.reasonCodePlaceholder}</FieldError>
    </Field>
    <Field id={`reason-detail${id}`} invalid={detailShort} disabled={disabled} required={required}>
      <FieldLabel>{t.reasonDetail}</FieldLabel>
      <Textarea value={value.detail} maxLength={1000} className="min-h-20"
        onChange={event => onChange({ ...value, detail: event.currentTarget.value })} />
      <FieldDescription>{t.reasonDetailHelp}</FieldDescription>
      <FieldError>{t.reasonTooShort}</FieldError>
    </Field>
    {withMessage ? <Field id={`reason-message${id}`} disabled={disabled}>
      <FieldLabel>{t.messageLabel}</FieldLabel>
      <Textarea value={value.message} maxLength={2000} className="min-h-20"
        onChange={event => onChange({ ...value, message: event.currentTarget.value })} />
      <FieldDescription>{t.messageHelp}</FieldDescription>
    </Field> : null}
  </>;
}
