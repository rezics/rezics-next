import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fusekiReadBudget, FusekiReadDeadlineExceeded } from '../src/infrastructure/fuseki.ts';
import { Value } from 'typebox/value';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import {
  startPostgresCluster,
  type PostgresCluster,
} from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { SourceRetainedRecordStore } from '../src/modules/source/retained-record.ts';
import {
  canonicalDigest,
  sourceDigest,
} from '../src/modules/source/retained-record-normalization.ts';
import {
  SourceFieldProblem,
  type RetainedSupportRequest,
} from '../src/modules/source/field-support-contract.ts';
import { verifyRetainedField } from '../src/modules/source/field-support-evidence.ts';
import { verifySourceNative } from '../src/modules/source/field-support-native.ts';
import { retainedSupportRequest } from '../src/modules/source/field-support-schema.ts';
import { SourceRetainedFieldSupportStore } from '../src/modules/source/field-support-retained.ts';
import { acknowledgedStructureSupportOwners } from '../src/modules/source/field-support-structure.ts';
import { SourceFieldWithdrawalStore } from '../src/modules/source/withdrawal.ts';
import {
  WorkReadMoved,
  WorkReadSession,
  withWorkReadSession,
} from '../src/modules/work/read-session.ts';
import type { AcknowledgedStructureOccurrence } from '../src/modules/structure/native-basis.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import {
  structureParentBinding,
  structurePrincipal,
  structureSourceFixture,
} from './source-field-structure-fixture.ts';

let cluster: PostgresCluster, pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  await migrateContent(pool);
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

async function retainedEpisode(data: Record<string, unknown> = { sort: 0.5, disc: 0, type: 1 }, omitParent = false) {
  const principalId = randomUUID(),
    externalId = String(Number.parseInt(randomUUID().slice(0, 8), 16));
  const subjectId = String(Number.parseInt(randomUUID().slice(0, 8), 16));
  const record: DatasetRecord = {
    key: `bangumi:episode:${externalId}`,
    provider: 'bangumi',
    kind: 'episode',
    externalId,
    title: '原作 第零点五話',
    language: '',
    sourceUrl: `https://bgm.tv/ep/${externalId}`,
    native: 'episode',
    data: { id: Number(externalId), ...(omitParent ? {} : { subject_id: Number(subjectId) }), ...data },
  };
  const snapshot = {
    id: 'source-episode-owner-shape',
    digest: 'a'.repeat(64),
    fileSha256: 'b'.repeat(64),
  };
  const bytes = Buffer.from(
    canonicalJson({
      format: 'rezics-dataset-record-v1',
      snapshot: snapshot.id,
      digest: snapshot.digest,
      record,
      edges: [],
      images: [],
    }),
  );
  const intake = new SourceIntakeStore(pool);
  const observation = (
    await intake.submit(principalId, randomUUID(), {
      provider: 'bangumi',
      namespace: 'episode',
      externalId,
      sourceRevision: snapshot.digest,
      mediaType: 'application/json',
      retention: 'retained',
      rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: 'captured-shape', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'facts', note: 'Isolated retained Episode owner regression' },
    })
  ).observation;
  const records = new SourceRetainedRecordStore(pool, intake);
  const converted = await records.convert(principalId, observation.observation.slice(-36), {
    profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'bangumi-episode-retained-map-v1',
    retained: {
      identity: { key: record.key, provider: 'bangumi', namespace: 'episode', externalId },
      snapshot,
      record,
      recordDigest: canonicalDigest(record),
      payload: { format: 'json', byteDigest: sourceDigest(bytes), byteLength: bytes.length },
      intakes: [
        {
          index: 0,
          record: observation.record,
          observation: observation.observation,
          byteDigest: observation.byteDigest!,
        },
      ],
    },
  });
  const evidence = (await records.evidence(principalId, converted.conversion.conversion))!;
  const binding = converted.conversion.retainedRecord;
  const f = await structureSourceFixture(record.key, externalId);
  const parent = await structureParentBinding(pool, f, subjectId, principalId);
  const owners = acknowledgedStructureSupportOwners({ sourceAdoptions: parent.adoptions });
  const input = (
    native = f.basis,
    field: 'sort' | 'disc' | 'type' = 'sort',
  ): RetainedSupportRequest => ({
    profile: 'source-field-support-attachment-v2',
    target: native.target,
    slot: `structure-occurrence-v1#qualifier.values.${field === 'sort' ? 'position' : field === 'type' ? 'kindCode' : 'disc'}`,
    occurrence: native.occurrence,
    context: native.structure,
    sourceRecord: binding.sourceRecord,
    conversion: binding.conversion,
    grain: 'episode',
    sourceField: field,
    sourceOccurrence: null,
    expectedHead: native.revision,
    actingSubject: f.actor,
    native,
    evidence: {
      binding: binding.binding,
      recordDigest: binding.recordDigest,
      mappingRevision: binding.mappingRevision,
      field: {
        pointer: `/data/${field}`,
        presence: 'value',
        valueDigest: canonicalDigest(data[field]),
      },
    },
  });
  const verify = async (request = input()) => {
    const selected = (await verifyRetainedField(request, evidence)).selected,
      session = f.session();
    return withWorkReadSession(session, () =>
      verifySourceNative(f.environment, request, owners, true, {
        principal: structurePrincipal,
        selected,
        session,
        evidence,
      }),
    );
  };
  return {
    ...f,
    parent,
    principalId,
    record,
    recordStore: records,
    evidence,
    input,
    verify,
    owners,
  };
}

function storeFor(
  r: Awaited<ReturnType<typeof retainedEpisode>>,
  controls: {
    beforeOwner?: () => Promise<void>;
    reuse?: () => Promise<void>;
    projection?: () => Promise<null>;
  } = {},
) {
  const access: Pick<AccessAdmissionRegistry, 'withOwnerAuthority'> = {
    withOwnerAuthority: async (request, operation) => {
      expect(request).toMatchObject({
        principal: structurePrincipal,
        actingSubject: r.actor,
        action: 'work.edit',
        scope: `work:edit:${r.basis.target}`,
      });
      await controls.beforeOwner?.();
      const client = await pool.connect();
      try {
        return await operation(client);
      } finally {
        client.release();
      }
    },
  };
  return new SourceRetainedFieldSupportStore(pool, r.environment, access, r.recordStore, {
    ...r.owners,
    authorizeReuse: async () => {
      await controls.reuse?.();
    },
    publicEvidence: async () => (controls.projection ? controls.projection() : null),
  });
}
const count = async (principalId: string) =>
  (
    await pool.query(
      'SELECT count(*)::integer AS n FROM source.field_support_step WHERE principal_id=$1',
      [principalId],
    )
  ).rows[0].n;

test('Structure support consumes exact retained 0.5/0/1, actual terminal receipt and same-revision ancestry', async () => {
  const r = await retainedEpisode();
  for (const field of ['sort', 'disc', 'type'] as const) {
    const input = r.input(r.basis, field);
    expect(Value.Check(retainedSupportRequest as never, input)).toBe(true);
    const selected = (await verifyRetainedField(input, r.evidence)).selected;
    expect(selected).toEqual({ value: r.record.data[field], language: { state: 'omitted' } });
    const ack = await r.verify(input);
    expect(ack).toMatchObject({
      receipt: r.basis.receipt,
      admissionId: expect.any(String),
      action: 'work.edit',
      scope: `work:edit:${r.basis.target}`,
      component: r.basis.component,
      revision: r.basis.revision,
      dataEpoch: r.dataEpoch,
      sequence: '1',
      structure: {
        native: r.basis,
        sourceBinding: r.parent.bindingId,
        operation: r.operations.get(r.basis.receipt),
        manifest: r.header().manifest,
        headGuarantee: 'verified-before-commit',
        record: r.records[1],
        path: [r.records[0]],
        commandReceipt: {
          receipt: r.basis.receipt,
          action: 'work.edit',
          structure: r.basis.structure,
          revision: r.basis.revision,
          outcome: 'succeeded',
        },
      },
    });
    expect(ack.admissionId).not.toBe(r.basis.occurrence);
  }
  const store = storeFor(r),
    session = r.session(),
    key = randomUUID();
  const attached = await withWorkReadSession(session, () =>
    store.attach(structurePrincipal, r.principalId, key, r.input(), session),
  );
  const saved = await withWorkReadSession(r.session(), () =>
    store.read(r.principalId, attached.support, attached.step, structurePrincipal),
  );
  expect(saved).toMatchObject({
    graphReceipt: r.basis.receipt,
    headGuarantee: 'verified-before-commit',
    attachment: { nativeReceipt: r.basis.receipt },
    admission: { native: r.basis },
  });
  const replay = await withWorkReadSession(r.session(), () =>
    store.attach(structurePrincipal, r.principalId, key, r.input()),
  );
  expect(replay).toEqual({ ...attached, replayed: true });
  expect(await count(r.principalId)).toBe(1);
});

test('Structure support refuses wrong receipt, head, child, ancestor, disc, scheme and original retained placement without settlement', async () => {
  const r = await retainedEpisode(),
    store = storeFor(r);
  const refused = async (native: AcknowledgedStructureOccurrence, expected: object) => {
    await expect(
      withWorkReadSession(r.session(), () =>
        store.attach(structurePrincipal, r.principalId, randomUUID(), r.input(native)),
      ),
    ).rejects.toMatchObject(expected);
    expect(await count(r.principalId)).toBe(0);
  };
  await refused(
    { ...r.basis, receipt: `urn:rezics:receipt:${'0'.repeat(64)}` },
    { status: 503, code: 'source_support_unavailable' },
  );
  await refused(
    { ...r.basis, revision: derivedId(randomUUID()) },
    { status: 409, basis: 'native-head' },
  );
  await refused({ ...r.basis, occurrence: r.second }, { status: 409, basis: 'native-value' });
  r.readable(false);
  await refused(r.basis, { status: 403 });
  r.readable(true);
  r.parent.available(false);
  await refused(r.basis, { status: 503 });
  r.parent.available(true);
  r.terminalAvailable(false);
  await refused(r.basis, { status: 503 });
  r.terminalAvailable(true);
  const later = await r.install(r.records);
  await refused({ ...later, receipt: r.basis.receipt }, { status: 409, basis: 'native-head' });
  for (const change of ['disc', 'scheme', 'ancestor', 'sourceKey', 'retired'] as const) {
    const records = structuredClone(r.records);
    const child = records[1]!;
    if (change === 'disc' || change === 'scheme') {
      if (child.qualifier?.type !== 'fields') throw new Error('Actual field qualifier required');
      child.qualifier.values[change === 'disc' ? 'disc' : 'kindScheme'] =
        change === 'disc' ? { numerator: 1, denominator: 1 } : 'invented:episode:type';
    } else if (change === 'ancestor') {
      const parent = records[0]!;
      parent.state = 'removed';
      parent.removedBy = derivedId(randomUUID());
      delete parent.orderKey;
      delete parent.segmentKey;
    } else if (change === 'sourceKey') child.sourceKey = 'bangumi:episode:other';
    else {
      child.state = 'removed';
      child.removedBy = derivedId(randomUUID());
      delete child.orderKey;
      delete child.segmentKey;
    }
    const basis = await r.install(records);
    await refused(
      basis,
      change === 'ancestor' || change === 'retired'
        ? { status: 409, basis: 'native-head' }
        : { status: 409, basis: change === 'sourceKey' ? 'native-target' : 'native-value' },
    );
  }
  const request = r.input(await r.install(r.records));
  request.sourceOccurrence = r.first;
  await expect(
    withWorkReadSession(r.session(), () =>
      store.attach(structurePrincipal, r.principalId, randomUUID(), request),
    ),
  ).rejects.toMatchObject({ status: 422, code: 'source_coordinate_invalid' });
  expect(await count(r.principalId)).toBe(0);
});

test('Structure correspondence consumes the independent selected value and language and refuses absent placement evidence', async () => {
  const r = await retainedEpisode();
  for (const selected of [
    { value: 1, language: { state: 'omitted' as const } },
    { value: 0.5, language: { state: 'value' as const, value: 'ja' } },
  ]) {
    const session = r.session();
    await expect(
      withWorkReadSession(session, () =>
        verifySourceNative(r.environment, r.input(), r.owners, true, {
          principal: structurePrincipal,
          selected,
          session,
          evidence: r.evidence,
        }),
      ),
    ).rejects.toMatchObject({ status: 409, basis: 'evidence-binding' });
  }
  const missing = await retainedEpisode({ sort: 0.5 }, true);
  await expect(
    withWorkReadSession(missing.session(), () =>
      storeFor(missing).attach(
        structurePrincipal,
        missing.principalId,
        randomUUID(),
        missing.input(),
      ),
    ),
  ).rejects.toMatchObject({ status: 503, code: 'source_support_unavailable' });
  expect(await count(missing.principalId)).toBe(0);
});

test('Structure support fences movement, denial, missing evidence and cancellation before Source commit', async () => {
  const r = await retainedEpisode();
  const moved = storeFor(r, {
    beforeOwner: async () => {
      await r.install(r.records);
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      moved.attach(structurePrincipal, r.principalId, randomUUID(), r.input()),
    ),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  expect(await count(r.principalId)).toBe(0);
  const basis = await r.install(r.records);
  let reuse = 0;
  const revoked = storeFor(r, {
    reuse: async () => {
      if (++reuse > 1) throw new SourceFieldProblem(403, 'rights_denied', 'Revoked');
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      revoked.attach(structurePrincipal, r.principalId, randomUUID(), r.input(basis)),
    ),
  ).rejects.toMatchObject({ status: 403, code: 'rights_denied' });
  expect(await count(r.principalId)).toBe(0);
  const controller = new AbortController();
  controller.abort();
  // workRead supplies this budget in production; a bare session has no
  // cancellation scope of its own.
  const aborted = new WorkReadSession(
    r.dependencies,
    new Request('https://main.test/cancelled', { signal: controller.signal }),
    { actingSubject: r.actor },
    { dataEpoch: r.dataEpoch, sequence: '1' },
  );
  aborted.principal = structurePrincipal;
  await expect(
    fusekiReadBudget.run({ signal: controller.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      withWorkReadSession(aborted, () =>
        storeFor(r).attach(structurePrincipal, r.principalId, randomUUID(), r.input(basis)),
      ),
    ),
  ).rejects.toBeDefined();
  expect(await count(r.principalId)).toBe(0);
  const during = new AbortController(),
    reason = new Error('Cancelled before Source settlement');
  const cancelled = storeFor(r, {
    beforeOwner: async () => {
      during.abort(reason);
    },
  });
  await expect(
    fusekiReadBudget.run({ signal: during.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      withWorkReadSession(r.session(), () =>
        cancelled.attach(structurePrincipal, r.principalId, randomUUID(), r.input(basis)),
      ),
    ),
  ).rejects.toBe(reason);
  expect(await count(r.principalId)).toBe(0);
  const budget = {
    signal: new AbortController().signal,
    callsLeft: 100,
    bytesLeft: 1_048_576,
    deadline: Infinity,
  };
  const expired = storeFor(r, {
    beforeOwner: async () => {
      budget.deadline = performance.now() - 1;
    },
  });
  await expect(
    fusekiReadBudget.run(budget, () =>
      withWorkReadSession(r.session(), () =>
        expired.attach(structurePrincipal, r.principalId, randomUUID(), r.input(basis)),
      ),
    ),
  ).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
  expect(await count(r.principalId)).toBe(0);
  const noSession = storeFor(r);
  await expect(
    noSession.attach(structurePrincipal, r.principalId, randomUUID(), r.input(basis)),
  ).rejects.toMatchObject({ status: 503, code: 'source_support_unavailable' });
});

test('Structure settlement and evidence emission fence the current Episode target profile and owner disclosure', async () => {
  const r = await retainedEpisode();
  const changed = storeFor(r, {
    beforeOwner: async () => {
      r.targetTypes(['https://schema.org/CreativeWork']);
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      changed.attach(structurePrincipal, r.principalId, randomUUID(), r.input()),
    ),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  expect(await count(r.principalId)).toBe(0);
  r.targetTypes(['https://schema.org/TVEpisode']);
  const denied = storeFor(r, {
    beforeOwner: async () => {
      r.disclosed(false);
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      denied.attach(structurePrincipal, r.principalId, randomUUID(), r.input()),
    ),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  expect(await count(r.principalId)).toBe(0);
  r.disclosed(true);
  const store = storeFor(r);
  const attached = await withWorkReadSession(r.session(), () =>
    store.attach(structurePrincipal, r.principalId, randomUUID(), r.input()),
  );
  const moving = storeFor(r, {
    projection: async () => {
      r.targetTypes(['https://schema.org/CreativeWork']);
      return null;
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      moving.read(r.principalId, attached.support, attached.step, structurePrincipal),
    ),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  const historical = (await store.read(
    r.principalId,
    attached.support,
    attached.step,
    structurePrincipal,
  ))!;
  expect(historical.publicEvidence).toBeNull();
  expect(historical.attachment.nativeReceipt).toBe(r.basis.receipt);
});

test('Structure replay retains its immutable certificate while current emission and independent withdrawal remain fenced', async () => {
  const r = await retainedEpisode(),
    other = await retainedEpisode();
  const store = storeFor(r),
    otherStore = storeFor(other),
    key = randomUUID(),
    originalInput = r.input();
  const attach = await withWorkReadSession(r.session(), () =>
    store.attach(structurePrincipal, r.principalId, key, originalInput),
  );
  const second = await withWorkReadSession(other.session(), () =>
    otherStore.attach(structurePrincipal, other.principalId, randomUUID(), other.input()),
  );
  const original = (await store.read(
    r.principalId,
    attach.support,
    attach.step,
    structurePrincipal,
  ))!;
  let projections = 0;
  const movingRead = storeFor(r, {
    projection: async () => {
      if (++projections === 1) await r.install(r.records);
      return null;
    },
  });
  await expect(
    withWorkReadSession(r.session(), () =>
      movingRead.read(r.principalId, attach.support, attach.step, structurePrincipal),
    ),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  const historical = (await store.read(
    r.principalId,
    attach.support,
    attach.step,
    structurePrincipal,
  ))!;
  expect(historical.attachment).toEqual(original.attachment);
  expect(historical.publicEvidence).toBeNull();
  const replayed = await withWorkReadSession(r.session(), () =>
    store.attach(structurePrincipal, r.principalId, key, originalInput),
  );
  expect(replayed).toEqual({ ...attach, replayed: true });
  await expect(
    withWorkReadSession(r.session(), () =>
      store.attach(structurePrincipal, r.principalId, randomUUID(), originalInput),
    ),
  ).rejects.toMatchObject({ status: 409, basis: 'native-head' });
  expect(await count(r.principalId)).toBe(1);
  const receipts = structuredClone([...r.receipts.entries()]),
    manifest = r.header().manifest;
  await new SourceFieldWithdrawalStore(pool, r.environment, store).withdraw(
    r.principalId,
    randomUUID(),
    {
      support: attach.support,
      expectedSupport: original.supportIdentity,
      reason: 'Record support withdrawn',
    },
  );
  expect(
    (await store.read(r.principalId, attach.support, attach.step, structurePrincipal))?.withdrawal
      ?.state,
  ).toBe('withdrawn');
  expect(
    (
      await withWorkReadSession(other.session(), () =>
        otherStore.read(other.principalId, second.support, second.step, structurePrincipal),
      )
    )?.state,
  ).toBe('recorded');
  expect([...r.receipts.entries()]).toEqual(receipts);
  expect(r.header().manifest).toBe(manifest);
});
