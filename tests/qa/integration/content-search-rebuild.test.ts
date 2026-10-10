import { expect, test } from 'bun:test';
import { foregroundCounted } from './support/query-cost-meter.ts';
import { randomUUID } from 'node:crypto';
import type { ContentCore } from '../../../services/content/src/core.ts';
import type { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { CONTENT_REBUILD_PAGE, CONTENT_REBUILD_READ_BUDGET_MS,
  clearQuarantinedContentUnits, quarantinePublicContentSearch, verifyQuarantinedContentIndex,
} from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { DATASET, GRAPHS, initializeFreshGraph, iri,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

class RecordingFuseki extends FusekiClient {
  readonly queries: string[] = [];
  readonly durations: number[] = [];

  override async query(sparql: string, maxResponseBytes?: number) {
    const counted = foregroundCounted();
    const started = performance.now();
    try {
      return await super.query(sparql, maxResponseBytes);
    } finally {
      if (counted) {
        this.queries.push(sparql);
        this.durations.push(performance.now() - started);
      }
    }
  }
}

test('content search rebuild verification pages its Fuseki reads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated integration QA tier');
  }
  const fuseki = new RecordingFuseki(Bun.env.FUSEKI_URL);
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  const prepared = await fuseki.query(`ASK { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} ?p ?o } }`);
  if (prepared.boolean !== true) await initializeFreshGraph(fuseki, lineage);
  const position = { owner: 'content' as const, dataEpoch: lineage.dataEpoch, sequence: '0' };
  const content = { ownerPosition: async () => position, readExactBatch: async () => [] } as unknown as ContentCore;
  const cursor = { read: async () => position } as unknown as ContentProjectionCursor;
  const env: WorkActivationEnvironment = { fuseki, lineage, objectDirectory: '' };
  const job = await quarantinePublicContentSearch(env, content, randomUUID());
  expect(await clearQuarantinedContentUnits(env, job)).toBe(0);
  const snapshot = await verifyQuarantinedContentIndex(env, content, cursor, job);
  expect(snapshot).toMatchObject({ unitCount: 0, contentUnitCount: 0 });
  const declared = fuseki.queries.filter(query => query.includes('ORDER BY STR(?variant)'));
  const units = fuseki.queries.filter(query => query.includes('ORDER BY STR(?unit)'));
  expect(declared.length).toBeGreaterThan(0);
  expect(units.length).toBeGreaterThan(0);
  for (const query of [...declared, ...units]) expect(query).toContain(`LIMIT ${CONTENT_REBUILD_PAGE}`);
  const joins = fuseki.queries.filter(query => query.includes('urn:rezics:graph:revisions')
    && query.includes('urn:rezics:graph:receipts'));
  for (const query of joins) {
    expect(query).toContain('VALUES ?variant');
    expect(query).toContain(`LIMIT ${CONTENT_REBUILD_PAGE}`);
    expect(query).toContain('rv:variant ?variant');
  }
  expect(Math.max(...fuseki.durations)).toBeLessThan(CONTENT_REBUILD_READ_BUDGET_MS);
});
