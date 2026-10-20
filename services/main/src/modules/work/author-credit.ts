import { isNativeCreditRole, type NativeCreditRole } from './credit-roles.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission, workEditReceiptIri } from './edit.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import manifest from '../../../../../generated/model/manifest.json';
import { selectCommandProfile } from '../../../../../model/compiler/registry.ts';

export const AUTHOR_CREDIT_PROFILE = 'work-author-credit-v1';
export const AUTHOR_CREDIT_SHAPE = `https://rezics.com/definition/${AUTHOR_CREDIT_PROFILE}`;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class AuthorCreditInvalid extends Error {}
export class AuthorCreditConflict extends Error {}
export class AuthorCreditUnavailable extends Error {}

export interface AuthorCreditValue {
  work: string; credit: string; revision: string; expectedHead: string;
  sourceKey: string; sourceRoleKey: string | null; nativeOrdinal: number;
  actingSubject: string;
  provider?: string; namespace?: string; role?: NativeCreditRole; agent?: string;
  /** Owner-resolved authored pin; the public command retains its V1 transport envelope. */
  modelRevision?: string;
}
export interface NativeAuthorCredit extends AuthorCreditValue {
  profile: 'work-author-credit-v1'; role: NativeCreditRole; participantKind: 'external-reference';
  provider: string; namespace: string; control: 'human-confirmed';
  rightsStatus: 'undetermined'; dataEpoch: string; sequence: string;
}
export interface AuthorCreditReceipt {
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string; credit: string; revision: string;
  work: string; expectedHead: string; sourceIntent: string;
}

export function authorCreditDigest(value: AuthorCreditValue, sourceIntent: string): string {
  if (![value.work, value.credit, value.revision, value.expectedHead, value.actingSubject, sourceIntent]
    .every(item => NATIVE.test(item)) || (value.agent ? !NATIVE.test(value.agent) : !validExternalReference(creditReference(value)))
    || !isNativeCreditRole(value.role ?? 'author')
    || !Number.isInteger(value.nativeOrdinal) || value.nativeOrdinal < 0 || value.nativeOrdinal > 127
    || (value.sourceRoleKey !== null && (!value.sourceRoleKey || value.sourceRoleKey.length > 200
      || /[\u0000-\u001f\u007f]/.test(value.sourceRoleKey)))) {
    throw new AuthorCreditInvalid('invalid native author credit');
  }
  const profile = creditProfile(value);
  return hash(JSON.stringify({ profile: profile.endsWith('-v2') ? profile : AUTHOR_CREDIT_PROFILE, ...(value.provider === undefined ? {} : {
    provider: value.provider, namespace: value.namespace, role: value.role }), work: value.work, credit: value.credit,
    revision: value.revision, expectedHead: value.expectedHead, sourceKey: value.sourceKey,
    sourceRoleKey: value.sourceRoleKey, nativeOrdinal: value.nativeOrdinal,
    actingSubject: value.actingSubject, sourceIntent }));
}

/** Qualified references are opaque to this owner. Provider parsers belong to adapters. */
export function validExternalReference(value: { provider: string; namespace: string; key: string }) {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value.provider) && /^[a-z][a-z0-9-]{0,63}$/.test(value.namespace)
    && value.key.length > 0 && value.key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.key);
}
export function creditReference(value: AuthorCreditValue) {
  return { provider: value.provider ?? 'open-library', namespace: value.namespace ?? 'author', key: value.sourceKey };
}
export function creditProfile(value: Pick<AuthorCreditValue, 'agent' | 'role' | 'modelRevision'>) {
  const legacy = value.agent ? 'native-agent-credit-v1' : AUTHOR_CREDIT_PROFILE;
  const successor = value.agent ? 'native-agent-credit-v2' : 'work-author-credit-v2';
  const pin = value.modelRevision ?? (value.role === 'performer' ? `https://rezics.com/definition/${successor}` : undefined);
  const selected = selectCommandProfile(manifest, [`${RV}${value.agent ? 'NativeAgentCredit' : 'AuthorCredit'}`],
    path => path === `${RV}modelRevision` && pin ? [pin] : []);
  const profile = pin === `https://rezics.com/definition/${successor}` ? successor : legacy;
  if ((pin !== undefined && pin !== `https://rezics.com/definition/${profile}`)
    || selected?.profile !== profile || (value.role === 'performer' && profile === legacy))
    throw new AuthorCreditInvalid('credit model does not admit this native participant and role');
  return profile;
}
/** Two exact subjects, independent of any Work's number of credits or revisions.
 * Historical profiles retain their identities; both participant alternatives use this owner. */
export function authorCreditTriples(value: AuthorCreditValue, epoch: string, sequence: string):
  { current: string; revision: string } {
  const reference = creditReference(value), role = value.role ?? 'author';
  const profile = `https://rezics.com/definition/${creditProfile(value)}`;
  const kind = value.agent ? 'NativeAgentCredit' : 'AuthorCredit';
  const participant = value.agent ? `rv:agent ${iri(value.agent)}` :
    `rv:externalProvider ${lit(reference.provider)} ; rv:externalNamespace ${lit(reference.namespace)} ;
     rv:externalKey ${lit(reference.key)} ; schema:position ${value.nativeOrdinal} ;
     rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined
     ${value.sourceRoleKey === null ? '' : `; rv:sourceRoleKey ${lit(value.sourceRoleKey)}`}`;
  const common = `rv:work ${iri(value.work)} ; schema:roleName ${lit(role)} ; ${participant}`;
  const currentPin = creditProfile(value).endsWith('-v2') ? `rv:modelRevision ${iri(profile)} ; ` : '';
  return { current: `${iri(value.credit)} a rv:${kind} ; rv:creditRevision ${iri(value.revision)} ; ${currentPin}${common} .`,
    revision: `${iri(value.revision)} a rv:${kind}Revision, rv:RevisionAnchor ;
      rv:component ${iri(value.credit)} ; rv:workRevision ${iri(value.expectedHead)} ;
      rv:confirmedBy ${iri(value.actingSubject)} ; ${common} ;
      rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ;
      rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} .` };
}

export async function authorCreditValidations(env: WorkActivationEnvironment,
  value: AuthorCreditValue, receipt: string, authorityEpoch: string, sourceIntent: string,
  scope = `work:edit:${value.work}`) {
  const graphs = value.agent ? [GRAPHS.current, GRAPHS.revisions]
    : [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control];
  const profile = creditProfile(value), shape = `https://rezics.com/definition/${profile}`;
  return profileValidations(env.fuseki, profile, [
    { shape: `${shape}/credit-shape`, focus: [value.credit], graphs },
    { shape: `${shape}/revision-shape`, focus: [value.revision], graphs },
  ], value.agent ? undefined : { credit: value.credit, revision: value.revision, work: value.work,
    provider: creditReference(value).provider, namespace: creditReference(value).namespace, role: value.role ?? 'author',
    'work-head': value.expectedHead, key: value.sourceKey, ordinal: String(value.nativeOrdinal),
    actor: value.actingSubject, receipt, scope, epoch: authorityEpoch,
    intent: sourceIntent, ...(value.sourceRoleKey === null ? {} : { 'source-role': value.sourceRoleKey }) });
}

export async function readAuthorCredit(env: WorkActivationEnvironment, credit: string,
  revision: string): Promise<NativeAuthorCredit | null> {
  if (![credit, revision].every(item => NATIVE.test(item))) throw new AuthorCreditInvalid('invalid credit identity');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?head ?key ?role ?creditRole ?provider ?namespace ?ordinal ?actor ?epoch ?sequence ?model ?shape ?currentModel WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:AuthorCredit ; rv:creditRevision ${iri(revision)} ;
        rv:work ?work ; rv:externalKey ?key ; schema:position ?ordinal ;
        schema:roleName ?creditRole ; rv:externalProvider ?provider ; rv:externalNamespace ?namespace ;
        rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined .
        OPTIONAL { ${iri(credit)} rv:sourceRoleKey ?currentRole }
        OPTIONAL { ${iri(credit)} rv:modelRevision ?currentModel }
        FILTER NOT EXISTS { ${iri(credit)} rv:agent|schema:author ?agent } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:AuthorCreditRevision, rv:RevisionAnchor ;
        rv:component ${iri(credit)} ; rv:work ?work ; rv:workRevision ?head ; rv:externalKey ?key ;
        schema:position ?ordinal ; schema:roleName ?creditRole ; rv:externalProvider ?provider ;
        rv:externalNamespace ?namespace ; rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined ;
        rv:modelRevision ?model ; rv:shapeRevision ?shape ;
        rv:confirmedBy ?actor ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:sourceRoleKey ?role }
        FILTER NOT EXISTS { ${iri(revision)} rv:agent|schema:author ?agent }
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision }
      }
      FILTER((!BOUND(?currentRole) && !BOUND(?role)) || sameTerm(?currentRole, ?role))
    } LIMIT 2`);
  const rows = data.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !['work', 'head', 'key', 'ordinal', 'actor', 'epoch', 'sequence', 'provider', 'namespace', 'creditRole']
    .every(key => row[key]?.value !== undefined)) throw new AuthorCreditUnavailable('native credit is ambiguous');
  const value: AuthorCreditValue = { work: row.work!.value, credit, revision, expectedHead: row.head!.value,
    sourceKey: row.key!.value, sourceRoleKey: row.role?.value ?? null,
    nativeOrdinal: Number(row.ordinal!.value), actingSubject: row.actor!.value,
    provider: row.provider!.value, namespace: row.namespace!.value, role: row.creditRole!.value as NativeCreditRole };
  verifyCreditModelPins(value, row.model, row.shape, row.currentModel);
  authorCreditDigest(value, credit);
  return { ...value, profile: AUTHOR_CREDIT_PROFILE, role: value.role!, participantKind: 'external-reference',
    provider: value.provider!, namespace: value.namespace!, control: 'human-confirmed', rightsStatus: 'undetermined',
    dataEpoch: row.epoch!.value, sequence: row.sequence!.value };
}

/** Exact stored pins, including the current selector, are part of the owner witness. */
export function verifyCreditModelPins(value: AuthorCreditValue,
  model: { type: string; value: string } | undefined, shape: { type: string; value: string } | undefined,
  current: { type: string; value: string } | undefined): void {
  if (model?.type !== 'uri' || shape?.type !== 'uri' || model.value !== shape.value)
    throw new AuthorCreditUnavailable('credit revision model pins are unavailable');
  let profile: ReturnType<typeof creditProfile>;
  try { profile = creditProfile({ ...value, modelRevision: model.value }); }
  catch { throw new AuthorCreditUnavailable('credit revision model differs from participant and role'); }
  if ((current && (current.type !== 'uri' || current.value !== model.value))
    || (profile.endsWith('-v2') && !current))
    throw new AuthorCreditUnavailable('credit current model differs from revision');
  if (profile.endsWith('-v2')) value.modelRevision = model.value;
}

/** Retirement reads either historical representation without resolving an external reference to an Agent. */
export async function readCreditValue(env: WorkActivationEnvironment, credit: string,
  revision: string, retiringActor: string): Promise<AuthorCreditValue | null> {
  const external = await readAuthorCredit(env, credit, revision);
  if (external) return external;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?head ?agent ?role ?actor ?model ?shape ?currentModel WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:NativeAgentCredit ; rv:creditRevision ${iri(revision)} ;
        rv:work ?work ; rv:agent ?agent ; schema:roleName ?role .
        OPTIONAL { ${iri(credit)} rv:modelRevision ?currentModel } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:NativeAgentCreditRevision ; rv:component ${iri(credit)} ;
        rv:work ?work ; rv:workRevision ?head ; rv:agent ?agent ; schema:roleName ?role .
        OPTIONAL { ${iri(revision)} rv:confirmedBy ?actor }
        OPTIONAL { ${iri(revision)} rv:modelRevision ?model }
        OPTIONAL { ${iri(revision)} rv:shapeRevision ?shape }
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
  const row = rows[0];
  if (!rows.length) return null;
  if (rows.length !== 1 || !row?.work || !row.head || !row.agent || !row.role || !isNativeCreditRole(row.role.value))
    throw new AuthorCreditUnavailable('native credit is ambiguous');
  const value: AuthorCreditValue = { work: row.work.value, credit, revision, expectedHead: row.head.value, agent: row.agent.value,
    role: row.role.value, sourceKey: '', sourceRoleKey: null, nativeOrdinal: 0,
    // Legacy Agent shapes do not bind an actor; no confirmer is inferred or written by retirement.
    actingSubject: row.actor?.value ?? retiringActor };
  // Unpinned legacy V1 Agent records remain retireable; successor pins are exact.
  if (row.model || row.shape || row.currentModel || value.role === 'performer')
    verifyCreditModelPins(value, row.model, row.shape, row.currentModel);
  return value;
}

export async function readAuthorCreditReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<AuthorCreditReceipt | null> {
  const terminal = await readWorkEditTerminalReceipt(env, admissionId);
  if (!terminal) return null;
  if (terminal.admissionId !== admissionId || terminal.receipt !== workEditReceiptIri(admissionId)) {
    throw new AuthorCreditUnavailable('credit receipt differs from admission');
  }
  if (terminal.outcome !== 'succeeded') throw new AuthorCreditConflict('credit command was cancelled');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?credit ?revision ?intent WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(terminal.receipt)} (rv:authorCredit|rv:nativeCredit) ?credit ;
      rv:creditRevision ?revision . OPTIONAL { ${iri(terminal.receipt)} rv:sourceIntent ?sourceIntent }
      BIND(COALESCE(?sourceIntent, ?credit) AS ?intent) } } LIMIT 2`);
  const rows = data.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.credit || !rows[0]?.revision || !rows[0]?.intent
    || terminal.revision !== terminal.predecessor) throw new AuthorCreditUnavailable('credit receipt is unavailable');
  return { receipt: terminal.receipt, admissionId, requestDigest: terminal.requestDigest,
    authorityEpoch: terminal.authorityEpoch, scope: terminal.scope, work: terminal.work!,
    expectedHead: terminal.predecessor!, credit: rows[0].credit.value, revision: rows[0].revision.value,
    sourceIntent: rows[0].intent.value, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}

export function authorCreditEnvelope(value: AuthorCreditValue, sourceIntent: string,
  admission: Pick<RegisteredAdmission, 'id' | 'authorityEpoch' | 'scope' | 'requestDigest'>,
  epoch: string, sequence: string, nativeCommand = false): string {
  const receipt = workEditReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0${nativeCommand ? 'native-credit' : 'author-credit'}`)}`;
  return `GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
    rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
    rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
    rv:outcome rv:Succeeded ; rv:work ${iri(value.work)} ; rv:expectedHead ${iri(value.expectedHead)} ;
    rv:workRevision ${iri(value.expectedHead)} ; ${nativeCommand ? `rv:nativeCredit ${iri(value.credit)} ;` : ''} rv:authorCredit ${iri(value.credit)} ;
    rv:creditRevision ${iri(value.revision)} ; rv:sourceIntent ${iri(sourceIntent)} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(epoch)} ;
      rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:${nativeCommand ? 'NativeAgentCreditCreatedEvent' : 'AuthorCreditAdoptedEvent'} ; rv:ordinal 0 ; rv:action "work.edit" ;
        rv:work ${iri(value.work)} ; rv:receipt ${iri(receipt)} . }`;
}

/** Reuses Work edit admission/cancellation; success observes, but does not replace, the Work revision. */
export async function adoptAuthorCredit(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, value: AuthorCreditValue, sourceIntent: string, key: string,
  nativeCommand?: { digest: string; visible: () => Promise<boolean> }):
  Promise<{ receipt: AuthorCreditReceipt; replayed: boolean }> {
  const { publicAgent } = await import('../profiles/read.ts');
  const { unerased } = await import('./public-patterns.ts');
  const digest = nativeCommand?.digest ?? authorCreditDigest(value, sourceIntent);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, nativeCommand ? ['work:edit'] : ['work:edit', 'source:adopt']);
  const registered = await access.register({ principal, actingSubject: value.actingSubject,
    scope: `work:edit:${value.work}`, action: 'work.edit', idempotencyKey: key, requestDigest: digest });
  if (nativeCommand) value = { ...value, revision: `https://rezics.com/id/${registered.id}` };
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed') {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      const receipt = workEditReceiptIri(admission.id);
      const triples = authorCreditTriples(value, env.lineage.dataEpoch, '?next');
      const validations = await authorCreditValidations(env, value, receipt, admission.authorityEpoch, sourceIntent);
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${triples.current} }
          GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision} }
          ${authorCreditEnvelope(value, sourceIntent, admission, env.lineage.dataEpoch, '?next', !!nativeCommand)} }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} a schema:CreativeWork ; rv:head ${iri(value.expectedHead)} . }
          ${unerased(iri(value.work))}
          ${value.agent ? `${publicAgent(iri(value.agent))}
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?duplicate a rv:NativeAgentCredit ;
              rv:work ${iri(value.work)} ; rv:agent ${iri(value.agent)} ; schema:roleName ${lit(value.role ?? 'author')} } }` : ''}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} rv:protectionHead ?protection } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.credit)} ?cp ?co } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} ?rp ?ro } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      try {
        const result = await validatedCommand(env, { receipt, digest, update, validations, deadlineMs: 10_000 }, admission);
        if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') {
          if (nativeCommand && !await nativeCommand.visible()) throw new AuthorCreditUnavailable('Agent unavailable');
          await sealMetadataWorkEditAdmission(env, admission);
        }
      } catch (error) { if (error instanceof CommandRejected || error instanceof AuthorCreditUnavailable) throw error; /* exact receipt resolves a lost response */ }
    }
  }
  const terminal = await readWorkEditTerminalReceipt(env, admission.id);
  if (!terminal) throw new PendingAdmittedWork(admission.id, 'work-edit');
  await access.recordGraphOutcome(admission.id, terminal);
  const receipt = await readAuthorCreditReceipt(env, admission.id);
  if (!receipt) throw new PendingAdmittedWork(admission.id, 'work-edit');
  if (receipt.requestDigest !== digest || receipt.authorityEpoch !== admission.authorityEpoch
    || receipt.scope !== admission.scope || receipt.work !== value.work || receipt.credit !== value.credit
    || receipt.revision !== value.revision || receipt.expectedHead !== value.expectedHead
    || receipt.sourceIntent !== sourceIntent) throw new IdempotencyConflict('credit receipt differs from intent');
  // A receipt reconciles a lost graph acknowledgement without turning this
  // first request into a replay. Registration owns that distinction.
  return { receipt, replayed: registered.replayed };
}
