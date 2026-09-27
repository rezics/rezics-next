'use client';

import { Button } from '@rezics/ui/button';
import { Kbd } from '@rezics/ui/kbd';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from '@rezics/ui/sheet';
import { SkipNavContent, SkipNavLink } from '@rezics/ui/skip-nav';
import { Toaster } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, ArrowUpLeftIcon, KeyboardIcon, LayoutDashboardIcon, LogOutIcon, MenuIcon, Rows3Icon, Rows4Icon,
  ScrollTextIcon, SearchIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useAccountClient } from '../../api/account-client.tsx';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminMe } from '../api/types.ts';
import { Brand } from '../../shell/brand.tsx';
import { type AvatarUser, UserAvatar } from '../../shell/user-avatar.tsx';
import { RoleBadge } from '../badges.tsx';
import { AdminProvider, type Density, useAdmin } from './admin-context.tsx';
import { CommandPalette } from './command-palette.tsx';
import { isEditable, isMac, usePageKeys } from './keys.ts';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import { StepUpProvider } from './step-up.tsx';
import { useTranslation } from '../../../i18n/client.ts';

export type AdminSection = 'overview' | 'users' | 'staff' | 'clients' | 'audit';
export const adminPaths: Record<AdminSection, string> = { overview: '/admin', users: '/admin/users', staff: '/admin/staff',
  clients: '/admin/clients', audit: '/admin/audit' };
const sections = [
  { id: 'overview', icon: LayoutDashboardIcon },
  { id: 'users', icon: UsersIcon },
  { id: 'staff', icon: ShieldCheckIcon },
  { id: 'clients', icon: AppWindowIcon, permission: 'clients:manage' },
  { id: 'audit', icon: ScrollTextIcon, permission: 'audit:read' },
] as const;

/** The operator panel frame: section navigation (a sheet on phones), the
 * command palette trigger, density and shortcuts, and the operator's menu. */
export function AdminShell({ me, user, density, section, children }: { me: AdminMe; user: AvatarUser;
  density: Density; section?: AdminSection; children: ReactNode }) {
  return <AdminProvider me={me} density={density}>
    <StepUpProvider><Frame user={user} section={section}>{children}</Frame></StepUpProvider>
  </AdminProvider>;
}

function Navigation({ section, onNavigate }: { section?: AdminSection; onNavigate?(): void }) {
  const { t } = useTranslation('admin');
  const { can } = useAdmin();
  return <nav aria-label={t.sectionsLabel} className="flex flex-col gap-0.5">
    {sections.filter(item => !('permission' in item) || can(item.permission)).map(item => {
      const Icon = item.icon;
      const current = item.id === section;
      return <a key={item.id} href={adminPaths[item.id]} aria-current={current ? 'page' : undefined} onClick={onNavigate}
        className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium outline-none transition-colors',
          'focus-visible:ring-[3px] focus-visible:ring-ring/32',
          current ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
        <Icon className="size-4.5" aria-hidden="true" />{t[item.id]}</a>;
    })}
  </nav>;
}

function Frame({ user, section, children }: { user: AvatarUser; section?: AdminSection; children: ReactNode }) {
  const { t } = useTranslation('admin');
  const common = useTranslation('common').t;
  const { me, density, setDensity, setPaletteOpen, setShortcutsOpen } = useAdmin();
  const { navigate } = useAdminClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { if (isMac()) setMod('⌘'); }, []);
  // ⌘K / Ctrl-K works everywhere, even in a text field, but never mid-composition.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [setPaletteOpen]);
  usePageKeys(event => {
    if (event.key === '?') { setShortcutsOpen(true); return true; }
    if (event.key !== '/') return false;
    const search = document.getElementById('admin-search');
    if (search && !isEditable(document.activeElement)) search.focus();
    else if (!search) navigate(`${adminPaths.users}#search`);
    return true;
  });
  const compact = density === 'compact';
  return <div data-density={density} className="group/admin min-h-dvh bg-background lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
    <SkipNavLink>{t.skipToContent}</SkipNavLink>
    <aside className="sticky top-0 flex h-dvh flex-col gap-6 border-r border-border/60 bg-card/50 px-3 py-5 max-lg:hidden">
      <div className="px-2"><Brand label={t.panelHome} product={t.productName} href={adminPaths.overview} /></div>
      <Navigation section={section} />
      <div className="mt-auto flex flex-col gap-3 px-2">
        {me.role ? <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t.yourRole}<RoleBadge role={me.role} /></span> : null}
        <a href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowUpLeftIcon className="size-4" aria-hidden="true" />{t.backToAccount}</a>
      </div>
    </aside>
    <div className="min-w-0">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border/60 bg-background/90 px-3 backdrop-blur sm:px-4">
        <Sheet open={menuOpen} onOpenChange={details => setMenuOpen(details.open)}>
          <SheetTrigger asChild><Button variant="ghost" size="icon-md" aria-label={t.openMenu} className="lg:hidden">
            <MenuIcon aria-hidden="true" /></Button></SheetTrigger>
          <SheetContent placement="left" className="w-72">
            <SheetHeader><Brand label={t.panelHome} product={t.productName} href={adminPaths.overview} /></SheetHeader>
            <SheetBody className="flex flex-col gap-6">
              <Navigation section={section} onNavigate={() => setMenuOpen(false)} />
              <a href="/" className="inline-flex items-center gap-2 px-3 text-sm text-muted-foreground">
                <ArrowUpLeftIcon className="size-4" aria-hidden="true" />{t.backToAccount}</a>
            </SheetBody>
          </SheetContent>
        </Sheet>
        <Button variant="outline" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K"
          className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-xl px-3 text-muted-foreground sm:max-w-md">
          <SearchIcon aria-hidden="true" /><span className="truncate">{t.palette.trigger}</span>
          <Kbd className="ms-auto max-sm:hidden" aria-hidden="true">{mod} K</Kbd>
        </Button>
        <div className="ms-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-md" aria-pressed={compact} aria-label={t.density.compact} title={t.density.label}
            onClick={() => setDensity(compact ? 'comfortable' : 'compact')}>
            {compact ? <Rows4Icon aria-hidden="true" /> : <Rows3Icon aria-hidden="true" />}</Button>
          <Button variant="ghost" size="icon-md" aria-label={t.shortcuts.open} onClick={() => setShortcutsOpen(true)}
            className="max-sm:hidden"><KeyboardIcon aria-hidden="true" /></Button>
          <OperatorMenu user={user} signOutLabel={common.signOut} />
        </div>
      </header>
      <SkipNavContent>
        <main className={cn('mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8', compact ? 'py-5' : 'py-6 md:py-8')}>{children}</main>
      </SkipNavContent>
    </div>
    <CommandPalette />
    <ShortcutsDialog />
    <Toaster />
  </div>;
}

function OperatorMenu({ user, signOutLabel }: { user: AvatarUser; signOutLabel: string }) {
  const { t } = useTranslation('admin');
  const { api, navigate } = useAccountClient();
  return <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => {
    if (value === 'account') navigate('/');
    if (value === 'sign-out') void api.signOut().then(() => navigate('/sign-in'));
  }}>
    <MenuTrigger asChild><Button variant="ghost" size="icon-lg" pill aria-label={user.name || user.email} className="rounded-full">
      <UserAvatar user={user} size="sm" /></Button></MenuTrigger>
    <MenuContent className="min-w-64">
      <div className="flex items-center gap-3 px-2 py-2">
        <UserAvatar user={user} />
        <div className="min-w-0"><p className="truncate font-medium">{user.name}</p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p></div>
      </div>
      <MenuSeparator />
      <MenuItem value="account"><ArrowUpLeftIcon aria-hidden="true" />{t.backToAccount}</MenuItem>
      <MenuItem value="sign-out"><LogOutIcon aria-hidden="true" />{signOutLabel}</MenuItem>
    </MenuContent>
  </Menu>;
}
