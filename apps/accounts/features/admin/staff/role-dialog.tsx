'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { OperatorRole } from '../api/types.ts';
import { ErrorAlert, errorMessage, type Reauth, ReauthFields, TypedConfirmation } from '../actions/confirm.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { useStepUp } from '../shell/step-up.tsx';
import { useTranslation } from '../../../i18n/client.ts';

export interface RoleTarget { id: string; name: string; email: string; role: OperatorRole | null }
type Choice = OperatorRole | 'none';

/** Owners change roles. Making someone an owner, or taking a role from an
 * owner, also needs their email typed and the operator's password. */
export function RoleDialog({ target, onClose, onDone }: { target: RoleTarget; onClose(): void; onDone(): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me } = useAdmin();
  const stepUp = useStepUp();
  const [choice, setChoice] = useState<Choice>(target.role ?? 'support');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [reauth, setReauth] = useState<Reauth>({ password: '', totpCode: '' });
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const high = choice === 'owner' || target.role === 'owner';
  const unchanged = choice === (target.role ?? 'none');
  const invalid = unchanged || reason.trim().length < 3 || (high && (typed.trim() !== target.email || !reauth.password));
  const label = target.name || target.email;
  async function submit() {
    setShowErrors(true);
    if (invalid) return;
    setPending(true); setError(null);
    if (high) {
      const confirmed = await api.reauthenticate(reauth.password, me.secondFactor ? reauth.totpCode : undefined);
      if (!confirmed.ok) { setPending(false); setError(confirmed.code === 'forbidden' ? t.stepUpFailed : errorMessage(confirmed, t)); return; }
    }
    const result = await stepUp(() => api.setRole(target.id, choice === 'none' ? null : choice, reason.trim()));
    setPending(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    toast.success({ title: t.roleChanged, description: t.requestId({ id: result.data.requestId }) });
    onDone();
  }
  const choices: Choice[] = ['owner', 'admin', 'support', 'none'];
  return <Dialog open role="alertdialog" onOpenChange={details => { if (!details.open && !pending) onClose(); }}
    closeOnInteractOutside={!pending} closeOnEscape={!pending}>
    <DialogContent size="md" showCloseButton={!pending}>
      <form className="contents" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
        <DialogHeader title={t.roleTitle({ name: label })} />
        <DialogBody className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2" disabled={pending}>
            <legend className="mb-2 text-sm font-medium">{t.newRole}</legend>
            {choices.map(value => <label key={value} className={cn('flex cursor-pointer gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors',
              choice === value ? 'border-primary/40 bg-primary/5' : 'border-border/60 hover:bg-accent/40')}>
              <input type="radio" name="role" value={value} checked={choice === value} onChange={() => setChoice(value)}
                className="mt-0.5 size-4 accent-primary" />
              <span><span className="block font-medium">{value === 'none' ? t.removeRole : t.roles[value]}</span>
                <span className="block text-muted-foreground">{t.roleConsequence[value]}</span></span>
            </label>)}
          </fieldset>
          <Field invalid={showErrors && reason.trim().length < 3} disabled={pending} required>
            <FieldLabel>{t.roleReason}</FieldLabel>
            <Textarea value={reason} maxLength={1000} className="min-h-20" onChange={event => setReason(event.currentTarget.value)} />
            <FieldError>{t.reasonTooShort}</FieldError>
          </Field>
          {high ? <>
            <TypedConfirmation expected={target.email} value={typed} onChange={setTyped} disabled={pending} showError={showErrors} />
            <ReauthFields value={reauth} onChange={setReauth} secondFactor={me.secondFactor} disabled={pending} description={t.reauthHelp} />
          </> : null}
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" variant={high || choice === 'none' ? 'destructive' : 'default'} isLoading={pending} disabled={unchanged}>
            {t.user.changeRole}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
