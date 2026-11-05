import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { subjectHref } from '../../subject/subject-href';
import type { VndbEffect } from './controller';
import type { VndbOutcome } from './contract';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_vndb_title()}</PageHeading>
      {children}
    </main>
  );
}

function outcomeLabel(status: string, kind: 'score' | 'entry-state') {
  if (status === 'applied') return m.library_bangumi_result_applied();
  if (status === 'skipped') return m.library_vndb_result_unchanged();
  if (status === 'stale') return m.library_bangumi_result_stale();
  if (status === 'unsupported') return m.library_bangumi_result_unsupported();
  if (status === 'failed') return m.library_vndb_result_rejected();
  if (status === 'unavailable' && kind === 'score') return m.library_vndb_score_result_unavailable();
  return m.library_vndb_result_uncertain();
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

export function VndbRemoved({ outcomes, effects }: { outcomes: VndbOutcome[]; effects: VndbEffect[] }) {
  const references = new Map(effects.map((effect) => [`${effect.ordinal}:${effect.kind}:${effect.reviewId}`, effect]));
  return (
    <section className="space-y-3" data-vndb-stage="removed" tabIndex={-1}>
      <p role="status">{m.library_bangumi_removed()}</p>
      {outcomes.length ? <p>{m.library_vndb_receipts_kept({ count: outcomes.length })}</p> : null}
      {outcomes.length ? (
        <ul className="space-y-2">
          {outcomes.map((outcome) => {
            const score = typeof outcome.scoreReviewId === 'string';
            const id = score ? outcome.scoreReviewId! : outcome.reviewId!;
            const kind = score ? 'score' : 'entry-state';
            const effect = references.get(`${outcome.ordinal}:${kind}:${id}`);
            return (
              <li key={`${outcome.ordinal}:${kind}:${id}`} className="break-words rounded-md border p-3 text-sm">
                <p>{m.library_vndb_effect_review_id({ id })}</p>
                <p>{outcomeLabel(outcome.status, kind)}</p>
                {effect?.targetId ? (
                  <a
                    href={subjectHref({ id: effect.targetId, label: '' }, getLocale()).href}
                    className="underline underline-offset-2"
                  >
                    {m.library_vndb_effect_target({ id: effect.targetId })}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_private_facts()}</p>
    </section>
  );
}
