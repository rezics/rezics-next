import type { Change } from './data';
import type { OwnerTransfer } from './owner-transfer';
import { GrantContents } from './grant-review';
import { m } from '../../paraglide/messages.js';

/** Inspection reads the retained command itself. Current grants cannot rewrite an unresolved intent. */
export function PendingAccessIntent({ intent }: { intent: Change | OwnerTransfer }) {
  return (
    <section className="min-w-0 space-y-3 rounded-lg border p-3">
      {intent.kind === 'realm-owner-transfer' ? (
        <p className="font-medium">{m.access_transfer_owner()}</p>
      ) : (
        <GrantContents kind={intent.kind} role={intent.role} actions={intent.actions} />
      )}
      <details className="min-w-0">
        <summary className="min-h-11 cursor-pointer content-center py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {m.access_identity_details()}
        </summary>
        <pre
          tabIndex={0}
          className="min-w-0 select-all whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs focus-visible:outline-2 focus-visible:outline-ring"
        >
          {JSON.stringify(intent, null, 2)}
        </pre>
      </details>
    </section>
  );
}
