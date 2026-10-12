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
  const stack = await startMediaStack('structure-group-move-growth');
  const readings: Reading[] = [];
  try {
    const member = await stack.member('structure-mover');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, account: { verify: async () => member.principal } });
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
      readings.push({ descendants, profile, nativeAdds: counter('current_adds') + counter('revisions_adds') + counter('other_adds'),
        validationFocuses: counter('validation_focuses'), pagesRead: result.cost.pagesRead });
      sink.clear();
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
      sql: reading.profile.postgresStatements, fuseki: reading.profile.fusekiRequests,
      adds: reading.nativeAdds, focuses: reading.validationFocuses, pages: reading.pagesRead }));
    console.log('Group move growth', JSON.stringify(counts), resultPath);
  }, 600_000);
  test.failing('cross-parent group move work is constant at 16/64/256 descendants', () => {
    const counts = readings.map(reading => ({ descendants: reading.descendants,
      sql: reading.profile.postgresStatements, fuseki: reading.profile.fusekiRequests,
      adds: reading.nativeAdds, focuses: reading.validationFocuses, pages: reading.pagesRead }));
    const message = `Cross-parent group move work at 16/64/256: ${JSON.stringify(counts)}`;
    try {
      assertWorkCostAtScales(readings.map(reading => reading.profile), {
        postgresStatements: readings[0]!.profile.postgresStatements! * 1.2,
        fusekiRequests: readings[0]!.profile.fusekiRequests! * 1.2,
      }, 'structure-group-move-growth');
      for (const field of ['nativeAdds', 'validationFocuses'] as const) {
        expect(Math.max(...readings.map(reading => reading[field])), message)
          .toBeLessThanOrEqual(readings[0]![field] * 1.2);
      }
    } catch (error) {
      throw new Error(message, { cause: error });
    }
  }, 600_000);
}
