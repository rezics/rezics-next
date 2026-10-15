import { beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry }
  from '../../../packages/observability/src/runtime.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { assertWorkCostAtScales, profileRequest, startWorkProfileSink,
  type WorkProfile } from '../support/work-profile.ts';

interface Reading {
  descendants: number;
  sqlRows: number;
  profile: WorkProfile;
  nativeAdds: number;
  validationFocuses: number;
  pagesRead: number;
}

if (process.env.REZICS_GROUP_MOVE_PROFILE_CHILD === '1') {
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startMediaStack } = await import('./media-support.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { activateMetadataWork, metadataWorkRequestDigest } =
    await import('../../../services/main/src/modules/work/activate.ts');
  const { StructureStageStore } = await import('../../../services/main/src/modules/structure/stage.ts');
  const { readCompositionHeader } = await import('../../../services/main/src/modules/structure/graph.ts');
  const { recordTree, subtreeHeight } = await import('../../../services/main/src/modules/structure/change.ts');
  const { checkStructureManifest } = await import('../../../services/main/src/modules/structure/format.ts');
  const { newCost } = await import('../../../services/main/src/modules/structure/tree.ts');
  const stack = await startMediaStack('structure-group-move-growth');
  const readings: Reading[] = [];
  try {
    const member = await stack.member('structure-mover');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async () => member.principal } });
    const prepared = performance.now();
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const text = await response.text();
      expect(response.status, text).toBe(status);
      return JSON.parse(text) as T;
    };
    type Composition = { structure: string; revision: string; occurrences: string[];
      cost: { pagesRead: number } };
    for (const descendants of [16, 64, 256]) {
      const title = `Group move ${descendants}`;
      const semanticTypes = ['https://schema.org/Book'];
      const work = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(title, semanticTypes)) });
      await member.grant(`work:edit:${work.work}`, 'work.edit');
      await member.grant(`work:read:${work.work}`, 'work.read');
      const call = (path: string, body: object, headers = new Headers()) => {
        headers.set('authorization', `Bearer ${member.token}`);
        headers.set('idempotency-key', randomUUID());
        headers.set('content-type', 'application/json');
        return app.handle(new Request(`http://main.local${path}`, {
          method: 'POST', headers, body: JSON.stringify(body) }));
      };
      let composition = await json<Composition>(await call('/v1/compositions', {
        profile: 'work-composition', work: work.work, mainVersion: work.mainVersion,
        actingSubject: member.actor }), 201);
      const path = `/v1/compositions/${composition.structure.slice(-36)}/changes`;
      const group = (parent: string) => ({ op: 'insert', role: 'group', parent,
        position: 'last' });
      const change = async (operations: object[], headers?: Headers) => {
        composition = await json<Composition>(await call(path, { profile: 'work-composition',
          actingSubject: member.actor, expectedHead: composition.revision, operations }, headers));
        return composition;
      };
      const retained = async () => {
        const header = (await readCompositionHeader(stack.env, composition.structure))!;
        const manifest = checkStructureManifest(await objects.get(header.manifest.slice(-64)));
        return recordTree(objects).range(manifest.records, '', '\uffff', 300, newCost());
      };
      const roots = await change([group(composition.structure), group(composition.structure)]);
      const [moved, destination] = roots.occurrences;
      for (let count = 0; count < descendants; count += 16) {
        await change(Array.from({ length: 16 }, () => group(moved!)));
      }
      const { profile, result } = await profileRequest(sink, headers => change([
        { op: 'move', occurrence: moved, parent: destination, position: 'last' },
      ], headers), { service: 'main', flush: flushTelemetryTraces });
      const native = profile.fusekiCalls.flatMap(call => call.nativeWork ? [call.nativeWork] : []);
      expect(native.length).toBeGreaterThan(0);
      const counter = (field: string) => native.reduce((sum, work) => {
        expect(Number.isFinite(work[field]), field).toBe(true);
        return sum + work[field]!;
      }, 0);
      const sqlRows = profile.postgres.reduce((sum, statement) => {
        const span = profile.spans.find(span => span.spanId === statement.spanId)!;
        const rows = span.attributes['rezics.postgres.rows'];
        expect(typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 0).toBe(true);
        return sum + Number(rows);
      }, 0);
      readings.push({ descendants, sqlRows, profile, nativeAdds: counter('current_adds') + counter('revisions_adds') + counter('other_adds'),
        validationFocuses: counter('validation_focuses'), pagesRead: result.cost.pagesRead });
      sink.clear();
      const afterMove = await retained();
      expect(afterMove.find(record => record.occurrence === moved)!.subtreeLevels![0]).toBe(descendants);
      expect(afterMove.find(record => record.occurrence === destination)!.subtreeLevels!.slice(0, 2))
        .toEqual([1, descendants]);
      if (descendants === 16) {
        const leaf = afterMove.find(record => record.parent === moved)!;
        const inserted = (await change([group(leaf.occurrence)])).occurrences[0]!;
        expect(subtreeHeight((await retained()).find(record => record.occurrence === destination)!.subtreeLevels)).toBe(3);
        await change([{ op: 'remove', occurrence: inserted }]);
        expect(subtreeHeight((await retained()).find(record => record.occurrence === destination)!.subtreeLevels)).toBe(2);
        await change([{ op: 'move', occurrence: moved, parent: composition.structure, position: 'last' }]);
        expect(subtreeHeight((await retained()).find(record => record.occurrence === destination)!.subtreeLevels)).toBe(0);

        const base = `/v1/compositions/${composition.structure.slice(-36)}`;
        type Stage = { id: string; holder: string; fence: string; revision: string };
        const stage = await json<Stage>(await call(`${base}/stages`, {
          actingSubject: member.actor, expectedHead: composition.revision }), 201);
        const legacyRecords = (await retained()).map(record => {
          const { subtreeLevels: _levels, ...legacy } = record;
          return legacy;
        });
        const headers = new Headers({ authorization: `Bearer ${member.token}`,
          'content-type': 'application/json', 'idempotency-key': randomUUID() });
        await json(await app.handle(new Request(`http://main.local${base}/stages/${stage.id}/pages/0`, {
          method: 'PUT', headers, body: JSON.stringify({ actingSubject: member.actor,
            holder: stage.holder, fence: stage.fence, entries: legacyRecords }) })));
        await json(await call(`${base}/stages/${stage.id}/seal`, { actingSubject: member.actor,
          holder: stage.holder, fence: stage.fence }));
        await json(await call(`${base}/stages/${stage.id}/activate`, { actingSubject: member.actor }));
        composition.revision = stage.revision;
        expect(subtreeHeight((await retained()).find(record => record.occurrence === moved)!.subtreeLevels)).toBe(1);
        await change([{ op: 'move', occurrence: moved, parent: destination, position: 'last' }]);
        const page = await json<{ occurrences: object[] }>(await app.handle(new Request(
          `http://main.local${base}?actingSubject=${encodeURIComponent(member.actor)}`,
          { headers: { authorization: `Bearer ${member.token}` } })));
        expect(page.occurrences.every(record => !('subtreeLevels' in record))).toBe(true);

        let parent = composition.structure;
        for (let depth = 0; depth < 15; depth++) parent = (await change([group(parent)])).occurrences[0]!;
        const head = composition.revision;
        await json(await call(path, { profile: 'work-composition', actingSubject: member.actor,
          expectedHead: head, operations: [{ op: 'move', occurrence: moved, parent, position: 'last' }] }), 409);
        expect((await readCompositionHeader(stack.env, composition.structure))!.head).toBe(head);
      }
    }
    expect(performance.now() - prepared).toBeLessThan(600_000);
    await app.stop();
  } finally {
    const resultPath = process.env.REZICS_WORK_PROFILE_RESULT!;
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ readings }));
    await stack.stop();
    await sink.stop();
    await shutdownTelemetry();
  }
} else {
  let readings: Reading[];
  beforeAll(async () => {
    const { resultPath } = await runWorkProfileChild(
      'tests/qa/integration/structure-group-move-growth.test.ts', {
        env: { REZICS_GROUP_MOVE_PROFILE_CHILD: '1' }, timeoutMs: 600_000 });
    ({ readings } = JSON.parse(readFileSync(resultPath, 'utf8')) as { readings: Reading[] });
    expect(readings.map(reading => reading.descendants)).toEqual([16, 64, 256]);
    const counts = readings.map(reading => ({ descendants: reading.descendants,
      sql: reading.profile.postgresStatements, sqlRows: reading.sqlRows, fuseki: reading.profile.fusekiRequests,
      adds: reading.nativeAdds, focuses: reading.validationFocuses, pages: reading.pagesRead }));
    console.log('Group move growth', JSON.stringify(counts), resultPath);
  }, 600_000);
  test('cross-parent group move work is constant at 16/64/256 descendants', () => {
    const counts = readings.map(reading => ({ descendants: reading.descendants,
      sql: reading.profile.postgresStatements, sqlRows: reading.sqlRows, fuseki: reading.profile.fusekiRequests,
      adds: reading.nativeAdds, focuses: reading.validationFocuses, pages: reading.pagesRead }));
    const message = `Cross-parent group move work at 16/64/256: ${JSON.stringify(counts)}`;
    try {
      assertWorkCostAtScales(readings.map(reading => reading.profile), {
        postgresStatements: readings[0]!.profile.postgresStatements! * 1.2,
        fusekiRequests: readings[0]!.profile.fusekiRequests! * 1.2,
      }, 'structure-group-move-growth');
      for (const field of ['nativeAdds', 'validationFocuses', 'sqlRows'] as const) {
        expect(Math.max(...readings.map(reading => reading[field])), message)
          .toBeLessThanOrEqual(readings[0]![field] * 1.2);
      }
    } catch (error) {
      throw new Error(message, { cause: error });
    }
  }, 600_000);
}
