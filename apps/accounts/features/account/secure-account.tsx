'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { AppWindowIcon, FingerprintIcon, LockKeyholeIcon, LogOutIcon, type LucideIcon, MailIcon,
  ShieldCheckIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SectionHeading } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

function Step({ icon: Icon, number, title, body, action }: { icon: LucideIcon; number: number; title: string;
  body: string; action: ReactNode }) {
  return <li className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) sm:flex-row sm:items-center sm:p-6">
    <span className="relative grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
      <Icon className="size-6" aria-hidden="true" />
      <span className="absolute -end-1 -top-1 grid size-5 place-items-center rounded-full bg-primary text-xs font-semibold
        text-primary-foreground" aria-hidden="true">{number}</span></span>
    <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground">{body}</p></div>
    <div className="shrink-0">{action}</div>
  </li>;
}

/** "Wasn't you?": what to do, in order, when activity looks unfamiliar. */
export function SecureAccount({ twoStep }: { twoStep: boolean }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>();
  async function signOutEverywhere() {
    setBusy(true);
    setOutcome(undefined);
    const result = await stepUp(() => api.revokeOtherSessions());
    setBusy(false);
    if (result.ok) setOutcome({ ok: true, text: t.devicesSignedOut });
    else if (result.kind !== 'cancelled') setOutcome({ ok: false, text: failureText(result.kind, common) });
  }
  const link = (href: string, label: string) => <Button variant="outline" asChild><a href={href}>{label}</a></Button>;
  const steps = [
    { icon: LockKeyholeIcon, title: t.secureStepPassword, body: t.secureStepPasswordBody,
      action: link('/security#password', t.changePassword) },
    { icon: LogOutIcon, title: t.secureStepDevices, body: t.secureStepDevicesBody,
      action: <Button variant="outline" isLoading={busy} onClick={() => void signOutEverywhere()}>{t.signOutAll}</Button> },
    { icon: FingerprintIcon, title: t.secureStepMethods, body: t.secureStepMethodsBody,
      action: link('/security/passkeys', t.reviewPasskeys) },
    ...twoStep ? [] : [{ icon: ShieldCheckIcon, title: t.secureStepTwoStep, body: t.secureStepTwoStepBody,
      action: link('/security/two-step-verification', t.turnOn) }],
    { icon: AppWindowIcon, title: t.secureStepApps, body: t.secureStepAppsBody, action: link('/connected-apps', t.manageApps) },
    { icon: MailIcon, title: t.secureStepEmail, body: t.secureStepEmailBody, action: link('/personal-info', t.reviewEmail) },
  ];
  return <>
    <SectionHeading back={{ href: '/security/activity', label: t.activity }} title={t.secureAccount}
      intro={t.secureAccountIntro} />
    {outcome ? <Alert role={outcome.ok ? 'status' : 'alert'} variant={outcome.ok ? 'success' : 'destructive'} className="mb-4">
      <AlertDescription>{outcome.text}</AlertDescription></Alert> : null}
    <ol className="flex flex-col gap-4">
      {steps.map((step, index) => <Step key={step.title} number={index + 1} {...step} />)}
    </ol>
  </>;
}
