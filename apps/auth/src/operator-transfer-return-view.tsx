import type { RefObject } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { TransferReturnEntry } from './operator-transfer-return';

const descriptions: Record<TransferReturnEntry, () => string> = {
  review: () => m.auth_transfer_return_review(),
  'saved-step': () => m.auth_transfer_recovery_saved(),
  'source-unknown': () => m.auth_transfer_recovery_source_unknown(),
  'source-acknowledged': () => m.auth_transfer_recovery_acknowledged(),
  'destination-accepted': () => m.auth_transfer_recovery_destination(),
  unreadable: () => m.auth_transfer_recovery_unreadable(),
};

export function OperatorTransferReturnView({
  entries,
  focusRef,
  onDismiss,
}: {
  entries: TransferReturnEntry[];
  focusRef?: RefObject<HTMLHeadingElement | null>;
  onDismiss: () => void;
}) {
  if (!entries.length) return null;
  return (
    <section aria-labelledby="transfer-return-heading" className="space-y-3 rounded-lg bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
      <h2
        id="transfer-return-heading"
        ref={focusRef}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        {m.auth_transfer_return_heading()}
      </h2>
      {entries.map((entry) => (
        <p key={entry}>{descriptions[entry]()}</p>
      ))}
      <p>{m.auth_transfer_return_separate()}</p>
      <Button type="button" variant="outline" onClick={onDismiss}>
        {m.auth_transfer_return_dismiss()}
      </Button>
    </section>
  );
}
