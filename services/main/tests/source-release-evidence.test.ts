import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { checkedRealization } from '../src/modules/realization/schema.ts';
import { checkedReleaseV2, resolvedReleaseV2 } from '../src/modules/release/schema.ts';
import { retainedFieldPlan } from '../src/modules/source/retained-record.ts';
import { verifyRetainedField } from '../src/modules/source/field-support-evidence.ts';
import type { RetainedSupportRequest, RetainedSupportAdmission, VerifiedNativeAcknowledgement,
  RetainedConversionRequest } from '../src/modules/source/field-support-contract.ts';
import { retainedAttachmentDigest } from '../src/modules/source/field-support-retained.ts';
import type { VerifiedRetainedRecordEvidence, PublicRetainedFieldEvidence } from '../src/modules/source/retained-evidence.ts';
import { canonicalDigest } from '../src/modules/source/retained-record-normalization.ts';
import type { ReleaseSourceNativeBasis, RealizationSourceNativeBasis } from '../src/modules/source/release-native-verifier.ts';
import { SourceReleaseEvidenceOwner, releaseSourceEvidence } from '../src/modules/source/release-evidence.ts';
import { RELEASE_EVIDENCE_COST } from '../src/modules/source/release-evidence-contract.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { RV } from '../src/modules/work/activate.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const custodian = id(20).slice(-36), actor = id(21), work = id(1), release = id(2), text = id(3);
const revision = id(4), textRevision = id(5);
const reference = { provider: 'vndb',namespace: 'release',externalId: 'r1',sourceRevision: null,
  datasetSnapshotDigest: 'a'.repeat(64),fieldLocator: '/data/tables/releases_platforms/0/platform',
  record: id(10),observation: id(12),href: 'https://vndb.org/r1' };

async function fixture(ownerKind: 'release' | 'realization' = 'release') {
  const record: DatasetRecord = { key: 'vndb:release:r1',provider: 'vndb',kind: 'release',externalId: 'r1',
    title: 'Captured release',language: 'ja',sourceUrl: reference.href,native: 'release',data: {
      id: 'r1',olang: 'ja',official: 't',released: '20049999',tables: {
        releases_platforms: [{ platform: 'win' }],releases_titles: [{ lang: 'ja',mtl: false }],
        releases_vn: [{ vid: 'v1',rtype: 'complete' }],
      },
    } };
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'vndb-release-retained-map-v2',retained: {
      identity: { key: record.key,provider: 'vndb',namespace: 'release',externalId: 'r1' },
      record,recordDigest: canonicalDigest(record),snapshot: { id: 'captured-release',digest: reference.datasetSnapshotDigest,
        fileSha256: 'b'.repeat(64) },intakes: [{ index: 0,record: id(11),observation: reference.observation,byteDigest: 'c'.repeat(64) }],
      payload: { format: 'json',byteDigest: 'c'.repeat(64),byteLength: 100 },
    } };
  const plan = await retainedFieldPlan(request);
  const platform = plan.fields.find(field => field.native?.owner === ownerKind
    && field.native.predicate === `${RV}${ownerKind === 'release' ? 'platform' : 'contentLanguage'}`)!;
  expect(platform).toBeDefined();
  const coordinate = platform.evidence[0]!;
  const receipt = workEditReceiptIri(id(30).slice(-36)), textReceipt = workEditReceiptIri(id(31).slice(-36));
  const releaseNative: ReleaseSourceNativeBasis = { kind: 'component-property',owner: 'release',target: work,
    component: release,revision,receipt,expectedHead: revision,property: platform.native!.property!,
    coverage: { realization: { component: text,revision: textRevision,receipt: textReceipt,expectedHead: textRevision },
      completeness: 'complete' } };
  const native: ReleaseSourceNativeBasis | RealizationSourceNativeBasis = ownerKind === 'release' ? releaseNative : {
    ...releaseNative.coverage.realization,kind: 'component-property',owner: 'realization',target: work,
    property: platform.native!.property!,release: { component: release,revision,receipt,expectedHead: revision },completeness: 'complete',
  };
  const input: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2',target: work,
    slot: `component-property-v1#${native.property.predicate}`,occurrence: native.component,context: 'global',sourceRecord: reference.record,
    conversion: id(13),grain: 'release',sourceField: coordinate.path.slice(6),sourceOccurrence: null,
    expectedHead: native.revision,actingSubject: actor,native,evidence: { binding: id(14),
      recordDigest: request.retained.recordDigest,mappingRevision: request.mappingRevision,
      field: { pointer: coordinate.path,presence: 'value',valueDigest: canonicalDigest(ownerKind === 'release' ? 'win' : 'ja'),
        ...(Object.hasOwn(coordinate,'language') ? { language: coordinate.language } : {}),
        ...(coordinate.ordinal !== undefined ? { ordinal: coordinate.ordinal } : {}) } } };
  const evidence: VerifiedRetainedRecordEvidence = {
    request,record,payload: { record },rule: 'dataset-record-envelope-v1',
    fieldPlan: plan,observations: [{ profile: 'source-manual-intake-v1',state: 'staged',provider: 'vndb',
      namespace: 'release',externalId: 'r1',sourceRevision: request.retained.snapshot.digest,record: id(11),
      observation: reference.observation,retention: 'retained',mediaType: 'application/json',byteDigest: 'c'.repeat(64),
      byteLength: 100,coverage: { scope: 'captured-shape',complete: true,omittedFields: [] },
      rightsEvidence: { basis: 'facts',note: 'Owner shape' },submittedAt: '2026-10-19' }],
    conversion: { profile: 'source-retained-record-conversion-v1',state: 'staged',conversion: input.conversion,
      observation: reference.observation,mappingRevision: request.mappingRevision,sourceDigest: 'c'.repeat(64),
      fieldInventory: [],createdAt: '2026-10-19',retainedRecord: { profile: 'source-retained-record-binding-v1',
        binding: input.evidence.binding,sourceRecord: reference.record,conversion: input.conversion,
        mappingRevision: request.mappingRevision,normalizationRevision: 'dataset-record-normalization-v1',
        identity: request.retained.identity,snapshot: request.retained.snapshot,recordDigest: request.retained.recordDigest,
        intakes: request.retained.intakes,payload: request.retained.payload } },
  };
  const field = await verifyRetainedField(input,evidence);
  const admission: RetainedSupportAdmission = { profile: 'source-field-support-admission-v1',
    sourceRecord: input.sourceRecord,conversion: input.conversion,evidence: input.evidence,native,
    correspondence: field.correspondence,headGuarantee: 'verified-before-commit' };
  const acknowledgement: VerifiedNativeAcknowledgement = { receipt: native.receipt,
    admissionId: id(ownerKind === 'release' ? 30 : 31).slice(-36),
    dataEpoch: 'owner-epoch',sequence: ownerKind === 'release' ? '8' : '7',scope: `work:edit:${work}`,
    action: 'work.edit',component: native.component,revision: native.revision,
    release: { currentHeads: { release: revision,realization: textRevision },correspondence: {
      work,release: releaseNative,realization: releaseNative.coverage.realization,completeness: 'complete',language: 'ja',
    } } };
  const requestDigest = retainedAttachmentDigest(custodian,input,admission,acknowledgement);
  const saved = { principal_id: custodian,support_id: id(40).slice(-36),step_id: id(41).slice(-36),request: input,
    retained_admission: admission,native_acknowledgement: acknowledgement,request_digest: requestDigest,
    attachment_receipt: `urn:rezics:receipt:${'d'.repeat(64)}`,certificate: {
      profile: 'source-field-attachment-certificate-v1' as const,receipt: `urn:rezics:receipt:${'d'.repeat(64)}`,
      requestDigest,nativeReceipt: native.receipt } };
  const realization = checkedRealization({ profile: 'realization-v1',id: text,expectedHead: null,actingSubject: actor,
    language: 'ja',kind: 'original',translators: [],publishers: [],source: { kind: 'unresolved',work },
    status: 'official',verification: 'verified',evidence: reference.href },work);
  const releaseRecord = resolvedReleaseV2(checkedReleaseV2({ profile: 'release-v2',id: release,expectedHead: null,
    actingSubject: actor,kind: 'formal',status: 'official',title: { value: record.title,language: 'ja' },
    titleLanguage: null,tracklistLanguage: null,publisher: null,publicationYear: 2004,editionStatement: null,
    isbn13: null,originalUrl: null,fixedRelease: null,evidence: null,identifiers: [],platform: 'win',territory: null,
    coverage: [{ realization: text,revision: textRevision,completeness: 'complete' }] },work),
  [{ realization: text,revision: textRevision,work,language: 'ja',kind: 'original',status: 'official' }]);
  const selection = { owner: ownerKind,component: native.component,revision: native.revision };
  let rows = [saved], visible = true, available = true, nativeCalls = 0, projections = 0;
  const sql: string[] = [];
  const pool = { async query(query: string,values: unknown[]) {
    sql.push(query);
    expect(values).toEqual([selection.component,selection.revision,ownerKind,RELEASE_EVIDENCE_COST.supports + 1]);
    return { rows };
  } } as unknown as Pool;
  const owner = new SourceReleaseEvidenceOwner(pool,{ async evidence(principal,conversion) {
    expect([principal,conversion]).toEqual([custodian,input.conversion]);
    return evidence;
  } },{ async projectPublicRetainedFieldForReader(context,actual,pointer) {
    projections++;
    expect(context.principal).toBeNull();
    expect(actual).toBe(evidence);
    expect(pointer).toBe(`/record${coordinate.path}`);
    if (!visible) return null;
    return { id: reference.record,attribution: { sourceUrl: reference.href } } as PublicRetainedFieldEvidence;
  } },async (_env,actual) => {
    nativeCalls++;
    expect(actual.principal).toBeNull();
    expect(actual.release.revision).toBe(revision);
    expect(actual.realization.revision).toBe(textRevision);
    if (!available) return { status: 'unavailable',reason: 'undisclosed-native-owner' };
    const command = { receipt,admissionId: id(30).slice(-36),
      dataEpoch: 'owner-epoch',sequence: '8',scope: acknowledgement.scope,outcome: 'succeeded' as const,
      release,work,revision,requestDigest: 'e'.repeat(64),authorityEpoch: '0' };
    return { status: 'available',release: { record: releaseRecord,receipt: command,head: id(80) },
      realization: { status: 'available',record: realization,head: id(81),receipt: { ...command,
        receipt: textReceipt,admissionId: id(31).slice(-36),sequence: '7',realization: text,revision: textRevision } } };
  });
  const deps = { sourceReleaseEvidence: owner,environment: {},access: { assertRecoveryOpen: async () => {} } } as
    unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps,new Request('https://rezics.test/v1/releases'),{},
    { dataEpoch: 'owner-epoch',sequence: '8' });
  return { owner,session,selection,evidence,saved,sql,releaseRecord,
    rows: (value: typeof rows) => { rows = value; },visible: (value: boolean) => { visible = value; },
    available: (value: boolean) => { available = value; },counters: () => ({ nativeCalls,projections }) };
}

test('public list/detail projection retains exact source identity, nullable revision and actual custody anchor', async () => {
  const f = await fixture();
  const before = canonicalJson({ saved: f.saved,evidence: f.evidence,release: f.releaseRecord });
  const expected = [{ ...reference,recordDigest: f.evidence.conversion.retainedRecord.recordDigest }];
  expect(await releaseSourceEvidence(f.session(),f.selection)).toEqual(expected);
  expect(await f.owner.read(f.session(),f.selection)).toEqual(expected);
  expect(canonicalJson({ saved: f.saved,evidence: f.evidence,release: f.releaseRecord })).toBe(before);
  expect(f.sql.every(sql => sql.includes('h.settled_step_id=st.id')
    && sql.includes('source.field_support_withdrawal') && sql.includes('LIMIT $4'))).toBe(true);
  expect(JSON.stringify(expected)).not.toMatch(/binding|certificate|conversion|principal|nativeReceipt/);
  expect(f.counters()).toEqual({ nativeCalls: 2,projections: 2 });
});

test('realization evidence remains on its own exact covered text and retained language field', async () => {
  const f = await fixture('realization');
  expect(await f.owner.read(f.session(),f.selection)).toEqual([{ ...reference,
    fieldLocator: f.saved.request.evidence.field.pointer,
    recordDigest: f.evidence.conversion.retainedRecord.recordDigest }]);
  expect(f.selection).toEqual({ owner: 'realization',component: text,revision: textRevision });
  expect(f.saved.native_acknowledgement.receipt).not.toBe(f.saved.request.native.owner === 'realization'
    ? f.saved.request.native.release.receipt : null);
});

test('independent duplicate supports preserve storage and project one disclosed reference; withdrawal is fenced', async () => {
  const f = await fixture();
  f.rows([f.saved,{ ...f.saved,support_id: id(50),step_id: id(51) }]);
  const session = f.session();
  expect(await f.owner.read(session,f.selection)).toHaveLength(1);
  expect(f.counters().nativeCalls).toBe(1);
  f.rows([]);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('private or unavailable native/source evidence is omitted and current disclosure changes invalidate delivery', async () => {
  const f = await fixture();
  const session = f.session();
  expect(await f.owner.read(session,f.selection)).toHaveLength(1);
  f.visible(false);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  expect(await f.owner.read(f.session(),f.selection)).toEqual([]);
  f.visible(true); f.available(false);
  expect(await f.owner.read(f.session(),f.selection)).toEqual([]);
});

test('a malformed certificate, wrong selected revision or bounded overflow cannot earn mapped public evidence', async () => {
  const f = await fixture();
  f.saved.certificate.nativeReceipt = id(77);
  await expect(f.owner.read(f.session(),f.selection)).rejects.toBeInstanceOf(WorkReadUnavailable);
  f.saved.certificate.nativeReceipt = f.saved.native_acknowledgement.receipt;
  f.saved.request.native.revision = id(78);
  await expect(f.owner.read(f.session(),f.selection)).rejects.toBeInstanceOf(WorkReadUnavailable);
  f.rows(Array.from({ length: RELEASE_EVIDENCE_COST.supports + 1 },() => f.saved));
  await expect(f.owner.read(f.session(),f.selection)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('native reads without retained supports or the optional retained owner need no conversion or mapper', async () => {
  const f = await fixture();
  f.rows([]);
  expect(await f.owner.read(f.session(),f.selection)).toEqual([]);
  const session = f.session();
  delete session.deps.sourceReleaseEvidence;
  expect(await releaseSourceEvidence(session,f.selection)).toEqual([]);
  expect(f.counters()).toEqual({ nativeCalls: 0,projections: 0 });
});
