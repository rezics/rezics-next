'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, EllipsisIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminAction, Signal, UserDetail } from '../api/types.ts';
import { ActionDialog, type ActionRequest } from '../actions/action-dialog.tsx';
import { availableActions } from '../actions/actions.ts';
import { userHref } from '../audit/entry.tsx';
import { RoleBadge, StatusBadge, UnverifiedBadge } from '../badges.tsx';
import { DateOnly, Time } from '../format.tsx';
import { ReviewDialog, SignalRow } from '../signals/signal.tsx';
import { usePaletteActions, useAdmin } from '../shell/admin-context.tsx';
import { usePageKeys } from '../shell/keys.ts';
import { rememberUser } from '../shell/recent.ts';
import { toTarget } from '../users/directory-table.tsx';
import { UserAvatar } from '../../shell/user-avatar.tsx';
import { OverviewTab } from './overview-tab.tsx';
import { CopyButton } from './parts.tsx';
import { AppsTab, AuditTab, RolesTab } from './record-tabs.tsx';
import { SecurityTab } from './security-tab.tsx';
import { type TabData, userTabs } from './tabs.ts';
import { useTranslation } from '../../../i18n/client.ts';

/** Buttons for the first actions; the rest go in the menu. */
const primary: AdminAction[] = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset'];

/** Open signals about this account, each with its evidence and Review. */
function NeedsReview({ signals, onReviewed }: { signals: Signal[]; onReviewed(signal: Signal): void }) {
  const { t } = useTranslation('admin');
  const [reviewing, setReviewing] = useState<Signal | null>(null);
  if (!signals.length) return null;
  return <section aria-label={t.signals.title} className="mb-5 overflow-hidden rounded-3xl border border-destructive/25 bg-destructive/[0.03]">
    <h2 className="px-5 pt-3 text-sm font-semibold text-destructive-foreground">{t.signals.title}</h2>
    <ul className="divide-y divide-border/60">{signals.map(signal => <SignalRow key={signal.key} signal={signal} showSubject={false}
      onReview={setReviewing} />)}</ul>
    {reviewing ? <ReviewDialog signal={reviewing} onClose={() => setReviewing(null)}
      onDone={signal => { setReviewing(null); onReviewed(signal); }} /> : null}
  </section>;
}

export function UserPage({ initial, data }: { initial: UserDetail; data: TabData }) {
  const { t } = useTranslation('admin');
  const { api, navigate } = useAdminClient();
  const { me, can } = useAdmin();
  const [detail, setDetail] = useState(initial);
  const [tabData, setTabData] = useState(data);
  // Remounts the tab after a change, so its pages start from the fresh read.
  const [version, setVersion] = useState(0);
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const note = useRef<{ open(): void } | null>(null);
  const user = detail.profile;
  const target = toTarget(user);
  const actions = availableActions(target, me).filter(action => action !== 'add-note');
  const label = user.name || user.email;
  useEffect(() => { rememberUser({ id: user.id, name: user.name, email: user.email }); }, [user.id, user.name, user.email]);
  const open = useCallback((action: AdminAction) => setRequest({ action, targets: [toTarget(detail.profile)] }), [detail.profile]);
  const tabs = userTabs.filter(tab => tab !== 'audit' || can('audit:read'));
  const tabHref = (tab: string) => `${userHref(user.id)}${tab === 'overview' ? '' : `?tab=${tab}`}`;
  usePaletteActions([
    ...actions.map(action => ({ id: action, label: t.actions[action], hint: label, run: () => open(action) })),
    ...(can('notes:write') ? [{ id: 'note', label: t.actions['add-note'], hint: label, run: () => {
      if (tabData.tab === 'overview') note.current?.open(); else navigate(`${userHref(user.id)}#note`);
    } }] : []),
    ...tabs.filter(tab => tab !== tabData.tab).map(tab => ({ id: `tab:${tab}`, label: t.story.openTab({ tab: t.user.tabs[tab] }),
      hint: label, run: () => navigate(tabHref(tab)) })),
  ]);
  usePageKeys(event => {
    if (event.key !== 'n' || tabData.tab !== 'overview' || !can('notes:write')) return false;
    note.current?.open();
    return true;
  });
  useEffect(() => { if (window.location.hash === '#note') note.current?.open(); }, []);
  const reload = useCallback(async () => {
    const [result, page] = await Promise.all([api.user(user.id), tabData.tab === 'audit' ? api.audit({ targetId: user.id }) : null]);
    if (result.ok) setDetail(result.data);
    if (page?.ok && tabData.tab === 'audit') setTabData({ tab: 'audit', page: page.data });
    setVersion(value => value + 1);
  }, [api, user.id, tabData.tab]);
  const buttons = actions.filter(action => primary.includes(action)).slice(0, 3);
  const rest = actions.filter(action => !buttons.includes(action));
  const facts: [string, ReactNode][] = [
    [t.story.joined, <DateOnly key="joined" iso={user.createdAt} />],
    [t.user.lastSignIn, user.lastSignInAt ? <Time key="last" iso={user.lastSignInAt} /> : t.never],
    [t.story.twoStep, user.twoFactorEnabled ? t.filters.yes : t.filters.no],
  ];
  return <>
    <a href="/admin/users" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeftIcon className="size-4" aria-hidden="true" />{t.users}</a>
    <header className="mb-5 flex flex-wrap items-start gap-4">
      <UserAvatar user={user} size="lg" className="size-14 text-xl max-sm:size-11 max-sm:text-base" />
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words md:text-[28px]">{label}</h1>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span className="min-w-0"><span className="break-all">{user.email}</span> <CopyButton value={user.email} label={t.user.copyEmail} /></span>
          <span className="min-w-0"><span className="break-all font-mono text-xs">{user.id}</span> <CopyButton value={user.id} label={t.user.copyId} /></span>
        </p>
        <p className="mt-2 flex flex-wrap gap-1.5"><StatusBadge status={user.status} />{user.role ? <RoleBadge role={user.role} /> : null}
          {user.emailVerified ? null : <UnverifiedBadge />}</p>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {facts.map(([term, value]) => <div key={term} className="flex gap-1.5">
            <dt className="text-muted-foreground">{term}</dt><dd className="font-medium">{value}</dd></div>)}
        </dl>
      </div>
      {actions.length ? <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
        {buttons.map(action => <Button key={action} variant={action === 'suspend' ? 'destructive' : 'outline'}
          size="md" onClick={() => open(action)}>{t.actions[action]}</Button>)}
        {rest.length ? <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => open(value as AdminAction)}>
          <MenuTrigger asChild><Button variant="outline" size="icon-md" aria-label={t.actions.more}><EllipsisIcon aria-hidden="true" /></Button></MenuTrigger>
          <MenuContent className="min-w-56">{rest.map(action => <MenuItem key={action} value={action}>{t.actions[action]}</MenuItem>)}</MenuContent>
        </Menu> : null}
      </div> : null}
    </header>
    <NeedsReview signals={detail.signals} onReviewed={signal => setDetail(current => ({ ...current,
      signals: current.signals.filter(item => item.key !== signal.key) }))} />
    <nav aria-label={t.user.tabsLabel} className="mb-5 flex overflow-x-auto border-b border-border/60 [scrollbar-width:none]">
      {tabs.map(tab => {
        const current = tab === tabData.tab;
        return <a key={tab} href={tabHref(tab)} aria-current={current ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/32',
            current ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t.user.tabs[tab]}</a>;
      })}
    </nav>
    <div key={version} className="contents">
      {tabData.tab === 'overview' ? <OverviewTab detail={detail} category={tabData.show} onChanged={reload} noteRef={note} />
        : tabData.tab === 'security' ? <SecurityTab detail={detail} />
          : tabData.tab === 'roles' ? <RolesTab detail={detail} permissions={tabData.permissions} onChanged={() => void reload()} />
            : tabData.tab === 'audit' ? <AuditTab userId={user.id} initial={tabData.page} />
              : <AppsTab detail={detail} />}
    </div>
    <ActionDialog request={request} onClose={() => setRequest(null)} onDone={() => { setRequest(null); void reload(); }} />
  </>;
}
