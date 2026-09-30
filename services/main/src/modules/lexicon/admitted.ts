import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { admitted, type SemanticAccess } from '../semantic/admitted.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { changePresentation, readPresentationTerminal, type PresentationResult } from './change.ts';
import {
  checkedPresentation,
  PRESENTATION_FAMILY,
  presentationAction,
  presentationDigest,
} from './schema.ts';

export interface AdmittedPresentationInput {
  target?: string;
  expectedHead: string | null;
  state: unknown;
  actingSubject: string;
  idempotencyKey: string;
}

/** Drafting and review require separate Access actions on the definition's scope. */
export async function admittedPresentationChange(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: SemanticAccess,
  request: Request,
  input: AdmittedPresentationInput,
): Promise<PresentationResult> {
  const state = checkedPresentation(input.state);
  const digest = presentationDigest(input.target, input.expectedHead, state);
  return admitted({
    env,
    account,
    access,
    request,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey,
    action: presentationAction(state),
    family: PRESENTATION_FAMILY,
    scope: `semantic:edit:${state.definition}`,
    digest,
    references: async () => [state.definition],
    dispatch: (admission) =>
      changePresentation(env, {
        admission,
        ...(input.target ? { target: input.target } : {}),
        expectedHead: input.expectedHead,
        state,
      }),
    readTerminal: (id) => readPresentationTerminal(env, id),
    result: (terminal, dispatched) => ({
      component: terminal.component!,
      revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null,
      receipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence,
      replayed: dispatched?.replayed ?? true,
    }),
  });
}
