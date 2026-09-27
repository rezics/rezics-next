'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, EllipsisIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminAction, UserDetail } from '../api/types.ts';
import { ActionDialog, type ActionRequest } from '../actions/action-dialog.tsx';
import { availableActions } from '../actions/actions.ts';
import { RoleBadge, StatusBadge, UnverifiedBadge } from '../badges.tsx';
import { usePaletteActions, useAdmin } from '../shell/admin-context.tsx';
import { toTarget } from '../users/directory-table.tsx';
import { UserAvatar } from '../../shell/user-avatar.tsx';
import { OverviewTab } from './overview-tab.tsx';
import { CopyButton } from './parts.tsx';
import { AppsTab, AuditTab, RolesTab, SanctionsTab } from './record-tabs.tsx';
import { SecurityTab } from './security-tab.tsx';
import { type TabData, userTabs } from './tabs.ts';
import { useTranslation } from '../../../i18n/client.ts';


/** Buttons for the first actions; the rest go in the menu. */
const primary: AdminAction[] = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset'];

export function UserPage({ initial, data }: { initial: UserDetail; data: TabData }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me, can } = useAdmin();
  const [detail, setDetail] = useState(initial);
  const [tabData, setTabData] = useState(data);
  // Remounts the tab after a change, so its pages start from the fresh read.
  const [version, setVersion] = useState(0);
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const user = detail.profile;
  const target = toTarget(user);
  const actions = availableActions(target, me).filter(action => action !== 'add-note');
  const label = user.name || user.email;
  const open = useCallback((action: AdminAction) => setRequest({ action, targets: [toTarget(detail.profile)] }), [detail.profile]);
  usePaletteActions(actions.map(action => ({ id: action, label: `${t.actions[action]} ${label}`, run: () => open(action) })));
  const reload = useCallback(async () => {
    const [result, page] = await Promise.all([api.user(user.id), tabData.tab === 'sanctions' ? api.sanctions(user.id)
      : tabData.tab === 'audit' ? api.audit({ targetId: user.id }) : null]);
    if (result.ok) setDetail(result.data);
    if (page?.ok && (tabData.tab === 'sanctions' || tabData.tab === 'audit')) setTabData({ tab: tabData.tab, page: page.data });
    setVersion(value => value + 1);
  }, [api, user.id, tabData.tab]);
  const tabs = userTabs.filter(tab => tab !== 'audit' || can('audit:read'));
  const buttons = actions.filter(action => primary.includes(action)).slice(0, 3);
  const rest = actions.filter(action => !buttons.includes(action));
  return <>
    <a href="/admin/users" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeftIcon className="size-4" aria-hidden="true" />{t.users}</a>
    <header className="mb-5 flex flex-wrap items-start gap-4">
      <UserAvatar user={user} size="lg" className="size-14 text-xl" />
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words md:text-[28px]">{label}</h1>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span className="min-w-0"><span className="break-all">{user.email}</span> <CopyButton value={user.email} label={t.user.copyEmail} /></span>
          <span className="min-w-0"><span className="break-all font-mono text-xs">{user.id}</span> <CopyButton value={user.id} label={t.user.copyId} /></span>
        </p>
        <p className="mt-2 flex flex-wrap gap-1.5"><StatusBadge status={user.status} />{user.role ? <RoleBadge role={user.role} /> : null}
          {user.emailVerified ? null : <UnverifiedBadge />}</p>
      </div>
      {actions.length ? <div className="flex flex-wrap items-center gap-2">
        {buttons.map(action => <Button key={action} variant={action === 'suspend' ? 'destructive' : 'outline'}
          size="md" onClick={() => open(action)}>{t.actions[action]}</Button>)}
        {rest.length ? <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => open(value as AdminAction)}>
          <MenuTrigger asChild><Button variant="outline" size="icon-md" aria-label={t.actions.more}><EllipsisIcon aria-hidden="true" /></Button></MenuTrigger>
          <MenuContent className="min-w-56">{rest.map(action => <MenuItem key={action} value={action}>{t.actions[action]}</MenuItem>)}</MenuContent>
        </Menu> : null}
      </div> : null}
    </header>
    <nav aria-label={t.user.tabsLabel} className="mb-5 flex overflow-x-auto border-b border-border/60 [scrollbar-width:none]">
      {tabs.map(tab => {
        const current = tab === tabData.tab;
        return <a key={tab} href={`?tab=${tab}`} aria-current={current ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/32',
            current ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t.user.tabs[tab]}</a>;
      })}
    </nav>
    <div key={version} className="contents">
      {tabData.tab === 'overview' ? <OverviewTab detail={detail} onChanged={reload} />
        : tabData.tab === 'security' ? <SecurityTab detail={detail} />
          : tabData.tab === 'roles' ? <RolesTab detail={detail} permissions={tabData.permissions} onChanged={() => void reload()} />
            : tabData.tab === 'sanctions' ? <SanctionsTab userId={user.id} initial={tabData.page} />
              : tabData.tab === 'audit' ? <AuditTab userId={user.id} initial={tabData.page} />
                : <AppsTab detail={detail} />}
    </div>
    <ActionDialog request={request} onClose={() => setRequest(null)} onDone={() => { setRequest(null); void reload(); }} />
  </>;
}
