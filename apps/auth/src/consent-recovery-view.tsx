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
import type { ConsentOutcome } from './consent-request-return';
import { m } from './paraglide/messages.js';

/** Generic notices never accept former account, client or permission details. */
export function ConsentRecoveryView({ outcome, dismiss }: { outcome: ConsentOutcome; dismiss: () => void }) {
  return (
    <>
      <p role="status">
        {outcome === 'unknown'
          ? m.auth_consent_history_unknown()
          : outcome === 'unattributed'
            ? m.auth_consent_history_unattributed()
            : outcome === 'acknowledged'
              ? m.auth_consent_history_acknowledged()
              : outcome === 'refused'
                ? m.auth_consent_history_refused()
                : m.auth_consent_declined()}
      </p>
      <p className="text-sm">{m.auth_consent_history_dismiss_explanation()}</p>
      <Button type="button" variant="outline" onClick={dismiss}>
        {m.auth_consent_history_dismiss()}
      </Button>
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
