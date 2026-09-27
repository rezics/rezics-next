'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/alert-dialog';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { AppWindowIcon, BadgeCheckIcon, CheckIcon } from 'lucide-react';
import { useState } from 'react';
import { SectionHeading } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface ConnectedAppView {
  clientId: string;
  name: string;
  uri: string | null;
  icon: string | null;
  /** A REZICS app, trusted without a consent screen. */
  trusted: boolean;
  /** REZICS withdrew the App; it can no longer be used, and its access can still be removed. */
  withdrawn: boolean;
  /** What it may do, in the page's language. */
  permissions: string[];
  /** Dates already localized on the server. */
  granted: string;
  lastUsed: string | null;
}

export function ConnectedApps({ apps }: { apps: ConnectedAppView[] }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  // The dialog keeps naming its app while it animates closed.
  const [removing, setRemoving] = useState<ConnectedAppView>();
  const [confirming, setConfirming] = useState(false);
  const ask = (app: ConnectedAppView) => { setRemoving(app); setConfirming(true); };
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [removed, setRemoved] = useState(false);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setFailure('');
    setRemoved(false);
    setConfirming(false);
    const result = await stepUp(() => api.revokeApp(removing.clientId));
    setBusy(false);
    if (result.ok) { setRemoved(true); return refresh(); }
    if (result.kind !== 'cancelled') setFailure(failureText(result.kind, common));
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
        {apps.map(app => <li key={app.clientId}
          className="rounded-3xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) sm:p-6">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border/60 bg-accent text-accent-foreground">
              {app.icon ? <img src={app.icon} alt="" className="size-full object-cover" />
                : <AppWindowIcon className="size-6" aria-hidden="true" />}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="truncate text-lg font-semibold">{app.uri
                  ? <a href={app.uri} target="_blank" rel="noreferrer" className="hover:underline">{app.name}</a>
                  : app.name}</h2>
                {app.trusted ? <Badge variant="info" className="text-info-foreground">
                  <BadgeCheckIcon aria-hidden="true" />{t.rezicsApp}</Badge> : null}
                {app.withdrawn ? <Badge variant="secondary">{t.appWithdrawn}</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">{t.accessSince({ date: app.granted })} · {app.lastUsed
                ? t.appLastUsed({ time: app.lastUsed }) : t.appNotUsed}</p>
              <p className="mt-3 text-sm font-medium">{t.hasAccessTo}</p>
              <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                {app.permissions.map(permission => <li key={permission} className="flex gap-2">
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />{permission}</li>)}
              </ul>
              {app.trusted ? <p className="mt-3 text-sm text-muted-foreground">{t.trustedAppNote}</p> : null}
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
          <AlertDialogTitle>{removing ? t.removeTitle({ app: removing.name }) : null}</AlertDialogTitle>
          <AlertDialogDescription>{removing ? removing.trusted ? t.removeTrustedBody({ app: removing.name })
            : t.removeBody({ app: removing.name }) : null}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => setConfirming(false)}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" isLoading={busy} onClick={() => void remove()}>{t.remove}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
