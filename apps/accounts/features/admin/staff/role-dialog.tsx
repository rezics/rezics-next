'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { useEffect, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { OperatorRole } from '../api/types.ts';
import { ErrorAlert, TypedConfirmation, useDismiss, useReauth } from '../actions/confirm.tsx';
import { useTranslation } from '../../../i18n/client.ts';

export interface RoleTarget { id: string; name: string; email: string; role: OperatorRole | null }
type Choice = OperatorRole | 'none';

/** Owners change roles. Making someone an owner, or taking a role from an
 * owner, also needs their email typed and the operator's password. */
export function RoleDialog({ target, onClose, onDone }: { target: RoleTarget; onClose(): void; onDone(): void }) {
  const [pending, setPending] = useState(false);
  const dismiss = useDismiss(onClose, { enabled: !pending, outside: false });
  return <Dialog open role="alertdialog" {...dismiss.root}>
    <DialogContent ref={dismiss.content} size="md" showCloseButton={false}>
      <RoleForm target={target} onCancel={onClose} onDone={onDone} onPending={setPending} />
    </DialogContent>
  </Dialog>;
}

/** The role form inside a dialog: its title, choices, reason and confirmation. */
export function RoleForm({ target, onCancel, onDone, onPending }: { target: RoleTarget; onCancel(): void; onDone(): void;
  onPending(pending: boolean): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const [choice, setChoice] = useState<Choice>(target.role ?? 'support');
  const current = useRef<HTMLLabelElement>(null);
  // Focus starts on the current choice: the dialog picks it (data-autofocus),
  // and this moves it there when the form replaces the find step.
  useEffect(() => {
    const frame = requestAnimationFrame(() => current.current?.querySelector<HTMLInputElement>('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const high = choice === 'owner' || target.role === 'owner';
  const ownerReauth = useReauth(true);
  const plainReauth = useReauth(false);
  const reauth = high ? ownerReauth : plainReauth;
  const unchanged = choice === (target.role ?? 'none');
  const invalid = unchanged || reason.trim().length < 3 || (high && typed.trim() !== target.email) || reauth.missing;
  const label = target.name || target.email;
  async function submit() {
    setShowErrors(true);
    if (invalid) return;
    setPending(true); onPending(true); setError(null);
    const result = await reauth.run(() => api.setRole(target.id, choice === 'none' ? null : choice, reason.trim()));
    setPending(false); onPending(false);
    if (!result.ok) { setError(result.message); return; }
    toast.success({ title: t.roleChanged, description: t.requestId({ id: result.data.requestId }) });
    onDone();
  }
  const choices: Choice[] = ['owner', 'admin', 'support', 'none'];
  return <form className="contents" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
        <DialogHeader title={t.roleTitle({ name: label })} />
        <DialogBody className="flex flex-col gap-4">
          <fieldset disabled={pending}>
            <legend className="mb-2 text-sm font-medium" id="new-role-label">{t.newRole}</legend>
            <RadioGroup name="role" value={choice} disabled={pending} aria-labelledby="new-role-label"
              onValueChange={({ value }) => setChoice(value as Choice)} className="gap-2">
              {choices.map(value => <RadioGroupItem key={value} value={value}
                ref={value === (target.role ?? 'support') ? current : undefined}
                data-autofocus={value === (target.role ?? 'support') || undefined}
                className={cn('cursor-pointer gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors',
                  choice === value ? 'border-primary/40 bg-primary/5' : 'border-border/60 hover:bg-accent/40')}>
                <span><span className="block font-medium">{value === 'none' ? t.removeRole : t.roles[value]}</span>
                <span className="block text-muted-foreground">{t.roleConsequence[value]}</span></span>
              </RadioGroupItem>)}
            </RadioGroup>
          </fieldset>
          <Field invalid={showErrors && reason.trim().length < 3} disabled={pending} required>
            <FieldLabel>{t.roleReason}</FieldLabel>
            <Textarea value={reason} maxLength={1000} className="min-h-20" onChange={event => setReason(event.currentTarget.value)} />
            <FieldError>{t.reasonTooShort}</FieldError>
          </Field>
          {high ? <TypedConfirmation expected={target.email} value={typed} onChange={setTyped} disabled={pending} showError={showErrors} /> : null}
          {reauth.fields(pending)}
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" variant={high || choice === 'none' ? 'destructive' : 'default'} isLoading={pending} disabled={unchanged}>
            {t.user.changeRole}</Button>
        </DialogFooter>
      </form>;
}
