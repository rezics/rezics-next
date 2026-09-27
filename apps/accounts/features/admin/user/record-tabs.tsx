'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { CheckIcon, MinusIcon, UserCogIcon } from 'lucide-react';
import { useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AuditEntry, AuditPage, Operators, UserDetail } from '../api/types.ts';
import { Actor, actionLabel, OutcomeBadge, reasonLabel } from '../audit/entry.tsx';
import { RoleBadge } from '../badges.tsx';
import { DateOnly, Time } from '../format.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { RoleDialog } from '../staff/role-dialog.tsx';
import { Empty, Panel, usePages } from './parts.tsx';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

/** One audit record as a timeline entry: who, what, why, when. */
function EntryItem({ entry, showOutcome = false }: { entry: AuditEntry; showOutcome?: boolean }) {
  const { t } = useTranslation('admin');
  const after = entry.after as { suspendedUntil?: string | null } | null;
  return <li className="flex flex-col gap-1 px-5 py-3 text-sm group-data-[density=compact]/admin:py-2">
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium">{actionLabel(entry.action, t)}</span>
      {entry.reasonCode ? <Badge variant="outline" size="sm">{reasonLabel(entry.reasonCode, t)}</Badge> : null}
      {showOutcome ? <OutcomeBadge outcome={entry.outcome} /> : null}
      <Time iso={entry.occurredAt} className="ms-auto text-xs text-muted-foreground" />
    </p>
    {entry.reason ? <p className="text-muted-foreground">{entry.reason}</p> : null}
    {entry.action === 'suspend' && after?.suspendedUntil ? <p className="text-xs text-muted-foreground">
      {t.user.until} <DateOnly iso={after.suspendedUntil} /></p> : null}
    {entry.userMessage ? <blockquote className="rounded-xl border-s-2 border-primary/40 bg-muted/50 px-3 py-2 text-xs">
      <span className="block font-medium text-muted-foreground">{t.user.messageToUser}</span>
      <span className="whitespace-pre-wrap">{entry.userMessage}</span></blockquote> : null}
    <p className="text-xs text-muted-foreground">{t.user.actorPrefix} <Actor entry={entry} /></p>
  </li>;
}

function EntryList({ initial, next, empty, showOutcome }: { initial: AuditPage;
  next(cursor: string): ReturnType<ReturnType<typeof useAdminClient>['api']['audit']>; empty: string; showOutcome?: boolean }) {
  const pages = usePages(initial, next);
  return <>{pages.items.length ? <ol className="divide-y divide-border/60 border-t border-border/60">
    {pages.items.map(entry => <EntryItem key={entry.id} entry={entry} showOutcome={showOutcome} />)}</ol> : <Empty>{empty}</Empty>}
  {pages.button}</>;
}

export function SanctionsTab({ userId, initial }: { userId: string; initial: AuditPage }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  return <Panel title={t.user.tabs.sanctions}>
    <EntryList initial={initial} next={cursor => api.sanctions(userId, cursor)} empty={t.user.sanctionsEmpty} />
  </Panel>;
}

export function AuditTab({ userId, initial }: { userId: string; initial: AuditPage }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  return <Panel title={t.user.tabs.audit} action={<Button asChild variant="link" size="sm" className="h-auto px-0">
    <a href={`/admin/audit?target=${encodeURIComponent(userId)}&range=all`}>{t.openAuditLog}</a></Button>}>
    <EntryList initial={initial} next={cursor => api.audit({ targetId: userId, cursor })} empty={t.user.auditEmpty} showOutcome />
  </Panel>;
}

export function AppsTab({ detail }: { detail: UserDetail }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current === 'zh-CN' ? 'zh-CN' : 'en';
  const { api } = useAdminClient();
  const apps = usePages(detail.apps, cursor => api.apps(detail.profile.id, cursor));
  return <Panel title={t.user.tabs.apps}>
    {apps.items.length ? <ul className="divide-y divide-border/60 border-t border-border/60">
      {apps.items.map(app => <li key={app.clientId} className="flex flex-col gap-1.5 px-5 py-3 text-sm">
        <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{app.name}</span>
          {app.trusted ? <Badge variant="soft" size="sm">{t.user.trusted}</Badge> : null}
          <span className="ms-auto text-xs text-muted-foreground">{t.user.granted} <DateOnly iso={app.grantedAt} />
            {' · '}{t.user.lastUsed} {app.lastUsedAt ? <Time iso={app.lastUsedAt} /> : t.never}</span></p>
        <ul className="flex flex-wrap gap-1.5">{app.scopes.map(scope => <li key={scope.scope}>
          <Badge variant="outline" size="sm" title={scope.scope}>{scope.description[locale]}</Badge></li>)}</ul>
      </li>)}
    </ul> : <Empty>{t.user.appsEmpty}</Empty>}
    {apps.button}
  </Panel>;
}

export function RolesTab({ detail, permissions, onChanged }: { detail: UserDetail; permissions: Operators['permissions'] | null;
  onChanged(): void }) {
  const { t } = useTranslation('admin');
  const { can } = useAdmin();
  const [changing, setChanging] = useState(false);
  const user = detail.profile;
  const allowed = user.role && permissions ? permissions[user.role] : [];
  const all = permissions ? permissions.owner : [];
  return <Panel title={t.user.role} description={can('operators:manage') ? undefined : t.user.rolesOwnerOnly}
    action={can('operators:manage') ? <Button size="sm" variant="outline" onClick={() => setChanging(true)}>
      <UserCogIcon aria-hidden="true" />{t.user.changeRole}</Button> : null}>
    <div className="border-t border-border/60 px-5 py-4">
      {user.role ? <RoleBadge role={user.role} /> : <p className="text-sm text-muted-foreground">{t.user.roleNone}</p>}
    </div>
    {user.role ? <>
      <h3 className="border-t border-border/60 px-5 pt-4 pb-2 text-sm font-medium">{t.user.rolePermissions}</h3>
      <ul className="grid gap-x-6 px-5 pb-4 text-sm sm:grid-cols-2">{all.map(permission => {
        const granted = (allowed as readonly string[]).includes(permission);
        return <li key={permission} className="flex items-center gap-2 py-1">
          {granted ? <CheckIcon className="size-4 text-success-foreground" aria-hidden="true" />
            : <MinusIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
          <span className={granted ? undefined : 'text-muted-foreground'}>{(t.permissions as Record<string, string>)[permission] ?? permission}</span>
          <span className="sr-only">{granted ? t.allowed : t.notAllowed}</span></li>;
      })}</ul></> : null}
    {changing ? <RoleDialog target={{ id: user.id, name: user.name, email: user.email, role: user.role }}
      onClose={() => setChanging(false)} onDone={() => { setChanging(false); onChanged(); }} /> : null}
  </Panel>;
}
