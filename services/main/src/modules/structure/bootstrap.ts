import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { createAdmittedComposition, type AdmittedComposition } from './change-admitted.ts';
import type { StructureProfile } from './format.ts';
import { NATIVE_ID } from './graph.ts';
import { structureProfileFor } from './profiles.ts';

export class StructureBootstrapConflict extends Error {}

/** An owner command returns this only after reading its durable success receipt. */
export interface OwnerBootstrapReceipt {
  owner: string;
  receipt: string;
  requestDigest: string;
  outcome: 'succeeded';
}

export interface StructureBootstrapIntent {
  profile: StructureProfile;
  owner: string;
  actingSubject: string;
  idempotencyKey: string;
  requestDigest: string;
}

interface StructureBootstrapSteps {
  createOwner: (input: { owner: string; profile: StructureProfile;
    idempotencyKey: string; requestDigest: string }) => Promise<OwnerBootstrapReceipt>;
  createStructure: (input: { owner: string; profile: StructureProfile;
    idempotencyKey: string }) => Promise<Pick<AdmittedComposition,
      'owner' | 'structure' | 'revision' | 'receipt' | 'outcome' | 'replayed'>>;
}

/**
 * Two owner-validated graph commands, each with a stable subkey and receipt.
 * A crash at either boundary resumes the same owner and Structure commands.
 * Work is bounded to one owner receipt and one Structure receipt per attempt.
 */
export async function bootstrapStructureOwner(input: StructureBootstrapIntent,
  steps: StructureBootstrapSteps) {
  const profile = structureProfileFor(input.profile);
  if (profile.componentPredicate || !profile.structurePredicate || !NATIVE_ID.test(input.owner)
    || !NATIVE_ID.test(input.actingSubject)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)
    || !/^[0-9a-f]{64}$/.test(input.requestDigest)) {
    throw new StructureBootstrapConflict('invalid direct owner bootstrap intent');
  }
  const operation = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const owner = await steps.createOwner({ owner: input.owner, profile: input.profile,
    idempotencyKey: `structure-bootstrap-owner:${operation}`,
    requestDigest: input.requestDigest });
  if (owner.owner !== input.owner || owner.requestDigest !== input.requestDigest
    || owner.outcome !== 'succeeded' || !owner.receipt.startsWith('urn:rezics:receipt:')) {
    throw new StructureBootstrapConflict('owner receipt differs from bootstrap intent');
  }
  const structure = await steps.createStructure({ owner: input.owner, profile: input.profile,
    idempotencyKey: `structure-bootstrap-structure:${operation}` });
  if (structure.owner !== input.owner || !structure.structure || !structure.revision
    || structure.outcome !== 'succeeded'
    || !structure.receipt.startsWith('urn:rezics:receipt:')) {
    throw new StructureBootstrapConflict('Structure receipt differs from bootstrap owner');
  }
  return { owner: input.owner, structure: structure.structure, revision: structure.revision,
    ownerReceipt: owner.receipt, structureReceipt: structure.receipt,
    replayed: structure.replayed };
}

/** The owner supplies its validated create command; Structure uses the common admission path. */
export function bootstrapAdmittedStructureOwner(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>,
  request: Request, input: StructureBootstrapIntent & {
    createOwner: StructureBootstrapSteps['createOwner'];
  }) {
  return bootstrapStructureOwner(input, { createOwner: input.createOwner,
    createStructure: step => createAdmittedComposition(env, account, access, request, {
      profile: step.profile, owner: step.owner, actingSubject: input.actingSubject,
      idempotencyKey: step.idempotencyKey }) });
}
