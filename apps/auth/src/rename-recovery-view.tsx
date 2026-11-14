import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { m } from './paraglide/messages.js';
import type { RenameHistory } from './rename-recovery';

/** Independent of current authority: these messages must never take private arguments. */
export function RenameRecoveryNotice({ history, observed = false }: { history: RenameHistory; observed?: boolean }) {
  if (history === 'none') return null;
  return (
    <div className="min-w-0 space-y-3">
      <Alert role="status" data-rename-history>
        <AlertDescription>
          {history === 'unknown' ? m.auth_rename_unknown() : m.auth_rename_acknowledged()}
        </AlertDescription>
      </Alert>
      {history === 'unknown' && observed ? (
        <Alert role="status">
          <AlertDescription>{m.auth_rename_observation()}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
