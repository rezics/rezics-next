import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission,
  workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { NativeChildConflict, NativeChildInvalid, NativeChildUnavailable,
  readNativeChild } from './child-native.ts';

const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const PROFILE = 'work-native-child-v1';
const SHAPE = `https://rezics.com/definition/${PROFILE}`;

export interface NativeChildRetirementInput {
  work: string; child: string; revision: string; expectedHead: string;
  actingSubject: string; reason: string; idempotencyKey: string;
}

export function nativeChildRetirementDigest(input: Omit<NativeChildRetirementInput, 'idempotencyKey'>): string {
  if (![input.work, input.child, input.revision, input.expectedHead,
    input.actingSubject].every(value => NATIVE.test(value))
    || input.reason !== input.reason.trim() || !input.reason || input.reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(input.reason)) {
    throw new NativeChildInvalid('invalid child retirement');
  }
  return hash(JSON.stringify({ profile: 'work-native-child-retirement-v1',
    work: input.work, child: input.child, revision: input.revision,
    expectedHead: input.expectedHead, actingSubject: input.actingSubject,
    reason: input.reason }));
}

export async function readNativeChildRetirement(env: WorkActivationEnvironment, child: string) {
  if (!NATIVE.test(child)) throw new NativeChildInvalid('invalid child identity');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?work ?revision ?head ?reason
    ?admission ?digest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(child)} a rv:NativeChild ; rv:retiredBy ?receipt . }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:nativeChild ${iri(child)} ;
      rv:nativeChildRevision ?revision ; rv:work ?work ; rv:expectedHead ?head ;
      rv:workRevision ?head ; rv:retirementReason ?reason ; rv:admissionId ?admission ;
      rv:requestDigest ?digest ; rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  } LIMIT 2`, 8192);
  const rows = data.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.receipt || !row.work || !row.revision || !row.head
    || !row.reason || !row.admission || !row.digest || !row.epoch || !row.sequence) {
    throw new NativeChildUnavailable('native child retirement is ambiguous');
  }
  return { profile: 'work-native-child-retirement-v1', state: 'retired',
    retirement: row.receipt.value, work: row.work.value, child, revision: row.revision.value,
    workHead: row.head.value, reason: row.reason.value, admissionId: row.admission.value,
    requestDigest: row.digest.value,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value, sequence: row.sequence.value } };
}

/** Human retirement changes one native child; Source withdrawal has no native effect. */
export async function retireNativeChild(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>,
  request: Request, input: NativeChildRetirementInput) {
  const { idempotencyKey, ...intent } = input;
  if (!KEY.test(idempotencyKey)) throw new NativeChildInvalid('invalid child retirement key');
  const requestDigest = nativeChildRetirementDigest(intent);
  const principal = await account.verify(request, ['work:edit']);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const child = await readNativeChild(env, input.child, input.revision);
  if (!child || child.work !== input.work) throw new NativeChildConflict('child identity differs');
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit', idempotencyKey,
    requestDigest });
  const prior = await readNativeChildRetirement(env, input.child);
  if (prior) {
    if (prior.admissionId !== registered.id || prior.requestDigest !== requestDigest
      || prior.work !== input.work || prior.revision !== input.revision
      || prior.workHead !== input.expectedHead || prior.reason !== input.reason) {
      throw new NativeChildConflict('child was retired by another intent');
    }
    return { retirement: prior, replayed: true };
  }
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, requestDigest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed') {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      const receipt = workEditReceiptIri(admission.id);
      const batch = `urn:rezics:outbox:${hash(receipt)}`;
      const event = `urn:rezics:event:${hash(`${receipt}\0native-child-retired`)}`;
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.child)} rv:retiredBy ${iri(receipt)} . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:outcome rv:Succeeded ; rv:action "work.edit" ;
            rv:admissionId ${lit(admission.id)} ; rv:requestDigest ${lit(requestDigest)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:work ${iri(input.work)} ; rv:workRevision ${iri(input.expectedHead)} ;
            rv:expectedHead ${iri(input.expectedHead)} ; rv:nativeChild ${iri(input.child)} ;
            rv:nativeChildRevision ${iri(input.revision)} ; rv:retirementReason ${lit(input.reason)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
            rv:event ${iri(event)} . ${iri(event)} a rv:NativeChildRetiredEvent ; rv:ordinal 0 ;
            rv:action "work.edit" ; rv:work ${iri(input.work)} ; rv:receipt ${iri(receipt)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork ;
            rv:head ${iri(input.expectedHead)} . ${iri(input.child)} a rv:NativeChild ;
            rv:work ${iri(input.work)} ; rv:childRevision ${iri(input.revision)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:protectionHead ?p } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.child)} rv:retiredBy ?r } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      const graphs = [GRAPHS.current, GRAPHS.revisions];
      const validations = await profileValidations(env.fuseki, PROFILE, [
        { shape: `${SHAPE}/child-shape`, focus: [input.child], graphs },
        { shape: `${SHAPE}/revision-shape`, focus: [input.revision], graphs },
      ]);
      const command = { receipt, digest: requestDigest, update, validations, deadlineMs: 10_000 };
      try {
        const result = await env.fuseki.commandWithReceipt({ ...command,
          titleAdmission: await access.issueTitleAdmission(admission, command) });
        if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') await sealMetadataWorkEditAdmission(env, admission);
      } catch (error) { if (error instanceof CommandRejected) throw error;
        // Retry resolves a lost acknowledgement from its exact immutable receipt.
      }
    }
  }
  const terminal = await readWorkEditTerminalReceipt(env, registered.id);
  if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome !== 'succeeded') throw new NativeChildConflict('child retirement basis changed');
  const retirement = await readNativeChildRetirement(env, input.child);
  if (!retirement || retirement.admissionId !== registered.id
    || retirement.requestDigest !== requestDigest || retirement.work !== input.work
    || retirement.revision !== input.revision || retirement.workHead !== input.expectedHead
    || retirement.reason !== input.reason) throw new NativeChildUnavailable('child retirement differs');
  return { retirement, replayed: registered.replayed };
}
