'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/alert-dialog';
import { Button } from '@rezics/ui/button';
import { CircleCheckIcon, CircleMinusIcon, FingerprintIcon, LockKeyholeIcon, ShieldCheckIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { CheckupIssue } from './activity.ts';
import { ActivityList, type ActivityView } from './activity-list.tsx';
import { SectionHeading, SettingsCard, SettingsLinkRow, SettingsRow } from './account-shell.tsx';
import { CheckupCard } from './checkup-card.tsx';
import { Devices, type DevicesView } from './devices.tsx';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { PasswordField, passwordLength } from '../auth/fields.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** How this account signs in, as the overview shows it. */
export interface SignInSummary {
  password: boolean;
  /** When the password last changed, already localized; null when unknown. */
  passwordChanged: string | null;
  passkeys: number;
  twoStep: boolean;
}

export type ActivitySummary = { status: 'ok'; entries: ActivityView[]; apps?: Record<string, string> }
  | { status: 'unavailable' };

function PasswordForm({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const showLabel = useTranslation('auth').t.showPassword;
  const { api } = useAccountClient();
  const stepUp = useStepUp();
  const [values, setValues] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof values, string>>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (field: keyof typeof values) => (value: string) => {
    setValues(current => ({ ...current, [field]: value }));
    setErrors({});
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = {
      current: values.current ? undefined : t.currentPasswordRequired,
      next: values.next.length < passwordLength.min ? t.passwordTooShort
        : values.next === values.current ? t.passwordUnchanged : undefined,
      confirm: values.confirm !== values.next ? t.passwordMismatch : undefined,
    };
    setErrors(found);
    setFailure('');
    if (found.current || found.next || found.confirm) return;
    setBusy(true);
    const result = await stepUp(() => api.changePassword({ currentPassword: values.current, newPassword: values.next }),
      { password: values.current });
    setBusy(false);
    if (result.ok) return onDone();
    if (result.kind === 'cancelled') return;
    if (result.kind === 'invalid-credentials') return setErrors({ current: t.wrongCurrentPassword });
    if (result.kind === 'password-too-short') return setErrors({ next: t.passwordTooShort });
    setFailure(failureText(result.kind, common));
  }

  return <form method="post" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4 px-5 py-4 sm:px-6">
    <input type="text" name="username" autoComplete="username" hidden readOnly />
    <PasswordField label={t.currentPassword} name="current-password" value={values.current}
      error={errors.current} autoComplete="current-password" visibilityLabel={showLabel} autoFocus
      disabled={busy} onChange={change('current')} />
    <PasswordField label={t.newPassword} name="new-password" value={values.next} error={errors.next}
      autoComplete="new-password" visibilityLabel={showLabel} disabled={busy} onChange={change('next')}
      description={t.passwordRule} />
    <PasswordField label={t.confirmPassword} name="confirm-password" value={values.confirm}
      error={errors.confirm} autoComplete="new-password" visibilityLabel={showLabel} disabled={busy}
      onChange={change('confirm')} />
    <p className="text-sm text-muted-foreground">{t.passwordSignsOutOthers}</p>
    {failure ? <Alert role="alert" variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onCancel}>{t.cancel}</Button>
      <Button type="submit" isLoading={busy}>{busy ? t.saving : t.changePassword}</Button>
    </div>
  </form>;
}

/** Remove the password from an account that also has a passkey. */
function RemovePassword() {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function remove() {
    setBusy(true);
    setFailure('');
    const result = await stepUp(() => api.removePassword());
    setBusy(false);
    setOpen(false);
    if (result.ok) return refresh();
    if (result.kind !== 'cancelled') {
      setFailure(result.kind === 'last-method' ? t.lastMethod : failureText(result.kind, common));
    }
  }
  return <>
    <Button variant="link" className="mt-1 h-auto px-0" onClick={() => setOpen(true)}>{t.removePassword}</Button>
    {failure ? <Alert role="alert" variant="destructive" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert> : null}
    <AlertDialog open={open} onOpenChange={({ open: next }) => { if (!next && !busy) setOpen(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.removePasswordTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.removePasswordBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => setOpen(false)}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" isLoading={busy} onClick={() => void remove()}>
            {t.removePassword}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function PasswordRow({ summary }: { summary: SignInSummary | null }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  if (changing) {
    return <div id="password"><PasswordForm onCancel={() => setChanging(false)}
      onDone={() => { setChanging(false); setChanged(true); refresh(); }} /></div>;
  }
  const action = summary?.password ? <Button variant="ghost" onClick={() => { setChanging(true); setChanged(false); }}>
    {t.changePassword}</Button>
    : summary ? <Button variant="ghost" asChild><a href="/forgot-password">{t.setPassword}</a></Button> : null;
  return <div id="password"><SettingsRow label={t.password} action={action}
    icon={<LockKeyholeIcon className="size-4" aria-hidden="true" />}>
    {!summary ? <span className="text-muted-foreground">{common.unavailableTitle}</span>
      : summary.password ? <span className="font-medium">
        {summary.passwordChanged ? t.passwordLastChanged({ date: summary.passwordChanged }) : t.methodOn}</span>
        : <span className="text-muted-foreground">{t.passwordNotSet}</span>}
    {summary?.password && summary.passkeys > 0 ? <div><RemovePassword /></div> : null}
    {changed ? <Alert role="status" variant="success" className="mt-3">
      <AlertDescription>{t.passwordChanged}</AlertDescription></Alert> : null}
  </SettingsRow></div>;
}

function Status({ on, children }: { on: boolean; children: string }) {
  const Icon = on ? CircleCheckIcon : CircleMinusIcon;
  return <span className="inline-flex items-center gap-2 font-medium">
    <Icon className={on ? 'size-4 text-success-foreground' : 'size-4 text-muted-foreground'} aria-hidden="true" />
    {children}</span>;
}

/** Security & sign-in: how the person signs in, where, and what happened lately. */
export function SecurityOverview({ signIn, issues, failedSignIns, devices, activity }: {
  signIn: SignInSummary | null; issues: CheckupIssue[]; failedSignIns: number; devices: DevicesView;
  activity: ActivitySummary }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return <>
    <SectionHeading title={t.security} intro={t.securityIntro} />
    <div className="flex flex-col gap-6">
      <CheckupCard issues={issues} failedSignIns={failedSignIns} />
      <SettingsCard title={t.signInMethods} description={t.signInMethodsIntro}>
        <PasswordRow summary={signIn} />
        <SettingsLinkRow label={t.methodPasskeys} href="/security/passkeys"
          icon={<FingerprintIcon className="size-4" aria-hidden="true" />}>
          {signIn ? <Status on={signIn.passkeys > 0}>{t.passkeyCount(signIn.passkeys)}</Status>
            : <span className="text-muted-foreground">{common.unavailableTitle}</span>}
        </SettingsLinkRow>
        <SettingsLinkRow label={t.methodTwoStep} href="/security/two-step-verification"
          icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}>
          {signIn ? <Status on={signIn.twoStep}>{signIn.twoStep ? t.twoStepOn : t.twoStepOff}</Status>
            : <span className="text-muted-foreground">{common.unavailableTitle}</span>}
        </SettingsLinkRow>
      </SettingsCard>
      <SettingsCard title={t.devices} description={t.devicesIntro}><Devices devices={devices} /></SettingsCard>
      <SettingsCard title={t.activity} description={t.activityIntro}>
        {activity.status === 'ok' ? <ActivityList entries={activity.entries} apps={activity.apps} />
          : <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
            <p className="text-muted-foreground">{common.unavailableBody}</p>
            <Button variant="outline" onClick={refresh}>{common.retry}</Button></div>}
        <div className="border-t border-border/60 px-5 py-3 sm:px-6">
          <Button variant="link" className="px-0" asChild><a href="/security/activity">{t.reviewActivity}</a></Button>
        </div>
      </SettingsCard>
    </div>
  </>;
}
