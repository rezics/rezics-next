import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { StructureStageStore, type StructureStage }
  from '../../../services/main/src/modules/structure/stage.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

test('COMP03/COMP04: staged pages checkpoint under a lease and activation rechecks target authority', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-stage-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, structureObjects: objects,
    structureStages: new StructureStageStore(f.pool, objects) });
  const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${f.account.tokenA}`,
      'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const book = await json<{ work: string; mainVersion: string }>(await call('POST', '/v1/works',
      { profile: 'metadata-only-v1', title: 'Stage Book',
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }), 201);
    const editGrant = await f.grant(`work:edit:${book.work}`, 'work.edit');
    await f.grant(`work:read:${book.work}`, 'work.read');
    const created = await json<{ structure: string; revision: string }>(await call('POST',
      '/v1/compositions', { profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: f.actor }), 201);
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const stages = `${path}/stages`;
    const createStage = async (expectedHead = created.revision) => json<StructureStage>(
      await call('POST', stages, { expectedHead, actingSubject: f.actor }), 201);
    const page = (stage: StructureStage, ordinal: number, record: object | object[],
      holder = stage.holder, fence = stage.fence) => call('PUT',
      `${stages}/${stage.id}/pages/${ordinal}`, { actingSubject: f.actor, holder, fence,
        entries: Array.isArray(record) ? record : [record] });
    const group = (stage: StructureStage, key: string) => ({ occurrence: nativeId(),
      state: 'active', parent: created.structure, segmentKey: 'a', orderKey: key,
      role: 'group', labels: [], introducedBy: stage.revision });
    const read = async () => json<{ revision: string; occurrences: object[] }>(await call('GET',
      `${path}?actingSubject=${encodeURIComponent(f.actor)}`), 200);

    const interrupted = await createStage();
    const batch = (start: number) => Array.from({ length: 16 }, (_, index) => {
      const ordinal = start + index;
      return { ...group(interrupted, (ordinal % 32).toString(36)),
        segmentKey: ordinal < 32 ? 'a' : 'b' };
    });
    await json<StructureStage>(await page(interrupted, 0, batch(0)), 200);
    await json<StructureStage>(await page(interrupted, 1, batch(16)), 200);
    expect((await page(interrupted, 2, batch(32), randomUUID())).status).toBe(409);
    const checkpoint = await json<StructureStage>(await call('GET',
      `${stages}/${interrupted.id}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(checkpoint).toMatchObject({ status: 'staging', pages: 2, records: 32 });
    const renewed = await json<StructureStage>(await call('POST',
      `${stages}/${interrupted.id}/lease`, { actingSubject: f.actor }), 200);
    expect(BigInt(renewed.fence)).toBe(BigInt(interrupted.fence) + 1n);
    expect((await page(interrupted, 2, batch(32))).status).toBe(409);
    await json<StructureStage>(await page(renewed, 2, batch(32)), 200);
    await json<StructureStage>(await page(renewed, 3, batch(48)), 200);
    expect((await read()).revision).toBe(created.revision);
    expect((await read()).occurrences).toEqual([]);
    expect(await json<StructureStage>(await call('POST', `${stages}/${interrupted.id}/seal`,
      { actingSubject: f.actor, holder: renewed.holder, fence: renewed.fence }), 200))
      .toMatchObject({ status: 'sealed', placementCount: 64 });
    expect((await call('POST', `${stages}/${interrupted.id}/activate`,
      { actingSubject: f.actor })).status).toBe(409);
    expect((await read()).revision).toBe(created.revision);
    expect(await json<StructureStage>(await call('DELETE', `${stages}/${interrupted.id}`,
      { actingSubject: f.actor }), 200)).toMatchObject({ status: 'cancelled', pages: 4,
      records: 64 });

    const target = await json<{ work: string }>(await call('POST', '/v1/works',
      { profile: 'metadata-only-v1', title: 'Staged chapter target', actingSubject: f.actor }), 201);
    const grant = await f.grant(`work:read:${target.work}`, 'work.read');
    const staleAuthority = await createStage();
    const chapter = { ...group(staleAuthority, 'a'), role: 'chapter', target: target.work,
      selection: { mode: 'follow-context' } };
    await json<StructureStage>(await page(staleAuthority, 0, chapter), 200);
    await json<StructureStage>(await call('POST', `${stages}/${staleAuthority.id}/seal`,
      { actingSubject: f.actor, holder: staleAuthority.holder, fence: staleAuthority.fence }), 200);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grant]);
    expect((await call('POST', `${stages}/${staleAuthority.id}/activate`,
      { actingSubject: f.actor })).status).toBe(409);
    expect((await read()).revision).toBe(created.revision);
    await json<StructureStage>(await call('DELETE', `${stages}/${staleAuthority.id}`,
      { actingSubject: f.actor }), 200);

    const ready = await createStage();
    const placed = group(ready, 'a');
    await json<StructureStage>(await page(ready, 0, placed), 200);
    const sealed = await json<StructureStage>(await call('POST', `${stages}/${ready.id}/seal`,
      { actingSubject: f.actor, holder: ready.holder, fence: ready.fence }), 200);
    expect(sealed).toMatchObject({ status: 'sealed', placementCount: 1 });
    const activated = await json<StructureStage & { cost: { placementsWritten: number } }>(await call('POST',
      `${stages}/${ready.id}/activate`, { actingSubject: f.actor }), 200);
    expect(activated.status).toBe('activated');
    expect(activated.graphReceipt).toMatch(/^urn:rezics:receipt:/);
    expect(activated.graphDataEpoch).toBe(f.env.lineage.dataEpoch);
    expect(activated.graphSequence).toMatch(/^[1-9][0-9]*$/);
    expect(activated.cost.placementsWritten).toBe(1);
    expect((await read()).occurrences).toMatchObject([{ occurrence: placed.occurrence }]);
    expect((await read()).revision).toBe(activated.revision);
    expect(await json<StructureStage>(await call('POST', `${stages}/${ready.id}/activate`,
      { actingSubject: f.actor }), 200)).toMatchObject({ graphReceipt: activated.graphReceipt });
    expect((await json<{ occurrences: object[] }>(await call('GET',
      `${path}/revisions/${shortId(created.revision)}?actingSubject=${encodeURIComponent(f.actor)}`),
    200)).occurrences).toEqual([]);

    const staleEdit = await createStage(activated.revision);
    await json<StructureStage>(await page(staleEdit, 0, group(staleEdit, 'a')), 200);
    await json<StructureStage>(await call('POST', `${stages}/${staleEdit.id}/seal`,
      { actingSubject: f.actor, holder: staleEdit.holder, fence: staleEdit.fence }), 200);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [editGrant]);
    expect((await call('POST', `${stages}/${staleEdit.id}/activate`,
      { actingSubject: f.actor })).status).toBe(403);
    expect((await read()).revision).toBe(activated.revision);
    await f.grant(`work:edit:${book.work}`, 'work.edit');
    await json<StructureStage>(await call('DELETE', `${stages}/${staleEdit.id}`,
      { actingSubject: f.actor }), 200);

    const staleHead = await createStage(activated.revision);
    await json<StructureStage>(await page(staleHead, 0, group(staleHead, 'a')), 200);
    await json<StructureStage>(await call('POST', `${stages}/${staleHead.id}/seal`,
      { actingSubject: f.actor, holder: staleHead.holder, fence: staleHead.fence }), 200);
    const concurrent = await json<{ revision: string }>(await call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: activated.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'group' }],
    }), 200);
    expect((await call('POST', `${stages}/${staleHead.id}/activate`,
      { actingSubject: f.actor })).status).toBe(409);
    expect((await read()).revision).toBe(concurrent.revision);
    await json<StructureStage>(await call('DELETE', `${stages}/${staleHead.id}`,
      { actingSubject: f.actor }), 200);

    const recovery = await createStage(concurrent.revision);
    await json<StructureStage>(await page(recovery, 0, group(recovery, 'a')), 200);
    await json<StructureStage>(await call('POST', `${stages}/${recovery.id}/seal`,
      { actingSubject: f.actor, holder: recovery.holder, fence: recovery.fence }), 200);
    const originalFuseki = f.env.fuseki;
    let lostResponse = false;
    f.env.fuseki = new Proxy(originalFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const outcome = await target.commandWithReceipt(envelope);
        if (!lostResponse && envelope.update.includes('composition.stage-activate')) {
          lostResponse = true;
          throw new Error('lost staged activation acknowledgement');
        }
        return outcome;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const recovered = await json<StructureStage>(await call('POST',
        `${stages}/${recovery.id}/activate`, { actingSubject: f.actor }), 200);
      expect(lostResponse).toBe(true);
      expect(recovered.status).toBe('activated');
      expect((await read()).revision).toBe(recovered.revision);
      expect(await json<StructureStage>(await call('POST', `${stages}/${recovery.id}/activate`,
        { actingSubject: f.actor }), 200)).toMatchObject({ graphReceipt: recovered.graphReceipt });
    } finally { f.env.fuseki = originalFuseki; }
  } finally { await f.close(); }
}, 180_000);
