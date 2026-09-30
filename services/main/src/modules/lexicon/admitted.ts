import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import {
  canReadSemantic,
  PendingSemanticChange,
  SEMANTIC_WRITE_SCOPE,
  type SemanticAccess,
} from '../semantic/admitted.ts';
import {
  cancelSemanticAdmission,
  checkedSemanticTerminal,
  familyReceiptIri,
  SemanticChangeRejected,
  SemanticTargetUnavailable,
  StaleSemanticHead,
} from '../semantic/command.ts';
import { ModelGenerationChanged } from '../semantic/generation-guard.ts';
import {
  CancelledActivation,
  IdempotencyConflict,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { changePresentation, readPresentationTerminal, type PresentationResult } from './change.ts';
import { checkedPresentation, PRESENTATION_FAMILY, presentationDigest } from './schema.ts';

export interface AdmittedPresentationInput {
  target?: string;
  expectedHead: string | null;
  state: unknown;
  actingSubject: string;
  idempotencyKey: string;
}

/** Vocabulary stewardship is an Access grant on the definition, never an inference from its type. */
export async function admittedPresentationChange(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: SemanticAccess,
  request: Request,
  input: AdmittedPresentationInput,
): Promise<PresentationResult> {
  const state = checkedPresentation(input.state);
  const digest = presentationDigest(input.target, input.expectedHead, state);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [SEMANTIC_WRITE_SCOPE]);
  if (!(await canReadSemantic(access, principal, input.actingSubject, state.definition))) {
    throw new SemanticChangeRejected(
      'unavailable-reference',
      'presentation definition is unavailable',
    );
  }
  const registered = await access.register({
    principal,
    actingSubject: input.actingSubject,
    scope: `semantic:edit:${state.definition}`,
    action: 'lexicon.presentation.change',
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
  });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try {
        admission = await access.claim(registered.id, digest);
      } catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let dispatched: PresentationResult | undefined;
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await cancelSemanticAdmission(
          env,
          familyReceiptIri(admission.id, PRESENTATION_FAMILY),
          admission,
        );
      } else {
        try {
          dispatched = await changePresentation(env, {
            admission,
            ...(input.target ? { target: input.target } : {}),
            expectedHead: input.expectedHead,
            state,
          });
        } catch (error) {
          if (
            error instanceof IdempotencyConflict ||
            error instanceof SemanticChangeRejected ||
            error instanceof CommandRejected ||
            error instanceof SemanticTargetUnavailable
          )
            throw error;
        }
      }
    }
    const terminal = await readPresentationTerminal(env, admission.id);
    if (!terminal) throw new PendingSemanticChange(admission.id, 'semantic-change');
    await access.recordGraphOutcome(admission.id, terminal);
    checkedSemanticTerminal(terminal, admission, digest);
    return {
      component: terminal.component!,
      revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null,
      receipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence,
      replayed: dispatched?.replayed ?? true,
    };
  } catch (error) {
    if (
      error instanceof IdempotencyConflict ||
      error instanceof SemanticChangeRejected ||
      error instanceof CommandRejected ||
      error instanceof SemanticTargetUnavailable ||
      error instanceof StaleSemanticHead ||
      error instanceof CancelledActivation ||
      error instanceof ModelGenerationChanged
    )
      throw error;
    throw new PendingSemanticChange(registered.id, 'semantic-change');
  }
}
