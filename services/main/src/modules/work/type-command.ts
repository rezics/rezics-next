import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission, setWorkTypes,
  StaleWorkHead, WorkEditUnavailable, workTypeEditDigest, type WorkEditReceipt } from './edit.ts';
import { checkedWorkTypes, WorkTypeConflict } from './type-schema.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

export interface WorkTypeInput {
  work: string; expectedHead: string; types: readonly string[];
  actingSubject: string; idempotencyKey: string;
}

/** Exact Work edit authority, one head CAS and a receipt for lost-response replay. */
export async function stateWorkType(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: WorkTypeInput): Promise<WorkEditReceipt> {
  const types = checkedWorkTypes(input.types);
  const digest = workTypeEditDigest(input.work, input.expectedHead, types);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest, principal); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let result: WorkEditReceipt | undefined;
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealMetadataWorkEditAdmission(env, admission);
      } else {
        try { result = await setWorkTypes(env, { admission, work: input.work,
          expectedHead: input.expectedHead, types }); }
        catch (error) { if (error instanceof IdempotencyConflict || error instanceof WorkTypeConflict) throw error; }
      }
    }
    const terminal = await readWorkEditTerminalReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
      || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('Work type receipt differs from admission');
    }
    if (terminal.outcome === 'cancelled') {
      if (terminal.reason === 'stale-head') throw new StaleWorkHead('expected Work head is stale');
      throw new WorkEditUnavailable('Work type command was cancelled');
    }
    if (terminal.work !== input.work || terminal.predecessor !== input.expectedHead) {
      throw new IdempotencyConflict('Work type receipt targets another Work');
    }
    return { work: terminal.work, revision: terminal.revision!, predecessor: terminal.predecessor,
      receipt: terminal.receipt, admissionId: registered.id, dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence, replayed: result?.replayed ?? true };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleWorkHead
      || error instanceof WorkTypeConflict
      || error instanceof WorkEditUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}
