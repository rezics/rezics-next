import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { backfillOccurrenceLabels } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { RV, GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { StructureStageStore } from '../../../services/main/src/modules/structure/stage.ts';
import { startMediaStack } from './media-support.ts';
import { fusekiMemoryProbe } from './g-1022-fuseki-memory.ts';
import { projectName } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { integrationResourceClass, qaResourceClasses } from '../../../scripts/qa/resource-classes.ts';

type Page = { items: Array<{ occurrence: string; ordinal: number }>; nextCursor: string | null;
  complete: boolean; resolved: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Stage = { id: string; holder: string; fence: string; revision: string };
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

// One real stack, identical three-volume topology and fixed page size at every
// scale. HTTP/graph/object counters measure store exchanges and bytes, not native
// TDB operators. The immutable-tree unit test separately observes visited pages.
test('G1022: maintained label search, numbered seeks, saved positions and interrupted backfill at 100, 1000 and 10000 chapters', async () => {
  const stack = await startMediaStack('g-1022-reading-cost');
  try {
    let measuringCount = 0, projectionCommands = 0, heapMs = 0;
    const resourceClass = integrationResourceClass(['tests/qa/integration/g-1022-reading-cost.test.ts']);
    const allocation = qaResourceClasses[resourceClass];
    const memory = await fusekiMemoryProbe(resourceClass);
    const heap = async (phase: string, collect = false) => {
      const started = performance.now(), reading = await memory(collect);
      heapMs += performance.now() - started;
      expect(reading.containerLimit).toBe(Number.parseInt(allocation.memory, 10) * 1024 ** 3);
      console.log('G1022 heap', JSON.stringify({ revision: 'lucene-after', count: measuringCount, phase, memory: reading }));
    };
    const member = await stack.member('reading-cost-editor');
    const originalObjects = stack.objects('semantic/structure/'); await originalObjects.initialize();
    let objectReads = 0, objectBytes = 0;
    const objects = { put: originalObjects.put.bind(originalObjects), get: async (digest: string) => {
      const bytes = await originalObjects.get(digest); objectReads++; objectBytes += bytes.length; return bytes;
    } };
    const query = stack.fuseki.query.bind(stack.fuseki);
    let graphRows = 0, graphBytes = 0, indexReads = 0;
    const graphWork: Array<{ name: string; ms: number }> = [];
    stack.fuseki.query = async (sparql, bytes) => {
      if (stack.fuseki.isBackgroundContext) return query(sparql, bytes);
      const start = performance.now(), result = await query(sparql, bytes);
      if (sparql.includes('# reading-position:label-index')) {
        const page = result.results?.bindings[0]?.page?.value;
        if (page) indexReads += (JSON.parse(page) as { reads: number }).reads;
      }
      graphRows += result.results?.bindings.length ?? 0; graphBytes += Buffer.byteLength(JSON.stringify(result));
      graphWork.push({ name: sparql.match(/# reading-position:([\w-]+)/)?.[1] ?? 'fence/disclosure', ms: performance.now() - start });
      return result;
    };
    const graphCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async envelope => {
      try {
        const result = await graphCommand(envelope);
        if (envelope.update.includes('structure.project') && ++projectionCommands % 10 === 0) await heap('projection');
        return result;
      }
      catch (error) {
        console.error('G1022 command failure', envelope.receipt,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        const env = loadDockerEnvironment(), project = projectName({ profile: 'qa', runId: Bun.env.REZICS_QA_RUN_ID! });
        const container = Bun.spawnSync(['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
          '--filter', 'label=com.docker.compose.service=fuseki'], { env }).stdout.toString().trim();
        if (container) {
          console.error('G1022 Fuseki state', Bun.spawnSync(['docker', 'inspect', '--format',
            '{{.State.OOMKilled}} {{.State.ExitCode}} {{.State.Status}}', container], { env }).stdout.toString().trim());
          console.error('G1022 Fuseki failure log', Bun.spawnSync(['docker', 'logs', '--tail', '30', container], { env }).stderr.toString());
        }
        throw error;
      }
    };
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, readingPositions: new ReadingPositionStore(stack.contentPool),
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async request => {
        if (request.headers.get('authorization') !== `Bearer ${member.token}`) throw new AccountAssertionDenied('Unknown bearer');
        return member.principal;
      } } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const makeWork = async (title: string, semanticTypes = ['https://schema.org/Book']) => {
      const work = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const contribution = await stack.contribution(work.work, member.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: contribution.contribution, publicationDecision: contribution.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      await selectMainDefault(stack.env, stack.admission(member.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await member.grant(`work:edit:${work.work}`, 'work.edit');
      await member.grant(`work:read:${work.work}`, 'work.read');
      return work;
    };
    const samples: object[] = [];
    for (const count of [100, 1000, 10000]) {
      measuringCount = count;
      await heap('before-build');
      const buildStarted = performance.now(), heapBeforeBuild = heapMs;
      const rootWork = await makeWork(`G1022 ${count} chapters`);
      const chapter = await makeWork(`G1022 ${count} chapter`, ['https://schema.org/DigitalDocument']);
      const root = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'work-composition',
        work: rootWork.work, mainVersion: rootWork.mainVersion, actingSubject: member.actor }), 201);
      const volumes = [];
      for (let index = 0; index < 3; index++) volumes.push(await makeWork(`G1022 ${count} volume ${index}`));
      await json(await call('POST', `/v1/compositions/${short(root.structure)}/changes`, {
        profile: 'work-composition', expectedHead: root.revision, actingSubject: member.actor,
        operations: volumes.map(volume => ({ op: 'insert', role: 'part', parent: root.structure,
          position: 'last', target: volume.work, displayLabel: 'Volume', inclusion: 'required' })) }));
      let last = '', lastCount = 0;
      for (const [index, volume] of volumes.entries()) {
        const size = Math.floor(count / 3) + (index === 2 ? count % 3 : 0); lastCount = size;
        const composition = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
          work: volume.work, mainVersion: volume.mainVersion, actingSubject: member.actor }), 201);
        const path = `/v1/compositions/${short(composition.structure)}/stages`;
        const stage = await json<Stage>(await call('POST', path, { expectedHead: composition.revision,
          actingSubject: member.actor }), 201);
        for (let offset = 0, page = 0; offset < size; offset += 256, page++) {
          const entries = Array.from({ length: Math.min(256, size - offset) }, (_, at) => {
            const local = offset + at, occurrence = `https://rezics.com/id/${randomUUID()}`;
            last = occurrence;
            return { occurrence, state: 'active', parent: composition.structure,
              segmentKey: Math.floor(local / 32).toString(36).padStart(4, '0'),
              orderKey: (local % 32).toString(36).padStart(2, '0'), role: 'chapter',
              target: chapter.work, selection: { mode: 'follow-context' }, introducedBy: stage.revision,
              labels: [{ value: index === 2 && local === size - 1 ? '魔法禁書目錄 重逢' : `Chapter ${local + 1}`, language: 'yue' }] };
          });
          await json(await call('PUT', `${path}/${stage.id}/pages/${page}`, { actingSubject: member.actor,
            holder: stage.holder, fence: stage.fence, entries }));
        }
        await json(await call('POST', `${path}/${stage.id}/seal`, { actingSubject: member.actor,
          holder: stage.holder, fence: stage.fence }));
        await heap(`sealed-volume-${index}`);
        await json(await call('POST', `${path}/${stage.id}/activate`, { actingSubject: member.actor }));
        await heap(`activated-volume-${index}`);
      }
      const buildWallMs = performance.now() - buildStarted;
      const buildMs = buildWallMs - (heapMs - heapBeforeBuild);
      await heap('after-build');
      await heap('after-build-collected', true);
      const partial = await json<Page & { search: { status: string }; count: { kind: string } }>(await app.handle(new Request(
        `http://main.local/v1/reading-positions/${short(rootWork.work)}?q=重逢&limit=1`)));
      expect(partial).toMatchObject({ complete: false, search: { status: 'indexing' }, count: { kind: 'at-least' } });
      const indexStarted = performance.now();
      await backfillOccurrenceLabels(stack.env);
      const indexMs = performance.now() - indexStarted;
      await heap('after-index');
      await heap('after-index-collected', true);
      expect(buildMs).toBeLessThan(600_000);
      const measured = async (operation: string, params: Record<string, string>, baseline = false) => {
        const start = performance.now(), calls = stack.fuseki.queries, rows = graphRows, bytes = graphBytes,
          reads = objectReads, objectSize = objectBytes, work = graphWork.length, postings = indexReads;
        // Test-only baseline of the retired scalar-label scan. Production has
        // no graph-only substring fallback, even when its order store is absent.
        const page = baseline ? await (async () => {
          const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}>
            SELECT ?occurrence WHERE { VALUES (?main ?volumeOrder) {
              ${volumes.map((volume, index) => `(${iri(volume.mainVersion)} ${index})`).join(' ')} }
              GRAPH ${iri(GRAPHS.current)} {
                ?structure rv:structureOf ?main ; rv:selectedGeneration ?generation .
                ?placement rv:generation ?generation ; rv:occurrence ?occurrence ; rv:occurrenceLabel ?label ;
                  rv:orderSegment ?segment ; rv:orderKey ?key .
                ?segment rv:segmentKey ?segmentKey . FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
                FILTER(CONTAINS(LCASE(STR(?label)), ${lit(params.q!)}))
              } } ORDER BY ?volumeOrder ?segmentKey ?key LIMIT 3`)).results?.bindings ?? [];
          return { items: rows.slice(0, 2).map(row => ({ occurrence: row.occurrence!.value, ordinal: 0 })),
            complete: rows.length <= 2, nextCursor: null, resolved: 'start' };
        })() : await json<Page>(await app.handle(new Request(
          `http://main.local/v1/reading-positions/${short(rootWork.work)}?${new URLSearchParams(params)}`)));
        samples.push({ count, operation, ms: performance.now() - start, graphCalls: stack.fuseki.queries - calls,
          graphRows: graphRows - rows, graphBytes: graphBytes - bytes, objectReads: objectReads - reads,
          objectBytes: objectBytes - objectSize, indexReads: indexReads - postings, queries: graphWork.slice(work) });
        return page;
      };
      for (const q of ['重逢', 'chapter', 'absent']) {
        const params = { q, limit: '2' };
        const before = await measured(`before:${q}`, params, true);
        const after = await measured(`after:${q}`, params);
        expect(after.items.map(item => item.occurrence)).toEqual(before.items.map(item => item.occurrence));
        expect(after.complete).toBe(before.complete);
      }
      const folded = await measured('folded-cjk', { q: '禁书目录', limit: '1' });
      expect(folded.items.map(item => item.occurrence)).toEqual([last]);
      expect(folded.complete).toBe(true);
      const number = await measured('number', { q: String(lastCount), limit: '100' });
      expect(number.items.some(item => item.occurrence === last && item.ordinal === lastCount)).toBe(true);
      const saved = await measured('saved-position', { q: '重逢', position: last, limit: '1' });
      expect(saved.resolved).toBe(last);
      const first = await measured('filtered-first', { q: 'chapter', limit: '2' });
      const next = await measured('filtered-continuation', { q: 'chapter', limit: '2', cursor: first.nextCursor! });
      expect(next.items.every(item => !first.items.some(previous => previous.occurrence === item.occurrence))).toBe(true);
      // Simulate an older/restored dataset without native index state, then an
      // interrupted build. Every committed batch is a durable resume point.
      if (count === 1000) {
        const generations = (await stack.fuseki.query(`PREFIX rv: <${RV}>
          SELECT ?generation WHERE { GRAPH ${iri(GRAPHS.current)} {
            ?structure rv:structureOf ${iri(volumes[2]!.mainVersion)} ; rv:selectedGeneration ?generation .
          } }`)).results!.bindings;
        const generation = generations[0]!.generation!.value;
        const abort = new AbortController();
        const nativeCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
        let committed = 0;
        stack.fuseki.commandWithReceipt = async request => {
          const result = await nativeCommand(request);
          if (result.status === 'committed' && ++committed === 2) abort.abort(new Error('interrupted build'));
          return result;
        };
        try {
          await expect(backfillOccurrenceLabels(stack.env, { generation, reset: true, signal: abort.signal }))
            .rejects.toThrow('interrupted build');
        } finally { stack.fuseki.commandWithReceipt = nativeCommand; }
        const closed = await app.handle(new Request(`http://main.local/v1/reading-positions/${short(rootWork.work)}?q=重逢`));
        const pending = await json<{ complete: boolean; search: { status: string }; count: { kind: string } }>(closed);
        expect(pending).toMatchObject({ complete: false, search: { status: 'indexing' }, count: { kind: 'at-least' } });
        await backfillOccurrenceLabels(stack.env, { generation });
        expect((await measured('backfilled', { q: '重逢', limit: '1' })).items.map(item => item.occurrence)).toEqual([last]);
        const retry = await backfillOccurrenceLabels(stack.env, { generation });
        expect(retry.indexed).toBe(0);
      }
      console.log('G1022 scale', JSON.stringify({ count, buildMs, buildWallMs, indexMs, samples: samples.filter(sample => (sample as { count: number }).count === count) }));
    }
  } finally { await stack.stop(); }
}, 600_000);
