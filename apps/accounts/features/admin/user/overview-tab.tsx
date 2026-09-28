'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { FingerprintIcon, KeyRoundIcon, LaptopIcon, NotebookPenIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useImperativeHandle, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { TimelineCategory, UserDetail } from '../api/types.ts';
import { ErrorAlert, useReauth } from '../actions/confirm.tsx';
import { reasonLabel } from '../audit/entry.tsx';
import { StatusBadge } from '../badges.tsx';
import { DateOnly, ExactTime, Time } from '../format.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { Empty, Facts, Panel } from './parts.tsx';
import { Timeline } from './timeline.tsx';
import { useTranslation } from '../../../i18n/client.ts';

type Note = UserDetail['notes'][number] & { pending?: boolean };
type Session = UserDetail['sessions']['items'][number];

/** Sessions from the same app and browser, as the account centre groups them. */
export function deviceGroups(sessions: Session[]) {
  const groups = new Map<string, { label: string; client: string | null; phone: boolean; sessions: Session[] }>();
  for (const session of sessions) {
    const key = session.groupKey ?? `${session.clientName ?? ''}\0${session.device.label}`;
    const group = groups.get(key) ?? { label: session.device.label, client: session.clientName ?? null,
      phone: /iOS|Android/.test(session.device.platform ?? ''), sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group,
    lastActiveAt: group.sessions.map(session => session.lastActiveAt).sort().at(-1)!,
    networks: [...new Set(group.sessions.map(session => session.network).filter((network): network is string => !!network))] }))
    .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
}

export function Devices({ sessions, more }: { sessions: Session[]; more?: ReactNode }) {
  const { t } = useTranslation('admin');
  const groups = deviceGroups(sessions);
  return <Panel title={t.user.sessions} description={sessions.length ? t.story.sessionCount(sessions.length) : undefined}>
    {groups.length ? <ul className="divide-y divide-border/60 border-t border-border/60">
      {groups.map(group => {
        const Icon = group.phone ? SmartphoneIcon : LaptopIcon;
        return <li key={`${group.client}:${group.label}:${group.lastActiveAt}`} className="flex items-start gap-3 px-5 py-3 text-sm
          group-data-[density=compact]/admin:py-2">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">{group.client ? `${group.client} · ${group.label}` : group.label}
              {group.sessions.length > 1 ? <Badge variant="outline" size="sm">{t.story.sessionCount(group.sessions.length)}</Badge> : null}</p>
            <p className="text-xs text-muted-foreground">{t.user.lastActive} <Time iso={group.lastActiveAt} />
              {group.networks.length ? ` · ${t.user.network} ${group.networks.slice(0, 2).join(', ')}` : ''}
              {group.networks.length > 2 ? ` ${t.bulkMore(group.networks.length - 2)}` : ''}</p>
          </div>
        </li>;
      })}
    </ul> : <Empty>{t.user.noSessions}</Empty>}
    {more}
  </Panel>;
}

function Status({ detail }: { detail: UserDetail }) {
  const { t } = useTranslation('admin');
  const user = detail.profile;
  const rows: [string, ReactNode][] = [];
  if (user.status === 'suspended') {
    rows.push([t.user.reason, <span key="reason" className="flex flex-col gap-1">
      {user.suspensionCode ? <Badge variant="outline" size="sm" className="w-fit">{reasonLabel(user.suspensionCode, t)}</Badge> : null}
      {user.suspensionReason ? <span>{user.suspensionReason}</span> : null}</span>]);
    if (user.suspendedAt) rows.push([t.user.since, <Time key="since" iso={user.suspendedAt} />]);
    rows.push([t.user.until, user.suspendedUntil ? <span key="until"><ExactTime iso={user.suspendedUntil} />{' · '}
      <Time iso={user.suspendedUntil} /></span> : t.user.noEnd]);
  }
  return <Panel title={t.user.status} action={<StatusBadge status={user.status} />}
    className={cn(user.status === 'suspended' && 'border-destructive/30', user.status === 'password-reset-required' && 'border-warning/40')}>
    {rows.length ? <Facts rows={rows} /> : <p className="border-t border-border/60 px-5 py-3 text-sm text-muted-foreground">
      {user.status === 'password-reset-required' ? t.user.resetExplained : t.user.activeExplained}</p>}
  </Panel>;
}

/** How this account signs in, at a glance; the Security tab has the detail. */
function Methods({ detail }: { detail: UserDetail }) {
  const { t } = useTranslation('admin');
  const { methods } = detail;
  const item = (icon: ReactNode, text: string, on: boolean) => <li className={cn('flex items-center gap-2', !on && 'text-muted-foreground')}>
    {icon}{text}</li>;
  return <Panel title={t.user.methods} action={<Button asChild variant="link" size="sm" className="h-auto px-0">
    <a href="?tab=security">{t.story.details}</a></Button>}>
    <ul className="flex flex-col gap-2 border-t border-border/60 px-5 py-3 text-sm">
      {item(<KeyRoundIcon className="size-4" aria-hidden="true" />, methods.password ? t.story.passwordSet : t.user.passwordNone, methods.password)}
      {item(<FingerprintIcon className="size-4" aria-hidden="true" />, methods.passkeys.length ? t.story.passkeys(methods.passkeys.length)
        : t.user.noPasskeys, methods.passkeys.length > 0)}
      {item(<ShieldCheckIcon className="size-4" aria-hidden="true" />, methods.totp?.verified ? t.story.authenticatorOn
        : t.story.authenticatorOff, !!methods.totp?.verified)}
    </ul>
  </Panel>;
}

function Apps({ detail }: { detail: UserDetail }) {
  const { t } = useTranslation('admin');
  const apps = detail.apps.items;
  return <Panel title={t.user.tabs.apps} action={apps.length ? <Button asChild variant="link" size="sm" className="h-auto px-0">
    <a href="?tab=apps">{t.story.details}</a></Button> : undefined}>
    {apps.length ? <ul className="divide-y divide-border/60 border-t border-border/60">
      {apps.slice(0, 5).map(app => <li key={app.clientId} className="flex items-baseline gap-2 px-5 py-2.5 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{app.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{app.lastUsedAt ? <Time iso={app.lastUsedAt} />
          : <><span>{t.user.granted}</span> <DateOnly iso={app.grantedAt} /></>}</span>
      </li>)}
    </ul> : <Empty>{t.user.appsEmpty}</Empty>}
  </Panel>;
}

/** The account's whole story on one page: the timeline beside its status,
 * sign-in methods, devices, apps and staff notes. */
export function OverviewTab({ detail, category, onChanged, noteRef }: { detail: UserDetail; category: TimelineCategory;
  onChanged(): Promise<void>; noteRef: RefObject<{ open(): void } | null> }) {
  const appNames = new Map(detail.apps.items.map(app => [app.clientId, app.name]));
  // On a phone: status, then the story, then the rest; wide: the story beside them.
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:grid-rows-[auto_1fr]">
    <div className="lg:col-start-2 lg:row-start-1"><Status detail={detail} /></div>
    <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
      <Timeline userId={detail.profile.id} initial={detail.timeline} initialCategory={category}
        appName={clientId => appNames.get(clientId) ?? clientId} />
    </div>
    <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-2">
      <Notes userId={detail.profile.id} name={detail.profile.name || detail.profile.email} notes={detail.notes} onChanged={onChanged}
        handle={noteRef} />
      <Methods detail={detail} />
      <Devices sessions={detail.sessions.items} />
      <Apps detail={detail} />
    </div>
  </div>;
}

/** Staff notes: append-only. The note shows at once as pending and becomes
 * permanent only when the service confirms it; on failure the text is kept. */
function Notes({ userId, name, notes, onChanged, handle }: { userId: string; name: string; notes: UserDetail['notes'];
  onChanged(): Promise<void>; handle: RefObject<{ open(): void } | null> }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { can } = useAdmin();
  const reauth = useReauth(false);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const writable = can('notes:write');
  useImperativeHandle(handle, () => ({ open: () => { if (writable) setOpen(true); } }), [writable]);
  async function save() {
    const body = text.trim();
    if (!body || reauth.missing) return;
    setError(null);
    setPending({ id: 'pending', authorId: '', authorName: null, authorEmail: null, body, createdAt: new Date().toISOString(), pending: true });
    const result = await reauth.run(() => api.act(userId, { action: 'add-note', commandId, reason: t.actionLabels['add-note'], note: body }));
    if (!result.ok) { setPending(null); setError(`${t.user.noteFailed} ${result.message}`); return; }
    await onChanged();
    setPending(null); setText(''); setOpen(false); setCommandId(crypto.randomUUID());
  }
  const shown: Note[] = [...(pending ? [pending] : []), ...notes].slice(0, 3);
  return <Panel title={t.user.notes} description={t.user.notesHelp}
    action={can('notes:write') && !open ? <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-keyshortcuts="n">
      <NotebookPenIcon aria-hidden="true" />{t.user.addNote}</Button> : null}>
    {open ? <form className="flex flex-col gap-3 border-t border-border/60 px-5 py-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field disabled={!!pending}><FieldLabel>{t.user.noteLabel}</FieldLabel>
        <Textarea value={text} autoFocus maxLength={4000} placeholder={t.user.notePlaceholder} aria-label={t.actionTitles['add-note']({ name })}
          onChange={event => setText(event.currentTarget.value)} />
        <FieldDescription>{t.consequences['add-note']}</FieldDescription></Field>
      {reauth.fields(!!pending)}
      <ErrorAlert message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setOpen(false); setError(null); }} disabled={!!pending}>{t.cancel}</Button>
        <Button type="submit" isLoading={!!pending} disabled={!text.trim() || reauth.missing}>{pending ? t.user.savingNote : t.user.saveNote}</Button>
      </div>
    </form> : null}
    {shown.length ? <ol className="divide-y divide-border/60 border-t border-border/60">
      {shown.map(note => <li key={note.id} className={cn('px-5 py-3 text-sm', note.pending && 'opacity-60')} aria-busy={note.pending || undefined}>
        <p className="whitespace-pre-wrap">{note.body}</p>
        <p className="mt-1 text-xs text-muted-foreground">{note.pending ? t.user.savingNote : <>
          {t.user.by({ name: note.authorName || note.authorEmail || note.authorId })}
          {' · '}<Time iso={note.createdAt} /></>}</p>
      </li>)}
    </ol> : <p className="border-t border-border/60 px-5 py-6 text-center text-sm text-muted-foreground">{t.user.noNotes}</p>}
    {notes.length > 3 ? <p className="border-t border-border/60 px-5 py-2.5 text-xs text-muted-foreground">{t.story.moreNotes(notes.length - 3)}</p> : null}
  </Panel>;
}
