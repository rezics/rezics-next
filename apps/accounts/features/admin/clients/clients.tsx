'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/table';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminClientEntry, ClientPage } from '../api/types.ts';
import { ErrorAlert, errorMessage, type Reauth, ReauthFields, TypedConfirmation } from '../actions/confirm.tsx';
import { DateOnly } from '../format.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { useStepUp } from '../shell/step-up.tsx';
import { CopyButton } from '../user/parts.tsx';
import { useTranslation } from '../../../i18n/client.ts';

type ClientAction = 'disable' | 'enable' | 'revoke' | 'install';
const cell = 'px-3 py-2.5 group-data-[density=compact]/admin:py-1';

function actionsFor(client: AdminClientEntry): ClientAction[] {
  return [client.disabled ? 'enable' : 'disable', client.installation?.state === 'active' ? 'revoke' : 'install'];
}

export function ClientsPage({ clients }: { clients: ClientPage }) {
  const { t } = useTranslation('admin');
  const { refresh } = useAdminClient();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [request, setRequest] = useState<{ action: ClientAction; client: AdminClientEntry } | null>(null);
  const toggle = (id: string) => setOpen(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <>
    <PageHeading title={t.clients} intro={t.clientsIntro} />
    {clients.items.length ? <Table className="min-w-[52rem]">
      <TableCaption className="sr-only">{t.clientsTable}</TableCaption>
      <TableHeader><TableRow>
        <TableHead scope="col" className="w-10 px-3"><span className="sr-only">{t.details}</span></TableHead>
        <TableHead scope="col" className="px-3">{t.columns.name}</TableHead>
        <TableHead scope="col" className="px-3">{t.columns.status}</TableHead>
        <TableHead scope="col" className="px-3">{t.installation}</TableHead>
        <TableHead scope="col" className="px-3">{t.scopes}</TableHead>
        <TableHead scope="col" className="px-3">{t.columns.created}</TableHead>
        <TableHead scope="col" className="w-12 px-3"><span className="sr-only">{t.actions.more}</span></TableHead>
      </TableRow></TableHeader>
      <TableBody>{clients.items.map(client => {
        const name = client.name ?? client.clientId;
        const expanded = open.has(client.clientId);
        const detailsId = `client-${client.clientId}`;
        return <Fragment key={client.clientId}>
          <TableRow>
            <TableCell className={cell}><Button variant="ghost" size="icon-sm" aria-expanded={expanded} aria-controls={detailsId}
              aria-label={t.clientDetails({ name })} onClick={() => toggle(client.clientId)}>
              {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}</Button></TableCell>
            <TableCell className={cell}><span className="flex flex-wrap items-center gap-1.5 font-medium">{name}
              <Badge variant="outline" size="sm">{t.clientType[client.type]}</Badge>
              {client.skipConsent ? <Badge variant="soft" size="sm">{t.firstParty}</Badge> : null}</span>
              <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">{client.clientId}
                <CopyButton value={client.clientId} label={t.clientId} /></span></TableCell>
            <TableCell className={cell}>{client.disabled ? <Badge variant="destructive" size="sm">{t.clientState.disabled}</Badge>
              : <Badge variant="success" size="sm">{t.clientState.enabled}</Badge>}</TableCell>
            <TableCell className={cell}>{client.installation ? <Badge variant={client.installation.state === 'active' ? 'outline' : 'warning'} size="sm">
              {(t.installationStates as Record<string, string>)[client.installation.state] ?? client.installation.state}</Badge>
              : <Badge variant="warning" size="sm">{t.installationStates.none}</Badge>}</TableCell>
            <TableCell className={`${cell} max-w-72 whitespace-normal`}><span className="line-clamp-2 font-mono text-xs text-muted-foreground">
              {(client.scopes ?? []).join(' ')}</span></TableCell>
            <TableCell className={`${cell} text-muted-foreground`}>{client.createdAt ? <DateOnly iso={client.createdAt} /> : '—'}</TableCell>
            <TableCell className={`${cell} text-end`}>
              <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value }) => setRequest({ action: value as ClientAction, client })}>
                <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t.rowActions({ name })}><EllipsisIcon aria-hidden="true" /></Button></MenuTrigger>
                <MenuContent className="min-w-56">{actionsFor(client).map(action => <MenuItem key={action} value={action}
                  variant={action === 'disable' || action === 'revoke' ? 'destructive' : 'default'}>
                  {{ disable: t.disableClient, enable: t.enableClient, revoke: t.revokeInstallation, install: t.reinstall }[action]}</MenuItem>)}
                </MenuContent>
              </Menu>
            </TableCell>
          </TableRow>
          {expanded ? <TableRow id={detailsId} className="bg-muted/30 hover:bg-muted/30">
            <TableCell colSpan={7} className="px-6 py-4 whitespace-normal">
              <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
                <div><dt className="text-muted-foreground">{t.redirectUris}</dt><dd><ul className="font-mono text-xs">
                  {client.redirectUris.map(uri => <li key={uri} className="break-all">{uri}</li>)}</ul></dd></div>
                <div><dt className="text-muted-foreground">{t.grantTypes}</dt><dd className="font-mono text-xs">{(client.grantTypes ?? []).join(', ')}</dd></div>
                <div><dt className="text-muted-foreground">{t.scopes}</dt><dd className="font-mono text-xs break-words">{(client.scopes ?? []).join(' ')}</dd></div>
                {client.installation ? <div><dt className="text-muted-foreground">{t.installation}</dt>
                  <dd className="text-xs"><span className="font-mono">{client.installation.id}</span> · <DateOnly iso={client.installation.installedAt} />
                    <span className="block font-mono">{client.installation.scopes.join(' ')}</span></dd></div> : null}
              </dl>
            </TableCell>
          </TableRow> : null}
        </Fragment>;
      })}</TableBody>
    </Table> : <p className="rounded-3xl border border-dashed border-border px-6 py-14 text-center text-muted-foreground">{t.clientsEmpty}</p>}
    {request ? <ClientDialog action={request.action} client={request.client} onClose={() => setRequest(null)}
      onDone={() => { setRequest(null); refresh(); }} /> : null}
  </>;
}

/** Disabling or revoking an App breaks it for everyone: type its name and
 * confirm with a password. Enabling and reinstalling need a reason only. */
function ClientDialog({ action, client, onClose, onDone }: { action: ClientAction; client: AdminClientEntry; onClose(): void; onDone(): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me } = useAdmin();
  const stepUp = useStepUp();
  const name = client.name ?? client.clientId;
  const high = action === 'disable' || action === 'revoke';
  const needsReason = action === 'disable' || action === 'enable';
  const [commandId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [reauth, setReauth] = useState<Reauth>({ password: '', totpCode: '' });
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = (needsReason && reason.trim().length < 3) || (high && (typed.trim() !== name || !reauth.password));
  async function submit() {
    setShowErrors(true);
    if (invalid) return;
    setPending(true); setError(null);
    if (high) {
      const confirmed = await api.reauthenticate(reauth.password, me.secondFactor ? reauth.totpCode : undefined);
      if (!confirmed.ok) { setPending(false); setError(confirmed.code === 'forbidden' ? t.stepUpFailed : errorMessage(confirmed, t)); return; }
    }
    const result = action === 'disable' || action === 'enable'
      ? await stepUp(() => api.setClient(client.clientId, { action, reason: reason.trim(), commandId }))
      : action === 'revoke' ? await stepUp(() => api.changeInstallation({ change: 'revoke', installationId: client.installation!.id }))
        : await stepUp(() => api.changeInstallation({ change: 'install', clientId: client.clientId, scopes: client.scopes ?? [], changeKey: commandId }));
    setPending(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    toast.success({ title: t.clientDone[action]({ name }) });
    onDone();
  }
  return <Dialog open role="alertdialog" onOpenChange={details => { if (!details.open && !pending) onClose(); }}
    closeOnInteractOutside={!pending} closeOnEscape={!pending}>
    <DialogContent size="md" showCloseButton={!pending}>
      <form className="contents" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
        <DialogHeader title={t.clientTitles[action]({ name })} description={t.clientConsequences[action]} />
        <DialogBody className="flex flex-col gap-4">
          {needsReason ? <Field invalid={showErrors && reason.trim().length < 3} disabled={pending} required>
            <FieldLabel>{t.reasonDetail}</FieldLabel>
            <Textarea value={reason} maxLength={1000} className="min-h-20" onChange={event => setReason(event.currentTarget.value)} />
            <FieldDescription>{t.reasonDetailHelp}</FieldDescription>
            <FieldError>{t.reasonTooShort}</FieldError>
          </Field> : null}
          {high ? <>
            <TypedConfirmation expected={name} value={typed} onChange={setTyped} disabled={pending} showError={showErrors} />
            <ReauthFields value={reauth} onChange={setReauth} secondFactor={me.secondFactor} disabled={pending} description={t.reauthHelp} />
          </> : null}
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" variant={high ? 'destructive' : 'default'} isLoading={pending}>
            {t.clientConfirm[action]}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
