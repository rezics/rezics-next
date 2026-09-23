import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { WorkActivationEnvironment } from './activate.ts';
import { sealMetadataWorkEditAdmission } from './edit.ts';
import { sealMetadataWorkAdmission } from './seal.ts';
import { sealTextContributionAdmission } from '../contribution/draft.ts';
import { sealTextContributionEditAdmission } from '../contribution/edit.ts';

export interface WorkScopeRevocationProgress {
  scope: string;
  authorityEpoch: string;
  status: 'pending' | 'complete';
  pending: number;
}

export interface WorkPrincipalRevocationProgress {
  principalId: string;
  enforcementEpoch: string;
  status: 'pending' | 'complete';
  pending: number;
}

/** One bounded reconciliation pass; rerun pending work after outages/restarts. */
export async function strongRevokeWorkScope(
  env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'strongCloseScope' | 'listUnsealed' | 'recordGraphOutcome'>,
  scope: string,
  expectedEpoch: string,
): Promise<WorkScopeRevocationProgress> {
  const closed = await access.strongCloseScope(scope, expectedEpoch);
  const pending = await access.listUnsealed(scope, 100);
  for (const admission of pending) {
    try {
      const terminal = admission.action === 'work.create'
        ? await sealMetadataWorkAdmission(env, admission)
        : admission.action === 'work.edit'
          ? await sealMetadataWorkEditAdmission(env, admission)
          : admission.action === 'contribution.create'
            ? await sealTextContributionAdmission(env, admission)
            : admission.action === 'contribution.edit'
              ? await sealTextContributionEditAdmission(env, admission)
          : null;
      if (!terminal) throw new Error('unsupported Work admission action');
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

export function strongRevokeMetadataWorkScope(
  env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'strongCloseScope' | 'listUnsealed' | 'recordGraphOutcome'>,
  expectedEpoch: string,
): Promise<WorkScopeRevocationProgress> {
  return strongRevokeWorkScope(env, access, 'work:create:root', expectedEpoch);
}

/** Fence one principal across Work scopes, then settle a bounded page. */
export async function strongRevokeWorkPrincipal(
  env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry,
    'strongDeactivatePrincipal' | 'listUnsealedPrincipal' | 'recordGraphOutcome'>,
  principalId: string,
  expectedEpoch: string,
): Promise<WorkPrincipalRevocationProgress> {
  const fenced = await access.strongDeactivatePrincipal(principalId, expectedEpoch);
  const pending = await access.listUnsealedPrincipal(principalId, 100);
  for (const admission of pending) {
    try {
      const terminal = admission.action === 'work.create'
        ? await sealMetadataWorkAdmission(env, admission)
        : admission.action === 'work.edit'
          ? await sealMetadataWorkEditAdmission(env, admission)
          : admission.action === 'contribution.create'
            ? await sealTextContributionAdmission(env, admission)
            : admission.action === 'contribution.edit'
              ? await sealTextContributionEditAdmission(env, admission)
          : null;
      if (!terminal) throw new Error('unsupported Work admission action');
      await access.recordGraphOutcome(admission.id, terminal);
    } catch {
      // The principal remains inactive. Retry under the durable fence after
      // any unknown graph update or unavailable owner is reconciled.
    }
  }
  const current = await access.strongDeactivatePrincipal(principalId, fenced.enforcementEpoch);
  return { principalId, enforcementEpoch: current.enforcementEpoch,
    status: current.pending === 0 ? 'complete' : 'pending', pending: current.pending };
}
