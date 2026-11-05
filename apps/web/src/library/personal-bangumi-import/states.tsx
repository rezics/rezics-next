import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { BangumiAction } from './controls';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_bangumi_title()}</PageHeading>
      {children}
    </main>
  );
}

export function BangumiPreparing() {
  return (
    <Shell>
      <p role="status">{m.library_bangumi_preparing()}</p>
    </Shell>
  );
}

export function BangumiSignedOut() {
  return (
    <Shell>
      <p role="status">{m.library_bangumi_sign_in()}</p>
    </Shell>
  );
}

export function BangumiUnavailable({ denied }: { denied?: boolean }) {
  return (
    <Shell>
      <p role="status">{denied ? m.library_bangumi_denied() : m.library_bangumi_unavailable()}</p>
    </Shell>
  );
}

export function BangumiApplying({ applied, applying }: { applied: number; applying: number }) {
  return (
    <section className="space-y-3" data-bangumi-stage="applying" aria-live="polite">
      <p role="status">{m.library_bangumi_applying({ applied, applying })}</p>
    </section>
  );
}

export function BangumiCancelledNotice({ onReturn }: { onReturn: () => void }) {
  const locale = getLocale();
  return (
    <section className="space-y-4" data-bangumi-stage="cancelled">
      <p role="status">{m.library_bangumi_canceled()}</p>
      <p>{m.library_bangumi_stopped()}</p>
      <div className="flex flex-wrap gap-3">
        <BangumiAction type="button" variant="outline" onClick={onReturn}>
          {m.library_bangumi_return_review()}
        </BangumiAction>
        <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
          {m.library_bangumi_return_library()}
        </a>
      </div>
    </section>
  );
}

export function BangumiRemovedNotice() {
  const locale = getLocale();
  return (
    <section className="space-y-4" data-bangumi-stage="removed">
      <p role="status">{m.library_bangumi_removed()}</p>
      <p className="text-sm text-muted-foreground">{m.library_bangumi_erasure_limit()}</p>
      <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
        {m.library_bangumi_return_library()}
      </a>
    </section>
  );
}
