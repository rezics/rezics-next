import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { AuthButton as Button } from './button';
import type { ConsentDecision } from './consent';
import { m } from './paraglide/messages.js';

/** This summary deliberately accepts no account, client, permission or operation identifier. */
export function ConsentRecoveryView({
  state,
  history,
  uncertain,
  unattributedUncertain,
  pending,
  retry,
}: Pick<ConsentDecision, 'state' | 'history' | 'uncertain' | 'unattributedUncertain' | 'pending'> & {
  retry: () => void;
}) {
  const unknown = history === 'unknown' || uncertain;
  const hasHistory = unknown || unattributedUncertain || history === 'acknowledged';
  return (
    <>
      {pending ? <p role="status">{m.auth_consent_sending()}</p> : null}
      {unknown ? <p role="status">{m.auth_consent_history_unknown()}</p> : null}
      {unattributedUncertain ? <p role="status">{m.auth_consent_unattributed_submission()}</p> : null}
      {!unknown && history === 'acknowledged' && state !== 'approved' ? (
        <p role="status">{m.auth_consent_history_acknowledged()}</p>
      ) : null}
      {hasHistory ? <p>{m.auth_consent_history_next()}</p> : null}
      {!pending &&
      state !== 'loading' &&
      (hasHistory || state === 'failed' || state === 'not-found' || state === 'signed-out') ? (
        <Button type="button" variant="outline" onClick={retry}>
          {m.auth_consent_review_current()}
        </Button>
      ) : null}
    </>
  );
}

export function ConsentDepartureView({
  open,
  stay,
  leave,
  focus,
}: {
  open: boolean;
  stay: () => void;
  leave: () => void;
  focus: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) stay();
      }}
    >
      <AlertDialogContent
        finalFocus={() => {
          focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_consent_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>{m.auth_consent_departure_description()}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction onClick={leave}>{m.auth_organization_departure_leave()}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
