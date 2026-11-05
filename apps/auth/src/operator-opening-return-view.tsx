import type { RefObject } from 'react';
import type { SessionProof } from '@rezics/auth-contract';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { OpeningReturnEntry } from './operator-opening-return';

function entryText(entry: OpeningReturnEntry): string {
  switch (entry) {
    case 'review':
      return m.auth_opening_return_review();
    case 'approval':
      return m.auth_opening_return_approval();
    case 'possibly-sent':
      return m.auth_opening_return_possible();
    case 'acknowledged':
      return m.auth_opening_return_acknowledged();
    case 'unconfirmed':
      return m.auth_opening_return_unknown();
    case 'refused':
      return m.auth_opening_return_refused();
  }
}

export function OpeningReturnHistoryView({
  entries,
  focusRef,
  dismiss,
}: {
  entries: readonly OpeningReturnEntry[];
  focusRef: RefObject<HTMLElement | null>;
  dismiss: () => void;
}) {
  if (!entries.length) return null;
  return (
    <section
      id="opening-return-history"
      ref={focusRef}
      aria-labelledby="opening-return-heading"
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground sm:p-5"
      role="status"
      tabIndex={-1}
    >
      <h2 id="opening-return-heading" className="font-semibold">
        {m.auth_opening_return_history_heading()}
      </h2>
      <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
        {entries.map((entry) => (
          <li key={entry}>{entryText(entry)}</li>
        ))}
      </ul>
      <Button variant="outline" onClick={dismiss}>
        {m.auth_opening_return_dismiss()}
      </Button>
    </section>
  );
}

export function OpeningCurrentSessionView({
  session,
  source,
  continueHref,
}: {
  session: SessionProof;
  source: 'opening-response' | 'session-readback';
  continueHref: string;
}) {
  return (
    <section role="status" className="space-y-3">
      <div>
        <h2 id="opening-current-state-heading" tabIndex={-1} className="font-semibold">
          {m.auth_opening_current()}
        </h2>
        <p className="text-sm text-muted-foreground">
          {source === 'session-readback' ? m.auth_opening_readback_note() : m.auth_opening_response_note()}
        </p>
        <dl>
          <dt>{m.auth_opening_subject()}</dt>
          <dd>{session.account_id}</dd>
          <dt>{m.auth_opening_method()}</dt>
          <dd>{session.amr.join(', ')}</dd>
          <dt>{m.auth_opening_scopes()}</dt>
          <dd>{session.scope.join(', ') || m.auth_opening_no_scopes()}</dd>
        </dl>
      </div>
      <a id="opening-safe-exit" className="underline underline-offset-4" href={continueHref}>
        {m.auth_opening_continue()}
      </a>
    </section>
  );
}
