import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../../../services/main/src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../../../services/main/src/modules/structure/format.ts';
import { orderTreeKey, type CompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { readCompositionOccurrenceByQualifierKey, readCompositionPage }
  from '../../../services/main/src/modules/structure/read.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable }
  from '../../../services/main/src/modules/structure/tree.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { StructureQualifierRootStore, qualifierSourceRoot }
  from '../../../services/main/src/modules/structure/qualifier-index.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage, ObjectRecoveryConflict }
  from '../../../services/main/src/modules/owner/object-coverage.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type LegacyManifest = Extract<StructureManifest, { format: 'rezics-structure-manifest-v1' }>;

// This tests the fixed private preparation owner, rather than populating the
// current graph with a second membership projection. Source records remain S3 authority.
test('trusted qualifier checkpoints prepare the exact original manifest on real PostgreSQL and S3', async () => {
  const started = performance.now(), stack = await startMediaStack('structure-qualifier-root');
  const objects = stack.objects('semantic/structure/');
  await objects.initialize();
  let measuring = false, pages = 0, bytes = 0, orderReads = 0;
  const evidence: object[] = [];
  const counted: ImmutableObjects = {
    put: value => objects.put(value),
    get: async digest => {
      const value = await objects.get(digest);
      if (measuring) {
        pages++; bytes += value.byteLength;
        if ((JSON.parse(new TextDecoder().decode(value)) as { tree?: string }).tree === 'order') orderReads++;
      }
      return value;
    },
  };
  Object.assign(stack.env, { structureObjects: counted });
  const zone = native(), target = native(), structure = native(), generation = native();
  const makeSource = async (size: number) => {
    const revision = native();
    const records = Array.from({ length: size }, (_, index): OccurrenceRecord => ({
      occurrence: native(), state: 'active', parent: structure, segmentKey: 'a',
      orderKey: index.toString(36).padStart(5, '0'), role: 'mount', target,
      labels: [], introducedBy: revision, qualifier: { type: 'zone-mount', zone,
        routeSegment: index === 0 ? 'selected' : `other-${index}`, disclosure: 'public' },
    }));
    const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
    const manifest: LegacyManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: zone,
      profile: 'zone-navigation', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
      records: await recordIndex.apply(await recordIndex.empty(cost),
        new Map(records.map(record => [record.occurrence, record])), cost),
      order: await orderIndex.apply(await orderIndex.empty(cost), new Map(records.map(record => {
        const entry = { parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey!,
          occurrence: record.occurrence };
        return [orderTreeKey(entry), entry];
      })), cost), placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
    const originalBytes = encode(manifest), digest = await objects.put(originalBytes);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a <${RV}StructureRevision> ; <${RV}component> ${iri(structure)} ;
        <${RV}manifest> <urn:rezics:sha256:${digest}> ; <${RV}placementCount> ${size} ;
        <${RV}modelRevision> <${STRUCTURE_PROFILE}> ; <${RV}shapeRevision> <${STRUCTURE_PROFILE}> ;
        <${RV}dataEpoch> ${JSON.stringify(stack.env.lineage.dataEpoch)} ; <${RV}sequence> 7 . } }`);
    const header: CompositionHeader = { structure, profile: 'zone-navigation', owner: zone,
      component: zone, mainVersion: zone, work: zone, head: revision, generation,
      placementCount: size, manifest: `urn:rezics:sha256:${digest}` };
    return { manifest, records, revision, digest, originalBytes, header };
  };
  try {
    const member = await stack.member('qualifier-checkpoint-owner');
    await member.grant(`semantic:read:${zone}`, 'semantic.read');
    await member.grant(`semantic:read:${target}`, 'semantic.read');
    const canRead = (reference: string) => stack.access.canReadSemanticResource(member.principal, member.actor, reference);
    const store = new StructureQualifierRootStore(stack.contentPool, counted);
    Object.assign(stack.env, { structureQualifierRoots: store });
    const lookup = (source: Awaited<ReturnType<typeof makeSource>>, routeSegment: string, exact = false) =>
      readCompositionOccurrenceByQualifierKey(stack.env, { structure, header: source.header,
        ...(exact ? { revision: source.revision } : {}), key: { type: 'zone-mount', zone, routeSegment },
        canReadOwner: canRead, canReadTarget: canRead });
    const measure = async <T>(label: string, operation: () => Promise<T>) => {
      pages = 0; bytes = 0; orderReads = 0; measuring = true;
      const before = performance.now(), sqlBefore = stack.contentPool.checkouts;
      let result: T;
      try { result = await operation(); }
      finally { measuring = false; }
      const sample = { label, pages, bytes, orderReads,
        ownerCheckouts: stack.contentPool.checkouts - sqlBefore, elapsed: performance.now() - before };
      console.log('Trusted qualifier checkpoint cost', JSON.stringify(sample));
      evidence.push(sample);
      expect(pages).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
      expect(bytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
      expect(sample.elapsed).toBeLessThan(WORK_READ_COST.deadlineMs);
      expect(orderReads).toBe(0);
      return result;
    };
    const ordinary = (source: Awaited<ReturnType<typeof makeSource>>) => readCompositionPage(stack.env, {
      structure, header: source.header, limit: 3, canReadTarget: canRead,
    });
    const failingPool = new Proxy(stack.contentPool, { get(pool, property, receiver) {
      if (property === 'query') return async (...args: unknown[]) => {
        if (/UPDATE\s+structure\.qualifier_root/i.test(String(args[0]))) throw new Error('Qualifier fixture CAS rollback');
        return (pool.query as (...values: unknown[]) => unknown).apply(pool, args);
      };
      const value = Reflect.get(pool, property, receiver);
      return typeof value === 'function' ? value.bind(pool) : value;
    } }) as Pool;
    for (const population of [257, 1025, 25_001]) {
      const source = await makeSource(population);
      const originalPage = await ordinary(source);
      expect(await store.read(source.digest)).toBeNull();
      await expect(lookup(source, 'absent')).rejects.toBeInstanceOf(StructureObjectUnavailable);
      const first = await measure(`first-${population}`, () => store.prepare(source.digest));
      expect(first.complete).toBe(false);
      expect(first.progress.visited).toBe(256);
      expect(first.batchLimit).toBe(256);
      expect(first.sourceRoot).toBe(qualifierSourceRoot(source.manifest));
      expect(first.source.records).toEqual(source.manifest.records);
      expect(first.source.order).toEqual(source.manifest.order);
      expect(await store.completedQualifierKeys(source.digest, source.manifest)).toBeNull();
      await expect(lookup(source, 'selected')).rejects.toBeInstanceOf(StructureObjectUnavailable);
      await expect(lookup(source, 'absent', true)).rejects.toBeInstanceOf(StructureObjectUnavailable);

      // Neither a failed CAS nor a caller retry can move the trusted checkpoint.
      const beforeFailure = await store.read(source.digest);
      await expect(new StructureQualifierRootStore(failingPool, counted).prepare(source.digest)).rejects
        .toThrow('Qualifier fixture CAS rollback');
      expect(await store.read(source.digest)).toEqual(beforeFailure);
      const transaction = await stack.contentPool.connect();
      try {
        await transaction.query('BEGIN');
        const transactionalStore = new StructureQualifierRootStore(transaction as unknown as Pool, counted);
        const candidate = await transactionalStore.prepare(source.digest);
        expect(candidate.progress.visited).toBe(Math.min(512, population));
        expect(candidate.version).not.toBe(beforeFailure!.version);
        expect(await transactionalStore.read(source.digest)).toEqual(candidate);
        await transaction.query('ROLLBACK');
      } catch (error) { await transaction.query('ROLLBACK'); throw error; }
      finally { transaction.release(); }
      expect(await store.read(source.digest)).toEqual(beforeFailure);

      // A committed update whose response is lost is discovered by re-reading
      // the exact PK through a fresh owner instance, without accepting a cursor.
      let lost = false;
      const lostAckPool = new Proxy(stack.contentPool, { get(pool, property, receiver) {
        if (property === 'query') return async (...args: unknown[]) => {
          const result = await (pool.query as (...values: unknown[]) => Promise<unknown>).apply(pool, args);
          if (!lost && /UPDATE\s+structure\.qualifier_root/i.test(String(args[0]))) {
            lost = true; throw new Error('Qualifier fixture lost acknowledgement');
          }
          return result;
        };
        const value = Reflect.get(pool, property, receiver);
        return typeof value === 'function' ? value.bind(pool) : value;
      } }) as Pool;
      const recovered = await new StructureQualifierRootStore(lostAckPool, counted).prepare(source.digest);
      expect(recovered.progress.visited).toBe(Math.min(512, population));
      expect(lost).toBe(true);
      const reopenedObjects = stack.objects('semantic/structure/');
      await reopenedObjects.initialize();
      const restarted = new StructureQualifierRootStore(stack.contentPool, reopenedObjects);
      let checkpoint = (await restarted.read(source.digest))!;
      expect(checkpoint.progress.visited).toBe(Math.min(512, population));
      expect(checkpoint.complete).toBe(population <= 512);
      let turns = 2, refinements = 0;
      while (!checkpoint.complete) {
        const prior = checkpoint;
        checkpoint = await measure(`resume-${population}-${turns}`, () => store.prepare(source.digest));
        const advanced = checkpoint.progress.visited - prior.progress.visited;
        expect(advanced).toBeGreaterThanOrEqual(0);
        expect(advanced).toBeLessThanOrEqual(prior.batchLimit);
        expect(BigInt(checkpoint.version)).toBeGreaterThan(BigInt(prior.version));
        if (advanced === 0) {
          expect(checkpoint.progress).toEqual(prior.progress);
          expect(checkpoint.complete).toBe(false);
          expect(checkpoint.batchLimit).toBe(Math.max(1, Math.floor(prior.batchLimit / 2)));
          expect(checkpoint.batchLimit).toBeLessThan(prior.batchLimit);
          expect(await store.completedQualifierKeys(source.digest, source.manifest)).toBeNull();
          await expect(lookup(source, 'absent', true)).rejects.toBeInstanceOf(StructureObjectUnavailable);
          refinements++;
        } else {
          expect(checkpoint.batchLimit).toBe(prior.batchLimit);
        }
        evidence.push({ label: `progress-${population}-${turns}`, advanced,
          visited: checkpoint.progress.visited, batchLimit: checkpoint.batchLimit,
          priorBatchLimit: prior.batchLimit, complete: checkpoint.complete });
        turns++;
        expect(turns).toBeLessThanOrEqual(population < 25_001 ? 10 : 512);
        expect(performance.now() - started).toBeLessThan(600_000);
      }
      if (population < 25_001) {
        expect(turns).toBe(Math.ceil(population / 256));
        expect(refinements).toBe(0);
      } else {
        expect(refinements).toBeGreaterThanOrEqual(1);
        expect(checkpoint.batchLimit).toBeLessThan(256);
      }
      expect(checkpoint.progress.visited).toBe(population);
      const coverage = (await restarted.completedQualifierKeys(source.digest, source.manifest))!;
      expect(coverage.sourceRoot).toBe(qualifierSourceRoot(source.manifest));
      expect(coverage.root.count).toBe(population);
      expect(await store.prepare(source.digest)).toEqual(checkpoint);
      for (const exact of [false, true]) for (const segment of ['selected', 'absent']) {
        const result = await measure(`lookup-${population}-${exact}-${segment}`, () => lookup(source, segment, exact));
        expect(pages).toBeLessThanOrEqual(12);
        expect(result.cost.pagesRead).toBe(pages);
        expect(result.outcome).toBe(segment === 'selected' ? 'found' : 'missing');
        expect(result.occurrences).toEqual(segment === 'selected' ? [source.records[0]!] : []);
        expect(result.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: stack.env.lineage.dataEpoch, sequence: '7' });
        expect(result).not.toHaveProperty('next');
        expect(result).not.toHaveProperty('placementCount');
        expect(result).not.toHaveProperty('candidateCount');
      }
      expect((await ordinary(source)).occurrences).toEqual(originalPage.occurrences);
      expect(await objects.get(source.digest)).toEqual(source.originalBytes);
      await stack.accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2',
        [member.actor, `semantic:read:${target}`]);
      try {
        expect((await lookup(source, 'selected')).outcome).toBe('missing');
        expect((await lookup(source, 'selected', true)).outcome).toBe('missing');
      } finally { await member.grant(`semantic:read:${target}`, 'semantic.read'); }

      const derivedPage = coverage.root.page.slice(7), derivedBytes = await objects.get(derivedPage);
      await objects.discard(derivedPage);
      try { await expect(lookup(source, 'absent')).rejects.toBeInstanceOf(StructureObjectUnavailable); }
      finally { expect(await objects.put(derivedBytes)).toBe(derivedPage); }

      // A similarly shaped source is not this exact source root; PK lookup must
      // refuse borrowed coverage before producing a physically bounded absence.
      await expect(store.completedQualifierKeys(source.digest, { ...source.manifest, generation: native() }))
        .rejects.toBeInstanceOf(StructureObjectCorrupt);
      const saved = (await stack.contentPool.query('SELECT * FROM structure.qualifier_root WHERE manifest_digest=$1',
        [source.digest])).rows[0]!;
      await stack.contentPool.query(`UPDATE structure.qualifier_root
        SET progress=jsonb_set(progress,'{root,count}',to_jsonb($2::integer)) WHERE manifest_digest=$1`,
        [source.digest, population - 1]);
      try { await expect(lookup(source, 'absent')).rejects.toBeInstanceOf(StructureObjectCorrupt); }
      finally {
        await stack.contentPool.query('UPDATE structure.qualifier_root SET progress=$2::jsonb WHERE manifest_digest=$1',
          [source.digest, JSON.stringify(saved.progress)]);
      }
      await stack.contentPool.query(`UPDATE structure.qualifier_root SET progress=jsonb_set(progress,'{visited}',to_jsonb($2::integer))
        WHERE manifest_digest=$1`, [source.digest, population - 1]);
      try {
        await expect(store.prepare(source.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
        await expect(lookup(source, 'absent')).rejects.toBeInstanceOf(StructureObjectCorrupt);
      } finally {
        await stack.contentPool.query('UPDATE structure.qualifier_root SET progress=$2::jsonb WHERE manifest_digest=$1',
          [source.digest, JSON.stringify(saved.progress)]);
      }
      const malformedDigest = await objects.put(encode({ ...source.manifest,
        records: { ...source.manifest.records, count: population + 1 } }));
      await expect(store.prepare(malformedDigest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
      expect(await store.read(malformedDigest)).toBeNull();
    }
    // Race two owner turns after each has read the same trusted progress. The
    // winner publishes one 256-record advance; a loser never unions partial roots.
    const raceSource = await makeSource(769);
    await expect(new StructureQualifierRootStore(failingPool, counted).prepare(raceSource.digest)).rejects
      .toThrow('Qualifier fixture CAS rollback');
    expect((await store.read(raceSource.digest))!.progress.visited).toBe(0);
    let reached = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const racingObjects: ImmutableObjects = { put: counted.put,
      get: async digest => {
        if (digest === raceSource.manifest.records.page.slice(7) && reached < 2) {
          reached++; if (reached === 2) release(); await gate;
        }
        return counted.get(digest);
      } };
    const competitors = new StructureQualifierRootStore(stack.contentPool, racingObjects);
    const raced = await Promise.all([competitors.prepare(raceSource.digest), competitors.prepare(raceSource.digest)]);
    const winner = (await store.read(raceSource.digest))!;
    expect(reached).toBe(2);
    expect(winner.progress.visited).toBe(256);
    expect(winner.complete).toBe(false);
    expect(raced.every(result => result.progress.visited === 256)).toBe(true);
    expect(await store.completedQualifierKeys(raceSource.digest, raceSource.manifest)).toBeNull();
    await expect(lookup(raceSource, 'absent')).rejects.toBeInstanceOf(StructureObjectUnavailable);
    expect(await objects.get(raceSource.digest)).toEqual(raceSource.originalBytes);

    // A focused owner cut uses real Jena references for this Structure only.
    // Custody still includes every derived checkpoint root, including partial work.
    const scopedGraph = { query: (query: string, maxBytes?: number) => stack.fuseki.query(
      query.replace('WHERE {', `WHERE { VALUES ?subject { ${iri(raceSource.revision)} }`),
      maxBytes),
    } as unknown as FusekiClient;
    const custodyStore = { directory: stack.env.objectDirectory, structureObjects: objects, structureQualifierRoots: store };
    const retained = new Set<string>();
    const custody = await captureObjectRecoveryCoverage(scopedGraph, custodyStore, retained);
    expect(retained.has(raceSource.digest)).toBe(true);
    expect(retained.has(winner.progress.root.page.slice(7))).toBe(true);
    await assertObjectRecoveryCoverage(scopedGraph, custodyStore, custody);
    await stack.contentPool.query('DELETE FROM structure.qualifier_root WHERE manifest_digest=$1', [raceSource.digest]);
    try {
      await expect(assertObjectRecoveryCoverage(scopedGraph, custodyStore, custody)).rejects.toBeInstanceOf(ObjectRecoveryConflict);
      await expect(lookup(raceSource, 'absent')).rejects.toBeInstanceOf(StructureObjectUnavailable);
    } finally {
      await stack.contentPool.query(`INSERT INTO structure.qualifier_root
        (manifest_digest,source_root,source,progress,version,complete,batch_limit) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [winner.manifestDigest, winner.sourceRoot, winner.source, winner.progress, winner.version, winner.complete, winner.batchLimit]);
    }
    await assertObjectRecoveryCoverage(scopedGraph, custodyStore, custody);
    expect(performance.now() - started).toBeLessThan(600_000);
    await Bun.write(resolve('.temp', 'goal', `structure-qualifier-root-costs-${Bun.env.REZICS_QA_RUN_ID}.json`),
      JSON.stringify({ runId: Bun.env.REZICS_QA_RUN_ID, costs: evidence }, null, 2));
  } finally { await stack.stop(); }
}, 600_000);
