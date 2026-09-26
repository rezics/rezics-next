import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

/** Shared fake of one native private draft for SEARCH11/SEARCH12 unit tests. */
export const root = resolve(import.meta.dir, '../../..');
export const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
export const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
export const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';
export const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
export const body = 'Hidden nebula phrase';
const epoch = '00000000-0000-4000-8000-000000000015';
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000016';
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string, language?: string) => ({ type: 'literal', value,
  ...(language ? { 'xml:lang': language } : {}) });
const bindings = (row?: Record<string, ReturnType<typeof literal> | ReturnType<typeof uri>>) =>
  ({ results: { bindings: row ? [row] : [] } });

export class PrivateFixture extends FusekiClient {
  queries: string[] = [];
  hits = true;
  indexed = true;
  projected = true;
  moved = false;
  commandOnly = true;
  privateEpoch = '0';
  reads = 0;
  /** Awaited before answering the numbered native position read. */
  positionGate: ((read: number) => Promise<void>) | undefined;
  constructor(readonly manifest: string) { super('http://localhost:1/rezics'); }
  override async commandHealth() { return { moduleVersion: '0.5.29',
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    privateSearchWriteEpoch: this.privateEpoch, privateSearchWriteActive: false,
    publicSearchDeltaAvailable: this.commandOnly, profiles: {} }; }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?head ?sequence ?generation')) {
      this.reads++;
      await this.positionGate?.(this.reads);
      return bindings({ head: uri(this.moved && this.reads >= 2 ? author : revision),
        sequence: literal('7'), generation: uri(generation) });
    }
    if (sparql.includes('SELECT ?component ?manifest')) return bindings({
      component: uri(contribution), manifest: uri(`urn:rezics:sha256:${this.manifest}`),
      model: uri(CONTRIBUTION_PROFILE), shape: uri(CONTRIBUTION_PROFILE),
      dataset: uri('urn:rezics:dataset:product'), epoch: literal(epoch), sequence: literal('6'),
    });
    if (sparql.includes('ASK')) return { boolean: true };
    if (sparql.includes('SELECT ?body')) return bindings(this.projected
      ? { body: literal(body, 'en') } : undefined);
    if (sparql.includes('privateBody:*')) return bindings(this.indexed
      ? { literal: literal(body, 'en'), graph: uri('urn:rezics:search:private'),
        predicate: uri('https://rezics.com/vocab/privateSearchBody') } : undefined);
    if (sparql.includes('text:query')) return bindings(this.hits
      ? { literal: literal(body, 'en'), graph: uri('urn:rezics:search:private'),
        predicate: uri('https://rezics.com/vocab/privateSearchBody') } : undefined);
    throw new Error(`unexpected query: ${sparql}`);
  }
}

/** Records the settlement a session asks Access to commit. */
export function settlement(operations: string[]) {
  return { settle: async (_id: string, _token: string, outcome: 'withheld' | 'unconfirmed') => {
    operations.push(outcome);
    return outcome;
  } };
}

export function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'private-search-'));
  const manifest = prepareComponent(directory, contribution,
    { work, author, language: 'en', body, publication: 'draft' }, CONTRIBUTION_PROFILE);
  const fuseki = new PrivateFixture(manifest);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
    lineage: { dataEpoch: epoch, routingEpoch: '1' } };
  return { env, fuseki, cleanup: () => rmSync(directory, { force: true, recursive: true }) };
}
