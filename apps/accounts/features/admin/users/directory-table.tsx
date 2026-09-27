'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { Skeleton } from '@rezics/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/table';
import { cn } from '@rezics/ui/utils';
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon, EllipsisIcon, MinusIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AdminAction, AdminUser, DirectoryColumn } from '../api/types.ts';
import { availableActions, type ActionTarget } from '../actions/actions.ts';
import { RoleBadge, StatusBadge } from '../badges.tsx';
import { DateOnly, Time } from '../format.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { userHref } from '../audit/entry.tsx';
import { UserAvatar } from '../../shell/user-avatar.tsx';
import { type Direction, type SortKey, sortable } from './state.ts';
import { useTranslation } from '../../../i18n/client.ts';

export const toTarget = (user: AdminUser): ActionTarget => ({ id: user.id, name: user.name, email: user.email, status: user.status,
  emailVerified: user.emailVerified, role: user.role });

function SelectBox({ checked, indeterminate, label, onChange }: { checked: boolean; indeterminate?: boolean; label: string;
  onChange(checked: boolean): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  // A native checkbox: it takes an accessible name without visible text.
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} onChange={event => onChange(event.currentTarget.checked)}
    className="size-4 cursor-pointer rounded accent-primary align-middle outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32" />;
}

const cellPadding = 'px-3 py-2.5 group-data-[density=compact]/admin:py-1';

/** The directory as a real table: sortable headers with aria-sort, a row per
 * user with selection and quick actions, skeleton rows that keep the columns. */
export function DirectoryTable({ users, columns, loading, sort, direction, onSort, selected, onSelect, active, onActive, onAction }: {
  users: AdminUser[] | null; columns: readonly DirectoryColumn[]; loading: boolean; sort: SortKey; direction: Direction;
  onSort(sort: SortKey): void; selected: ReadonlySet<string>; onSelect(ids: string[], selected: boolean): void; active: number;
  onActive(index: number): void; onAction(action: AdminAction, user: AdminUser): void }) {
  const { t } = useTranslation('admin');
  const { me } = useAdmin();
  const all = users?.length ? users.every(user => selected.has(user.id)) : false;
  const some = !!users?.some(user => selected.has(user.id));
  const header = (column: DirectoryColumn) => {
    const key = sortable[column];
    const label = t.columns[column];
    if (!key) return <TableHead key={column} scope="col" className="px-3">{label}</TableHead>;
    const current = key === sort;
    const Icon = !current ? ArrowUpDownIcon : direction === 'asc' ? ArrowUpIcon : ArrowDownIcon;
    return <TableHead key={column} scope="col" className="px-3" aria-sort={current ? direction === 'asc' ? 'ascending' : 'descending' : undefined}>
      <button type="button" onClick={() => onSort(key)} title={t.sortBy({ column: label })}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/32">
        {label}<Icon aria-hidden="true" className={cn('size-3.5', current ? 'text-foreground' : 'text-muted-foreground/70')} /></button>
    </TableHead>;
  };
  const cell = (column: DirectoryColumn, user: AdminUser, index: number) => {
    switch (column) {
      case 'name': return <TableCell key={column} className={cn(cellPadding, 'max-w-72')}>
        <div className="flex items-center gap-3">
          <UserAvatar user={user} size="sm" className="group-data-[density=compact]/admin:hidden" />
          <div className="min-w-0">
            <a href={userHref(user.id)} data-row-link={index} onFocus={() => onActive(index)}
              className="block truncate font-medium outline-none hover:underline focus-visible:underline">{user.name || user.email}</a>
            {columns.includes('email') ? null : <span className="block truncate text-xs text-muted-foreground">{user.email}</span>}
          </div>
        </div></TableCell>;
      case 'email': return <TableCell key={column} className={cn(cellPadding, 'max-w-64 truncate text-muted-foreground')}>{user.email}</TableCell>;
      case 'status': return <TableCell key={column} className={cellPadding}><StatusBadge status={user.status} />
        {user.status === 'suspended' && user.suspendedUntil ? <span className="block text-xs text-muted-foreground">
          {t.queues.until} <DateOnly iso={user.suspendedUntil} /></span> : null}</TableCell>;
      case 'role': return <TableCell key={column} className={cellPadding}>{user.role ? <RoleBadge role={user.role} />
        : <span className="text-muted-foreground">—</span>}</TableCell>;
      case 'verified': return <TableCell key={column} className={cellPadding}>{user.emailVerified
        ? <span className="inline-flex items-center gap-1 text-success-foreground"><CheckIcon className="size-4" aria-hidden="true" />{t.verified}</span>
        : <span className="inline-flex items-center gap-1 text-warning-foreground"><MinusIcon className="size-4" aria-hidden="true" />{t.unverified}</span>}</TableCell>;
      case 'twoFactor': return <TableCell key={column} className={cn(cellPadding, 'text-muted-foreground')}>
        {user.twoFactorEnabled ? t.twoFactorOn : t.twoFactorOff}</TableCell>;
      case 'created': return <TableCell key={column} className={cn(cellPadding, 'text-muted-foreground')}><DateOnly iso={user.createdAt} /></TableCell>;
      case 'lastSignIn': return <TableCell key={column} className={cn(cellPadding, 'text-muted-foreground')}>
        {user.lastSignInAt ? <Time iso={user.lastSignInAt} /> : t.never}</TableCell>;
    }
  };
  return <Table aria-busy={loading} className="min-w-[44rem]">
    <TableCaption className="sr-only">{t.users}</TableCaption>
    <TableHeader><TableRow>
      <TableHead scope="col" className="w-10 ps-4"><SelectBox checked={all} indeterminate={some && !all} label={t.selectAll}
        onChange={value => onSelect((users ?? []).map(user => user.id), value)} /></TableHead>
      {columns.map(header)}
      <TableHead scope="col" className="w-12"><span className="sr-only">{t.actions.more}</span></TableHead>
    </TableRow></TableHeader>
    <TableBody className={cn('transition-opacity', loading && users ? 'opacity-60' : null)}>
      {users ? users.map((user, index) => {
        const actions = availableActions(toTarget(user), me);
        const label = user.name || user.email;
        return <TableRow key={user.id} data-state={selected.has(user.id) ? 'selected' : undefined} data-active={index === active || undefined}
          onClick={event => { if (!(event.target as HTMLElement).closest('a,button,input')) onActive(index); }}
          className="data-active:shadow-[inset_3px_0_0_var(--color-primary)]">
          <TableCell className={cn(cellPadding, 'ps-4')}><SelectBox checked={selected.has(user.id)} label={t.selectUser({ name: label })}
            onChange={value => onSelect([user.id], value)} /></TableCell>
          {columns.map(column => cell(column, user, index))}
          <TableCell className={cn(cellPadding, 'pe-3 text-end')}>
            {actions.length ? <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => onAction(value as AdminAction, user)}>
              <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t.rowActions({ name: label })}>
                <EllipsisIcon aria-hidden="true" /></Button></MenuTrigger>
              <MenuContent className="min-w-56">
                {actions.map(action => <MenuItem key={action} value={action}
                  variant={action === 'suspend' || action === 'require-password-reset' ? 'destructive' : 'default'}>{t.actions[action]}</MenuItem>)}
              </MenuContent>
            </Menu> : null}
          </TableCell>
        </TableRow>;
      }) : Array.from({ length: 8 }, (_, row) => <TableRow key={row} aria-hidden="true">
        <TableCell className={cn(cellPadding, 'ps-4')}><Skeleton className="size-4 rounded" /></TableCell>
        {columns.map(column => <TableCell key={column} className={cellPadding}>
          {column === 'name' ? <div className="flex items-center gap-3"><Skeleton className="size-8 rounded-full group-data-[density=compact]/admin:hidden" />
            <Skeleton className="h-4 w-32" /></div> : <Skeleton className={cn('h-4', column === 'email' ? 'w-44' : 'w-20')} />}
        </TableCell>)}
        <TableCell className={cellPadding} />
      </TableRow>)}
    </TableBody>
  </Table>;
}
