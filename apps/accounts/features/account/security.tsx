'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldLabel } from '@rezics/ui/field';
import { CircleCheckIcon, HistoryIcon, LaptopIcon, MonitorIcon, SmartphoneIcon,
  TabletIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { SectionHeading, SettingsCard, SettingsRow } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { useAccountClient } from '../api/account-client.tsx';
import { PasswordField, passwordLength } from '../auth/fields.tsx';
import { signInHref } from '../shell/state-panel.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface DeviceView {
  id: string;
  token: string;
  current: boolean;
  kind: 'phone' | 'tablet' | 'computer' | 'unknown';
  /** Browser and system, already localized on the server. */
  title: string;
  /** "Active now" or "Last active 3 hours ago". */
  activity: string;
}

export type DevicesView = { status: 'ok'; items: DeviceView[] } | { status: 'stale' | 'unavailable' };

const deviceIcons = { phone: SmartphoneIcon, tablet: TabletIcon, computer: LaptopIcon, unknown: MonitorIcon };

function PasswordForm({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const showLabel = useTranslation('auth').t.showPassword;
  const { api } = useAccountClient();
  const [values, setValues] = useState({ current: '', next: '', confirm: '' });
  const [signOutOthers, setSignOutOthers] = useState(true);
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
      current: values.current ? undefined : t.wrongCurrentPassword,
      next: values.next.length < passwordLength.min ? t.passwordTooShort : undefined,
      confirm: values.confirm !== values.next ? t.passwordMismatch : undefined,
    };
    setErrors(found);
    setFailure('');
    if (found.current || found.next || found.confirm) return;
    setBusy(true);
    const result = await api.changePassword({ currentPassword: values.current, newPassword: values.next,
      signOutOthers });
    setBusy(false);
    if (result.ok) return onDone();
    if (result.kind === 'invalid-credentials') return setErrors({ current: t.wrongCurrentPassword });
    if (result.kind === 'password-too-short') return setErrors({ next: t.passwordTooShort });
    setFailure(failureText(result.kind, common));
  }

  return <form method="post" noValidate onSubmit={submit} className="flex flex-col gap-4 px-5 py-4 sm:px-6">
    <input type="text" name="username" autoComplete="username" hidden readOnly />
    <PasswordField label={t.currentPassword} name="current-password" value={values.current}
      error={errors.current} autoComplete="current-password" visibilityLabel={showLabel} autoFocus
      disabled={busy} onChange={change('current')} />
    <PasswordField label={t.newPassword} name="new-password" value={values.next} error={errors.next}
      autoComplete="new-password" visibilityLabel={showLabel} disabled={busy} onChange={change('next')} />
    <PasswordField label={t.confirmPassword} name="confirm-password" value={values.confirm}
      error={errors.confirm} autoComplete="new-password" visibilityLabel={showLabel} disabled={busy}
      onChange={change('confirm')} />
    <Field orientation="horizontal" disabled={busy}>
      <Checkbox checked={signOutOthers} onCheckedChange={({ checked }) => setSignOutOthers(checked === true)} />
      <FieldLabel>{t.signOutOthers}</FieldLabel>
    </Field>
    {failure ? <Alert role="alert" variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onCancel}>{t.cancel}</Button>
      <Button type="submit" isLoading={busy}>{busy ? t.saving : t.changePassword}</Button>
    </div>
  </form>;
}

function Devices({ devices }: { devices: DevicesView }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState('');

  async function run(key: string, action: () => ReturnType<typeof api.revokeOtherSessions>) {
    setBusy(key);
    setFailure('');
    const result = await action();
    setBusy(undefined);
    if (result.ok) refresh();
    else setFailure(failureText(result.kind, common));
  }

  if (devices.status !== 'ok') {
    return <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
      <p className="text-muted-foreground">{devices.status === 'stale' ? common.staleBody : common.unavailableBody}</p>
      {devices.status === 'stale'
        ? <Button asChild variant="outline"><a href={signInHref('/security', true)}>{common.confirmIdentity}</a></Button>
        : <Button variant="outline" onClick={refresh}>{common.retry}</Button>}
    </div>;
  }
  const others = devices.items.filter(item => !item.current);
  return <>
    <ul className="divide-y divide-border/60">
      {devices.items.map(item => {
        const Icon = deviceIcons[item.kind];
        return <li key={item.id} className="flex items-center gap-4 px-5 py-4 sm:px-6">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
            <Icon className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{item.title}</p>
            <p className="text-sm text-muted-foreground">{item.current
              ? <span className="inline-flex items-center gap-1.5 font-medium text-success-foreground">
                <CircleCheckIcon className="size-4" aria-hidden="true" />{t.thisDevice}</span>
              : item.activity}</p>
          </div>
          {item.current ? null : <Button variant="outline" size="sm" isLoading={busy === item.id}
            disabled={!!busy} aria-label={`${t.signOutDevice} · ${item.title}`}
            onClick={() => run(item.id, () => api.revokeSession(item.token))}>{t.signOutDevice}</Button>}
        </li>;
      })}
    </ul>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
      {others.length ? <Button variant="outline" isLoading={busy === 'others'} disabled={!!busy}
        onClick={() => run('others', () => api.revokeOtherSessions())}>{t.signOutAll}</Button>
        : <p className="text-sm text-muted-foreground">{t.noOtherDevices}</p>}
    </div>
    {failure ? <Alert role="alert" variant="destructive" className="mx-5 mb-4 w-auto sm:mx-6">
      <AlertDescription>{failure}</AlertDescription></Alert> : null}
  </>;
}

export function SecurityOverview({ hasPassword, devices }: { hasPassword: boolean | null;
  devices: DevicesView }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  return <>
    <SectionHeading title={t.security} intro={t.securityIntro} />
    <div className="flex flex-col gap-6">
      <SettingsCard title={t.signInMethods} description={t.passwordHelp}>
        {changing ? <PasswordForm onCancel={() => setChanging(false)}
          onDone={() => { setChanging(false); setChanged(true); }} />
          : <SettingsRow label={t.password} action={hasPassword === false ? null
            : <Button variant="ghost" onClick={() => { setChanging(true); setChanged(false); }}>
              {t.changePassword}</Button>}>
            {hasPassword === null ? <span className="text-muted-foreground">{common.unavailableTitle}</span>
              : <span className="inline-flex items-center gap-2 font-medium">
                <CircleCheckIcon className="size-4 text-success-foreground" aria-hidden="true" />
                {hasPassword ? t.methodOn : common.notAvailableYet}</span>}
            {changed ? <Alert role="status" variant="success" className="mt-3">
              <AlertDescription>{t.passwordChanged}</AlertDescription></Alert> : null}
          </SettingsRow>}
        <SettingsRow label={t.methodPasskeys} action={<Badge variant="secondary">{common.comingSoon}</Badge>} />
        <SettingsRow label={t.methodTwoStep} action={<Badge variant="secondary">{common.comingSoon}</Badge>} />
      </SettingsCard>
      <SettingsCard title={t.devices} description={t.devicesIntro}><Devices devices={devices} /></SettingsCard>
      <SettingsCard title={t.activity}>
        <div className="flex items-start gap-4 px-5 py-5 sm:px-6">
          <HistoryIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="flex-1 text-muted-foreground">{t.activityEmpty}</p>
          <Badge variant="secondary">{common.comingSoon}</Badge>
        </div>
      </SettingsCard>
    </div>
  </>;
}
