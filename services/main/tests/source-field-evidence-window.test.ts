import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { projectDatasetFields } from '../../../scripts/datasets/native/fields.ts';
import { fusekiReadBudget, FusekiReadDeadlineExceeded } from '../src/infrastructure/fuseki.ts';
import {
  SourceRetainedFieldSupportStore,
  retainedAttachmentDigest,
  type RetainedPublicEvidence,
} from '../src/modules/source/field-support-retained.ts';
import { verifyRetainedField } from '../src/modules/source/field-support-evidence.ts';
import {
  SourceFieldProblem,
  type RetainedSupportRequest,
  type RetainedSupportAdmission,
  type VerifiedNativeAcknowledgement,
} from '../src/modules/source/field-support-contract.ts';
import { canonicalDigest } from '../src/modules/source/retained-record-normalization.ts';
import {
  WorkReadSession,
  WorkReadMoved,
  withWorkReadSession,
} from '../src/modules/work/read-session.ts';

// Exercise the actual Source projection and session with controlled SQL,
// custody, native and evidence ports. These prerequisites prove no installed
// native admission, public quotation grant or public API acceptance.
async function evidenceWindowFixture(visible = false) {
  const id = () => `https://rezics.com/id/${randomUUID()}`;
  const principalId = randomUUID(),
    supportId = randomUUID(),
    stepId = randomUUID();
  const principal = { issuer: 'https://account.test', subject: 'reader' };
  const record = {
    key: 'bangumi:episode:101',
    provider: 'bangumi',
    kind: 'episode',
    externalId: '101',
    title: 'Episode',
    native: 'episode',
    data: { id: 101, subject_id: 10, sort: 0.5, disc: 0, type: 1 },
  };
  const binding = {
    binding: id(),
    sourceRecord: id(),
    conversion: id(),
    recordDigest: canonicalDigest(record),
    mappingRevision: 'bangumi-episode-retained-map-v1',
    normalizationRevision: 'retained-record-json-v1',
  };
  const source = {
    key: record.key,
    provider: record.provider,
    namespace: record.kind,
    externalId: record.externalId,
    snapshot: 'snapshot',
    snapshotDigest: 'a'.repeat(64),
    recordDigest: binding.recordDigest,
    observations: [],
    intakes: [],
  };
  const evidence = {
    record,
    payload: { record },
    rule: 'dataset-record-envelope-v1',
    conversion: { retainedRecord: binding },
    fieldPlan: projectDatasetFields(record as never, source as never),
  };
  const native = {
    kind: 'structure-occurrence',
    owner: 'structure',
    target: id(),
    component: id(),
    structure: id(),
    profile: 'episode-list-v1',
    revision: id(),
    receipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
    occurrence: id(),
  } as const;
  const request: RetainedSupportRequest = {
    profile: 'source-field-support-attachment-v2',
    target: native.target,
    slot: 'structure-occurrence-v1#qualifier.values.position',
    occurrence: native.occurrence,
    context: native.structure,
    sourceRecord: binding.sourceRecord,
    conversion: binding.conversion,
    grain: 'episode',
    sourceField: 'sort',
    sourceOccurrence: null,
    expectedHead: native.revision,
    actingSubject: id(),
    native,
    evidence: {
      binding: binding.binding,
      recordDigest: binding.recordDigest,
      mappingRevision: binding.mappingRevision,
      field: { pointer: '/data/sort', presence: 'value', valueDigest: canonicalDigest(0.5) },
    },
  };
  const field = await verifyRetainedField(request, evidence as never);
  const acknowledgement: VerifiedNativeAcknowledgement = {
    receipt: native.receipt,
    admissionId: randomUUID(),
    scope: `work:edit:${native.target}`,
    action: 'work.edit',
    component: native.component,
    revision: native.revision,
    dataEpoch: randomUUID(),
    sequence: '1',
  };
  const admission: RetainedSupportAdmission = {
    profile: 'source-field-support-admission-v1',
    sourceRecord: binding.sourceRecord,
    conversion: binding.conversion,
    evidence: request.evidence,
    correspondence: field.correspondence,
    native,
    headGuarantee: 'verified-before-commit',
  };
  const digest = retainedAttachmentDigest(principalId, request, admission, acknowledgement);
  const saved = {
    support_id: supportId,
    step_id: stepId,
    request,
    request_digest: digest,
    retained_admission: admission,
    native_acknowledgement: acknowledgement,
    certificate: {
      profile: 'source-field-attachment-certificate-v1' as const,
      receipt: `urn:rezics:receipt:${'c'.repeat(64)}`,
      requestDigest: digest,
      nativeReceipt: native.receipt,
    },
    created_at: new Date('2026-10-20T00:00:00Z'),
    withdrawal_id: null as string | null,
    reason: null as string | null,
    withdrawn_at: null as Date | null,
  };
  const current: RetainedPublicEvidence = {
    id: binding.sourceRecord,
    sourceWork: null,
    representationSha256: 'a'.repeat(64),
    locator: { pointer: '/record/data/sort' },
    attribution: { sourceName: 'Bangumi', sourceUrl: 'https://bgm.tv/ep/101', licence: null },
    rightsBasis: {
      basisKind: 'unprotected_fact',
      basisRef: null,
      licenseExpression: null,
      notice: null,
      obligations: [],
      useScope: 'quotation',
      result: 'supported',
      memberOrdinals: [1],
    },
    quote: '0.5',
    quoteWithheld: false,
    language: { state: 'omitted' },
  };
  const state = {
    generation: '1',
    nativeHead: native.revision,
    custody: true,
    evidenceAvailable: true,
    projection: visible ? current : (null as RetainedPublicEvidence | null),
    denied: false,
    active: true,
    recovery: true,
  };
  const reads = { window: 0, native: 0, rights: 0, authority: 0 };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('field_support_generation'))
        return { rows: [{ generation: state.generation }], rowCount: 1 };
      if (sql.includes('SELECT s.id,s.principal_id')) {
        reads.window++;
        return { rows: [{ id: supportId, principal_id: principalId }], rowCount: 1 };
      }
      if (sql.includes('AS support_id')) return { rows: [structuredClone(saved)], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM source.retained_record_binding'))
        return { rows: [], rowCount: state.custody ? 1 : 0 };
      if (sql.startsWith('SELECT principal_id,conversion_id'))
        return {
          rows: [{ principal_id: principalId, conversion_id: binding.conversion.slice(-36) }],
          rowCount: 1,
        };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const deps = {
    environment: {},
    access: {
      activePrincipalId: async () => {
        reads.authority++;
        return state.active ? principalId : null;
      },
      assertRecoveryOpen: async () => {
        if (!state.recovery) throw new Error('Recovery closed');
      },
    },
  };
  const controller = new AbortController();
  const session = new WorkReadSession(
    deps as never,
    new Request('https://main.test/v1/evidence', { signal: controller.signal }),
    { actingSubject: request.actingSubject },
    { dataEpoch: acknowledgement.dataEpoch, sequence: '1' },
  );
  session.principal = principal;
  const store = new SourceRetainedFieldSupportStore(
    pool as never,
    {} as never,
    {} as never,
    { evidence: async () => (state.evidenceAvailable ? evidence : null) } as never,
    {
      structure: async () => {
        reads.native++;
        // The native owner registers its selected head on this same session.
        session.observeDependency(
          'selected-native-head',
          state.nativeHead,
          async () => state.nativeHead,
        );
        return acknowledgement;
      },
      publicEvidence: async () => {
        reads.rights++;
        if (state.denied) throw new SourceFieldProblem(403, 'rights_denied', 'Revoked');
        return state.projection;
      },
    },
  );
  const budget = {
    callsLeft: 100,
    bytesLeft: 1_048_576,
    deadline: Infinity,
    signal: controller.signal,
  };
  const selection = {
    target: native.target,
    slot: request.slot,
    occurrence: native.occurrence,
    context: native.structure,
    component: native.component,
    revision: native.revision,
  };
  const run = <T>(operation: () => Promise<T>) =>
    fusekiReadBudget.run(budget, () => withWorkReadSession(session, operation));
  return {
    store,
    session,
    selection,
    run,
    state,
    reads,
    budget,
    saved,
    current,
    controller,
    principalId,
    supportId,
    principal,
  };
}

test('stable retained Structure evidence window completes its final dependency fence', async () => {
  const r = await evidenceWindowFixture();
  await r.run(async () => {
    const window = await r.store.readEvidenceWindow(r.session, r.selection);
    expect(window).toEqual({ items: [], generation: '1', more: false, next: null });
    expect(r.reads.window).toBe(1);
    r.budget.deadline = performance.now() + 100;
    let failure: unknown;
    try {
      await r.session.fenceDependencies();
    } catch (error) {
      failure = error;
    }
    expect(
      failure,
      'unchanged input and withheld evidence must allow the final fence to complete',
    ).toBeUndefined();
    await r.session.fenceAuthority();
    expect(r.reads.window).toBe(2);
    expect(r.reads.native).toBe(2);
    expect(r.reads.authority).toBeGreaterThan(0);
  });
});

test('current Structure evidence and direct reads complete the same outer window fence', async () => {
  const r = await evidenceWindowFixture(true);
  await r.run(async () => {
    const window = await r.store.readEvidenceWindow(r.session, r.selection);
    expect(window.items).toEqual([r.current]);
    const direct = await r.store.read(
      r.principalId,
      r.supportId,
      undefined,
      r.principal,
      r.session,
    );
    expect(direct?.publicEvidence).toEqual(r.current);
    expect(direct?.attachment).toEqual(r.saved.certificate);
    expect(r.reads.authority).toBeGreaterThan(0);
    await r.session.fenceDependencies();
    await r.session.fenceAuthority();
    expect(r.reads.window).toBe(3);
    expect(r.reads.native).toBe(4);
    expect(window.items).toEqual([r.current]);
  });
});

for (const visible of [false, true]) {
  for (const change of [
    'native',
    'generation',
    'withdrawal',
    'rights',
    'custody',
    'evidence',
    'denied',
  ] as const) {
    test(`Structure window final fence refuses ${change} movement with ${visible ? 'current' : 'withheld'} evidence`, async () => {
      const r = await evidenceWindowFixture(visible);
      await r.run(async () => {
        await r.store.readEvidenceWindow(r.session, r.selection);
        if (change === 'native') r.state.nativeHead = `https://rezics.com/id/${randomUUID()}`;
        if (change === 'generation') r.state.generation = '2';
        if (change === 'withdrawal') {
          r.saved.withdrawal_id = randomUUID();
          r.saved.reason = 'Withdrawn';
          r.saved.withdrawn_at = new Date();
        }
        if (change === 'rights') {
          r.state.projection = visible ? null : r.current;
        }
        if (change === 'custody') r.state.custody = false;
        if (change === 'evidence') r.state.evidenceAvailable = false;
        if (change === 'denied') r.state.denied = true;
        const certificate = structuredClone(r.saved.certificate);
        if (change === 'denied') {
          await expect(r.session.fenceDependencies()).rejects.toMatchObject({
            status: 403,
            code: 'rights_denied',
          });
        } else if (change === 'custody') {
          await expect(r.session.fenceDependencies()).rejects.toMatchObject({
            status: 404,
            code: 'source_support_unavailable',
          });
        } else if (change === 'evidence') {
          await expect(r.session.fenceDependencies()).rejects.toMatchObject({
            status: 503,
            code: 'source_support_unavailable',
          });
        } else {
          await expect(r.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
        }
        expect(r.saved.certificate).toEqual(certificate);
      });
    });
  }
}

test('Structure window final authority, cancellation and deadline remain enforced', async () => {
  for (const change of ['principal', 'recovery', 'cancelled', 'deadline'] as const) {
    const r = await evidenceWindowFixture(true);
    await r.run(async () => {
      await r.store.readEvidenceWindow(r.session, r.selection);
      if (change === 'principal' || change === 'recovery') {
        await r.session.fenceDependencies();
        if (change === 'principal') r.state.active = false;
        else r.state.recovery = false;
        await expect(r.session.fenceAuthority()).rejects.toBeDefined();
      } else {
        if (change === 'cancelled')
          r.controller.abort(new Error('Cancelled before final emission'));
        else r.budget.deadline = performance.now() - 1;
        if (change === 'deadline') {
          await expect(r.session.fenceDependencies()).rejects.toBeInstanceOf(
            FusekiReadDeadlineExceeded,
          );
        } else {
          await expect(r.session.fenceDependencies()).rejects.toBeDefined();
        }
      }
    });
  }
});
