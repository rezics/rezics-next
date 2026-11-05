import type { usePrivateReportOrigin } from '../private-report-current-origin';
import type { ConsolidationEnvelope } from './visit';

type Origin = ReturnType<typeof usePrivateReportOrigin>['origin'];

/** Bind to the actual private reader, including synchronous viewer/address/exposure retirement. */
export function consolidationEnvelope(
  origin: Origin,
  isCurrent: () => boolean,
  subscribeReader: (notify: () => void) => () => void,
): ConsolidationEnvelope {
  return {
    capture() {
      // Native consolidation operations all use personal_library. Capture anew for every dispatch.
      const admitted = origin.capture('personal_library', 'library_label.assignment_list');
      const current = () => isCurrent() && admitted();
      const token = origin.read().csrfToken;
      if (!current() || !token.trim()) return null;
      return { headers: { 'x-csrf-token': token }, isCurrent: current };
    },
    subscribeRetirement(retire) {
      const check = () => {
        if (!isCurrent()) retire();
      };
      const release = origin.watch(check);
      const reader = subscribeReader(check);
      check();
      return () => {
        release();
        reader();
      };
    },
  };
}
