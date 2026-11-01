import { platformRegistry, profileDigest, validateProfile, type PresentationProfile } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import {
  CurationPublication,
  type ActiveCuration,
  type PublicationConfirmation,
  type PublicationRead,
} from './curation-publish';

export type ValidationCorrection = { describe: (pointer: string) => string; correct: (pointer: string) => void };

export function CurationFailureNotice({
  failure,
  correction,
}: {
  failure: Exclude<PublicationRead, { ok: true }>;
  correction?: ValidationCorrection | undefined;
}) {
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
        <ul className="space-y-3">
          {failure.errors.map(({ pointer, code }, index) => (
            <li key={index}>
              <p>{correction?.describe(pointer) ?? m.curation_correction_unknown()}</p>
              {correction && <Button onClick={() => correction.correct(pointer)}>{m.curation_correct()}</Button>}
              <details className="break-all text-sm">
                <summary>{m.curation_diagnostics()}</summary>
                <code>
                  {pointer || '/'} — {code}
                </code>
              </details>
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
  correction,
}: {
  publication: CurationPublication;
  profile: PresentationProfile;
  head: number;
  onPublished: (confirmation: PublicationConfirmation) => void;
  onReviewed: (active: ActiveCuration, choice: 'keep' | 'discard') => void;
  correction?: ValidationCorrection;
}) {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [publication]);
  const { intent, result, active, readFailure, busy } = useSyncExternalStore(
    publication.subscribe,
    publication.getSnapshot,
    publication.getSnapshot,
  );
  if (!intent && !result) return null;
  const stale = result?.ok === false && result.reason === 'stale';
  const invalid = result?.ok === false && result.reason === 'invalid';
  function reconcile(choice: 'keep' | 'discard') {
    if (!mounted.current) return;
    const reviewed = publication.reconcile(profile, choice);
    if (reviewed) onReviewed(reviewed, choice);
  }
  async function retry() {
    if (!mounted.current) return;
    const confirmation = await publication.retry();
    if (mounted.current && confirmation) onPublished(confirmation);
  }
  return (
    <section
      aria-label={m.curation_recovery()}
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      aria-busy={busy}
    >
      {result?.ok ? (
        <>
          <p role="status">{m.presentation_editor_published()}</p>
          <details className="text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_publication_details()}</summary>
            <p className="mt-2 break-all font-mono">
              {m.presentation_editor_version_reference({ head: result.head, digest: result.digest })}
            </p>
          </details>
        </>
      ) : null}
      {result?.ok === false ? <CurationFailureNotice failure={result} correction={correction} /> : null}
      {intent ? (
        <>
          <p>
            {invalid
              ? m.curation_invalid_retained()
              : stale
                ? m.presentation_editor_publication_stale()
                : m.presentation_editor_publication_pending()}
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_publication_details()}</summary>
            <p className="mt-2 break-all font-mono">
              {m.presentation_editor_version_reference({
                head: intent.expectedHead,
                digest: profileDigest(intent.profile),
              })}
            </p>
          </details>
          <div className="flex flex-wrap gap-3">
            {!invalid && (
              <Button
                variant="outline"
                className="min-h-11 whitespace-normal"
                disabled={busy}
                onClick={() => void retry()}
              >
                {m.curation_retry_original()}
              </Button>
            )}
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
                variant="outline"
                disabled={
                  busy ||
                  validateProfile(platformRegistry, profile).length > 0 ||
                  profileDigest(profile) === profileDigest(intent.profile)
                }
                onClick={async () => {
                  if (!mounted.current) return;
                  const confirmation = await publication.replaceInvalid(profile, head);
                  if (mounted.current && confirmation) onPublished(confirmation);
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
          <details className="text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_active_version_details()}</summary>
            <p className="mt-2 break-all font-mono">
              {m.curation_actual_head({ head: active.head, digest: active.digest })}
            </p>
          </details>
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
