import { AdmissionUnavailable } from '../../src/modules/access/admission.ts';

/** Reads, catalogue search and readiness share this gate with admissions.
 * A closed or missing fence refuses; an open fence continues. */
export function recoveryAccess(fence: { open?: boolean } = { open: true }) {
  return {
    async assertRecoveryOpen(): Promise<void> {
      if (fence.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
    },
  };
}
