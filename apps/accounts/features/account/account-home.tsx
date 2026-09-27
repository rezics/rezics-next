'use client';

import { Button } from '@rezics/ui/button';
import { AppWindowIcon, CircleCheckIcon, CircleMinusIcon, FingerprintIcon, LaptopIcon, type LucideIcon,
  ShieldIcon, SlidersHorizontalIcon, UserRoundIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CheckupIssue } from './activity.ts';
import { sectionPaths } from './sections.ts';
import { CheckupCard } from './checkup-card.tsx';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface HomeSummary {
  user: AvatarUser & { emailVerified: boolean };
  /** What needs doing now; the checkup card shows only when this is not empty. */
  issues: CheckupIssue[];
  failedSignIns: number;
  /** Null when the source could not be read right now. */
  security: { passkeys: number; twoStep: boolean } | null;
  devices: number | null;
  apps: number | null;
}

function Line({ icon: Icon, on, children }: { icon: LucideIcon; on?: boolean; children: ReactNode }) {
  const Mark = on === undefined ? Icon : on ? CircleCheckIcon : CircleMinusIcon;
  return <li className="flex items-center gap-3 py-1">
    <Mark aria-hidden="true" className={on ? 'size-5 shrink-0 text-success-foreground' : 'size-5 shrink-0 text-muted-foreground'} />
    <span>{children}</span></li>;
}

function Tile({ icon: Icon, title, children, href, action }: { icon: LucideIcon; title: string; children: ReactNode;
  href: string; action: string }) {
  return <section className="flex flex-col rounded-3xl border border-border/60 bg-card p-6 shadow-(--aura-shadow-card)">
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-5" aria-hidden="true" /></span>
      <h2 className="text-lg font-semibold">{title}</h2>
    </div>
    <div className="mt-3 flex-1 text-muted-foreground">{children}</div>
    <div className="mt-5"><Button variant="soft" asChild><a href={href}>{action}</a></Button></div>
  </section>;
}

export function AccountHome({ summary }: { summary: HomeSummary }) {
  const { t } = useTranslation('account');
  const { user, security } = summary;
  return <div className="flex flex-col gap-8">
    <header className="flex flex-col items-center gap-3 pt-2 text-center">
      <UserAvatar user={user} className="size-24 text-3xl" />
      <h1 className="mt-1 text-3xl font-semibold tracking-tight md:text-[34px]">
        {t.greeting({ name: user.name || user.email })}</h1>
      <p className="text-muted-foreground">{user.email}</p>
      <p className="max-w-lg text-base text-muted-foreground">{t.homeIntro}</p>
    </header>
    <CheckupCard issues={summary.issues} failedSignIns={summary.failedSignIns} />
    <div className="grid gap-4 sm:grid-cols-2">
      <Tile icon={ShieldIcon} title={t.security} href={sectionPaths.security} action={t.reviewSecurity}>
        <ul className="text-foreground">
          {security ? <>
            <Line icon={ShieldIcon} on={security.twoStep}>{security.twoStep ? t.twoStepOn : t.twoStepOff}</Line>
            <Line icon={FingerprintIcon} on={security.passkeys > 0}>{t.passkeyCount(security.passkeys)}</Line>
          </> : null}
          {summary.devices === null ? null : <Line icon={LaptopIcon}>{t.deviceCount(summary.devices)}</Line>}
        </ul>
      </Tile>
      <Tile icon={UserRoundIcon} title={t.personalInfo} href={sectionPaths['personal-info']} action={t.manageInfo}>
        <ul className="text-foreground">
          <Line icon={UserRoundIcon} on={user.emailVerified}>{user.emailVerified ? t.emailVerified : t.emailNotVerified}</Line>
        </ul>
        <p className="mt-1">{t.infoCardBody}</p>
      </Tile>
      <Tile icon={AppWindowIcon} title={t.connectedApps} href={sectionPaths['connected-apps']} action={t.manageApps}>
        {summary.apps === null ? t.appsIntro : t.appsCardBody(summary.apps)}
      </Tile>
      <Tile icon={SlidersHorizontalIcon} title={t.dataPrivacy} href={sectionPaths['data-privacy']} action={t.dataPrivacy}>
        {t.privacyIntro}
      </Tile>
    </div>
  </div>;
}
