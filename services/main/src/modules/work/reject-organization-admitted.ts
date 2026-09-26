import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionUnavailable, type AccessAdmissionRegistry } from '../access/admission.ts';
import type { AccessOrganizationModeration } from '../access/organization-moderation.ts';
import { canonicalOrganizationPublication, moderationProofDigest,
  type OrganizationPublicationTarget } from '../access/organization-publication.ts';
import { GRAPHS, RV, iri, IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { readComponentState } from './history.ts';
import { organizationPublisherEvidence } from './organization-publication-evidence.ts';
import { checkedRealmRejectionReceipt, realmRejectionDigest, readRealmRejectionReceipt,
  rejectRealmLocal, sealRealmRejectionAdmission, REALM_REJECTION_PROFILE,
  StaleRealmRejection, RealmRejectionUnavailable,
  type RealmRejectionReceipt, type RejectRealmLocalInput } from './reject-realm.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

export function organizationRejectionInput(target: OrganizationPublicationTarget): RejectRealmLocalInput {
  const t = canonicalOrganizationPublication(target);
  return { context: { kind: 'realm-local', id: t.realm }, work: t.work, mainVersion: t.mainVersion,
    expectedSelectionHead: t.selection, decisionBasis: 'realm-manager-review', reasonCode: 'not-approved',
    actingSubject: t.actingSubject, organizationPublication: t };
}

/** This profile deliberately never calls the generic registration or claim methods. */
export async function rejectAdmittedOrganizationPublication(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  owner: Pick<AccessOrganizationModeration, 'admit'>,
  access: Pick<AccessAdmissionRegistry, 'recordGraphOutcome'>,
  request: Request, raw: OrganizationPublicationTarget, key: string,
): Promise<RealmRejectionReceipt & { replayed: boolean; authorityProofDigest: string }> {
  const target = canonicalOrganizationPublication(raw);
  const input = organizationRejectionInput(target);
  const digest = realmRejectionDigest(input);
  const principal = await account.verify(request, ['realm:reject']);
  let publisher;
  try {
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    publisher = await organizationPublisherEvidence(env, target);
  } catch { throw new AdmissionUnavailable('selected organization publication evidence is unavailable'); }
  const admission = await owner.admit(principal, target, publisher, key, digest);
  try {
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible) await sealRealmRejectionAdmission(env, admission);
      else {
        try { await rejectRealmLocal(env, admission, input); }
        catch { /* A just-read terminal receipt decides success, stale or pending. */ }
      }
    }
    const receipt = await readRealmRejectionReceipt(env, admission.id);
    if (!receipt) throw new PendingAdmittedWork(admission.id, 'realm-rejection');
    try { await access.recordGraphOutcome(admission.id, receipt); }
    catch { throw new PendingAdmittedWork(admission.id, 'realm-rejection'); }
    if (receipt.outcome === 'cancelled' && !receipt.reason) {
      throw new AdmissionDenied('saved organization moderation admission is no longer dispatchable');
    }
    const terminal = checkedRealmRejectionReceipt(receipt, admission, input, digest);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(terminal.rejection!)} rv:manifest ?manifest }
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1) throw new AdmissionUnavailable('rejection manifest is unavailable');
    const state = readComponentState(env.objectDirectory, rows[0]!.manifest!.value, terminal.slot!, REALM_REJECTION_PROFILE);
    if (state.authorityProofDigest !== admission.moderationProofDigest
      || moderationProofDigest(state.organizationPublication) !== moderationProofDigest(target)) {
      throw new AdmissionUnavailable('rejection attribution differs from saved admission');
    }
    return { ...terminal, replayed: admission.replayed, authorityProofDigest: admission.moderationProofDigest };
  } catch (error) {
    if (error instanceof AdmissionDenied || error instanceof IdempotencyConflict || error instanceof StaleRealmRejection
      || error instanceof RealmRejectionUnavailable || error instanceof AdmissionUnavailable) throw error;
    throw new PendingAdmittedWork(admission.id, 'realm-rejection');
  }
}
