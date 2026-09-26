import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected, type CommandEnvelope } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { editorialFieldSlot, validEditorialControlBasis,
  type EditorialControlBasis } from '../protection/field-control.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission,
  workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

export const SYNOPSIS_DEFINITION = 'https://rezics.com/definition/work-synopsis-v1';
export const FIELD_PROFILE = 'https://rezics.com/definition/work-editorial-field-v1';
const CONTEXT = 'urn:rezics:context:global-native';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;

export class NativeFieldInvalid extends Error {}
export class NativeFieldConflict extends Error {}
export class NativeFieldUnavailable extends Error {}

export interface NativeFieldSourceBasis {
  record: string; observation: string; conversion: string;
  mapping: 'open-library-work-map-v1';
}
export interface NativeFieldControlIntent {
  profile: 'work-editorial-field-control-v1'; work: string; field: 'synopsis';
  expectedWorkHead: string; basis: EditorialControlBasis & { contentHead: string | null };
  value: string; origin: 'human' | 'source'; source: NativeFieldSourceBasis | null;
}
export interface NativeFieldControlState {
  profile: 'work-editorial-field-control-v1'; work: string; field: 'synopsis';
  slot: string; workHead: string; contentHead: string | null; controlHead: string | null;
  controlEpoch: string; protectionHead: string | null;
  mode: 'unestablished' | 'human-controlled' | 'source-managed'; value: string | null;
  rightsStatus: 'undetermined' | null;
}
export interface NativeFieldControlReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string;
  requestDigest: string; authorityEpoch: string; scope: string;
  dataEpoch: string; sequence: string; replayed: boolean;
  work?: string; slot?: string; content?: string; control?: string;
}

export function synopsisSlot(work: string): string {
  if (!NATIVE.test(work)) throw new NativeFieldInvalid('invalid Work');
  return editorialFieldSlot({ component: work, definition: SYNOPSIS_DEFINITION,
    occurrence: null, context: CONTEXT });
}

export function nativeFieldDigest(intent: NativeFieldControlIntent): string {
  if (intent.profile !== 'work-editorial-field-control-v1' || intent.field !== 'synopsis'
    || !NATIVE.test(intent.work) || !NATIVE.test(intent.expectedWorkHead)
    || !validEditorialControlBasis(intent.basis)
    || (intent.basis.contentHead !== null && !NATIVE.test(intent.basis.contentHead))
    || intent.value.length < 1 || intent.value.length > 8000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(intent.value)
    || (intent.basis.head === null) !== (intent.basis.contentHead === null)
    || (intent.origin === 'human') !== (intent.source === null)
    || !['human', 'source'].includes(intent.origin)
    || (intent.source !== null && (intent.source.mapping !== 'open-library-work-map-v1'
      || ![intent.source.record, intent.source.observation, intent.source.conversion]
        .every(value => NATIVE.test(value))))) throw new NativeFieldInvalid('invalid field-control intent');
  return hash(JSON.stringify({ profile: intent.profile, work: intent.work, field: intent.field,
    expectedWorkHead: intent.expectedWorkHead,
    basis: { contentHead: intent.basis.contentHead, head: intent.basis.head,
      epoch: intent.basis.epoch, protection: intent.basis.protection },
    value: intent.value, origin: intent.origin,
    source: intent.source === null ? null : { record: intent.source.record,
      observation: intent.source.observation, conversion: intent.source.conversion,
      mapping: intent.source.mapping } }));
}

/** One Work and one stable field slot; no Work history or source-corpus scan. */
export async function readNativeFieldControl(env: WorkActivationEnvironment, work: string):
  Promise<NativeFieldControlState> {
  const slot = synopsisSlot(work);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?workHead ?content ?control ?value
    ?epoch ?mode ?protection ?protectionMode ?rights WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/CreativeWork> ; rv:head ?workHead .
      OPTIONAL { ${iri(slot)} a rv:EditorialFieldSlot ; rv:component ${iri(work)} ;
        rv:fieldDefinition ${iri(SYNOPSIS_DEFINITION)} ; rv:fieldHead ?content ;
        rv:fieldControlHead ?control ; rv:fieldValue ?value . }
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?control a rv:EditorialFieldControlRevision ;
      rv:component ${iri(slot)} ; rv:controlField "synopsis" ; rv:controlEpoch ?epoch ;
      rv:controlMode ?mode ; rv:fieldRevision ?content .
      ?content a rv:EditorialFieldRevision ; rv:component ${iri(slot)} ;
        rv:fieldValue ?value ; rv:rightsStatus ?rights . } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:protectionHead ?protection }
      GRAPH ${iri(GRAPHS.revisions)} { ?protection rv:protectionMode ?protectionMode } }
  } LIMIT 2`, 16_384);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.workHead) throw new NativeFieldUnavailable('Work field is unavailable');
  const row = rows[0]!;
  if (row.protection && !row.protectionMode) throw new NativeFieldUnavailable('field protection is unavailable');
  if (!row.control) {
    if (row.content || row.value || row.epoch || row.mode) throw new NativeFieldUnavailable('field heads are incomplete');
    return { profile: 'work-editorial-field-control-v1', work, field: 'synopsis', slot,
      workHead: row.workHead.value, contentHead: null, controlHead: null,
      controlEpoch: '0', protectionHead: row.protection?.value ?? null,
      mode: 'unestablished', value: null, rightsStatus: null };
  }
  if (!row.content || !row.value || !row.epoch || !row.mode
    || row.rights?.value !== `${RV}Undetermined`
    || !/^[1-9][0-9]{0,18}$/.test(row.epoch.value)) {
    throw new NativeFieldUnavailable('field revision is incomplete');
  }
  const mode = row.mode.value === `${RV}HumanControlled` ? 'human-controlled'
    : row.mode.value === `${RV}SourceManaged` ? 'source-managed' : null;
  if (!mode) throw new NativeFieldUnavailable('field control mode is invalid');
  return { profile: 'work-editorial-field-control-v1', work, field: 'synopsis', slot,
    workHead: row.workHead.value, contentHead: row.content.value,
    controlHead: row.control.value, controlEpoch: row.epoch.value,
    protectionHead: row.protection?.value ?? null, mode, value: row.value.value,
    rightsStatus: 'undetermined' };
}

export async function readNativeFieldReceipt(env: WorkActivationEnvironment, admissionId: string):
  Promise<NativeFieldControlReceipt | null> {
  const terminal = await readWorkEditTerminalReceipt(env, admissionId);
  if (!terminal) return null;
  if (terminal.outcome === 'cancelled') return { outcome: 'cancelled', receipt: terminal.receipt,
    admissionId, requestDigest: terminal.requestDigest, authorityEpoch: terminal.authorityEpoch,
    scope: terminal.scope, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed: true };
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?slot ?content ?control WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(terminal.receipt)} rv:work ?work ; rv:fieldSlot ?slot ;
      rv:fieldRevision ?content ; rv:fieldControl ?control . } } LIMIT 2`, 4096);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.slot || !rows[0]?.content || !rows[0]?.control) {
    throw new NativeFieldUnavailable('field receipt is incomplete');
  }
  return { outcome: 'succeeded', receipt: terminal.receipt, admissionId,
    requestDigest: terminal.requestDigest, authorityEpoch: terminal.authorityEpoch,
    scope: terminal.scope, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
    work: rows[0].work.value, slot: rows[0].slot.value, content: rows[0].content.value,
    control: rows[0].control.value, replayed: true };
}

export async function nativeFieldCommand(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, intent: NativeFieldControlIntent): Promise<CommandEnvelope> {
  const digest = nativeFieldDigest(intent);
  if (admission.action !== 'work.edit' || admission.requestDigest !== digest
    || admission.scope !== `work:edit:${intent.work}`) throw new NativeFieldConflict('Access admission differs');
  const slot = synopsisSlot(intent.work), content = ID + Bun.randomUUIDv7(),
    control = ID + Bun.randomUUIDv7();
  const receipt = workEditReceiptIri(admission.id);
  const manifest = prepareComponent(env.objectDirectory, slot, { intent, content, control }, FIELD_PROFILE);
  const absent = 'rv:Absent';
  const basis = intent.basis;
  const current = `${iri(slot)} rv:fieldHead ?priorContent ; rv:fieldControlHead ?priorControl ;
    rv:fieldValue ?priorValue .`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${current} } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:EditorialFieldSlot ;
        rv:component ${iri(intent.work)} ; rv:fieldDefinition ${iri(SYNOPSIS_DEFINITION)} ;
        rv:fieldHead ${iri(content)} ; rv:fieldControlHead ${iri(control)} ;
        rv:fieldValue ${lit(intent.value)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(content)} a rv:RevisionAnchor, rv:EditorialFieldRevision ;
        rv:component ${iri(slot)} ; rv:fieldValue ${lit(intent.value)} ; rv:rightsStatus rv:Undetermined ;
        ${basis.contentHead ? `rv:predecessor ${iri(basis.contentHead)} ;` : ''}
        rv:manifest <urn:rezics:sha256:${manifest}> ; rv:modelRevision ${iri(FIELD_PROFILE)} ;
        rv:shapeRevision ${iri(FIELD_PROFILE)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next .
        ${iri(control)} a rv:RevisionAnchor, rv:EditorialFieldControlRevision ;
        rv:component ${iri(slot)} ; rv:controlField "synopsis" ;
        rv:controlMode rv:${intent.origin === 'human' ? 'HumanControlled' : 'SourceManaged'} ;
        rv:controlEpoch ${BigInt(basis.epoch) + 1n} ; rv:fieldRevision ${iri(content)} ;
        ${basis.head ? `rv:predecessor ${iri(basis.head)} ;` : ''}
        rv:controlIntent ${lit(JSON.stringify(intent))} ; rv:manifest <urn:rezics:sha256:${manifest}> ;
        rv:modelRevision ${iri(FIELD_PROFILE)} ; rv:shapeRevision ${iri(FIELD_PROFILE)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:outcome rv:Succeeded ; rv:action "work.edit" ; rv:admissionId ${lit(admission.id)} ;
        rv:requestDigest ${lit(digest)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:work ${iri(intent.work)} ;
        rv:expectedHead ${iri(intent.expectedWorkHead)} ; rv:workRevision ${iri(intent.expectedWorkHead)} ;
        rv:fieldSlot ${iri(slot)} ; rv:fieldRevision ${iri(content)} ; rv:fieldControl ${iri(control)} ;
        rv:expectedControl ${basis.head ? iri(basis.head) : absent} ;
        rv:expectedContent ${basis.contentHead ? iri(basis.contentHead) : absent} ;
        rv:expectedProtection ${basis.protection ? iri(basis.protection) : absent} ;
        rv:expectedControlEpoch ${basis.epoch} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { <urn:rezics:outbox:${hash(receipt)}> a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event <urn:rezics:event:${hash(receipt)}> .
        <urn:rezics:event:${hash(receipt)}> a rv:EditorialFieldControlEvent ; rv:ordinal 0 ;
        rv:action "work.edit" ; rv:work ${iri(intent.work)} ; rv:receipt ${iri(receipt)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} a <https://schema.org/CreativeWork> ;
        rv:head ${iri(intent.expectedWorkHead)} .
        OPTIONAL { ${current} }
        OPTIONAL { ${iri(slot)} rv:protectionHead ?priorProtection } }
      FILTER(${basis.contentHead ? `?priorContent = ${iri(basis.contentHead)}` : '!BOUND(?priorContent)'})
      FILTER(${basis.head ? `?priorControl = ${iri(basis.head)}` : '!BOUND(?priorControl)'})
      FILTER(${basis.protection ? `?priorProtection = ${iri(basis.protection)}` : '!BOUND(?priorProtection)'})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  const graphs = [GRAPHS.current, GRAPHS.revisions];
  const validations = await profileValidations(env.fuseki, 'work-editorial-field-v1', [
    { shape: `${FIELD_PROFILE}/slot-shape`, focus: [slot], graphs },
    { shape: `${FIELD_PROFILE}/value-shape`, focus: [content], graphs },
    { shape: `${FIELD_PROFILE}/control-shape`, focus: [control], graphs },
  ]);
  return { receipt, digest, update, validations, deadlineMs: 10_000 };
}

/** Even equal bytes create a new content revision and a new control epoch. */
export async function changeNativeFieldControl(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>,
  request: Request, input: NativeFieldControlIntent & { actingSubject: string;
    idempotencyKey: string }): Promise<NativeFieldControlReceipt> {
  if (!NATIVE.test(input.actingSubject) || !KEY.test(input.idempotencyKey)) {
    throw new NativeFieldInvalid('invalid field actor or key');
  }
  const { actingSubject, idempotencyKey, ...intent } = input;
  const digest = nativeFieldDigest(intent);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, input.origin === 'source'
    ? ['work:edit', 'source:adopt'] : ['work:edit']);
  const registered = await access.register({ principal, actingSubject,
    scope: `work:edit:${intent.work}`, action: 'work.edit', idempotencyKey,
    requestDigest: digest });
  let terminal = await readNativeFieldReceipt(env, registered.id);
  const replayed = !!terminal;
  if (!terminal && registered.state !== 'sealed') {
    let admission = registered;
    try { if (admission.dispatchEligible) admission = await access.claim(admission.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    if (admission.state === 'claimed' && admission.dispatchEligible) {
      const command = await nativeFieldCommand(env, admission, intent);
      command.titleAdmission = await access.issueTitleAdmission(admission, command);
      try {
        const result = await env.fuseki.commandWithReceipt(command);
        if (['guard-unmatched', 'invalid'].includes(result.status)) {
          await sealMetadataWorkEditAdmission(env, admission);
        } else if (result.status === 'unknown-profile') throw new CommandRejected(result);
      } catch (error) {
        if (error instanceof CommandRejected
          || error instanceof Error && error.message.startsWith('Fuseki command rejected:')) throw error;
        // A lost command acknowledgement is resolved by its exact receipt.
      }
    } else await sealMetadataWorkEditAdmission(env, admission);
    terminal = await readNativeFieldReceipt(env, registered.id);
  }
  if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
  if (terminal.requestDigest !== digest || terminal.scope !== registered.scope
    || terminal.authorityEpoch !== registered.authorityEpoch) {
    throw new NativeFieldConflict('field receipt differs from Access admission');
  }
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome === 'cancelled') throw new NativeFieldConflict('field content, control or protection changed');
  return { ...terminal, replayed };
}
