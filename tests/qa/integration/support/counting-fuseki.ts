import { FusekiClient, type SparqlResult, type TemplateQueryEnvelope,
  type StatementPublicationNativeRequest, type StatementPublicationNativeResult,
  type TemplateIndexDelta } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { isForegroundOperation, runBackgroundOperation } from './operation-cost.ts';

/** Compatibility entry point for fixtures that previously installed only the
 * directory boundary. The shared cost module now installs every scheduler. */
export function attributeDirectoryRefreshQueries(): void {
  // Kept for existing fixtures; importing the shared counters installs all schedulers.
}

/** Counts operation queries while background schedulers keep using the real client. */
export class CountingFuseki extends FusekiClient {
  queries = 0;

  /** Query interceptors use the same attribution as the round-trip counter. */
  get isBackgroundContext(): boolean {
    return !isForegroundOperation();
  }

  runBackground<T>(operation: () => T): T {
    return runBackgroundOperation(operation);
  }

  override async query(sparql: string, maxBytes?: number): Promise<SparqlResult> {
    if (!this.isBackgroundContext) this.queries++;
    return super.query(sparql, maxBytes);
  }
  override async templateQuery(input:TemplateQueryEnvelope,maxBytes?:number):Promise<SparqlResult> {
    if(!this.isBackgroundContext) this.queries++;
    return super.templateQuery(input,maxBytes);
  }
  override async templateIndex(input:StatementPublicationNativeRequest):Promise<StatementPublicationNativeResult>;
  override async templateIndex(input:Parameters<FusekiClient['templateIndex']>[0]):Promise<TemplateIndexDelta>;
  override async templateIndex(input:StatementPublicationNativeRequest | Parameters<FusekiClient['templateIndex']>[0]) {
    if(!this.isBackgroundContext) this.queries++;
    if(input.operation==='statement-publication-page') return super.templateIndex(input);
    return super.templateIndex(input);
  }
}
