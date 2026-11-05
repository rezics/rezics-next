import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryProfile,
  libraryLabels,
  unitData,
} from '../../../../packages/definitions/test/support/library-profiles';
import {
  archiveBase64,
  ProgressRecoveryJourney,
} from '../../../../apps/web/src/library/archive-progress-recovery/controller';
import {
  progressRecoveryNative,
  type Reply,
  type ReviewInput,
} from '../../../../apps/web/src/library/archive-progress-recovery/native';
import type { ProgressRecoveryPort as Port } from '../../../../apps/web/src/library/archive-progress-recovery/native';
import { createCopyArchive } from '../../src/library/copy-archive';
import { createWorkClient } from '../../src/work/client';
import { routeOf } from '../../src/route/route';
import { testRouteKey } from '../support/test-kernel';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let work: Awaited<ReturnType<typeof createWorkClient>>;
let subjectId: string, artifact: string, memberId: string, detachedId: string, unitSource: string;
let sessions: string[] = [];
let port: Port;
let interrupt = false,
  loseResponse = false;
const originals: { key: string; command: string }[] = [];
function ok<T>(reply: Reply<T>): T {
  expect(reply.kind).toBe('ok');
  if (reply.kind !== 'ok') throw new Error(JSON.stringify(reply));
  return reply.value;
}
async function response(method: string, path: string, body?: unknown) {
  const result = await f.send(owner.bearer, method, path, body);
  if (!result.ok) throw new Error(`${result.status}: ${await result.text()}`);
  return result.json();
}
const body = (sessionId: string): ReviewInput => ({
  sessionId,
  subjectId,
  mode: 'scalar_amount',
  unit: 'chapter',
  additionalMeasures: [{ sourceUnit: 'page', unit: 'page' }],
  unitIds: [],
});

beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity([
    'subject:read',
    'subject:create',
    'statement:propose',
    'copy:list',
    'copy:create',
    'copy:read',
    'library_entry:list',
    'library_entry:read',
    'library_entry:update',
    'progress_session:list',
    'progress_session:read',
    'progress_session:create',
    'progress_session:update',
    'collection:read',
  ]);
  const profile = libraryProfile('fixture.archive-web', 'chapter');
  profile.progress.allowed[0]!.units.push(unitData('page'), unitData('old.page'));
  profile.progress.allowed.push({ mode: 'completed_units', units: [unitData('episode', 'completed_units')] });
  const sources = fixture(profile),
    schema = JSON.parse(sources.schemas['fixture.yaml']!);
  schema.prefixes.schema = 'http://schema.org/';
  schema.classes.Child.slots = ['isPartOf'];
  schema.classes.Episode = { class_uri: 'schema:Episode', slots: ['isPartOf'] };
  schema.slots = {
    isPartOf: {
      slot_uri: 'schema:isPartOf',
      range: 'Child',
      annotations: { datatype: 'wikibase-item', relation_group: 'membership' },
    },
  };
  sources.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, source] of Object.entries(sources.presentation)) {
    const labels = JSON.parse(source);
    labels.types['schema:Episode'] = 'episode';
    labels.properties = { 'schema:isPartOf': 'part of' };
    labels.libraryProfiles[profile.id] = libraryLabels(
      profile,
      key.slice('fixture/'.length) as Parameters<typeof libraryLabels>[1],
    );
    sources.presentation[key] = JSON.stringify(labels);
  }
  await f.activate(await f.publish(await compileCatalogue(sources)));
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  subjectId = await f.createSubject('game');
  await response('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' });
  await response('POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' });
  // Independent equal-valued repeats, zero, absent, exact decimals, active and terminal source states.
  for (let i = 0; i < 13; i++) {
    const started = await response('POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'chapter',
      ...(i === 3 ? {} : { total: '9.125000' }),
      additionalMeasures: [{ unit: 'page', total: '12.500001' }, { unit: 'old.page' }],
    });
    sessions.push(started.progressSession.id);
    if (i !== 2)
      await response('POST', `/v1/progressSessions/${sessions[i]}:record`, {
        revision: 1,
        amount: i === 3 ? '0' : '1.125000',
      });
    if (i === 0 || i === 1) {
      await response('POST', `/v1/progressSessions/${sessions[i]}:record`, {
        revision: 2,
        measureId: 'page',
        amount: '0',
      });
      await response('POST', `/v1/progressSessions/${sessions[i]}:complete`, { revision: 3 });
    }
    if (i === 4) await response('POST', `/v1/progressSessions/${sessions[i]}:abandon`, { revision: 2 });
  }
  const episode = async (label: string) => {
    const item = await response('POST', '/v1/subjects', {
      type: 'schema:Episode',
      labels: { en: label },
      statements: {
        'schema:isPartOf': [{ property: { id: 'schema:isPartOf' }, value: { type: 'value', content: subjectId } }],
      },
    });
    return item.subject as { id: string; statements: Record<string, { id: string }[]> };
  };
  const member = await episode('Member'),
    detached = await episode('Detached');
  memberId = member.id;
  detachedId = detached.id;
  const memberIds = [memberId];
  for (let n = 0; n < 10; n++) memberIds.push((await episode(`Member ${n + 2}`)).id);
  unitSource = (await response('POST', '/v1/progressSessions', { subjectId, mode: 'completed_units', unit: 'episode' }))
    .progressSession.id;
  await response('POST', `/v1/progressSessions/${unitSource}:recordEpisodes`, {
    revision: 1,
    add: [...memberIds, detachedId],
  });
  expect(
    (
      await f.send(
        'steward',
        'POST',
        `/v1/subjects/${detachedId}/candidates/${detached.statements['schema:isPartOf']![0]!.id}:hide`,
        { reason: 'Detach archive fixture member' },
      )
    ).status,
  ).toBe(200);
  // Seed a supported installed capture before paging. The current V4 default remains refused by recovery.
  const capture = await response('POST', '/v1/libraryExports');
  await f.pool.query(
    'UPDATE library.library_export SET format_version=2 WHERE route=$1 AND account_id=$2 AND export_id=$3',
    [routeOf(owner.actor.accountId), owner.actor.accountId, capture.exportId],
  );
  const status = await response('GET', `/v1/libraryExports/${capture.exportId}`);
  const records: unknown[] = [];
  let cursor = status.first,
    manifest: unknown = null;
  while (cursor) {
    const page = await response(
      'GET',
      `/v1/libraryExports/${capture.exportId}/pages?cursor=${encodeURIComponent(cursor)}`,
    );
    records.push(...page.records);
    cursor = page.next;
    if (page.manifest) manifest = page.manifest;
  }
  expect(manifest).toMatchObject({ version: 2 });
  artifact = JSON.stringify({ manifest, records });
  work = await createWorkClient(f.pool.options.connectionString!, f.pool);
  const service = createCopyArchive({
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    workClient: work,
    routeKey: testRouteKey(),
  });
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      if (request.url.endsWith(':apply')) {
        originals.push({ key: request.headers.get('idempotency-key')!, command: request.url });
        if (interrupt) {
          interrupt = false;
          const match = new URL(request.url).pathname.split('/'),
            abort = new AbortController();
          await expect(
            service.applyProgress(
              owner.actor,
              match[3]!,
              match[5]!.split(':')[0]!,
              JSON.parse(request.headers.get('idempotency-key')!),
              abort.signal,
              () => abort.abort(),
            ),
          ).rejects.toThrow();
          return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
        }
        if (loseResponse) {
          loseResponse = false;
          await f.handle(request);
          throw new TypeError('fetch failed');
        }
      }
      return f.handle(request);
    }) as typeof fetch,
  });
  const native = progressRecoveryNative(client, `Bearer ${owner.bearer}`);
  port = {
    ...native,
    choices: async (id) => ({
      kind: 'ok',
      value: {
        subjectId: id,
        choices: [
          {
            mode: 'scalar_amount',
            units: [
              { id: 'chapter', label: 'chapter', step: 'any', total: 'optional' },
              { id: 'page', label: 'page', step: 'any', total: 'optional' },
            ],
          },
        ],
      },
    }),
  };
}, 120000);
afterAll(async () => {
  await work?.close();
  await f?.close();
});

async function independent() {
  // Compare actual independent owner facts, including empty journals/publications, without assuming UI summaries.
  const capture = await response('POST', '/v1/libraryExports');
  let cursor = capture.first;
  const facts: unknown[] = [];
  while (cursor) {
    const page = await response(
      'GET',
      `/v1/libraryExports/${capture.exportId}/pages?cursor=${encodeURIComponent(cursor)}`,
    );
    facts.push(
      ...page.records.filter((row: { section: string }) =>
        ['entries', 'holdings', 'journals', 'annotations', 'provenance'].includes(row.section),
      ),
    );
    cursor = page.next;
  }
  return facts;
}
async function journey() {
  const value = new ProgressRecoveryJourney(port, entryKey(), () => true);
  await value.upload(new File([artifact], 'completed-v2.json'));
  return value;
}
async function select(journey: ProgressRecoveryJourney, sessionId: string) {
  await journey.page('occurrences');
  while (true) {
    const page = journey.snapshot().occurrences!;
    const selected = page.occurrences.find(({ evidence }) => evidence.session_id === sessionId);
    if (selected) return journey.select(selected.evidence);
    expect(page.next).not.toBeNull();
    await journey.page('occurrences', page.next!);
  }
}

test('mounted generated journey pages a completed export and creates distinct equal-valued repeats with exact native readback', async () => {
  const before = await independent(),
    j = await journey();
  expect(j.snapshot().occurrences!.occurrences).toHaveLength(10);
  await j.page('occurrences', j.snapshot().occurrences!.next!);
  expect(j.snapshot().occurrences!.occurrences.length).toBeGreaterThan(0);
  const ids: string[] = [];
  for (const source of [sessions[0]!, sessions[1]!, sessions[2]!, sessions[3]!, sessions[4]!]) {
    await select(j, source);
    await j.review(body(source));
    const reviewed = j.snapshot().review!;
    expect(reviewed.applicable).toBe(true);
    expect(reviewed.unsupported.length).toBeGreaterThan(0);
    await j.confirm(reviewed.reviewId);
    const current = j.snapshot().result!.progressSession!;
    ids.push(current.id);
    expect(current.id).not.toBe(source);
    expect(current.total).toBe(source === sessions[3] ? null : '9.125000');
    expect(current.amount).toBe(source === sessions[2] ? null : source === sessions[3] ? '0' : '1.125000');
    expect(current.state).toBe(
      source === sessions[0] || source === sessions[1] ? 'completed' : source === sessions[4] ? 'abandoned' : 'active',
    );
    const measures = current.measures!;
    expect(measures.find((item) => item.unit === 'page')).toMatchObject({
      total: '12.500001',
      amount: source === sessions[0] || source === sessions[1] ? '0' : null,
    });
  }
  expect(new Set(ids).size).toBe(5);
  await select(j, unitSource);
  expect(j.snapshot().units!.units).toHaveLength(10);
  const unitMapping: ReviewInput = {
    ...body(unitSource),
    mode: 'completed_units',
    unit: 'episode',
    additionalMeasures: [],
    unitIds: [],
  };
  await j.review({ ...unitMapping, unitIds: j.snapshot().units!.units.map(({ evidence }) => evidence.unit_id) }, true);
  expect(j.snapshot().unitSupport).toHaveLength(10);
  expect(j.snapshot().review).toBeNull();
  await j.page('units', j.snapshot().units!.next!);
  expect(j.snapshot().units!.units).toHaveLength(2);
  await j.review({ ...unitMapping, unitIds: j.snapshot().units!.units.map(({ evidence }) => evidence.unit_id) }, true);
  expect(j.snapshot().unitSupport).toHaveLength(2);
  await j.review({ ...unitMapping, unitIds: [memberId] });
  expect(j.snapshot().review).toMatchObject({
    recovery: 'partial',
    completedUnits: [{ unitId: memberId, admission: 'member' }],
  });
  expect(j.snapshot().review!.unsupported.length).toBeGreaterThan(0);
  await j.confirm(j.snapshot().review!.reviewId);
  const unitResult = j.snapshot().result!;
  expect(unitResult.progressSession!.completedUnitCount).toBe(1);
  expect(unitResult.completedEpisodes).not.toBeNull();
  const read = await response(
    'GET',
    `/v1/progressSessions/${unitResult.progressSession!.id}/episodes?ids=${memberId},${detachedId}`,
  );
  expect(read.episodes).toMatchObject([
    { episodeSubjectId: memberId, completed: true },
    { episodeSubjectId: detachedId, completed: false },
  ]);
  expect(await independent()).toEqual(before);
  await j.remove();
  expect(j.snapshot().notice).toBe('removed');
  expect((await response('GET', `/v1/progressSessions/${ids[0]}`)).progressSession.id).toBe(ids[0]);
}, 120000);

test('effect-before-checkpoint and response loss replay original routes/keys; cancellation preserves accepted partial Session and deletion stays bounded', async () => {
  const before = await independent(),
    j = await journey();
  await j.review(body(sessions[0]!));
  interrupt = true;
  await j.confirm(j.snapshot().review!.reviewId);
  expect(j.snapshot().pending).toBe(true);
  const uploadId = j.snapshot().upload!.uploadId,
    reviewId = j.snapshot().review!.reviewId;
  expect(ok(await port.result(uploadId, reviewId))).toMatchObject({
    application: { state: 'recoverable', acceptedSteps: 0 },
    progressSession: null,
    completedEpisodes: null,
  });
  await j.cancel();
  expect(j.snapshot().application).toMatchObject({ state: 'partial', acceptedSteps: 1 });
  const partial = j.snapshot().result!.progressSession!;
  expect(partial.state).toBe('active');
  expect(originals.at(-1)).toEqual(originals.at(-2));
  await j.remove();
  expect((await response('GET', `/v1/progressSessions/${partial.id}`)).progressSession.id).toBe(partial.id);
  const second = await journey();
  await second.review(body(sessions[1]!));
  loseResponse = true;
  await second.confirm(second.snapshot().review!.reviewId);
  expect(second.snapshot().pending).toBe(true);
  await second.retry();
  expect(second.snapshot().result!.progressSession!.state).toBe('completed');
  expect(originals.at(-1)).toEqual(originals.at(-2));
  // Retain over one child-page of reviews; bounded removal must make multiple native calls.
  for (let n = 0; n < 101; n++)
    ok(await port.review(second.snapshot().upload!.uploadId, body(sessions[2]!), entryKey()));
  const removed = ok(await port.remove(second.snapshot().upload!.uploadId));
  expect(removed.removed).toBeLessThanOrEqual(100);
  expect(removed.complete).toBe(false);
  await second.remove();
  expect(second.snapshot().notice).toBe('removed');
  expect(await independent()).toEqual(before);
}, 120000);
