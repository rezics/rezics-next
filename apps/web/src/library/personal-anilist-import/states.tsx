import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { AniListAction } from './controls';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_anilist_title()}</PageHeading>
      {children}
    </main>
  );
}

export function AniListPreparing() {
  return (
    <Shell>
      <p role="status">{m.library_anilist_preparing()}</p>
    </Shell>
  );
}

export function AniListSignedOut() {
  return (
    <Shell>
      <p role="status">{m.library_anilist_sign_in()}</p>
    </Shell>
  );
}

export function AniListUnavailable({ denied }: { denied?: boolean }) {
  return (
    <Shell>
      <p role="status">{denied ? m.library_anilist_denied() : m.library_anilist_unavailable()}</p>
    </Shell>
  );
}

export function AniListApplying({ applied, applying }: { applied: number; applying: number }) {
  return (
    <section className="space-y-3" data-anilist-stage="applying" aria-live="polite">
      <p role="status">{m.library_anilist_applying({ applied, applying })}</p>
    </section>
  );
}

export function AniListCancelledNotice({ onReturn }: { onReturn: () => void }) {
  const locale = getLocale();
  return (
    <section className="space-y-4" data-anilist-stage="cancelled">
      <p role="status">{m.library_anilist_canceled()}</p>
      <p>{m.library_anilist_stopped()}</p>
      <div className="flex flex-wrap gap-3">
        <AniListAction type="button" variant="outline" onClick={onReturn}>
          {m.library_anilist_return_review()}
        </AniListAction>
        <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
          {m.library_anilist_return_library()}
        </a>
      </div>
    </section>
  );
}

export function AniListRemovedNotice() {
  const locale = getLocale();
  return (
    <section className="space-y-4" data-anilist-stage="removed">
      <p role="status">{m.library_anilist_removed()}</p>
      <p className="text-sm text-muted-foreground">{m.library_anilist_erasure_limit()}</p>
      <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
        {m.library_anilist_return_library()}
      </a>
    </section>
  );
}
