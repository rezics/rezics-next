import type { VerifiedPrincipal } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { admitted, type AdmittedRelationChangeInput, type SemanticAccess } from '../semantic/admitted.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertIdentityParticipants, relationReferences, canonicalRelation, changeRelationOccurrence, readCurrentOccurrence, readExactDefinition,
  readRelationChangeTerminal, relationChangeDigest, RELATION_CHANGE_FAMILY, type ExactDefinition,
  type OccurrenceState } from './change.ts';

/** Definition data chooses a singleton subject role; Access alone grants its edit authority. */
export function relationSubjectWork(definition: ExactDefinition, state: OccurrenceState): string {
  const subjects = state.participations.filter(item => definition.roleKeys[item.role] === definition.workSubjectRole);
  if (subjects.length !== 1 || subjects[0]!.participant.kind !== 'resource') {
    throw new SemanticChangeRejected('invalid', 'relation requires one native subject Work');
  }
  return subjects[0]!.participant.ref;
}

export async function admittedWorkRelationChange(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: SemanticAccess, request: Request,
  input: AdmittedRelationChangeInput) {
  const definition = await readExactDefinition(env, input.input.definition);
  if (!definition?.workSubjectRole) throw new SemanticChangeRejected('invalid', 'definition has no Work subject role');
  const state = canonicalRelation(definition, input.input);
  const subject = relationSubjectWork(definition, state);
  const present = await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(subject)} a <https://schema.org/CreativeWork> } }`);
  if (!present.boolean) {
    const principal = await account.verify(request, ['work:edit']);
    await assertIdentityParticipants(env, state.participations, { access, principal, actingSubject: input.actingSubject });
    throw new SemanticChangeRejected('unavailable-reference', 'subject Work is unavailable');
  }
  if (input.occurrence) {
    const current = await readCurrentOccurrence(env, input.occurrence);
    const previous = current ? await readExactDefinition(env, current.state.definition) : null;
    // Editing a different Work cannot move an existing occurrence into this scope.
    if (!current || !previous?.workSubjectRole || relationSubjectWork(previous, current.state) !== subject) {
      throw new SemanticChangeRejected('unavailable-reference', 'relation occurrence is unavailable');
    }
  }
  const digest = relationChangeDigest(input.occurrence, input.expectedHead, state);
  // Baseline claims need the current Account assertion; keep this in the Work adapter.
  let currentPrincipal: VerifiedPrincipal | undefined;
  const workAccess = new Proxy(access, { get(target, property) {
    if (property === 'claim') return (id: string, digest: string) => target.claim(id, digest, currentPrincipal);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return admitted({ env, account, access: workAccess, request, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, action: 'relation.change', family: RELATION_CHANGE_FAMILY,
    scope: `work:edit:${subject}`, digest,
    references: async principal => {
      currentPrincipal = principal;
      if (!await access.canReadWork(principal, input.actingSubject, subject)) {
        throw new SemanticChangeRejected('unavailable-reference', 'subject Work is unavailable');
      }
      return relationReferences(env, definition, state, { access, principal, actingSubject: input.actingSubject });
    },
    dispatch: (admission, canRead) => changeRelationOccurrence(env, { admission, ...input, canRead: input.canReadConflict ?? canRead }),
    readTerminal: id => readRelationChangeTerminal(env, id),
    result: async (terminal, dispatched) => {
      await input.beforeCommit?.complete?.(terminal.component!, terminal.receipt);
      return { occurrence: terminal.component!, revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null, receipt: terminal.receipt, dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence, replayed: dispatched?.replayed ?? true };
    } });
}
