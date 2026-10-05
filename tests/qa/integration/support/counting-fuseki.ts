import { AsyncLocalStorage } from 'node:async_hooks';
import { FusekiClient, type SparqlResult } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { RealmDirectoryWorker } from '../../../../services/main/src/modules/realm-directory/worker.ts';

const background = new AsyncLocalStorage<boolean>();
let directoryAttributed = false;

/** Embedded apps may start their worker lazily on a request. Attribute the
 * public scheduling boundary, including interval and follow-up nudges, rather
 * than app construction or the refresh implementation. Explicit ticks still
 * count as operations. Install once so concurrent fixtures share the boundary. */
export function attributeDirectoryRefreshQueries(): void {
  if (directoryAttributed) return;
  const nudge = RealmDirectoryWorker.prototype.nudge;
  RealmDirectoryWorker.prototype.nudge = function () {
    background.run(true, () => nudge.call(this));
  };
  directoryAttributed = true;
}

/** Counts operation queries while background schedulers keep using the real client. */
export class CountingFuseki extends FusekiClient {
  queries = 0;

  /** Query interceptors use the same attribution as the round-trip counter. */
  get isBackgroundContext(): boolean {
    return background.getStore() === true;
  }

  runBackground<T>(operation: () => T): T {
    return background.run(true, operation);
  }

  override async query(sparql: string, maxBytes?: number): Promise<SparqlResult> {
    if (!this.isBackgroundContext) this.queries++;
    return super.query(sparql, maxBytes);
  }
}
