import { useLocation } from '@tanstack/react-router';
import { useMemo } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { useRecoveryLifetime } from '../recovery-lifetime';

export type RecoveryVisit = {
  subject: string;
  csrfToken: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};

/** Collection recovery retains its own controller and exact original command operands. */
export function useRecoveryVisit(): RecoveryVisit | null {
  const location = useLocation();
  const scope = useRecoveryLifetime(location.pathname + location.searchStr, getLocale());
  return useMemo(() => {
    if (!scope.subject || !scope.csrfToken) return null;
    const controller = new AbortController();
    scope.onRetire(() => controller.abort());
    return {
      subject: scope.subject,
      csrfToken: scope.csrfToken,
      controller,
      current: (signal?: AbortSignal) => scope.current() && !controller.signal.aborted && !signal?.aborted,
      retire: () => {
        controller.abort();
        scope.retire();
      },
    };
  }, [scope]);
}
