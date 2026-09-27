'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, ArrowUpRightIcon, HouseIcon, LogOutIcon, ShieldIcon, SlidersHorizontalIcon,
  UserRoundIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { Brand } from '../shell/brand.tsx';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useTranslation } from '../../i18n/client.ts';

export type AccountSection = 'home' | 'personal-info' | 'security' | 'connected-apps' | 'data-privacy';

export const sectionPaths: Record<AccountSection, string> = { home: '/', 'personal-info': '/personal-info',
  security: '/security', 'connected-apps': '/connected-apps', 'data-privacy': '/data-privacy' };

const sections = [
  { id: 'home', icon: HouseIcon, label: 'home' },
  { id: 'personal-info', icon: UserRoundIcon, label: 'personalInfo' },
  { id: 'security', icon: ShieldIcon, label: 'security' },
  { id: 'connected-apps', icon: AppWindowIcon, label: 'connectedApps' },
  { id: 'data-privacy', icon: SlidersHorizontalIcon, label: 'dataPrivacy' },
] as const;

function AccountMenu({ user }: { user: AvatarUser }) {
  const { t } = useTranslation('common');
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    await api.signOut();
    navigate('/sign-in');
  }
  return <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => {
    if (value === 'sign-out') void signOut();
  }}>
    <MenuTrigger asChild><Button variant="ghost" size="icon-lg" pill aria-label={t.accountMenu}
      className="rounded-full"><UserAvatar user={user} /></Button></MenuTrigger>
    <MenuContent className="min-w-64">
      <div className="flex items-center gap-3 px-2 py-2">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0"><p className="truncate font-medium">{user.name}</p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p></div>
      </div>
      <MenuSeparator />
      <MenuItem value="sign-out" disabled={busy}><LogOutIcon aria-hidden="true" />
        {busy ? t.signingOut : t.signOut}</MenuItem>
    </MenuContent>
  </Menu>;
}

/** Account centre frame: left navigation on desktop, scrolling tabs on phones. */
export function AccountShell({ section, user, webOrigin, children }: { section?: AccountSection;
  user?: AvatarUser; webOrigin: string; children: ReactNode }) {
  const common = useTranslation('common').t;
  const { t } = useTranslation('account');
  const link = (item: (typeof sections)[number], tab: boolean) => {
    const current = item.id === section;
    const Icon = item.icon;
    return <a key={item.id} href={sectionPaths[item.id]} aria-current={current ? 'page' : undefined}
      className={cn('flex shrink-0 items-center gap-3 font-medium outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/32',
        tab ? 'border-b-2 px-3 py-3 text-sm' : 'rounded-full px-4 py-2.5',
        current ? tab ? 'border-primary text-primary' : 'bg-accent text-accent-foreground'
          : tab ? 'border-transparent text-muted-foreground hover:text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
      {tab ? null : <Icon className="size-5" aria-hidden="true" />}{t[item.label]}</a>;
  };
  return <div className="min-h-dvh bg-background">
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Brand label={common.homeLink} product={common.productName} />
        <div className="flex-1" />
        <Button variant="ghost" asChild className="max-sm:hidden"><a href={webOrigin}>
          {common.goToRezics}<ArrowUpRightIcon aria-hidden="true" /></a></Button>
        {user ? <AccountMenu user={user} />
          : <Button asChild><a href={`/sign-in?next=${encodeURIComponent(sectionPaths[section ?? 'home'])}`}>
            {common.signIn}</a></Button>}
      </div>
      <nav aria-label={t.sections} className="flex overflow-x-auto px-2 md:hidden [scrollbar-width:none]">
        {sections.map(item => link(item, true))}</nav>
    </header>
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-6 md:grid-cols-[15rem_minmax(0,1fr)] md:py-10">
      <nav aria-label={t.sections} className="sticky top-24 flex flex-col gap-1 self-start max-md:hidden">
        {sections.map(item => link(item, false))}</nav>
      <main className="min-w-0 max-w-3xl">{children}</main>
    </div>
  </div>;
}

/** Page heading used by every account section. */
export function SectionHeading({ title, intro }: { title: string; intro?: string }) {
  return <header className="mb-6 md:mb-8">
    <h1 className="text-3xl font-semibold tracking-tight md:text-[34px]">{title}</h1>
    {intro ? <p className="mt-2 text-base text-muted-foreground">{intro}</p> : null}
  </header>;
}

/** A titled card holding the rows of one topic, as Google Account groups settings. */
export function SettingsCard({ title, description, children, className }: { title: string;
  description?: string; children: ReactNode; className?: string }) {
  const id = `card-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return <section aria-labelledby={id} className={cn('rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)', className)}>
    <header className="px-5 pt-5 pb-3 sm:px-6">
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </header>
    <div className="divide-y divide-border/60">{children}</div>
  </section>;
}

/** One row of a settings card: label, value and an optional action. */
export function SettingsRow({ label, children, action }: { label: string; children?: ReactNode;
  action?: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 sm:flex-nowrap sm:px-6">
    <div className="w-full shrink-0 text-sm font-medium text-muted-foreground sm:w-40">{label}</div>
    <div className="min-w-0 flex-1">{children}</div>
    {action ? <div className="shrink-0">{action}</div> : null}
  </div>;
}
