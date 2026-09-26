import { CommandRejected } from '../../infrastructure/fuseki.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { sealMetadataWorkEditAdmission } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { changeComposition, compositionChangeDigest, compositionCreateDigest,
  compositionSealDigest, createComposition, readCompositionReceipt, sealComposition,
  terminalResult, type CompositionConflict, type CompositionCost, type CompositionOperation,
  type CompositionTerminal } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader } from './graph.ts';
import { InvalidCompositionChange } from './change.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from './tree.ts';

type Account = Pick<AccountAssertionVerifier, 'verify'>;
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;

export interface AdmittedComposition extends CompositionTerminal {
  replayed: boolean;
  occurrences?: string[];
  cost?: CompositionCost;
}

const KNOWN = ['StaleCompositionHead', 'CompositionConflict', 'CompositionExists',
  'CompositionTooLarge', 'CompositionCancelled', 'InvalidCompositionChange'];
const known = (error: unknown) => error instanceof IdempotencyConflict || error instanceof CommandRejected
  || error instanceof CompositionUnavailable || error instanceof CompositionCorrupt
  || error instanceof InvalidCompositionChange || error instanceof StructureObjectCorrupt
  || error instanceof StructureObjectUnavailable
  || (error instanceof Error && KNOWN.includes(error.constructor.name));

/**
 * Current Account plus the exact `work:edit:<Work>` Access grant precede dispatch;
 * the graph receipt, not the HTTP response, decides replay and pending outcomes.
 */
async function admitted(env: WorkActivationEnvironment, account: Account, access: Access,
  request: Request, input: { work: string; actingSubject: string; idempotencyKey: string; digest: string },
  run: (admission: RegisteredAdmission) => Promise<{ committed: boolean; occurrences?: string[];
    cost?: CompositionCost }>): Promise<AdmittedComposition> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit',
    idempotencyKey: input.idempotencyKey, requestDigest: input.digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, input.digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let ran: Awaited<ReturnType<typeof run>> | undefined;
    if (admission.state === 'sealed') {
      // A lost response after the Access outcome write resolves from the same receipt.
    } else if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      try { ran = await run(admission); }
      catch (error) { if (known(error)) throw error; }
    }
    const terminal = await readCompositionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    terminalResult(terminal, registered);
    return { ...terminal, replayed: !ran?.committed,
      ...(ran?.occurrences ? { occurrences: ran.occurrences } : {}),
      ...(ran?.cost ? { cost: ran.cost } : {}) };
  } catch (error) {
    if (known(error)) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}

async function bookWork(env: WorkActivationEnvironment, structure: string): Promise<string> {
  const header = await readCompositionHeader(env, structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  return header.work;
}

export function createAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request,
  input: { work: string; mainVersion: string; actingSubject: string; idempotencyKey: string }) {
  const digest = compositionCreateDigest(input.mainVersion);
  return admitted(env, account, access, request, { ...input, digest },
    admission => createComposition(env, { admission, mainVersion: input.mainVersion, work: input.work }));
}

export async function changeAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: { structure: string; expectedHead: string;
    operations: readonly CompositionOperation[]; actingSubject: string; idempotencyKey: string }) {
  const digest = compositionChangeDigest(input.structure, input.expectedHead, input.operations);
  await account.verify(request, ['work:edit']);
  const work = await bookWork(env, input.structure);
  return admitted(env, account, access, request, { work, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => changeComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead, operations: input.operations }));
}

export async function sealAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: { structure: string; expectedHead: string;
    actingSubject: string; idempotencyKey: string }) {
  const digest = compositionSealDigest(input.structure, input.expectedHead);
  await account.verify(request, ['work:edit']);
  const work = await bookWork(env, input.structure);
  return admitted(env, account, access, request, { work, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => sealComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead }));
}

export type { CompositionConflict };
