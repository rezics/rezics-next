import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { TransferRecoveryKind } from './operator-transfer-recovery';

const descriptions: Record<Exclude<TransferRecoveryKind, 'none'>, () => string> = {
  'saved-step': () => m.auth_transfer_recovery_saved(),
  'source-unknown': () => m.auth_transfer_recovery_source_unknown(),
  'source-acknowledged': () => m.auth_transfer_recovery_acknowledged(),
  'source-acknowledged-conflict': () => m.auth_transfer_recovery_readback_changed(),
  'destination-accepted': () => m.auth_transfer_recovery_destination(),
  unreadable: () => m.auth_transfer_recovery_unreadable(),
};

export function OperatorTransferRecoveryView({
  kind,
  pending,
  authorityRetired,
  readUnavailable,
  observed,
  canReview,
  onReview,
}: {
  kind: TransferRecoveryKind;
  pending: boolean;
  authorityRetired: boolean;
  readUnavailable: boolean;
  observed: boolean;
  canReview: boolean;
  onReview: () => void;
}) {
  if (kind === 'none') return null;
  return (
    <section aria-labelledby="transfer-recovery-heading" className="space-y-2" role="status">
      <h2 id="transfer-recovery-heading">{m.auth_transfer_recovery_heading()}</h2>
      <p>{descriptions[kind]()}</p>
      {authorityRetired ? <p>{m.auth_transfer_recovery_authority()}</p> : null}
      {pending ? <p role="status">{m.auth_transfer_recovery_pending()}</p> : null}
      {readUnavailable ? <p role="alert">{m.auth_transfer_recovery_unavailable()}</p> : null}
      {observed ? <p>{m.auth_transfer_recovery_observed()}</p> : null}
      {canReview ? (
        <Button variant="outline" disabled={pending} aria-busy={pending} onClick={onReview}>
          {readUnavailable ? m.auth_transfer_recovery_retry() : m.auth_transfer_recovery_review()}
        </Button>
      ) : null}
      <p>
        <a href="/security">{m.auth_transfer_recovery_return()}</a>
      </p>
    </section>
  );
}
