import type { PresentationProfile } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import {
  CurationPublication,
  type ActiveCuration,
  type PublicationConfirmation,
  type PublicationRead,
} from './curation-publish';

export function CurationFailureNotice({ failure }: { failure: Exclude<PublicationRead, { ok: true }> }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
      <p>
        {failure.reason === 'invalid'
          ? m.curation_invalid()
          : failure.reason === 'stale'
            ? m.curation_stale()
            : failure.reason === 'forbidden' || failure.reason === 'signed-out'
              ? m.curation_forbidden()
              : failure.reason === 'rate-limited'
                ? m.curation_limited()
                : failure.reason === 'unavailable' && failure.outcome === 'unknown'
                  ? m.curation_unknown()
                  : m.curation_unavailable()}
      </p>
      {failure.reason === 'unavailable' && failure.phase === 'activate' ? <p>{m.curation_partial()}</p> : null}
      {failure.reason === 'rate-limited' && failure.retryAfter !== undefined ? (
        <p>{m.curation_retry_after({ seconds: failure.retryAfter })}</p>
      ) : null}
      {failure.reason === 'invalid' ? (
        <ul className="list-disc break-all ps-5">
          {failure.errors.map(({ pointer, code }, index) => (
            <li key={index}>
              <code>
                {pointer || '/'} — {code}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Publication recovery consumes the editor's draft, without owning document selection or edits. */
export function CurationPublicationRecovery({
  publication,
  profile,
  head,
  onPublished,
  onReviewed,
}: {
  publication: CurationPublication;
  profile: PresentationProfile;
  head: number;
  onPublished: (confirmation: PublicationConfirmation) => void;
  onReviewed: (active: ActiveCuration, choice: 'keep' | 'discard') => void;
}) {
  const { intent, result, active, readFailure, busy } = useSyncExternalStore(
    publication.subscribe,
    publication.getSnapshot,
    publication.getSnapshot,
  );
  if (!intent && !result) return null;
  const stale = result?.ok === false && result.reason === 'stale';
  function reconcile(choice: 'keep' | 'discard') {
    const reviewed = publication.reconcile(profile, choice);
    if (reviewed) onReviewed(reviewed, choice);
  }
  async function retry() {
    const confirmation = await publication.retry();
    if (confirmation) onPublished(confirmation);
  }
  return (
    <section
      aria-label={m.curation_recovery()}
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      aria-busy={busy}
    >
      {result?.ok ? <p role="status">{m.curation_published({ head: result.head })}</p> : null}
      {result?.ok === false ? <CurationFailureNotice failure={result} /> : null}
      {intent ? (
        <>
          <p>{m.curation_retained({ head: intent.expectedHead })}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              className="min-h-11 whitespace-normal"
              disabled={busy}
              onClick={() => void retry()}
            >
              {m.curation_retry_original()}
            </Button>
            <Button
              variant="outline"
              className="min-h-11 whitespace-normal"
              disabled={busy}
              onClick={() => void publication.inspect()}
            >
              {m.curation_reload_head()}
            </Button>
            {result?.ok === false && result.reason === 'invalid' ? (
              <Button
                className="min-h-11 whitespace-normal"
                disabled={busy}
                onClick={async () => {
                  const confirmation = await publication.replaceInvalid(profile, head);
                  if (confirmation) onPublished(confirmation);
                }}
              >
                {m.curation_new_intent()}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {readFailure ? <CurationFailureNotice failure={readFailure} /> : null}
      {active ? (
        <div className="space-y-3">
          <p className="break-all">{m.curation_actual_head({ head: active.head, digest: active.digest })}</p>
          <details className="space-y-3">
            <summary className="cursor-pointer">{m.curation_compare()}</summary>
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <section className="min-w-0">
                <h3 className="font-semibold">{m.curation_draft()}</h3>
                <pre className="max-h-80 overflow-auto text-xs">{JSON.stringify(profile, null, 2)}</pre>
              </section>
              <section className="min-w-0">
                <h3 className="font-semibold">{m.curation_active()}</h3>
                <pre className="max-h-80 overflow-auto text-xs">{JSON.stringify(active.profile, null, 2)}</pre>
              </section>
            </div>
          </details>
          {stale ? (
            <>
              <p>{m.curation_review_help()}</p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  className="min-h-11 whitespace-normal"
                  disabled={busy}
                  onClick={() => reconcile('discard')}
                >
                  {m.curation_discard()}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11 whitespace-normal"
                  disabled={busy}
                  onClick={() => reconcile('keep')}
                >
                  {m.curation_reconcile()}
                </Button>
              </div>
            </>
          ) : (
            <p>{m.curation_resolve_first()}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
