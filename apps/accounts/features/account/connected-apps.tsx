'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/alert-dialog';
import { Button } from '@rezics/ui/button';
import { AppWindowIcon } from 'lucide-react';
import { useState } from 'react';
import { SectionHeading } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { useAccountClient } from '../api/account-client.tsx';
import { groupScopes } from '../consent/scopes.ts';
import { useTranslation } from '../../i18n/client.ts';

export interface ConnectedApp {
  consentId: string;
  name: string | null;
  logo: string | null;
  uri: string | null;
  scopes: string[];
  /** When access was given, already localized on the server. */
  since: string;
}

const groupTitles = { identity: 'groupIdentity', works: 'groupWorks', other: 'groupOther',
  offline: 'groupOffline' } as const;

export function ConnectedApps({ apps }: { apps: ConnectedApp[] }) {
  const { t } = useTranslation('account');
  const consent = useTranslation('consent').t;
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  // The dialog keeps naming its app while it animates closed.
  const [removing, setRemoving] = useState<ConnectedApp>();
  const [confirming, setConfirming] = useState(false);
  const ask = (app: ConnectedApp) => { setRemoving(app); setConfirming(true); };
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [removed, setRemoved] = useState(false);
  const label = (app: ConnectedApp) => app.name?.trim() || consent.unknownApp;

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setFailure('');
    const result = await api.removeAppAccess(removing.consentId);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) return setFailure(failureText(result.kind, common));
    setRemoved(true);
    refresh();
  }

  return <>
    <SectionHeading title={t.connectedApps} intro={t.appsIntro} />
    {removed ? <Alert role="status" variant="success" className="mb-4">
      <AlertDescription>{t.removed}</AlertDescription></Alert> : null}
    {failure ? <Alert role="alert" variant="destructive" className="mb-4">
      <AlertDescription>{failure}</AlertDescription></Alert> : null}
    {apps.length === 0
      ? <section className="flex flex-col items-center gap-3 rounded-3xl border border-border/60 bg-card px-6 py-12 text-center shadow-(--aura-shadow-card)">
        <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
          <AppWindowIcon className="size-6" aria-hidden="true" /></span>
        <h2 className="text-xl font-semibold">{t.appsEmptyTitle}</h2>
        <p className="max-w-md text-muted-foreground">{t.appsEmptyBody}</p>
      </section>
      : <ul className="flex flex-col gap-4">
        {apps.map(app => <li key={app.consentId}
          className="rounded-3xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) sm:p-6">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border/60 bg-accent text-accent-foreground">
              {app.logo ? <img src={app.logo} alt="" className="size-full object-cover" />
                : <AppWindowIcon className="size-6" aria-hidden="true" />}</span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold">{app.uri
                ? <a href={app.uri} target="_blank" rel="noreferrer" className="hover:underline">{label(app)}</a>
                : label(app)}</h2>
              <p className="text-sm text-muted-foreground">{t.accessSince({ date: app.since })}</p>
              <p className="mt-3 text-sm font-medium">{t.hasAccessTo}</p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {groupScopes(app.scopes).map(({ group }) => <li key={group}
                  className="rounded-full bg-secondary px-3 py-1 text-sm text-secondary-foreground">
                  {consent[groupTitles[group]]}</li>)}
              </ul>
            </div>
            <Button variant="outline" className="shrink-0 max-sm:hidden" onClick={() => ask(app)}>
              {t.removeAccess}</Button>
          </div>
          <Button variant="outline" className="mt-4 w-full sm:hidden" onClick={() => ask(app)}>
            {t.removeAccess}</Button>
        </li>)}
      </ul>}
    <AlertDialog open={confirming} onOpenChange={({ open }) => { if (!open && !busy) setConfirming(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{removing ? t.removeTitle({ app: label(removing) }) : null}</AlertDialogTitle>
          <AlertDialogDescription>{removing ? t.removeBody({ app: label(removing) }) : null}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => setConfirming(false)}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" isLoading={busy} onClick={() => void remove()}>{t.remove}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
