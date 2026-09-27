'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { NotebookPenIcon } from 'lucide-react';
import { useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { UserDetail } from '../api/types.ts';
import { ErrorAlert, useReauth } from '../actions/confirm.tsx';
import { reasonLabel } from '../audit/entry.tsx';
import { StatusBadge } from '../badges.tsx';
import { DateOnly, ExactTime, Time } from '../format.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { CopyButton, Facts, Panel } from './parts.tsx';
import { useTranslation } from '../../../i18n/client.ts';

type Note = UserDetail['notes'][number] & { pending?: boolean };

export function OverviewTab({ detail, onChanged }: { detail: UserDetail; onChanged(): Promise<void> }) {
  const { t } = useTranslation('admin');
  const user = detail.profile;
  const statusRows: [string, React.ReactNode][] = [[t.user.status, <StatusBadge key="status" status={user.status} />]];
  if (user.status === 'suspended') {
    statusRows.push([t.user.reason, <span key="reason" className="flex flex-col gap-1">
      {user.suspensionCode ? <Badge variant="outline" size="sm" className="w-fit">{reasonLabel(user.suspensionCode, t)}</Badge> : null}
      {user.suspensionReason ? <span>{user.suspensionReason}</span> : null}</span>]);
    if (user.suspendedAt) statusRows.push([t.user.since, <Time key="since" iso={user.suspendedAt} />]);
    statusRows.push([t.user.until, user.suspendedUntil ? <span key="until"><ExactTime iso={user.suspendedUntil} />{' · '}
      <Time iso={user.suspendedUntil} /></span> : t.user.noEnd]);
  } else {
    statusRows.push([t.user.reason, user.status === 'password-reset-required' ? t.user.resetExplained : t.user.activeExplained]);
  }
  return <div className="grid gap-4 lg:grid-cols-2">
    <Panel title={t.user.status} className={cn(user.status === 'suspended' && 'border-destructive/30',
      user.status === 'password-reset-required' && 'border-warning/40')}><Facts rows={statusRows} /></Panel>
    <Panel title={t.user.keyDates}><Facts rows={[
      [t.user.created, <DateOnly key="created" iso={user.createdAt} />],
      [t.user.lastSignIn, user.lastSignInAt ? <Time key="last" iso={user.lastSignInAt} /> : t.never],
      [t.user.updated, <Time key="updated" iso={user.updatedAt} />],
    ]} /></Panel>
    <Panel title={t.user.identity}><Facts rows={[
      [t.user.userId, <span key="id"><span className="break-all font-mono text-xs">{user.id}</span>{' '}
        <CopyButton value={user.id} label={t.user.copyId} /></span>],
      [t.user.email, <span key="email"><span className="break-all">{user.email}</span>{' '}<CopyButton value={user.email} label={t.user.copyEmail} /></span>],
      [t.user.emailVerified, user.emailVerified ? t.filters.yes : t.filters.no],
      [t.filters['2fa'], user.twoFactorEnabled ? t.filters.yes : t.filters.no],
    ]} /></Panel>
    <Notes userId={user.id} name={user.name || user.email} notes={detail.notes} onChanged={onChanged} />
  </div>;
}

/** Staff notes: append-only. The note shows at once as pending and becomes
 * permanent only when the service confirms it; on failure the text is kept. */
function Notes({ userId, name, notes, onChanged }: { userId: string; name: string; notes: UserDetail['notes']; onChanged(): Promise<void> }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { can } = useAdmin();
  const reauth = useReauth(false);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
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
  const shown: Note[] = [...(pending ? [pending] : []), ...notes];
  return <Panel title={t.user.notes} description={t.user.notesHelp}
    action={can('notes:write') && !open ? <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
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
  </Panel>;
}
