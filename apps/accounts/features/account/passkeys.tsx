'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/alert-dialog';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { CloudIcon, FingerprintIcon, PlusIcon, SmartphoneIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { dialogForm } from './dialog-form.ts';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { autofocus } from '../auth/fields.tsx';
import { passkeysSupported } from '../auth/webauthn.ts';
import { useTranslation } from '../../i18n/client.ts';

export interface PasskeyView {
  id: string;
  /** The stored name, else the provider's; null when neither is known. */
  name: string | null;
  provider: string | null;
  /** Synced by a password manager to the person's other devices. */
  synced: boolean;
  /** Dates already localized on the server. */
  created: string;
  lastUsed: string | null;
}

type Outcome = { tone: 'success' | 'destructive'; text: string };

/** Passkeys: create, rename and remove them. The last way to sign in can't be
 * removed; the Account service refuses it too. */
export function Passkeys({ passkeys, hasPassword }: { passkeys: PasskeyView[]; hasPassword: boolean }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const [supported, setSupported] = useState(true);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [renaming, setRenaming] = useState<PasskeyView>();
  const [removing, setRemoving] = useState<PasskeyView>();
  const [dialog, setDialog] = useState<'rename' | 'remove'>();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setSupported(passkeysSupported()), []);
  const label = (passkey: PasskeyView) => passkey.name ?? passkey.provider ?? t.passkeyDefaultName;
  const onlyMethod = !hasPassword && passkeys.length === 1;
  const fail = (kind: Parameters<typeof failureText>[0]) => setOutcome({ tone: 'destructive',
    text: kind === 'last-method' ? t.lastMethod : kind === 'conflict' ? t.passkeyExists
      : failureText(kind, common) });

  async function add() {
    setAdding(true);
    setOutcome(undefined);
    const result = await stepUp(() => api.addPasskey());
    setAdding(false);
    if (result.ok) { setOutcome({ tone: 'success', text: t.passkeyAdded }); return refresh(); }
    // Dismissing either the confirmation or the browser's prompt is a choice.
    if (result.kind !== 'cancelled') fail(result.kind);
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const value = name.trim();
    if (!value) return setNameError(t.passkeyNameRequired);
    setBusy(true);
    const result = await stepUp(() => api.renamePasskey(renaming.id, value));
    setBusy(false);
    setDialog(undefined);
    if (result.ok) { setOutcome({ tone: 'success', text: t.saved }); return refresh(); }
    if (result.kind !== 'cancelled') fail(result.kind);
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    const result = await stepUp(() => api.removePasskey(removing.id));
    setBusy(false);
    setDialog(undefined);
    if (result.ok) { setOutcome({ tone: 'success', text: t.passkeyRemoved }); return refresh(); }
    if (result.kind !== 'cancelled') fail(result.kind);
  }

  return <>
    <SectionHeading back={{ href: '/security', label: t.security }} title={t.passkeysTitle} intro={t.passkeysIntro} />
    <div className="flex flex-col gap-6">
      {outcome ? <Alert role={outcome.tone === 'destructive' ? 'alert' : 'status'} variant={outcome.tone}>
        <AlertDescription>{outcome.text}</AlertDescription></Alert> : null}
      <SettingsCard title={t.yourPasskeys} description={t.passkeysHow}>
        {passkeys.length ? <ul className="divide-y divide-border/60">
          {passkeys.map(passkey => <li key={passkey.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 sm:px-6">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
              <FingerprintIcon className="size-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{label(passkey)}</p>
              <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
                {passkey.synced ? <CloudIcon className="size-3.5" aria-hidden="true" />
                  : <SmartphoneIcon className="size-3.5" aria-hidden="true" />}
                {passkey.synced ? t.passkeySynced : t.passkeyDeviceBound}
                {passkey.provider && passkey.provider !== passkey.name ? <> · {passkey.provider}</> : null}</p>
              <p className="text-sm text-muted-foreground">{t.passkeyCreated({ date: passkey.created })} · {passkey.lastUsed
                ? t.passkeyLastUsed({ time: passkey.lastUsed }) : t.passkeyNeverUsed}</p>
            </div>
            <div className="flex gap-2 max-sm:w-full max-sm:justify-end">
              <Button variant="ghost" size="sm" aria-label={`${t.rename} · ${label(passkey)}`}
                onClick={() => { setRenaming(passkey); setName(passkey.name ?? ''); setNameError(''); setDialog('rename'); }}>
                {t.rename}</Button>
              <Button variant="outline" size="sm" disabled={onlyMethod} aria-label={`${t.remove} · ${label(passkey)}`}
                onClick={() => { setRemoving(passkey); setDialog('remove'); }}>{t.remove}</Button>
            </div>
          </li>)}
        </ul> : <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
            <FingerprintIcon className="size-6" aria-hidden="true" /></span>
          <h2 className="text-lg font-semibold">{t.passkeysEmptyTitle}</h2>
          <p className="max-w-md text-muted-foreground">{t.passkeysEmptyBody}</p>
        </div>}
        {onlyMethod ? <p className="px-5 pb-4 text-sm text-muted-foreground sm:px-6">{t.onlyPasskeyHint}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-4 sm:px-6">
          <p className="text-sm text-muted-foreground">{supported ? t.passkeyCreateHint : t.passkeysUnsupported}</p>
          <Button isLoading={adding} disabled={!supported} onClick={() => void add()}>
            <PlusIcon aria-hidden="true" />{t.createPasskey}</Button>
        </div>
      </SettingsCard>
    </div>
    <Dialog open={dialog === 'rename'} onOpenChange={({ open }) => { if (!open && !busy) setDialog(undefined); }}>
      <DialogContent size="sm">
        <DialogHeader title={t.renamePasskeyTitle} />
        <form noValidate onSubmit={event => void rename(event)} className={dialogForm}>
          <DialogBody>
            <Field invalid={!!nameError} disabled={busy}>
              <FieldLabel>{t.passkeyName}</FieldLabel>
              <Input size="lg" name="passkey-name" autoComplete="off" {...autofocus(true)} maxLength={80} value={name}
                onChange={event => { setName(event.currentTarget.value); setNameError(''); }} />
              <FieldError>{nameError}</FieldError>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(undefined)}>{t.cancel}</Button>
            <Button type="submit" isLoading={busy}>{t.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={dialog === 'remove'} onOpenChange={({ open }) => { if (!open && !busy) setDialog(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{removing ? t.removePasskeyTitle({ name: label(removing) }) : null}</AlertDialogTitle>
          <AlertDialogDescription>{t.removePasskeyBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => setDialog(undefined)}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" isLoading={busy} onClick={() => void remove()}>{t.remove}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
