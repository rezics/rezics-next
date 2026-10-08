import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type GraphTerminalProof,
  type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict, PendingActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { ZONE_PROFILE } from './config-format.ts';
import { ZoneUnavailable } from './configuration.ts';
import { realmAttachmentEventId } from './outbox-event.ts';
import { REALM_ATTACH_ACTION, realmAttachScope } from './realm-attachment-authority.ts';
import { realmAttachRequest } from './realm-attachment.ts';

export interface ZoneRealmWithdrawalInput {
  zone: string; realm: string; actingSubject: string; idempotencyKey: string;
}

/** Same receipt family as the Zone's own commands, so Access derives and seals
 * it without a second graph vocabulary. */
const receiptIri = (admissionId: string) => `urn:rezics:receipt:${hash(`${admissionId}\0structure-command`)}`;

async function readTerminal(env: WorkActivationEnvironment, receipt: string): Promise<GraphTerminalProof | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?admission ?epoch ?scope ?dataEpoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?admission ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence . } } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new ZoneUnavailable('Realm attachment receipt is incomplete or ambiguous');
  }
  return { outcome: row.outcome?.value === `${RV}Succeeded` ? 'succeeded' : 'cancelled', receipt,
    admissionId: row.admission!.value, requestDigest: row.digest!.value, authorityEpoch: row.epoch!.value,
    scope: row.scope!.value, dataEpoch: row.dataEpoch!.value, sequence: row.sequence!.value };
}

const receiptHeader = (env: WorkActivationEnvironment, admission: Pick<RegisteredAdmission, 'id'
  | 'requestDigest' | 'authorityEpoch' | 'scope'>, receipt: string, outcome: 'Succeeded' | 'Cancelled') =>
  `${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:${outcome} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`;

const attachmentBatch = (env: WorkActivationEnvironment, receipt: string) => {
  const event = realmAttachmentEventId(receipt);
  return `${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
    ${iri(event)} a rv:ZoneRealmAttachmentEvent ; rv:ordinal 0 ; rv:action ${lit(REALM_ATTACH_ACTION)} ;
      rv:receipt ${iri(receipt)} .`;
};

const controlGuard = (env: WorkActivationEnvironment) => `
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;

async function sealCancelled(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  access: Pick<AccessAdmissionRegistry, 'recordGraphOutcome'>) {
  const receipt = receiptIri(admission.id);
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptHeader(env, admission, receipt, 'Cancelled')} }
      GRAPH ${iri(GRAPHS.outbox)} { ${attachmentBatch(env, receipt)} } }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update,
    validations: [], deadlineMs: 10_000 }); }
  catch { /* the graph receipt is authoritative after an ambiguous response */ }
  const terminal = await readTerminal(env, receipt);
  if (!terminal) throw new PendingActivation('Realm attachment cancellation outcome is unknown');
  await access.recordGraphOutcome(admission.id, terminal);
}

/** A Realm steward ends a Zone's attachment of their Realm at once, without any
 * Zone authority. The Zone's own link and its attachment record are removed
 * together, so every read behaves as if no Realm were attached. The steward
 * grant is judged by the same register and claim as any `realm.attach` effect and
 * held through the graph switch.
 * Cost: one graph read and one bounded graph command. */
export async function withdrawZoneRealmAttachment(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'withOwnerAuthority'>>,
  request: Request, input: ZoneRealmWithdrawalInput) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const digest = hash(JSON.stringify({ family: 'zone-realm-withdrawal-v1', zone: input.zone,
    realm: input.realm, actingSubject: input.actingSubject }));
  const principal = await account.verify(request, ['zone:edit']);
  const scope = realmAttachScope(input.realm);
  const registered = await access.register({ principal, actingSubject: input.actingSubject, scope,
    action: REALM_ATTACH_ACTION, idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  const receipt = receiptIri(registered.id);
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealCancelled(env, admission, access);
    throw new AdmissionDenied('Realm attachment authority is unavailable');
  }
  if (admission.state !== 'sealed' && !await readTerminal(env, receipt)) {
    const live = (await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.zone)} a rv:Zone ; rv:realmAttachment ?attachment ; rv:realmAttachedBy ?by ;
        rv:defaultRealm ${iri(input.realm)} . } }`, 1024)).boolean === true;
    if (!live) {
      await sealCancelled(env, admission, access);
      throw new ZoneUnavailable('Zone attachment is unavailable');
    }
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:defaultRealm ${iri(input.realm)} ;
          rv:realmAttachedBy ?by ; rv:realmAttachment ?attachment . } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { ${receiptHeader(env, admission, receipt, 'Succeeded')}
          ${iri(receipt)} rv:structureOwner ${iri(input.zone)} ; rv:realm ${iri(input.realm)} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${attachmentBatch(env, receipt)} } }
      WHERE { ${controlGuard(env)}
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} a rv:Zone ; rv:realmAttachment ?attachment ;
          rv:realmAttachedBy ?by ; rv:defaultRealm ${iri(input.realm)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'zone-capability-v1', [
      { shape: `${ZONE_PROFILE}/zone-shape`, focus: [input.zone], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    const commit = () => env.fuseki.commandWithReceipt({ receipt, digest, update, validations, deadlineMs: 10_000 });
    try {
      if (access.withOwnerAuthority) {
        await access.withOwnerAuthority(realmAttachRequest(principal, input.actingSubject, input.realm), commit);
      } else await commit();
    } catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        await sealCancelled(env, admission, access);
        throw error;
      }
      // The receipt resolves an ambiguous graph response.
    }
    if (!await readTerminal(env, receipt)) {
      // The attachment changed between the read and the switch.
      await sealCancelled(env, admission, access);
      throw new ZoneUnavailable('Zone attachment is unavailable');
    }
  }
  const terminal = await readTerminal(env, receipt);
  if (!terminal) throw new PendingActivation('Realm attachment withdrawal outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== scope) {
    throw new IdempotencyConflict('Realm attachment receipt differs from intent');
  }
  if (terminal.outcome !== 'succeeded') throw new ZoneUnavailable('Zone attachment is unavailable');
  return { zone: input.zone, realm: input.realm, receipt, replayed: registered.replayed,
    dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}
