'use client';

import { Button } from '@rezics/ui/button';
import { CircleAlertIcon, CircleCheckIcon, KeyRoundIcon, LaptopIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { sectionPaths } from './account-shell.tsx';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface HomeSummary {
  user: AvatarUser & { emailVerified: boolean };
  /** Counts are null when their source could not be read right now. */
  signInMethods: number | null;
  devices: number | null;
  apps: number | null;
}

function Check({ icon: Icon, tone, children }: { icon: LucideIcon; tone: 'ok' | 'warn' | 'plain';
  children: ReactNode }) {
  return <li className="flex items-center gap-3 py-1.5">
    <Icon aria-hidden="true" className={tone === 'ok' ? 'size-5 text-success-foreground'
      : tone === 'warn' ? 'size-5 text-warning-foreground' : 'size-5 text-muted-foreground'} />
    <span>{children}</span></li>;
}

function HomeCard({ title, children, href, action }: { title: string; children: ReactNode; href: string;
  action: string }) {
  return <section className="flex flex-col rounded-3xl border border-border/60 bg-card p-6 shadow-(--aura-shadow-card)">
    <h2 className="text-lg font-semibold">{title}</h2>
    <div className="mt-2 flex-1 text-muted-foreground">{children}</div>
    <div className="mt-5"><Button variant="soft" asChild><a href={href}>{action}</a></Button></div>
  </section>;
}

export function AccountHome({ summary }: { summary: HomeSummary }) {
  const { t } = useTranslation('account');
  const { user } = summary;
  return <div className="flex flex-col gap-8">
    <header className="flex flex-col items-center gap-4 pt-2 text-center">
      <UserAvatar user={user} className="size-24 text-3xl" />
      <h1 className="text-3xl font-semibold tracking-tight md:text-[34px]">
        {t.greeting({ name: user.name || user.email })}</h1>
      <p className="max-w-lg text-base text-muted-foreground">{t.homeIntro}</p>
    </header>
    <div className="grid gap-4 sm:grid-cols-2">
      <HomeCard title={t.checkupTitle} href={sectionPaths.security} action={t.reviewSecurity}>
        <p className="mb-2">{t.checkupBody}</p>
        <ul className="text-foreground">
          <Check icon={user.emailVerified ? CircleCheckIcon : CircleAlertIcon}
            tone={user.emailVerified ? 'ok' : 'warn'}>
            {user.emailVerified ? t.emailVerified : t.emailNotVerified}</Check>
          {summary.signInMethods === null ? null : <Check icon={KeyRoundIcon} tone="plain">
            {t.signInMethodCount(summary.signInMethods)}</Check>}
          {summary.devices === null ? null : <Check icon={LaptopIcon} tone="plain">
            {t.deviceCount(summary.devices)}</Check>}
        </ul>
      </HomeCard>
      <HomeCard title={t.connectedApps} href={sectionPaths['connected-apps']} action={t.manageApps}>
        {summary.apps === null ? t.appsIntro : t.appsCardBody(summary.apps)}
      </HomeCard>
      <HomeCard title={t.personalInfo} href={sectionPaths['personal-info']} action={t.manageInfo}>
        {t.infoCardBody}
      </HomeCard>
      <HomeCard title={t.dataPrivacy} href={sectionPaths['data-privacy']} action={t.dataPrivacy}>
        {t.privacyIntro}
      </HomeCard>
    </div>
  </div>;
}
