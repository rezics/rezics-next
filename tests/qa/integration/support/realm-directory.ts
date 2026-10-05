import { setTimeout as delay } from 'node:timers/promises';
import { DATASET, GRAPHS, iri, lit, RV, type WorkActivationEnvironment } from '../../../../services/main/src/modules/work/activate.ts';
import type { ReadPosition } from '../../../../services/main/src/modules/work/read-session.ts';

export const DIRECTORY_POLL_COST = { deadlineMs: 15_000, intervalMs: 50 } as const;
export interface DirectorySnapshot {
  sourcePosition: ReadPosition;
  items: { id: string }[];
}

/** Observe the asynchronous projection through its public read. Capturing the
 * source after a command avoids assuming read-your-writes or advancing a worker
 * from a test. An optional predicate covers fixture-only writes without receipts. */
export async function waitForRealmDirectory(env: WorkActivationEnvironment, read: () => Promise<Response>,
  accepts: (page: DirectorySnapshot) => boolean = () => true): Promise<Response> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?sequence } } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')) throw new Error('Directory source is unavailable');
  const sequence = BigInt(rows[0]!.sequence!.value);
  const deadline = Date.now() + DIRECTORY_POLL_COST.deadlineMs;
  let last = '';
  while (Date.now() < deadline) {
    const response = await read();
    const body = await response.clone().text();
    last = `${response.status}: ${body}`;
    if (response.status === 200) {
      const page = JSON.parse(body) as DirectorySnapshot;
      if (page.sourcePosition.dataEpoch === env.lineage.dataEpoch
        && BigInt(page.sourcePosition.sequence) >= sequence && accepts(page)) return response;
    } else if (response.status !== 503 && response.status !== 409) {
      throw new Error(`Directory poll failed: ${last}`);
    }
    await delay(DIRECTORY_POLL_COST.intervalMs);
  }
  throw new Error(`Directory did not publish within ${DIRECTORY_POLL_COST.deadlineMs} ms; last response ${last}`);
}
