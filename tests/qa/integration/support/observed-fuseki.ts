import {
  FusekiClient,
  type CommandEnvelope,
  type SparqlResult,
} from '../../../../services/main/src/infrastructure/fuseki.ts';
import { isForegroundOperation } from './operation-cost.ts';

/** Retain query shapes and count health fences and commands for the operation. */
export class ObservedFuseki extends FusekiClient {
  readonly queries: string[] = [];
  healthReads = 0;
  commands = 0;

  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    if (isForegroundOperation()) this.queries.push(sparql);
    return super.query(sparql, maxResponseBytes);
  }

  override async commandHealth() {
    if (isForegroundOperation()) this.healthReads++;
    return super.commandHealth();
  }

  override async commandWithReceipt(envelope: CommandEnvelope) {
    if (isForegroundOperation()) this.commands++;
    return super.commandWithReceipt(envelope);
  }
}
