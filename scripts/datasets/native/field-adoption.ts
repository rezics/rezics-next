import type { ResourceState } from '../../../services/main/src/modules/semantic/change.ts';
import type { AcknowledgedNativeBasis, RetainedConversionRequest, RetainedSupportRequest } from '../../../services/main/src/modules/source/field-support-contract.ts';
import type { RetainedConversion } from '../../../services/main/src/modules/source/retained-record.ts';
import { retainedMappingRevision } from '../../../services/main/src/modules/source/retained-record-normalization.ts';
import { suppliedLanguage } from '../../../services/main/src/modules/source/field-control-language.ts';
import { canonical, sha256 } from '../store.ts';
import type { DatasetFieldAdoption, DatasetFieldAdoptionJournal, DatasetMappingContext, DatasetRecordedCommand, DatasetRetainedConversionReceipt } from '../types.ts';
import { DatasetApiError } from '../auth.ts';
import type { DatasetFieldEvidence, DatasetFieldPlan, DatasetNativeField } from './fields.ts';

export const DATASET_FIELD_ADOPTION_REVISION = 'retained-fields-v1';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const RECEIPT = /^urn:rezics:receipt:[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const short = (id: string) => id.slice(-36);
const nativeId = (v: unknown): v is string => typeof v === 'string' && NATIVE.test(v);
const receiptId = (v: unknown): v is string => typeof v === 'string' && RECEIPT.test(v);
function requireReceipt(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`acknowledgement-invalid: ${reason}`);
}
function reason(stage: string, error: unknown): string {
  return error instanceof DatasetApiError
    ? `${stage}: HTTP ${error.status} ${String(error.detail.code ?? '')} ${String(error.detail.basis ?? '')}`.trim()
    : `${stage}: ${error instanceof Error ? error.message : String(error)}`;
}
const coordinate = (field: DatasetNativeField, evidence: DatasetFieldEvidence): RetainedSupportRequest['evidence']['field'] => ({
  pointer: evidence.path, presence: field.presence,
  ...(evidence.valueDigest !== undefined ? { valueDigest: evidence.valueDigest } : {}),
  ...(Object.hasOwn(evidence, 'language') ? { language: evidence.language } : {}),
  ...(evidence.ordinal !== undefined ? { ordinal: evidence.ordinal } : {}),
});

/** Transport over the existing importer journal. A resumed command uses its
 * original intent before dispatch; a fresh command obtains fresh owner heads. */
export interface DatasetFieldAdoptionContext extends DatasetMappingContext {
  execute(label: string, path: string, body: () => Promise<unknown>): Promise<DatasetRecordedCommand>;
  checkpoint(label: string): DatasetRecordedCommand | undefined;
  /** Exact producer state at an acknowledged revision, never a filtered read
   * used as a complete replacement for somebody else's semantic properties. */
  semanticState(target: string, revision: string): ResourceState | undefined;
  converted(key: string, receipt: DatasetRetainedConversionReceipt): void;
}

function checkedConversion(command: DatasetRecordedCommand, request: RetainedConversionRequest): RetainedConversion {
  const result = command.result, converted = result?.conversion;
  requireReceipt(equal(command.body, request) && typeof result?.replayed === 'boolean' && object(converted), 'conversion command');
  const binding = converted.retainedRecord;
  requireReceipt(object(binding) && converted.profile === 'source-retained-record-conversion-v1'
    && converted.state === 'staged' && converted.mappingRevision === request.mappingRevision
    && converted.observation === request.retained.intakes[0]!.observation
    && converted.sourceDigest === request.retained.payload.byteDigest
    && nativeId(converted.conversion) && typeof converted.createdAt === 'string', 'conversion identity');
  requireReceipt(binding.profile === 'source-retained-record-binding-v1' && nativeId(binding.binding)
    && nativeId(binding.sourceRecord) && binding.conversion === converted.conversion
    && binding.mappingRevision === request.mappingRevision && typeof binding.normalizationRevision === 'string'
    && binding.normalizationRevision.length > 0, 'retained binding');
  for (const field of ['identity', 'snapshot', 'recordDigest', 'intakes', 'payload'] as const)
    requireReceipt(equal(binding[field], request.retained[field]), `retained binding ${field}`);
  return structuredClone(converted) as unknown as RetainedConversion;
}

/** Source performs the authoritative evidence, rights and native verification.
 * The producer accepts only that operation's exact, currently recorded result. */
function checkedSupport(value: Record<string, unknown>, input: RetainedSupportRequest, conversion: RetainedConversion) {
  requireReceipt(value.profile === 'source-field-support-v1' && value.state === 'recorded'
    && value.withdrawal === null && value.outcome === 'attached' && nativeId(value.support)
    && nativeId(value.supportIdentity), 'recorded independently withdrawable support');
  for (const field of ['target','slot','occurrence','context','sourceRecord','conversion','grain','sourceField','sourceOccurrence'] as const)
    requireReceipt(equal(value[field], input[field]), `support ${field}`);
  requireReceipt(value.mappingRevision === input.evidence.mappingRevision
    && value.nativeRevision === input.native.revision && value.graphReceipt === input.native.receipt
    && value.valueDigest === input.evidence.field.valueDigest, 'support native value');
  const admission = value.admission, attachment = value.attachment;
  requireReceipt(object(admission) && admission.profile === 'source-field-support-admission-v1'
    && admission.sourceRecord === input.sourceRecord && admission.conversion === input.conversion
    && equal(admission.evidence, input.evidence) && equal(admission.native, input.native)
    && admission.headGuarantee === 'verified-before-commit' && value.headGuarantee === admission.headGuarantee,
  'Source admission and head guarantee');
  const correspondence = admission.correspondence;
  requireReceipt(object(correspondence) && correspondence.normalizationRevision === conversion.retainedRecord.normalizationRevision
    && correspondence.rule === 'dataset-record-envelope-v1'
    && equal(correspondence.payloadPointers, [`/record${input.evidence.field.pointer}`])
    && correspondence.selectedValueDigest === input.evidence.field.valueDigest, 'Source correspondence');
  requireReceipt(object(attachment) && attachment.profile === 'source-field-attachment-certificate-v1'
    && receiptId(attachment.receipt) && attachment.nativeReceipt === input.native.receipt
    && typeof attachment.requestDigest === 'string' && /^[0-9a-f]{64}$/.test(attachment.requestDigest), 'Source settlement certificate');
}

export async function adoptDatasetFields(context: DatasetFieldAdoptionContext, plans: readonly DatasetFieldPlan[],
  journal: DatasetFieldAdoptionJournal): Promise<void> {
  for (const plan of plans) {
    const target = context.native.get(plan.source.key);
    if (!target) continue;
    const candidates = plan.fields.filter(field => field.disposition === 'candidate' && field.native
      && (field.native.owner === 'work-editorial' || field.native.owner === 'semantic' && field.native.material === 'fact'));
    if (!candidates.length) continue;
    const source = context.source(plan.source.key), retained = source.retained;
    const entries = candidates.flatMap(field => field.evidence.map(evidence => ({ field, evidence,
      entry: { record: source.key, field: coordinate(field, evidence), status: 'pending' as const,
        reason: 'retained-conversion-pending' } as DatasetFieldAdoption })));
    journal.fields.push(...entries.map(item => item.entry));
    const pending = (entry: DatasetFieldAdoption, why: string) => {
      entry.reason = why;
      context.disposition({ record: source.key, kind: 'field', path: entry.field.pointer }, { status: 'unmapped', reason: why });
    };
    let conversion: RetainedConversion;
    const conversionLabel = `conversion:${source.key}`;
    try {
      requireReceipt(retained?.snapshot.fileSha256, 'frozen snapshot file pin missing');
      const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
        mappingRevision: retainedMappingRevision(source.provider, source.namespace), retained: {
          identity: retained.identity, snapshot: { ...retained.snapshot, fileSha256: retained.snapshot.fileSha256 },
          record: retained.record, recordDigest: retained.recordDigest, payload: retained.payload,
          intakes: retained.intakes.map(({ index, record, observation, byteDigest }) => ({ index, record, observation, byteDigest })),
        } };
      const command = await context.execute(conversionLabel,
        `/v1/sources/observations/${short(request.retained.intakes[0]!.observation)}/conversions`, async () => request);
      conversion = checkedConversion(command, request);
      for (const { entry } of entries) entry.conversion = command;
      const receipt = { request, conversion, command };
      journal.conversions[source.key] = structuredClone(receipt);
      context.converted(source.key, receipt);
    } catch (error) {
      for (const { entry } of entries) {
        entry.conversion = context.checkpoint(conversionLabel);
        pending(entry, reason('source-retained-conversion', error));
      }
      continue;
    }
    const semantic = entries.filter(({ field }) => field.native!.owner === 'semantic');
    const semanticLabel = `semantic:${source.key}`;
    let semanticCommand: DatasetRecordedCommand | undefined;
    let semanticFailure: unknown;
    if (semantic.length) {
      try {
        semanticCommand = await context.execute(semanticLabel, '/v1/semantic/changes', async () => {
          let current: Record<string, unknown> | undefined;
          try { current = await context.read(`/v1/semantic/resources/${short(target.id)}?actingSubject=${encodeURIComponent(context.actingSubject)}`); }
          catch (error) { if (!(error instanceof DatasetApiError && error.status === 404)) throw error; }
          let state: ResourceState = { component: 'resource', lifecycle: 'active',
            types: ['http://www.w3.org/2000/01/rdf-schema#Resource'], properties: [] };
          if (current) {
            requireReceipt(current.component === target.id && nativeId(current.revision), 'current semantic identity');
            const complete = context.semanticState(target.id, current.revision);
            requireReceipt(complete?.lifecycle === 'active', 'complete acknowledged semantic state unavailable; preserve existing properties');
            state = structuredClone(complete);
          }
          for (const { field } of semantic) {
            const property = field.native!.property!;
            if (!state.properties.some(prior => equal(prior, property))) state.properties.push(structuredClone(property));
          }
          return { profile: 'semantic-change-v1', target: target.id, expectedHead: current?.revision ?? null,
            state, actingSubject: context.actingSubject };
        });
      } catch (error) { semanticFailure = error; }
    }
    for (const { field, evidence, entry } of entries) {
      const identity = sha256(canonical({ record: source.key, field: entry.field, native: field.native }));
      const nativeLabel = field.native!.owner === 'semantic' ? semanticLabel : `synopsis:${identity}`;
      const supportLabel = `support:${identity}`;
      let stage = 'native-field-adoption';
      try {
        let native: Extract<AcknowledgedNativeBasis, { kind: 'component-property' }>;
        let verifyHead: (body: Record<string, unknown>) => void;
        if (field.native!.owner === 'semantic') {
          if (semanticFailure) throw semanticFailure;
          requireReceipt(semanticCommand?.result, 'missing semantic acknowledgement');
          entry.native = semanticCommand;
          const ack = semanticCommand.result;
          requireReceipt(ack.profile === 'semantic-change-v1' && ack.component === target.id
            && nativeId(ack.revision) && receiptId(ack.receipt), 'semantic native receipt');
          const property = field.native!.property!;
          native = { kind: 'component-property', owner: 'semantic', target: target.id, component: target.id,
            revision: ack.revision, receipt: ack.receipt, property };
          const path = `/v1/semantic/resources/${short(target.id)}?actingSubject=${encodeURIComponent(context.actingSubject)}`;
          const body = await context.read(path);
          entry.nativeRead = { path, body };
          entry.nativeReads = [entry.nativeRead];
          verifyHead = body => requireReceipt(body.component === target.id && body.revision === native.revision && object(body.state)
            && Array.isArray(body.state.properties) && body.state.properties.some(actual => object(actual)
              && actual.predicate === property.predicate && equal(actual.value, property.value)), 'current semantic head/value');
          verifyHead(body);
        } else {
          requireReceipt(target.kind === 'work' && field.native!.property, 'synopsis needs its existing Work');
          const property = field.native!.property, language = suppliedLanguage(evidence);
          requireReceipt(property.value.kind === 'string' || property.value.kind === 'language-string', 'synopsis text');
          const text = property.value.lexical;
          const path = `/v1/works/${short(target.id)}/fields/synopsis/control`;
          const readPath = `${path}?actingSubject=${encodeURIComponent(context.actingSubject)}`;
          entry.native = await context.execute(nativeLabel, path, async () => {
            const state = await context.read(readPath);
            requireReceipt(state.profile === 'work-editorial-field-control-v1' && state.work === target.id
              && state.mode === 'unestablished' && state.contentHead === null && state.controlHead === null
              && state.value === null && nativeId(state.workHead), 'existing editor/source synopsis choice is preserved');
            return { profile: 'work-editorial-field-control-v1', field: 'synopsis', expectedWorkHead: state.workHead,
              basis: { contentHead: state.contentHead, head: state.controlHead, epoch: state.controlEpoch, protection: state.protectionHead },
              value: text, language, origin: 'source', source: { record: conversion.retainedRecord.sourceRecord,
                observation: conversion.observation, conversion: conversion.conversion, mapping: conversion.mappingRevision },
              actingSubject: context.actingSubject };
          });
          const ack = entry.native.result;
          requireReceipt(ack?.outcome === 'succeeded' && ack.work === target.id && nativeId(ack.content)
            && nativeId(ack.control) && typeof ack.slot === 'string' && receiptId(ack.receipt), 'editorial native receipt');
          const body = await context.read(readPath);
          entry.nativeRead = { path: readPath, body };
          entry.nativeReads = [entry.nativeRead];
          verifyHead = current => requireReceipt(current.work === target.id && current.contentHead === ack.content && current.controlHead === ack.control
            && current.slot === ack.slot && current.mode === 'source-managed' && current.value === text
            && equal(current.language, language) && current.workHead === body.workHead
            && current.controlEpoch === body.controlEpoch && current.protectionHead === body.protectionHead,
          'current editorial heads/value/language');
          verifyHead(body);
          native = { kind: 'component-property', owner: 'work-editorial', target: target.id, component: ack.slot,
            revision: ack.content, receipt: ack.receipt, field: 'synopsis', property, language };
        }
        const request: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2',
          target: target.id, slot: native.owner === 'work-editorial' ? 'work-editorial-field-v1#synopsis'
            : `component-property-v1#${native.property.predicate}`, occurrence: null, context: 'global',
          sourceRecord: conversion.retainedRecord.sourceRecord, conversion: conversion.conversion,
          grain: source.namespace, sourceField: evidence.path.startsWith('/data/') ? evidence.path.slice(6) : evidence.path.slice(1),
          sourceOccurrence: null, expectedHead: native.revision, actingSubject: context.actingSubject,
          evidence: { binding: conversion.retainedRecord.binding, recordDigest: source.recordDigest,
            mappingRevision: conversion.mappingRevision, field: entry.field }, native };
        stage = 'source-field-support';
        entry.support = await context.execute(supportLabel, '/v1/sources/field-supports', async () => request);
        requireReceipt(equal(entry.support.body, request), 'replayed support intent');
        const support = entry.support.result?.support;
        requireReceipt(object(support), 'missing Source support acknowledgement');
        checkedSupport(support, request, conversion);
        const path = `/v1/sources/field-supports/${short(String(support.support))}`;
        const body = await context.read(path);
        entry.supportRead = { path, body };
        checkedSupport(body, request, conversion);
        requireReceipt(body.supportIdentity === support.supportIdentity && equal(body.attachment, support.attachment), 'current Source support step');
        stage = 'native-field-adoption';
        const current = { path: entry.nativeRead!.path, body: await context.read(entry.nativeRead!.path) };
        entry.nativeRead = current;
        entry.nativeReads!.push(current);
        verifyHead(current.body);
        entry.status = 'mapped'; entry.reason = 'acknowledged-retained-field-adoption-and-support';
        context.disposition({ record: source.key, kind: 'field', path: evidence.path }, { status: 'mapped', reason: entry.reason,
          mapping: { target: target.id, readPath: target.kind === 'work' ? `/v1/works/${short(target.id)}`
            : `/v1/resources/${short(target.id)}/page`, receipt: { conversion: journal.conversions[source.key]!,
              native: entry.native, nativeRead: entry.nativeRead, nativeReads: entry.nativeReads,
              support: entry.support, supportRead: entry.supportRead } } });
      } catch (error) {
        entry.native ??= context.checkpoint(nativeLabel);
        entry.support ??= context.checkpoint(supportLabel);
        pending(entry, reason(stage, error));
      }
    }
  }
}
