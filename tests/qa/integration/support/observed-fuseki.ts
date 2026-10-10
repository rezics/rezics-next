import {
  FusekiClient,
  type CommandEnvelope,
  type SparqlResult,
} from '../../../../services/main/src/infrastructure/fuseki.ts';
import { foregroundCounted } from './query-cost-meter.ts';

/** Retain query shapes and count health fences and commands for the operation. */
export class ObservedFuseki extends FusekiClient {
  readonly queries: string[] = [];
  healthReads = 0;
  commands = 0;

  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    if (foregroundCounted()) this.queries.push(sparql);
    return super.query(sparql, maxResponseBytes);
  }

  override async commandHealth() {
    if (foregroundCounted()) this.healthReads++;
    return super.commandHealth();
  }

  override async commandWithReceipt(envelope: CommandEnvelope) {
    if (foregroundCounted()) this.commands++;
    return super.commandWithReceipt(envelope);
  }
}
