import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission,
  workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

const PROFILE = 'work-native-child-v1';
const SHAPE = `https://rezics.com/definition/${PROFILE}`;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export class NativeChildInvalid extends Error {}
export class NativeChildConflict extends Error {}
export class NativeChildUnavailable extends Error {}

export interface NativeChildValue {
  work: string; child: string; revision: string; field: 'subjects'; sourceKey: string;
  nativeOrdinal: number; expectedHead: string; actingSubject: string; sourceIntent: string;
}
export interface NativeChildReceipt {
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string; work: string; expectedHead: string;
  child: string; revision: string; sourceIntent: string;
}

export function nativeChildDigest(value: NativeChildValue): string {
  if (![value.work, value.child, value.revision, value.expectedHead, value.actingSubject,
    value.sourceIntent].every(item => NATIVE.test(item)) || value.field !== 'subjects'
    || !value.sourceKey || value.sourceKey.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.sourceKey)
    || !Number.isInteger(value.nativeOrdinal) || value.nativeOrdinal < 0 || value.nativeOrdinal > 127) {
    throw new NativeChildInvalid('invalid native child');
  }
  return hash(JSON.stringify({ profile: PROFILE, ...value }));
}

export async function readNativeChild(env: WorkActivationEnvironment,
  child: string, revision: string) {
  if (![child, revision].every(item => NATIVE.test(item))) throw new NativeChildInvalid('invalid child identity');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?head ?field ?key ?position ?actor ?epoch ?sequence ?retirement WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(child)} a rv:NativeChild ;
        rv:childRevision ${iri(revision)} ; rv:work ?work ; rv:childField ?field ;
        rv:sourceKey ?key ; schema:position ?position ; rv:editControl rv:HumanConfirmed ;
        rv:rightsStatus rv:Undetermined . OPTIONAL { ${iri(child)} rv:retiredBy ?retirement } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:NativeChildRevision, rv:RevisionAnchor ;
        rv:component ${iri(child)} ; rv:work ?work ; rv:workRevision ?head ;
        rv:childField ?field ; rv:sourceKey ?key ; schema:position ?position ;
        rv:confirmedBy ?actor ; rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined ;
        rv:modelRevision ${iri(SHAPE)} ; rv:shapeRevision ${iri(SHAPE)} ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    } LIMIT 2`, 8192);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.work || !row.head || !row.field || !row.key
    || !row.position || !row.actor || !row.epoch || !row.sequence
    || row.field.value !== 'subjects') throw new NativeChildUnavailable('native child differs');
  return { profile: PROFILE, state: row.retirement ? 'retired' : 'active', work: row.work.value,
    child, revision, field: row.field.value, sourceKey: row.key.value,
    nativeOrdinal: Number(row.position.value), expectedHead: row.head.value,
    actingSubject: row.actor.value, dataEpoch: row.epoch.value,
    sequence: row.sequence.value, retiredBy: row.retirement?.value ?? null };
}

export async function readNativeChildReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<NativeChildReceipt | null> {
  const terminal = await readWorkEditTerminalReceipt(env, admissionId);
  if (!terminal) return null;
  if (terminal.outcome === 'cancelled') throw new NativeChildConflict('native child command was cancelled');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?child ?revision ?intent WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(terminal.receipt)} rv:nativeChild ?child ;
      rv:nativeChildRevision ?revision ; rv:sourceIntent ?intent . } } LIMIT 2`, 4096);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.child || !rows[0]?.revision || !rows[0]?.intent
    || terminal.revision !== terminal.predecessor || !terminal.work || !terminal.predecessor) {
    throw new NativeChildUnavailable('native child receipt is unavailable');
  }
  return { receipt: terminal.receipt, admissionId, requestDigest: terminal.requestDigest,
    authorityEpoch: terminal.authorityEpoch, scope: terminal.scope, work: terminal.work,
    expectedHead: terminal.predecessor, child: rows[0].child.value,
    revision: rows[0].revision.value, sourceIntent: rows[0].intent.value,
    dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}

/** One immutable relation and revision, guarded by a Work head and signed edit grant. */
export async function adoptNativeChild(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>,
  request: Request, value: NativeChildValue, key: string):
  Promise<{ receipt: NativeChildReceipt; replayed: boolean }> {
  if (!KEY.test(key)) throw new NativeChildInvalid('invalid child key');
  const digest = nativeChildDigest(value);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['source:adopt', 'work:edit']);
  const registered = await access.register({ principal, actingSubject: value.actingSubject,
    scope: `work:edit:${value.work}`, action: 'work.edit', idempotencyKey: key, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed') {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      const receipt = workEditReceiptIri(admission.id);
      const batch = `urn:rezics:outbox:${hash(receipt)}`;
      const event = `urn:rezics:event:${hash(`${receipt}\0native-child`)}`;
      const common = `rv:work ${iri(value.work)} ; rv:childField ${lit(value.field)} ;
        rv:sourceKey ${lit(value.sourceKey)} ; schema:position ${value.nativeOrdinal} ;
        rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined`;
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.child)} a rv:NativeChild ;
            rv:childRevision ${iri(value.revision)} ; ${common} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} a rv:NativeChildRevision, rv:RevisionAnchor ;
            rv:component ${iri(value.child)} ; rv:workRevision ${iri(value.expectedHead)} ;
            rv:confirmedBy ${iri(value.actingSubject)} ; ${common} ;
            rv:modelRevision ${iri(SHAPE)} ; rv:shapeRevision ${iri(SHAPE)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:action "work.edit" ; rv:outcome rv:Succeeded ; rv:work ${iri(value.work)} ;
            rv:expectedHead ${iri(value.expectedHead)} ; rv:workRevision ${iri(value.expectedHead)} ;
            rv:nativeChild ${iri(value.child)} ; rv:nativeChildRevision ${iri(value.revision)} ;
            rv:sourceIntent ${iri(value.sourceIntent)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
            rv:event ${iri(event)} . ${iri(event)} a rv:NativeChildAdoptedEvent ; rv:ordinal 0 ;
            rv:action "work.edit" ; rv:work ${iri(value.work)} ; rv:receipt ${iri(receipt)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} a schema:CreativeWork ;
            rv:head ${iri(value.expectedHead)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} rv:protectionHead ?p } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.child)} ?cp ?co } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} ?rp ?ro } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          BIND(?n + 1 AS ?next) }`;
      const graphs = [GRAPHS.current, GRAPHS.revisions];
      const validations = await profileValidations(env.fuseki, PROFILE, [
        { shape: `${SHAPE}/child-shape`, focus: [value.child], graphs },
        { shape: `${SHAPE}/revision-shape`, focus: [value.revision], graphs },
      ]);
      const command = { receipt, digest, update, validations, deadlineMs: 10_000 };
      try {
        const result = await env.fuseki.commandWithReceipt({ ...command,
          titleAdmission: await access.issueTitleAdmission(admission, command) });
        if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') await sealMetadataWorkEditAdmission(env, admission);
      } catch (error) { if (error instanceof CommandRejected) throw error;
        // A lost acknowledgement is recovered from the exact Work edit receipt.
      }
    }
  }
  const terminal = await readWorkEditTerminalReceipt(env, admission.id);
  if (!terminal) throw new PendingAdmittedWork(admission.id, 'work-edit');
  await access.recordGraphOutcome(admission.id, terminal);
  const receipt = await readNativeChildReceipt(env, admission.id);
  if (!receipt) throw new PendingAdmittedWork(admission.id, 'work-edit');
  if (receipt.requestDigest !== digest || receipt.authorityEpoch !== admission.authorityEpoch
    || receipt.scope !== admission.scope || receipt.work !== value.work
    || receipt.expectedHead !== value.expectedHead || receipt.child !== value.child
    || receipt.revision !== value.revision || receipt.sourceIntent !== value.sourceIntent) {
    throw new NativeChildConflict('native child receipt differs from intent');
  }
  return { receipt, replayed: registered.replayed };
}
