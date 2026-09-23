import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { WorkActivationEnvironment } from './activate.ts';
import { sealMetadataWorkAdmission } from './seal.ts';

export interface WorkScopeRevocationProgress {
  scope: string;
  authorityEpoch: string;
  status: 'pending' | 'complete';
  pending: number;
}

/** One bounded reconciliation pass; rerun pending work after outages/restarts. */
export async function strongRevokeMetadataWorkScope(
  env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'strongCloseScope' | 'listUnsealed' | 'recordGraphOutcome'>,
  expectedEpoch: string,
): Promise<WorkScopeRevocationProgress> {
  const scope = 'work:create:root';
  const closed = await access.strongCloseScope(scope, expectedEpoch);
  const pending = await access.listUnsealed(scope, 100);
  for (const admission of pending) {
    try {
      const terminal = await sealMetadataWorkAdmission(env, admission);
      await access.recordGraphOutcome(admission.id, terminal);
    } catch {
      // The durable Access fence remains closed. A later pass must reconcile
      // this admission; neither a timeout nor missing receipt means cancelled.
    }
  }
  const current = await access.strongCloseScope(scope, closed.authorityEpoch);
  return { scope, authorityEpoch: current.authorityEpoch,
    status: current.pending === 0 ? 'complete' : 'pending', pending: current.pending };
}
