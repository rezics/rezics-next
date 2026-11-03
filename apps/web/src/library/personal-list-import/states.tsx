import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_vndb_title()}</PageHeading>
      {children}
    </main>
  );
}

export function VndbSignedOut() {
  return (
    <Shell>
      <p role="status">{m.library_bangumi_sign_in()}</p>
    </Shell>
  );
}

export function VndbUnavailable() {
  return (
    <Shell>
      <p role="status">{m.library_bangumi_unavailable()}</p>
    </Shell>
  );
}

export function VndbApplying({ applied, applying, total }: { applied: number; applying: number; total: number }) {
  return (
    <section className="space-y-3" data-vndb-stage="applying" tabIndex={-1} aria-live="polite">
      <p role="status">{m.library_vndb_applying({ applied, applying, total })}</p>
      <progress
        className="w-full"
        max={Math.max(total, 1)}
        value={applied}
        aria-label={m.library_vndb_progress_label()}
      />
    </section>
  );
}

export function VndbRemoved({ outcomes }: { outcomes: { ordinal: number; reviewId: string; status: string }[] }) {
  return (
    <section className="space-y-3" data-vndb-stage="removed" tabIndex={-1}>
      <p role="status">{m.library_bangumi_removed()}</p>
      {outcomes.length ? <p>{m.library_vndb_receipts_kept({ count: outcomes.length })}</p> : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_private_facts()}</p>
    </section>
  );
}
