import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import {
  AdmissionDenied,
  AdmissionExpired,
  type AccessAdmissionRegistry,
} from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import {
  CancelledActivation,
  IdempotencyConflict,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import {
  cancelSemanticAdmission,
  checkedSemanticTerminal,
  familyReceiptIri,
  SemanticChangeRejected,
  SemanticTargetUnavailable,
  StaleSemanticHead,
} from '../semantic/command.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { ModelGenerationChanged } from '../semantic/generation-guard.ts';
import {
  changeQuestionPresentation,
  readQuestionPresentationTerminal,
} from './question-presentation.ts';
import {
  checkedQuestionPresentation,
  QUESTION_PRESENTATION_FAMILY,
  questionPresentationAction,
  questionPresentationDigest,
  questionPresentationScope,
} from './question-presentation-schema.ts';

export async function admittedQuestionPresentationChange(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: {
    target?: string;
    expectedHead: string | null;
    state: unknown;
    retire?: boolean;
    actingSubject: string;
    idempotencyKey: string;
  },
) {
  const state = checkedQuestionPresentation(input.state);
  const digest = questionPresentationDigest(input.target, input.expectedHead, state, input.retire);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:configure']);
  const registered = await access.register({
    principal,
    actingSubject: input.actingSubject,
    scope: questionPresentationScope(state.context),
    action: questionPresentationAction(state),
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
  });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try {
        admission = await access.claim(registered.id, digest, principal);
      } catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let replayed = true;
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await cancelSemanticAdmission(
          env,
          familyReceiptIri(registered.id, QUESTION_PRESENTATION_FAMILY),
          admission,
        );
      } else {
        const result = await changeQuestionPresentation(env, {
          admission,
          target: input.target,
          expectedHead: input.expectedHead,
          state,
          retire: input.retire,
        });
        replayed = result.replayed;
      }
    }
    const terminal = await readQuestionPresentationTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id);
    await access.recordGraphOutcome(registered.id, terminal);
    checkedSemanticTerminal(terminal, registered, digest);
    return {
      component: terminal.component!,
      revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null,
      receipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence,
      replayed,
    };
  } catch (error) {
    if (
      error instanceof IdempotencyConflict ||
      error instanceof CancelledActivation ||
      error instanceof SemanticChangeRejected ||
      error instanceof SemanticTargetUnavailable ||
      error instanceof StaleSemanticHead ||
      error instanceof ModelGenerationChanged ||
      error instanceof CommandRejected
    ) {
      // A graph refusal is terminal too. Seal Access before returning it so a
      // refused command never remains claimed until its lease expires.
      const terminal = await readQuestionPresentationTerminal(env, registered.id);
      if (terminal) await access.recordGraphOutcome(registered.id, terminal);
      throw error;
    }
    throw new PendingAdmittedWork(registered.id);
  }
}
