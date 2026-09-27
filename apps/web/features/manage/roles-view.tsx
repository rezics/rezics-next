'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldError, FieldHelper, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { CheckIcon, PencilIcon, PlusIcon, ShieldIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { type AdminApi, bffAdminApi, useRoleChange } from './admin-api.ts';
import { CommandDialog } from './command-dialog.tsx';
import { agentLabel } from './format.ts';
import { ImpactPreview } from './impact-preview.tsx';
import { failureText } from './members-view.tsx';
import type { ManageMessages } from './messages.ts';
import { permissionOrder, permissionText, sortPermissions } from './permissions.ts';
import { mergeAgents } from './read.ts';
import { REASON_LIMIT } from './reason-dialog.tsx';
import type { AgentSummary, RealmPermission, Role, RoleChange, RoleList } from './types.ts';

/**
 * The Realm's roles as bundles of permissions in plain words. Every edit shows
 * who gains or loses what before it can be saved.
 */
export function RolesView({ realm, actingSubject, list, holders, agents, locale, messages, api: givenApi }: {
  realm: string; actingSubject: string; list: RoleList;
  /** Role holders from the members roster, by role; people outside the roster are not listed. */
  holders: Record<string, readonly string[]>; agents: Record<string, AgentSummary>;
  locale: UiLocale; messages: ManageMessages; api?: AdminApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffAdminApi(realm, actingSubject), [givenApi, realm, actingSubject]);
  const router = useRouter();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const name = (iri: string) => agentLabel(agents[iri], iri, id => t.agentFallback({ id }));
  return <div className="grid gap-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="font-semibold text-xl tracking-tight">{t.rolesTitle}</h2>
        <p className="max-w-2xl text-muted-foreground text-sm">{t.rolesHelp}</p>
      </div>
      <Button size="sm" onClick={() => setEditing('new')}><PlusIcon aria-hidden="true" />{t.newRole}</Button>
    </div>
    <div role="status" aria-live="polite" className="empty:hidden">{status ? <p className="text-sm">{status}</p> : null}</div>
    {!list.roles.length ? <EmptyState icon={ShieldIcon} title={t.noRolesTitle} description={t.noRolesHelp} />
      : <ul className="grid gap-4 md:grid-cols-2">
        {list.roles.map(role => <li key={role.id} className="grid content-start gap-4 rounded-2xl border border-border/60 bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-semibold">{role.name}</h3>
              <p className="text-muted-foreground text-sm">{role.permissions.length
                ? t.permissionCount(role.permissions.length) : t.noPermissions}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(role)} aria-label={`${t.editRole}: ${role.name}`}>
              <PencilIcon aria-hidden="true" />{t.editRole}</Button>
          </div>
          <ul aria-label={t.permissionsLabel} className="grid gap-2.5">
            {sortPermissions(role.permissions).map(permission => <li key={permission} className="flex gap-2.5 text-sm">
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              <span><span className="font-medium">{t[permissionText[permission].name]}</span>
                <span className="block text-muted-foreground">{t[permissionText[permission].help]}</span></span>
            </li>)}
          </ul>
          <p className="border-border/60 border-t pt-3 text-muted-foreground text-sm">
            {holders[role.id]?.length ? holders[role.id]!.map(name).join(', ') : t.roleHoldersHelp}</p>
        </li>)}
      </ul>}
    {editing ? <RoleEditor role={editing === 'new' ? null : editing} generation={list.generation} api={api}
      actingSubject={actingSubject} agents={agents} locale={locale} messages={messages} onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); setStatus(t.roleSaved); router.refresh(); }} /> : null}
  </div>;
}

function RoleEditor({ role, generation, api, actingSubject, agents, locale, messages, onClose, onSaved }: {
  role: Role | null; generation: string; api: AdminApi; actingSubject: string; agents: Record<string, AgentSummary>;
  locale: UiLocale; messages: ManageMessages; onClose: () => void; onSaved: () => void;
}) {
  const t = materializeData(messages, { locale });
  const [roleId] = useState(() => role?.id ?? crypto.randomUUID());
  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<readonly RealmPermission[]>(role?.permissions ?? []);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const change = useMemo<RoleChange | null>(() => name.trim()
    ? { kind: 'role', roleId, name: name.trim(), permissions: sortPermissions(permissions) } : null,
  [roleId, name, permissions]);
  const unchanged = role !== null && role.name === name.trim()
    && sortPermissions(role.permissions).join() === sortPermissions(permissions).join();
  const { state, save, names } = useRoleChange(api, { actingSubject, generation, change: unchanged ? null : change });

  async function submit() {
    if (!name.trim()) { setError(t.roleNameRequired); return; }
    if (!reason.trim()) { setError(t.reasonRequired); return; }
    setPending(true); setError(null);
    const result = await save(reason);
    setPending(false);
    if (!result.ok) { setError(failureText(result.failure, t, 'role')); return; }
    onSaved();
  }

  return <CommandDialog open title={role ? t.editRole : t.newRole} confirm={role ? t.saveRole : t.createRole}
    pending={pending} error={error} cancel={t.cancel} onClose={onClose} onConfirm={() => void submit()}
    disabled={unchanged || state.kind !== 'ready'}>
    <Field invalid={error === t.roleNameRequired}>
      <FieldLabel>{t.roleNameLabel}</FieldLabel>
      <Input value={name} maxLength={80} onChange={event => setName(event.currentTarget.value)} />
      {error === t.roleNameRequired ? <FieldError>{error}</FieldError> : null}
    </Field>
    <FieldSet>
      <FieldLegend>{t.permissionsLabel}</FieldLegend>
      <div className="grid gap-3">
        {permissionOrder.map(permission => <Field key={permission} orientation="horizontal">
          <Checkbox checked={permissions.includes(permission)} onCheckedChange={details => setPermissions(current =>
            details.checked === true ? [...current, permission] : current.filter(item => item !== permission))} />
          <FieldContent>
            <FieldLabel>{t[permissionText[permission].name]}</FieldLabel>
            <FieldDescription>{t[permissionText[permission].help]}</FieldDescription>
          </FieldContent>
        </Field>)}
      </div>
    </FieldSet>
    <ImpactPreview state={state} agents={mergeAgents(agents, names)} actingSubject={actingSubject} locale={locale}
      messages={messages} />
    <Field invalid={error === t.reasonRequired}>
      <FieldLabel>{t.changeReasonLabel}</FieldLabel>
      <Textarea value={reason} rows={2} maxLength={REASON_LIMIT} onChange={event => setReason(event.currentTarget.value)} />
      <FieldHelper>{t.changeReasonHelp}</FieldHelper>
    </Field>
  </CommandDialog>;
}
