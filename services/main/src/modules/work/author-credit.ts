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
}
export interface NativeAuthorCredit extends AuthorCreditValue {
  profile: 'work-author-credit-v1'; role: 'author'; participantKind: 'external-reference';
  provider: 'open-library'; namespace: 'author'; control: 'human-confirmed';
  rightsStatus: 'undetermined'; dataEpoch: string; sequence: string;
}
export interface AuthorCreditReceipt {
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string; credit: string; revision: string;
  work: string; expectedHead: string; sourceIntent: string;
}

export function authorCreditDigest(value: AuthorCreditValue, sourceIntent: string): string {
  if (![value.work, value.credit, value.revision, value.expectedHead, value.actingSubject, sourceIntent]
    .every(item => NATIVE.test(item)) || !/^\/authors\/OL[1-9][0-9]{0,11}A$/.test(value.sourceKey)
    || !Number.isInteger(value.nativeOrdinal) || value.nativeOrdinal < 0 || value.nativeOrdinal > 127
    || (value.sourceRoleKey !== null && (!value.sourceRoleKey || value.sourceRoleKey.length > 200
      || /[\u0000-\u001f\u007f]/.test(value.sourceRoleKey)))) {
    throw new AuthorCreditInvalid('invalid native author credit');
  }
  return hash(JSON.stringify({ profile: AUTHOR_CREDIT_PROFILE, work: value.work, credit: value.credit,
    revision: value.revision, expectedHead: value.expectedHead, sourceKey: value.sourceKey,
    sourceRoleKey: value.sourceRoleKey, nativeOrdinal: value.nativeOrdinal,
    actingSubject: value.actingSubject, sourceIntent }));
}

/** Two exact subjects, independent of any Work's number of credits or revisions. */
export function authorCreditTriples(value: AuthorCreditValue, epoch: string, sequence: string):
  { current: string; revision: string } {
  const common = `rv:work ${iri(value.work)} ; schema:roleName "author" ;
    rv:externalProvider "open-library" ; rv:externalNamespace "author" ;
    rv:externalKey ${lit(value.sourceKey)} ; schema:position ${value.nativeOrdinal} ;
    rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined
    ${value.sourceRoleKey === null ? '' : `; rv:sourceRoleKey ${lit(value.sourceRoleKey)}`}`;
  return { current: `${iri(value.credit)} a rv:AuthorCredit ; rv:creditRevision ${iri(value.revision)} ; ${common} .`,
    revision: `${iri(value.revision)} a rv:AuthorCreditRevision, rv:RevisionAnchor ;
      rv:component ${iri(value.credit)} ; rv:workRevision ${iri(value.expectedHead)} ;
      rv:confirmedBy ${iri(value.actingSubject)} ; ${common} ;
      rv:modelRevision ${iri(AUTHOR_CREDIT_SHAPE)} ; rv:shapeRevision ${iri(AUTHOR_CREDIT_SHAPE)} ;
      rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} .` };
}

export async function authorCreditValidations(env: WorkActivationEnvironment,
  value: AuthorCreditValue, receipt: string, authorityEpoch: string, sourceIntent: string) {
  const graphs = [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control];
  return profileValidations(env.fuseki, AUTHOR_CREDIT_PROFILE, [
    { shape: `${AUTHOR_CREDIT_SHAPE}/credit-shape`, focus: [value.credit], graphs },
    { shape: `${AUTHOR_CREDIT_SHAPE}/revision-shape`, focus: [value.revision], graphs },
  ], { credit: value.credit, revision: value.revision, work: value.work,
    'work-head': value.expectedHead, key: value.sourceKey, ordinal: String(value.nativeOrdinal),
    actor: value.actingSubject, receipt, scope: `work:edit:${value.work}`, epoch: authorityEpoch,
    intent: sourceIntent, ...(value.sourceRoleKey === null ? {} : { 'source-role': value.sourceRoleKey }) });
}

export async function readAuthorCredit(env: WorkActivationEnvironment, credit: string,
  revision: string): Promise<NativeAuthorCredit | null> {
  if (![credit, revision].every(item => NATIVE.test(item))) throw new AuthorCreditInvalid('invalid credit identity');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?head ?key ?role ?ordinal ?actor ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:AuthorCredit ; rv:creditRevision ${iri(revision)} ;
        rv:work ?work ; rv:externalKey ?key ; schema:position ?ordinal ;
        schema:roleName "author" ; rv:externalProvider "open-library" ; rv:externalNamespace "author" ;
        rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined .
        OPTIONAL { ${iri(credit)} rv:sourceRoleKey ?currentRole }
        FILTER NOT EXISTS { ${iri(credit)} rv:agent|schema:author ?agent } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:AuthorCreditRevision, rv:RevisionAnchor ;
        rv:component ${iri(credit)} ; rv:work ?work ; rv:workRevision ?head ; rv:externalKey ?key ;
        schema:position ?ordinal ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined ;
        rv:modelRevision ${iri(AUTHOR_CREDIT_SHAPE)} ; rv:shapeRevision ${iri(AUTHOR_CREDIT_SHAPE)} ;
        rv:confirmedBy ?actor ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:sourceRoleKey ?role }
        FILTER NOT EXISTS { ${iri(revision)} rv:agent|schema:author ?agent }
      }
      FILTER((!BOUND(?currentRole) && !BOUND(?role)) || sameTerm(?currentRole, ?role))
    } LIMIT 2`);
  const rows = data.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !['work', 'head', 'key', 'ordinal', 'actor', 'epoch', 'sequence']
    .every(key => row[key]?.value !== undefined)) throw new AuthorCreditUnavailable('native credit is ambiguous');
  const value: AuthorCreditValue = { work: row.work!.value, credit, revision, expectedHead: row.head!.value,
    sourceKey: row.key!.value, sourceRoleKey: row.role?.value ?? null,
    nativeOrdinal: Number(row.ordinal!.value), actingSubject: row.actor!.value };
  authorCreditDigest(value, credit);
  return { ...value, profile: AUTHOR_CREDIT_PROFILE, role: 'author', participantKind: 'external-reference',
    provider: 'open-library', namespace: 'author', control: 'human-confirmed', rightsStatus: 'undetermined',
    dataEpoch: row.epoch!.value, sequence: row.sequence!.value };
}

export async function readAuthorCreditReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<AuthorCreditReceipt | null> {
  const terminal = await readWorkEditTerminalReceipt(env, admissionId);
  if (!terminal) return null;
  if (terminal.outcome !== 'succeeded') throw new AuthorCreditConflict('credit command was cancelled');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?credit ?revision ?intent WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(terminal.receipt)} rv:authorCredit ?credit ;
      rv:creditRevision ?revision ; rv:sourceIntent ?intent . } } LIMIT 2`);
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
  epoch: string, sequence: string): string {
  const receipt = workEditReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0author-credit`)}`;
  return `GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
    rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
    rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
    rv:outcome rv:Succeeded ; rv:work ${iri(value.work)} ; rv:expectedHead ${iri(value.expectedHead)} ;
    rv:workRevision ${iri(value.expectedHead)} ; rv:authorCredit ${iri(value.credit)} ;
    rv:creditRevision ${iri(value.revision)} ; rv:sourceIntent ${iri(sourceIntent)} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(epoch)} ;
      rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:AuthorCreditAdoptedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
        rv:work ${iri(value.work)} ; rv:receipt ${iri(receipt)} . }`;
}

/** Reuses Work edit admission/cancellation; success observes, but does not replace, the Work revision. */
export async function adoptAuthorCredit(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, value: AuthorCreditValue, sourceIntent: string, key: string):
  Promise<{ receipt: AuthorCreditReceipt; replayed: boolean }> {
  const digest = authorCreditDigest(value, sourceIntent);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit', 'source:adopt']);
  const registered = await access.register({ principal, actingSubject: value.actingSubject,
    scope: `work:edit:${value.work}`, action: 'work.edit', idempotencyKey: key, requestDigest: digest });
  let admission = registered;
  let replayed = true;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed') {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      const receipt = workEditReceiptIri(admission.id);
      const triples = authorCreditTriples(value, env.lineage.dataEpoch, '?next');
      const validations = await authorCreditValidations(env, value, receipt, admission.authorityEpoch, sourceIntent);
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${triples.current} }
          GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision} }
          ${authorCreditEnvelope(value, sourceIntent, admission, env.lineage.dataEpoch, '?next')} }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} a schema:CreativeWork ; rv:head ${iri(value.expectedHead)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} rv:protectionHead ?protection } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.credit)} ?cp ?co } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} ?rp ?ro } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      try {
        const result = await validatedCommand(env, { receipt, digest, update, validations, deadlineMs: 10_000 }, admission);
        replayed = registered.replayed;
        if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') await sealMetadataWorkEditAdmission(env, admission);
      } catch (error) { if (error instanceof CommandRejected) throw error; /* exact receipt resolves a lost response */ }
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
  return { receipt, replayed };
}
