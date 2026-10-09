import { CommandRejected } from '../../infrastructure/fuseki.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { sealMetadataWorkEditAdmission } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { carriedComposition, changeComposition, chapterCreateDigest, compositionChangeDigest, compositionCreateDigest,
  changeStructureMeasures, structureMeasureDigest,
  compositionSealDigest, createComposition, readCompositionReceipt, sealComposition,
  compositionRestoreDigest, compositionStageDigest, restoreComposition, structureCreateDigest,
  sealStructureAdmissionCancellation,
  terminalResult, type CompositionConflict, type CompositionCost, type CompositionOperation,
  type NewChapterPost,
  type CompositionTerminal } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader } from './graph.ts';
import { InvalidCompositionChange } from './change.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from './tree.ts';
import { StructureStageConflict } from './stage.ts';
import { canReadStructureTarget, isCatalogTarget, structureProfileFor,
  type StructureProfileRegistration, type StructureTargetReader }
  from './profiles.ts';
import { targetRead } from '../target/resolve.ts';
import type { RecipeMeasure, StructureProfile } from './format.ts';

type Account = Pick<AccountAssertionVerifier, 'verify'>;
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>
  & Partial<Pick<AccessAdmissionRegistry, 'canReadSemanticResource' | 'realmReadProof'>>;

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
  || error instanceof StructureObjectUnavailable || error instanceof StructureStageConflict
  || (error instanceof Error && KNOWN.includes(error.constructor.name));

/**
 * Current Account plus the exact `work:edit:<Work>` Access grant precede dispatch;
 * the graph receipt, not the HTTP response, decides replay and pending outcomes.
 */
async function admitted(env: WorkActivationEnvironment, account: Account, access: Access,
  request: Request, input: { owner: string; profile: StructureProfileRegistration;
    actingSubject: string; idempotencyKey: string; digest: string },
  run: (admission: RegisteredAdmission) => Promise<{ committed: boolean; occurrences?: string[];
    cost?: CompositionCost; terminal?: CompositionTerminal }>, returnCancelled = false): Promise<AdmittedComposition> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [input.profile.editPermission]);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `${input.profile.editScopePrefix}${input.owner}`, action: input.profile.editAction,
    idempotencyKey: input.idempotencyKey, requestDigest: input.digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, input.digest, principal); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    let ran: Awaited<ReturnType<typeof run>> | undefined;
    let runError: unknown;
    if (admission.state === 'sealed') {
      // A lost response after the Access outcome write resolves from the same receipt.
    } else if (!admission.dispatchEligible || admission.state === 'registered') {
      if (input.profile.id === 'book-composition') await sealMetadataWorkEditAdmission(env, admission);
      else await sealStructureAdmissionCancellation(env, admission);
    } else {
      try { ran = await run(admission); }
      catch (error) {
        if (known(error) && !returnCancelled) throw error;
        runError = error;
      }
    }
    // A run that already read this admission's receipt is that proof. Reading it
    // again would only repeat the seek.
    const terminal = ran?.terminal ?? await readCompositionReceipt(env, registered.id, input.profile.editAction);
    if (!terminal && runError && known(runError)) throw runError;
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    if (!returnCancelled) terminalResult(terminal, registered);
    return { ...terminal, replayed: !ran?.committed,
      ...(ran?.occurrences ? { occurrences: ran.occurrences } : {}),
      ...(ran?.cost ? { cost: ran.cost } : {}) };
  } catch (error) {
    if (known(error)) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}

async function structureOwner(env: WorkActivationEnvironment, structure: string) {
  const header = await readCompositionHeader(env, structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  return { header, profile: structureProfileFor(header.profile) };
}

export function createAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request,
  input: { profile?: StructureProfile; owner?: string; component?: string;
    work?: string; mainVersion?: string; actingSubject: string; idempotencyKey: string }) {
  const profile = structureProfileFor(input.profile ?? 'book-composition');
  const owner = input.owner ?? input.work ?? '';
  const component = profile.componentPredicate ? input.component ?? input.mainVersion ?? '' : owner;
  const digest = profile.id === 'book-composition'
    ? compositionCreateDigest(component, profile.id)
    : structureCreateDigest(owner, component, profile.id);
  return admitted(env, account, access, request, { owner, profile, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => createComposition(env, { admission, owner, component, profile: profile.id,
    work: input.work, mainVersion: input.mainVersion }));
}

export async function changeAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: { structure: string; expectedHead: string;
    operations: readonly CompositionOperation[]; actingSubject: string; idempotencyKey: string;
    profile?: StructureProfile; newWork?: NewChapterPost }, targetReader?: StructureTargetReader) {
  const carried = carriedComposition(input.structure, input.expectedHead);
  const header = carried?.header ?? await readCompositionHeader(env, input.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  if (input.profile && input.profile !== header.profile) {
    throw new InvalidCompositionChange('composition profile differs');
  }
  const profile = structureProfileFor(header.profile);
  const digest = input.newWork
    ? chapterCreateDigest(input.structure, input.expectedHead, input.operations, input.newWork)
    : compositionChangeDigest(input.structure, input.expectedHead, input.operations, profile.id);
  const targets = [...new Set(input.operations.flatMap(operation => operation.op === 'insert'
    && operation.target && operation.target !== input.newWork?.work
    && !isCatalogTarget(profile, operation.target) ? [operation.target] : []))];
  const principal = await account.verify(request, [profile.editPermission,
    ...(targets.length && profile.targetReadPermission ? [profile.targetReadPermission] : [])]);
  targetReader ??= operation => targetRead(env, { access, principal, actingSubject: input.actingSubject }, operation);
  for (const target of targets) {
    if (!await canReadStructureTarget(profile, { environment: env, access, principal,
      actingSubject: input.actingSubject, target, targetReader })) {
      throw new CompositionUnavailable('Structure target is unavailable');
    }
  }
  return admitted(env, account, access, request, { owner: header.owner, profile,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => changeComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead, operations: input.operations,
    newWork: input.newWork, carried: carried ?? { header } }));
}

export async function changeAdmittedStructureMeasures(env: WorkActivationEnvironment,
  account: Account, access: Access, request: Request, input: { structure: string;
    expectedHead: string; measures: readonly RecipeMeasure[]; actingSubject: string;
    idempotencyKey: string }) {
  const { header, profile } = await structureOwner(env, input.structure);
  if (profile.id !== 'recipe-composition') {
    throw new InvalidCompositionChange('measures require a Recipe Structure');
  }
  const digest = structureMeasureDigest(input.structure, input.expectedHead, input.measures);
  return admitted(env, account, access, request, { owner: header.owner, profile,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, digest },
  admission => changeStructureMeasures(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead, measures: input.measures }));
}

export async function sealAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: { structure: string; expectedHead: string;
    actingSubject: string; idempotencyKey: string }, targetReader?: StructureTargetReader) {
  const { header, profile } = await structureOwner(env, input.structure);
  const digest = compositionSealDigest(input.structure, input.expectedHead);
  const principal = await account.verify(request, [profile.editPermission,
    ...(profile.targetReadPermission ? [profile.targetReadPermission] : [])]);
  targetReader ??= operation => targetRead(env, { access, principal, actingSubject: input.actingSubject }, operation);
  return admitted(env, account, access, request, { owner: header.owner, profile,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => sealComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead,
    canReadTarget: target => canReadStructureTarget(profile, { environment: env, access, principal,
      actingSubject: input.actingSubject, target, targetReader }) }));
}

export async function restoreAdmittedComposition(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: { structure: string; expectedHead: string;
    restoredFrom: string; actingSubject: string; idempotencyKey: string }, targetReader?: StructureTargetReader) {
  const { header, profile } = await structureOwner(env, input.structure);
  const digest = compositionRestoreDigest(input.structure, input.expectedHead, input.restoredFrom);
  const principal = await account.verify(request, [profile.editPermission,
    ...(profile.targetReadPermission ? [profile.targetReadPermission] : [])]);
  targetReader ??= operation => targetRead(env, { access, principal, actingSubject: input.actingSubject }, operation);
  return admitted(env, account, access, request, { owner: header.owner, profile,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => restoreComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead, restoredFrom: input.restoredFrom,
    canReadTarget: target => canReadStructureTarget(profile, { environment: env, access, principal,
      actingSubject: input.actingSubject, target, targetReader }) }));
}

export async function activateAdmittedCompositionStage(env: WorkActivationEnvironment,
  account: Account, access: Access, request: Request, input: { structure: string;
  expectedHead: string; stageId: string; generation: string; revision: string; manifestDigest: string;
    kind?: 'replace' | 'import' | 'refresh'; sourceRef?: string | null;
    sourceRevision?: string | null; mappingPolicy?: 'source-key' | 'explicit' | null;
    actingSubject: string; idempotencyKey: string; onGraphStart: () => Promise<number>;
    onProjectionBatch: (previous: number) => Promise<number> }, targetReader?: StructureTargetReader) {
  const digest = compositionStageDigest(input.structure, input.expectedHead,
    input.stageId, input.manifestDigest);
  const { header, profile } = await structureOwner(env, input.structure);
  const principal = await account.verify(request, [profile.editPermission,
    ...(profile.targetReadPermission ? [profile.targetReadPermission] : [])]);
  targetReader ??= operation => targetRead(env, { access, principal, actingSubject: input.actingSubject }, operation);
  return admitted(env, account, access, request, { owner: header.owner, profile,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest },
  admission => restoreComposition(env, { admission, structure: input.structure,
    expectedHead: input.expectedHead, restoredFrom: input.expectedHead,
    stage: { id: input.stageId, generation: input.generation, revision: input.revision,
      kind: input.kind, sourceRef: input.sourceRef, sourceRevision: input.sourceRevision,
      mappingPolicy: input.mappingPolicy,
      manifestDigest: input.manifestDigest, onGraphStart: input.onGraphStart,
      onProjectionBatch: input.onProjectionBatch },
    canReadTarget: target => canReadStructureTarget(profile, { environment: env, access, principal,
      actingSubject: input.actingSubject, target, targetReader }) }), true);
}

export type { CompositionConflict };
