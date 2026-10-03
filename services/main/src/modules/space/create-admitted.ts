import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { AliasInvalid, AliasConflict, AliasUnavailable } from '../address/registry.ts';
import { createRealmSpace, readSpaceCreationReceipt, sealRealmSpaceAdmission,
  spaceCreationDigest, validateTopics, InvalidSpaceInput, type CreateRealmSpaceInput, type SpaceCreationReceipt } from './create.ts';
import { createZoneSpace, zoneSpaceCreationDigest, type CreateZoneSpaceInput } from './create-zone.ts';

type Account = Pick<AccountAssertionVerifier, 'verify'>;
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
  & Partial<Pick<AccessAdmissionRegistry, 'withOwnerAuthority'>>;

export function createAdmittedRealmSpace(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: CreateRealmSpaceInput & { idempotencyKey: string }) {
  return createAdmittedSpace(env, account, access, request, { capability: 'realm', input });
}

export function createAdmittedZoneSpace(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: CreateZoneSpaceInput & { idempotencyKey: string }) {
  return createAdmittedSpace(env, account, access, request, { capability: 'zone', input });
}

async function createAdmittedSpace(
  env: WorkActivationEnvironment,
  account: Account,
  access: Access,
  request: Request,
  creation: { capability: 'realm'; input: CreateRealmSpaceInput & { idempotencyKey: string } }
    | { capability: 'zone'; input: CreateZoneSpaceInput & { idempotencyKey: string } },
): Promise<SpaceCreationReceipt & { replayed: boolean }> {
  const { input } = creation;
  const digest = creation.capability === 'realm'
    ? spaceCreationDigest(creation.input) : zoneSpaceCreationDigest(creation.input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['space:create']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: 'space:create:root', action: 'space.create',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest, principal); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealRealmSpaceAdmission(env, admission);
      } else {
        try {
          if (creation.capability === 'realm') await validateTopics(env, creation.input.topics ?? []);
          if (input.handle) {
            if (!env.addresses || !access.withOwnerAuthority) throw new AliasUnavailable('Space alias registry is unavailable');
            await access.withOwnerAuthority({ principal,actingSubject: input.actingSubject,
              action: 'space.create',scope: 'space:create:root' },client => env.addresses!.write(client,principal,{
                scope: 'space',holder: `https://rezics.com/id/${admission.id}`,actingSubject: input.actingSubject,
                operation: 'claim',alias: input.handle,expectedRevision: null,idempotencyKey: `space-alias:${admission.id}`,
              },input.actingSubject,admission.id));
          }
          if (creation.capability === 'realm') await createRealmSpace(env, admission, creation.input);
          else await createZoneSpace(env, admission, creation.input);
        }
        catch (error) {
          if (error instanceof AliasUnavailable) throw error;
          if (error instanceof AliasInvalid || error instanceof AliasConflict) {
            const terminal = await sealRealmSpaceAdmission(env,admission);
            await access.recordGraphOutcome(admission.id,terminal);
            throw error;
          }
          if (error instanceof InvalidSpaceInput) {
            const terminal = await sealRealmSpaceAdmission(env, admission);
            await access.recordGraphOutcome(admission.id, terminal);
            throw error;
          }
          if (error instanceof IdempotencyConflict) throw error;
        }
      }
    }
    const terminal = await readSpaceCreationReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'space-create');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('Space admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      if (input.handle) await env.addresses?.retireFailedCreation(`https://rezics.com/id/${registered.id}`);
      throw new CancelledActivation('Space creation was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation
      || error instanceof InvalidSpaceInput || error instanceof AliasInvalid
      || error instanceof AliasConflict || error instanceof AliasUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'space-create');
  }
}
