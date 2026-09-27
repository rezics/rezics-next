'use client';

import { Button } from '@rezics/ui/button';
import { useAccountClient } from '../../api/account-client.tsx';
import { Brand } from '../../shell/brand.tsx';
import { signInHref, StatePanel } from '../../shell/state-panel.tsx';
import { useTranslation } from '../../../i18n/client.ts';

export type GateStatus = 'signed-out' | 'forbidden' | 'unavailable';

/** Before the panel: signed out, not an operator, or the service is down. */
export function AdminGate({ status, next }: { status: GateStatus; next: string }) {
  const { t } = useTranslation('admin');
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="flex h-16 items-center border-b border-border/60 px-4 sm:px-6">
      <Brand label={t.panelHome} product={t.productName} href="/admin" /></header>
    <main className="grid flex-1 place-items-center px-4 py-10">
      {status === 'signed-out' ? <StatePanel icon="signedOut" headingLevel={1} className="w-full max-w-lg"
        title={common.signedOutTitle} body={common.signedOutBody}
        action={<Button asChild size="lg"><a href={signInHref(next)}>{common.signIn}</a></Button>} />
        : status === 'forbidden' ? <StatePanel icon="stale" headingLevel={1} className="w-full max-w-lg"
          title={t.forbiddenTitle} body={t.forbiddenBody}
          action={<Button asChild variant="outline" size="lg"><a href="/">{t.backToAccount}</a></Button>} />
          : <StatePanel icon="unavailable" headingLevel={1} className="w-full max-w-lg"
            title={common.unavailableTitle} body={common.unavailableBody}
            action={<Button variant="outline" size="lg" onClick={refresh}>{common.retry}</Button>} />}
    </main>
  </div>;
}

/** Inside the panel: the operator's role lacks this section's permission. */
export function NoPermission() {
  const { t } = useTranslation('admin');
  return <StatePanel icon="stale" headingLevel={1} title={t.noPermissionTitle} body={t.noPermissionBody} />;
}

/** Inside the panel: a read failed. */
export function Unavailable({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return <StatePanel icon="unavailable" headingLevel={headingLevel} title={common.unavailableTitle} body={common.unavailableBody}
    action={<Button variant="outline" size="lg" onClick={refresh}>{common.retry}</Button>} />;
}

/** A page heading with an optional intro and actions on the right. */
export function PageHeading({ title, intro, actions }: { title: string; intro?: string; actions?: React.ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 group-data-[density=compact]/admin:mb-4">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight md:text-[28px]">{title}</h1>
      {intro ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground md:text-base">{intro}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </header>;
}
