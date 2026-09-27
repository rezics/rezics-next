'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/table';
import { CheckIcon, MinusIcon, ShieldAlertIcon, UserPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { OperatorEntry, OperatorRole, Operators } from '../api/types.ts';
import { userHref } from '../audit/entry.tsx';
import { RoleBadge, StatusBadge } from '../badges.tsx';
import { DateOnly, Time } from '../format.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { type RoleTarget, RoleDialog } from './role-dialog.tsx';
import { useTranslation } from '../../../i18n/client.ts';

const roles: OperatorRole[] = ['owner', 'admin', 'support'];
const cell = 'px-3 py-2.5 group-data-[density=compact]/admin:py-1';

export function StaffPage({ operators }: { operators: Operators }) {
  const { t } = useTranslation('admin');
  const { can } = useAdmin();
  const { refresh } = useAdminClient();
  const [target, setTarget] = useState<RoleTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const manage = can('operators:manage');
  const change = (entry: OperatorEntry) => setTarget({ id: entry.userId, name: entry.name, email: entry.email, role: entry.role });
  return <>
    <PageHeading title={t.staff} intro={t.staffIntro} actions={manage ? <Button onClick={() => setAdding(true)}>
      <UserPlusIcon aria-hidden="true" />{t.addStaff}</Button> : null} />
    <div className="flex flex-col gap-6">
      <Table className="min-w-[48rem]">
        <TableCaption className="sr-only">{t.staffTable}</TableCaption>
        <TableHeader><TableRow>
          <TableHead scope="col" className="px-3">{t.columns.name}</TableHead>
          <TableHead scope="col" className="px-3">{t.columns.role}</TableHead>
          <TableHead scope="col" className="px-3">{t.filters['2fa']}</TableHead>
          <TableHead scope="col" className="px-3">{t.columns.status}</TableHead>
          <TableHead scope="col" className="px-3">{t.assigned}</TableHead>
          <TableHead scope="col" className="px-3">{t.columns.lastSignIn}</TableHead>
          {manage ? <TableHead scope="col" className="px-3"><span className="sr-only">{t.actions.more}</span></TableHead> : null}
        </TableRow></TableHeader>
        <TableBody>{operators.items.map(entry => <TableRow key={entry.userId}>
          <TableCell className={cell}><a href={userHref(entry.userId)} className="block font-medium hover:underline">{entry.name || entry.email}</a>
            <span className="block text-xs text-muted-foreground">{entry.email}</span></TableCell>
          <TableCell className={cell}><RoleBadge role={entry.role} /></TableCell>
          <TableCell className={cell}>{entry.twoFactorEnabled ? <span className="inline-flex items-center gap-1 text-success-foreground">
            <CheckIcon className="size-4" aria-hidden="true" />{t.twoFactorOn}</span>
            : <Badge variant="warning" size="sm"><ShieldAlertIcon aria-hidden="true" />{t.noTwoFactorWarning}</Badge>}</TableCell>
          <TableCell className={cell}><StatusBadge status={entry.status} /></TableCell>
          <TableCell className={`${cell} text-muted-foreground`}><DateOnly iso={entry.assignedAt} /></TableCell>
          <TableCell className={`${cell} text-muted-foreground`}>{entry.lastSignInAt ? <Time iso={entry.lastSignInAt} /> : t.never}</TableCell>
          {manage ? <TableCell className={`${cell} text-end`}><Button size="sm" variant="outline" onClick={() => change(entry)}>
            {t.user.changeRole}</Button></TableCell> : null}
        </TableRow>)}</TableBody>
      </Table>
      <section aria-labelledby="permissions-table">
        <h2 id="permissions-table" className="mb-3 text-lg font-semibold">{t.permissionsTable}</h2>
        <Table className="min-w-[36rem]">
          <TableCaption className="sr-only">{t.permissionsTable}</TableCaption>
          <TableHeader><TableRow>
            <TableHead scope="col" className="px-3">{t.permission}</TableHead>
            {roles.map(role => <TableHead key={role} scope="col" className="px-3 text-center">{t.roles[role]}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>{operators.permissions.owner.map(permission => <TableRow key={permission}>
            <TableHead scope="row" className={`${cell} font-normal`}>{(t.permissions as Record<string, string>)[permission] ?? permission}</TableHead>
            {roles.map(role => {
              const granted = (operators.permissions[role] as readonly string[]).includes(permission);
              return <TableCell key={role} className={`${cell} text-center`}>
                {granted ? <CheckIcon className="inline size-4 text-success-foreground" aria-hidden="true" />
                  : <MinusIcon className="inline size-4 text-muted-foreground" aria-hidden="true" />}
                <span className="sr-only">{granted ? t.allowed : t.notAllowed}</span></TableCell>;
            })}
          </TableRow>)}</TableBody>
        </Table>
      </section>
    </div>
    {adding ? <AddStaffDialog onClose={() => setAdding(false)} onFound={found => { setAdding(false); setTarget(found); }} /> : null}
    {target ? <RoleDialog target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); refresh(); }} /> : null}
  </>;
}

/** Find the account by its exact email, then choose the role. */
function AddStaffDialog({ onClose, onFound }: { onClose(): void; onFound(target: RoleTarget): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState(false);
  async function find() {
    setPending(true); setMissing(false);
    const result = await api.users({ q: email.trim(), limit: 1 });
    setPending(false);
    const user = result.ok ? result.data.exact : null;
    if (!user || user.email.toLowerCase() !== email.trim().toLowerCase()) { setMissing(true); return; }
    onFound({ id: user.id, name: user.name, email: user.email, role: user.role });
  }
  return <Dialog open onOpenChange={details => { if (!details.open) onClose(); }}>
    <DialogContent size="sm">
      <form className="contents" onSubmit={event => { event.preventDefault(); void find(); }}>
        <DialogHeader title={t.addStaffTitle} />
        <DialogBody>
          <Field invalid={missing}><FieldLabel>{t.addStaffEmail}</FieldLabel>
            <Input type="email" value={email} autoFocus autoComplete="off" onChange={event => setEmail(event.currentTarget.value)} />
            <FieldError>{t.addStaffNotFound}</FieldError></Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" isLoading={pending} disabled={!email.includes('@')}>{t.addStaffFind}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
