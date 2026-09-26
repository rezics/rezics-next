import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { changeTitleControl, TitleControlInvalid, type TitleControlBasis } from './title-control.ts';
import { GRAPHS, RV, iri } from './activate.ts';
import { editMetadataWork, metadataWorkEditDigest, readWorkEditTerminalReceipt,
  sealMetadataWorkEditAdmission, StaleWorkHead, WorkEditUnavailable,
  type TerminalWorkEdit, type WorkEditReceipt } from './edit.ts';

export interface AdmittedMetadataEditInput {
  work: string;
  expectedHead: string;
  title: string;
  actingSubject: string;
  idempotencyKey: string;
  titleControl?: TitleControlBasis;
}

function checkedResult(terminal: TerminalWorkEdit, registered: RegisteredAdmission,
  input: AdmittedMetadataEditInput, digest: string): WorkEditReceipt {
  if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
    throw new IdempotencyConflict('Work edit receipt differs from admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'stale-head') throw new StaleWorkHead('expected Work head is stale');
    throw new WorkEditUnavailable('Work edit was cancelled');
  }
  if (terminal.work !== input.work || terminal.predecessor !== input.expectedHead) {
    throw new IdempotencyConflict('Work edit receipt targets another Work');
  }
  return { work: terminal.work, revision: terminal.revision!, predecessor: terminal.predecessor,
    receipt: terminal.receipt, admissionId: registered.id, dataEpoch: terminal.dataEpoch,
    sequence: terminal.sequence, replayed: true };
}

/** Current Account and exact Work-scoped Access grant precede any edit dispatch. */
export async function editAdmittedMetadataWork(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'issueTitleAdmission'>>,
  request: Request,
  input: AdmittedMetadataEditInput,
): Promise<WorkEditReceipt> {
  if (input.titleControl) {
    if (!access.issueTitleAdmission) throw new WorkEditUnavailable('title admission signer unavailable');
    const receipt = await changeTitleControl(env, account,
      { register: access.register.bind(access), claim: access.claim.bind(access),
        recordGraphOutcome: access.recordGraphOutcome.bind(access), issueTitleAdmission: access.issueTitleAdmission.bind(access) },
      request, { ...input, basis: input.titleControl, action: 'work.edit', source: null });
    return { work: input.work, predecessor: input.expectedHead, revision: receipt.revision!,
      receipt: receipt.receipt, admissionId: receipt.admissionId, dataEpoch: receipt.dataEpoch,
      sequence: receipt.sequence, replayed: receipt.replayed };
  }
  const controlled = await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(input.work)} <${RV}titleControlHead> ?control } }`, 1024);
  if (controlled.boolean) throw new TitleControlInvalid('title control and protection expectations are required');
  const digest = metadataWorkEditDigest(input.work, input.expectedHead, input.title);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let result: WorkEditReceipt | undefined;
    if (admission.state === 'sealed') {
      // A prior response may have been lost after the Access outcome write.
    } else if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      try {
        result = await editMetadataWork(env, { admission, work: input.work,
          expectedHead: input.expectedHead, title: input.title });
      } catch (error) {
        if (error instanceof IdempotencyConflict) throw error;
        // A stale or ambiguous graph result is resolved from the same receipt.
      }
    }
    const terminal = await readWorkEditTerminalReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    const checked = checkedResult(terminal, registered, input, digest);
    return result ? { ...checked, replayed: result.replayed } : checked;
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleWorkHead
      || error instanceof WorkEditUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}
