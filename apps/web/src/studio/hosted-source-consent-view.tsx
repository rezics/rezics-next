import { useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { HostedSourceConsentVisit } from './hosted-source-consent';

/** The surrounding review owns the saved body and exact tuple. Receipts and command keys stay private. */
export function HostedSourceConsentView({
  visit,
  bookTitle,
  locale,
  disabled = false,
}: {
  visit: HostedSourceConsentVisit;
  bookTitle: string;
  locale: Locale;
  disabled?: boolean;
}) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale };
  if (state.kind !== 'active') return null;
  const busy = state.phase === 'working';
  const unknown = state.phase === 'uncertain';
  return (
    <section className="studio-stack" aria-label={m.studio_source_consent_heading({}, options)} aria-busy={busy}>
      <h3>{m.studio_source_consent_heading({}, options)}</h3>
      <p className="break-words">{m.studio_source_consent_book({ title: bookTitle }, options)}</p>
      <p>{m.studio_source_consent_scope({}, options)}</p>
      <p className="studio-help">{m.studio_source_consent_public({}, options)}</p>
      <p className="studio-help">{m.studio_source_consent_independent({}, options)}</p>
      <div aria-live="polite" aria-atomic="true">
        {state.phase === 'unknown' ? <p role="status">{m.studio_source_consent_unknown({}, options)}</p> : null}
        {busy ? (
          <p role="status">
            {state.operation === 'revoke'
              ? m.studio_source_consent_revoking({}, options)
              : m.studio_source_consent_issuing({}, options)}
          </p>
        ) : null}
        {state.phase === 'issued' ? <p role="status">{m.studio_source_consent_issued({}, options)}</p> : null}
        {state.phase === 'revoked' ? <p role="status">{m.studio_source_consent_revoked({}, options)}</p> : null}
        {unknown ? (
          <p role="alert">
            {state.operation === 'revoke'
              ? m.studio_source_consent_revoke_uncertain({}, options)
              : m.studio_source_consent_issue_uncertain({}, options)}
          </p>
        ) : null}
        {state.phase === 'denied' ? <p role="alert">{m.studio_source_consent_denied({}, options)}</p> : null}
        {state.phase === 'failed' ? (
          <p role="alert">
            {state.failure === 'stale'
              ? m.studio_source_consent_stale({}, options)
              : state.failure === 'unavailable'
                ? m.studio_source_consent_unavailable({}, options)
                : m.studio_source_consent_failed({}, options)}
          </p>
        ) : null}
      </div>
      <div className="studio-action-row">
        {unknown ? (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => void visit.replay()}>
            {m.studio_source_consent_replay({}, options)}
          </Button>
        ) : state.phase === 'issued' ? (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => void visit.revoke()}>
            {m.studio_source_consent_revoke({}, options)}
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void visit.issue()}>
            {m.studio_source_consent_issue({}, options)}
          </Button>
        )}
      </div>
      {state.phase === 'issued' ? (
        <p className="studio-help">{m.studio_source_consent_revoke_help({}, options)}</p>
      ) : null}
    </section>
  );
}
