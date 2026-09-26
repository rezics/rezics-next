import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type VerifiedPrincipal } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { CancelledActivation, IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { canonicalRelation, changeRelationOccurrence, readExactDefinition, readRelationChangeTerminal, RELATION_CHANGE_FAMILY,
  relationChangeDigest, type RelationChangeResult, type RelationInput } from '../relation/change.ts';
import { changeSemanticComponent, checkedComponentState, readSemanticChangeTerminal, referencedResources,
  semanticChangeDigest, type SemanticChangeResult } from './change.ts';
import { cancelSemanticAdmission, checkedSemanticTerminal, familyReceiptIri, SemanticChangeRejected,
  SemanticTargetUnavailable, StaleSemanticHead, type SemanticAdmission, type SemanticTerminal } from './command.ts';

export type SemanticAccess = Pick<AccessAdmissionRegistry,
  'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>
  & Partial<Pick<AccessAdmissionRegistry, 'canReadSemanticResource'>>;

/** Coarse OAuth capability; fine authority is the Access `semantic.*` grant on the exact scope. */
export const SEMANTIC_WRITE_SCOPE = 'work:edit';
export const SEMANTIC_READ_SCOPE = 'work:read';

export class PendingSemanticChange extends PendingAdmittedWork {
  constructor(admissionId: string, phase: 'semantic-change' | 'relation-change') {
    super(admissionId);
    Object.defineProperty(this, 'phase', { value: phase });
  }
}

/** A readable target is a semantic Resource or Work the acting subject may read now. */
export function referenceReader(access: Pick<SemanticAccess, 'canReadSemanticResource' | 'canReadWork'>,
  principal: VerifiedPrincipal, actingSubject: string) {
  return async (ref: string): Promise<boolean> =>
    await canReadSemantic(access, principal, actingSubject, ref)
      || await access.canReadWork(principal, actingSubject, ref);
}

export async function canReadSemantic(access: Pick<SemanticAccess, 'canReadWork' | 'canReadSemanticResource'>,
  principal: VerifiedPrincipal, actingSubject: string, resource: string): Promise<boolean> {
  if (!access.canReadSemanticResource) throw new Error('semantic Resource read authority is unavailable');
  return access.canReadSemanticResource(principal, actingSubject, resource);
}

interface AdmittedCall<T> {
  env: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: SemanticAccess;
  request: Request;
  actingSubject: string;
  idempotencyKey: string;
  action: 'semantic.change' | 'relation.change';
  family: string;
  scope: string;
  digest: string;
  references: (principal: VerifiedPrincipal) => Promise<string[]>;
  dispatch: (admission: SemanticAdmission) => Promise<T>;
  readTerminal: (admissionId: string) => Promise<SemanticTerminal | null>;
  result: (terminal: SemanticTerminal, dispatched?: T) => T;
}

/**
 * Account verification, reference disclosure, Access admission, graph dispatch,
 * receipt resolution and Access sealing, as in the Work edit family. A private or
 * missing reference is refused before any admission with one indistinct outcome.
 */
async function admitted<T>(call: AdmittedCall<T>): Promise<T> {
  await assertGraphAdmissionOpen(call.env.fuseki, call.env.lineage);
  const principal = await call.account.verify(call.request, [SEMANTIC_WRITE_SCOPE]);
  const readable = referenceReader(call.access, principal, call.actingSubject);
  for (const ref of await call.references(principal)) {
    if (!await readable(ref)) throw new SemanticChangeRejected('unavailable-reference', 'a referenced resource is unavailable');
  }
  const registered = await call.access.register({ principal, actingSubject: call.actingSubject, scope: call.scope,
    action: call.action, idempotencyKey: call.idempotencyKey, requestDigest: call.digest });
  const phase = call.action === 'semantic.change' ? 'semantic-change' : 'relation-change';
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await call.access.claim(registered.id, call.digest); }
      catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    let dispatched: T | undefined;
    if (admission.state === 'sealed') {
      // A prior response was lost after the Access outcome write.
    } else if (!admission.dispatchEligible || admission.state === 'registered') {
      await cancelSemanticAdmission(call.env, familyReceiptIri(registered.id, call.family), admission);
    } else {
      try { dispatched = await call.dispatch(admission); }
      catch (error) {
        if (error instanceof IdempotencyConflict || error instanceof SemanticChangeRejected
          || error instanceof CommandRejected || error instanceof SemanticTargetUnavailable) throw error;
      }
    }
    const terminal = await call.readTerminal(registered.id);
    if (!terminal) throw new PendingSemanticChange(registered.id, phase);
    await call.access.recordGraphOutcome(registered.id, terminal);
    checkedSemanticTerminal(terminal, registered, call.digest);
    return call.result(terminal, dispatched);
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleSemanticHead
      || error instanceof SemanticChangeRejected || error instanceof CommandRejected
      || error instanceof SemanticTargetUnavailable || error instanceof CancelledActivation) throw error;
    throw new PendingSemanticChange(registered.id, phase);
  }
}

export interface AdmittedSemanticChangeInput {
  target?: string;
  expectedHead: string | null;
  state: unknown;
  actingSubject: string;
  idempotencyKey: string;
}

export async function admittedSemanticChange(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: SemanticAccess, request: Request,
  input: AdmittedSemanticChangeInput): Promise<SemanticChangeResult> {
  const state = checkedComponentState(input.state);
  const digest = semanticChangeDigest(input.target, input.expectedHead, state);
  return admitted({ env, account, access, request, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, action: 'semantic.change', family: 'semantic-change',
    scope: input.target ? `semantic:edit:${input.target}` : 'semantic:create:root', digest,
    references: async () => referencedResources(state),
    dispatch: admission => changeSemanticComponent(env, { admission, ...(input.target ? { target: input.target } : {}),
      expectedHead: input.expectedHead, state }),
    readTerminal: id => readSemanticChangeTerminal(env, id),
    result: (terminal, dispatched) => ({ component: terminal.component!, revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null, receipt: terminal.receipt, dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence, replayed: dispatched?.replayed ?? true }) });
}

export interface AdmittedRelationChangeInput {
  occurrence?: string;
  expectedHead: string | null;
  input: RelationInput;
  actingSubject: string;
  idempotencyKey: string;
}

export async function admittedRelationChange(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: SemanticAccess, request: Request,
  input: AdmittedRelationChangeInput): Promise<RelationChangeResult> {
  const definition = await readExactDefinition(env, input.input.definition);
  if (!definition) throw new SemanticChangeRejected('unavailable-reference', 'relation definition is unavailable');
  const { state, digest } = relationIntent(definition, input);
  return admitted({ env, account, access, request, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, action: 'relation.change', family: RELATION_CHANGE_FAMILY,
    scope: input.occurrence ? `relation:edit:${input.occurrence}` : 'relation:create:root', digest,
    references: async () => [...new Set(state.participations.flatMap(item =>
      item.participant.kind === 'resource' ? [item.participant.ref] : []))],
    dispatch: admission => changeRelationOccurrence(env, { admission,
      ...(input.occurrence ? { occurrence: input.occurrence } : {}), expectedHead: input.expectedHead, input: input.input }),
    readTerminal: id => readRelationChangeTerminal(env, id),
    result: (terminal, dispatched) => ({ occurrence: terminal.component!, revision: terminal.revision!,
      predecessor: terminal.expectedHead ?? null, receipt: terminal.receipt, dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence, replayed: dispatched?.replayed ?? true }) });
}

function relationIntent(definition: NonNullable<Awaited<ReturnType<typeof readExactDefinition>>>,
  input: AdmittedRelationChangeInput) {
  const state = canonicalRelation(definition, input.input);
  return { state, digest: relationChangeDigest(input.occurrence, input.expectedHead, state) };
}
